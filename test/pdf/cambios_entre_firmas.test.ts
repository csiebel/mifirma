/**
 * El analizador de cambios, y la prueba adversaria que lo justifica.
 *
 * ═══ POR QUÉ EXISTE ESTO ═══
 *
 * Un documento se puede adulterar entre dos firmas SIN romper ninguna. Se firma,
 * se reescribe el contenido de una página en un incremento posterior, y se
 * vuelve a firmar. El resultado es el peor caso posible:
 *
 *   · las dos firmas verifican —sus bytes no se tocaron—,
 *   · no sobra ni un byte sin firmar,
 *   · o sea que `integro` da **true**,
 *   · y sin embargo la hoja que firmó el primero muestra otra cosa.
 *
 * Es el hueco que DocMDP intenta tapar declarando y que acá se responde
 * mirando. Si el analizador no lo detecta, no sirve para nada — y por eso esta
 * prueba fabrica el ataque de verdad, con los bytes que escribiría alguien con
 * un editor de PDF y malas intenciones.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { contarCambio } from '../../src/firma/cambios';
import { normalizar, sellar, verificar } from '../../src/firma/pades';
import type { Marca } from '../../src/firma/apariencia';
import { base, firma, firmanteLab, prepararFixtures, rubrica } from './fixtures';
import { guardar } from './inspeccion';

const req = createRequire(import.meta.url);
const readPdf = req('@signpdf/placeholder-plain/dist/readPdf').default;
const findObject = req('@signpdf/placeholder-plain/dist/findObject').default;
const getIndexFromRef = req('@signpdf/placeholder-plain/dist/getIndexFromRef').default;
const getPagesDictionaryRef = req('@signpdf/placeholder-plain/dist/getPagesDictionaryRef').default;
const trailer = req('@signpdf/placeholder-plain/dist/createBufferTrailer').default;

let MARCAS: Marca[];
let BASE: Buffer;

before(async () => {
  await prepararFixtures();
  BASE = await normalizar(base());
  MARCAS = [
    { pagina: 0, rect: [430, 60, 485, 100], imagen: rubrica() },
    { pagina: 2, rect: [70, 150, 240, 205], imagen: firma(), principal: true },
  ];
});

/**
 * Le tacha media hoja al documento, como incremental update.
 *
 * No es una simulación: reescribe el objeto de la página apuntando a un
 * contenido nuevo y deja el viejo donde estaba, que es exactamente lo que hace
 * cualquier editor de PDF.
 */
function tacharPrimeraPagina(pdf: Buffer): Buffer {
  const info = readPdf(pdf);
  const dicPages = findObject(pdf, info.xref, getPagesDictionaryRef(info)).toString('latin1');
  const i = dicPages.indexOf('/Kids');
  const kids = dicPages
    .slice(dicPages.indexOf('[', i) + 1, dicPages.indexOf(']', i))
    .match(/\d+\s+\d+\s+R/g)!;
  const pref = kids[0]!;
  const idxPag = getIndexFromRef(info.xref, pref);
  const dicPag = findObject(pdf, info.xref, pref).toString('latin1');

  let salida = Buffer.from(pdf);
  const refs = new Map<number, number>();
  let indice: number = info.xref.maxIndex;
  const escribir = (idx: number, cuerpo: string) => {
    refs.set(idx, salida.length + 1);
    salida = Buffer.concat([salida, Buffer.from(`\n${idx} 0 obj\n${cuerpo}\nendobj\n`, 'latin1')]);
    return `${idx} 0 R`;
  };

  // Un rectángulo negro enorme. No hace falta ninguna fuente ni recurso.
  const flujo = '0 0 0 rg\n50 350 500 250 re f\n';
  const nuevo = escribir(++indice, `<<\n/Length ${flujo.length}\n>>\nstream\n${flujo}endstream`);

  // ⚠ pdf-lib escribe `/Contents [ 6 0 R ]` y otras herramientas `/Contents 6 0 R`.
  // Las dos formas son válidas y el atacante no elige cuál le toca.
  const pagNueva = dicPag.replace(/\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/, `/Contents ${nuevo}`);
  assert.notEqual(pagNueva, dicPag, 'no encontré el /Contents de la página');
  escribir(idxPag, `<<${pagNueva}>>`);

  info.xref.maxIndex = indice;
  return Buffer.concat([salida, Buffer.from('\n'), trailer(salida, info, refs)]);
}

test('dos firmas honestas: el analizador no acusa nada', async () => {
  let pdf = (await sellar(BASE, { razon: 'Firmado por Ana', nombre: 'Ana Pérez', marcas: MARCAS },
                          firmanteLab('a'))).pdf;
  pdf = (await sellar(pdf, { razon: 'Firmado por Beto', nombre: 'Beto Silva', marcas: MARCAS },
                      firmanteLab('b'))).pdf;
  guardar('cambios_sano.pdf', pdf);

  const v = verificar(pdf);
  assert.ok(v.integro);
  assert.equal(v.contenido_alterado_entre_firmas, false,
               JSON.stringify(v.cambios.flatMap((c) => c.objetos.filter((o) => o.cambio))));
  // Un tramo analizado, no cero: «no encontré cambios» y «no pude mirar» son
  // cosas distintas y no se pueden confundir.
  assert.equal(v.cambios.length, 1);
  assert.ok(v.cambios[0]!.analizado, 'el tramo tiene que quedar analizado, no sin analizar');
  assert.match(contarCambio(v.cambios[0]!), /Ninguna página cambió/);
});

test('⚠ alguien tacha media hoja entre las dos firmas', async () => {
  let pdf = (await sellar(BASE, { razon: 'Firmado por Ana', nombre: 'Ana Pérez', marcas: MARCAS },
                          firmanteLab('a'))).pdf;

  pdf = tacharPrimeraPagina(pdf);                                    // ← el ataque

  pdf = (await sellar(pdf, { razon: 'Firmado por Beto', nombre: 'Beto Silva', marcas: MARCAS },
                      firmanteLab('b'))).pdf;
  guardar('cambios_alterado.pdf', pdf);

  const v = verificar(pdf);
  // Lo que hace que el caso sea grave: por las comprobaciones de siempre, pasa.
  assert.equal(v.firmas.length, 2);
  assert.ok(v.firmas.every((f) => f.verifica), 'las dos firmas verifican igual');
  assert.ok(v.integro, '«íntegro» sigue dando true: por eso hacía falta el analizador');

  // Y esto es lo único que lo delata.
  assert.equal(v.contenido_alterado_entre_firmas, true);
  const c = v.cambios[0];
  assert.equal(c?.despuesDeFirma, 1, 'tiene que decir en qué tramo');
  assert.ok(c?.objetos.some((o) => o.cambio?.includes('/Contents')), 'tiene que decir qué cambió');
  assert.match(contarCambio(c!), /Cambió lo que muestran/);
});
