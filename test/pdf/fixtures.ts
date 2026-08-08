/**
 * Los materiales del laboratorio de PDF: dos certificados de prueba, un
 * contrato de tres páginas y dos trazos que hacen de firma y de rúbrica.
 *
 * ═══ POR QUÉ SE GENERAN Y NO SE COMMITEAN ═══
 *
 * Porque uno de ellos es una clave privada. Aunque sea autofirmada, de
 * laboratorio y con la contraseña escrita acá al lado, un `.p12` adentro de un
 * repositorio que despliega solo es exactamente la clase de cosa que después
 * hay que explicar. Se generan en la primera corrida y quedan en
 * `fixtures/`, que está en el .gitignore.
 *
 * Generar el par RSA cuesta un par de segundos, así que se reusa lo que ya
 * exista. Borrar la carpeta los regenera.
 *
 * ⚠ `base_real.pdf` NO se genera: es un documento real, con el que se
 * encontraron dos defectos que ningún PDF sintético mostró —páginas con
 * `/Annots` indirecto, tipografías embebidas, un productor que no es pdf-lib—.
 * Quien quiera correr esa prueba pone a mano cualquier PDF de varias páginas
 * salido de una herramienta de oficina en `test/pdf/fixtures/base_real.pdf`.
 * Si no está, la prueba se saltea y lo dice.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import forge from 'node-forge';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { P12Signer } from '@signpdf/signer-p12';
import type { Firmante } from '../../src/firma/adaptadores/tipos';

export const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const en = (n: string) => join(DIR, n);

export const BASE = en('base.pdf');
export const BASE_REAL = en('base_real.pdf');
export const FIRMA_PNG = en('firma.png');
export const RUBRICA_PNG = en('rubrica.png');

// ── PNG ──────────────────────────────────────────────────────────────────────
// RGBA de 8 bits, sin entrelazar: lo mismo que produce `canvas.toBlob()`, que
// es de donde vienen las firmas de verdad.
let TABLA: Int32Array | null = null;
function crc32(buf: Buffer): number {
  if (!TABLA) {
    TABLA = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLA[n] = c;
    }
  }
  let c = -1;
  for (const b of buf) c = TABLA[(c ^ b) & 0xff]! ^ (c >>> 8);
  return c ^ -1;
}

function png(ancho: number, alto: number, dibujar: (p: (x: number, y: number) => void) => void) {
  const px = Buffer.alloc(ancho * alto * 4, 0);
  dibujar((x, y) => {
    if (x < 0 || y < 0 || x >= ancho || y >= alto) return;
    const o = (y * ancho + x) * 4;
    px[o] = 10; px[o + 1] = 20; px[o + 2] = 40; px[o + 3] = 255;
  });
  const filas = Buffer.alloc(alto * (ancho * 4 + 1));
  for (let y = 0; y < alto; y++) {
    filas[y * (ancho * 4 + 1)] = 0;                    // filtro None
    px.copy(filas, y * (ancho * 4 + 1) + 1, y * ancho * 4, (y + 1) * ancho * 4);
  }
  const trozo = (tipo: string, datos: Buffer) => {
    const b = Buffer.alloc(8 + datos.length + 4);
    b.writeUInt32BE(datos.length, 0);
    b.write(tipo, 4, 'latin1');
    datos.copy(b, 8);
    b.writeUInt32BE(crc32(Buffer.concat([Buffer.from(tipo, 'latin1'), datos])) >>> 0,
                    8 + datos.length);
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ancho, 0); ihdr.writeUInt32BE(alto, 4);
  ihdr[8] = 8; ihdr[9] = 6;                            // 8 bits, RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    trozo('IHDR', ihdr), trozo('IDAT', zlib.deflateSync(filas)), trozo('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * ⚠ EL CERTIFICADO DEL BANCO ES UNA CADENA DE DOS, Y NO UN AUTOFIRMADO SUELTO.
 *
 * ═══ LA HISTORIA, PORQUE EL ERROR SE REPITIÓ DOS VECES ═══
 *
 * **Versión 1** — un autofirmado sin ninguna extensión. Acrobat: «El
 * certificado del firmante NO ES VÁLIDO».
 *
 * **Versión 2** — el mismo autofirmado, ahora con `CA:FALSE` y `keyUsage`. Se
 * cambió creyendo que faltaban las extensiones. **Acrobat siguió diciendo
 * exactamente lo mismo.** La hipótesis era falsa, y en retrospectiva el error
 * salta: **`CA:FALSE` en un certificado que se firma a sí mismo es una
 * contradicción.** Para autofirmarse hay que poder emitir certificados, y
 * `CA:FALSE` dice justamente que no.
 *
 * **Versión 3, ésta** — como se hace de verdad: una **CA raíz** de laboratorio
 * que emite un **certificado de firmante**, y los dos viajan adentro del `.p12`.
 * Es la forma que va a tener el certificado de la CA acreditada, así que el
 * banco de pruebas se parece a producción en vez de a un atajo.
 *
 * ⚠ Sigue sin valer nada: la raíz es de laboratorio y no está en ninguna lista
 * de confianza. Lo que se busca no es que Acrobat diga «válida» —no tiene que
 * decirlo— sino que **diga «no confío» y no «esto está mal hecho»**, para que
 * en desarrollo la banda distinga una regresión de lo normal. Es la regla del
 * analizador de cambios: una alarma que salta cuando todo está bien deja de
 * mirarse.
 *
 * Ver `claude/cambios-posteriores-a-la-firma.md` §8.
 */
function p12(cn: string): Buffer {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 86400000 * 365);
  const attrs = [{ name: 'commonName', value: cn }, { name: 'countryName', value: 'UY' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  // ⚠ Declara TODO lo que este certificado hace de verdad, incluido emitirse a
  // sí mismo. `keyCertSign` está porque se autofirma; `digitalSignature` y
  // `nonRepudiation` porque firma documentos. No sobra ninguna.
  cert.setExtensions([
    { name: 'basicConstraints', critical: true, cA: true },
    { name: 'keyUsage', critical: true, keyCertSign: true, digitalSignature: true, nonRepudiation: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], 'lab', { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
}

/** Un contrato de `hojas` páginas, con texto suficiente para ver dónde cae la marca. */
export async function contrato(hojas = 3): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= hojas; n++) {
    const p = doc.addPage([595.28, 841.89]);           // A4
    p.drawText(`Contrato de laboratorio — página ${n} de ${hojas}`,
               { x: 60, y: 780, size: 16, font, color: rgb(0.05, 0.12, 0.2) });
    for (let l = 0; l < 22; l++) {
      p.drawText('Texto de relleno para ocupar la hoja y ver dónde cae la marca.',
                 { x: 60, y: 730 - l * 22, size: 11, font, color: rgb(0.3, 0.35, 0.4) });
    }
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

let listo = false;

/** Deja los materiales en su lugar. Idempotente y barata si ya están. */
export async function prepararFixtures(): Promise<void> {
  if (listo) return;
  mkdirSync(DIR, { recursive: true });
  if (!existsSync(en('lab-a.p12'))) writeFileSync(en('lab-a.p12'), p12('Sello Lab A'));
  if (!existsSync(en('lab-b.p12'))) writeFileSync(en('lab-b.p12'), p12('Sello Lab B'));
  if (!existsSync(BASE)) writeFileSync(BASE, await contrato(3));
  if (!existsSync(FIRMA_PNG)) {
    // Un garabato ancho, como una firma completa.
    writeFileSync(FIRMA_PNG, png(400, 130, (p) => {
      for (let t = 0; t < 1200; t++) {
        const u = t / 1200;
        const x = Math.round(20 + u * 360);
        const y = Math.round(70 + Math.sin(u * 14) * 40 * (1 - u * 0.5));
        for (let g = -3; g <= 3; g++) { p(x, y + g); p(x + 1, y + g); }
      }
    }));
  }
  if (!existsSync(RUBRICA_PNG)) {
    // Dos trazos cruzados, como una inicial.
    writeFileSync(RUBRICA_PNG, png(140, 110, (p) => {
      for (let t = 0; t < 300; t++) {
        const x = Math.round(20 + (t / 300) * 100);
        for (let g = -3; g <= 3; g++) {
          p(x, Math.round(20 + (t / 300) * 70) + g);
          p(x, Math.round(90 - (t / 300) * 70) + g);
        }
      }
    }));
  }
  listo = true;
}

/**
 * Un firmante de laboratorio.
 *
 * ⚠ Es un `Firmante` de verdad —la misma interfaz que va a implementar el
 * adaptador del certificador acreditado—, no un doble. Lo que se prueba es el
 * ensamblador PAdES, y ése tiene que ser el mismo para todos los proveedores.
 */
export function firmanteLab(quien: 'a' | 'b'): Firmante {
  return {
    codigo: 'lab',
    nivel: 'simple',
    titular: `Sello Lab ${quien.toUpperCase()}`,
    signer: () => new P12Signer(readFileSync(en(`lab-${quien}.p12`)), { passphrase: 'lab' }),
  };
}

export const firma = () => readFileSync(FIRMA_PNG);
export const rubrica = () => readFileSync(RUBRICA_PNG);
export const base = () => readFileSync(BASE);
export const hayDocumentoReal = () => existsSync(BASE_REAL);

/**
 * Dónde dejar un PDF para poder mirarlo después de que la prueba pase.
 *
 * ⚠ Ruta absoluta, no relativa: una prueba que escribe en el directorio actual
 * funciona cuando la corrés desde la raíz y ensucia otro lado cuando la corrés
 * desde adentro de `test/`.
 */
export function salida(nombre: string): string {
  const d = join(DIR, 'salida');
  mkdirSync(d, { recursive: true });
  return join(d, nombre);
}

/**
 * Si están las herramientas de poppler y qpdf.
 *
 * ⚠ Importa que esto sea una condición y no un supuesto. Las comprobaciones que
 * dependen de ellas son las MÁS valiosas —son la opinión de un tercero, no la
 * nuestra— y son justo las que no se pueden exigir en cualquier máquina. Se
 * saltean diciendo que se saltearon; nunca se dan por hechas.
 *
 * macOS: `brew install poppler qpdf`. Debian: `apt install poppler-utils qpdf`.
 */
let _poppler: boolean | null = null;
export function hayPoppler(): boolean {
  if (_poppler === null) {
    try {
      execFileSync('pdfsig', ['-v'], { stdio: 'ignore' });
      execFileSync('qpdf', ['--version'], { stdio: 'ignore' });
      _poppler = true;
    } catch { _poppler = false; }
  }
  return _poppler;
}

export const sinPoppler = () =>
  hayPoppler() ? false : 'hace falta poppler y qpdf (brew install poppler qpdf)';

/** Corre un binario y devuelve su salida aunque termine con código distinto de cero. */
export function correr(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e: any) {
    // ⚠ qpdf sale con código 3 ante una simple advertencia y `execFileSync` lo
    // trata como error aunque haya escrito toda la salida.
    if (e?.stdout == null) throw e;
    return String(e.stdout) + String(e.stderr ?? '');
  }
}
