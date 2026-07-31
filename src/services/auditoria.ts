import type { Transaction } from 'kysely';
import type { DB } from '../db/schema';
import { withUsuario, puede } from '../auth/authz';
import { ownerDb } from '../db/owner';
import { HttpError } from '../http/errors';

// Registro de auditoría. Tres formas de anotar un evento:
//   - registrar(trx, ...)        dentro de una transacción ya abierta (atómico con la acción).
//   - registrarSesion(...)       con sesión de usuario pero sin trx a mano (best-effort).
//   - registrarSistema(...)      eventos pre-sesión como el login (conexión privilegiada, best-effort).
// Las dos variantes best-effort nunca rompen la operación principal si el log falla.

export interface Evento {
  accion: string;
  recurso?: string;
  objetoId?: string;
  detalle?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

function fila(cuentaId: string, usuarioId: string | null, ev: Evento) {
  return {
    cuenta_id: cuentaId,
    usuario_id: usuarioId,
    accion: ev.accion,
    recurso: ev.recurso ?? null,
    objeto_id: ev.objetoId ?? null,
    detalle: ev.detalle === undefined ? null : JSON.stringify(ev.detalle),
    ip: ev.ip ?? null,
    user_agent: ev.userAgent ?? null,
  };
}

export async function registrar(trx: Transaction<DB>, cuentaId: string, usuarioId: string | null, ev: Evento) {
  await trx.insertInto('auditoria').values(fila(cuentaId, usuarioId, ev)).execute();
}

export async function registrarSesion(cuentaId: string, usuarioId: string, ev: Evento) {
  try {
    await withUsuario(cuentaId, usuarioId, (trx) => registrar(trx, cuentaId, usuarioId, ev));
  } catch (e) {
    console.error('auditoria (sesion):', e);
  }
}

export async function registrarSistema(cuentaId: string, usuarioId: string | null, ev: Evento) {
  try {
    await ownerDb().insertInto('auditoria').values(fila(cuentaId, usuarioId, ev)).execute();
  } catch (e) {
    console.error('auditoria (sistema):', e);
  }
}

function parseDetalle(s: string | null) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export async function listarAuditoria(
  cuentaId: string,
  adminUsuarioId: string,
  opts?: { limit?: number },
) {
  const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 500);
  return withUsuario(cuentaId, adminUsuarioId, async (trx, autz) => {
    if (!puede(autz, 'auditoria', 'leer')) throw new HttpError(403, 'No tenés permiso para ver la auditoría.');
    const rows = await trx
      .selectFrom('auditoria as a')
      .leftJoin('usuario as u', 'u.id', 'a.usuario_id')
      .select(['a.id', 'a.creado_at', 'a.accion', 'a.recurso', 'a.objeto_id', 'a.detalle', 'a.ip', 'u.email as usuario_email'])
      .orderBy('a.creado_at', 'desc')
      .limit(limit)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      creado_at: r.creado_at,
      accion: r.accion,
      recurso: r.recurso,
      objeto_id: r.objeto_id,
      ip: r.ip,
      usuario_email: r.usuario_email ?? null,
      detalle: parseDetalle(r.detalle),
    }));
  });
}

// Visor de auditoría a nivel plataforma (consola del operador). Ve todas las
// empresas vía conexión privilegiada. Solo lectura. Filtros opcionales: texto
// libre (email, empresa, acción, IP o detalle), tipo (ingresos = login/OTP/reset),
// y rango de fechas. Nunca expone códigos OTP ni contraseñas (no se guardan).
const ACCIONES_INGRESO = [
  'login.ok',
  'login.fallido',
  'otp.enviado',
  'otp.fallido',
  'password.reset_solicitado',
  'password.reset',
  'push.enviado',
  'push.fallido',
];

export async function listarAuditoriaOperador(opts: {
  q?: string;
  tipo?: 'ingresos' | 'todo';
  desde?: string;
  hasta?: string;
  limit?: number;
}) {
  const limit = Math.min(Math.max(opts.limit ?? 150, 1), 500);
  let qb = ownerDb()
    .selectFrom('auditoria as a')
    .leftJoin('usuario as u', 'u.id', 'a.usuario_id')
    .leftJoin('empresa as e', 'e.id', 'a.cuenta_id')
    .select([
      'a.id as id',
      'a.creado_at as creado_at',
      'a.accion as accion',
      'a.recurso as recurso',
      'a.objeto_id as objeto_id',
      'a.detalle as detalle',
      'a.ip as ip',
      'a.user_agent as user_agent',
      'u.email as usuario_email',
      'e.nombre as empresa_nombre',
    ]);

  if (opts.tipo === 'ingresos') {
    qb = qb.where('a.accion', 'in', ACCIONES_INGRESO);
  }
  if (opts.desde) {
    const d = new Date(opts.desde);
    if (!isNaN(d.getTime())) qb = qb.where('a.creado_at', '>=', d);
  }
  if (opts.hasta) {
    const h = new Date(opts.hasta + 'T23:59:59.999');
    if (!isNaN(h.getTime())) qb = qb.where('a.creado_at', '<=', h);
  }
  const term = (opts.q || '').trim();
  if (term) {
    const like = `%${term}%`;
    qb = qb.where((eb) =>
      eb.or([
        eb('u.email', 'ilike', like),
        eb('e.nombre', 'ilike', like),
        eb('a.accion', 'ilike', like),
        eb('a.ip', 'ilike', like),
        eb('a.detalle', 'ilike', like),
      ]),
    );
  }

  const rows = await qb.orderBy('a.creado_at', 'desc').limit(limit).execute();
  return rows.map((r) => ({
    id: r.id,
    creado_at: r.creado_at,
    empresa_nombre: r.empresa_nombre ?? null,
    usuario_email: r.usuario_email ?? null,
    accion: r.accion,
    ip: r.ip,
    user_agent: r.user_agent,
    detalle: parseDetalle(r.detalle),
  }));
}
