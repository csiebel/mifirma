import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

/**
 * Apariencia visible de la firma: la marca autógrafa dentro del PDF.
 *
 * ⚠ REGLA DE ORO Nº1. Nada de este archivo firma nada. Lo que produce es una
 * imagen ubicada en el documento para que un humano reconozca de un vistazo
 * quién firmó. El valor legal lo da el PAdES, y un documento sin marca está
 * firmado igual.
 *
 * ═══ POR QUÉ VA EN LA APARIENCIA DEL CAMPO Y NO ESTAMPADA EN LA PÁGINA ═══
 *
 * Estampar la marca como contenido de la página modifica el documento. En una
 * firma en serie eso significa cambiar lo que se VE de un PDF que alguien ya
 * firmó — criptográficamente sigue cerrando, pero el segundo firmante alteró lo
 * que vio el primero, y esa es exactamente la discusión que no queremos tener
 * en un juicio.
 *
 * La forma correcta —la que usan Acrobat y DocuSign— es meter la imagen en la
 * APARIENCIA del campo de firma. Entra en el mismo incremental update que la
 * firma, así que no es un cambio posterior: es parte de firmar.
 *
 * ═══ UN CAMPO DE FIRMA Y UNA SOLA MARCA; EL RESTO SON SELLOS ═══
 *
 * El requisito es que la rúbrica aparezca en las 200 hojas de un contrato y que
 * el panel de firmas muestre UNA firma, no 200. Se probaron las tres formas:
 *
 * 1. **N campos `/FT /Sig` con el mismo `/V`** (primera versión de este
 *    archivo). Un lector cuenta N firmas para un solo acto. Descartada: le
 *    miente al lector sobre cuántas veces consintió esa persona.
 *
 * 2. **Un campo con `/Kids`**, que es lo que dice la especificación —`/V` es
 *    heredable— y lo que uno escribiría leyendo el estándar. **No funciona**:
 *    poppler lista los cuatro widgets y dice de los cuatro *"the signature form
 *    field is not signed"*, porque busca `/V` en el widget y no sube al padre.
 *    Medido, no supuesto. Una firma que un lector declara no firmada es peor
 *    que una firma fea.
 *
 * 3. **Un campo fusionado campo+widget para UNA marca, y el resto como
 *    anotaciones `/Subtype /Stamp`.** El panel muestra exactamente una firma
 *    —la misma forma que produce `plainAddPlaceholder`, que sabemos que todos
 *    los lectores validan— y las demás marcas se dibujan como sellos, que
 *    ningún lector cuenta como firma.
 *
 *    ⚠ Pero un sello NO SE IMPRIME cuando el lector imprime «sólo el
 *    documento», que es una opción del diálogo de Acrobat. Medido el 2/8: el
 *    contrato salía con los campos completados y sin ninguna rúbrica a la
 *    vista. Legalmente da igual —la firma es la criptográfica— pero un
 *    contrato impreso que parece sin firmar es un problema igual.
 *
 * 4. **El resto como BOTONES de sólo lectura (`/FT /Btn`, pushbutton).** Es la
 *    que quedó. Un botón es un campo de formulario: se imprime siempre, se
 *    dibuja idéntico, no tiene valor que un lector pueda regenerar, y ningún
 *    lector lo cuenta como firma. Confirmado en Acrobat y en poppler.
 *
 * ⚠ Las marcas NO son decoración suelta: entran en el MISMO incremental update
 * que la firma, así que quedan dentro de su ByteRange. Moverlas o sacarlas
 * después rompe la firma igual que tocar el texto. Y no tocan el contenido de
 * la página: se agregan a su `/Annots`, igual que el widget.
 *
 * ═══ ⚠ EL ACROFORM SE EXTIENDE, NO SE REEMPLAZA ═══
 *
 * En un documento con varias firmas, cada firma agrega su campo al MISMO
 * AcroForm. Crear uno nuevo y reapuntar la raíz —que es lo que hacía la primera
 * versión— deja los campos de las firmas anteriores fuera del formulario: las
 * firmas siguen verificando byte a byte, pero el documento deja de declararlas
 * y el panel del lector muestra sólo la última.
 *
 * Se verificó reproduciéndolo: firma visible + firma sin marca dejaba el
 * AcroForm en `/Fields [26 0 R]`, perdiendo los cuatro widgets de la primera.
 *
 * Por lo mismo el diccionario lleva `/Type /AcroForm` como PRIMERA clave:
 * `plainAddPlaceholder` localiza el AcroForm existente con
 * `lastIndexOf('/Type /AcroForm')`, y sin esa clave devuelve -1 y termina
 * indexando el buffer desde el final —con índices negativos, en silencio—.
 * O sea: la firma SIN marca que viene después de una CON marca depende de que
 * esa clave esté. Es una dependencia real aunque no se vea.
 *
 * ⚠ DEPENDENCIA FRÁGIL, ANOTADA A PROPÓSITO. Se reusan helpers internos de
 * `@signpdf/placeholder-plain` (`dist/…`) para leer la tabla de referencias
 * cruzadas y reescribir página y catálogo. No son API pública: una versión
 * nueva de esa librería puede moverlos sin aviso. Se eligió reusarlos en vez de
 * reimplementar el manejo de xref —que es donde se corrompen los PDF— y el
 * precio es fijar la versión y probar al actualizar.
 */

const req = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-var-requires */
const readPdf = req('@signpdf/placeholder-plain/dist/readPdf').default;
const findObject = req('@signpdf/placeholder-plain/dist/findObject').default;
const getIndexFromRef = req('@signpdf/placeholder-plain/dist/getIndexFromRef').default;
const getPagesDictionaryRef = req('@signpdf/placeholder-plain/dist/getPagesDictionaryRef').default;
const trailer = req('@signpdf/placeholder-plain/dist/createBufferTrailer').default;

// ⚠ `createBufferPageWithAnnotation` y `createBufferRootWithAcroform` NO se
// reusan, y por qué está explicado arriba. Escribirlos acá es más código y
// menos dependencia frágil: son treinta líneas contra un diccionario corrupto
// que ningún test detectaba porque los PDF de prueba no tenían anotaciones.

export interface Marca {
  /** Índice de página, base 0. */
  pagina: number;
  /** [x1, y1, x2, y2] en puntos, origen abajo-izquierda como manda el PDF. */
  rect: [number, number, number, number];
  /** PNG con fondo transparente. Excluyente con `texto`. */
  imagen?: Buffer;
  /**
   * EXPERIMENTO — valor de un campo completado por el firmante.
   *
   * Excluyente con `imagen`. Va en el MISMO incremental update que la firma, o
   * sea que queda dentro de su ByteRange, y no toca el contenido de la página.
   */
  texto?: string;
  /** Cuerpo en puntos. Si no se indica, se ajusta al alto del rect. */
  cuerpo?: number;
  /**
   * Color del texto, [r, g, b] de 0 a 1. Si no se indica, la tinta general.
   *
   * ⚠ Es POR MARCA y no del documento entero. Antes había un solo color para
   * todo, y con un formulario que usa azul para lo que se completa a mano no
   * había forma de que el valor saliera como corresponde. Ver migración 056.
   */
  color?: [number, number, number];
  /**
   * Cómo se materializa la marca que NO es el campo de firma. Por omisión,
   * 'campo' — que es lo que se imprime.
   *
   *  · 'campo' — widget de formulario de sólo lectura: `/FT /Tx` con el valor
   *    en `/V` si es texto, `/FT /Btn` (pushbutton) si es una imagen.
   *  · 'sello' — anotación `/Subtype /Stamp`. Se dibuja igual en pantalla pero
   *    NO se imprime cuando el lector imprime «sólo el documento». Queda como
   *    escape, no como opción recomendada.
   */
  modo?: 'sello' | 'campo';
  /** Etiqueta del campo, para el modo 'campo'. */
  etiqueta?: string;
  /**
   * Cuál de las marcas ES el campo de firma. Las demás se dibujan como sellos.
   *
   * Si no se indica ninguna, se toma la primera. Conviene que sea la firma
   * completa y no una rúbrica: es la que el lector resalta al hacer clic en el
   * panel de firmas.
   */
  principal?: boolean;
}

/**
 * Decodifica un PNG de 8 bits, color type 2 (RGB) o 6 (RGBA), sin entrelazado.
 * Es el que produce `canvas.toBlob()`, que es de donde vienen nuestras firmas.
 */
export function decodificarPng(buf: Buffer) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('no es PNG');
  let i = 8;
  let ihdr: any = null;
  const idat: Buffer[] = [];
  while (i + 8 <= buf.length) {
    const largo = buf.readUInt32BE(i);
    const tipo = buf.toString('latin1', i + 4, i + 8);
    const datos = buf.subarray(i + 8, i + 8 + largo);
    if (tipo === 'IHDR') {
      ihdr = {
        ancho: datos.readUInt32BE(0), alto: datos.readUInt32BE(4),
        profundidad: datos[8], color: datos[9], entrelazado: datos[12],
      };
    } else if (tipo === 'IDAT') idat.push(datos);
    else if (tipo === 'IEND') break;
    i += 12 + largo;
  }
  if (!ihdr) throw new Error('PNG sin IHDR');
  if (ihdr.profundidad !== 8) throw new Error('sólo 8 bits por canal');
  if (ihdr.color !== 2 && ihdr.color !== 6) throw new Error('sólo RGB o RGBA');
  if (ihdr.entrelazado) throw new Error('PNG entrelazado no soportado');
  if (!idat.length) throw new Error('PNG sin datos de imagen');

  const canales = ihdr.color === 6 ? 4 : 3;
  const crudo = zlib.inflateSync(Buffer.concat(idat));
  const anchoFila = ihdr.ancho * canales;
  if (crudo.length < ihdr.alto * (anchoFila + 1)) throw new Error('PNG truncado');
  const px = Buffer.alloc(ihdr.alto * anchoFila);

  // Des-filtrado: cada fila arranca con su tipo de filtro. Es la parte del PNG
  // que hay que hacer bien o sale basura que igual "decodifica".
  let o = 0;
  for (let y = 0; y < ihdr.alto; y++) {
    const filtro = crudo[o++];
    const fila = crudo.subarray(o, o + anchoFila); o += anchoFila;
    const dest = px.subarray(y * anchoFila, (y + 1) * anchoFila);
    const arriba = y > 0 ? px.subarray((y - 1) * anchoFila, y * anchoFila) : null;
    for (let x = 0; x < anchoFila; x++) {
      const a = (x >= canales ? dest[x - canales] : 0)!;
      const b = (arriba ? arriba[x] : 0)!;
      const c = (arriba && x >= canales ? arriba[x - canales] : 0)!;
      let v = fila[x]!;
      if (filtro === 1) v += a;
      else if (filtro === 2) v += b;
      else if (filtro === 3) v += (a + b) >> 1;
      else if (filtro === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      } else if (filtro !== 0) throw new Error('filtro PNG desconocido: ' + filtro);
      dest[x] = v & 0xff;
    }
  }
  return { ...ihdr, canales, px };
}

/**
 * Convierte la imagen en una MÁSCARA de 1 bit por píxel.
 *
 * ═══ POR QUÉ MÁSCARA Y NO IMAGEN ═══
 *
 * Una firma es un trazo, no una foto: monocroma y con fondo transparente.
 * Como imagen RGBA habría que embeber el color y además un /SMask aparte para
 * el alfa — dos objetos, más peso, y el color del trazo congelado. Como
 * `ImageMask`, el PDF pinta con el color que le diga el contenido allí donde
 * hay tinta, y el resto queda transparente. Ocupa ocho veces menos y deja el
 * color como decisión de quien estampa.
 *
 * En un ImageMask el bit 0 pinta (con /Decode por defecto), así que se pone 0
 * donde hay trazo.
 */
export function aMascara(img: any, umbralAlfa = 96) {
  const bytesPorFila = Math.ceil(img.ancho / 8);
  const bits = Buffer.alloc(bytesPorFila * img.alto, 0xff);   // 1 = no pinta
  let conTinta = 0;
  for (let y = 0; y < img.alto; y++) {
    for (let x = 0; x < img.ancho; x++) {
      const p = (y * img.ancho + x) * img.canales;
      const alfa = img.canales === 4 ? img.px[p + 3] : 255;
      const lum = 0.299 * img.px[p] + 0.587 * img.px[p + 1] + 0.114 * img.px[p + 2];
      if (alfa >= umbralAlfa && lum < 190) {
        bits[y * bytesPorFila + (x >> 3)] &= ~(0x80 >> (x & 7));
        conTinta++;
      }
    }
  }
  // Una máscara sin un solo píxel encendido es un rectángulo vacío en el
  // documento: peor que no estampar nada, porque parece que algo falló.
  if (!conTinta) throw new Error('la imagen no tiene trazo visible');
  return { bits: zlib.deflateSync(bits), ancho: img.ancho, alto: img.alto };
}

/**
 * Una cadena de texto de PDF.
 *
 * ⚠ Si tiene algo fuera de ASCII va en UTF-16BE con BOM. Escribirla como UTF-8
 * —que es lo que hace `Buffer.from(str)` por defecto— produce "PÃ©rez" en el
 * panel de firmas de cualquier lector. Es el mismo formato que ya sabe leer
 * `decodificarTexto()` del verificador.
 */
function cadenaPdf(t: string | null | undefined) {
  const s = String(t ?? '');
  if (/^[\x20-\x7e\n\r\t]*$/.test(s)) return '(' + s.replace(/([\\()])/g, '\\$1') + ')';
  let out = '\\376\\377';                       // BOM FE FF, en octal
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    const u = c > 0xffff ? [0xd800 + ((c - 0x10000) >> 10), 0xdc00 + ((c - 0x10000) & 0x3ff)] : [c];
    for (const v of u) {
      out += '\\' + ((v >> 8) & 0xff).toString(8).padStart(3, '0');
      out += '\\' + (v & 0xff).toString(8).padStart(3, '0');
    }
  }
  return '(' + out + ')';
}

/**
 * Una cadena para DIBUJAR dentro de un flujo de contenido con
 * `/Encoding /WinAnsiEncoding`.
 *
 * ⚠ NO es lo mismo que `cadenaPdf`. Aquélla escribe UTF-16BE cuando hay algo
 * fuera de ASCII, que es lo correcto para `/V`, `/T` o `/Reason` —objetos de
 * texto del PDF—. Adentro de un flujo de contenido cada byte es un índice en la
 * tabla de la fuente: escribir UTF-16 ahí dibuja basura. Es exactamente la
 * misma trampa que apareció con el certificado de finalización.
 *
 * WinAnsi cubre acentos, ñ, ç y ã, o sea todo el MVP. No cubre chino ni árabe:
 * el día que haya que soportarlos hay que embeber una fuente, y eso es otro
 * problema (grande).
 */
/**
 * Los 27 caracteres que WinAnsi mete entre 0x80 y 0x9F y que NO están en
 * Unicode en ese rango. Son justamente los tipográficos que la gente escribe
 * sin darse cuenta: la raya, las comillas curvas que pone el corrector del
 * teléfono, los puntos suspensivos, el símbolo del euro.
 *
 * Sin esta tabla, «Montevideo — Uruguay» se dibuja «Montevideo ? Uruguay».
 * Medido en el laboratorio, no supuesto.
 */
const WINANSI_ALTO: Record<string, number> = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85,
  '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a,
  '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92,
  '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97,
  '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c,
  'ž': 0x9e, 'Ÿ': 0x9f,
};

/** Lo que WinAnsi no puede dibujar. Vacío = se puede estampar tal cual. */
export function fueraDeWinAnsi(t: string): string[] {
  const malos = new Set<string>();
  for (const ch of String(t ?? '')) {
    const c = ch.codePointAt(0)!;
    const ok = (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || ch in WINANSI_ALTO;
    if (!ok) malos.add(ch);
  }
  return [...malos];
}

function cadenaContenido(t: string): string {
  let out = '';
  for (const ch of String(t ?? '')) {
    const c = ch.codePointAt(0)!;
    if (c === 0x28 || c === 0x29 || c === 0x5c) out += '\\' + ch;      // ( ) \
    else if (c >= 0x20 && c <= 0x7e) out += ch;
    else {
      const b = c >= 0xa0 && c <= 0xff ? c : WINANSI_ALTO[ch];
      // No hay reemplazo silencioso: dibujar «?» donde el usuario escribió otra
      // cosa deja el `/V` diciendo una cosa y los píxeles otra, en un documento
      // que se está por firmar. Se corta antes.
      if (b == null) throw new Error(`no se puede dibujar «${ch}» con la fuente estándar`);
      out += '\\' + b.toString(8).padStart(3, '0');
    }
  }
  return '(' + out + ')';
}

/** Ancho aproximado de una cadena en Helvetica, en unidades de 1/1000 de em. */
function anchoHelvetica(t: string): number {
  // Suficiente para decidir si hay que achicar el cuerpo. La tabla exacta de
  // métricas es de la fuente; esto es el promedio ponderado del latín.
  let w = 0;
  for (const ch of t) {
    const c = ch.charCodeAt(0);
    if (c === 32) w += 278;
    else if ('iljI.,:;\'|!'.includes(ch)) w += 250;
    else if ('fjrt'.includes(ch)) w += 320;
    else if ('mwMW@'.includes(ch)) w += 830;
    else if (ch >= 'A' && ch <= 'Z') w += 680;
    else w += 556;
  }
  return w;
}


// ═══════════════════════════════════════════════════════════════════════════
// Leer y reescribir objetos, a mano
//
// ⚠ TODO EN latin1, no en utf8. Un PDF es una secuencia de BYTES: leerlo como
// utf8 convierte cualquier byte >127 en el carácter de reemplazo, y al
// escribirlo de vuelta sale otra cosa. latin1 es el único que va y vuelve sin
// tocar nada. (Los helpers de la librería usan `.toString()`, o sea utf8, y ahí
// hay una corrupción silenciosa esperando un documento con acentos en su
// catálogo.)
// ═══════════════════════════════════════════════════════════════════════════

/** El cuerpo crudo de un objeto: lo que hay entre `obj` y `endobj`. */
function cuerpoObjeto(pdf: Buffer, info: any, ref: string): string {
  const idx = getIndexFromRef(info.xref, ref);
  const off = info.xref.offsets.get(idx);
  if (off == null) throw new Error(`no encuentro el objeto ${ref}`);
  const desde = pdf.indexOf('obj', off);
  const hasta = pdf.indexOf('endobj', desde);
  if (desde < 0 || hasta < 0) throw new Error(`el objeto ${ref} está mal formado`);
  return pdf.subarray(desde + 3, hasta).toString('latin1');
}

/**
 * Dónde TERMINA el valor que empieza en `i`. Sirve para sacar una clave de un
 * diccionario sin tocar lo demás.
 *
 * Cubre las formas que puede tomar un valor en un diccionario: nombre, número,
 * referencia indirecta (`12 0 R`), booleano, `null`, arreglo, diccionario y las
 * dos clases de cadena. La referencia es la que obliga a mirar hacia adelante:
 * son tres tokens y el primero se confunde con un número suelto.
 */
function finDeValor(s: string, desde: number): number {
  let i = desde;
  while (i < s.length && /[\s]/.test(s[i]!)) i++;
  const c = s[i];
  // ⚠ `cierreDeArreglo` devuelve la posición DEL `]`, no la de después. Sin el
  // +1 queda un `]` suelto en el diccionario, y —peor— el siguiente `]` le baja
  // la profundidad a `claveEnNivelUno`, que deja de encontrar todo lo que venga
  // después. Un carácter de diferencia y dos síntomas sin relación aparente.
  if (c === '[') return cierreDeArreglo(s, i) + 1;
  if (c === '<' && s[i + 1] === '<') {
    let prof = 0;
    while (i < s.length) {
      if (s[i] === '<' && s[i + 1] === '<') { prof++; i += 2; continue; }
      if (s[i] === '>' && s[i + 1] === '>') { prof--; i += 2; if (!prof) return i; continue; }
      if (s[i] === '(') { let n = 1; i++; while (i < s.length && n) { if (s[i] === '\\') i++; else if (s[i] === '(') n++; else if (s[i] === ')') n--; i++; } continue; }
      i++;
    }
    return i;
  }
  if (c === '<') return s.indexOf('>', i) + 1;
  if (c === '(') { let n = 1; i++; while (i < s.length && n) { if (s[i] === '\\') i++; else if (s[i] === '(') n++; else if (s[i] === ')') n--; i++; } return i; }
  if (c === '/') { i++; while (i < s.length && !/[\s/<>[\]()%]/.test(s[i]!)) i++; return i; }
  // Número, booleano, null… o el primero de los tres tokens de una referencia.
  const ref = /^\s*(\d+)\s+(\d+)\s+R\b/.exec(s.slice(desde));
  if (ref) return desde + ref[0].length;
  while (i < s.length && !/[\s/<>[\]()%]/.test(s[i]!)) i++;
  return i;
}

/**
 * El AcroForm que va a quedar: el que había, **con sus claves intactas**, más
 * los campos nuevos.
 *
 * ⚠ La versión anterior escribía el diccionario de cero con `/Type`, `/SigFlags`
 * y `/Fields`, y nada más. Todo lo que el formulario del cliente traía —`/DR`
 * con sus fuentes, `/DA`, `/Q`, `/XFA`— desaparecía al firmar. Medido con un
 * formulario hecho con pdf-lib: entraba con `/NeedAppearances true` y salía sin
 * él.
 *
 * `/NeedAppearances` es el único que se saca A PROPÓSITO, y hay que sacarlo:
 * significa «lector, dibujá vos los valores», o sea que lo que se ve lo decide
 * cada lector. Sobre un documento firmado eso es inaceptable — dos lectores
 * mostrarían cosas distintas del mismo documento firmado—. Las apariencias se
 * generan en `normalizar()`, antes de que exista ninguna firma, y a partir de
 * ahí lo que se ve está congelado y cubierto por el ByteRange.
 */
function acroExtendido(dicViejo: string | null, campos: string[]): string {
  const cuerpo = dicViejo === null ? '' : (() => {
    const a = dicViejo.indexOf('<<');
    const b = dicViejo.lastIndexOf('>>');
    if (a < 0 || b < 0) return '';
    // ⚠ CON los `<< >>`: `claveEnNivelUno` mide profundidad y exige `prof === 1`.
    // Pasarle el contenido pelado devuelve -1 para todo, en silencio, y el
    // resultado es un diccionario con la clave repetida: la nuestra primero y la
    // vieja después, que es la que gana. Costó una corrida entenderlo.
    let s = dicViejo.slice(a, b + 2);
    for (const clave of ['/Type', '/SigFlags', '/Fields', '/NeedAppearances']) {
      for (;;) {
        const k = claveEnNivelUno(s, clave);
        if (k < 0) break;
        s = s.slice(0, k) + s.slice(finDeValor(s, k + clave.length));
      }
    }
    return s.slice(2, s.lastIndexOf('>>')).trim();
  })();
  // `/Type /AcroForm` va PRIMERO: ver la nota de arriba sobre `lastIndexOf`.
  return `<<\n/Type /AcroForm\n/SigFlags 3\n/Fields [${campos.join(' ')}]` +
         (cuerpo ? `\n${cuerpo}` : '') + '\n>>';
}

/**
 * Dónde está una clave en el NIVEL SUPERIOR del diccionario, o -1.
 *
 * Un `indexOf('/Annots')` suelto encuentra también el que esté adentro de un
 * diccionario anidado o de una cadena, y ahí se edita el lugar equivocado. Esto
 * lleva la cuenta de la profundidad y saltea cadenas literales y hexadecimales.
 */
function claveEnNivelUno(dic: string, clave: string): number {
  let prof = 0;
  let i = 0;
  while (i < dic.length) {
    const c = dic[i]!;
    if (c === '%') { while (i < dic.length && dic[i] !== '\n') i++; continue; }
    if (c === '(') {                       // cadena literal, con paréntesis anidados
      let n = 1; i++;
      while (i < dic.length && n > 0) {
        if (dic[i] === '\\') i++;
        else if (dic[i] === '(') n++;
        else if (dic[i] === ')') n--;
        i++;
      }
      continue;
    }
    if (c === '<' && dic[i + 1] === '<') { prof++; i += 2; continue; }
    if (c === '>' && dic[i + 1] === '>') { prof--; i += 2; continue; }
    if (c === '<') {                        // cadena hexadecimal
      const f = dic.indexOf('>', i);
      if (f < 0) break;
      i = f + 1; continue;
    }
    if (c === '[') { prof++; i++; continue; }
    if (c === ']') { prof--; i++; continue; }
    if (c === '/' && prof === 1 && dic.startsWith(clave, i)) {
      // Que no sea el prefijo de otra clave: /Annots vs /AnnotsRaros.
      const sig = dic[i + clave.length];
      if (sig === undefined || /[\s/[\]<>(]/.test(sig)) return i;
    }
    i++;
  }
  return -1;
}

/** El `]` que cierra el arreglo que abre en `desde`. */
function cierreDeArreglo(s: string, desde: number): number {
  let prof = 0;
  let i = desde;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '(') {
      let n = 1; i++;
      while (i < s.length && n > 0) {
        if (s[i] === '\\') i++;
        else if (s[i] === '(') n++;
        else if (s[i] === ')') n--;
        i++;
      }
      continue;
    }
    if (c === '[') prof++;
    else if (c === ']') { prof--; if (prof === 0) return i; }
    i++;
  }
  throw new Error('arreglo sin cerrar');
}

/**
 * Agrega anotaciones a una página, sin tocar nada más.
 *
 * ⚠ ACÁ ESTABA EL BUG QUE CORROMPÍA DOCUMENTOS REALES.
 *
 * `createBufferPageWithAnnotation` de la librería asume que `/Annots` es un
 * arreglo escrito ahí mismo. Cuando la página lo tiene como REFERENCIA
 * INDIRECTA —`/Annots 35 0 R`, que es lo normal en PDF generados por
 * herramientas de oficina— busca el `]` que cierra el arreglo, no lo encuentra,
 * y a partir de ahí opera con índices negativos: el diccionario de la página
 * sale **duplicado**, con un `]` suelto en el medio.
 *
 * El resultado no da error. La firma verifica. poppler avisa y se recupera; el
 * visor de Safari muestra la hoja **en blanco**. Se detectó el 2/8/2026 con un
 * documento real de tres páginas: la primera, que no tenía anotaciones, salió
 * perfecta; la segunda y la tercera, que sí tenían, quedaron vacías.
 *
 * ⚠ El mismo defecto afecta a `plainAddPlaceholder`, que llama a ese helper
 * sobre la primera página. O sea que la firma SIN marca también corrompía —
 * sólo que hacía falta un documento cuya primera página tuviera anotaciones
 * para verlo. Por eso acá abajo se dejó de usar del todo.
 *
 * Devuelve los objetos a reescribir. Cuando `/Annots` es indirecto se reescribe
 * el ARREGLO y la página no se toca: menos bytes y menos superficie de error.
 */
function objetosConAnotacion(
  pdf: Buffer, info: any, pageRef: string, nuevos: string[],
): { idx: number; cuerpo: string }[] {
  const dic = cuerpoObjeto(pdf, info, pageRef);
  const lista = nuevos.join(' ');
  const p = claveEnNivelUno(dic, '/Annots');

  // 1) La página no tenía anotaciones: se agrega la clave.
  if (p < 0) {
    const cierre = dic.lastIndexOf('>>');
    if (cierre < 0) throw new Error('la página no parece un diccionario');
    return [{
      idx: getIndexFromRef(info.xref, pageRef),
      cuerpo: dic.slice(0, cierre) + `\n/Annots [${lista}]\n` + dic.slice(cierre),
    }];
  }

  let j = p + '/Annots'.length;
  while (j < dic.length && /\s/.test(dic[j]!)) j++;

  // 2) Arreglo escrito en la misma página: se insertan antes del cierre.
  if (dic[j] === '[') {
    const fin = cierreDeArreglo(dic, j);
    return [{
      idx: getIndexFromRef(info.xref, pageRef),
      cuerpo: dic.slice(0, fin) + ` ${lista}` + dic.slice(fin),
    }];
  }

  // 3) Referencia indirecta: se reescribe el arreglo, no la página.
  const m = /^(\d+)\s+(\d+)\s+R/.exec(dic.slice(j));
  if (m) {
    const refArr = `${m[1]} ${m[2]} R`;
    const arr = cuerpoObjeto(pdf, info, refArr);
    const fin = arr.lastIndexOf(']');
    if (fin < 0) throw new Error('/Annots apunta a algo que no es un arreglo');
    return [{
      idx: getIndexFromRef(info.xref, refArr),
      cuerpo: arr.slice(0, fin) + ` ${lista}` + arr.slice(fin),
    }];
  }

  // Preferible fallar que adivinar: `sellar()` lo captura, firma sin marca y
  // deja el motivo en el expediente. Un documento sin trazo es correcto; uno
  // con el diccionario roto, no.
  throw new Error('no se entiende el /Annots de esta página');
}

/** La raíz con su `/AcroForm`, reemplazando la clave si ya estaba. */
function raizConAcroform(pdf: Buffer, info: any, acroRef: string): string {
  const dic = cuerpoObjeto(pdf, info, info.rootRef);
  const p = claveEnNivelUno(dic, '/AcroForm');
  if (p < 0) {
    const cierre = dic.lastIndexOf('>>');
    return dic.slice(0, cierre) + `\n/AcroForm ${acroRef}\n` + dic.slice(cierre);
  }
  // Ya había uno: se pisa su valor. No se agrega una segunda clave, que es lo
  // que hacía el helper de la librería y produce un diccionario ambiguo.
  const resto = dic.slice(p + '/AcroForm'.length);
  const m = /^\s*(\d+\s+\d+\s+R|<<[\s\S]*?>>)/.exec(resto);
  if (!m) throw new Error('no se entiende el /AcroForm del catálogo');
  return dic.slice(0, p) + `/AcroForm ${acroRef}` + resto.slice(m[0].length);
}

/**
 * Todas las páginas, en orden.
 *
 * ⚠ El árbol de páginas puede tener nodos intermedios: `/Kids` no siempre son
 * páginas. Quedarse con el primer nivel —lo que hacía la versión anterior—
 * funciona con los PDF chicos y cuelga el widget de un nodo `/Pages` en los
 * grandes, que no es un error visible sino un documento mal formado que abre
 * igual. Se recorre el árbol.
 */
function refsDePaginas(pdf: Buffer, info: any): string[] {
  const salida: string[] = [];
  const visto = new Set<string>();

  const bajar = (ref: string, hondura: number) => {
    if (hondura > 32 || visto.has(ref)) return;      // los ciclos existen
    visto.add(ref);
    let dic: string;
    try {
      dic = findObject(pdf, info.xref, ref).toString();
    } catch {
      salida.push(ref);                              // ilegible: tratarlo como hoja
      return;
    }
    const i = dic.indexOf('/Kids');
    if (i < 0) { salida.push(ref); return; }         // es una página
    const kids = dic.slice(dic.indexOf('[', i) + 1, dic.indexOf(']', i));
    for (const k of kids.match(/\d+\s+\d+\s+R/g) || []) bajar(k, hondura + 1);
  };

  bajar(getPagesDictionaryRef(info), 0);
  return salida;
}

/** El `N 0 R` del AcroForm que ya tiene el documento, si tiene. */
function acroformExistente(root: string): string | undefined {
  const m = /\/AcroForm\s+(\d+\s+\d+\s+R)/.exec(root);
  return m?.[1]?.replace(/\s+/g, ' ');
}

/** Los campos que ya están en ese AcroForm, como refs `N 0 R`. */
function camposDe(pdf: Buffer, info: any, acroRef: string): string[] {
  try {
    const dic = findObject(pdf, info.xref, acroRef).toString();
    const i = dic.indexOf('/Fields');
    if (i < 0) return [];
    const lista = dic.slice(dic.indexOf('[', i) + 1, dic.indexOf(']', i));
    return lista.match(/\d+\s+\d+\s+R/g) || [];
  } catch {
    return [];
  }
}

/**
 * Los widgets que MiFirma dejó PRE-DECLARADOS en el AcroForm, por su nombre.
 *
 * ⚠ Existe para que una firma pueda COMPLETAR un widget en vez de AGREGARLO, y
 * eso no es una optimización: es la diferencia entre que Acrobat diga «el
 * documento se ha modificado o dañado desde que fue firmado» y que diga «esta
 * revisión del documento no se ha modificado».
 *
 * Medido el 8/8 con tres PDF de laboratorio idénticos salvo en eso
 * (`claude/cambios-posteriores-a-la-firma.md`): agregar un campo de formulario
 * nuevo después de una firma NO está entre los cambios que un lector da por
 * permitidos; completar uno que ya estaba, SÍ. Con N firmantes, la forma vieja
 * deja N−1 firmas en rojo, y el que ve el cartel es el cliente.
 *
 * ⚠ Sólo se devuelven los que llevan `/MiFirma true`. El nombre de nuestro
 * widget se deriva del código del campo, que a su vez ES el nombre de un campo
 * del formulario del cliente: sin la marca, un cliente que tuviera un campo
 * llamado `razon_social__mf1` haría que le reescribiéramos EL SUYO, en silencio
 * y adentro de un documento firmado.
 */
function widgetsPredeclarados(pdf: Buffer, info: any, acroRef: string | undefined): Map<string, string> {
  const mapa = new Map<string, string>();
  if (!acroRef) return mapa;
  for (const ref of camposDe(pdf, info, acroRef)) {
    try {
      const cuerpo = cuerpoObjeto(pdf, info, ref);
      if (!/\/MiFirma\s+true\b/.test(cuerpo)) continue;
      // El `/T` de lo que nosotros escribimos siempre sale de `cadenaPdf`, así
      // que es una cadena literal con `\\`, `(` y `)` escapados. No hace falta
      // cubrir la forma hexadecimal: no la generamos.
      const t = /\/T\s*\(((?:\\.|[^\\()])*)\)/.exec(cuerpo);
      if (t) mapa.set(t[1]!.replace(/\\([\\()])/g, '$1'), ref.replace(/\s+/g, ' '));
    } catch {
      // Un campo ilegible no puede impedir que se usen los demás: se cae al
      // camino viejo —agregarlo— que sigue produciendo un documento correcto.
    }
  }
  return mapa;
}

/**
 * Agrega un hueco de firma CON APARIENCIA VISIBLE, en las páginas y posiciones
 * indicadas. Nada del contenido de las páginas se toca: se les agrega una
 * anotación y nada más.
 */
export function huecoVisible({
  pdf,
  marcas,
  razon,
  nombre,
  lugar,
  contacto,
  largoFirma = 32768,
  tinta = [0.07, 0.09, 0.16],
}: {
  pdf: Buffer;
  marcas: Marca[];
  razon: string;
  nombre: string;
  lugar?: string;
  contacto?: string;
  largoFirma?: number;
  /** Color del trazo, RGB de 0 a 1. La máscara no lleva color propio. */
  tinta?: number[];
}): Buffer {
  const info = readPdf(pdf);
  const paginas = refsDePaginas(pdf, info);
  for (const m of marcas) {
    if (!paginas[m.pagina]) {
      throw new Error(`el documento tiene ${paginas.length} página(s): no existe la ${m.pagina + 1}`);
    }
  }

  let salida = Buffer.from(pdf);
  const refs = new Map<number, number>();

  let indice: number = info.xref.maxIndex;
  const reservar = () => (indice += 1);

  /** Escribe un objeto con un índice dado. Sirve para agregar y para reemplazar. */
  const escribir = (idx: number, cuerpo: Buffer) => {
    refs.set(idx, salida.length + 1);
    salida = Buffer.concat([
      salida, Buffer.from('\n'), Buffer.from(`${idx} 0 obj\n`), cuerpo, Buffer.from('\nendobj\n'),
    ]);
    return `${idx} 0 R`;
  };
  const agregar = (cuerpo: Buffer) => escribir(reservar(), cuerpo);
  const flujo = (dic: string, datos: Buffer) =>
    Buffer.concat([Buffer.from(`<<\n${dic}\n/Length ${datos.length}\n>>\nstream\n`), datos,
                   Buffer.from('\nendstream')]);

  // 1) El hueco de la firma. Es UNO solo aunque se muestre en varias hojas.
  //
  // ⚠ El orden de las claves importa: `signpdf` busca `/Contents ` DESPUÉS del
  // `/ByteRange`, y nuestro verificador busca `/Reason` y `/Name` después de
  // `/Contents`. No reordenar sin releer los dos.
  const relleno = '0'.repeat(largoFirma * 2);
  const sigRef = agregar(Buffer.from(
    '<<\n/Type /Sig\n/Filter /Adobe.PPKLite\n/SubFilter /ETSI.CAdES.detached\n' +
    `/ByteRange [0 /********** /********** /**********]\n/Contents <${relleno}>\n` +
    `/Reason ${cadenaPdf(razon)}\n/M (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z)\n` +
    `/Name ${cadenaPdf(nombre)}\n/Location ${cadenaPdf(lugar || '')}\n/ContactInfo ${cadenaPdf(contacto || '')}\n>>`));

  const acroRefViejo = acroformExistente(info.root);
  const camposViejos = acroRefViejo ? camposDe(pdf, info, acroRefViejo) : [];
  const predeclarados = widgetsPredeclarados(pdf, info, acroRefViejo);
  // Único dentro del documento y estable: no depende del reloj.
  //
  // ⚠ Se cuentan sólo los campos de FIRMA, no todos los del AcroForm. Cuando
  // empezaron a convivir con campos de texto, la segunda firma de un documento
  // salía llamándose «MiFirma3» y eso es lo que el lector muestra en el panel.
  const firmasPrevias = camposViejos.filter((ref) => {
    try { return /\/FT\s*\/Sig\b/.test(cuerpoObjeto(pdf, info, ref)); } catch { return false; }
  }).length;
  const nombreCampo = `MiFirma${firmasPrevias + 1}`;

  // Cuál de las marcas es el campo de firma. El resto se dibuja como sello.
  const iPrincipal = Math.max(0, marcas.findIndex((m) => m.principal));

  // ⚠ La imagen y la apariencia se embeben UNA vez y se reusan.
  //
  // Sin esto, un contrato de 200 hojas rubricado entero embebe 200 copias
  // idénticas del mismo trazo. Medido: 4,39 KB por hoja, 879 KB de sobrecosto
  // para dos firmantes. El PDF está hecho justamente para que un XObject se
  // referencie desde muchos lugares.
  /** [r,g,b] de 0 a 1 → la cadena de tres decimales que espera el PDF. */
  const aRgb = (c: readonly number[]) =>
    c.map((v) => Math.min(1, Math.max(0, v)).toFixed(3)).join(' ');
  const rgb = aRgb(tinta);
  const imagenes = new Map<string, string>();
  const apariencias = new Map<string, string>();

  const refImagen = (png: Buffer) => {
    const clave = createHash('sha256').update(png).digest('hex');
    let ref = imagenes.get(clave);
    if (ref) return ref;
    const mask = aMascara(decodificarPng(png));
    ref = agregar(flujo(
      `/Type /XObject\n/Subtype /Image\n/Width ${mask.ancho}\n/Height ${mask.alto}\n` +
      '/ImageMask true\n/BitsPerComponent 1\n/Filter /FlateDecode', mask.bits));
    imagenes.set(clave, ref);
    return ref;
  };

  const refApariencia = (png: Buffer, w: number, h: number) => {
    const imgRef = refImagen(png);
    const clave = `${imgRef}|${w}|${h}`;
    let ref = apariencias.get(clave);
    if (ref) return ref;
    // El BBox arranca en 0,0: la apariencia vive en su propio sistema de
    // coordenadas y el /Rect de la anotación la ubica en la página.
    ref = agregar(flujo(
      `/Type /XObject\n/Subtype /Form\n/FormType 1\n/BBox [0 0 ${w} ${h}]\n` +
      `/Resources << /XObject << /Im0 ${imgRef} >> >>`,
      Buffer.from(`q\n${rgb} rg\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ`)));
    apariencias.set(clave, ref);
    return ref;
  };

  /**
   * Apariencia de un valor de texto. La fuente va como diccionario directo en
   * los recursos de la propia apariencia: no toca el `/DR` del AcroForm ni los
   * recursos de la página, así que no hay nada compartido que se pueda pisar
   * entre dos firmantes.
   */
  const refTexto = (texto: string, w: number, h: number, pedido?: number,
                    color?: [number, number, number]) => {
    let cuerpo = pedido ?? Math.min(11, Math.max(6, h * 0.62));
    // Que no se desborde del rect. Es lo que hace Acrobat con «auto».
    const ancho = anchoHelvetica(texto) / 1000;
    if (ancho * cuerpo > w - 4) cuerpo = Math.max(4, (w - 4) / Math.max(ancho, 0.001));
    const base = Math.max(1, (h - cuerpo * 0.72) / 2);
    const rgbTexto = color ? aRgb(color) : rgb;
    // ⚠ El color va en la CLAVE de la caché. Sin él, dos campos con el mismo
    // texto y el mismo recuadro comparten apariencia, y el segundo sale del
    // color del primero — un valor dibujado de un color que nadie eligió, sin
    // ningún error a la vista.
    const clave = `${texto}|${w}|${h}|${cuerpo.toFixed(2)}|${rgbTexto}`;
    let ref = apariencias.get(clave);
    if (ref) return ref;
    ref = agregar(flujo(
      `/Type /XObject\n/Subtype /Form\n/FormType 1\n/BBox [0 0 ${w} ${h}]\n` +
      '/Resources << /Font << /Ayuda << /Type /Font /Subtype /Type1 ' +
      '/BaseFont /Helvetica /Encoding /WinAnsiEncoding >> >> >>',
      // `/Tx BMC … EMC` es lo que envuelve Acrobat en la apariencia de un campo
      // de texto. Para un sello es inocuo; para un campo, lo esperado.
      Buffer.from(`/Tx BMC\nq\nBT\n/Ayuda ${cuerpo.toFixed(2)} Tf\n${rgbTexto} rg\n` +
                  `2 ${base.toFixed(2)} Td\n${cadenaContenido(texto)} Tj\nET\nQ\nEMC`, 'latin1')));
    apariencias.set(clave, ref);
    return ref;
  };

  // 2) Una anotación por marca. Sólo la principal es el campo de firma.
  //
  // Sin marcas hay igual UN widget: el campo de firma tiene que existir y estar
  // en alguna página. Va con `/Rect [0 0 0 0]` y sin apariencia — invisible,
  // que es exactamente lo que hacía `plainAddPlaceholder` antes de que
  // dejáramos de usarlo.
  const anotaciones: { pagina: number; ref: string }[] = [];
  let refCampo = '';

  if (!marcas.length) {
    refCampo = agregar(Buffer.from(
      '<<\n/Type /Annot\n/Subtype /Widget\n/Rect [0 0 0 0]\n/F 4\n' +
      `/P ${paginas[0]}\n/FT /Sig\n/V ${sigRef}\n/T ${cadenaPdf(nombreCampo)}\n>>`));
    anotaciones.push({ pagina: 0, ref: refCampo });
  }

  /** Campos que además del de firma van al AcroForm: valores y rúbricas-botón. */
  const camposExtra: string[] = [];

  for (const [n, m] of marcas.entries()) {
    const w = m.rect[2] - m.rect[0], h = m.rect[3] - m.rect[1];
    const esTexto = m.texto != null;
    if (esTexto === (m.imagen != null)) {
      throw new Error('cada marca lleva imagen o texto, uno y sólo uno');
    }
    const apRef = esTexto
      ? refTexto(m.texto!, w, h, m.cuerpo, m.color)
      : refApariencia(m.imagen!, w, h);

    const comun =
      `/Type /Annot\n/Rect [${m.rect.join(' ')}]\n` +
      `/P ${paginas[m.pagina]}\n/AP << /N ${apRef} >>`;

    // El nombre del widget, cuando lo tiene. Es la llave para saber si ya
    // existe pre-declarado. Los sellos y el hueco de firma no entran acá.
    let nombreWidget: string | null = null;
    let cuerpoAnot: string;
    if (esTexto && (m.modo ?? 'campo') === 'campo') {
      // Campo de texto de SÓLO LECTURA, con el valor en `/V`.
      //
      // Es lo que semánticamente es: un campo de formulario completado. El
      // valor queda además legible como DATO —no sólo como píxeles—, que es lo
      // que permite que un tercero lo extraiga sin OCR. `/Ff 1` = sólo lectura.
      const t = nombreWidget = m.etiqueta || `Campo${camposExtra.length + 1}_${nombreCampo}`;
      cuerpoAnot =
        `<<\n${comun}\n/Subtype /Widget\n/F 68\n/FT /Tx\n/Ff 1\n` +
        `/V ${cadenaPdf(m.texto!)}\n/T ${cadenaPdf(t)}\n` +
        // ⚠ El `/DA` tiene que decir el MISMO color que la apariencia. Si
        // discrepan, un lector que regenere la apariencia dibuja un color
        // distinto del que se firmó.
        `/DA (/Ayuda 0 Tf ${m.color ? aRgb(m.color) : rgb} rg)\n>>`;
    } else if (esTexto) {
      cuerpoAnot =
        `<<\n${comun}\n/Subtype /Stamp\n/F 68\n` +
        `/Contents ${cadenaPdf(m.texto!)}\n>>`;
    } else if (n !== iPrincipal && m.modo !== 'sello') {
      // La rúbrica va como BOTÓN de sólo lectura, no como sello.
      //
      // ⚠ Medido en Acrobat el 2/8: con «Comentarios y formularios: Documento»
      // —una opción del diálogo de impresión que el cliente puede elegir sin
      // querer— los sellos NO se imprimen y los campos de formulario SÍ. Un
      // contrato impreso sin ninguna firma a la vista parece un contrato sin
      // firmar: es un problema comercial aunque no sea uno legal.
      //
      // Un botón es un campo de formulario, así que se imprime; no tiene valor
      // que un lector pueda regenerar, así que la apariencia no se toca; y
      // ningún lector lo cuenta como firma, que era la única razón por la que
      // se habían elegido sellos. Se renderiza idéntico —comparado píxel a
      // píxel— y las dos firmas siguen verificando.
      //
      // `/Ff 65537` = sólo lectura (1) + pushbutton (65536).
      const t = nombreWidget = m.etiqueta || `Marca${camposExtra.length + 1}_${nombreCampo}`;
      cuerpoAnot =
        `<<\n${comun}\n/Subtype /Widget\n/F 4\n/FT /Btn\n/Ff 65537\n` +
        `/T ${cadenaPdf(t)}\n/MK << /I ${apRef} >>\n>>`;
    } else if (n === iPrincipal) {
      // Campo y widget fusionados: la forma que produce Acrobat y la única
      // que todos los lectores validan. /F 4 = imprimible.
      cuerpoAnot =
        `<<\n${comun}\n/Subtype /Widget\n/F 4\n/FT /Sig\n/V ${sigRef}\n` +
        `/T ${cadenaPdf(nombreCampo)}\n>>`;
    } else {
      // Sello: se dibuja igual, no es un campo y ningún lector lo cuenta como
      // firma. /F 68 = imprimible (4) + sólo lectura (64): no se puede mover.
      cuerpoAnot =
        `<<\n${comun}\n/Subtype /Stamp\n/F 68\n` +
        `/Contents ${cadenaPdf(`Marca de firma de ${nombre}`)}\n>>`;
    }

    // ⚠ Si el widget YA EXISTE pre-declarado, se REESCRIBE ESE MISMO OBJETO en
    // vez de agregar uno nuevo. Ver `widgetsPredeclarados`: es lo que hace que
    // Acrobat lea esto como «se completó un formulario» y no como «el documento
    // fue modificado o dañado».
    //
    // Y por eso mismo NO se toca ni `/Fields` ni el `/Annots` de la página: el
    // widget ya está en los dos. Agregarlo de nuevo lo duplicaría, que es el
    // defecto nº 2 del 4/8 —dos campos con el mismo nombre y el lector
    // mostrando el vacío— por una puerta nueva.
    //
    // Si no existe, se cae al camino de siempre y el documento sale igual que
    // antes. Los dos caminos conviven a propósito: un circuito despachado antes
    // de que esto existiera no tiene nada pre-declarado.
    const refPrevia = nombreWidget ? predeclarados.get(nombreWidget) : undefined;

    let ref: string;
    if (refPrevia) {
      // La marca se conserva al reescribir: el widget sigue siendo nuestro, y
      // sin ella una segunda pasada no lo reconocería.
      const conMarca = cuerpoAnot.replace(/>>\s*$/, '/MiFirma true\n>>');
      ref = escribir(getIndexFromRef(info.xref, refPrevia), Buffer.from(conMarca, 'latin1'));
    } else {
      ref = agregar(Buffer.from(cuerpoAnot, 'latin1'));
      if (esTexto) {
        if ((m.modo ?? 'campo') === 'campo') camposExtra.push(ref);
      } else if (n !== iPrincipal && m.modo !== 'sello') camposExtra.push(ref);
      else if (n === iPrincipal) refCampo = ref;
      anotaciones.push({ pagina: m.pagina, ref });
    }
    if (n === iPrincipal && !refCampo) refCampo = ref;
  }

  // ⚠ Si TODAS las marcas son de texto no hay widget de firma. El campo tiene
  // que existir igual: se agrega el invisible, como cuando no hay marcas.
  if (!refCampo) {
    refCampo = agregar(Buffer.from(
      '<<\n/Type /Annot\n/Subtype /Widget\n/Rect [0 0 0 0]\n/F 4\n' +
      `/P ${paginas[0]}\n/FT /Sig\n/V ${sigRef}\n/T ${cadenaPdf(nombreCampo)}\n>>`));
    anotaciones.push({ pagina: 0, ref: refCampo });
  }

  // 3) AcroForm. Si ya hay uno, se reescribe ESE MISMO OBJETO con sus campos
  //    más el nuevo, y la raíz no se toca porque ya le apunta.
  const todosLosCampos = [...camposViejos, refCampo, ...camposExtra];
  const cuerpoAcro = Buffer.from(acroExtendido(
    acroRefViejo ? cuerpoObjeto(pdf, info, acroRefViejo) : null, todosLosCampos), 'latin1');

  if (acroRefViejo) {
    escribir(getIndexFromRef(info.xref, acroRefViejo), cuerpoAcro);
  } else {
    const acro = agregar(cuerpoAcro);
    escribir(getIndexFromRef(info.xref, info.rootRef),
             Buffer.from(raizConAcroform(pdf, info, acro), 'latin1'));
  }

  // 4) Las páginas tocadas. Puede tocar la página o el arreglo de anotaciones,
  //    según cómo lo tenga el documento: lo decide `objetosConAnotacion`.
  for (const pref of new Set(anotaciones.map((a) => paginas[a.pagina]))) {
    const deEsta = anotaciones.filter((a) => paginas[a.pagina] === pref).map((a) => a.ref);
    for (const o of objetosConAnotacion(pdf, info, pref!, deEsta)) {
      escribir(o.idx, Buffer.from(o.cuerpo, 'latin1'));
    }
  }

  info.xref.maxIndex = indice;
  return Buffer.concat([salida, Buffer.from('\n'), trailer(salida, info, refs)]);
}
