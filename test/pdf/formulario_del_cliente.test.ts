/**
 * El SEGUNDO tipo de documento: uno que YA trae su propio formulario.
 *
 * ⚠ Regresión de la lección 13. Todo lo que se había probado entraba al sistema
 * como un PDF plano, pero la mitad de lo que sube un cliente —un formulario de
 * banco, del BPS, de la DGI— viene con AcroForm propio: sus campos, sus
 * recursos por omisión (`/DR`), su `/DA`, su alineación, y a veces
 * `/NeedAppearances`.
 *
 * `huecoVisible()` reescribía ese diccionario de cero con tres claves y todo lo
 * demás desaparecía al firmar. Sin `/DR`, un lector que tenga que redibujar un
 * campo no encuentra las fuentes.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFBool, PDFName, PDFNumber, StandardFonts } from 'pdf-lib';
import { normalizar, sellar, verificar } from '../../src/firma/pades';
import { firma, firmanteLab, prepararFixtures, sinPoppler, correr } from './fixtures';
import { extraer, guardar } from './inspeccion';

let FORM: Buffer;

before(async () => {
  await prepararFixtures();

  // Un formulario como los que suben los clientes.
  const doc = await PDFDocument.create();
  const pag = doc.addPage([595, 842]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  pag.drawText('SOLICITUD — completar y firmar', { x: 50, y: 780, size: 14, font: helv });
  const form = doc.getForm();
  for (const [i, n] of ['nombre', 'documento', 'domicilio'].entries()) {
    const f = form.createTextField(`solicitante.${n}`);
    f.setText(n === 'nombre' ? 'Juan Pérez' : '');
    f.addToPage(pag, { x: 180, y: 700 - i * 40, width: 320, height: 22 });
  }
  form.acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
  form.acroForm.dict.set(PDFName.of('DR'),
    doc.context.obj({ Font: doc.context.obj({ Helv: helv.ref }) }));
  form.acroForm.dict.set(PDFName.of('Q'), PDFNumber.of(1));
  FORM = Buffer.from(await doc.save({ useObjectStreams: false }));
});

/**
 * El diccionario del AcroForm, resuelto por la referencia del catálogo.
 *
 * ⚠ No se puede buscar «/Type /AcroForm»: pdf-lib NO escribe esa clave. Es la
 * misma trampa que está anotada en `apariencia.ts`, y la primera versión de
 * esta prueba se comió tres falsos negativos por caer en ella.
 */
function acroDe(archivo: string): string {
  const qdf = correr('qpdf', ['--qdf', '--object-streams=disable', archivo, '-']);
  const ref = qdf.match(/\/AcroForm\s+(\d+)\s+\d+\s+R/)?.[1];
  if (!ref) return '';
  const i = qdf.indexOf(`\n${ref} 0 obj`);
  return i < 0 ? '' : qdf.slice(i, qdf.indexOf('endobj', i));
}

const refsDeFields = (d: string) =>
  (d.slice(d.indexOf('/Fields')).match(/^[^\]]*/)?.[0].match(/\d+ 0 R/g) || []).length;

test('normalizar() congela las apariencias y saca /NeedAppearances a propósito', async (t) => {
  // Antes esto pasaba solo, porque `save()` de pdf-lib regenera apariencias por
  // omisión. El resultado era correcto y nadie lo había decidido — o sea,
  // correcto hasta la próxima refactorización.
  const norm = await normalizar(FORM);
  assert.ok(!norm.toString('latin1').includes('/NeedAppearances'));

  if (sinPoppler()) return t.skip(String(sinPoppler()));
  // Y lo que importa: el valor se sigue viendo sin que el lector lo redibuje.
  assert.ok(extraer(guardar('formulario_norm.pdf', norm)).includes('Juan Pérez'));
});

test('firmar un formulario del cliente no le borra el AcroForm', async (t) => {
  if (sinPoppler()) return t.skip(String(sinPoppler()));

  const original = guardar('formulario_original.pdf', FORM);
  const antes = acroDe(original);
  assert.match(antes, /\/NeedAppearances/);
  assert.match(antes, /\/DR/);
  assert.match(antes, /\/Q/);

  const pdf = (await sellar(await normalizar(FORM), {
    razon: 'Firmado por Ana', nombre: 'Ana Pérez',
    marcas: [{ pagina: 0, rect: [70, 100, 240, 155], imagen: firma(), principal: true }],
  }, firmanteLab('a'))).pdf;
  const archivo = guardar('formulario_firmado.pdf', pdf);

  const v = verificar(pdf);
  assert.ok(v.integro);
  assert.equal(v.firmas.length, 1);

  const despues = acroDe(archivo);
  assert.equal(refsDeFields(despues), refsDeFields(antes) + 1,
               'no puede perder ningún campo del formulario original');
  assert.equal((despues.match(/\/Fields/g) || []).length, 1, 'ninguna clave repetida');
  assert.match(despues, /\/DR/);
  assert.match(despues, /\/Q/);
  assert.ok(!/\/NeedAppearances/.test(despues));

  assert.ok(extraer(archivo).includes('Juan Pérez'), 'el valor del cliente sigue viéndose');
  const sig = correr('pdfsig', [archivo]);
  assert.match(sig, /Signature #1/);
  assert.ok(!/not signed/i.test(sig));
});
