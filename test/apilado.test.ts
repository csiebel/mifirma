/**
 * Las copias que «uno para cada firmante» dejó apiladas y nadie movió.
 *
 * ═══ QUÉ DECIDE ESTA PRUEBA ═══
 *
 * El botón «uno para cada firmante» apila las copias debajo de la primera y
 * pide que las arrastres, porque adivinar dónde va el renglón de cada uno en el
 * documento del cliente no lo puede hacer nadie. Falta la red: si no las moviste
 * el documento sale con el valor de uno impreso encima del texto de la hoja, y
 * sale firmado, o sea inmutable. Pasó el 8/8 —«Claudio T2C» arriba de la
 * etiqueta «Cargo»— y la comprobación del banco sobre el PDF **no lo ve**,
 * porque compara widgets contra widgets y acá lo pisado es texto de la hoja.
 *
 * Esta prueba cubre el otro lado: reconocer, ANTES de despachar, que una copia
 * sigue parada exactamente donde la puso el botón.
 *
 * ═══ POR QUÉ EXISTE Y NO SE BORRA ═══
 *
 * ⚠ La primera versión de la detección preguntaba «¿está en algún múltiplo del
 * paso por debajo de la base?». Es la versión obvia, y **esta prueba la
 * volteó**: el caso «arrastrada a un múltiplo exacto» daba positivo sobre un
 * campo bien puesto. Con un paso de 26 puntos eso pasa una de cada cincuenta
 * veces que alguien arrastra una copia — y un aviso que grita en falso se
 * aprende a ignorar, incluido el día que tiene razón.
 *
 * La detección de ahora es la función de apilado leída al revés, con los lugares
 * de los firmantes: exacta, sin múltiplos sueltos.
 *
 * ⚠ Se prueba el archivo del navegador, `public/campos.js`, cargado en un
 * sandbox. Es a propósito: el que apila tiene que ser el mismo que sabe
 * reconocer lo apilado. Si alguien cambia el respiro del apilado y deja la
 * detección atrás, acá se ve; en pantalla no se vería nada.
 *
 * Ver el §1 de `claude/estado-y-proximos-pasos.md`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

type Campo = Record<string, unknown>;
type Apilada = { copia: Campo; base: Campo };

/** Carga `public/campos.js` en un sandbox y devuelve lo que expone. */
function cargarDetector(): (campos: Campo[], lugares: number[]) => Apilada[] {
  const ruta = fileURLToPath(new URL('../public/campos.js', import.meta.url));
  const ventana: Record<string, any> = {};
  const ctx = createContext({ window: ventana, document: {}, console });
  runInContext(readFileSync(ruta, 'utf8'), ctx);
  const f = ventana.copiasApiladasSinMover;
  assert.equal(typeof f, 'function',
    'public/campos.js dejó de exponer copiasApiladasSinMover: el aviso previo al ' +
    'despacho se apaga solo y sin un error a la vista');
  return f;
}

const detectar = cargarDetector();

// Firmantes en los lugares 1, 2 y 3. Con alto 20, el paso del apilado es 26.
const LUGARES = [1, 2, 3];
const PASO = 26;

const base = (o: Campo = {}): Campo => ({
  codigo: 'cargo', etiqueta: 'Cargo', pagina: 0,
  x: 100, y: 500, ancho: 150, alto: 20, posicion_firmante: 1, ...o,
});
const copia = (lugar: number, y: number, o: Campo = {}): Campo => ({
  codigo: 'cargo_f' + lugar, etiqueta: 'Cargo', pagina: 0,
  x: 100, y, ancho: 150, alto: 20, posicion_firmante: lugar, ...o,
});
/** Dónde deja el botón al k-ésimo. */
const escalon = (k: number) => 500 - k * PASO;

const cuantas = (campos: Campo[], lugares: number[] = LUGARES) =>
  detectar(campos, lugares).length;

test('el caso del 8/8: tres firmantes y ninguna copia movida', () => {
  assert.equal(cuantas([base(), copia(2, escalon(1)), copia(3, escalon(2))]), 2);
});

test('movió una y se olvidó de la otra: salta igual', () => {
  // ⚠ Distinto del aviso de campos sin adoptar, que se calla si adoptaste
  // alguno. Allá dejar siete de doce afuera es una decisión mirada; acá una
  // copia clavada en el escalón exacto mientras las otras se movieron es un
  // olvido.
  assert.equal(cuantas([base(), copia(2, 300), copia(3, escalon(2))]), 1);
  assert.equal(cuantas([base(), copia(2, escalon(1)), copia(3, 240)]), 1);
});

test('todas acomodadas: no molesta', () => {
  assert.equal(cuantas([base(), copia(2, 300), copia(3, 240)]), 0);
});

test('⚠ una copia arrastrada a un múltiplo exacto del paso NO es una sin mover', () => {
  // El caso que volteó la primera versión. Su lugar es el 3, o sea el escalón 2;
  // está en el 10. La puso una persona, no el botón.
  assert.equal(cuantas([base(), copia(2, 300), copia(3, 500 - 10 * PASO)]), 0);
});

test('dos firmantes: la única copia sin mover', () => {
  assert.equal(cuantas([base(), copia(2, escalon(1))], [1, 2]), 1);
});

test('la movió: a otra hoja, al costado, o hacia arriba', () => {
  assert.equal(cuantas([base(), copia(2, escalon(1), { pagina: 1 })]), 0);
  assert.equal(cuantas([base(), copia(2, escalon(1), { x: 300 })]), 0);
  assert.equal(cuantas([base(), copia(2, 600)]), 0);
});

test('un campo que el emisor bautizó «anexo_f2» a mano no es una copia', () => {
  assert.equal(cuantas([
    base({ codigo: 'anexo' }),
    { codigo: 'anexo_f2', etiqueta: 'Anexo', pagina: 0, x: 100, y: escalon(1),
      ancho: 150, alto: 20, posicion_firmante: 3 },
  ]), 0);
});

test('sin la base —la borraron— no hay con qué comparar', () => {
  assert.equal(cuantas([copia(2, escalon(1))]), 0);
});

test('el ruido decimal de Postgres no cuenta como haber movido', () => {
  assert.equal(cuantas([base({ y: 500.0000001 }), copia(2, 473.9999998)]), 1);
  assert.equal(cuantas([base(), copia(2, escalon(1) + 0.2)]), 1);
  assert.equal(cuantas([base(), copia(2, escalon(1) + 3)]), 0);
});

test('el paso sale del alto del campo, no de un número fijo', () => {
  assert.equal(cuantas([base({ alto: 40 }), copia(2, 500 - 46, { alto: 40 })]), 1);
});

test('la base puede ser de cualquier firmante, o del emisor', () => {
  // El botón reparte «todos menos el dueño de la base», en orden.
  assert.equal(cuantas([
    base({ posicion_firmante: 2 }), copia(1, escalon(1)), copia(3, escalon(2)),
  ]), 2);
  assert.equal(cuantas([
    base({ posicion_firmante: null }),
    copia(1, escalon(1)), copia(2, escalon(2)), copia(3, escalon(3)),
  ]), 3);
});

test('en modo copias hay un solo lugar: el botón no crea nada y no hay qué avisar', () => {
  assert.equal(cuantas([base()], [1]), 0);
});

test('sin campos o sin firmantes no inventa avisos', () => {
  assert.equal(cuantas([], LUGARES), 0);
  assert.equal(cuantas([base(), copia(2, escalon(1))], []), 0);
});
