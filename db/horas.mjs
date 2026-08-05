#!/usr/bin/env node
/**
 * db/horas.mjs — cuánto tiempo llevamos, sacado de la evidencia.
 *
 * ⚠ No lleva la cuenta de memoria: la deduce del historial de git, que es lo
 * único que quedó registrado sin que nadie tuviera que acordarse de anotarlo.
 *
 * ═══ CÓMO CUENTA, Y QUÉ TIENE DE FLOJO ═══
 *
 * Un commit dice CUÁNDO se terminó algo, no cuánto duró. Así que se agrupan los
 * commits en sesiones —dos commits separados por más de `CORTE` minutos son dos
 * sesiones distintas— y cada sesión mide desde su primer commit hasta el último,
 * más un rato de arranque por delante (el trabajo anterior al primer commit).
 *
 * Eso deja dos sesgos, y conviene tenerlos presentes al leer el número:
 *
 *  · **Por abajo**: una sesión con un solo commit al final se cuenta como
 *    `ARRANQUE` minutos aunque hayan sido tres horas. Es el caso más común en
 *    los días de un solo commit largo.
 *  · **Por arriba**: si en el medio de una sesión hubo un almuerzo de una hora,
 *    esa hora se cuenta igual.
 *
 * Por eso hay `claude/horas.md`: lo que sabemos de verdad de cada jornada se
 * anota ahí a mano, y esto es la referencia de contraste. Un número medido con
 * su método a la vista sirve; uno inventado con dos decimales, no.
 *
 *   node db/horas.mjs
 *   node db/horas.mjs --detalle     # sesión por sesión
 */
import { execSync } from 'node:child_process';

const CORTE = 150;      // minutos de silencio que separan una sesión de la otra
const ARRANQUE = 45;    // minutos que se suponen antes del primer commit de cada sesión

const salida = execSync(
  'git log --reverse --pretty=format:"%at|%ad|%s" --date=format:"%Y-%m-%d %H:%M"',
  { encoding: 'utf8' },
);

const commits = salida.trim().split('\n').map((l) => {
  const [at, fecha, ...resto] = l.split('|');
  return { t: Number(at) * 1000, fecha, titulo: resto.join('|') };
});

if (!commits.length) { console.log('No hay commits todavía.'); process.exit(0); }

const sesiones = [];
let actual = null;
for (const c of commits) {
  if (!actual || (c.t - actual.fin) / 60000 > CORTE) {
    actual = { desde: c.t, fin: c.t, commits: [c] };
    sesiones.push(actual);
  } else {
    actual.fin = c.t;
    actual.commits.push(c);
  }
}

const enHoras = (min) => (min / 60).toFixed(1).replace('.', ',');
let total = 0;
const porDia = new Map();

const detalle = process.argv.includes('--detalle');
if (detalle) console.log('\nSESIÓN POR SESIÓN\n' + '─'.repeat(72));

for (const s of sesiones) {
  const medidos = (s.fin - s.desde) / 60000;
  const min = medidos + ARRANQUE;
  total += min;

  const dia = s.commits[0].fecha.slice(0, 10);
  porDia.set(dia, (porDia.get(dia) ?? 0) + min);

  if (detalle) {
    const h1 = s.commits[0].fecha.slice(11);
    const h2 = s.commits[s.commits.length - 1].fecha.slice(11);
    console.log(
      `${dia}  ${h1}–${h2}  ${String(s.commits.length).padStart(2)} commit(s)  ` +
      `${enHoras(min).padStart(5)} h` +
      (s.commits.length === 1 ? '   ⚠ un solo commit: es el mínimo, no lo real' : ''),
    );
    console.log(`             ${s.commits[0].titulo.slice(0, 62)}`);
  }
}

console.log('\nPOR DÍA\n' + '─'.repeat(40));
for (const [dia, min] of [...porDia].sort()) {
  const barra = '█'.repeat(Math.round(min / 60));
  console.log(`${dia}   ${enHoras(min).padStart(5)} h  ${barra}`);
}

console.log('─'.repeat(40));
console.log(`${porDia.size} jornada(s) · ${sesiones.length} sesión(es) · ${commits.length} commits`);
console.log(`TOTAL MEDIDO: ${enHoras(total)} horas`);
console.log(
  `\n⚠ Es un piso, no una cuenta exacta. Los días con un solo commit se cuentan\n` +
  `  como ${ARRANQUE} minutos aunque hayan sido varias horas. Lo que se sabe de cada\n` +
  `  jornada está anotado en claude/horas.md, y ese es el número que vale.`,
);
