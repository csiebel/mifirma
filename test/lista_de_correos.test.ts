import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partirLista } from '../src/services/lista_de_correos';

/**
 * La lista de correos que el emisor pega a mano en un envío de copias.
 *
 * Se prueba sola —sin base, sin servidor— porque `partirLista` no toca nada:
 * entra un texto, sale una lista. Lo que se comprueba acá es que acepte lo que
 * la gente realmente pega, y sobre todo que **no invente direcciones**.
 */

test('una columna de Excel: un correo por línea', () => {
  const r = partirLista('ana@empresa.com\njuan@empresa.com\nmaria@otra.com');
  assert.deepEqual(r.correos, ['ana@empresa.com', 'juan@empresa.com', 'maria@otra.com']);
  assert.deepEqual(r.malos, []);
});

test('el campo Para de un correo reenviado: direcciones entre <>', () => {
  const r = partirLista('<ana@empresa.com>, <juan@empresa.com>');
  assert.deepEqual(r.correos, ['ana@empresa.com', 'juan@empresa.com']);
  assert.deepEqual(r.malos, []);
});

test('punto y coma, que es lo que separa Outlook', () => {
  const r = partirLista('ana@empresa.com; juan@empresa.com;');
  assert.deepEqual(r.correos, ['ana@empresa.com', 'juan@empresa.com']);
  assert.deepEqual(r.malos, []);
});

test('tabulaciones, espacios de más y renglones en blanco', () => {
  const r = partirLista('  ana@empresa.com\t\tjuan@empresa.com   \n\n  maria@otra.com  ');
  assert.deepEqual(r.correos, ['ana@empresa.com', 'juan@empresa.com', 'maria@otra.com']);
});

test('la coma que quedó al final del último renglón', () => {
  const r = partirLista('ana@empresa.com,\njuan@empresa.com,');
  assert.deepEqual(r.correos, ['ana@empresa.com', 'juan@empresa.com']);
  assert.deepEqual(r.malos, []);
});

test('comillas de una celda de planilla', () => {
  const r = partirLista('"ana@empresa.com"\n"juan@empresa.com"');
  assert.deepEqual(r.correos, ['ana@empresa.com', 'juan@empresa.com']);
});

test('un repetido entra una sola vez y se avisa', () => {
  const r = partirLista('ana@empresa.com\njuan@empresa.com\nana@empresa.com');
  assert.deepEqual(r.correos, ['ana@empresa.com', 'juan@empresa.com']);
  assert.deepEqual(r.repetidos, ['ana@empresa.com']);
});

test('⚠ repetido con otra capitalización: el buzón es el mismo', () => {
  // Si esto no se detectara, Ana recibiría dos copias del mismo documento y no
  // sabría cuál firmar. Se compara como el buzón —sin distinguir mayúsculas— y
  // se guarda lo que escribió el emisor.
  const r = partirLista('Ana@Empresa.com\nana@empresa.COM');
  assert.deepEqual(r.correos, ['Ana@Empresa.com']);
  assert.deepEqual(r.repetidos, ['ana@empresa.COM']);
});

test('⚠ lo mal escrito se devuelve como malo, NO se corrige', () => {
  // Lo importante no es que lo detecte: es que no adivine. Mandarle el
  // documento a una dirección que inventamos nosotros es peor que no mandarlo.
  const r = partirLista('ana@empresa.com\njuan.empresa.com\nmaria@\n@otra.com');
  assert.deepEqual(r.correos, ['ana@empresa.com']);
  assert.deepEqual(r.malos, ['juan.empresa.com', 'maria@', '@otra.com']);
});

test('vacío o nulo: no revienta y no devuelve nada', () => {
  assert.deepEqual(partirLista('').correos, []);
  assert.deepEqual(partirLista('   \n\n  ').correos, []);
  assert.deepEqual(partirLista(null as unknown as string).correos, []);
  assert.deepEqual(partirLista(undefined as unknown as string).correos, []);
});

test('uno solo, sin ningún separador', () => {
  assert.deepEqual(partirLista('ana@empresa.com').correos, ['ana@empresa.com']);
});

test('cincuenta: no se pierde ninguno ni se altera el orden', () => {
  const gente = Array.from({ length: 50 }, (_, i) => `persona${i}@empresa.com`);
  const r = partirLista(gente.join('\n'));
  assert.deepEqual(r.correos, gente);
  assert.deepEqual(r.malos, []);
  assert.deepEqual(r.repetidos, []);
});
