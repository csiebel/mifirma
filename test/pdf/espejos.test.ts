/**
 * Los ESPEJOS de un campo: el mismo dato, dibujado en cada lugar donde el
 * formulario lo repite. Migración 059, deuda 26.
 *
 * ═══ QUÉ DECIDE ESTA PRUEBA ═══
 *
 * Un formulario serio repite el mismo dato en varias hojas —el nombre del
 * paciente arriba de cada página—. En el PDF eso es UN campo con VARIOS
 * widgets. La decisión del 11/8: el valor se dibuja en TODOS los lugares, como
 * espejos que se pre-declaran y se completan igual que el widget principal.
 *
 * Acá se prueba la propiedad completa, por el camino real de la maquinaria
 * sellada — que NO se tocó: los espejos entran como datos.
 *
 *  1. Los tres widgets (principal + dos espejos) quedan pre-declarados.
 *  2. Dos firmas después, el valor se lee en las TRES hojas, las firmas
 *     verifican, y los objetos completados son los de ANTES de la primera
 *     firma — la propiedad exacta que Acrobat castiga si no se cumple.
 *  3. El GEMELO DE CONTROL: el mismo documento sin espejos sale con el valor
 *     en UNA sola hoja y verifica igual. Si este caso fallara, la prueba de
 *     arriba podría estar pasando por otro motivo.
 *  4. El nombre del espejo es literalmente el que es. No es capricho: ese
 *     nombre queda escrito ADENTRO de documentos ya despachados y todavía sin
 *     firmar del todo. Si el formato cambia entre dos versiones del código, la
 *     firma que llega después no encuentra el widget pre-declarado, lo AGREGA,
 *     y Acrobat dice «modificado o dañado» sobre un documento legítimo.
 *
 * ⚠ Los nombres salen de `nombreDelWidget` / `nombreDelEspejo` de
 * `services/campos.ts` — las MISMAS funciones que usan `widgetsAPredeclarar` y
 * `prepararCampos`— así esta prueba se rompe si alguien toca el formato.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { SignPdf } from '@signpdf/signpdf';
import { huecoVisible, type Marca, type WidgetPredeclarado } from '../../src/firma/apariencia';
import { normalizar, verificar } from '../../src/firma/pades';
import { nombreDelWidget, nombreDelEspejo, type Espejo } from '../../src/services/campos';
import { firmanteLab, prepararFixtures } from './fixtures';
import { acroformFinal, estructura } from './inspeccion';

const req = createRequire(import.meta.url);
const readPdf = req('@signpdf/placeholder-plain/dist/readPdf').default;

const signpdf = new SignPdf();

/** El campo tal como quedaría adoptado: del firmante del lugar 1. */
const CAMPO = { codigo: 'nombre_paciente', quien_completa: 'firmante', posicion_firmante: 1 };

/** Sin acentos a propósito: el assert de abajo busca los bytes tal cual. */
const VALOR = 'Ana Maria Solis';

/** El lugar principal (hoja 1) y los espejos (hojas 2 y 3), como en la base. */
const LUGAR = { pagina: 0, x: 90, y: 760, ancho: 220, alto: 20 };
const ESPEJOS: Espejo[] = [
  { pagina: 1, x: 90, y: 780, ancho: 220, alto: 20 },
  { pagina: 2, x: 90, y: 780, ancho: 180, alto: 16 }, // más chico a propósito: se ajusta solo
];

let FORM3: Buffer;

before(async () => {
  await prepararFixtures();

  // El formulario del cliente: tres hojas, y UN campo cuyo dato se repite en
  // las tres — exactamente la estructura que produce una herramienta de
  // oficina cuando el diseñador pone «Nombre del paciente» en cada página.
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const f = doc.getForm().createTextField('nombre_paciente');
  f.setText('');
  for (let i = 0; i < 3; i++) {
    const pag = doc.addPage([595, 842]);
    pag.drawText(`CONSENTIMIENTO — hoja ${i + 1}`, { x: 50, y: 810, size: 12, font: helv });
    pag.drawText('Nombre del paciente:', { x: 90, y: (i === 0 ? 760 : 780) + 24, size: 9, font: helv });
    f.addToPage(pag, i === 0
      ? { x: LUGAR.x, y: LUGAR.y, width: LUGAR.ancho, height: LUGAR.alto }
      : { x: 90, y: 780, width: ESPEJOS[i - 1]!.ancho, height: ESPEJOS[i - 1]!.alto });
  }
  FORM3 = Buffer.from(await doc.save({ useObjectStreams: false }));
});

/** Lo que emitiría `widgetsAPredeclarar` para este campo: principal + espejos. */
function widgets(conEspejos: boolean): WidgetPredeclarado[] {
  const w: WidgetPredeclarado[] = [{
    nombre: nombreDelWidget(CAMPO as any),
    pagina: LUGAR.pagina,
    rect: [LUGAR.x, LUGAR.y, LUGAR.x + LUGAR.ancho, LUGAR.y + LUGAR.alto],
  }];
  if (conEspejos) {
    for (const [i, e] of ESPEJOS.entries()) {
      w.push({
        nombre: nombreDelEspejo(CAMPO as any, i),
        pagina: e.pagina,
        rect: [e.x, e.y, e.x + e.ancho, e.y + e.alto],
      });
    }
  }
  return w;
}

/** Lo que emitiría `prepararCampos` al firmar: una marca por lugar. */
function marcas(conEspejos: boolean): Marca[] {
  const m: Marca[] = [{
    pagina: LUGAR.pagina,
    rect: [LUGAR.x, LUGAR.y, LUGAR.x + LUGAR.ancho, LUGAR.y + LUGAR.alto],
    texto: VALOR, modo: 'campo', etiqueta: nombreDelWidget(CAMPO as any),
  }];
  if (conEspejos) {
    for (const [i, e] of ESPEJOS.entries()) {
      m.push({
        pagina: e.pagina,
        rect: [e.x, e.y, e.x + e.ancho, e.y + e.alto],
        texto: VALOR, modo: 'campo', etiqueta: nombreDelEspejo(CAMPO as any, i),
      });
    }
  }
  return m;
}

const firmar = (pdf: Buffer, m: Marca[], nombre: string, quien: 'a' | 'b') =>
  signpdf.sign(
    huecoVisible({ pdf, marcas: m, razon: `Firmado por ${nombre}`, nombre, largoFirma: 16384 }),
    firmanteLab(quien).signer(),
  );

/** Cuántas veces quedó el VALOR escrito como valor de campo (`/V`). */
const vecesElValor = (pdf: Buffer) =>
  (pdf.toString('latin1').match(new RegExp(`/V \\(${VALOR}\\)`, 'g')) || []).length;

test('el nombre del espejo es el que es, porque vive adentro de documentos despachados', () => {
  assert.equal(nombreDelWidget(CAMPO as any), 'nombre_paciente__mf1');
  assert.equal(nombreDelEspejo(CAMPO as any, 0), 'nombre_paciente__mf1_e1');
  assert.equal(nombreDelEspejo(CAMPO as any, 1), 'nombre_paciente__mf1_e2');
});

test('el valor queda en las tres hojas, las firmas verifican, y nada se agregó después', async () => {
  const norm = await normalizar(FORM3, widgets(true));
  const maxAntes = readPdf(norm).xref.maxIndex;

  // Los tres quedaron pre-declarados con su nombre.
  const { campos } = acroformFinal(norm);
  const nombres = estructura(norm, campos).map((c) => c.nombre);
  for (const w of widgets(true)) {
    assert.ok(nombres.includes(w.nombre), `«${w.nombre}» no quedó pre-declarado`);
  }

  // Firma 1 completa el campo (principal + espejos); firma 2 no toca campos —
  // el segundo firmante de un consentimiento no escribe nada, y su firma es la
  // que castigaría cualquier cambio indebido de la primera.
  const uno = await firmar(norm, marcas(true), 'Ana Maria Solis', 'a');
  const dos = await firmar(uno, [], 'Dr. Benitez', 'b');

  const v = verificar(dos);
  assert.equal(v.firmas.length, 2, 'tienen que quedar DOS firmas');
  assert.ok(v.firmas.every((f) => f.verifica), 'alguna firma no verifica');
  assert.ok(v.integro, 'quedaron bytes que ninguna firma cubre');

  assert.equal(vecesElValor(dos), 3, 'el valor tiene que estar en los TRES lugares');

  // La propiedad que mira Acrobat: los widgets completados son los de ANTES de
  // la primera firma. Un objeto nuevo con estos nombres sería AGREGAR.
  const { campos: cf } = acroformFinal(dos);
  const refs = new Map(estructura(dos, cf).map((c) => [c.nombre, c.campo]));
  for (const w of widgets(true)) {
    const ref = refs.get(w.nombre);
    assert.ok(ref, `«${w.nombre}» desapareció del AcroForm final`);
    assert.ok(Number(ref!.split(/\s+/)[0]) <= maxAntes,
      `«${w.nombre}» es un objeto NUEVO: la firma lo agregó en vez de completarlo`);
  }

  // Y el AcroForm quedó sano: sin nombres repetidos ni rotos.
  const utiles = estructura(dos, cf).map((c) => c.nombre).filter((n) => n !== '?');
  assert.equal(new Set(utiles).size, utiles.length, 'hay nombres repetidos en el AcroForm');
  assert.ok(!utiles.some((n) => /undefined|null|NaN/.test(n)), 'hay un nombre roto en el AcroForm');
});

test('EL CONTROL: el mismo documento sin espejos sale con el valor en UNA hoja', async () => {
  const norm = await normalizar(FORM3, widgets(false));
  const uno = await firmar(norm, marcas(false), 'Ana Maria Solis', 'a');
  const dos = await firmar(uno, [], 'Dr. Benitez', 'b');

  const v = verificar(dos);
  assert.equal(v.firmas.length, 2);
  assert.ok(v.firmas.every((f) => f.verifica), 'alguna firma no verifica');
  assert.ok(v.integro, 'quedaron bytes que ninguna firma cubre');

  // Si esto diera 3, la prueba de arriba estaría midiendo otra cosa.
  assert.equal(vecesElValor(dos), 1, 'sin espejos el valor va en UN solo lugar');
});
