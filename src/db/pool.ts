import pg from 'pg';
import { fijarContexto } from './contexto';
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
    // Modo sistema: jobs de cola, webhooks de proveedores, procesos internos.
    await fijarContexto(trx, { actor: 'sistema', cuentaId });
    return fn(trx);
  });
}

/**
 * Contexto del FIRMANTE EXTERNO: alguien sin cuenta que llega por un enlace
 * firmado enviado a su correo.
 *
 * No es un realm nuevo ni un tipo de usuario: el enlace es un PUNTERO A UNA
 * FILA de otorgamiento. Por eso acá no hay cuentaId — el externo no pertenece a
 * ninguna cuenta, pertenece a un otorgamiento —, y la RLS lo encierra en el
 * alcance exacto de esa fila aunque adivine el uuid de otra instancia, aunque
 * haya un bug de ruteo, aunque exista una inyección en un endpoint.
 */
export async function withExterno<T>(
  otorgamientoId: string,
  identidadId: string,
  fn: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  if (!otorgamientoId) throw new Error('withExterno: otorgamientoId es requerido');
  if (!identidadId) throw new Error('withExterno: identidadId es requerido');

  return db.transaction().execute(async (trx) => {
    await fijarContexto(trx, {
      actor: 'externo',
      identidadId,
      otorgamientoId,
      // Abrir el enlace no prueba identidad. El nivel sube sólo si firma con
      // certificado, y esa elevación la hace el motor de firma, no el acceso.
      nivelGarantia: 'ninguno',
    });
    return fn(trx);
  });
}

export async function cerrarPool(): Promise<void> {
  await db.destroy();
}
