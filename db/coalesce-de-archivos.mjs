#!/usr/bin/env node
/**
 * db/coalesce-de-archivos.mjs — el `archivo_vigente_id` que se olvida.
 *
 * ═══ POR QUÉ EXISTE ═══
 *
 * Un documento vive en tres archivos distintos según cuánto se firmó:
 *
 *   · archivo_firmado_id  — firmaron TODOS: el circuito se completó.
 *   · archivo_vigente_id  — firmaron algunos. Es el estado entre la primera
 *                           firma y la última.
 *   · archivo_base_id     — el original, sin ninguna firma.
 *
 * Toda consulta que quiera «el documento» tiene que mirar los tres, en ese
 * orden. Y el del medio se olvida siempre, porque **el caso feliz funciona
 * igual sin él**: si firmaron todos, `archivo_firmado_id` está puesto y nadie
 * nota nada. El defecto aparece sólo en el medio del circuito, o cuando el
 * cierre no llegó a marcarse — y ahí el síntoma es que alguien firma, abre el
 * documento, y ve el original sin firmas ni datos.
 *
 * Ya pasó tres veces:
 *   · migración 039 — `archivo_select` no lo alcanzaba y ningún circuito de más
 *     de un firmante podía completarse.
 *   · `documentoParaFirmar` — el segundo firmante recibía el PDF sin la firma
 *     del primero.
 *   · `bajarDocumento` — «firmé un documento y no veo ni las firmas ni el texto».
 *
 * Tres veces el mismo olvido es un patrón, no un descuido.
 *
 *   node db/coalesce-de-archivos.mjs
 *
 * Sale con 1 si encuentra alguno incompleto, para poder colgarlo del commit.
 */
import fs from 'node:fs';
import path from 'node:path';

const raiz = process.argv[2] ?? new URL('../src/', import.meta.url).pathname;

function archivos(p) {
  if (fs.statSync(p).isFile()) return [p];
  return fs.readdirSync(p, { withFileTypes: true }).flatMap((e) => {
    const q = path.join(p, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : archivos(q);
    return /\.ts$/.test(e.name) ? [q] : [];
  });
}

const malos = [];

for (const f of archivos(raiz)) {
  const texto = fs.readFileSync(f, 'utf8');
  const lineas = texto.split('\n');

  lineas.forEach((linea, i) => {
    if (!/coalesce\s*\(/i.test(linea)) return;
    if (!/archivo_firmado_id/.test(linea)) return;

    // El coalesce puede estar partido en dos líneas: se mira esta y la siguiente.
    const bloque = linea + ' ' + (lineas[i + 1] ?? '');
    if (/archivo_vigente_id/.test(bloque)) return;

    malos.push({
      archivo: path.relative(process.cwd(), f),
      linea: i + 1,
      texto: linea.trim().slice(0, 92),
    });
  });
}

if (!malos.length) {
  console.log('✓ Todo coalesce con archivo_firmado_id mira también el vigente.');
  process.exit(0);
}

console.log('✗ Falta archivo_vigente_id en el coalesce:\n');
for (const m of malos) {
  console.log(`  ${m.archivo}:${m.linea}`);
  console.log(`    ${m.texto}\n`);
}
console.log('Un documento firmado por algunos y no por todos vive en');
console.log('archivo_vigente_id. Sin él, quien acaba de firmar ve el original.');
console.log('El orden correcto es: firmado → vigente → base.');
process.exit(1);
