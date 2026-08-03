/**
 * El caso que motivó toda la función: un contrato largo rubricado hoja por hoja.
 *
 * ⚠ Lo que vigila es el PESO. Reusar la misma imagen en 200 hojas embebía 200
 * XObjects idénticos: 4,39 KB por hoja, 879 KB de sobrecosto para dos firmantes
 * sobre un documento que pesaba menos que eso. Con deduplicación por huella
 * queda en menos de 3 KB por hoja, y lo que queda es el incremental update.
 *
 * Si alguien toca `refImagen()` o `refApariencia()` y se pierde la
 * deduplicación, todo sigue verificando y nadie se entera hasta que un cliente
 * manda un contrato de 300 hojas. Esta prueba es lo único que lo detecta.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { SignPdf } from '@signpdf/signpdf';
import { huecoVisible, type Marca } from '../../src/firma/apariencia';
import { verificar } from '../../src/firma/pades';
import { contrato, firma, firmanteLab, prepararFixtures, rubrica } from './fixtures';
import { guardar } from './inspeccion';

// Sesenta alcanza para que la deduplicación se note y no cuesta veinte segundos.
// El caso real son 200: `HOJAS=200 npx tsx --test test/pdf/contrato_largo.test.ts`.
const HOJAS = Number(process.env.HOJAS ?? 60);
/**
 * Techo del sobrecosto MARGINAL por hoja, en KB.
 *
 * ⚠ Marginal, no promedio. Cada firma reserva un hueco de 32 KB que se escribe
 * como 64 KB de ceros en hexadecimal, y ese costo es fijo: repartido entre 60
 * hojas parece 2 KB por hoja y entre 200 parece 0,6. Un techo sobre el promedio
 * daría distinto según el largo del contrato, que es justo lo que no queremos.
 * Lo que se vigila es lo que cuesta CADA hoja de más.
 */
const TECHO_KB_POR_HOJA = 3;
const HUECOS = 2 * 32768 * 2;      // dos firmas, en hexadecimal

const signpdf = new SignPdf();
let BASE: Buffer;

before(async () => {
  await prepararFixtures();
  BASE = await contrato(HOJAS);
});

test(`${HOJAS} hojas rubricadas por dos firmantes`, async () => {
  const marcas = (y: number): Marca[] => [
    ...Array.from({ length: HOJAS }, (_, pg): Marca => (
      { pagina: pg, rect: [470, y, 525, y + 40], imagen: rubrica() })),
    { pagina: HOJAS - 1, rect: [70, y + 120, 240, y + 175], imagen: firma(), principal: true },
  ];

  let pdf = BASE;
  for (const [quien, nombre, y] of [['a', 'Ana Pérez', 55], ['b', 'Beto Silva', 100]] as const) {
    pdf = await signpdf.sign(
      huecoVisible({ pdf, marcas: marcas(y), razon: `Firmado por ${nombre}`, nombre,
                     lugar: 'Montevideo', largoFirma: 32768 }),
      firmanteLab(quien).signer(),
    );
  }
  guardar('contrato_largo.pdf', pdf);

  const v = verificar(pdf);
  assert.equal(v.firmas.length, 2, 'dos firmantes, dos firmas — no dos por hoja');
  assert.ok(v.integro);

  // La invariante directa, y la que se lee de un vistazo: cada firma embebe sus
  // DOS imágenes (la rúbrica y la firma) una sola vez, no una por hoja. Sin
  // deduplicación serían 2 × (HOJAS + 1).
  const copias = (pdf.toString('latin1').match(/\/ImageMask true/g) || []).length;
  assert.equal(copias, 4,
               `${copias} imágenes embebidas; tienen que ser 4 (rúbrica y firma, por cada firmante)`);

  const kbPorHoja = (pdf.length - BASE.length - HUECOS) / 1024 / HOJAS;
  assert.ok(kbPorHoja < TECHO_KB_POR_HOJA,
            `sobrecosto marginal ${kbPorHoja.toFixed(2)} KB por hoja (techo ${TECHO_KB_POR_HOJA}): ` +
            'se perdió la deduplicación de la imagen o de la apariencia');
});
