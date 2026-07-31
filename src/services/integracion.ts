import { randomBytes, createHash } from 'node:crypto';
import { withTenant } from '../db/pool';
import { ownerDb } from '../db/owner';
import { withUsuario, puede } from '../auth/authz';
import { HttpError } from '../http/errors';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// ---- Gestión de tokens (con identidad de admin) ----

/** Crea un token de servicio para la empresa. Devuelve el valor en claro UNA vez. */
export async function crearApiToken(cuentaId: string, usuarioId: string, nombre: string) {
  return withUsuario(cuentaId, usuarioId, async (trx, autz) => {
    if (!puede(autz, 'usuario', 'escribir')) {
      throw new HttpError(403, 'Solo un administrador puede crear tokens de integración.');
    }
    const token = 'png_' + randomBytes(24).toString('hex');
    const fila = await trx
      .insertInto('api_token')
      .values({
        cuenta_id: cuentaId,
        nombre,
        token_sha256: sha256(token),
        prefijo: token.slice(0, 12),
      })
      .returning(['id', 'prefijo'])
      .executeTakeFirstOrThrow();
    // El token en claro se devuelve una sola vez; después solo queda el hash.
    return { id: fila.id, nombre, token, prefijo: fila.prefijo };
  });
}

export async function listarApiTokens(cuentaId: string, usuarioId: string) {
  return withUsuario(cuentaId, usuarioId, async (trx, autz) => {
    if (!puede(autz, 'usuario', 'escribir')) {
      throw new HttpError(403, 'Solo un administrador puede ver los tokens de integración.');
    }
    const tokens = await trx
      .selectFrom('api_token')
      .select(['id', 'nombre', 'prefijo', 'activa', 'created_at', 'last_used_at'])
      .orderBy('created_at desc')
      .execute();
    return { tokens };
  });
}

export async function revocarApiToken(cuentaId: string, usuarioId: string, id: string) {
  return withUsuario(cuentaId, usuarioId, async (trx, autz) => {
    if (!puede(autz, 'usuario', 'escribir')) {
      throw new HttpError(403, 'Solo un administrador puede revocar tokens de integración.');
    }
    await trx.updateTable('api_token').set({ activa: false }).where('id', '=', id).execute();
    return { id, activa: false };
  });
}

// ---- Ingesta de asistencia (con token de servicio) ----

/**
 * Resuelve un token de servicio (Bearer) a su empresa. Usa la conexión owner porque
 * todavía no se conoce la empresa (la búsqueda es por hash entre todos los tenants).
 * Devuelve el cuenta_id si el token existe y está activo; si no, null.
 */
export async function resolverEmpresaPorToken(token: string): Promise<string | null> {
  if (!token) return null;
  const db = ownerDb();
  const fila = await db
    .selectFrom('api_token')
    .select(['id', 'cuenta_id'])
    .where('token_sha256', '=', sha256(token))
    .where('activa', '=', true)
    .executeTakeFirst();
  if (!fila) return null;
  await db.updateTable('api_token').set({ last_used_at: new Date().toISOString() }).where('id', '=', fila.id).execute();
  return fila.cuenta_id;
}

// Campos de asistencia que acepta la ingesta y a qué tipo de novedad mapean.
const CAMPOS_NOVEDAD: Record<string, string> = {
  dias_trabajados: 'dias_trabajados',
  faltas: 'falta',
  tardanza_min: 'tardanza_min',
  horas_descuento: 'horas_descuento',
  horas_extra: 'hora_extra',
};

export interface ItemAsistencia {
  relacion_id?: string;
  documento?: string;
  dias_trabajados?: number;
  faltas?: number;
  tardanza_min?: number;
  horas_descuento?: number;
  horas_extra?: number;
}

/**
 * Ingesta de asistencia de un período para varios empleados. Cada métrica se guarda
 * como una NOVEDAD del período (relacion, periodo, tipo, cantidad). Es idempotente:
 * re-enviar el mismo período reemplaza los valores de esos tipos (no acumula), así un
 * reloj puede reenviar sin duplicar. La identificación es por relacion_id o documento.
 *
 * Las novedades alimentan al motor (faltas/tardanzas/horas descuentan; días trabajados
 * prorratea). La autorización es por empresa: el token solo escribe en SU empresa.
 */
export async function ingestarAsistencia(cuentaId: string, periodo: string, items: ItemAsistencia[]) {
  if (!/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(periodo)) {
    throw new HttpError(400, `Período inválido: ${periodo} (esperado YYYY-MM)`);
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new HttpError(400, 'No hay items de asistencia.');
  }

  return withTenant(cuentaId, async (trx) => {
    let procesados = 0;
    const noEncontrados: string[] = [];

    for (const item of items) {
      // Doble conteo: días trabajados ya contempla la ausencia; no se combina con faltas.
      if (item.dias_trabajados !== undefined && item.faltas !== undefined) {
        throw new HttpError(400, 'Un item no puede traer dias_trabajados y faltas a la vez (se duplicaría el descuento).');
      }

      // Resolver la relación: por id explícito o por documento del empleado.
      let relacionId = item.relacion_id ?? null;
      if (!relacionId && item.documento) {
        const rel = await trx
          .selectFrom('relacion_laboral as rl')
          .innerJoin('persona as p', 'p.id', 'rl.persona_id')
          .select(['rl.id as id'])
          .where('p.documento', '=', item.documento)
          .where('rl.fecha_egreso', 'is', null)
          .orderBy('rl.fecha_ingreso desc')
          .executeTakeFirst();
        relacionId = rel?.id ?? null;
      }
      if (!relacionId) {
        noEncontrados.push(item.documento ?? item.relacion_id ?? '(sin id)');
        continue;
      }

      // Por cada métrica informada: reemplaza la novedad de ese tipo para el período.
      for (const [campo, tipo] of Object.entries(CAMPOS_NOVEDAD)) {
        const valor = (item as Record<string, number | undefined>)[campo];
        if (valor === undefined) continue;
        if (typeof valor !== 'number' || valor < 0) {
          throw new HttpError(400, `Valor inválido para ${campo} (debe ser un número >= 0).`);
        }
        await trx
          .deleteFrom('novedad')
          .where('relacion_id', '=', relacionId)
          .where('periodo', '=', periodo)
          .where('tipo', '=', tipo)
          .execute();
        await trx
          .insertInto('novedad')
          .values({ cuenta_id: cuentaId, relacion_id: relacionId, periodo, tipo, cantidad: String(valor) })
          .execute();
      }
      procesados++;
    }

    return { periodo, procesados, no_encontrados: noEncontrados };
  });
}
