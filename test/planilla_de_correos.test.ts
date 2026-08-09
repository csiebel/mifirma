/**
 * La planilla de destinatarios: de un archivo al texto que se revisa.
 *
 * ═══ QUÉ DECIDE ESTA PRUEBA ═══
 *
 * Que **ninguna persona de la planilla se pierda en el camino**, y que lo que se
 * saltea **se muestre**. Una fila descartada en silencio es alguien que tenía
 * que firmar y no va a recibir nada; el emisor ve «se agregaron 39» donde puso
 * 40 y no tiene forma de saber cuál falta.
 *
 * ⚠ **Contar no alcanza, y eso lo enseñó una planilla de prueba de verdad.** La
 * primera versión devolvía «saltée 2 filas» y la pantalla agregaba «(el
 * encabezado suele ser una)» — una frase que invita a ignorar el número. Con
 * `claudio.siebel@gmail`, sin `.com`, esa fila **no llega a `partirLista`**
 * —así que no sale como correo malo— y desaparecía adentro del mismo contador
 * que el encabezado. Ver el caso «una persona con el correo mal tipeado».
 *
 * ⚠ Se prueba junto con `partirLista`, y no sola. El lector devuelve texto y
 * ese texto lo vuelve a leer otro: **los dos tienen que entenderse**. Si el
 * lector escribe un apellido con coma sin comillas, acá se lee bien y allá se
 * parte al medio — y cada archivo, probado solo, diría que está perfecto.
 *
 * ⚠ Y ojo con la de Excel: el `.xlsx` de la prueba **se arma acá**, con la
 * biblioteca de escritura, no es un archivo guardado en el repo. Un fixture
 * binario que nadie puede leer ni corregir es una prueba que dentro de un año
 * nadie va a poder cambiar.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leerPlanilla, partirCsv, filaARenglon } from '../src/services/planilla_de_correos';
import { partirLista } from '../src/services/lista_de_correos';
import { xlsxMinimo } from './xlsx_minimo';

/** El camino completo: archivo → texto → destinatarios. */
async function extremoAExtremo(datos: Buffer, nombre: string) {
  const r = await leerPlanilla(datos, nombre);
  const p = partirLista(r.texto);
  return {
    leidas: r.personas,
    salteadas: r.salteadas.length,
    /** «nº: lo que decía» — lo que la pantalla le muestra al emisor. */
    detalleSalteadas: r.salteadas.map((s) => s.fila + ': ' + s.texto),
    de_mas: r.de_mas,
    gente: p.personas.map((x) => (x.nombre ?? '·') + '|' + x.correo),
    malos: p.malos,
  };
}
const csv = (s: string, n = 'lista.csv') => extremoAExtremo(Buffer.from(s, 'utf8'), n);

// ── El partidor de CSV ───────────────────────────────────────────────────────

test('las comillas mantienen junta una celda con coma', () => {
  assert.deepEqual(partirCsv('"Pérez, Ana",ana@empresa.com'), [['Pérez, Ana', 'ana@empresa.com']]);
});

test('coma, punto y coma y tabulación sirven de separador', () => {
  assert.deepEqual(partirCsv('a,b'), [['a', 'b']]);
  assert.deepEqual(partirCsv('a;b'), [['a', 'b']]);
  assert.deepEqual(partirCsv('a\tb'), [['a', 'b']]);
});

test('el BOM que pone Excel no arruina la primera celda', () => {
  // Sin sacarlo, la celda arranca con un carácter invisible y el correo de la
  // fila 1 deja de parecer un correo: se pierde la primera persona.
  assert.deepEqual(partirCsv('﻿ana@empresa.com'), [['ana@empresa.com']]);
  assert.equal(filaARenglon(partirCsv('﻿ana@empresa.com')[0]!), 'ana@empresa.com');
});

// ── Qué columna es cuál ──────────────────────────────────────────────────────

test('no importa el orden de las columnas', () => {
  assert.equal(filaARenglon(['ana@empresa.com', 'Ana']), '"Ana" <ana@empresa.com>');
  assert.equal(filaARenglon(['Ana', 'ana@empresa.com']), '"Ana" <ana@empresa.com>');
  assert.equal(filaARenglon(['Compras', 'Ana', 'ana@empresa.com']), '"Compras" <ana@empresa.com>');
});

test('sin nombre, el renglón es la dirección sola', () => {
  assert.equal(filaARenglon(['ana@empresa.com']), 'ana@empresa.com');
  assert.equal(filaARenglon(['ana@empresa.com', '', null]), 'ana@empresa.com');
});

test('una fila sin ninguna celda con correo no es una persona', () => {
  assert.equal(filaARenglon(['Correo', 'Nombre']), null);
  assert.equal(filaARenglon(['Total: 3', null]), null);
});

// ── El camino completo ───────────────────────────────────────────────────────

test('encabezado, fila vacía y el «Total» de abajo: se saltean y SE MUESTRAN', async () => {
  const r = await csv('Correo,Nombre\nana@empresa.com,Ana\n\njuan@empresa.com,Juan\nTotal,2\n');
  assert.deepEqual(r.gente, ['Ana|ana@empresa.com', 'Juan|juan@empresa.com']);
  assert.equal(r.leidas, 2);
  // El encabezado y el «Total». La fila vacía NO cuenta: es espacio en blanco,
  // no una persona descartada.
  assert.deepEqual(r.detalleSalteadas, ['1: Correo / Nombre', '5: Total / 2']);
});

test('⚠⚠ una persona con el correo mal tipeado NO se pierde en el contador', async () => {
  // EL CASO QUE MOTIVÓ ESTA LISTA. `claudio.siebel@gmail` no tiene punto, así
  // que esa fila no tiene NINGUNA celda que parezca un correo y se descarta
  // entera: no sale como «correo malo», porque nunca llega a `partirLista`.
  //
  // Con un contador, el emisor leía «saltée 2 filas (el encabezado suele ser
  // una)» y daba las dos por ruido. **Ahí desaparecía una persona.**
  const r = await csv(
    'Nombre,Correo\nClaudio Mac,csiebel@mac.com\nClaudio Gmail,claudio.siebel@gmail\n',
  );
  assert.equal(r.leidas, 1);
  assert.deepEqual(r.malos, [], 'no llega como correo malo: por eso hace falta la lista');
  assert.deepEqual(r.detalleSalteadas, [
    '1: Nombre / Correo',
    '3: Claudio Gmail / claudio.siebel@gmail',
  ], 'tiene que decir el número de fila y QUÉ decía, o no sirve');
});

test('el número de fila es el de Excel: la primera es la 1', async () => {
  // Si dijera 0, mandaría al emisor a mirar una fila que no existe.
  const r = await csv('basura\nana@empresa.com\n');
  assert.deepEqual(r.detalleSalteadas, ['1: basura']);
});

test('una fila salteada muy larga se recorta, pero se reconoce', async () => {
  const largo = 'X'.repeat(200);
  const r = await csv(largo + '\nana@empresa.com\n');
  assert.equal(r.detalleSalteadas.length, 1);
  assert.ok(r.detalleSalteadas[0]!.endsWith('…'), 'se recorta');
  assert.ok(r.detalleSalteadas[0]!.length < 80, 'y no llena la pantalla');
});

test('⚠ el apellido con coma sobrevive al viaje de ida y vuelta', async () => {
  // Es el caso que sólo se ve probando los dos archivos juntos: si el lector
  // escribiera el nombre sin comillas, acá saldría «Ana» y «Pérez» como
  // direcciones malas, y cada archivo probado por su cuenta diría que está bien.
  const r = await csv('"Pérez, Ana";ana@empresa.com\n');
  assert.deepEqual(r.gente, ['Pérez, Ana|ana@empresa.com']);
  assert.deepEqual(r.malos, []);
});

test('las tildes y la ñ llegan enteras', async () => {
  const r = await csv('María Ñandú,maria@otra.com\n');
  assert.deepEqual(r.gente, ['María Ñandú|maria@otra.com']);
});

test('un archivo con sólo correos, sin nombres', async () => {
  const r = await csv('ana@empresa.com\njuan@empresa.com\n');
  assert.deepEqual(r.gente, ['·|ana@empresa.com', '·|juan@empresa.com']);
  assert.equal(r.salteadas, 0);
  assert.deepEqual(r.detalleSalteadas, []);
});

test('el repetido llega hasta partirLista, que es quien avisa', async () => {
  const r = await csv('ana@empresa.com,Ana\nANA@empresa.com,Ana de nuevo\n');
  assert.equal(r.leidas, 2, 'el lector no deduplica: no es su trabajo');
  assert.deepEqual(r.gente, ['Ana|ana@empresa.com'], 'el que deduplica es partirLista');
});

test('⚠ si se recorta por el tope, se dice', async () => {
  const muchas = Array.from({ length: 230 }, (_, i) => `p${i}@empresa.com`).join('\n');
  const r = await csv(muchas);
  assert.equal(r.leidas, 200);
  assert.equal(r.de_mas, 30, 'un recorte que no se cuenta se lee como «entraron todos»');
});

test('un archivo vacío no explota ni inventa gente', async () => {
  const r = await csv('');
  assert.equal(r.leidas, 0);
  assert.deepEqual(r.gente, []);
});

// ── Excel de verdad ──────────────────────────────────────────────────────────

test('un .xlsx de verdad, con encabezado, hueco y basura al final', async () => {
  const datos = xlsxMinimo(
    [
      ['Nombre', 'Correo', 'Sector'],
      ['Pérez, Ana', 'ana@empresa.com', 'Compras'],
      [null, null, null],
      ['Juan Díaz', 'juan@empresa.com', 'Legales'],
      ['María Ñandú', 'maria@otra.com', null],
      ['Total: 3', null, null],
    ],
    'Destinatarios',
  );
  const r = await extremoAExtremo(datos, 'destinatarios.xlsx');
  assert.deepEqual(r.gente, [
    'Pérez, Ana|ana@empresa.com',
    'Juan Díaz|juan@empresa.com',
    'María Ñandú|maria@otra.com',
  ]);
  assert.deepEqual(r.detalleSalteadas, ['1: Nombre / Correo / Sector', '6: Total: 3']);
  assert.deepEqual(r.malos, []);
});

test('⚠ la biblioteca devuelve las filas donde las esperamos', async () => {
  // `read-excel-file` devolvió, según la versión, las filas derecho o envueltas
  // en `[{ sheet, data }]`. El lector acepta las dos formas a propósito: si una
  // actualización cambia la envoltura y sólo se contemplara una, la lectura
  // daría CERO personas **sin ningún error** — el archivo se subiría, el cuadro
  // quedaría vacío y parecería que la planilla estaba mal. Esta prueba es la
  // que se entera.
  const r = await leerPlanilla(xlsxMinimo([['ana@empresa.com']], 'Sola'), 'x.xlsx');
  assert.equal(r.personas, 1, 'cero acá significa que cambió la forma del retorno');
  assert.equal(r.texto, 'ana@empresa.com');
});

test('el nombre de la hoja se informa, para que el emisor sepa cuál se leyó', async () => {
  const r = await leerPlanilla(xlsxMinimo([['a@e.com']], 'Segunda tanda'), 'x.xlsx');
  assert.equal(r.hoja, 'Segunda tanda');
});
