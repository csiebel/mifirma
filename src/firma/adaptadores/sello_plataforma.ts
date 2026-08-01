import { readFileSync } from 'node:fs';
import { P12Signer } from '@signpdf/signer-p12';
import forge from 'node-forge';
import { HttpError } from '../../http/errors';
import type { Firmante } from './tipos';

/**
 * El sello de plataforma: MiFirma firma en nombre del firmante.
 *
 * ═══ QUÉ ES Y QUÉ NO ES ═══
 *
 * Cuando alguien firma con firma SIMPLE no tiene certificado propio: no hay
 * clave privada suya con la cual firmar. Lo que hace este adaptador es sellar
 * el documento con el certificado de la PLATAFORMA, dejando constancia en el
 * motivo de la firma de a nombre de quién se selló.
 *
 * Eso NO convierte la firma simple en avanzada, y el producto no debe decir que
 * sí. Lo que aporta es concreto y limitado, y conviene tenerlo claro:
 *
 *   · **Integridad demostrable**: cualquiera puede verificar, sin acceso a
 *     nuestra base, que el documento no cambió desde que se selló.
 *   · **Fecha oponible**, cuando se le agregue el sello de tiempo RFC 3161.
 *   · **Un tercero identificable** que afirma haber presenciado el acto.
 *
 * Lo que NO aporta: que la clave la haya controlado el firmante. Eso es lo que
 * distingue una firma avanzada, y ninguna cantidad de sellos lo suple.
 *
 * ═══ ⚠ EL CERTIFICADO DE DESARROLLO NO VALE NADA ═══
 *
 * Un certificado autofirmado prueba integridad y nada más: cualquiera puede
 * generar uno que diga "MiFirma". Para producción hace falta un certificado de
 * sello emitido por una CA acreditada, y —para que Acrobat lo muestre como
 * válido sin que el usuario instale nada— que esa CA esté en el programa AATL
 * de Adobe. Está anotado como pendiente en `proveedores-y-adaptadores.md`.
 *
 * Por eso `nivel` es 'simple' y no se puede configurar para que diga otra cosa.
 */
class SelloPlataforma implements Firmante {
  readonly codigo = 'sello_plataforma';
  readonly nivel = 'simple' as const;
  readonly titular: string;

  constructor(
    private readonly p12: Buffer,
    private readonly passphrase: string,
    titular: string,
  ) {
    this.titular = titular;
  }

  signer() {
    // Instancia nueva por firma: ver el comentario de `Firmante.signer`.
    return new P12Signer(this.p12, { passphrase: this.passphrase });
  }
}

let _sello: SelloPlataforma | null = null;

/**
 * Carga el sello desde el entorno.
 *
 * Se acepta el P12 en base64 (`SELLO_P12`) o una ruta (`SELLO_P12_RUTA`). En
 * Railway va la variable; en desarrollo, el archivo. Si no hay ninguno, esto NO
 * inventa un certificado al vuelo: falla con un mensaje que dice qué falta.
 * Generar uno automáticamente sería producir documentos "firmados" con una
 * clave distinta en cada arranque — imposibles de verificar y peores que no
 * tener firma.
 */
export function selloDePlataforma(): Firmante {
  if (_sello) return _sello;

  const b64 = process.env.SELLO_P12;
  const ruta = process.env.SELLO_P12_RUTA;
  const pass = process.env.SELLO_P12_PASSWORD ?? '';

  let p12: Buffer;
  if (b64) p12 = Buffer.from(b64, 'base64');
  else if (ruta) {
    try {
      p12 = readFileSync(ruta);
    } catch {
      throw new HttpError(503, `No se pudo leer el certificado de sello en ${ruta}.`);
    }
  } else {
    throw new HttpError(
      503,
      'No hay certificado de sello configurado (SELLO_P12 o SELLO_P12_RUTA). ' +
        'Sin él no se puede firmar: generá uno de desarrollo con scripts/sello-dev.sh.',
    );
  }

  // Se abre acá, al arrancar el primer uso, para fallar temprano y con un
  // mensaje claro en vez de reventar en medio de una firma con un error de ASN.1.
  let titular = 'MiFirma';
  try {
    const asn1 = forge.asn1.fromDer(p12.toString('binary'));
    const bolsa = forge.pkcs12.pkcs12FromAsn1(asn1, false, pass);
    const certs = bolsa.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag];
    const cert: any = certs?.[0]?.cert;
    if (cert) titular = cert.subject.getField('CN')?.value ?? titular;
  } catch {
    throw new HttpError(
      503,
      'El certificado de sello no se pudo abrir: revisá SELLO_P12_PASSWORD.',
    );
  }

  _sello = new SelloPlataforma(p12, pass, titular);
  return _sello;
}
