/**
 * Mirar un PDF por afuera: qué declara su AcroForm, qué dice qpdf de su
 * estructura, y qué hojas tienen tinta de verdad.
 *
 * ⚠ Nada de acá usa nuestro verificador. Es a propósito: una prueba que sólo
 * le pregunta al código que escribimos no prueba que el archivo sea correcto,
 * prueba que somos consistentes con nosotros mismos.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { correr, DIR, salida } from './fixtures';

/**
 * El AcroForm que gana: el ÚLTIMO objeto escrito con ese índice.
 *
 * ⚠ En un PDF con incremental updates el mismo objeto aparece varias veces y
 * vale el último. Buscar el primero devuelve el AcroForm de antes de firmar, y
 * la prueba pasa por el motivo equivocado.
 */
export function acroformFinal(pdf: Buffer) {
  const s = pdf.toString('latin1');
  const raiz = /\/AcroForm\s+(\d+)\s+0\s+R/g;
  let idx: string | null = null;
  for (let m = raiz.exec(s); m; m = raiz.exec(s)) idx = m[1]!;
  if (!idx) return { campos: [] as string[], texto: '(sin AcroForm)' };

  const obj = new RegExp(`(?:^|[^0-9])${idx} 0 obj([\\s\\S]*?)endobj`, 'g');
  let ultimo = '';
  for (let m = obj.exec(s); m; m = obj.exec(s)) ultimo = m[1]!;
  const i = ultimo.indexOf('/Fields');
  const lista = i < 0 ? '' : ultimo.slice(ultimo.indexOf('[', i) + 1, ultimo.indexOf(']', i));
  return { campos: lista.match(/\d+\s+\d+\s+R/g) || [], texto: ultimo.trim().replace(/\s+/g, ' ') };
}

export interface CampoDeclarado {
  campo: string;
  nombre: string;
  widgets: number;
  forma: string;
  esFirma: boolean;
  soloLectura: boolean;
}

/** Qué declara cada campo del AcroForm: si es firma, cuántos widgets, si está bloqueado. */
export function estructura(pdf: Buffer, campos: string[]): CampoDeclarado[] {
  const s = pdf.toString('latin1');
  return campos.map((ref) => {
    const idx = ref.split(/\s+/)[0];
    const obj = new RegExp(`(?:^|[^0-9])${idx} 0 obj([\\s\\S]*?)endobj`, 'g');
    let ultimo = '';
    for (let m = obj.exec(s); m; m = obj.exec(s)) ultimo = m[1]!;
    const kids = /\/Kids\s*\[([^\]]*)\]/.exec(ultimo);
    const ff = /\/Ff\s+(\d+)/.exec(ultimo);
    return {
      campo: ref,
      nombre: /\/T\s*\(([^)]*)\)/.exec(ultimo)?.[1] ?? '?',
      widgets: kids ? (kids[1]!.match(/\d+\s+\d+\s+R/g) || []).length : 1,
      forma: kids ? 'campo con /Kids' : 'campo+widget fusionado',
      esFirma: /\/FT\s*\/Sig\b/.test(ultimo),
      soloLectura: !!ff && (Number(ff[1]) & 1) === 1,
    };
  });
}

/**
 * qpdf como árbitro: si un tercero se queja de la estructura, está mal.
 *
 * «extraneous whitespace seen before xref» lo produce el incremental update de
 * la propia librería, qpdf lo lee igual y ningún lector se inmuta. Es la única
 * advertencia tolerada, y está nombrada una por una a propósito: un filtro
 * ancho acá esconde justo lo que esto tiene que encontrar.
 */
export function estructuraSana(archivo: string) {
  const salidaQpdf = correr('qpdf', ['--check', archivo]);
  const graves = salidaQpdf.split('\n').filter(
    (l) => /WARNING|ERROR/.test(l) && !/extraneous whitespace/.test(l),
  );
  return { ok: !graves.length, graves };
}

/**
 * Qué hojas renderizan con contenido.
 *
 * ⚠ Ésta es la comprobación que faltaba el 2/8: el documento verificaba
 * perfecto y tenía dos hojas EN BLANCO. Una A4 vacía a 40 dpi pesa ~3 KB; con
 * texto, más de 6. Es grosero y alcanza — lo que hay que detectar es la
 * diferencia entre una hoja y una hoja vacía, no matices de gris.
 *
 * ⚠⚠ EL PREFIJO ES ÚNICO POR LLAMADA, Y NO ES UN DETALLE. `node:test` corre
 * cada archivo de pruebas en SU PROPIO PROCESO y en paralelo. Con un prefijo
 * compartido, dos pruebas escriben los mismos PNG a la vez y una lee el archivo
 * de la otra a medio escribir. Pasó en la Mac de Claudio el 3/8: la batería del
 * documento real informó «hojas con contenido: 1,3» —o sea, denunció una hoja
 * en blanco que no existía— mientras la del certificado renderizaba encima.
 *
 * Una prueba que falla a veces es peor que una que no existe: enseña a
 * ignorarla, y el día que tenga razón nadie le va a creer.
 */
let corrida = 0;
export function paginasConTinta(archivo: string, hojas: number): number[] {
  const pre = join(DIR, 'salida', `tinta-${process.pid}-${++corrida}`);
  correr('pdftoppm', ['-png', '-r', '40', archivo, pre]);
  const conTinta: number[] = [];
  const ancho = String(hojas).length;
  const escritos: string[] = [];
  for (let i = 1; i <= hojas; i++) {
    // pdftoppm rellena el número con ceros según el total de páginas.
    const cual = [String(i), String(i).padStart(ancho, '0'), String(i).padStart(2, '0')]
      .map((n) => `${pre}-${n}.png`).find(existsSync);
    if (!cual) continue;
    escritos.push(cual);
    const png = readFileSync(cual);
    // Un PNG que no termina en IEND está a medio escribir. Antes eso se contaba
    // como «hoja en blanco»; ahora se dice, porque es un problema de la prueba
    // y no del documento.
    if (png.length < 12 || png.toString('latin1', png.length - 8, png.length - 4) !== 'IEND') {
      throw new Error(`${cual} quedó a medio escribir: alguien más está renderizando encima`);
    }
    if (png.length > 6000) conTinta.push(i);
  }
  for (const f of escritos) rmSync(f, { force: true });
  return conTinta;
}

/**
 * El texto del PDF EN ORDEN DE CONTENIDO.
 *
 * ⚠ Sin `-raw`, poppler reacomoda por columnas y un valor corto encima de un
 * párrafo se entrevera con él —«Tel. 098 / 099 765 / 123 432»—: buscar la
 * cadena entera falla aunque el texto esté. Dos falsos negativos costó.
 */
export const extraer = (archivo: string) =>
  correr('pdftotext', ['-raw', archivo, '-']).replace(/\s+/g, ' ');

/**
 * Qué dice pdfsig —un lector ajeno— sobre las firmas del archivo.
 *
 * ⚠ `puedeValidar` no es un detalle. Poppler valida la criptografía con **NSS**,
 * y en macOS la base de NSS suele no existir: sale `NSS_Init failed: security
 * library: bad database`, TODAS las firmas se declaran «Invalid» —incluidas las
 * que en Linux salen válidas— y encima tarda ocho segundos en rendirse.
 *
 * O sea que ese «Invalid» no es un juicio sobre el documento: es que el
 * verificador no arrancó. Exigirlo igual sería hacer que la prueba fallara según
 * la máquina, que es la peor clase de prueba: la que enseña a ignorarla.
 *
 * Lo que SÍ vale en cualquier máquina —y es lo que esta comprobación vino a
 * cuidar— es **cuántas firmas ve el lector y si dice que alguna no está
 * firmada**. Ése fue el defecto real del 2/8: con `/Kids`, poppler listaba
 * cuatro widgets y decía de los cuatro «the signature form field is not
 * signed». La criptografía ya la comprobó `verificar()`, que es nuestro y no
 * depende de NSS.
 *
 * Para tenerlo también en macOS: `brew install nss` y
 * `certutil -N -d sql:$HOME/.pki/nssdb --empty-password`.
 */
export function firmasSegunPoppler(archivo: string) {
  const texto = correr('pdfsig', [archivo]);
  return {
    texto,
    campos: (texto.match(/Signature Field Name/g) || []).length,
    validas: (texto.match(/Signature is Valid/g) || []).length,
    sinFirmar: /not signed/i.test(texto),
    puedeValidar: !/NSS_Init failed/.test(texto),
  };
}

/** Guarda el PDF para poder mirarlo, y devuelve la ruta. */
export function guardar(nombre: string, pdf: Buffer): string {
  const p = salida(nombre);
  writeFileSync(p, pdf);
  return p;
}
