import { sql, type Transaction } from 'kysely';
import { db } from '../db/pool';
import type { DB, AlcanceDato } from '../db/schema';

// Amplitud relativa de los alcances (para quedarse con el más amplio del usuario).
const RANGO: Record<AlcanceDato, number> = { propio: 1, equipo: 2, area: 3, empresa: 4 };

export interface ContextoAutz {
  relacionPropia: string | null;
  alcances: Map<string, AlcanceDato>; // recurso -> alcance más amplio para 'leer'
  alcancesEscritura: Map<string, AlcanceDato>; // recurso -> alcance más amplio para 'escribir'
  capacidades: Set<string>; // 'recurso:accion' permitidos
}

/**
 * Resuelve los permisos del usuario y FIJA el contexto de autorización en la
 * sesión (las GUCs que consume RLS para el alcance jerárquico). Se llama dentro
 * de una transacción que ya tiene el contexto de empresa puesto.
 */
export async function cargarContextoAutorizacion(
  trx: Transaction<DB>,
  usuarioId: string,
): Promise<ContextoAutz> {
  // 1. Relación propia del usuario (su legajo como empleado), si tiene una.
  const usuario = await trx
    .selectFrom('usuario')
    .select(['persona_id'])
    .where('id', '=', usuarioId)
    .executeTakeFirst();

  let relacionPropia: string | null = null;
  if (usuario?.persona_id) {
    const rel = await trx
      .selectFrom('relacion_laboral')
      .select(['id'])
      .where('persona_id', '=', usuario.persona_id)
      .orderBy('fecha_ingreso', 'desc')
      .executeTakeFirst();
    relacionPropia = rel?.id ?? null;
  }

  // 2. Capacidades del usuario (roles -> capacidades).
  const caps = await trx
    .selectFrom('usuario_rol')
    .innerJoin('capacidad', 'capacidad.rol_id', 'usuario_rol.rol_id')
    .select(['capacidad.recurso', 'capacidad.accion', 'capacidad.alcance'])
    .where('usuario_rol.usuario_id', '=', usuarioId)
    .execute();

  const alcances = new Map<string, AlcanceDato>();
  const alcancesEscritura = new Map<string, AlcanceDato>();
  const capacidades = new Set<string>();
  for (const c of caps) {
    capacidades.add(`${c.recurso}:${c.accion}`);
    const destino = c.accion === 'leer' ? alcances : c.accion === 'escribir' ? alcancesEscritura : null;
    if (destino) {
      const actual = destino.get(c.recurso);
      if (!actual || RANGO[c.alcance] > RANGO[actual]) destino.set(c.recurso, c.alcance);
    }
  }

  // 3. Relaciones supervisadas (subárbol jerárquico), una sola vez.
  let supervisadas: string[] = [];
  if (relacionPropia) {
    const filas = await sql<{ relacion_id: string }>`
      SELECT relacion_id FROM app.relaciones_supervisadas(${relacionPropia}::uuid)
    `.execute(trx);
    supervisadas = filas.rows.map((r) => r.relacion_id);
  }

  // 4. Fijar el contexto en la sesión (transacción) para RLS.
  await sql`select set_config('app.current_relacion_id', ${relacionPropia ?? ''}, true)`.execute(trx);
  await sql`select set_config('app.relaciones_supervisadas', ${supervisadas.join(',')}, true)`.execute(trx);
  // Alcance por recurso (los recursos sin GUC quedan fail-closed en modo usuario).
  for (const [recurso, alcance] of alcances) {
    await sql`select set_config(${`app.alcance_${recurso}`}, ${alcance}, true)`.execute(trx);
  }

  return { relacionPropia, alcances, alcancesEscritura, capacidades };
}

/** Gate de RBAC (en la app): ¿el usuario tiene la capacidad (recurso, accion)? */
export function puede(ctx: ContextoAutz, recurso: string, accion: string): boolean {
  return ctx.capacidades.has(`${recurso}:${accion}`);
}

/**
 * ¿Puede el usuario ver los montos de un recibo? Campo sensible (sección 11, "el
 * sueldo según política"): qué recibos ve lo decide recibo:leer + alcance (RLS);
 * si además ve los importes lo decide la capacidad recibo:ver_monto. El recibo
 * propio siempre muestra sus montos. Fail-closed: por defecto, oculto.
 */
export function puedeVerMontosRecibo(ctx: ContextoAutz, relacionId: string): boolean {
  if (puede(ctx, 'recibo', 'ver_monto')) return true;
  if (ctx.relacionPropia && ctx.relacionPropia === relacionId) return true;
  return false;
}

/**
 * ¿Puede el usuario ver el RESULTADO de una evaluación en detalle? Campo sensible
 * (secciones 10 y 11): qué evaluaciones ve lo decide evaluacion:leer + alcance
 * (RLS); si además ve el resultado, lo decide la capacidad evaluacion:ver_detalle.
 * La evaluación propia siempre muestra su resultado. Fail-closed: por defecto, oculto.
 */
export function puedeVerDetalleEvaluacion(ctx: ContextoAutz, relacionId: string): boolean {
  if (puede(ctx, 'evaluacion', 'ver_detalle')) return true;
  if (ctx.relacionPropia && ctx.relacionPropia === relacionId) return true;
  return false;
}

/**
 * ¿Puede el usuario ver los documentos SENSIBLES del legajo (su tipo y su
 * referencia)? Qué legajos ve lo decide legajo:leer + alcance (RLS/app); si además
 * ve el contenido de los marcados como sensibles, lo decide la capacidad
 * legajo:ver_detalle. El legajo propio siempre se ve. Fail-closed: por defecto, oculto.
 */
export function puedeVerLegajoSensible(ctx: ContextoAutz, relacionId: string): boolean {
  if (puede(ctx, 'legajo', 'ver_detalle')) return true;
  if (ctx.relacionPropia && ctx.relacionPropia === relacionId) return true;
  return false;
}

/**
 * Alcance de ESCRITURA de un recurso: el declarado en sus capacidades de
 * escritura; si no hay, espeja el de lectura del mismo recurso; en última
 * instancia 'propio' (lo más restrictivo).
 */
export function alcanceEscritura(ctx: ContextoAutz, recurso: string): AlcanceDato {
  return ctx.alcancesEscritura.get(recurso) ?? ctx.alcances.get(recurso) ?? 'propio';
}

/**
 * El alcance de lectura más amplio que el usuario tiene sobre cualquier recurso.
 * Sirve como "a quién puede ver" para listar empleados: no existe un recurso
 * 'empleado:leer', la visibilidad de personas deriva de los datos que ya ve
 * (recibo, evaluación, etc.). Un jefe -> 'area', un admin -> 'empresa'.
 */
export function alcanceMaximoLectura(ctx: ContextoAutz): AlcanceDato {
  let best: AlcanceDato = 'propio';
  for (const a of ctx.alcances.values()) if (RANGO[a] > RANGO[best]) best = a;
  return best;
}

/**
 * ¿La relación objetivo cae dentro de un alcance dado? Usa la MISMA función SQL
 * que el RLS. Sirve para validar la escritura en la capa de app: el WITH CHECK
 * del RLS de RRHH es solo por empresa, así que el "quién escribe sobre quién"
 * se chequea acá.
 */
export async function relacionEnAlcance(
  trx: Transaction<DB>,
  relacionId: string,
  alcance: AlcanceDato,
): Promise<boolean> {
  const r = await sql<{ ok: boolean }>`
    SELECT app.visible_por_alcance(${relacionId}::uuid, ${alcance}) AS ok
  `.execute(trx);
  return r.rows[0]?.ok === true;
}

/** Igual que relacionEnAlcance pero para entidades ancladas en persona (legajo,
 * estudios): la persona es visible si alguna de sus relaciones lo es. */
export async function personaEnAlcance(
  trx: Transaction<DB>,
  personaId: string,
  alcance: AlcanceDato,
): Promise<boolean> {
  const r = await sql<{ ok: boolean }>`
    SELECT app.persona_visible(${personaId}::uuid, ${alcance}) AS ok
  `.execute(trx);
  return r.rows[0]?.ok === true;
}

/**
 * Ejecuta `fn` con el contexto de EMPRESA + USUARIO puesto. Es el wrapper para
 * peticiones de usuario (a diferencia de withTenant, que es modo sistema y se
 * usa para procesos como la corrida). cuentaId y usuarioId vienen del token.
 */
export async function withUsuario<T>(
  cuentaId: string,
  usuarioId: string,
  fn: (trx: Transaction<DB>, autz: ContextoAutz) => Promise<T>,
): Promise<T> {
  if (!cuentaId || !usuarioId) throw new Error('withUsuario: cuentaId y usuarioId requeridos');
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.cuenta_id', ${cuentaId}, true)`.execute(trx);
    const autz = await cargarContextoAutorizacion(trx, usuarioId);
    return fn(trx, autz);
  });
}

/**
 * Contexto de sesión de un ESTUDIO (panel del contador, sin empresa activa todavía).
 * Fija app.current_estudio_id para que el RLS del módulo deje ver la cartera del
 * estudio. Cuando el contador elige una empresa de su cartera, esa request usa
 * withUsuario con la empresa elegida (el RLS de negocio opera igual que siempre).
 */
export async function withEstudio<T>(
  estudioId: string,
  fn: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  if (!estudioId) throw new Error('withEstudio: estudioId requerido');
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.current_estudio_id', ${estudioId}, true)`.execute(trx);
    return fn(trx);
  });
}
