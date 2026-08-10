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

/* ═══════════════════════════════════════════════════════════════════════════
   LA TERCERA COMPROBACIÓN (deuda 11) — rectángulos contra la hoja, contra
   los demás rectángulos y contra el texto impreso.

   Las tres comprobaciones de `prueba-acrobat.md` §9 «se contestan solas sobre
   cualquier documento firmado». Las dos primeras (nombres duplicados, nombres
   con undefined) ya viven en otras pruebas; ésta es la tercera: un widget que
   se sale de la hoja, que pisa a otro, o que cae encima del texto impreso del
   cliente.

   ⚠ Se mide con qpdf y pdftotext, NO con nuestro verificador ni con pdf-lib —
   la regla de la cabecera de este archivo. `src/firma/tapado.ts` hace algo
   parecido para el producto; acá se reimplementa a propósito: el banco es la
   segunda opinión, y una segunda opinión con el mismo ojo no es una segunda
   opinión.

   ⚠ pdftotext -bbox da la y desde ARRIBA; los /Rect del PDF, desde abajo.
   Sin el espejo (alto − y) la comprobación compara peras con la sombra de
   las peras. Ya mordió una vez el 10/8 en tapado.ts.

   ⚠ El punto ciego de los escaneados NO se calla: una hoja con widgets y sin
   texto extraíble queda «no comprobable», nunca verde. La mitad de lo que
   sube un cliente es escaneado.
   ═══════════════════════════════════════════════════════════════════════════ */

export interface WidgetMedido {
  pagina: number;                          // base 0
  nombre: string;                          // /T propio o del /Parent; '?' si no hay
  rect: [number, number, number, number];  // normalizado: x1<x2, y1<y2
}

export interface VeredictoRectangulos {
  widgets: WidgetMedido[];
  fueraDeHoja: WidgetMedido[];
  pisadas: Array<[WidgetMedido, WidgetMedido]>;
  sobreTexto: Array<{ widget: WidgetMedido; palabrasDebajo: number }>;
  /** Hojas CON widgets y SIN texto extraíble: el punto ciego, dicho. */
  noComprobables: Array<{ pagina: number; motivo: string }>;
}

/** Los widgets de cada hoja según qpdf, con la hoja medida. */
export function widgetsSegunQpdf(archivo: string): {
  hojas: Array<{ ancho: number; alto: number }>;
  widgets: WidgetMedido[];
} {
  const crudo = correr('qpdf', ['--json=latest', '--json-key=pages', '--json-key=qpdf', archivo]);
  // ⚠ `correr()` pega stderr DESPUÉS de stdout cuando qpdf sale con código 3
  // (advertencia simple, p. ej. sobre un PDF con incrementos de firma). El
  // JSON termina en la última llave; lo que sigue son las advertencias.
  const j = JSON.parse(crudo.slice(crudo.indexOf('{'), crudo.lastIndexOf('}') + 1));
  const objetos: Record<string, any> = j.qpdf[1];
  const valorDe = (ref: string) => objetos['obj:' + ref]?.value;

  const sinPrefijo = (s: unknown) =>
    typeof s === 'string' ? s.replace(/^u:/, '').replace(/^b:/, '') : '?';

  // El /MediaBox puede vivir en el /Pages padre: se hereda caminando /Parent.
  const mediaBox = (dic: any): number[] | null => {
    for (let d = dic, i = 0; d && i < 32; d = d['/Parent'] ? valorDe(d['/Parent']) : null, i++) {
      if (Array.isArray(d['/MediaBox'])) return d['/MediaBox'];
    }
    return null;
  };

  const hojas: Array<{ ancho: number; alto: number }> = [];
  const widgets: WidgetMedido[] = [];

  (j.pages as Array<{ object: string }>).forEach((p, pagina) => {
    const dic = valorDe(p.object);
    const mb = mediaBox(dic) ?? [0, 0, 0, 0];
    hojas.push({ ancho: mb[2] - mb[0], alto: mb[3] - mb[1] });

    const annots: string[] = Array.isArray(dic?.['/Annots'])
      ? dic['/Annots']
      : (typeof dic?.['/Annots'] === 'string' ? valorDe(dic['/Annots']) ?? [] : []);
    for (const ref of annots) {
      const a = typeof ref === 'string' ? valorDe(ref) : ref;
      if (!a || a['/Subtype'] !== '/Widget') continue;
      const r = a['/Rect'];
      if (!Array.isArray(r) || r.length !== 4) continue;
      const nombre = a['/T'] ?? (a['/Parent'] ? valorDe(a['/Parent'])?.['/T'] : undefined);
      widgets.push({
        pagina,
        nombre: sinPrefijo(nombre),
        rect: [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])],
      });
    }
  });
  return { hojas, widgets };
}

/** Las palabras de cada hoja según pdftotext -bbox, con la y ya espejada. */
function palabrasSegunPoppler(archivo: string): Array<Array<[number, number, number, number]>> {
  const xml = correr('pdftotext', ['-bbox', archivo, '-']);
  const hojas: Array<Array<[number, number, number, number]>> = [];
  const rePagina = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
  for (let mp = rePagina.exec(xml); mp; mp = rePagina.exec(xml)) {
    const alto = Number(mp[2]);
    const palabras: Array<[number, number, number, number]> = [];
    const reW = /<word xMin="([-\d.]+)" yMin="([-\d.]+)" xMax="([-\d.]+)" yMax="([-\d.]+)">/g;
    for (let m = reW.exec(mp[3]!); m; m = reW.exec(mp[3]!)) {
      palabras.push([Number(m[1]), alto - Number(m[4]), Number(m[3]), alto - Number(m[2])]);
    }
    hojas.push(palabras);
  }
  return hojas;
}

const areaCruce = (a: [number, number, number, number], b: [number, number, number, number]) =>
  Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
  Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

/**
 * La tercera comprobación entera sobre un archivo firmado.
 *
 * - `fueraDeHoja`: el rectángulo asoma fuera de la hoja (medio punto de
 *   tolerancia por el redondeo). El x = 0 exacto de los campos clavados
 *   habría caído acá si además asomara; el borde mismo es válido.
 * - `pisadas`: dos widgets visibles con más de 1 pt² en común. Los
 *   rectángulos cero de las reservas no pisan nada por construcción.
 * - `sobreTexto`: pisa una palabra impresa si le cubre al menos la mitad
 *   (el mismo criterio que el verificador usa para las anotaciones).
 */
export function rectangulos(archivo: string): VeredictoRectangulos {
  const { hojas, widgets } = widgetsSegunQpdf(archivo);
  const palabras = palabrasSegunPoppler(archivo);
  const EPS = 0.5;

  const fueraDeHoja = widgets.filter((w) => {
    const h = hojas[w.pagina]!;
    return w.rect[0] < -EPS || w.rect[1] < -EPS ||
           w.rect[2] > h.ancho + EPS || w.rect[3] > h.alto + EPS;
  });

  const pisadas: Array<[WidgetMedido, WidgetMedido]> = [];
  for (let i = 0; i < widgets.length; i++) {
    for (let k = i + 1; k < widgets.length; k++) {
      const a = widgets[i]!, b = widgets[k]!;
      if (a.pagina !== b.pagina) continue;
      if (areaCruce(a.rect, b.rect) > 1) pisadas.push([a, b]);
    }
  }

  const sobreTexto: Array<{ widget: WidgetMedido; palabrasDebajo: number }> = [];
  const noComprobables: Array<{ pagina: number; motivo: string }> = [];
  const hojasSinTexto = new Set<number>();
  widgets.forEach((w) => { if (!(palabras[w.pagina] ?? []).length) hojasSinTexto.add(w.pagina); });
  hojasSinTexto.forEach((p) => noComprobables.push({
    pagina: p,
    motivo: 'la hoja no tiene texto extraíble (¿escaneada?): no se puede comprobar qué hay debajo',
  }));

  for (const w of widgets) {
    const lista = palabras[w.pagina] ?? [];
    if (!lista.length) continue;   // ya quedó como no comprobable
    let tapadas = 0;
    for (const p of lista) {
      const areaPalabra = (p[2] - p[0]) * (p[3] - p[1]);
      if (areaPalabra > 0 && areaCruce(w.rect, p) >= areaPalabra * 0.5) tapadas++;
    }
    if (tapadas > 0) sobreTexto.push({ widget: w, palabrasDebajo: tapadas });
  }

  return { widgets, fueraDeHoja, pisadas, sobreTexto, noComprobables };
}
