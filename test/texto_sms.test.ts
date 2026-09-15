import test from 'node:test';
import assert from 'node:assert/strict';
import { fueraDeGsm7, textosSmsParaPrueba } from '../src/services/twilio';

// =============================================================================
// Que los SMS del producto no se partan en dos por una tilde.
//
// El limite de 160 caracteres de un SMS vale solo mientras el texto entre en el
// alfabeto basico (GSM-7). UN SOLO caracter fuera de el fuerza UCS-2 y el limite
// cae a 70: el mismo mensaje pasa a costar el doble o el triple, y Twilio cobra
// por pedazo.
//
// Medido en produccion el 15/9/2026: el mensaje de prueba salio en 2 segmentos
// por la tilde de "codigo". No lo encontro una lectura del codigo — lo encontro
// medirlo, y el comentario que decia "se cuidan los 160 caracteres" llevaba
// meses siendo cierto e inutil.
//
// Esta prueba existe para que la proxima tilde no vuelva a ser invisible.
// =============================================================================

test('los textos de SMS entran en el alfabeto basico (GSM-7)', () => {
  for (const { proposito, texto } of textosSmsParaPrueba()) {
    const fuera = fueraDeGsm7(texto);
    assert.deepEqual(
      fuera,
      [],
      `El texto de "${proposito}" tiene ${fuera.length} caracter(es) fuera del alfabeto basico: ` +
        `${JSON.stringify(fuera)}. Eso fuerza UCS-2, baja el limite de 160 a 70 y parte el ` +
        `mensaje en dos. Texto: ${JSON.stringify(texto)}`,
    );
  }
});

test('los textos de SMS entran en un solo segmento', () => {
  for (const { proposito, texto } of textosSmsParaPrueba()) {
    assert.ok(
      texto.length <= 160,
      `El texto de "${proposito}" tiene ${texto.length} caracteres y el limite de un segmento ` +
        `GSM-7 es 160. Se paga uno mas. Texto: ${JSON.stringify(texto)}`,
    );
  }
});

test('la prueba se da cuenta si alguien mete una tilde', () => {
  // Una verificacion que no puede fallar no verifica nada: se comprueba que el
  // detector detecte.
  assert.deepEqual(fueraDeGsm7('codigo'), []);
  assert.deepEqual(fueraDeGsm7('código'), ['ó']);
  assert.deepEqual(fueraDeGsm7('«hola»'), ['«', '»']);
});
