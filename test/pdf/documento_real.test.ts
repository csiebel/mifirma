/**
 * Un documento REAL, salido de una herramienta de oficina.
 *
 * ⚠ Ésta es la regresión del peor defecto del 2/8/2026: un contrato de tres
 * páginas se firmaba, verificaba perfecto, y **las hojas 2 y 3 salían en
 * blanco** en el visor. La causa era que sus páginas traían `/Annots` como
 * referencia indirecta —lo normal fuera de pdf-lib— y el helper de la librería
 * buscaba un `]` que no existía, operando con índices negativos en silencio.
 *
 * Ningún PDF sintético lo mostró. Los que genera `fixtures.ts` traen `/Annots
 * [ ]` inline, que es justo el caso que funcionaba.
 *
 * ⚠ El archivo NO está en el repositorio: es un documento de alguien. Para
 * correr esta prueba, poné cualquier PDF de varias páginas salido de Word,
 * Pages, Acrobat o un banco en `test/pdf/fixtures/base_real.pdf`. Sin él la
 * prueba se saltea y lo dice — que no es lo mismo que pasar.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { normalizar, sellar, verificar } from '../../src/firma/pades';
import type { Marca } from '../../src/firma/apariencia';
import {
  BASE_REAL, firma, firmanteLab, hayDocumentoReal, prepararFixtures, rubrica, sinPoppler,
} from './fixtures';
import { estructuraSana, firmasSegunPoppler, guardar, paginasConTinta } from './inspeccion';

let BASE: Buffer;
let HOJAS = 0;
let MARCAS: Marca[] = [];

const porQueNo = () =>
  !hayDocumentoReal()
    ? 'falta test/pdf/fixtures/base_real.pdf (ver el encabezado de este archivo)'
    : sinPoppler();

before(async () => {
  await prepararFixtures();
  if (porQueNo()) return;
  const original = readFileSync(BASE_REAL);
  HOJAS = (await PDFDocument.load(original, { ignoreEncryption: true })).getPageCount();
  BASE = await normalizar(original);
  const ultima = HOJAS - 1;
  MARCAS = [
    ...Array.from({ length: HOJAS }, (_, p): Marca => (
      { pagina: p, rect: [470, 300, 525, 340], imagen: rubrica() })),
    { pagina: ultima, rect: [70, 120, 240, 175], imagen: firma(), principal: true },
  ];
});

test('el original renderiza entero antes de que lo toquemos', (t) => {
  if (porQueNo()) return t.skip(String(porQueNo()));
  // Si esto falla, el problema es el archivo de prueba y no el código.
  assert.equal(paginasConTinta(BASE_REAL, HOJAS).length, HOJAS);
});

test('una firma con rúbrica en todas las hojas', async (t) => {
  if (porQueNo()) return t.skip(String(porQueNo()));
  const r = await sellar(BASE, { razon: 'Firmado por Ana Pérez', nombre: 'Ana Pérez',
                                 marcas: MARCAS }, firmanteLab('a'));
  const archivo = guardar('real_una.pdf', r.pdf);

  assert.equal(r.marcasEstampadas, MARCAS.length);
  assert.equal(r.errorMarca, null);
  assert.ok(verificar(r.pdf).integro);

  const e = estructuraSana(archivo);
  assert.ok(e.ok, `qpdf se queja: ${e.graves.slice(0, 3).join(' | ')}`);

  const conTinta = paginasConTinta(archivo, HOJAS);
  assert.equal(conTinta.length, HOJAS, `hojas con contenido: ${conTinta.join(',')}`);
});

test('una firma SIN marcas: el camino que antes corrompía la página', async (t) => {
  if (porQueNo()) return t.skip(String(porQueNo()));
  const r = await sellar(BASE, { razon: 'Firmado por Beto Silva', nombre: 'Beto Silva' },
                         firmanteLab('b'));
  const archivo = guardar('real_sin.pdf', r.pdf);
  assert.ok(verificar(r.pdf).integro);
  const e = estructuraSana(archivo);
  assert.ok(e.ok, e.graves.slice(0, 3).join(' | '));
  assert.equal(paginasConTinta(archivo, HOJAS).length, HOJAS);
});

test('tres firmas encadenadas: un lector cuenta tres y las tres valen', async (t) => {
  if (porQueNo()) return t.skip(String(porQueNo()));
  let pdf = BASE;
  const quienes: [string, 'a' | 'b', Marca[] | undefined][] = [
    ['Claudio Siebel', 'a', MARCAS],
    ['Beto Silva', 'b', undefined],
    ['Carla Núñez', 'a', MARCAS.map((m) => ({
      ...m, rect: [m.rect[0] - 60, m.rect[1], m.rect[2] - 60, m.rect[3]] as Marca['rect'],
    }))],
  ];
  for (const [nombre, quien, ms] of quienes) {
    pdf = (await sellar(pdf, { razon: `Firmado por ${nombre}`, nombre, marcas: ms },
                        firmanteLab(quien))).pdf;
  }
  const archivo = guardar('real_tres.pdf', pdf);

  const v = verificar(pdf);
  assert.ok(v.integro);
  assert.equal(v.firmas.length, 3);
  assert.ok(v.firmas.every((f) => f.verifica),
            v.firmas.map((f) => `${f.nombre_declarado}:${f.verifica}`).join(' '));

  const e = estructuraSana(archivo);
  assert.ok(e.ok, e.graves.slice(0, 3).join(' | '));
  assert.equal(paginasConTinta(archivo, HOJAS).length, HOJAS);

  // La opinión del tercero. Tres campos y ninguno declarado sin firmar: ésa es
  // la comprobación que atrapa el defecto de `/Kids`. La validez criptográfica
  // se exige sólo donde poppler puede validarla — ver `firmasSegunPoppler`.
  const s = firmasSegunPoppler(archivo);
  assert.equal(s.campos, 3);
  assert.ok(!s.sinFirmar, s.texto);
  if (s.puedeValidar) assert.equal(s.validas, 3, s.texto);
});
