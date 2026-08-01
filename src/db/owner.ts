import pg from 'pg';
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import type { DB } from './schema';

// Pool PRIVILEGIADO para onboarding (alta de empresas). Usa DATABASE_OWNER_URL,
// un rol con INSERT sobre empresa (que app_user NO tiene). Es la conexión de la
// "plataforma", separada del runtime de la app. No usar para tráfico normal.
let _ownerDb: Kysely<DB> | null = null;

export function ownerDb(): Kysely<DB> {
  if (!_ownerDb) {
    const url = process.env.DATABASE_OWNER_URL;
    if (!url) {
      throw new Error('DATABASE_OWNER_URL no configurado (necesario para el provisioning).');
    }
    const pool = new pg.Pool({ connectionString: url });
    _ownerDb = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  }
  return _ownerDb;
}

/**
 * Corre `fn` con la conexión privilegiada y el contexto de empresa fijado al
 * id que se va a crear. Pre-generar el id y fijar el contexto hace que las
 * políticas WITH CHECK (= empresa actual) se cumplan al insertar la empresa y
 * todo lo que cuelga de ella, sin necesidad de evadir RLS.
 */
export async function withProvision<T>(
  cuentaId: string,
  fn: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  return ownerDb()
    .transaction()
    .execute(async (trx) => {
      await sql`select set_config('app.cuenta_id', ${cuentaId}, true)`.execute(trx);
      return fn(trx);
    });
}

/**
 * Igual que withProvision pero para el realm de ESTUDIO: fija el contexto de
 * estudio al id que se va a crear, para cumplir el WITH CHECK (= estudio actual)
 * al insertar el estudio y su primer contador.
 */

export async function cerrarOwnerPool(): Promise<void> {
  if (_ownerDb) {
    await _ownerDb.destroy();
    _ownerDb = null;
  }
}
