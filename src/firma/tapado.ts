/**
 * ¿Alguna anotación agregada DESPUÉS de una firma tapa texto firmado?
 *
 * ═══ QUÉ PREGUNTA CONTESTA, Y CUÁL NO ═══
 *
 * El analizador de cambios (`cambios.ts`) ya dice QUÉ se escribió entre firma y
 * firma, y grita si una página cambió de contenido. Lo que no decía —anotado
 * como «todavía no» el 2/8 en `claude/que-cambio-entre-firmas.md`— es si una
 * anotación agregada junto con una firma posterior TAPA lo que el primer
 * firmante vio: un rectángulo blanco sobre una cláusula se informaba («se
 * agregó 1 anotación») pero no se marcaba. Esto contesta eso, comparando el
 * rectángulo de cada anotación agregada contra las PALABRAS de su hoja.
 *
 * ═══ LOS TRES VEREDICTOS, Y POR QUÉ NINGUNO SE CALLA ═══
 *
 *   · `tapa_texto`     — la anotación cubre palabras firmadas. Rojo.
 *   · `libre`          — hay palabras en la hoja y no cubre ninguna.
 *   · `no_comprobable` — no se pudo afirmar ni una cosa ni la otra, y el
 *     motivo viaja: la hoja no tiene texto extraíble (una hoja ESCANEADA da
 *     cero palabras — el punto ciego medido el 9/8 en la tercera comprobación,
 *     acá dicho en voz alta en vez de dar verde), o no se pudo ubicar la hoja,
 *     o `pdftotext` no está en este servidor.
 *
 * Es la regla del 2/8: un analizador que ante la duda informa «sin cambios» es
 * peor que ninguno. Ante la duda, acá se dice «no comprobable».
 *
 * ═══ QUÉ NECESITA ═══
 *
 * `pdftotext -bbox` (poppler). En Railway lo trae `nixpacks.toml`; donde no
 * esté, el veredicto entero es «no comprobado» con el motivo — el producto
 * sigue andando igual. pdf-lib ubica cada anotación en su hoja (por el /Annots
 * de cada página, con el número de objeto que reportó `cambios.ts`).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, PDFName, PDFArray, PDFRef } from 'pdf-lib';
import type { CambioEntreFirmas } from './cambios';

const correr = promisify(execFile);

export interface AnotacionSobreTexto {
  /** El incremento donde se escribió: después de esta firma (1-based). */
  despuesDeFirma: number;
  numeroObjeto: number;
  /** Hoja, base 0. Null si no se pudo ubicar. */
  pagina: number | null;
  rect: [number, number, number, number] | null;
  veredicto: 'tapa_texto' | 'libre' | 'no_comprobable';
  /** Palabras firmadas que quedan debajo (sólo con veredicto `tapa_texto`). */
  palabrasDebajo: number;
  motivo?: string;
}

export interface VeredictoTapado {
  /** False = ni se intentó (sin pdftotext, o el texto no se pudo extraer). */
  comprobado: boolean;
  motivo?: string;
  anotaciones: AnotacionSobreTexto[];
  algunaTapa: boolean;
}

/** Una palabra cubierta a medias no está tapada: se exige cubrir la mitad del
 *  área. Evita que el borde de una anotación que ROZA un renglón dispare la
 *  alarma — una alarma falsa acá y la próxima nadie la mira. */
const CUBRE_MINIMO = 0.5;

interface Caja { x1: number; y1: number; x2: number; y2: number; }

/** Las palabras de cada hoja según `pdftotext -bbox`, en coordenadas PDF.
 *  ⚠ pdftotext mide desde ARRIBA de la hoja; el PDF desde abajo. Se da vuelta
 *  acá y en ningún otro lado. */
async function palabrasPorHoja(pdf: Buffer): Promise<Caja[][]> {
  const dir = await mkdtemp(join(tmpdir(), 'mifirma-tapado-'));
  try {
    const p = join(dir, 'doc.pdf');
    await writeFile(p, pdf);
    const { stdout } = await correr('pdftotext', ['-bbox', p, '-'],
                                    { maxBuffer: 64 * 1024 * 1024 });
    const hojas: Caja[][] = [];
    const rePagina = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
    let mp: RegExpExecArray | null;
    while ((mp = rePagina.exec(stdout)) !== null) {
      const alto = Number(mp[2]);
      const palabras: Caja[] = [];
      const reW = /<word xMin="([-\d.]+)" yMin="([-\d.]+)" xMax="([-\d.]+)" yMax="([-\d.]+)">/g;
      let mw: RegExpExecArray | null;
      while ((mw = reW.exec(mp[3]!)) !== null) {
        palabras.push({
          x1: Number(mw[1]), y1: alto - Number(mw[4]),
          x2: Number(mw[3]), y2: alto - Number(mw[2]),
        });
      }
      hojas.push(palabras);
    }
    return hojas;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => { /* basura temporal */ });
  }
}

/** Qué hoja lista a cada anotación en su /Annots: número de objeto → hoja. */
async function hojaDeCadaAnotacion(pdf: Buffer): Promise<Map<number, number>> {
  const mapa = new Map<number, number>();
  const doc = await PDFDocument.load(pdf, { ignoreEncryption: true });
  doc.getPages().forEach((page, indice) => {
    const crudo = page.node.get(PDFName.of('Annots'));
    const annots = crudo instanceof PDFRef ? doc.context.lookup(crudo) : crudo;
    if (!(annots instanceof PDFArray)) return;
    for (let i = 0; i < annots.size(); i++) {
      const el = annots.get(i);
      if (el instanceof PDFRef) mapa.set(el.objectNumber, indice);
    }
  });
  return mapa;
}

function areaInterseccion(a: Caja, r: [number, number, number, number]): number {
  const w = Math.min(a.x2, r[2]) - Math.max(a.x1, r[0]);
  const h = Math.min(a.y2, r[3]) - Math.max(a.y1, r[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

export async function anotacionesSobreTexto(
  pdf: Buffer,
  cambios: CambioEntreFirmas[],
): Promise<VeredictoTapado> {
  const candidatas = cambios.flatMap((c) =>
    c.objetos
      .filter((o) => o.clase === 'anotacion')
      .map((o) => ({ despuesDeFirma: c.despuesDeFirma, numeroObjeto: o.numero, rect: o.rect ?? null })));

  // El caso común: nadie agregó anotaciones después de una firma. Nuestro
  // propio pipeline no lo hace nunca — las marcas son campos pre-declarados.
  if (!candidatas.length) return { comprobado: true, anotaciones: [], algunaTapa: false };

  try {
    await correr('pdftotext', ['-v']);
  } catch {
    return {
      comprobado: false,
      motivo: 'pdftotext no está instalado en este servidor',
      anotaciones: [], algunaTapa: false,
    };
  }

  let hojas: Caja[][];
  try {
    hojas = await palabrasPorHoja(pdf);
  } catch {
    return { comprobado: false, motivo: 'no se pudo extraer el texto del documento', anotaciones: [], algunaTapa: false };
  }

  let mapa = new Map<number, number>();
  try { mapa = await hojaDeCadaAnotacion(pdf); } catch { /* cada anotación dirá que no se ubicó */ }

  const anotaciones: AnotacionSobreTexto[] = candidatas.map((c) => {
    const base = { despuesDeFirma: c.despuesDeFirma, numeroObjeto: c.numeroObjeto, rect: c.rect };
    if (!c.rect) {
      return { ...base, pagina: null, veredicto: 'no_comprobable' as const, palabrasDebajo: 0,
               motivo: 'la anotación no tiene un rectángulo legible' };
    }
    const pagina = mapa.get(c.numeroObjeto);
    if (pagina === undefined) {
      return { ...base, pagina: null, veredicto: 'no_comprobable' as const, palabrasDebajo: 0,
               motivo: 'no se pudo ubicar en qué hoja está' };
    }
    const palabras = hojas[pagina] ?? [];
    if (!palabras.length) {
      // ⚠ El punto ciego de los escaneados, dicho en voz alta: cero palabras no
      // significa «no tapa nada», significa que no hay contra qué comparar.
      return { ...base, pagina, veredicto: 'no_comprobable' as const, palabrasDebajo: 0,
               motivo: 'la hoja no tiene texto extraíble (¿escaneada?)' };
    }
    const rect = c.rect;
    const debajo = palabras.filter((w) => {
      const area = (w.x2 - w.x1) * (w.y2 - w.y1);
      return area > 0 && areaInterseccion(w, rect) >= CUBRE_MINIMO * area;
    }).length;
    return debajo > 0
      ? { ...base, pagina, veredicto: 'tapa_texto' as const, palabrasDebajo: debajo }
      : { ...base, pagina, veredicto: 'libre' as const, palabrasDebajo: 0 };
  });

  return {
    comprobado: true,
    anotaciones,
    algunaTapa: anotaciones.some((a) => a.veredicto === 'tapa_texto'),
  };
}
