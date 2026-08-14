import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

/**
 * La consulta con la que `canalesPara()` decide si además del correo se avisa
 * por push, corrida contra el esquema REAL de `push_suscripcion`.
 *
 * ⚠⚠ Por qué existe este test. Del 3/8 al 14/8 esa consulta pidió una columna
 * `cuenta_id` que la tabla no tiene (migración 014), y reventaba con
 * «column "cuenta_id" does not exist» (42703) cada vez que se avisaba a alguien
 * con identidad. Como `canalesPara` estaba fuera del `try` de `avisar()`, se
 * llevaba puesto el aviso ENTERO, correo incluido. El único que llama a
 * `avisar()` es la cancelación de circuito: once días de cancelaciones que se
 * grababan en la base y después devolvían 500, sin que ningún firmante se
 * enterara de que ya no tenía que firmar. Se descubrió cancelando un documento
 * en pantalla, no leyendo el código.
 *
 * **Ninguna prueba lo agarró porque no había ninguna.** Ésta es la que faltaba.
 *
 * Cómo prueba lo que dice que prueba:
 *
 *  1. Crea `push_suscripcion` con el DDL **textual de la migración 014**, no con
 *     una copia a mano. Si mañana la tabla cambia, el test cambia con ella.
 *  2. Saca la consulta del **archivo fuente de `mensajes.ts`**, no de una copia
 *     pegada acá. Una copia se desincroniza en silencio, que es exactamente el
 *     tipo de defecto que estamos cazando.
 *
 * Necesita un Postgres de descarte escuchando (el mismo que usa
 * `test/migraciones/probar.sh`). Sin él se saltea, diciendo cómo correrlo — un
 * test que no puede correr tiene que decirlo, no pasar en verde.
 */

const RAIZ = new URL('..', import.meta.url).pathname;

/** El `create table push_suscripcion (...)` tal cual está en la migración. */
function ddlDeLaMigracion(): string {
  const sql = readFileSync(RAIZ + 'migrations/014_mensajeria_y_textos.sql', 'utf8');
  const m = sql.match(/create table push_suscripcion \([\s\S]*?\n\);/);
  assert.ok(m, 'no se encontró el create table de push_suscripcion en la 014');
  // `identidad_id` referencia `identidad`, que acá no existe: la referencia se
  // quita para poder crear la tabla sola. Las COLUMNAS, que es lo que se
  // prueba, quedan intactas.
  return m[0].replace(/ references identidad\(id\)[^,\n]*/g, '');
}

/** La consulta de `canalesPara`, sacada del fuente y con los parámetros puestos. */
function consultaDeCanalesPara(identidadId: string): string {
  const src = readFileSync(RAIZ + 'src/services/mensajes.ts', 'utf8');
  const m = src.match(/select count\(\*\)::int as n from push_suscripcion[\s\S]*?(?=`)/);
  assert.ok(m, 'no se encontró la consulta de push_suscripcion en mensajes.ts');
  return (
    m[0]
      .replace(/\$\{d\.identidadId\}/g, `'${identidadId}'`)
      // Cualquier otro parámetro se rellena con un UUID cualquiera a propósito:
      // así la consulta se ejecuta de verdad y, si menciona una columna que no
      // existe, el que habla es Postgres con su 42703 — que es el defecto que
      // este test viene a impedir. Rechazarla antes de correrla la haría fallar
      // por el motivo equivocado.
      .replace(/\$\{[^}]+\}/g, `'00000000-0000-0000-0000-000000000000'`)
  );
}

/**
 * ⚠⚠ SÓLO `PGURL_TEST`, y a propósito. Este test crea un esquema y lo borra: si
 * heredara `PGHOST`/`PGUSER` del entorno, correr `npm test` en la **terminal A**
 * —donde vive `source db/tunel.sh`— lo apuntaría a la base REAL de Railway.
 * Misma advertencia que `test/migraciones/probar.sh`. Sin la variable puesta a
 * mano, el test se saltea y dice cómo correrlo.
 */
const URL_BASE = process.env.PGURL_TEST || '';

async function conectar(): Promise<Client | null> {
  if (!URL_BASE) return null;
  const c = new Client({ connectionString: URL_BASE });
  try {
    await c.connect();
    return c;
  } catch {
    return null;
  }
}

test('la consulta de canalesPara corre contra el esquema real de push_suscripcion', async (t) => {
  const c = await conectar();
  if (!c) {
    t.skip(
      'sin PGURL_TEST. Levantá un Postgres DE DESCARTE (nunca el túnel) y corré:\n' +
        '  PGURL_TEST=postgres://postgres@localhost:5432/postgres npx tsx --test test/canales_de_aviso.test.ts',
    );
    return;
  }
  const esquema = 'canales_test_' + process.pid;
  try {
    await c.query(`create schema ${esquema}`);
    await c.query(`set search_path to ${esquema}`);
    await c.query('create extension if not exists pgcrypto');
    await c.query(ddlDeLaMigracion());

    const identidad = '11111111-1111-1111-1111-111111111111';
    const consulta = consultaDeCanalesPara(identidad);

    // 1. Sin suscripciones: corre y da 0. Que CORRA es medio test: es el 42703
    //    que estuvo once días vivo.
    let r = await c.query(consulta);
    assert.equal(Number(r.rows[0].n), 0, 'sin suscripciones tendría que dar 0');

    // 2. Con una vigente: da 1 → se prende el canal push.
    await c.query(
      `insert into push_suscripcion (identidad_id, endpoint, p256dh, auth)
       values ($1, 'https://push.example/abc', 'p', 'a')`,
      [identidad],
    );
    r = await c.query(consulta);
    assert.equal(Number(r.rows[0].n), 1, 'una suscripción vigente tendría que prender el push');

    // 3. Revocada: vuelve a 0. Un dispositivo dado de baja no recibe.
    await c.query(`update push_suscripcion set revocada_en = now()`);
    r = await c.query(consulta);
    assert.equal(Number(r.rows[0].n), 0, 'una suscripción revocada NO tendría que prender el push');

    // 4. Otra identidad no ve la suscripción ajena.
    await c.query(`update push_suscripcion set revocada_en = null`);
    r = await c.query(consultaDeCanalesPara('22222222-2222-2222-2222-222222222222'));
    assert.equal(Number(r.rows[0].n), 0, 'la suscripción de otra persona no cuenta');
  } finally {
    await c.query(`drop schema if exists ${esquema} cascade`).catch(() => {});
    await c.end();
  }
});
