/**
 * La tercera comprobación (deuda 11) — rectángulos que se salen de la hoja,
 * que se pisan entre sí, o que caen sobre el texto impreso del cliente.
 *
 * ═══ QUÉ DECIDE ESTA PRUEBA ═══
 *
 * `prueba-acrobat.md` §9: «tres comprobaciones que se contestan solas sobre
 * cualquier documento firmado». Ésta es la tercera, la única que faltaba, y
 * habría encontrado sola los defectos del 8/8 (marcas pisadas, x = 0 exacto)
 * y el del 10/8 (campos clavados en el borde).
 *
 * ⚠ Mide con qpdf y pdftotext (inspeccion.ts), no con nuestro código: el
 * banco es la segunda opinión. Los documentos se FABRICAN con el camino real
 * (`huecoVisible` + firma de laboratorio); se INSPECCIONAN con el ojo ajeno.
 *
 * ⚠ El punto ciego de los escaneados se dice, no se calla: una hoja con
 * widgets y sin texto extraíble es «no comprobable», nunca verde.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { SignPdf } from '@signpdf/signpdf';
import { huecoVisible, type Marca } from '../../src/firma/apariencia';
import { normalizar } from '../../src/firma/pades';
import { base, firma, firmanteLab, prepararFixtures, sinPoppler } from './fixtures';
import { guardar, rectangulos } from './inspeccion';

const signpdf = new SignPdf();

/** Firma con la marca en el rectángulo que el test elige. */
const firmarCon = (pdf: Buffer, quien: 'a' | 'b', nombre: string, rect: [number, number, number, number]) =>
  signpdf.sign(huecoVisible({
    pdf, razon: `Prueba ${nombre}`, nombre, largoFirma: 16384,
    marcas: [{ pagina: 0, rect, imagen: firma(), principal: true }] as Marca[],
  }), firmanteLab(quien).signer());

// Zonas medidas sobre el contrato de laboratorio (las mismas que usa
// tapado.test.ts): la cláusula con texto vive en [55,640]–[320,745]; el
// margen derecho a la altura 300–435 está en blanco; los sellos de la
// plataforma se estampan en la columna [430,485] × [60,160].
const LIBRE_A: [number, number, number, number] = [440, 300, 560, 355];
const LIBRE_B: [number, number, number, number] = [440, 380, 560, 435];

test('el documento sano del banco sale limpio de las tres', { skip: sinPoppler() }, async () => {
  await prepararFixtures();
  const uno = await firmarCon(await normalizar(base(), []), 'a', 'Sello Lab A', LIBRE_A);
  const dos = await firmarCon(uno, 'b', 'Sello Lab B', LIBRE_B);
  const ruta = guardar('rectangulos_limpio.pdf', dos);

  const v = rectangulos(ruta);
  assert.ok(v.widgets.length >= 2, 'tiene que haber widgets que mirar');
  assert.deepEqual(v.fueraDeHoja, [], 'nada asoma fuera de la hoja');
  assert.deepEqual(v.pisadas, [], 'nadie pisa a nadie');
  assert.deepEqual(v.sobreTexto, [], 'nadie cae sobre el texto impreso');
  assert.deepEqual(v.noComprobables, [], 'todas las hojas con widgets tienen texto: se comprueba todo');
});

test('una marca sobre la cláusula impresa grita: sobreTexto', { skip: sinPoppler() }, async () => {
  await prepararFixtures();
  const uno = await firmarCon(await normalizar(base(), []), 'a', 'Sello Lab A', [60, 650, 230, 705]);
  const ruta = guardar('rectangulos_sobre_texto.pdf', uno);

  const v = rectangulos(ruta);
  const mala = v.sobreTexto.find((s) => s.widget.nombre.includes('MiFirma'));
  assert.ok(mala, 'tenía que gritar: la marca cae sobre la cláusula');
  assert.ok(mala!.palabrasDebajo > 0);
  assert.equal(mala!.widget.pagina, 0);
});

test('dos marcas pisadas entre sí gritan: pisadas', { skip: sinPoppler() }, async () => {
  await prepararFixtures();
  const uno = await firmarCon(await normalizar(base(), []), 'a', 'Sello Lab A', LIBRE_A);
  const dos = await firmarCon(uno, 'b', 'Sello Lab B', [480, 330, 560, 385]);
  const ruta = guardar('rectangulos_pisadas.pdf', dos);

  const v = rectangulos(ruta);
  const par = v.pisadas.find(([a, b]) =>
    (a.nombre + b.nombre).includes('MiFirma1') && (a.nombre + b.nombre).includes('MiFirma2'));
  assert.ok(par, 'tenía que gritar: las dos firmas comparten 80 × 25 pt');
});

test('un rectángulo que asoma fuera de la hoja grita: fueraDeHoja', { skip: sinPoppler() }, async () => {
  await prepararFixtures();
  const uno = await firmarCon(await normalizar(base(), []), 'a', 'Sello Lab A', [500, 800, 700, 860]);
  const ruta = guardar('rectangulos_fuera.pdf', uno);

  const v = rectangulos(ruta);
  const fuera = v.fueraDeHoja.find((w) => w.nombre.includes('MiFirma'));
  assert.ok(fuera, 'tenía que gritar: 700 > 595 de ancho y 860 > 842 de alto');
});

test('hoja sin texto extraíble: no comprobable, nunca verde', { skip: sinPoppler() }, async () => {
  await prepararFixtures();
  // El escaneado típico: la hoja es una imagen y pdftotext ve cero palabras.
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(firma());
  doc.addPage([595.28, 841.89]).drawImage(img, { x: 40, y: 300, width: 500, height: 200 });
  const escaneado = Buffer.from(await doc.save({ useObjectStreams: false }));

  const uno = await firmarCon(await normalizar(escaneado, []), 'a', 'Sello Lab A', [60, 320, 300, 420]);
  const ruta = guardar('rectangulos_escaneado.pdf', uno);

  const v = rectangulos(ruta);
  assert.deepEqual(v.sobreTexto, [], 'sobre un escaneado nadie puede decir «no tapa»');
  const ciego = v.noComprobables.find((n) => n.pagina === 0);
  assert.ok(ciego, 'el punto ciego se dice, no se calla');
  assert.match(ciego!.motivo, /extraíble/);
});
