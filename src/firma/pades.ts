import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { plainAddPlaceholder } from '@signpdf/placeholder-plain';
import { SignPdf } from '@signpdf/signpdf';
import { SUBFILTER_ETSI_CADES_DETACHED } from '@signpdf/utils';
import forge from 'node-forge';
import { Signer } from '@signpdf/utils';
import { insertarSelloEnFirma, loQueSeSella, leerSelloDeFirma, type SelloObtenido } from './tsa';
import { HttpError } from '../http/errors';
import type { Firmante } from './adaptadores/tipos';

/**
 * El ensamblador PAdES.
 *
 * Es la pieza que convierte un expediente en una firma. Todo lo demás del
 * producto —el circuito, los otorgamientos, la evidencia— describe QUÉ pasó;
 * esto es lo que hace que el documento lo pruebe por sí mismo, sin depender de
 * nuestra base de datos ni de nuestra buena fe.
 *
 * ═══ POR QUÉ ES NUESTRO Y NO DEL PROVEEDOR ═══
 *
 * Los proveedores de firma avanzada NO firman PDF: firman HASHES y devuelven un
 * PKCS#7 (`proveedores-y-adaptadores.md` §0). El PAdES —el ByteRange, el
 * incremental update, el DSS— lo armamos nosotros, igual para todos los
 * proveedores. Por eso el adaptador es delgado y esto es grueso, y por eso vale
 * escribirlo una sola vez y bien: un error acá afecta a todos los documentos de
 * todos los países.
 *
 * ═══ TRES COSAS QUE SE VERIFICARON, NO SE SUPUSIERON ═══
 *
 * 1. **`pdf-lib` REESCRIBE el archivo.** Sirve para normalizar una vez, antes
 *    de la primera firma. Usarlo para agregar la segunda destruye la primera:
 *    se comprobó que a partir del byte 781 el archivo ya no coincide, y una
 *    firma cuyo ByteRange apunta a bytes que cambiaron no verifica más.
 *
 * 2. **`plainAddPlaceholder` no entiende cross-reference streams.** Los PDF 1.5+
 *    —y los que produce pdf-lib por defecto— los usan. De ahí `normalizar()`:
 *    una pasada que deja tabla xref clásica. Después de eso, el archivo no se
 *    vuelve a serializar nunca.
 *
 * 3. **El subfiltro tiene que ser `ETSI.CAdES.detached`.** El que viene por
 *    defecto, `adbe.pkcs7.detached`, es el formato viejo de Adobe y no es PAdES.
 */

const signpdf = new SignPdf();

/**
 * Espacio reservado para el PKCS#7, en bytes.
 *
 * ⚠ El hueco se reserva ANTES de firmar y no se puede agrandar después: si la
 * firma no entra, `signpdf` tira y el documento no se firma. Por eso el número
 * se elige con margen y con datos, no a ojo.
 *
 * Medido el 1/8/2026 contra siete autoridades: el token RFC 3161 con
 * certificado va de 4279 B (apple) a 7651 B (globalsign). Sumado a una cadena
 * de certificados de firmante acreditada (~6 KB), una firma sellada puede
 * rondar los 14 KB — el 83% de 16384, demasiado ajustado para enterarse en
 * producción con un documento real. Con sello se reserva el doble.
 *
 * Sobra espacio y se rellena con ceros, así que el costo de pasarse es tamaño
 * de archivo; el costo de quedarse corto es una firma que no se puede hacer.
 */
const LARGO_SIN_SELLO = 16384;
const LARGO_CON_SELLO = 32768;

export interface DatosSello {
  /** Qué se está firmando y quién. Aparece en el panel de firmas de Acrobat. */
  razon: string;
  /** Nombre que se muestra como firmante. */
  nombre: string;
  lugar?: string;
  contacto?: string;
}

/**
 * Deja el PDF en un formato que se pueda firmar de forma incremental.
 *
 * Se corre UNA vez, sobre el documento base, antes de la primera firma. A
 * partir de ahí cada firma agrega bytes al final y nadie vuelve a serializar
 * nada — que es la única forma de que las firmas anteriores sigan valiendo.
 */
export async function normalizar(pdf: Buffer): Promise<Buffer> {
  try {
    const doc = await PDFDocument.load(pdf, { ignoreEncryption: true });
    return Buffer.from(await doc.save({ useObjectStreams: false }));
  } catch (e) {
    throw new HttpError(
      400,
      'No se pudo preparar el PDF para firmar. Puede estar dañado o protegido con contraseña.',
    );
  }
}

/**
 * Aplica UNA firma sobre el PDF, como incremental update.
 *
 * El PDF que entra puede tener firmas anteriores: sus bytes quedan intactos y
 * esta firma se agrega al final. Eso es lo que permite que tres personas firmen
 * el mismo documento y que las tres firmas sigan verificando.
 */
/**
 * Envoltorio que le pide el sello de tiempo a quien sepa conseguirlo.
 *
 * ═══ POR QUÉ ACÁ ADENTRO Y NO ANTES NI DESPUÉS ═══
 *
 * El sello de una firma se calcula sobre el VALOR DE LA FIRMA, que recién
 * existe cuando el adaptador firmó, y tiene que estar adentro del PKCS#7 antes
 * de que ese PKCS#7 se escriba en el hueco del PDF. O sea: en el medio de una
 * operación que `signpdf` maneja sola. La única costura disponible es el
 * firmante, así que el sellado vive en un envoltorio del firmante.
 *
 * Extiende `Signer` porque signpdf comprueba `instanceof`. Probado.
 *
 * ⚠ Si el sello falla, se devuelve la firma SIN sello en vez de tirar. La
 * decisión de degradar está tomada en la migración 028 y se ejecuta acá: perder
 * la firma entera porque una autoridad ajena no contestó sería peor. Quien
 * llama se entera mirando `this.sello`, que queda en null.
 */
class SignerSellado extends Signer {
  sello: SelloObtenido | null = null;
  errorSello: string | null = null;
  bytesFirma = 0;

  constructor(
    private base: Signer,
    private pedirSello: (datos: Buffer) => Promise<SelloObtenido | null>,
  ) {
    super();
  }

  async sign(data: Buffer, signingTime?: Date): Promise<Buffer> {
    const cms = await this.base.sign(data, signingTime);
    try {
      this.sello = await this.pedirSello(loQueSeSella(cms));
    } catch (e) {
      this.errorSello = e instanceof Error ? e.message : 'error desconocido';
      this.sello = null;
    }
    const salida = this.sello ? insertarSelloEnFirma(cms, this.sello.nodo) : cms;
    this.bytesFirma = salida.length;
    return salida;
  }
}

export interface ResultadoSellado {
  pdf: Buffer;
  sello: SelloObtenido | null;
  errorSello: string | null;
  /** Qué fracción del hueco reservado ocupó la firma, de 0 a 1.
   *  Se registra en el expediente para que el tamaño del hueco lo decidan los
   *  documentos reales y no mi estimación. Si esto se acerca a 1, hay que
   *  agrandarlo ANTES de que un documento no se pueda firmar. */
  huecoUsado: number;
}

/**
 * Aplica UNA firma sobre el PDF, con sello de tiempo si se puede conseguir.
 *
 * `conSello` es opcional: sin él se firma como antes y `sello` vuelve null.
 */
export async function sellar(
  pdf: Buffer,
  datos: DatosSello,
  firmante: Firmante,
  conSello?: (datos: Buffer) => Promise<SelloObtenido | null>,
): Promise<ResultadoSellado> {
  const largo = conSello ? LARGO_CON_SELLO : LARGO_SIN_SELLO;

  const conHueco = plainAddPlaceholder({
    pdfBuffer: pdf,
    reason: datos.razon,
    name: datos.nombre,
    location: datos.lugar ?? '',
    contactInfo: datos.contacto ?? '',
    signatureLength: largo,
    subFilter: SUBFILTER_ETSI_CADES_DETACHED,
  });

  if (!conSello) {
    return {
      pdf: await signpdf.sign(conHueco, firmante.signer()),
      sello: null,
      errorSello: null,
      huecoUsado: 0,
    };
  }

  const s = new SignerSellado(firmante.signer(), conSello);
  const salida = await signpdf.sign(conHueco, s);
  return {
    pdf: salida,
    sello: s.sello,
    errorSello: s.errorSello,
    huecoUsado: Number((s.bytesFirma / largo).toFixed(3)),
  };
}

// ---------------------------------------------------------------------------
// Verificación
// ---------------------------------------------------------------------------

/**
 * Hasta dónde llega lo que esta firma cubre, y si eso está explicado.
 *
 * ⚠ Que una firma NO cubra hasta el final del archivo es lo NORMAL en un
 * documento con varias firmas: cada firma se agrega como incremental update, o
 * sea escribiendo bytes al final, y por definición la primera firma no puede
 * cubrir bytes que todavía no existían. Presentar eso como "el documento se
 * modificó" es falso y asusta al usuario sin motivo.
 *
 * Lo que SÍ es una alarma es que después de una firma haya bytes que ninguna
 * firma posterior explique.
 */
export type AlcanceFirma =
  /** Cubre hasta el final del archivo. Es la última firma. */
  | 'final'
  /** No llega al final, pero lo que sigue son firmas posteriores que verifican. */
  | 'firma_posterior'
  /** Después de esta firma hay bytes que nadie firmó. Esto sí es un problema. */
  | 'sin_explicar';

export interface FirmaVerificada {
  numero: number;
  /** El resumen de los bytes que dice cubrir coincide con el que se firmó. */
  verifica: boolean;
  /** CN del certificado: quién firmó según la criptografía. */
  firmante: string | null;
  emisor: string | null;
  /** /Name del diccionario: a nombre de quién se declaró la firma.
   *  NO es prueba de nada — es texto que escribe quien arma el PDF. */
  nombre_declarado: string | null;
  motivo: string | null;
  firmada_en: string | null;
  /** Byte del archivo hasta el que llega lo cubierto por esta firma. */
  cubre_hasta: number;
  bytes_cubiertos: number;
  alcance: AlcanceFirma;
  /** El sello RFC 3161 embebido, leído del archivo. Null si esta firma no lo
   *  tiene — que es lo que pasa con todo lo firmado antes de que existiera. */
  sello: { sellado_en: string | null; politica: string; numero_serie: string } | null;
}

export interface VerificacionPdf {
  firmas: FirmaVerificada[];
  /** Todas las firmas verifican y no quedan bytes fuera de toda firma. */
  integro: boolean;
  /** Bytes al final del archivo que ninguna firma cubre. Debería ser 0.
   *  Null si no verifica ninguna firma: ahí el número no significa nada. */
  bytes_sin_firmar: number | null;
}

/**
 * Una cadena literal de PDF — `(texto)` — desde la posición del paréntesis.
 *
 * Hay que leerla a mano y no con una expresión regular: `(` y `)` pueden
 * aparecer adentro escapados con barra, y `/Reason (Firmado por Ana (h))` le
 * corta la cabeza a cualquier `[^)]*`.
 */
function leerCadena(s: string, desde: number): string | null {
  if (s[desde] !== '(') return null;
  let out = '';
  let prof = 1;
  for (let i = desde + 1; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '\\') { out += s[i + 1] ?? ''; i++; continue; }
    if (ch === '(') prof++;
    if (ch === ')') { prof--; if (prof === 0) break; }
    out += ch;
  }
  return decodificarTexto(out);
}

/**
 * El texto de una cadena de PDF, que puede venir en dos codificaciones.
 *
 * Si arranca con el BOM `FE FF` es UTF-16BE. Y ojo con cómo llega: signpdf
 * arma la cadena en JavaScript y escribe el buffer como UTF-8, así que el BOM
 * viaja como `C3 BE C3 BF`. Por eso se decodifica UTF-8 primero y recién ahí se
 * miran los pares de bytes. Sin esto, "Firmado por José Peña" se muestra como
 * un plato de caracteres rotos, que es exactamente el tipo de detalle que le
 * hace perder credibilidad a una pantalla que dice verificar firmas.
 */
function decodificarTexto(crudo: string): string {
  const u = Buffer.from(crudo, 'latin1').toString('utf8');
  if (u.charCodeAt(0) !== 0xfe || u.charCodeAt(1) !== 0xff) return crudo;
  const cuerpo = u.slice(2);
  let out = '';
  for (let i = 0; i + 1 < cuerpo.length; i += 2) {
    out += String.fromCharCode((cuerpo.charCodeAt(i) << 8) | cuerpo.charCodeAt(i + 1));
  }
  return out;
}

/** Un campo de cadena del diccionario de firma, buscado dentro de una ventana. */
function campo(s: string, desde: number, hasta: number, nombre: string): string | null {
  const i = s.indexOf('/' + nombre, desde);
  if (i < 0 || i > hasta) return null;
  let j = i + nombre.length + 1;
  while (j < s.length && /\s/.test(s[j]!)) j++;
  return leerCadena(s, j);
}

/** La fecha de un atributo ASN.1, que puede ser UTCTime o GeneralizedTime.
 *  Tomar `.value` crudo devuelve "260801193325Z", que `new Date()` no entiende
 *  y termina en una fecha que nunca se muestra. */
function leerFecha(nodo: any): string | null {
  try {
    const d =
      nodo.type === forge.asn1.Type.GENERALIZEDTIME
        ? forge.asn1.generalizedTimeToDate(nodo.value)
        : forge.asn1.utcTimeToDate(nodo.value);
    return isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

/** Largo real de una estructura DER, leído de su cabecera.
 *
 *  Hace falta porque el hueco de la firma se rellena con ceros hasta
 *  `LARGO_FIRMA`, y recortar los "00" del final es un error: un DER puede
 *  terminar legítimamente en 00 y el recorte lo dejaría truncado. */
function largoDer(buf: Buffer): number {
  const primero = buf[1]!;
  if (primero < 0x80) return 2 + primero;
  const bytes = primero & 0x7f;
  let n = 0;
  for (let i = 0; i < bytes; i++) n = n * 256 + buf[2 + i]!;
  return 2 + bytes + n;
}

/**
 * Verifica todas las firmas de un PDF: que el digest firmado coincida con los
 * bytes que la firma dice cubrir.
 *
 * No valida la cadena de confianza contra una lista de CA — eso es otra cosa y
 * depende del país. Lo que responde es la pregunta anterior y más importante:
 * **¿el documento cambió después de firmado?**
 *
 * Se corre antes de entregar un documento firmado y al emitir el certificado de
 * finalización. Una firma que no verifica no se entrega: se investiga.
 */
export function verificar(pdf: Buffer): VerificacionPdf {
  const s = pdf.toString('latin1');
  const firmas: FirmaVerificada[] = [];
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  let m: RegExpExecArray | null;
  let n = 0;

  while ((m = re.exec(s)) !== null) {
    n += 1;
    const [a, b, c, d] = m.slice(1).map(Number) as [number, number, number, number];

    // Lo firmado es todo el archivo MENOS el hueco donde vive la firma.
    const cubierto = Buffer.concat([pdf.subarray(a, a + b), pdf.subarray(c, c + d)]);
    const digest = createHash('sha256').update(cubierto).digest('hex');

    let verifica = false;
    let firmante: string | null = null;
    let emisor: string | null = null;
    let firmadaEn: string | null = null;
    let cms: Buffer | null = null;

    try {
      const hex = pdf
        .subarray(a + b, c)
        .toString('latin1')
        .replace(/^[\s<]+/, '')
        .replace(/[\s>\0]+$/, '');
      const bruto = Buffer.from(hex, 'hex');
      const der = bruto.subarray(0, largoDer(bruto));
      cms = der;
      const p7: any = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(der.toString('binary')));

      for (const at of p7.rawCapture?.authenticatedAttributes ?? []) {
        const oid = forge.asn1.derToOid(at.value[0].value);
        if (oid === forge.pki.oids.messageDigest) {
          const md = Buffer.from(at.value[1].value[0].value, 'binary').toString('hex');
          verifica = md === digest;
        }
        if (oid === forge.pki.oids.signingTime) {
          firmadaEn = leerFecha(at.value[1].value[0]);
        }
      }

      const cert = p7.certificates?.[0];
      if (cert) {
        firmante = cert.subject.getField('CN')?.value ?? null;
        emisor = cert.issuer.getField('CN')?.value ?? null;
      }
    } catch {
      verifica = false;
    }

    // ⚠ El resto del diccionario se busca HACIA ADELANTE, desde donde termina
    // el hueco de la firma. `/Reason` y `/Name` van DESPUÉS de `/Contents`, no
    // antes: mirar hacia atrás desde el `/ByteRange` —como se hacía— encuentra
    // el diccionario de la firma ANTERIOR, y el panel muestra cada motivo
    // corrido un lugar. La primera firma queda sin motivo y la última pierde
    // el suyo. Se vio en un PDF de tres firmas, no se dedujo.
    firmas.push({
      numero: n,
      verifica,
      firmante,
      emisor,
      nombre_declarado: campo(s, c, Math.min(s.length, c + 1200), 'Name'),
      motivo: campo(s, c, Math.min(s.length, c + 1200), 'Reason'),
      firmada_en: firmadaEn,
      cubre_hasta: c + d,
      bytes_cubiertos: b + d,
      alcance: 'sin_explicar',
      sello: cms ? leerSelloDeFirma(cms) : null,
    });
  }

  // El final "real" del archivo, sin el espacio en blanco de la cola: algunas
  // herramientas dejan un salto de línea después del %%EOF y eso no es una
  // modificación del documento.
  let util = pdf.length;
  while (util > 0 && /\s/.test(s[util - 1]!)) util--;

  const conFirma = firmas.filter((f) => f.verifica);
  const tope = conFirma.length ? Math.max(...conFirma.map((f) => f.cubre_hasta)) : null;

  for (const f of firmas) {
    if (f.cubre_hasta >= util) f.alcance = 'final';
    else if (firmas.some((g) => g.verifica && g.cubre_hasta > f.cubre_hasta)) f.alcance = 'firma_posterior';
    else f.alcance = 'sin_explicar';
  }

  const sinFirmar = tope === null ? null : Math.max(0, util - tope);

  return {
    firmas,
    bytes_sin_firmar: sinFirmar,
    // ⚠ Lo que esto afirma, con precisión: cada firma cubre exactamente los
    // bytes que cubría cuando se hizo, y no hay bytes que nadie haya firmado.
    // Lo que NO afirma: que un incremental update posterior no haya cambiado lo
    // que se VE de una página. Para eso hace falta comprobar DocMDP, y todavía
    // no lo hacemos. No decir en pantalla más de lo que se comprobó.
    integro: firmas.length > 0 && firmas.every((f) => f.verifica) && sinFirmar === 0,
  };
}
