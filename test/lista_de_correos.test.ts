/**
 * La lista de correos: lo que se pega a mano y lo que sale de una planilla.
 *
 * ═══ QUÉ DECIDE ESTA PRUEBA ═══
 *
 * `partirLista` es la puerta por la que entran los destinatarios de un
 * documento legal. Lo que deja pasar se convierte en correos enviados, y lo que
 * pierde en silencio es **una persona que tenía que firmar y no se enteró**.
 * No hay pantalla que muestre eso: el emisor ve nueve donde puso diez.
 *
 * ⚠ Existe porque el comentario del archivo prometía «nombres entre <>» desde
 * el primer día y era falso: `Ana Pérez <ana@empresa.com>` contestaba «Estos no
 * parecen correos: Ana, Pérez». El caso más común que hay —reenviar un correo y
 * copiar el campo Para— estaba roto y nadie lo había reportado.
 *
 * ⚠ Y encontró un segundo defecto, en el arreglo mismo: con el nombre
 * admitiendo comas, `ana@empresa.com, Ana <a@empresa.com>` daba UNA persona
 * llamada «ana@empresa.com, Ana». El primer destinatario desaparecía sin un
 * error a la vista. Es el caso `no se come la direccion de al lado`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partirLista } from '../src/services/lista_de_correos';

/** Atajo: sólo las direcciones. */
const dir = (s: string) => partirLista(s).correos;
/** Atajo: pares «nombre|correo», para leer de un vistazo. */
const pares = (s: string) =>
  partirLista(s).personas.map((p) => (p.nombre ?? '·') + '|' + p.correo);

// ── Lo que ya funcionaba, y tiene que seguir dando exactamente lo mismo ──────

test('una columna copiada de Excel', () => {
  assert.deepEqual(dir('ana@empresa.com\njuan@empresa.com'), ['ana@empresa.com', 'juan@empresa.com']);
});

test('separados por comas, por punto y coma, o con espacios de más', () => {
  const esperado = ['ana@empresa.com', 'juan@empresa.com'];
  assert.deepEqual(dir('ana@empresa.com, juan@empresa.com'), esperado);
  assert.deepEqual(dir('ana@empresa.com;juan@empresa.com'), esperado);
  assert.deepEqual(dir('  ana@empresa.com   juan@empresa.com  '), esperado);
  assert.deepEqual(dir('ana@empresa.com,'), ['ana@empresa.com']);
});

test('lo que no es un correo sale como malo, y no se corrige', () => {
  const r = partirLista('ana@empresa.com\nana(arroba)empresa.com');
  assert.deepEqual(r.correos, ['ana@empresa.com']);
  assert.deepEqual(r.malos, ['ana(arroba)empresa.com']);
});

test('el repetido se señala, no se descarta callado', () => {
  const r = partirLista('ana@empresa.com\nANA@empresa.com');
  assert.deepEqual(r.correos, ['ana@empresa.com']);
  assert.deepEqual(r.repetidos, ['ANA@empresa.com']);
});

test('se guarda como lo escribió el emisor, se compara en minúscula', () => {
  assert.deepEqual(dir('Ana.Perez@Empresa.com'), ['Ana.Perez@Empresa.com']);
});

// ── El campo «Para», que decía que andaba y no andaba ────────────────────────

test('⚠ el campo Para de un correo reenviado, con nombres', () => {
  const r = partirLista('Ana Pérez <ana@empresa.com>, Juan Díaz <juan@empresa.com>');
  assert.deepEqual(r.malos, [], 'los nombres no son direcciones malas');
  assert.deepEqual(
    r.personas.map((p) => p.nombre + '|' + p.correo),
    ['Ana Pérez|ana@empresa.com', 'Juan Díaz|juan@empresa.com'],
  );
});

test('⚠ el nombre no se come la dirección de al lado', () => {
  // El defecto que introdujo el primer arreglo: con el nombre admitiendo comas,
  // esto daba UNA persona llamada «ana@empresa.com, Ana».
  const r = partirLista('ana@empresa.com, Ana <a@empresa.com>');
  assert.deepEqual(r.correos, ['ana@empresa.com', 'a@empresa.com'], 'tienen que entrar las DOS');
  assert.deepEqual(pares('ana@empresa.com, Ana <a@empresa.com>'), ['·|ana@empresa.com', 'Ana|a@empresa.com']);
});

test('el nombre con coma va entre comillas, como lo manda Outlook', () => {
  assert.deepEqual(pares('"Pérez, Ana" <ana@empresa.com>'), ['Pérez, Ana|ana@empresa.com']);
});

test('una dirección entre <> sin nombre no es una persona llamada «»', () => {
  assert.deepEqual(pares('<ana@empresa.com>'), ['·|ana@empresa.com']);
});

test('un renglón sin nombre y otro con nombre, mezclados', () => {
  assert.deepEqual(
    pares('ana@empresa.com\nJuan Díaz <juan@empresa.com>\nmaria@otra.com'),
    ['·|ana@empresa.com', 'Juan Díaz|juan@empresa.com', '·|maria@otra.com'],
  );
});

test('un < sin cerrar arruina su renglón y no se traga la lista', () => {
  const r = partirLista('Ana <ana@empresa.com\njuan@empresa.com');
  assert.ok(r.correos.includes('juan@empresa.com'), 'el renglón siguiente entra igual');
  assert.ok(r.malos.includes('Ana'), 'y el renglón roto se señala');
});

test('el nombre se limpia: comillas, espacios de más, y el tope de 120', () => {
  assert.deepEqual(pares('  Ana    Pérez   <ana@empresa.com>'), ['Ana Pérez|ana@empresa.com']);
  const largo = 'N'.repeat(200);
  assert.equal(partirLista(largo + ' <ana@empresa.com>').personas[0]!.nombre!.length, 120);
});

test('personas y correos van en el mismo orden y con el mismo largo', () => {
  const r = partirLista('Ana <a@e.com>\nb@e.com\n"Díaz, C" <c@e.com>\nno-es-correo');
  assert.equal(r.personas.length, r.correos.length);
  assert.deepEqual(r.personas.map((p) => p.correo), r.correos);
});

test('vacío no explota', () => {
  const r = partirLista('');
  assert.deepEqual(r.correos, []);
  assert.deepEqual(r.personas, []);
  assert.deepEqual(r.malos, []);
});
