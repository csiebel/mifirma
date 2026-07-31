import pg from 'pg';
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import type { DB } from './schema';

const { Pool, types } = pg;

// Postgres `date` (OID 1082): devolverlo como string 'YYYY-MM-DD' en lugar de
// Date evita corrimientos por zona horaria (bug clásico de node-pg con fechas).
types.setTypeParser(1082, (v) => v);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // OJO: este usuario debe ser `app_user` (sujeto a RLS), no el owner.
});

export const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool }),
});

/**
 * Ejecuta `fn` dentro de UNA transacción con el contexto de tenant seteado.
 *
 * Toda consulta de negocio pasa por acá: es lo que activa el filtrado RLS por
 * empresa en la base. Sin contexto, RLS no devuelve filas (fail-closed).
 *
 * Importante: este helper solo PROVEE el contexto de empresa; no decide
 * permisos. La autorización vive en los datos (políticas RLS), no en este código.
 */
export async function withTenant<T>(
  cuentaId: string,
  fn: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  if (!cuentaId) throw new Error('withTenant: cuentaId es requerido');

  return db.transaction().execute(async (trx) => {
    // set_config(clave, valor, is_local=true) equivale a SET LOCAL, pero permite
    // pasar el valor como PARÁMETRO (no se concatena el uuid => sin inyección).
    // Solo vive dentro de esta transacción y se revierte al COMMIT/ROLLBACK.
    await sql`select set_config('app.cuenta_id', ${cuentaId}, true)`.execute(trx);
    return fn(trx);
  });
}

export async function cerrarPool(): Promise<void> {
  await db.destroy();
}
