#!/usr/bin/env bash
# =============================================================================
# MiFirma — certificado de sello para DESARROLLO.
#
# ⚠ ESTE CERTIFICADO NO VALE NADA LEGALMENTE. Es autofirmado: prueba que el
#   documento no cambió, y nada más. Cualquiera puede generar uno que diga
#   "MiFirma". Para producción hace falta un certificado de sello de una CA
#   acreditada, y —para que Acrobat lo muestre válido sin instalar nada— que esa
#   CA esté en el programa AATL de Adobe.
#
#   Está a propósito en un script aparte y no se genera solo al arrancar: un
#   certificado que aparece mágicamente es un certificado que alguien despliega
#   a producción sin darse cuenta.
#
# ═══ ⚠ POR QUÉ ESTE SCRIPT CAMBIÓ EL 8/8/2026 ═══
#
# La versión anterior era `openssl req -x509` pelado, que produce un
# certificado SIN NINGUNA `keyUsage`: no dice qué se puede hacer con él.
#
# ⚠ Se cambió creyendo que ésa era la causa de que Acrobat dijera "El
#   certificado del firmante NO ES VÁLIDO" en vez de "la validez de la firma es
#   DESCONOCIDA". **Se probó y NO lo era**: con las extensiones puestas Acrobat
#   dice exactamente lo mismo. La hipótesis está refutada y anotada en el §9 de
#   `claude/cambios-posteriores-a-la-firma.md`.
#
# El cambio se mantiene igual, por dos motivos que no dependen de aquello:
# declarar lo que un certificado hace es correcto, y hay que llegar a la CA
# acreditada sabiendo qué pedirle.
#
#   Uso:  ./scripts/sello-dev.sh
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p db

# ⚠ La clave sale del .env si está, y no del entorno de la shell.
#
# Antes salía sólo de `$SELLO_P12_PASSWORD`, que en una terminal cualquiera no
# está definida: el .p12 salía con "desarrollo" mientras el .env decía otra
# cosa, y el servidor moría con «revisá SELLO_P12_PASSWORD» sin que nadie
# hubiera tocado el .env. Un certificado nuevo que no abre es peor que ninguno.
CLAVE="${SELLO_P12_PASSWORD:-}"
if [ -z "$CLAVE" ] && [ -f .env ]; then
  CLAVE="$(grep -E '^[[:space:]]*SELLO_P12_PASSWORD=' .env | tail -1 | cut -d= -f2- | tr -d '"'"'"' \r')"
  [ -n "$CLAVE" ] && echo "Clave tomada de .env."
fi
CLAVE="${CLAVE:-desarrollo}"

if [ -f db/sello-dev.p12 ]; then
  echo "Ya existe db/sello-dev.p12."
  echo
  echo "Si querés rehacerlo —por ejemplo para que salga con las extensiones"
  echo "correctas— corré esto primero y volvé a llamar al script:"
  echo
  echo "  mv db/sello-dev.p12 db/sello-dev.p12.viejo"
  echo
  echo "⚠ Los documentos que YA se firmaron siguen verificando: el certificado"
  echo "  viaja adentro de cada firma. Lo único que cambia es lo que se firme"
  echo "  de ahora en adelante."
  exit 0
fi

# ═══ Las extensiones, que son todo el punto ═══
#
# ⚠ Declara TODO lo que este certificado hace de verdad, y ni una cosa más.
#
# keyCertSign       — porque **se emite a sí mismo**. Sin esto el certificado se
#                     contradice: dice que no puede emitir certificados y su
#                     propio emisor es él. (Se probó con `CA:FALSE` y Acrobat
#                     dijo exactamente lo mismo que antes, así que la
#                     contradicción no compraba nada.)
# digitalSignature  — puede firmar.
# nonRepudiation    — la firma compromete a quien la hace (contentCommitment).
#                     Es la que corresponde a una firma de documento y no a una
#                     de canal.
#
# ⚠ Un sello de PRODUCCIÓN no se autofirma: lo emite una CA y viaja con su
#   cadena. Ahí sí corresponde `CA:FALSE`. Ver el §9 de
#   `claude/cambios-posteriores-a-la-firma.md`.
# Sin extendedKeyUsage a propósito: ausente significa "sin restricción". Poner
# una lista incompleta es peor que no poner ninguna.
#
# Van con `-addext` y no con un archivo de configuración porque la Mac trae
# LibreSSL y el Linux de Railway trae OpenSSL 3: los dos entienden `-addext`,
# pero el `openssl.cnf` no está en el mismo lugar en los dos.
openssl req -x509 -newkey rsa:2048 -keyout /tmp/sello-k.pem -out /tmp/sello-c.pem \
  -days 730 -nodes -sha256 \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,digitalSignature,nonRepudiation" \
  -addext "subjectKeyIdentifier=hash" \
  -subj "/CN=MiFirma (sello de desarrollo - SIN VALOR LEGAL)/O=MiFirma/C=UY" 2>/dev/null

openssl pkcs12 -export -out db/sello-dev.p12 \
  -inkey /tmp/sello-k.pem -in /tmp/sello-c.pem \
  -passout "pass:$CLAVE" 2>/dev/null

rm -f /tmp/sello-k.pem /tmp/sello-c.pem
chmod 600 db/sello-dev.p12

# ═══ Y se comprueba lo que se acaba de generar ═══
#
# ⚠ Un `-addext` que la versión de openssl de turno no acepta pasa
# desapercibido y el certificado sale pelado otra vez. Nos enteraríamos recién
# abriendo un PDF en un lector, o nunca. Es el mismo motivo por el que
# `predeclarar()` relee los widgets que acaba de escribir.
SALIDA="$(openssl pkcs12 -in db/sello-dev.p12 -passin "pass:$CLAVE" -nokeys -clcerts 2>/dev/null \
          | openssl x509 -noout -text)"
FALTA=""
echo "$SALIDA" | grep -q "CA:TRUE"             || FALTA="$FALTA basicConstraints"
echo "$SALIDA" | grep -q "Digital Signature"   || FALTA="$FALTA keyUsage(digitalSignature)"
echo "$SALIDA" | grep -q "Non Repudiation"     || FALTA="$FALTA keyUsage(nonRepudiation)"

if [ -n "$FALTA" ]; then
  echo "⚠ El certificado salió SIN:$FALTA"
  echo "  Es el defecto que este script vino a arreglar. No lo uses así:"
  echo "  revisá que openssl haya tomado -extensions, borrá db/sello-dev.p12 y"
  echo "  volvé a correrlo."
  exit 1
fi

echo "Listo: db/sello-dev.p12"
echo "  · autofirmado y coherente: declara que se emite a sí mismo y que firma"
echo "  · keyUsage: keyCertSign, firma digital y no repudio"
echo
echo "Agregá esto a .env si no está:"
echo "  SELLO_P12_RUTA=db/sello-dev.p12"
echo "  SELLO_P12_PASSWORD=$CLAVE"
