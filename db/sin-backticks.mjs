#!/usr/bin/env node
/**
 * db/sin-backticks.mjs — el error que ya nos costó cuatro veces el mismo rato.
 *
 * ═══ QUÉ BUSCA ═══
 *
 * Un backtick adentro de un comentario SQL, adentro de un template literal:
 *
 *     await sql`
 *       select ...
 *       -- Antes esto salía de `participaciones[0].id`, que funciona
 *     `.execute(trx)
 *              ↑ ese backtick CIERRA el template, y a partir de ahí
 *                esbuild lee SQL como si fuera JavaScript.
 *
 * El error que sale no menciona comillas ni comentarios:
 *
 *     ERROR: Expected ";" but found "participaciones"
 *
 * O sea que señala una palabra que está tres líneas más abajo del problema, y
 * el servidor no arranca. Escribir el nombre de una columna entre backticks es
 * el reflejo natural de cualquiera que documenta código, y por eso vuelve a
 * pasar: no es un descuido de una vez, es una trampa del lenguaje.
 *
 * ⚠ Esto NO lo agarra TypeScript ni el editor: el archivo es sintácticamente
 * válido hasta que esbuild lo transforma. La única forma de que no llegue al
 * repo es mirarlo antes.
 *
 *   node db/sin-backticks.mjs            # todo src/
 *   node db/sin-backticks.mjs archivo.ts # uno solo
 *
 * Sale con código 1 si encuentra algo, para poder colgarlo de un hook o del
 * comando de commit.
 */
import fs from 'node:fs';
import path from 'node:path';

const raiz = process.argv[2] ?? new URL('../src/', import.meta.url).pathname;

function archivos(p) {
  if (fs.statSync(p).isFile()) return [p];
  return fs.readdirSync(p, { withFileTypes: true }).flatMap((e) => {
    const q = path.join(p, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : archivos(q);
    return /\.(ts|mts|js|mjs)$/.test(e.name) ? [q] : [];
  });
}

const malos = [];

for (const f of archivos(raiz)) {
  const lineas = fs.readFileSync(f, 'utf8').split('\n');
  // Se cuenta la paridad de backticks para saber si la línea está DENTRO de un
  // template literal. No es un parser de JavaScript —no lo necesita— pero sí
  // distingue el caso que importa: un `--` con backticks estando adentro.
  let dentro = false;
  lineas.forEach((linea, i) => {
    const sinEscapar = linea.replace(/\\`/g, '');
    const comentarioSql = /^\s*--/.test(linea) || /\s--\s/.test(linea);

    if (dentro && comentarioSql && sinEscapar.includes('`')) {
      malos.push({
        archivo: path.relative(process.cwd(), f),
        linea: i + 1,
        texto: linea.trim().slice(0, 88),
      });
    }
    const n = (sinEscapar.match(/`/g) || []).length;
    if (n % 2 === 1) dentro = !dentro;
  });
}

if (!malos.length) {
  console.log('✓ Ningún backtick adentro de un comentario SQL.');
  process.exit(0);
}

console.log('✗ Backticks adentro de comentarios SQL — esto rompe el build:\n');
for (const m of malos) {
  console.log(`  ${m.archivo}:${m.linea}`);
  console.log(`    ${m.texto}\n`);
}
console.log('Sacales los backticks: en un comentario SQL no significan nada y');
console.log('cierran el template literal que los rodea.');
process.exit(1);
