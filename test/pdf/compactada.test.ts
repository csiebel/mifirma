/**
 * La base con numeración agujereada se compacta antes de firmar.
 *
 * ═══ QUÉ DECIDE ESTA PRUEBA ═══
 *
 * Medido en Acrobat la noche del 9/8 sobre el manual real de 74 hojas
 * (`claude/contrato-grande.md`): una base cuya numeración de objetos tiene
 * huecos sale de pdf-lib con la xref partida en subsecciones, y el comparador
 * de revisiones de Acrobat responde «el documento se ha modificado o dañado»
 * sobre firmas íntegras. La misma base compactada: verde. Acá se fija que
 * `normalizar()` compacte cuando corresponde y NO toque cuando no.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { PDFDocument, PDFName, PDFRef, PDFString, StandardFonts, rgb } from 'pdf-lib';
import { normalizar } from '../../src/firma/pades';

/** Subsecciones de la ÚLTIMA tabla xref clásica del archivo. */
function subsecciones(pdf: Buffer): number {
  const idx = pdf.lastIndexOf('\nxref\n');
  assert.ok(idx >= 0, 'el archivo no tiene tabla xref clásica');
  const tr = pdf.indexOf(Buffer.from('trailer'), idx);
  const cuerpo = pdf.slice(idx + 1, tr).toString('latin1');
  return [...cuerpo.matchAll(/^(\d+)\s+(\d+)$/gm)].length;
}

async function baseLisa(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2; i++) {
    doc.addPage([595.28, 841.89]).drawText(`hoja ${i + 1}`, { x: 60, y: 780, size: 12, font, color: rgb(0.2, 0.2, 0.2) });
  }
  return doc;
}

/** Le abre un hueco a la numeración: un objeto en el 500, referenciado. */
async function conHueco(): Promise<Buffer> {
  const doc = await PDFDocument.load(Buffer.from(await (await baseLisa()).save({ useObjectStreams: false })));
  const ref = PDFRef.of(500, 0);
  doc.context.assign(ref, PDFString.of('relleno para agujerear la numeración'));
  doc.catalog.set(PDFName.of('MiFirmaLabHueco'), ref);
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

test('una base agujereada y sin formulario sale compactada: una sola subsección', async () => {
  const cruda = await conHueco();
  // La condición previa de la prueba: el archivo de entrada REALMENTE está
  // agujereado. Sin esto, un pdf-lib que cambie de conducta la deja midiendo nada.
  assert.ok(subsecciones(cruda) > 1, 'el fixture perdió el hueco: no hay qué compactar');
  const norm = await normalizar(cruda, []);
  assert.equal(subsecciones(norm), 1, 'la base agujereada tenía que salir con la xref en una subsección');
});

test('una base sana sale como salía: una subsección, sin compactar de más', async () => {
  const sana = Buffer.from(await (await baseLisa()).save({ useObjectStreams: false }));
  const norm = await normalizar(sana, []);
  assert.equal(subsecciones(norm), 1);
});

test('una base agujereada CON formulario no se compacta: el formulario manda', async () => {
  const doc = await baseLisa();
  const f = doc.getForm().createTextField('cliente_razon');
  f.addToPage(doc.getPage(0), { x: 60, y: 600, width: 220, height: 24 });
  const guardado = await PDFDocument.load(Buffer.from(await doc.save({ useObjectStreams: false })));
  const ref = PDFRef.of(500, 0);
  guardado.context.assign(ref, PDFString.of('relleno'));
  guardado.catalog.set(PDFName.of('MiFirmaLabHueco'), ref);
  const cruda = Buffer.from(await guardado.save({ useObjectStreams: false }));

  const norm = await normalizar(cruda, []);
  const relecto = await PDFDocument.load(norm);
  assert.equal(relecto.getForm().getFields().length, 1,
    'el campo del cliente tenía que sobrevivir: un formulario no se compacta');
});
