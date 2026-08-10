/**
 * La lista CASILLA_MARCADA vive en dos archivos, y tiene que decir lo mismo.
 *
 * ═══ QUÉ DECIDE ESTA PRUEBA ═══
 *
 * El servidor estampa la X de una casilla con `CASILLA_MARCADA` (campos.ts);
 * la pantalla del firmante dibuja el tilde con `MARCADA` (visor.js). Son dos
 * procesos — uno Node, otro navegador — así que compartir el código no sale
 * gratis; compartir la VIGILANCIA sí. Si alguien agrega una forma de decir
 * «sí» en un archivo y no en el otro, la persona ve una cosa en la pantalla
 * y el PDF estampa otra. Eso es exactamente lo que esta prueba no deja pasar
 * en silencio (deuda 28).
 *
 * ⚠ Lee los archivos fuente con una regex anclada a la declaración. Si la
 * declaración cambia de forma, esta prueba falla con «no encontré la lista»
 * — que es la señal de venir a actualizarla, no un verde falso.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');

function lista(archivo: string, regex: RegExp): string[] {
  const t = readFileSync(join(raiz, archivo), 'utf8');
  const m = regex.exec(t);
  assert.ok(m, `no encontré la lista en ${archivo}: si cambió la declaración, actualizá esta prueba`);
  return [...m![1]!.matchAll(/'([^']*)'/g)].map((x) => x[1]!).sort();
}

test('CASILLA_MARCADA dice lo mismo en el servidor y en la pantalla', () => {
  const servidor = lista('src/services/campos.ts', /const CASILLA_MARCADA = new Set\(\[([^\]]*)\]\)/);
  const pantalla = lista('public/visor.js', /var MARCADA = \[([^\]]*)\]/);
  assert.ok(servidor.length >= 5, 'la lista del servidor quedó sospechosamente corta');
  assert.deepEqual(pantalla, servidor,
    'las dos listas divergieron: lo que la pantalla tilda y lo que el PDF estampa tienen que coincidir');
});
