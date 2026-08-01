import type { Transaction } from 'kysely';
import { fijarContexto, type ContextoRls, type NivelGarantia } from '../db/contexto';
import { db } from '../db/pool';
import type { DB } from '../db/schema';
import { HttpError } from '../http/errors';

/**
 * Autorización del lado de la aplicación.
 *
 * ⚠ LEER ESTO ANTES DE AGREGAR UN CHEQUEO ACÁ
 *
 * La autorización de MiFirma vive en la capa de datos: las políticas RLS de
 * PostgreSQL. Una consulta sin contexto no devuelve una fila, y una consulta con
 * el contexto de la cuenta A no ve nada de la cuenta B — aunque el código de la
 * aplicación se equivoque, aunque un endpoint tenga un bug, aunque haya una
 * inyección.
 *
 * Lo que hay en este archivo NO es la autorización. Es la capa de cortesía:
 * sirve para devolver un 403 con un mensaje entendible en vez de una lista
 * vacía inexplicable. Si alguna vez `puede()` dice que sí y la RLS dice que no,
 * gana la RLS y el bug está acá.
 *
 * Corolario práctico: NUNCA reemplazar una política RLS por un chequeo de este
 * archivo, ni "optimizar" una consulta salteando `withUsuario`.
 *
 * Qué se fue de la versión de Payroll NG y por qué:
 * el modelo de alcances (`propio` / `equipo` / `area` / `empresa`) colgaba de
 * `relacion_laboral` y del organigrama, que son dominio de RRHH. En MiFirma
 * quién ve qué documento lo deciden las CARPETAS (permiso por rol, migración
 * 005) y los OTORGAMIENTOS (migración 008). No hay jerarquía de personas.
 */

export interface ContextoAutz {
  cuentaId: string;
  identidadId: string;
  /** 'recurso:accion' — el catálogo está en la tabla `capacidad` (migración 004). */
  capacidades: Set<string>;
}

/**
 * Carga las capacidades del usuario en la cuenta activa.
 *
 * Es la misma consulta que hace `app.tiene_capacidad()` dentro de las políticas
 * RLS. Duplicarla acá es a propósito: la política decide, esto sólo permite
 * anticipar la respuesta para dar un error decente.
 */
export async function cargarContextoAutorizacion(
  trx: Transaction<DB>,
  cuentaId: string,
  identidadId: string,
): Promise<ContextoAutz> {
  const filas = await trx
    .selectFrom('usuario_rol as ur')
    .innerJoin('rol_capacidad as rc', 'rc.rol_id', 'ur.rol_id')
    .innerJoin('capacidad as c', 'c.id', 'rc.capacidad_id')
    .select(['c.recurso', 'c.accion'])
    .where('ur.identidad_id', '=', identidadId)
    .where('ur.cuenta_id', '=', cuentaId)
    .execute();

  const capacidades = new Set<string>();
  for (const f of filas) capacidades.add(`${f.recurso}:${f.accion}`);

  return { cuentaId, identidadId, capacidades };
}

/** ¿Tiene la capacidad (recurso, accion)? Fail-closed: lo que no está, no se puede. */
export function puede(ctx: ContextoAutz, recurso: string, accion: string): boolean {
  return ctx.capacidades.has(`${recurso}:${accion}`);
}

/**
 * Igual que `puede`, pero corta con 403. Evita el patrón repetido de
 * `if (!puede(...)) throw new HttpError(403, ...)` en cada servicio, que es
 * donde se olvida el chequeo.
 */
export function exigir(ctx: ContextoAutz, recurso: string, accion: string, mensaje?: string): void {
  if (!puede(ctx, recurso, accion)) {
    throw new HttpError(403, mensaje ?? `No tenés permiso para ${accion} ${recurso}.`);
  }
}

/** Datos de la sesión que viajan al contexto RLS. Vienen del token, no del cliente. */
export interface DatosSesion {
  /** Anclajes efectivamente probados en ESTA sesión. Ver 003 y `app.anclajes_probados()`. */
  anclajesProbados?: string[];
  /**
   * Nivel de garantía de la SESIÓN, no de la identidad: la misma persona puede
   * entrar hoy con contraseña (bajo) y mañana con certificado (alto).
   */
  nivelGarantia?: NivelGarantia;
  idioma?: string;
}

/**
 * Ejecuta `fn` con el contexto de cuenta + identidad puesto, dentro de una
 * transacción. Es el envoltorio de toda petición de usuario autenticado.
 *
 * `cuentaId` e `identidadId` salen del token verificado. Nunca de un parámetro
 * de la request: eso sería dejar que el cliente elija en qué cuenta entra.
 */
export async function withUsuario<T>(
  cuentaId: string,
  identidadId: string,
  fn: (trx: Transaction<DB>, autz: ContextoAutz) => Promise<T>,
  sesion?: DatosSesion,
): Promise<T> {
  if (!cuentaId || !identidadId) {
    throw new Error('withUsuario: cuentaId e identidadId son requeridos');
  }
  return db.transaction().execute(async (trx) => {
    const ctx: ContextoRls = {
      actor: 'cuenta',
      cuentaId,
      identidadId,
      anclajesProbados: sesion?.anclajesProbados,
      // 'bajo' es el piso de una sesión autenticada con contraseña. Subirlo por
      // defecto haría que los otorgamientos que exigen nivel alto se abran con
      // sólo iniciar sesión.
      nivelGarantia: sesion?.nivelGarantia ?? 'bajo',
      idioma: sesion?.idioma,
    };
    await fijarContexto(trx, ctx);
    const autz = await cargarContextoAutorizacion(trx, cuentaId, identidadId);
    return fn(trx, autz);
  });
}
