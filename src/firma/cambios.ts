/**
 * Qué cambió entre una firma y la siguiente.
 *
 * ═══ POR QUÉ ESTO Y NO DocMDP ═══
 *
 * La pregunta que importa —«¿alguien alteró lo que se ve después de que yo
 * firmé?»— tiene dos respuestas posibles en un PDF:
 *
 *   · **DocMDP**: la primera firma DECLARA qué cambios permite después, y el
 *     lector marca los que se salgan. Es una declaración a futuro.
 *   · **Este archivo**: se mira lo que efectivamente se escribió en cada
 *     incremento y se DICE QUÉ PASÓ. Es una constatación sobre hechos.
 *
 * Se eligió lo segundo (2/8/2026), y no por comodidad:
 *
 * 1. **DocMDP es para un documento certificado por su autor.** En un contrato
 *    entre tres partes no hay un autor que certifique: hay tres que aprueban.
 *    El nivel 2 —el que estaba decidido el 30/7— prohíbe agregar anotaciones,
 *    y las rúbricas de cada firmante SON anotaciones. Con nivel 2, Acrobat le
 *    diría a un juez «el documento fue alterado de forma no permitida».
 * 2. **El nivel 3 lo permitiría, pero afirma menos**: declara que las
 *    anotaciones están permitidas, o sea que una anotación agregada después
 *    que tape un párrafo no la marca nadie.
 * 3. **DocMDP depende de que cada proveedor de firma avanzada lo exponga
 *    bien**, y no todos lo hacen. Esto no depende de nadie.
 *
 * Lo que se gana es lo que un abogado necesita escuchar: no «se permitían
 * ciertos cambios» sino **«entre la firma de Ana y la de Beto se agregaron dos
 * rúbricas y ninguna página cambió de contenido»**.
 *
 * ⚠ LO QUE ESTO NO ES. No es un parser de PDF completo y no pretende serlo.
 * Recorre los bytes de cada incremento buscando objetos, y cuando no entiende
 * algo lo dice —`analizado: false`— en vez de callarse. Un analizador que ante
 * la duda informa «sin cambios» es peor que no tener ninguno.
 */

export type ClaseObjeto =
  | 'firma'        // el diccionario /Sig
  | 'campo'        // el campo de firma o su widget
  | 'apariencia'   // XObject de imagen o de formulario: el dibujo de la firma
  | 'anotacion'    // una anotación que no es el widget de la firma
  | 'pagina'       // un objeto de página reescrito
  | 'formulario'   // el AcroForm
  | 'catalogo'     // la raíz
  | 'flujo'        // un stream que no se pudo clasificar mejor
  | 'otro';

export interface ObjetoEscrito {
  numero: number;
  clase: ClaseObjeto;
  /** El objeto ya existía antes de este incremento: es un reemplazo. */
  reemplaza: boolean;
  /** Sólo para anotaciones: su rectángulo [x1,y1,x2,y2], si se pudo leer.
   *  Lo consume `tapado.ts` para decidir si tapa texto firmado (deuda 43). */
  rect?: [number, number, number, number];
  /** Sólo para páginas: qué referencias cambiaron respecto de la versión previa. */
  cambio?: string[];
}

export interface CambioEntreFirmas {
  /** Este incremento se escribió DESPUÉS de esta firma (1-based). */
  despuesDeFirma: number;
  desde: number;
  hasta: number;
  objetos: ObjetoEscrito[];
  /** Cuántos de cada clase, para mostrarlo sin recorrer la lista. */
  resumen: Record<string, number>;
  /**
   * ⚠ LA ÚNICA BANDERA QUE IMPORTA. Alguna página cambió lo que muestra:
   * su `/Contents` o sus `/Resources` apuntan a otra cosa que antes.
   */
  contenidoAlterado: boolean;
  /** Se agregaron anotaciones que no son el widget de la firma nueva. */
  anotacionesAgregadas: number;
  /** False si el incremento no se pudo recorrer entero. Nunca se informa
   *  «no cambió nada» sobre algo que no se leyó. */
  analizado: boolean;
}

/** Un objeto tal como aparece escrito en el archivo. */
interface Escritura {
  numero: number;
  offset: number;
  /** El diccionario, sin el stream. */
  dic: string;
}

/**
 * Todos los `N G obj` del archivo, en orden de aparición.
 *
 * ⚠ Se saltean los streams a propósito. Un stream comprimido es ruido binario
 * y contiene por azar secuencias como `12 0 obj`; contarlas como objetos
 * inventaría cambios que nadie hizo. Se usa `/Length` cuando se puede confiar
 * en él y `endstream` cuando no.
 */
function escrituras(pdf: Buffer): { lista: Escritura[]; completo: boolean } {
  const s = pdf.toString('latin1');
  const lista: Escritura[] = [];
  let completo = true;
  const re = /(^|[\r\n])(\d+)[ \t]+(\d+)[ \t]+obj\b/g;

  let m: RegExpExecArray | null;
  let saltarHasta = 0;
  while ((m = re.exec(s)) !== null) {
    const inicio = m.index + m[1]!.length;
    if (inicio < saltarHasta) continue;          // estaba adentro de un stream

    const cuerpoDesde = m.index + m[0].length;
    const finObj = s.indexOf('endobj', cuerpoDesde);
    const inicioStream = s.indexOf('stream', cuerpoDesde);

    let dic: string;
    if (inicioStream >= 0 && (finObj < 0 || inicioStream < finObj)) {
      dic = s.slice(cuerpoDesde, inicioStream);
      // Saltar el stream. Con /Length numérico es exacto; si es indirecto —o no
      // está— se busca `endstream`, que es lo que hace cualquier lector cuando
      // el /Length miente.
      const largo = /\/Length[ \t]+(\d+)[^0-9R]/.exec(dic);
      let tras = inicioStream + 'stream'.length;
      while (s[tras] === '\r' || s[tras] === '\n') tras++;
      const fin = largo
        ? tras + Number(largo[1])
        : s.indexOf('endstream', tras);
      if (fin < 0 || fin > s.length) { completo = false; break; }
      saltarHasta = fin;
      re.lastIndex = fin;
    } else {
      if (finObj < 0) { completo = false; break; }
      dic = s.slice(cuerpoDesde, finObj);
    }

    lista.push({ numero: Number(m[2]), offset: inicio, dic });
  }
  return { lista, completo };
}

/** Las referencias `N G R` que cuelgan de una clave del diccionario. */
function refsDe(dic: string, clave: string): string[] {
  const i = dic.indexOf(clave);
  if (i < 0) return [];
  const resto = dic.slice(i + clave.length, i + clave.length + 400);
  const arr = /^\s*\[([^\]]*)\]/.exec(resto);
  const zona = arr ? arr[1]! : resto.slice(0, 24);
  return zona.match(/\d+\s+\d+\s+R/g) || [];
}

/** El /Rect de una anotación, normalizado (x1<x2, y1<y2). */
function rectDe(dic: string): [number, number, number, number] | null {
  const m = /\/Rect\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/.exec(dic);
  if (!m) return null;
  const [a, b, c, d] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if ([a, b, c, d].some((n) => !Number.isFinite(n))) return null;
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}

function clasificar(dic: string): ClaseObjeto {
  if (/\/Type\s*\/Sig\b/.test(dic)) return 'firma';
  if (/\/Type\s*\/Catalog\b/.test(dic)) return 'catalogo';
  if (/\/Type\s*\/AcroForm\b/.test(dic) || /\/Fields\s*\[/.test(dic)) return 'formulario';
  if (/\/Type\s*\/Page\b(?!s)/.test(dic)) return 'pagina';
  if (/\/Subtype\s*\/Widget\b/.test(dic)) return 'campo';
  if (/\/Type\s*\/Annot\b/.test(dic)) return 'anotacion';
  if (/\/Subtype\s*\/(Form|Image)\b/.test(dic)) return 'apariencia';
  if (/\/Length\b/.test(dic)) return 'flujo';
  return 'otro';
}

/**
 * Qué se escribió en cada incremento, entre firma y firma.
 *
 * `cortes` son los bytes hasta donde llega cada firma, en orden. Vienen del
 * `/ByteRange`, o sea del propio archivo: no hay que creerle nada a nadie.
 */
export function cambiosEntreFirmas(pdf: Buffer, cortes: number[]): CambioEntreFirmas[] {
  if (cortes.length < 2) return [];

  const { lista, completo } = escrituras(pdf);

  // Para saber si un objeto REEMPLAZA a otro hay que saber qué existía antes.
  // Se recorre en orden y se lleva la última versión vista de cada número.
  const previo = new Map<number, string>();
  const salida: CambioEntreFirmas[] = [];

  let i = 0;
  // Todo lo anterior al primer corte es el documento original más la primera
  // firma: no es un cambio de nadie.
  while (i < lista.length && lista[i]!.offset < cortes[0]!) {
    previo.set(lista[i]!.numero, lista[i]!.dic);
    i++;
  }

  for (let k = 1; k < cortes.length; k++) {
    const desde = cortes[k - 1]!;
    const hasta = cortes[k]!;
    const objetos: ObjetoEscrito[] = [];
    let contenidoAlterado = false;
    let anotaciones = 0;

    while (i < lista.length && lista[i]!.offset < hasta) {
      const e = lista[i]!;
      const antes = previo.get(e.numero);
      const clase = clasificar(e.dic);
      const o: ObjetoEscrito = { numero: e.numero, clase, reemplaza: antes !== undefined };

      if (clase === 'pagina' && antes !== undefined) {
        // ⚠ ACÁ ESTÁ LA PREGUNTA. Una página reescrita es normal —se le agrega
        // la anotación de la firma—, pero si además apunta a otro `/Contents` o
        // a otros `/Resources`, lo que la hoja MUESTRA cambió. Eso es lo único
        // que hay que gritar.
        const cambio: string[] = [];
        for (const clave of ['/Contents', '/Resources', '/MediaBox', '/CropBox', '/Rotate']) {
          const a = refsDe(antes, clave).join(' ');
          const b = refsDe(e.dic, clave).join(' ');
          // Sin refs, se compara el valor literal (MediaBox, Rotate).
          const va = a || (new RegExp(clave + '\\s*([^/>]*)').exec(antes)?.[1] ?? '').trim();
          const vb = b || (new RegExp(clave + '\\s*([^/>]*)').exec(e.dic)?.[1] ?? '').trim();
          if (va !== vb) cambio.push(clave);
        }
        if (cambio.length) { o.cambio = cambio; contenidoAlterado = true; }
      }

      // Un flujo o una apariencia que REEMPLAZA a otro anterior sí cambia lo
      // que se ve: es el contenido de una página o el dibujo de una firma ya
      // hecha, reescrito.
      if (o.reemplaza && (clase === 'flujo' || clase === 'apariencia')) contenidoAlterado = true;

      if (clase === 'anotacion') {
        anotaciones++;
        // El rectángulo viaja para que `tapado.ts` pueda compararlo contra las
        // palabras de la hoja. Si no se deja leer, el veredicto de allá lo va a
        // decir («sin rectángulo legible») — nunca un verde por silencio.
        const r = rectDe(e.dic);
        if (r) o.rect = r;
      }

      objetos.push(o);
      previo.set(e.numero, e.dic);
      i++;
    }

    const resumen: Record<string, number> = {};
    for (const o of objetos) resumen[o.clase] = (resumen[o.clase] ?? 0) + 1;

    salida.push({
      despuesDeFirma: k,
      desde,
      hasta,
      objetos,
      resumen,
      contenidoAlterado,
      anotacionesAgregadas: anotaciones,
      analizado: completo,
    });
  }

  return salida;
}

/** Una línea en castellano, que es lo que va a leer una persona. */
export function contarCambio(c: CambioEntreFirmas): string {
  if (!c.analizado) {
    return 'No se pudo analizar este tramo del archivo. No quiere decir que esté mal: ' +
           'quiere decir que no lo podemos afirmar.';
  }
  if (c.contenidoAlterado) {
    const pgs = c.objetos.filter((o) => o.cambio?.length);
    return '⚠ Cambió lo que muestran ' + (pgs.length || 1) + ' página(s) del documento' +
           (pgs.length ? ' (' + [...new Set(pgs.flatMap((p) => p.cambio!))].join(', ') + ')' : '') + '.';
  }
  const partes: string[] = [];
  if (c.resumen.firma) partes.push('la firma');
  if (c.anotacionesAgregadas) partes.push(c.anotacionesAgregadas + ' marca(s) autógrafa(s)');
  if (c.resumen.campo) partes.push('su campo de firma');
  if (!partes.length) return 'No se agregó nada visible.';
  return 'Se agregó ' + partes.join(', ') + '. Ninguna página cambió de contenido.';
}
