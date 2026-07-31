import { ownerDb } from '../db/owner';
import { hashPassword, verifyPassword, validarPassword } from '../auth/password';
import { registrarSistema } from './auditoria';
import { HttpError } from '../http/errors';

// Cambio de la propia contraseña por un usuario autenticado de la empresa.
// Es self-scoped: sólo afecta al usuario del token (id + empresa del token), así
// que no necesita permiso de admin. Pide la contraseña actual (reautenticación)
// para que una sesión robada no pueda cambiarla. Usa ownerDb porque toca
// credenciales del propio usuario, acotando por id y empresa de forma explícita.
export async function cambiarMiPassword(
  cuentaId: string,
  usuarioId: string,
  actual: unknown,
  nueva: unknown,
) {
  if (typeof actual !== 'string' || typeof nueva !== 'string') {
    throw new HttpError(400, 'Faltan datos.');
  }
  const err = validarPassword(nueva);
  if (err) throw new HttpError(400, err);

  const db = ownerDb();
  const u = await db
    .selectFrom('usuario')
    .select(['id', 'password_hash'])
    .where('id', '=', usuarioId)
    .where('cuenta_id', '=', cuentaId)
    .executeTakeFirst();
  if (!u) throw new HttpError(404, 'Usuario no encontrado.');
  if (!u.password_hash) {
    throw new HttpError(400, 'Tu cuenta todavía no tiene contraseña. Usá "¿Olvidaste tu contraseña?" para crear una.');
  }
  if (!verifyPassword(actual, u.password_hash)) {
    throw new HttpError(400, 'La contraseña actual no es correcta.');
  }
  if (verifyPassword(nueva, u.password_hash)) {
    throw new HttpError(400, 'La nueva contraseña debe ser distinta de la actual.');
  }

  await db
    .updateTable('usuario')
    .set({ password_hash: hashPassword(nueva), password_actualizado: new Date() })
    .where('id', '=', usuarioId)
    .where('cuenta_id', '=', cuentaId)
    .execute();
  await registrarSistema(cuentaId, usuarioId, {
    accion: 'usuario.cambiar_password',
    recurso: 'usuario',
    objetoId: usuarioId,
  });
  return { ok: true };
}
