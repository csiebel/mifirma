import forge from 'node-forge';
import { Signer } from '@signpdf/utils';
import { HttpError } from '../../http/errors';
import type { Firmante } from './tipos';

/**
 * Firmar con la clave del titular custodiada en tuID.
 *
 * ═══ QUÉ HACE ESTE ARCHIVO Y QUÉ NO ═══
 *
 * Lo mismo que `sello_plataforma.ts`, con otra clave: consigue una firma
 * criptográfica sobre unos bytes. La diferencia es QUIÉN tiene la clave. En el
 * sello es la plataforma; acá es el titular, y la clave nunca sale de tuID.
 * Por eso esto produce firma AVANZADA: la clave la controla el firmante.
 *
 * NO sabe nada de OAuth, del catálogo ni de la base. Recibe el certificado del
 * titular y una función que firma un hash, y con eso arma el CMS. Quien lo
 * construye (`services/tuid_firma.ts`) ya hizo el viaje, tiene el token y sabe
 * qué identidad de firma usar. Así este archivo se puede probar con una función
 * que firme localmente, sin tuID de por medio.
 *
 * ═══ EL DOCUMENTO NUNCA SALE DEL SERVIDOR ═══
 *
 * tuID ofrece dos caminos (PDF §5.1 y §5.2): mandarle el documento entero para
 * que lo firme, o mandarle un hash y recibir la firma cruda. Se eligió el
 * segundo el 5/9, y no por prolijidad: el contenido de los documentos de los
 * clientes NO sale de MiFirma. Lo que viaja a tuID son 32 bytes —el hash de los
 * atributos firmados—, y lo que vuelve es la firma RSA sobre ellos. El PAdES,
 * el CMS, el certificado, todo lo arma esto.
 *
 * ═══ CÓMO SE ARMA UN CMS CUANDO LA CLAVE ESTÁ EN OTRO LADO ═══
 *
 * `node-forge` arma el SignedData y, en el último paso, llama a
 * `key.sign(md)` con el hash de los atributos firmados ya calculado. Es la
 * única costura. Como la firma es remota y asíncrona y forge es síncrono, se
 * hace en DOS PASADAS con los mismos atributos:
 *
 *   1. Se arma el CMS con una «clave» que no firma: CAPTURA el hash que forge
 *      le pide firmar y devuelve un relleno. Ese CMS se descarta.
 *   2. Se manda el hash a tuID y vuelve la firma.
 *   3. Se arma el CMS de nuevo, con una «clave» que ENTREGA esa firma —después
 *      de comprobar que forge le pidió firmar exactamente el mismo hash.
 *
 * Funciona porque los atributos firmados son deterministas si `signingTime` es
 * el mismo en las dos pasadas. Por eso se fija una vez, arriba, y no se deja
 * que forge ponga «ahora» en cada una.
 *
 * ═══ ⚠ LA FIRMA SE VERIFICA ACÁ, ANTES DE TOCAR EL PDF ═══
 *
 * Con la clave pública del certificado se comprueba que lo que devolvió tuID
 * es una firma PKCS#1 v1.5 con SHA-256 válida sobre el hash que se le mandó.
 * No es desconfianza: es el sabotaje incorporado. Si el `digest_value` se
 * codificara mal (base64 del hexadecimal en vez de los bytes, que es lo que
 * hace el ejemplo de Postman) tuID firmaría OTRO valor, no daría ningún error,
 * y el PDF saldría con una firma que ningún lector puede verificar. Acá se
 * corta con un mensaje que dice qué pasó.
 *
 * ═══ QUÉ NO ESTÁ ═══
 *
 * · La CADENA del certificado. tuID devuelve sólo el de entidad final; la
 *   subordinada y la raíz las tiene que buscar el lector (el certificado trae
 *   AIA). Si algún día el operador carga la cadena en el catálogo, entra por
 *   `cadenaDer` y va dentro del CMS.
 * · `signingCertificateV2` (PAdES-B-B estricto). El sello de plataforma
 *   tampoco lo pone: se agrega para los dos juntos, no para uno.
 */

const LARGO_RELLENO = 512; // bytes de una firma RSA-4096; sólo para la pasada 1

class SignerTuid extends Signer {
  constructor(
    private readonly cert: forge.pki.Certificate,
    private readonly cadena: forge.pki.Certificate[],
    private readonly firmarHash: (digestSha256: Buffer) => Promise<Buffer>,
  ) {
    super();
  }

  async sign(pdfBuffer: Buffer, signingTime?: Date): Promise<Buffer> {
    if (!(pdfBuffer instanceof Buffer)) throw new HttpError(500, 'El adaptador de tuID esperaba un Buffer.');
    // ⚠ Fijado UNA vez: es lo que hace idénticas las dos pasadas.
    const cuando = signingTime ?? new Date();

    // ── Pasada 1: qué hash hay que firmar ──
    let capturado: Buffer | null = null;
    this.armar(
      {
        sign: (md: forge.md.MessageDigest) => {
          capturado = Buffer.from(md.digest().getBytes(), 'binary');
          return ' '.repeat(LARGO_RELLENO);
        },
      },
      pdfBuffer,
      cuando,
    );
    if (!capturado) throw new HttpError(500, 'forge no pidió firmar nada: no se pudo obtener el hash.');
    const hash: Buffer = capturado;

    // ── Pasada 2: la firma, hecha en tuID ──
    const firma = await this.firmarHash(hash);

    // ── El sabotaje incorporado: verificar ANTES de armar el PDF ──
    const pub = this.cert.publicKey as forge.pki.rsa.PublicKey;
    let valida = false;
    try {
      valida = pub.verify(hash.toString('binary'), firma.toString('binary'), 'RSASSA-PKCS1-V1_5');
    } catch {
      valida = false;
    }
    if (!valida) {
      throw new HttpError(
        502,
        'La firma que devolvió tuID no verifica contra el certificado del titular. ' +
          'No se escribió nada en el documento. (Si esto aparece siempre, el sospechoso es cómo se codifica el hash que se le manda.)',
      );
    }

    // ── Pasada 3: el CMS definitivo ──
    let entregada = false;
    const p7 = this.armar(
      {
        sign: (md: forge.md.MessageDigest) => {
          const d = Buffer.from(md.digest().getBytes(), 'binary');
          if (!d.equals(hash)) {
            // No debería pasar nunca: significaría que los atributos cambiaron
            // entre pasadas, y entonces la firma es sobre otra cosa.
            throw new HttpError(500, 'El hash de la segunda pasada no coincide con el firmado.');
          }
          entregada = true;
          return firma.toString('binary');
        },
      },
      pdfBuffer,
      cuando,
    );
    if (!entregada) throw new HttpError(500, 'La firma de tuID no llegó a entrar en el CMS.');

    return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');
  }

  /** Arma el SignedData exactamente como lo hace `P12Signer`, con otra clave. */
  private armar(key: { sign: (md: forge.md.MessageDigest) => string }, pdf: Buffer, cuando: Date) {
    const p7 = forge.pkcs7.createSignedData();
    p7.content = forge.util.createBuffer(pdf.toString('binary'));
    p7.addCertificate(this.cert);
    for (const c of this.cadena) p7.addCertificate(c);
    p7.addSigner({
      // forge sólo le pide `.sign(md, scheme)`; el tipo de forge exige una
      // PrivateKey, así que se le miente al compilador, no a forge.
      key: key as unknown as forge.pki.rsa.PrivateKey,
      certificate: this.cert,
      digestAlgorithm: forge.pki.oids.sha256,
      // ⚠ Mismo orden que P12Signer: importa para la validación europea (DSS).
      authenticatedAttributes: [
        { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
        { type: forge.pki.oids.signingTime, value: cuando as unknown as string },
        { type: forge.pki.oids.messageDigest },
      ],
    });
    p7.sign({ detached: true });
    return p7;
  }
}

/** Lo que hace falta para construir el firmante. Lo junta `services/tuid_firma.ts`. */
export interface DatosFirmanteTuid {
  /** Certificado del titular, DER (de `sign_identities[].details.certificate`). */
  certificadoDer: Buffer;
  /** Cadena de certificación, DER, si se tiene. Opcional: ver la cabecera. */
  cadenaDer?: Buffer[];
  /** Firma un SHA-256 (32 bytes) con la clave del titular y devuelve la firma cruda. */
  firmarHash: (digestSha256: Buffer) => Promise<Buffer>;
}

class FirmanteTuid implements Firmante {
  readonly codigo = 'tuid';
  // Avanzada y no cualificada, a propósito: «la clave la controla el titular»
  // es un hecho técnico que este archivo puede afirmar. «Cualificada» es una
  // afirmación LEGAL —depende de la acreditación del prestador en el país— y
  // eso lo decide el paquete de país verificado por el abogado, no un adaptador.
  readonly nivel = 'avanzada' as const;
  readonly titular: string;
  private readonly cert: forge.pki.Certificate;
  private readonly cadena: forge.pki.Certificate[];

  constructor(private readonly datos: DatosFirmanteTuid) {
    this.cert = deDer(datos.certificadoDer);
    this.cadena = (datos.cadenaDer ?? []).map(deDer);
    this.titular = this.cert.subject.getField('CN')?.value ?? 'titular en tuID';
  }

  signer() {
    // Instancia nueva por firma, como manda `Firmante.signer`.
    return new SignerTuid(this.cert, this.cadena, this.datos.firmarHash);
  }

  /** Para el expediente: quién emitió el certificado y hasta cuándo vale. */
  get emisorCertificado(): string {
    return this.cert.issuer.getField('CN')?.value ?? '';
  }
  get certificadoValidoHasta(): Date {
    return this.cert.validity.notAfter;
  }
}

function deDer(der: Buffer): forge.pki.Certificate {
  try {
    return forge.pki.certificateFromAsn1(forge.asn1.fromDer(der.toString('binary')));
  } catch {
    throw new HttpError(502, 'El certificado que devolvió tuID no se pudo leer.');
  }
}

export function firmanteTuid(datos: DatosFirmanteTuid): FirmanteTuid {
  return new FirmanteTuid(datos);
}
export type { FirmanteTuid };
