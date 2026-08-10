/**
 * Anotaciones que tapan texto firmado — el escalón del 10/8 (deuda 43).
 *
 * ═══ QUÉ DECIDE ESTA PRUEBA ═══
 *
 * El gesto hostil exacto: alguien recibe un documento con una firma, le agrega
 * una anotación (un rectángulo blanco) COMO INCREMENTO CRUDO —los bytes que
 * escribiría cualquier editor de PDF— y firma encima. Las firmas verifican, no
 * sobran bytes, `integro` da true. La pregunta nueva: ¿la anotación tapa
 * palabras que el primer firmante firmó? Tres casos: sobre una cláusula (rojo),
 * sobre el margen (libre), y sobre una hoja sin texto extraíble (no
 * comprobable — el punto ciego de los escaneados, dicho y no callado).
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { SignPdf } from '@signpdf/signpdf';
import { huecoVisible, type Marca } from '../../src/firma/apariencia';
import { normalizar, verificar } from '../../src/firma/pades';
import { anotacionesSobreTexto } from '../../src/firma/tapado';
import { base, firma, firmanteLab, prepararFixtures, sinPoppler } from './fixtures';

const signpdf = new SignPdf();

/**
 * Agrega una anotación cuadrada a la hoja 1 como incremento crudo: el objeto
 * nuevo, la página reescrita para listarlo en /Annots, y su tabla xref. Es lo
 * que escribe un editor hostil — no pasa por ninguna API nuestra.
 */
function conAnotacionHostil(pdf: Buffer, rect: [number, number, number, number]): Buffer {
  const s = pdf.toString('latin1');

  // La hoja 1: el primer objeto /Type /Page (no /Pages) del archivo.
  const rePag = /(\d+)[ \t]+0[ \t]+obj\b([\s\S]*?)endobj/g;
  let pagNum = -1; let pagDic = '';
  let m: RegExpExecArray | null;
  let maximo = 0;
  while ((m = rePag.exec(s)) !== null) {
    maximo = Math.max(maximo, Number(m[1]));
    if (pagNum < 0 && /\/Type\s*\/Page\b(?!s)/.test(m[2]!)) { pagNum = Number(m[1]); pagDic = m[2]!; }
  }
  assert.ok(pagNum > 0, 'no se encontró la hoja 1');
  const nuevo = maximo + 1;

  const cuerpoAnot =
    `<<\n/Type /Annot\n/Subtype /Square\n/Rect [${rect.join(' ')}]\n/F 4\n/IC [1 1 1]\n/CA 1\n>>`;

  // La página, con la anotación en su /Annots (creándolo si no estaba).
  let dic = pagDic.trim();
  if (/\/Annots\s*\[/.test(dic)) {
    dic = dic.replace(/\/Annots\s*\[/, (t) => `${t} ${nuevo} 0 R `);
  } else {
    const cierre = dic.lastIndexOf('>>');
    dic = dic.slice(0, cierre) + `\n/Annots [${nuevo} 0 R]\n` + dic.slice(cierre);
  }

  const rootRef = [...s.matchAll(/\/Root\s+(\d+\s+0\s+R)/g)].pop()?.[1];
  const prev = [...s.matchAll(/startxref\r?\n(\d+)/g)].pop()?.[1];
  assert.ok(rootRef && prev, 'sin /Root o sin startxref');

  let salida = Buffer.from(pdf);
  const refs: Array<[number, number]> = [];
  const escribir = (num: number, cuerpo: string) => {
    refs.push([num, salida.length + 1]);
    salida = Buffer.concat([salida, Buffer.from(`\n${num} 0 obj\n${cuerpo}\nendobj\n`, 'latin1')]);
  };
  escribir(nuevo, cuerpoAnot);
  escribir(pagNum, dic);

  const off10 = (n: number) => `0000000000${n}`.slice(-10);
  const xrefOff = salida.length + 1;
  const tabla = 'xref\n' +
    refs.sort((a, b) => a[0] - b[0])
        .map(([n, off]) => `${n} 1\n${off10(off)} 00000 n \n`).join('') +
    `trailer\n<<\n/Size ${nuevo + 1}\n/Root ${rootRef}\n/Prev ${prev}\n>>\n` +
    `startxref\n${xrefOff}\n%%EOF`;
  return Buffer.concat([salida, Buffer.from('\n' + tabla, 'latin1')]);
}

const firmar = (pdf: Buffer, quien: 'a' | 'b', nombre: string) =>
  signpdf.sign(huecoVisible({
    pdf, razon: `Prueba ${nombre}`, nombre, largoFirma: 16384,
    marcas: [{ pagina: 0, rect: [400, 40, 540, 90], imagen: firma(), principal: true }] as Marca[],
  }), firmanteLab(quien).signer());

async function firmadoConHostil(basePdf: Buffer, rect: [number, number, number, number]) {
  const uno = await firmar(await normalizar(basePdf, []), 'a', 'Sello Lab A');
  const dos = await firmar(conAnotacionHostil(uno, rect), 'b', 'Sello Lab B');
  const v = verificar(dos);
  assert.equal(v.integro, true, 'las firmas tienen que verificar: el ataque no rompe bytes');
  return { pdf: dos, v };
}

test('un rectángulo sobre una cláusula firmada se marca: tapa_texto', { skip: sinPoppler() }, async () => {
  await prepararFixtures();
  const { pdf, v } = await firmadoConHostil(base(), [55, 640, 320, 745]);
  const t = await anotacionesSobreTexto(pdf, v.cambios);
  assert.equal(t.comprobado, true);
  assert.equal(t.algunaTapa, true, 'tenía que gritar: hay palabras debajo');
  const mala = t.anotaciones.find((a) => a.veredicto === 'tapa_texto');
  assert.ok(mala, 'falta el veredicto tapa_texto');
  assert.equal(mala!.pagina, 0);
  assert.ok(mala!.palabrasDebajo > 0);
  assert.equal(mala!.despuesDeFirma, 1, 'se escribió después de la firma 1');
});

test('el mismo rectángulo sobre el margen no molesta: libre', { skip: sinPoppler() }, async () => {
  await prepararFixtures();
  const { pdf, v } = await firmadoConHostil(base(), [440, 300, 560, 380]);
  const t = await anotacionesSobreTexto(pdf, v.cambios);
  assert.equal(t.comprobado, true);
  assert.equal(t.algunaTapa, false);
  assert.equal(t.anotaciones.filter((a) => a.veredicto === 'libre').length, 1);
});

test('sobre una hoja sin texto extraíble NO se da verde: no_comprobable', { skip: sinPoppler() }, async () => {
  await prepararFixtures();
  // Una hoja que es pura imagen — el documento escaneado típico.
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(firma());
  doc.addPage([595.28, 841.89]).drawImage(img, { x: 40, y: 300, width: 500, height: 200 });
  const escaneado = Buffer.from(await doc.save({ useObjectStreams: false }));

  const { pdf, v } = await firmadoConHostil(escaneado, [60, 320, 300, 420]);
  const t = await anotacionesSobreTexto(pdf, v.cambios);
  assert.equal(t.comprobado, true);
  assert.equal(t.algunaTapa, false);
  const dudosa = t.anotaciones.find((a) => a.veredicto === 'no_comprobable');
  assert.ok(dudosa, 'el punto ciego se dice, no se calla');
  assert.match(dudosa!.motivo ?? '', /extraíble/);
});

test('un documento sin anotaciones agregadas no tiene nada que comprobar', async () => {
  await prepararFixtures();
  const uno = await firmar(await normalizar(base(), []), 'a', 'Sello Lab A');
  const dos = await firmar(uno, 'b', 'Sello Lab B');
  const v = verificar(dos);
  const t = await anotacionesSobreTexto(dos, v.cambios);
  assert.equal(t.comprobado, true);
  assert.equal(t.anotaciones.length, 0);
  assert.equal(t.algunaTapa, false);
});
