/**
 * El envío desde planilla CON DATOS POR PERSONA — las tres piezas puras.
 *
 * ═══ QUÉ DECIDE ESTA PRUEBA ═══
 *
 * Que un dato de la planilla **no pueda aterrizar en el campo equivocado ni con
 * la forma equivocada**, que es el riesgo nuevo que este envío agrega: cuarenta
 * valores que nadie mira uno por uno van a parar a documentos legales.
 *
 *  1. `leerPlanilla` sólo ve una TABLA cuando la forma es inequívoca — ante la
 *     duda devuelve lo de siempre y no se pierde nada.
 *  2. `mapearColumnasACampos` aparea por nombre y dice POR QUÉ ignora lo que
 *     ignora. Entran también los campos del firmante —opción B del 13/8—,
 *     cada columna con su `quien`, para que la pantalla avise cuáles quedan
 *     como sugerencia que el firmante puede corregir.
 *  3. `juzgarValorDePlanilla` rechaza lo que no se entiende ANTES de escribir,
 *     con el motivo que el emisor necesita para corregir la celda.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leerPlanilla, celdaATexto } from '../src/services/planilla_de_correos';
import { juzgarValorDePlanilla, mapearColumnasACampos } from '../src/services/campos';

const csv = (s: string) => leerPlanilla(Buffer.from(s, 'utf8'), 'lista.csv');

// ── 1. La tabla se ve sólo cuando ES una tabla ──────────────────────────────

test('encabezado + columnas de datos = tabla, con el número de fila de Excel', async () => {
  const r = await csv(
    'Nombre,Correo,Sueldo,Inicio\n' +
    '"Pérez, Ana",ana@empresa.com,85000,01/09/2026\n' +
    'Juan Díaz,juan@empresa.com,72000,15/09/2026\n',
  );
  assert.ok(r.tabla, 'con esa forma tenía que haber tabla');
  assert.deepEqual(r.tabla!.titulos, ['Sueldo', 'Inicio']);
  assert.deepEqual(r.tabla!.filas.map((f) => [f.fila, f.correo, f.nombre, f.datos['Sueldo']]), [
    [2, 'ana@empresa.com', 'Pérez, Ana', '85000'],
    [3, 'juan@empresa.com', 'Juan Díaz', '72000'],
  ]);
  // El encabezado se ENTENDIÓ: no puede figurar como fila salteada.
  assert.deepEqual(r.salteadas, []);
  // Y el texto de siempre sigue estando: una pantalla vieja no se entera.
  assert.equal(r.personas, 2);
});

test('sin fila de títulos no hay tabla, y todo sigue como antes', async () => {
  const r = await csv('ana@empresa.com,Compras\njuan@empresa.com,Legales\n');
  assert.equal(r.tabla, null);
  assert.equal(r.personas, 2);
});

test('si el correo cambia de columna, la tabla no es confiable y no se ofrece', async () => {
  // Las columnas no significan lo mismo en toda la planilla: un dato leído de
  // la columna equivocada es un sueldo en el renglón del teléfono.
  const r = await csv('Nombre,Correo,Sueldo\nAna,ana@empresa.com,85000\njuan@empresa.com,Juan,72000\n');
  assert.equal(r.tabla, null);
  assert.equal(r.personas, 2, 'las personas igual se leen: sólo se pierde la tabla');
});

test('dos correos en una fila: tampoco — no se sabe cuál manda', async () => {
  const r = await csv('Nombre,Correo,Alterno\nAna,ana@empresa.com,ana@personal.com\n');
  assert.equal(r.tabla, null);
});

test('sin columna que se llame nombre, el nombre queda vacío antes que adivinado', async () => {
  // En una tabla con datos, «la primera celda que no parece correo» puede ser
  // un monto: saludar a alguien por «85000» es peor que no saludarlo.
  const r = await csv('Sueldo,Correo\n85000,ana@empresa.com\n');
  assert.ok(r.tabla);
  assert.equal(r.tabla!.filas[0]!.nombre, null);
});

test('una celda con fecha de verdad se escribe como acá: día/mes/año', () => {
  assert.equal(celdaATexto(new Date(2026, 8, 1)), '01/09/2026');
  assert.equal(celdaATexto(85000), '85000');
  assert.equal(celdaATexto(true), 'sí');
  assert.equal(celdaATexto(null), '');
});

// ── 2. El mapeo de columnas dice lo que hace ────────────────────────────────

const CAMPOS = [
  { codigo: 'sueldo', etiqueta: 'Sueldo', etiqueta_i18n: { es: 'Sueldo', pt: 'Salário' }, tipo: 'moneda', quien_completa: 'emisor' },
  { codigo: 'inicio', etiqueta: 'Fecha de inicio', tipo: 'fecha', quien_completa: 'emisor' },
  { codigo: 'telefono', etiqueta: 'Teléfono', tipo: 'texto', quien_completa: 'firmante' },
];

test('el título aparea contra código y etiqueta, sin mayúsculas ni tildes', () => {
  const m = mapearColumnasACampos(['SUELDO', 'fecha de inicio'], CAMPOS);
  assert.deepEqual(m.columnas.map((c) => c.codigo), ['sueldo', 'inicio']);
  assert.deepEqual(m.ignoradas, []);
});

test('la etiqueta en otro idioma también responde: «Salário» es sueldo', () => {
  const m = mapearColumnasACampos(['Salário'], CAMPOS);
  assert.deepEqual(m.columnas.map((c) => c.codigo), ['sueldo']);
});

test('lo del firmante ENTRA, marcado como suyo — opción B del 13/8', () => {
  // Primero fue «sólo del emisor» (la mañana del 13/8); a la tarde Claudio
  // eligió la opción B: la planilla también deja prellenado lo del firmante, y
  // esa persona lo puede corregir hasta firmar (migración 060). El `quien` es
  // lo que le permite a la pantalla avisar cuáles columnas son sugerencias.
  const m = mapearColumnasACampos(['Teléfono', 'Sueldo'], CAMPOS);
  assert.deepEqual(
    m.columnas.map((c) => c.codigo + ':' + c.quien),
    ['telefono:firmante', 'sueldo:emisor'],
  );
  assert.deepEqual(m.ignoradas, []);
});

test('una columna desconocida y una repetida salen con motivos distintos', () => {
  const m = mapearColumnasACampos(['Sueldo', 'Comentarios', 'sueldo'], CAMPOS);
  assert.deepEqual(m.columnas.map((c) => c.codigo), ['sueldo']);
  assert.match(m.ignoradas[0]!.motivo, /no coincide con ningún campo/);
  assert.match(m.ignoradas[1]!.motivo, /repite/);
});

// ── 3. El juicio de cada valor, tipo por tipo ───────────────────────────────

const campo = (tipo: string, extra: Record<string, unknown> = {}) => ({
  codigo: 'c', etiqueta: 'C', tipo, opciones: null, obligatorio: false, ...extra,
}) as any;

test('número y moneda: como los escribe una persona, y nada más', () => {
  for (const v of ['85000', '85.000', '85000,50', '1,234.56', '$ 85000', '-12']) {
    assert.equal(juzgarValorDePlanilla(campo('moneda'), v).ok, true, v);
  }
  const r = juzgarValorDePlanilla(campo('numero'), 'ochenta mil');
  assert.equal(r.ok, false);
  assert.match((r as any).motivo, /tiene que ser un número/);
});

test('fecha: dd/mm/aaaa o aaaa-mm-dd, y el día tiene que existir', () => {
  assert.equal(juzgarValorDePlanilla(campo('fecha'), '01/09/2026').ok, true);
  assert.equal(juzgarValorDePlanilla(campo('fecha'), '2026-09-01').ok, true);
  const feb = juzgarValorDePlanilla(campo('fecha'), '31/02/2026');
  assert.equal(feb.ok, false);
  assert.match((feb as any).motivo, /no es una fecha del calendario/);
  assert.equal(juzgarValorDePlanilla(campo('fecha'), 'pronto').ok, false);
});

test('casilla: sí/x/1 marcan, no/0 dejan vacío, «quizás» no es una respuesta', () => {
  assert.deepEqual(juzgarValorDePlanilla(campo('casilla'), 'Sí'), { ok: true, valor: 'Sí' });
  assert.deepEqual(juzgarValorDePlanilla(campo('casilla'), 'no'), { ok: true, valor: '' });
  assert.equal(juzgarValorDePlanilla(campo('casilla'), 'quizás').ok, false);
});

test('opción: entra sin tildes ni mayúsculas pero se guarda la CANÓNICA', () => {
  const c = campo('opcion', { opciones: ['Jurídica', 'Física'] });
  assert.deepEqual(juzgarValorDePlanilla(c, 'juridica'), { ok: true, valor: 'Jurídica' });
  const r = juzgarValorDePlanilla(c, 'Cooperativa');
  assert.equal(r.ok, false);
  assert.match((r as any).motivo, /Jurídica, Física/);
});

test('un obligatorio con la celda vacía rechaza — decisión del 13/8', () => {
  const r = juzgarValorDePlanilla(campo('texto', { obligatorio: true }), '  ');
  assert.equal(r.ok, false);
  assert.match((r as any).motivo, /obligatorio/);
  // Vacío y opcional: pasa, y no escribe nada.
  assert.deepEqual(juzgarValorDePlanilla(campo('texto'), ''), { ok: true, valor: '' });
});

test('lo que el documento no puede dibujar se rechaza acá, no al firmar', () => {
  const r = juzgarValorDePlanilla(campo('texto'), 'precio en ₿');
  assert.equal(r.ok, false);
  assert.match((r as any).motivo, /no se pueden dibujar/);
});
