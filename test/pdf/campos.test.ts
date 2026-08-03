/**
 * Campos completados sobre el PDF: el valor va como ANOTACIÓN, no estampado.
 *
 * ═══ QUÉ DECIDE ESTA PRUEBA ═══
 *
 * Con el analizador de cambios andando, **aplanar un campo se ve exactamente
 * igual que una adulteración**: las dos cosas cambian el `/Contents` de una
 * página en un incremento posterior a una firma. El certificado gritaría sobre
 * un documento legítimo, y una alarma que salta cuando todo está bien deja de
 * mirarse.
 *
 * Por eso el valor se dibuja como campo de formulario de sólo lectura, en el
 * mismo incremento que la firma de quien lo completó. El caso 2 existe para
 * demostrar que el problema era real: si el analizador NO acusara el estampado,
 * no habría nada que resolver.
 *
 * Ver `claude/campos-sobre-el-pdf.md`.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fueraDeWinAnsi, type Marca } from '../../src/firma/apariencia';
import { normalizar, sellar, verificar } from '../../src/firma/pades';
import {
  base, correr, firma, firmanteLab, prepararFixtures, rubrica, sinPoppler,
} from './fixtures';
import { extraer, guardar } from './inspeccion';

const req = createRequire(import.meta.url);
const readPdf = req('@signpdf/placeholder-plain/dist/readPdf').default;
const findObject = req('@signpdf/placeholder-plain/dist/findObject').default;
const getIndexFromRef = req('@signpdf/placeholder-plain/dist/getIndexFromRef').default;
const getPagesDictionaryRef = req('@signpdf/placeholder-plain/dist/getPagesDictionaryRef').default;
const trailer = req('@signpdf/placeholder-plain/dist/createBufferTrailer').default;

let FIRMA: Buffer;
let RUBRICA: Buffer;
let BASE: Buffer;

before(async () => {
  await prepararFixtures();
  FIRMA = firma();
  RUBRICA = rubrica();
  BASE = await normalizar(base());
});

/**
 * Estampa el valor EN EL CONTENIDO de la página, como incremental update.
 *
 * Es lo que hace un «aplanado» clásico y lo que haría cualquier librería de
 * formularios. Se escribe a mano y no con pdf-lib a propósito: pdf-lib reescribe
 * el documento entero, lo que rompería la firma anterior por mover bytes. Un
 * aplanador correcto —y un atacante— usan un incremento.
 */
function estamparEnContenido(pdf: Buffer, pagina: number, texto: string,
                             x: number, y: number, cuerpo = 10): Buffer {
  const info = readPdf(pdf);
  const dicPages = findObject(pdf, info.xref, getPagesDictionaryRef(info)).toString('latin1');
  const i = dicPages.indexOf('/Kids');
  const kids = dicPages
    .slice(dicPages.indexOf('[', i) + 1, dicPages.indexOf(']', i))
    .match(/\d+\s+\d+\s+R/g)!;
  const pref = kids[pagina]!;
  const idxPag = getIndexFromRef(info.xref, pref);
  const dicPag = findObject(pdf, info.xref, pref).toString('latin1');

  // Reusa una fuente que la página ya tenga: no hay que tocar /Resources.
  const fuente = dicPag.match(/\/(Helvetica[-\w]*)\s+\d+\s+\d+\s+R/)?.[1];
  assert.ok(fuente, 'la página no trae ninguna Helvetica que reusar');

  let salida = Buffer.from(pdf);
  const refs = new Map<number, number>();
  let indice: number = info.xref.maxIndex;
  const escribir = (idx: number, cuerpoObj: string) => {
    refs.set(idx, salida.length + 1);
    salida = Buffer.concat([salida, Buffer.from(`\n${idx} 0 obj\n${cuerpoObj}\nendobj\n`, 'latin1')]);
    return `${idx} 0 R`;
  };

  const flujo = `q\nBT\n/${fuente} ${cuerpo} Tf\n0 0 0 rg\n${x} ${y} Td\n(${texto}) Tj\nET\nQ\n`;
  const nuevo = escribir(++indice, `<<\n/Length ${flujo.length}\n>>\nstream\n${flujo}endstream`);

  // Se AGREGA al arreglo de contenidos, no se reemplaza: lo que ya estaba
  // impreso sigue estando. Es lo que hace un aplanado honesto.
  const m = dicPag.match(/\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/);
  assert.ok(m, 'no encontré el /Contents de la página');
  const viejos = m![1]!.startsWith('[') ? m![1]!.slice(1, -1).trim() : m![1]!;
  escribir(idxPag, `<<${dicPag.replace(m![0], `/Contents [${viejos} ${nuevo}]`)}>>`);

  info.xref.maxIndex = indice;
  return Buffer.concat([salida, Buffer.from('\n'), trailer(salida, info, refs)]);
}

const marcasCon = (quien: string, valor: string, modo: 'campo' | 'sello'): Marca[] => [
  { pagina: 0, rect: [430, 60, 485, 100], imagen: RUBRICA },
  { pagina: 2, rect: [70, 150, 240, 205], imagen: FIRMA, principal: true },
  { pagina: 0, rect: [180, 620, 380, 640], texto: valor, modo, etiqueta: `Telefono_${quien}` },
];

test('el valor como anotación: el analizador queda callado', async (t) => {
  let pdf = (await sellar(BASE, {
    razon: 'Firmado por Ana', nombre: 'Ana Pérez',
    marcas: marcasCon('ana', 'Tel. 099 123 456 — Montevideo, Ñ ç ã', 'campo'),
  }, firmanteLab('a'))).pdf;
  pdf = (await sellar(pdf, {
    razon: 'Firmado por Beto', nombre: 'Beto Silva',
    marcas: marcasCon('beto', 'Tel. 098 765 432', 'sello'),
  }, firmanteLab('b'))).pdf;
  const archivo = guardar('campos_anotacion.pdf', pdf);

  const v = verificar(pdf);
  assert.equal(v.firmas.length, 2);
  assert.ok(v.firmas.every((f) => f.verifica));
  assert.ok(v.integro);
  assert.equal(v.contenido_alterado_entre_firmas, false,
               JSON.stringify(v.cambios.flatMap((c) => c.objetos.filter((o) => o.cambio))));

  // El valor queda además como DATO, no sólo como píxeles: un tercero lo
  // extrae sin OCR, y por eso el certificado de finalización puede imprimirlo.
  assert.match(readFileSync(archivo, 'latin1'), /\/FT \/Tx/);

  if (sinPoppler()) return t.skip(String(sinPoppler()));
  const texto = extraer(archivo);
  assert.ok(texto.includes('099 123 456'), 'el valor tiene que poder buscarse y copiarse');
  // WinAnsi alto: la raya larga que pone el corrector del teléfono, y los
  // acentos. Sin la tabla 0x80–0x9F, «Montevideo — Uruguay» sale «Montevideo ?».
  assert.ok(texto.includes('— Montevideo, Ñ ç ã'), texto.slice(0, 200));

  const sig = correr('pdfsig', [archivo]);
  assert.ok(/MiFirma1/.test(sig) && /MiFirma2/.test(sig) && !/MiFirma3/.test(sig),
            `el número de firma cuenta campos que no son firmas — ${
              (sig.match(/Signature Field Name: \S+/g) || []).join(' / ')}`);
});

test('⚠ el valor estampado en la hoja SÍ dispara la alarma (era la hipótesis)', async () => {
  let pdf = (await sellar(BASE, {
    razon: 'Firmado por Ana', nombre: 'Ana Pérez',
    marcas: [{ pagina: 2, rect: [70, 150, 240, 205], imagen: FIRMA, principal: true }],
  }, firmanteLab('a'))).pdf;

  pdf = estamparEnContenido(pdf, 0, 'Tel. 098 765 432', 180, 625);   // ← Beto completa

  pdf = (await sellar(pdf, {
    razon: 'Firmado por Beto', nombre: 'Beto Silva',
    marcas: [{ pagina: 0, rect: [430, 60, 485, 100], imagen: RUBRICA }],
  }, firmanteLab('b'))).pdf;
  guardar('campos_estampado.pdf', pdf);

  const v = verificar(pdf);
  assert.ok(v.firmas.every((f) => f.verifica), 'las dos firmas verifican igual');
  assert.ok(v.integro, '«íntegro» da true');
  assert.equal(v.contenido_alterado_entre_firmas, true,
               'si esto no saltara, no habría problema que resolver');
});

test('los campos del EMISOR se estampan antes de la primera firma, y no molestan', async (t) => {
  let pdf = estamparEnContenido(BASE, 0, 'Contrato Nro. 2026-0431', 180, 645);
  pdf = estamparEnContenido(pdf, 0, 'Importe: USD 12.500', 180, 625);

  pdf = (await sellar(pdf, {
    razon: 'Firmado por Ana', nombre: 'Ana Pérez',
    marcas: [{ pagina: 2, rect: [70, 150, 240, 205], imagen: FIRMA, principal: true }],
  }, firmanteLab('a'))).pdf;
  pdf = (await sellar(pdf, {
    razon: 'Firmado por Beto', nombre: 'Beto Silva',
    marcas: [{ pagina: 0, rect: [430, 60, 485, 100], imagen: RUBRICA }],
  }, firmanteLab('b'))).pdf;
  const archivo = guardar('campos_emisor.pdf', pdf);

  const v = verificar(pdf);
  assert.ok(v.integro);
  // Quedó adentro del ByteRange de la primera firma: no hay nada anterior que
  // proteger, así que estamparlo en el contenido es correcto y además conviene.
  assert.equal(v.contenido_alterado_entre_firmas, false,
               JSON.stringify(v.cambios.flatMap((c) => c.objetos.filter((o) => o.cambio))));

  if (sinPoppler()) return t.skip(String(sinPoppler()));
  assert.ok(extraer(archivo).includes('2026-0431'));
});

test('un carácter que la fuente no dibuja CORTA la firma, no dibuja «?»', async () => {
  // Dibujar «?» dejaría el `/V` diciendo una cosa y los píxeles otra, en un
  // documento que se está por firmar. Y la tolerancia de `sellar()` con las
  // marcas rotas no aplica: un campo completado no es decoración, es contenido.
  assert.deepEqual(fueraDeWinAnsi('Peña — 1º «así»'), []);
  assert.ok(fueraDeWinAnsi('Wǒ de míngzì 王').length > 0);

  await assert.rejects(
    () => sellar(BASE, {
      razon: 'x', nombre: 'x',
      marcas: [{ pagina: 0, rect: [180, 620, 380, 640], texto: '王小明', modo: 'campo' }],
    }, firmanteLab('a')),
    /no se puede dibujar/,
  );
});
