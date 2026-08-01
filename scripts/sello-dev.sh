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
#   Uso:  ./scripts/sello-dev.sh
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p db
CLAVE="${SELLO_P12_PASSWORD:-desarrollo}"

if [ -f db/sello-dev.p12 ]; then
  echo "Ya existe db/sello-dev.p12. Borralo si querés generar otro."
  exit 0
fi

openssl req -x509 -newkey rsa:2048 -keyout /tmp/sello-k.pem -out /tmp/sello-c.pem \
  -days 730 -nodes \
  -subj "/CN=MiFirma (sello de desarrollo - SIN VALOR LEGAL)/O=MiFirma/C=UY" 2>/dev/null

openssl pkcs12 -export -out db/sello-dev.p12 \
  -inkey /tmp/sello-k.pem -in /tmp/sello-c.pem \
  -passout "pass:$CLAVE" 2>/dev/null

rm -f /tmp/sello-k.pem /tmp/sello-c.pem
chmod 600 db/sello-dev.p12

echo "Listo: db/sello-dev.p12"
echo
echo "Agregá esto a .env:"
echo "  SELLO_P12_RUTA=db/sello-dev.p12"
echo "  SELLO_P12_PASSWORD=$CLAVE"
