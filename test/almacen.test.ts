// El almacén distingue «no está» de «no pude leerlo» — deuda 16.
//
// La diferencia no es cosmética: un 404 con la región dice «los bytes viven en
// otro almacén» (la topología conocida de una base y dos almacenes), y un 503
// dice «reintentá». Cuando los dos salían como el mismo error crudo, el visor
// mostraba una hoja en blanco y se perdieron dos diagnósticos (10/8). Este test
// fija ese contrato: si alguien vuelve a unificar las dos fallas, acá se ve.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// La raíz se fija ANTES del primer `almacen()`: el driver es un singleton que
// lee ALMACEN_DIR una sola vez. Por eso los imports del código van dinámicos,
// después de setear el entorno.
const RAIZ = await mkdtemp(join(tmpdir(), 'almacen-test-'));
process.env.ALMACEN_DIR = RAIZ;
const { almacen, nuevaClave } = await import('../src/almacenamiento/almacen');
const { HttpError } = await import('../src/http/errors');

after(() => rm(RAIZ, { recursive: true, force: true }));

test('guardar y leer devuelven los mismos bytes', async () => {
  const clave = nuevaClave();
  const contenido = Buffer.from('%PDF-1.4 contenido de prueba');
  await almacen().guardar(clave, contenido);
  assert.deepEqual(await almacen().leer(clave), contenido);
});

test('leer una clave que no está es 404 y el mensaje nombra la región', async () => {
  const err = await almacen().leer(nuevaClave()).then(
    () => assert.fail('tendría que haber tirado'),
    (e: unknown) => e,
  );
  assert.ok(err instanceof HttpError, 'sale como HttpError, no como error crudo de Node');
  assert.equal(err.statusCode, 404);
  // La región es el dato que resuelve la duda en un segundo: dice EN QUÉ
  // almacén se buscó, que es lo que distingue un fantasma de otro entorno de
  // un archivo perdido de verdad.
  assert.match(err.message, /«local»/);
  assert.match(err.message, /no está/);
});

test('cualquier otra falla de lectura es 503 e invita a reintentar', async () => {
  // Se fabrica un EISDIR: un directorio donde tendría que haber un archivo.
  // Es la forma más barata de provocar «está pero no lo pude leer» sin tocar
  // permisos, que en CI se comportan distinto según el usuario.
  const clave = nuevaClave();
  await mkdir(join(RAIZ, clave.slice(0, 2), clave.slice(2, 4), clave), { recursive: true });
  const err = await almacen().leer(clave).then(
    () => assert.fail('tendría que haber tirado'),
    (e: unknown) => e,
  );
  assert.ok(err instanceof HttpError);
  assert.equal(err.statusCode, 503);
  assert.match(err.message, /volvé a intentarlo/);
});

test('borrar una clave que no está no tira: borrar es best-effort', async () => {
  await almacen().borrar(nuevaClave());
});
