import pg from 'pg';
import { fijarContexto } from './contexto';
import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import type { DB } from './schema';

const { Pool, types } = pg;

// Postgres `date` (OID 1082): devolverlo como string 'YYYY-MM-DD' en lugar de
// Date evita corrimientos por zona horaria (bug clásico de node-pg con fechas).
types.setTypeParser(1082, (v) => v);

/**
 * ⚠ DATABASE_URL debe apuntar al rol `mifirma_app`, NUNCA a `postgres`.
 *
 * PostgreSQL saltea todas las políticas RLS para un superusuario y para el
 * dueño de las tablas. La URL que entrega Railway por defecto es del rol
 * `postgres`, que es superusuario: usarla acá apaga el aislamiento entre
 * cuentas en producción sin producir ningún síntoma. Los tests siguen pasando,
 * las consultas simplemente devuelven de más.
 *
 * Ver README.md y `claude/infraestructura.md`.
 */
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool }),
});

/**
 * Ejecuta `fn` dentro de UNA transacción con el contexto de tenant seteado, en
 * modo SISTEMA: jobs de la cola, webhooks de proveedores, procesos internos.
 *
 * `set_config(clave, valor, is_local=true)` equivale a SET LOCAL pero permite
 * pasar el valor como PARÁMETRO — el uuid no se concatena, así que no hay
 * inyección posible. Sólo vive dentro de la transacción y se revierte al
 * COMMIT o al ROLLBACK.
 *
 * Este helper PROVEE contexto; no decide permisos. La autorización vive en las
 * políticas RLS, no en este código.
 */
export async function withTenant<T>(
  cuentaId: string,
  fn: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  if (!cuentaId) throw new Error('withTenant: cuentaId es requerido');

  return db.transaction().execute(async (trx) => {
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

// ---------------------------------------------------------------------------
// Realm operador
// ---------------------------------------------------------------------------

let _operadorDb: Kysely<DB> | null = null;

/**
 * Pool SEPARADO para la consola del proveedor del SaaS, con el rol
 * `mifirma_operador`.
 *
 * Es una conexión distinta a propósito, no por prolijidad: el límite del
 * operador —no ver el contenido de los clientes— es la AUSENCIA de GRANT sobre
 * `archivo`, `instancia`, `participacion`, `circuito`, `carpeta`,
 * `otorgamiento`, `persona`, `credencial`, `anclaje_identidad` y `medio_pago`.
 * Ese límite lo verifica el test C4 y sólo existe si la conexión es otra.
 * Compartiendo pool con la app, el operador heredaría los permisos de `app_rw`.
 */
export function operadorDb(): Kysely<DB> {
  if (!_operadorDb) {
    const url = process.env.DATABASE_OPERADOR_URL;
    if (!url) {
      throw new Error(
        'DATABASE_OPERADOR_URL no configurado. Es la conexión del rol mifirma_operador; ' +
          'ver db/roles-login.sql.',
      );
    }
    _operadorDb = new Kysely<DB>({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString: url }) }),
    });
  }
  return _operadorDb;
}

/**
 * Ejecuta `fn` con el contexto del realm operador.
 *
 * No lleva cuentaId: el operador no está dentro de ninguna cuenta. Las
 * políticas que lo admiten lo hacen por `app.actor() = 'operador'`, y lo que ve
 * está acotado por los GRANT del rol, no por un filtro de tenant.
 *
 * Tampoco setea `app.identidad_id`: un operador NO es una identidad. Vive en su
 * propia tabla (`operador`, migración 010) y no tiene fila en `identidad`.
 * Ponerlo ahí haría que `app.identidad_actual()` devolviera un uuid inexistente
 * — inofensivo hoy, pero es la clase de detalle que después se lee como si el
 * operador fuera un usuario más y termina en una política escrita mal.
 *
 * `operadorId` se recibe para que quien registre en la bitácora sepa quién
 * actuó; no entra al contexto de la base.
 */
export async function withOperador<T>(
  operadorId: string,
  fn: (trx: Transaction<DB>, operadorId: string) => Promise<T>,
): Promise<T> {
  if (!operadorId) throw new Error('withOperador: operadorId es requerido');

  return operadorDb()
    .transaction()
    .execute(async (trx) => {
      await fijarContexto(trx, { actor: 'operador' });
      return fn(trx, operadorId);
    });
}

export async function cerrarPool(): Promise<void> {
  await db.destroy();
  if (_operadorDb) {
    await _operadorDb.destroy();
    _operadorDb = null;
  }
}
