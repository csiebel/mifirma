/**
 * Las cuatro combinaciones de dos firmas sobre el mismo documento.
 *
 * ⚠ Ésta es la regresión de la lección 12: el estampado visual estaba probado
 * sobre UN documento con UNA firma, y la segunda firma perdía los campos de la
 * primera. Las dos firmas seguían verificando byte a byte —el ByteRange no se
 * toca— pero el documento dejaba de declarar la primera y el panel del lector
 * mostraba una sola. Un camino ejercido una vez no está probado, está estrenado.
 *
 * La firma «plana» se hace con `plainAddPlaceholder`, que NO es nuestro camino:
 * está a propósito, porque hace de firma puesta por OTRA herramienta. Un
 * documento que ya viene firmado por Acrobat y que después firmamos nosotros
 * —o al revés— es un caso real, y es donde se rompen los formularios.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { SignPdf } from '@signpdf/signpdf';
import { plainAddPlaceholder } from '@signpdf/placeholder-plain';
import { SUBFILTER_ETSI_CADES_DETACHED } from '@signpdf/utils';
import { huecoVisible, type Marca } from '../../src/firma/apariencia';
import { normalizar, verificar } from '../../src/firma/pades';
import { base, firma, firmanteLab, prepararFixtures, rubrica } from './fixtures';
import { acroformFinal, estructura, guardar } from './inspeccion';

const signpdf = new SignPdf();
const LARGO = 16384;
let FIRMA: Buffer;
let RUBRICA: Buffer;
let BASE: Buffer;

before(async () => {
  await prepararFixtures();
  FIRMA = firma();
  RUBRICA = rubrica();
  BASE = await normalizar(base());
});

const marcasDe = (quien: 'a' | 'b'): Marca[] => {
  const y = quien === 'a' ? 60 : 110;
  return [
    { pagina: 0, rect: [430, y, 485, y + 40], imagen: RUBRICA },
    { pagina: 1, rect: [430, y, 485, y + 40], imagen: RUBRICA },
    { pagina: 2, rect: [430, y, 485, y + 40], imagen: RUBRICA },
    { pagina: 2, rect: [70, y + 160, 240, y + 215], imagen: FIRMA, principal: true },
  ];
};

const firmarVisible = (pdf: Buffer, quien: 'a' | 'b', nombre: string) =>
  signpdf.sign(huecoVisible({
    pdf, marcas: marcasDe(quien), razon: `Firmado electrónicamente por ${nombre}`,
    nombre, lugar: 'Montevideo', contacto: 'soporte@mifirma.uy', largoFirma: LARGO,
  }), firmanteLab(quien).signer());

const firmarPlano = (pdf: Buffer, quien: 'a' | 'b', nombre: string) =>
  signpdf.sign(plainAddPlaceholder({
    pdfBuffer: pdf, reason: `Firmado electrónicamente por ${nombre}`, name: nombre,
    location: 'Montevideo', contactInfo: 'soporte@mifirma.uy',
    signatureLength: LARGO, subFilter: SUBFILTER_ETSI_CADES_DETACHED,
  }), firmanteLab(quien).signer());

const CASOS: [string, 'v' | 'p', 'v' | 'p'][] = [
  ['visible → visible', 'v', 'v'],
  ['visible → plana', 'v', 'p'],
  ['plana → visible', 'p', 'v'],
  ['plana → plana', 'p', 'p'],
];

for (const [titulo, uno, dos] of CASOS) {
  test(titulo, async () => {
    const p1 = uno === 'v' ? await firmarVisible(BASE, 'a', 'Ana Pérez')
                           : await firmarPlano(BASE, 'a', 'Ana Pérez');
    const p2 = dos === 'v' ? await firmarVisible(p1, 'b', 'Beto Silva')
                           : await firmarPlano(p1, 'b', 'Beto Silva');
    guardar(`matriz_${uno}${dos}.pdf`, p2);

    const v = verificar(p2);
    assert.equal(v.firmas.length, 2, 'tienen que quedar dos firmas');
    assert.ok(v.integro, 'el archivo tiene que quedar íntegro');

    const est = estructura(p2, acroformFinal(p2).campos);
    const detalle = est.map((e) => `${e.nombre}${e.esFirma ? '(firma)' : ''}`).join(' ');

    // ⚠ DOS CAMPOS DE FIRMA, no «dos campos». Desde que las rúbricas son
    // botones de sólo lectura —para que se impriman— también son campos y
    // también van al `/Fields`. Lo que hay que contar es `/FT /Sig`, que es lo
    // que el lector muestra como firma. La versión anterior contaba todo y esta
    // prueba se puso roja sin que nada se hubiera roto: la afirmación estaba
    // escrita más angosta que la invariante.
    assert.equal(est.filter((e) => e.esFirma).length, 2,
                 `el AcroForm final tiene que declarar las dos firmas — ${detalle}`);

    // Un campo de firma por acto de consentimiento, con UN widget: la forma que
    // todos los lectores validan. Con `/Kids`, poppler dice «not signed».
    assert.ok(est.every((e) => e.widgets === 1), `widgets por campo inesperados — ${detalle}`);

    // Y lo que no es firma tiene que estar bloqueado: una rúbrica que el
    // destinatario pueda mover o borrar no es una rúbrica.
    assert.ok(est.every((e) => e.esFirma || e.soloLectura),
              `alguna marca quedó editable — ${detalle}`);
  });
}
