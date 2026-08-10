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
import { huecoVisible, type Marca, type WidgetPredeclarado } from '../../src/firma/apariencia';
import { normalizar, verificar } from '../../src/firma/pades';
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
  // ═══ El pipeline REAL de hoy, no el del 8/8 (deuda 19) ═══
  //
  // Antes este test firmaba la base cruda, sin `normalizar()` ni pre-declarado:
  // medía el costo por hoja de un camino que ya no existe. Hoy el producto
  // normaliza, y con la reserva magra pre-declara los lugares de los que firman
  // DESPUÉS del primero: acá, la rúbrica por hoja y la firma del lugar 2. El
  // primero no reserva — sus marcas nacen frescas en su incremento — así que
  // sus etiquetas no están en la lista, a propósito, y el techo de KB por hoja
  // vigila el sobrecosto REAL: imágenes deduplicadas + widgets pre-declarados.
  const nom = (lugar: number, pg: number) => `marca_rubrica_h${pg + 1}__mf${lugar}`;
  const nomFirma = (lugar: number) => `marca_firma_h${HOJAS}__mf${lugar}`;
  const TODAS: WidgetPredeclarado[] = [
    ...Array.from({ length: HOJAS }, (_, pg): WidgetPredeclarado => (
      { nombre: nom(2, pg), pagina: pg, rect: [0, 0, 0, 0], clase: 'marca' })),
    { nombre: nomFirma(2), pagina: HOJAS - 1, rect: [0, 0, 0, 0], clase: 'marca' },
  ];

  const marcas = (y: number, lugar: number): Marca[] => [
    ...Array.from({ length: HOJAS }, (_, pg): Marca => (
      { pagina: pg, rect: [470, y, 525, y + 40], imagen: rubrica(), etiqueta: nom(lugar, pg) })),
    { pagina: HOJAS - 1, rect: [70, y + 120, 240, y + 175], imagen: firma(), principal: true,
      etiqueta: nomFirma(lugar) },
  ];

  let pdf = await normalizar(BASE, TODAS);
  for (const [quien, nombre, y, lugar] of
       [['a', 'Ana Pérez', 55, 1], ['b', 'Beto Silva', 100, 2]] as const) {
    pdf = await signpdf.sign(
      huecoVisible({ pdf, marcas: marcas(y, lugar), razon: `Firmado por ${nombre}`, nombre,
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
