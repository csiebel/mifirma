import zlib from 'node:zlib';
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
 * Y un campo de firma puede tener VARIOS widgets, uno por página. Por eso la
 * rúbrica en todas las hojas no estampa nada: es el mismo campo mostrándose en
 * varios lugares.
 *
 * ═══ QUÉ SE VERIFICÓ ANTES DE ESCRIBIR ESTO ═══
 *
 * Un contrato de tres páginas, con rúbrica al pie de las tres y firma completa
 * sólo en la última: cuatro widgets, un campo, y la firma criptográfica
 * verifica. Se renderizó el PDF para mirarlo, no sólo para contar objetos.
 *
 * ⚠ DEPENDENCIA FRÁGIL, ANOTADA A PROPÓSITO. Se reusan cuatro helpers internos
 * de `@signpdf/placeholder-plain` (`dist/…`) para leer la tabla de referencias
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
const paginaConAnotacion = req('@signpdf/placeholder-plain/dist/createBufferPageWithAnnotation').default;
const raizConAcroform = req('@signpdf/placeholder-plain/dist/createBufferRootWithAcroform').default;
const trailer = req('@signpdf/placeholder-plain/dist/createBufferTrailer').default;

export interface Marca {
  /** Índice de página, base 0. */
  pagina: number;
  /** [x1, y1, x2, y2] en puntos, origen abajo-izquierda como manda el PDF. */
  rect: [number, number, number, number];
  /** PNG con fondo transparente. */
  imagen: Buffer;
}


/**
 * Decodifica un PNG de 8 bits, color type 2 (RGB) o 6 (RGBA), sin entrelazado.
 * Es el que produce `canvas.toBlob()`, que es de donde vienen nuestras firmas.
 */
export function decodificarPng(buf: Buffer) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('no es PNG');
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

  const canales = ihdr.color === 6 ? 4 : 3;
  const crudo = zlib.inflateSync(Buffer.concat(idat));
  const anchoFila = ihdr.ancho * canales;
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
  for (let y = 0; y < img.alto; y++) {
    for (let x = 0; x < img.ancho; x++) {
      const p = (y * img.ancho + x) * img.canales;
      const alfa = img.canales === 4 ? img.px[p + 3] : 255;
      const lum = 0.299 * img.px[p] + 0.587 * img.px[p + 1] + 0.114 * img.px[p + 2];
      const hayTinta = alfa >= umbralAlfa && lum < 190;
      if (hayTinta) bits[y * bytesPorFila + (x >> 3)] &= ~(0x80 >> (x & 7));
    }
  }
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

/** Todas las páginas, en orden. La librería sólo sabe devolver la primera. */
function refsDePaginas(pdf: Buffer, info: any): string[] {
  const dic = findObject(pdf, info.xref, getPagesDictionaryRef(info)).toString();
  const i = dic.indexOf('/Kids');
  const kids = dic.slice(dic.indexOf('[', i) + 1, dic.indexOf(']', i));
  return (kids.match(/\d+\s+\d+\s+R/g) || []);
}

/**
 * Agrega un hueco de firma CON APARIENCIA VISIBLE, en las páginas y posiciones
 * indicadas.
 *
 * `marcas`: [{ pagina, rect: [x1,y1,x2,y2], imagen: Buffer(PNG) }]
 *
 * Un campo de firma puede tener VARIOS widgets —uno por página—, así que la
 * rúbrica en todas las hojas no necesita estampar contenido: es el mismo campo
 * mostrándose en varios lugares. Nada del contenido de la página se toca.
 */
export function huecoVisible({
  pdf,
  marcas,
  razon,
  nombre,
  lugar,
  contacto,
  largoFirma = 32768,
}: {
  pdf: Buffer;
  marcas: Marca[];
  razon: string;
  nombre: string;
  lugar?: string;
  contacto?: string;
  largoFirma?: number;
}): Buffer {
  const info = readPdf(pdf);
  const paginas = refsDePaginas(pdf, info);
  let salida = Buffer.from(pdf);
  const refs = new Map();

  let indice = info.xref.maxIndex;
  const agregar = (cuerpo: Buffer) => {
    indice += 1;
    refs.set(indice, salida.length + 1);
    salida = Buffer.concat([
      salida, Buffer.from('\n'), Buffer.from(`${indice} 0 obj\n`), cuerpo, Buffer.from('\nendobj\n'),
    ]);
    return `${indice} 0 R`;
  };
  const flujo = (dic: string, datos: Buffer) =>
    Buffer.concat([Buffer.from(`<<\n${dic}\n/Length ${datos.length}\n>>\nstream\n`), datos,
                   Buffer.from('\nendstream')]);

  // 1) El hueco de la firma. Es UNO solo aunque se muestre en varias hojas.
  const relleno = '0'.repeat(largoFirma * 2);
  const sigRef = agregar(Buffer.from(
    '<<\n/Type /Sig\n/Filter /Adobe.PPKLite\n/SubFilter /ETSI.CAdES.detached\n' +
    `/ByteRange [0 /********** /********** /**********]\n/Contents <${relleno}>\n` +
    `/Reason ${cadenaPdf(razon)}\n/M (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z)\n` +
    `/Name ${cadenaPdf(nombre)}\n/Location ${cadenaPdf(lugar || '')}\n/ContactInfo ${cadenaPdf(contacto || '')}\n>>`));

  // 2) Un widget por marca, cada uno con su apariencia.
  const widgets: { pagina: number; ref: string }[] = [];
  for (const [n, m] of marcas.entries()) {
    const img = decodificarPng(m.imagen);
    const mask = aMascara(img);
    const imgRef = agregar(flujo(
      `/Type /XObject\n/Subtype /Image\n/Width ${mask.ancho}\n/Height ${mask.alto}\n` +
      '/ImageMask true\n/BitsPerComponent 1\n/Filter /FlateDecode', mask.bits));

    const w = m.rect[2] - m.rect[0], h = m.rect[3] - m.rect[1];
    // El BBox arranca en 0,0: la apariencia vive en su propio sistema de
    // coordenadas y el Rect del widget la ubica en la página.
    const apRef = agregar(flujo(
      `/Type /XObject\n/Subtype /Form\n/FormType 1\n/BBox [0 0 ${w} ${h}]\n` +
      `/Resources << /XObject << /Im0 ${imgRef} >> >>`,
      Buffer.from(`q\n0.07 0.09 0.16 rg\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ`)));

    widgets.push({
      pagina: m.pagina,
      ref: agregar(Buffer.from(
        `<<\n/Type /Annot\n/Subtype /Widget\n/FT /Sig\n/Rect [${m.rect.join(' ')}]\n` +
        `/V ${sigRef}\n/T (MiFirma${Date.now()}_${n})\n/F 4\n/P ${paginas[m.pagina]}\n` +
        `/AP << /N ${apRef} >>\n>>`)),
    });
  }

  // 3) AcroForm con todos los widgets del campo.
  const acro = agregar(Buffer.from(
    `<<\n/Fields [${widgets.map((w) => w.ref).join(' ')}]\n/SigFlags 3\n/DA (/Helv 0 Tf 0 g)\n>>`));

  // 4) Las páginas tocadas y la raíz.
  for (const pref of new Set(widgets.map((w) => paginas[w.pagina]))) {
    const deEsta = widgets.filter((w) => paginas[w.pagina] === pref).map((w) => w.ref).join(' ');
    refs.set(getIndexFromRef(info.xref, pref), salida.length + 1);
    salida = Buffer.concat([salida, Buffer.from('\n'),
      paginaConAnotacion(salida, info, pref, { toString: () => deEsta })]);
  }
  refs.set(getIndexFromRef(info.xref, info.rootRef), salida.length + 1);
  salida = Buffer.concat([salida, Buffer.from('\n'), raizConAcroform(salida, info, acro)]);

  info.xref.maxIndex = indice;
  return Buffer.concat([salida, Buffer.from('\n'), trailer(salida, info, refs)]);
}
