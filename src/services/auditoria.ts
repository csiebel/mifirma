import type { Transaction } from 'kysely';
import type { DB } from '../db/schema';
import { withUsuario, exigir } from '../auth/authz';
import { withTenant, withOperador } from '../db/pool';

/**
 * Bitácora de plataforma: quién hizo qué en la aplicación.
 *
 * ⚠ NO confundir con la evidencia de firma, que es otra cosa y va en otra tabla:
 *
 *   · La EVIDENCIA es lo que ocurrió alrededor de un documento. Inmutable,
 *     encadenada, sellada, y parte del expediente que se entrega en un juicio.
 *     Se conserva por el plazo legal del país.
 *   · La BITÁCORA —esto— es administrativa: asignó un rol, cambió una plantilla,
 *     revocó un otorgamiento, exportó datos. Se retiene por política y se purga.
 *
 * Si algún día alguien escribe un evento de firma acá, la evidencia queda
 * incompleta y nadie se entera hasta el primer litigio.
 *
 * Tres formas de anotar:
 *   registrar(trx, ...)     dentro de una transacción abierta — atómico con la acción.
 *   registrarSesion(...)    con sesión de usuario pero sin trx a mano — best-effort.
 *   registrarSistema(...)   eventos pre-sesión, como el login — best-effort.
 *
 * Las dos best-effort nunca rompen la operación principal si el log falla. Eso
 * es deliberado para el login: un problema de escritura de bitácora no puede
 * dejar a nadie afuera del sistema. Para acciones sensibles —revocar un
 * otorgamiento, exportar datos— usá `registrar` dentro de la misma transacción,
 * y así o quedan las dos cosas o no queda ninguna.
 */

export type ActorTipo = 'usuario' | 'operador' | 'sistema' | 'api';

export interface Evento {
  /** Verbo en punto: 'rol.asignado', 'otorgamiento.revocado', 'documento.exportado'. */
  accion: string;
  recursoTipo: string;
  recursoId?: string | null;
  /**
   * Estado antes y después del cambio.
   *
   * ⚠ Acá NO van datos personales del firmante ni contenido de documentos: van
   * los campos de configuración que cambiaron. La bitácora se purga por
   * política de retención, así que todo lo que se guarde acá es dato que se
   * pierde — y mientras existe, es dato personal que hay que poder explicar.
   */
  antes?: unknown;
  despues?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

function fila(
  cuentaId: string,
  identidadId: string | null,
  actorTipo: ActorTipo,
  ev: Evento,
) {
  return {
    cuenta_id: cuentaId,
    identidad_id: identidadId,
    actor_tipo: actorTipo,
    accion: ev.accion,
    recurso_tipo: ev.recursoTipo,
    recurso_id: ev.recursoId ?? null,
    antes: ev.antes === undefined ? null : JSON.stringify(ev.antes),
    despues: ev.despues === undefined ? null : JSON.stringify(ev.despues),
    ip: ev.ip ?? null,
    user_agent: ev.userAgent ?? null,
  };
}

/** Atómico con la acción que se está registrando. Es la forma preferida. */
export async function registrar(
  trx: Transaction<DB>,
  cuentaId: string,
  identidadId: string | null,
  ev: Evento,
  actorTipo: ActorTipo = 'usuario',
) {
  await trx
    .insertInto('bitacora_plataforma')
    .values(fila(cuentaId, identidadId, actorTipo, ev))
    .execute();
}

export async function registrarSesion(cuentaId: string, identidadId: string, ev: Evento) {
  try {
    await withUsuario(cuentaId, identidadId, (trx) =>
      registrar(trx, cuentaId, identidadId, ev, 'usuario'),
    );
  } catch (e) {
    console.error('bitacora (sesion):', e);
  }
}

/**
 * Eventos sin sesión de usuario: login, OTP, reset de contraseña, jobs.
 *
 * Va por `withTenant`, que fija actor 'sistema'. NO usa una conexión
 * privilegiada: la política de INSERT de la bitácora admite a 'sistema', así
 * que no hace falta evadir RLS para escribir un log — y no evadirla significa
 * que un bug acá tampoco puede escribir en la cuenta equivocada.
 */
export async function registrarSistema(
  cuentaId: string,
  identidadId: string | null,
  ev: Evento,
  actorTipo: ActorTipo = 'sistema',
) {
  try {
    await withTenant(cuentaId, (trx) => registrar(trx, cuentaId, identidadId, ev, actorTipo));
  } catch (e) {
    console.error('bitacora (sistema):', e);
  }
}

// ============================ LECTURA ============================

export interface FiltroBitacora {
  q?: string;
  desde?: string;
  hasta?: string;
  accion?: string;
  recursoTipo?: string;
  limit?: number;
}

/**
 * La bitácora de la propia cuenta.
 *
 * El `exigir` es cortesía: la política de SELECT ya verifica
 * `app.tiene_capacidad('bitacora','leer')` en la base. Sin él, un usuario sin
 * la capacidad vería una lista vacía y creería que no pasó nada nunca.
 */
export async function listarBitacora(
  cuentaId: string,
  identidadId: string,
  opts: FiltroBitacora = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);

  return withUsuario(cuentaId, identidadId, async (trx, autz) => {
    exigir(autz, 'bitacora', 'leer', 'No tenés permiso para ver la bitácora.');

    let qb = trx
      .selectFrom('bitacora_plataforma as b')
      .leftJoin('identidad as i', 'i.id', 'b.identidad_id')
      .select([
        'b.id',
        'b.ocurrido_en',
        'b.actor_tipo',
        'b.accion',
        'b.recurso_tipo',
        'b.recurso_id',
        'b.antes',
        'b.despues',
        'b.ip',
        'i.email_mostrado as usuario_email',
        'i.nombre_mostrado as usuario_nombre',
      ]);

    qb = aplicarFiltros(qb, opts);

    const rows = await qb.orderBy('b.ocurrido_en', 'desc').limit(limit).execute();
    return rows.map(mapear);
  });
}

/**
 * Visor de la consola del operador: todas las cuentas.
 *
 * Corre por el realm operador, cuyo actor es 'operador'. La política de SELECT
 * de la bitácora lo admite sin filtro de cuenta — a diferencia de `archivo`,
 * `instancia` y `participacion`, sobre las que el operador no tiene GRANT
 * (verificado por el test C4). Ve QUÉ se hizo, nunca QUÉ decía el documento.
 */
export async function listarBitacoraOperador(operadorId: string, opts: FiltroBitacora = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 150, 1), 500);

  return withOperador(operadorId, async (trx) => {
    let qb = trx
      .selectFrom('bitacora_plataforma as b')
      .leftJoin('identidad as i', 'i.id', 'b.identidad_id')
      .leftJoin('cuenta as c', 'c.id', 'b.cuenta_id')
      .select([
        'b.id',
        'b.ocurrido_en',
        'b.actor_tipo',
        'b.accion',
        'b.recurso_tipo',
        'b.recurso_id',
        'b.antes',
        'b.despues',
        'b.ip',
        'b.user_agent',
        'i.email_mostrado as usuario_email',
        'i.nombre_mostrado as usuario_nombre',
        'c.nombre_mostrado as cuenta_nombre',
      ]);

    qb = aplicarFiltros(qb, opts);

    const rows = await qb.orderBy('b.ocurrido_en', 'desc').limit(limit).execute();
    return rows.map((r: any) => ({ ...mapear(r), cuenta_nombre: r.cuenta_nombre ?? null }));
  });
}

// ============================ INTERNOS ============================

/**
 * Acciones que responden "quién entró y cuándo", que es el filtro que primero
 * pide cualquier auditoría. Se mantiene como lista y no como prefijo porque
 * `login.` y `otp.` no cubren el reset de contraseña.
 */
export const ACCIONES_INGRESO = [
  'login.ok',
  'login.fallido',
  'otp.enviado',
  'otp.fallido',
  'password.reset_solicitado',
  'password.reset',
  'sesion.cerrada',
  'dispositivo.confiado',
  'dispositivo.revocado',
];

function aplicarFiltros(qb: any, opts: FiltroBitacora) {
  if (opts.accion === 'ingresos') {
    qb = qb.where('b.accion', 'in', ACCIONES_INGRESO);
  } else if (opts.accion) {
    qb = qb.where('b.accion', '=', opts.accion);
  }
  if (opts.recursoTipo) {
    qb = qb.where('b.recurso_tipo', '=', opts.recursoTipo);
  }
  if (opts.desde) {
    const d = new Date(opts.desde);
    if (!isNaN(d.getTime())) qb = qb.where('b.ocurrido_en', '>=', d);
  }
  if (opts.hasta) {
    // Fin de día inclusivo: quien filtra "hasta el 5" espera que entre lo del 5.
    const h = new Date(opts.hasta + 'T23:59:59.999');
    if (!isNaN(h.getTime())) qb = qb.where('b.ocurrido_en', '<=', h);
  }
  const term = (opts.q || '').trim();
  if (term) {
    const like = `%${term}%`;
    qb = qb.where((eb: any) =>
      eb.or([
        eb('i.email_mostrado', 'ilike', like),
        eb('i.nombre_mostrado', 'ilike', like),
        eb('b.accion', 'ilike', like),
        eb('b.recurso_tipo', 'ilike', like),
        eb(eb.cast(eb.ref('b.ip'), 'text'), 'ilike', like),
      ]),
    );
  }
  return qb;
}

function mapear(r: any) {
  return {
    id: r.id,
    ocurrido_en: r.ocurrido_en,
    actor_tipo: r.actor_tipo,
    accion: r.accion,
    recurso_tipo: r.recurso_tipo,
    recurso_id: r.recurso_id,
    ip: r.ip,
    user_agent: r.user_agent ?? null,
    usuario_email: r.usuario_email ?? null,
    usuario_nombre: r.usuario_nombre ?? null,
    antes: r.antes ?? null,
    despues: r.despues ?? null,
  };
}
