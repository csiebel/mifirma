import { withUsuario, puede, type ContextoAutz } from '../auth/authz';
import { enviarInvitacionPorCorreo } from './auth_reset';
import { registrar } from './auditoria';
import { HttpError } from '../http/errors';

function gate(autz: ContextoAutz) {
  if (!puede(autz, 'usuario', 'escribir')) throw new HttpError(403, 'No tenés permiso para gestionar accesos.');
}

/**
 * Gestión de accesos (cuentas de usuario). Es tarea de admin: el documento le
 * asigna "configurar usuarios, roles y estructura". Gateado por usuario:escribir.
 * Dar de alta un empleado crea la persona y su relación; ESTO crea la cuenta con
 * la que esa persona ingresa, y le asigna un rol (que define qué puede ver y
 * sobre quién). El login es por email, así que el email es la credencial.
 */

// Roles de la empresa (para elegir al dar acceso).
export async function listarRoles(cuentaId: string, usuarioId: string) {
  return withUsuario(cuentaId, usuarioId, async (trx, autz) => {
    if (!puede(autz, 'usuario', 'escribir'))
      throw new HttpError(403, 'No tenés permiso para gestionar accesos.');
    return trx.selectFrom('rol').select(['id', 'nombre']).orderBy('nombre').execute();
  });
}

export interface CrearAccesoInput {
  relacionId: string; // el empleado (de ahí se deriva la persona)
  email: string;
  rolId: string;
  vincular?: boolean; // si el email ya tiene cuenta, confirmar que se reasigne a este empleado
}
export async function crearAcceso(cuentaId: string, usuarioId: string, input: CrearAccesoInput) {
  const r = await withUsuario(cuentaId, usuarioId, async (trx, autz) => {
    gate(autz);

    // Persona detrás del empleado.
    const rel = await trx
      .selectFrom('relacion_laboral')
      .select(['persona_id'])
      .where('id', '=', input.relacionId)
      .executeTakeFirst();
    if (!rel) throw new HttpError(404, 'No encontré ese empleado en tu empresa.');

    // El rol tiene que ser de esta empresa (RLS ya filtra, pero validamos claro).
    const rol = await trx.selectFrom('rol').select(['id']).where('id', '=', input.rolId).executeTakeFirst();
    if (!rol) throw new HttpError(400, 'Ese rol no existe en tu empresa.');

    // Una persona, una cuenta; y el email no puede repetirse en la empresa.
    const yaPersona = await trx
      .selectFrom('usuario')
      .select(['id'])
      .where('persona_id', '=', rel.persona_id)
      .executeTakeFirst();
    if (yaPersona) throw new HttpError(409, 'Ese empleado ya tiene una cuenta de acceso.');
    const existente = await trx
      .selectFrom('usuario')
      .select(['id', 'persona_id'])
      .where('email', '=', input.email)
      .executeTakeFirst();
    if (existente) {
      // El email ya tiene cuenta. Si el admin no confirmó, avisamos para que la consola
      // ofrezca el botón de vincular (no tocamos nada todavía).
      if (!input.vincular) {
        return { necesitaVincular: true as const, email: input.email };
      }
      // Salvaguarda: no le sacamos la cuenta a otro empleado activo distinto.
      if (existente.persona_id && existente.persona_id !== rel.persona_id) {
        const otroActivo = await trx
          .selectFrom('relacion_laboral')
          .select(['id'])
          .where('persona_id', '=', existente.persona_id)
          .where('fecha_egreso', 'is', null)
          .executeTakeFirst();
        if (otroActivo) throw new HttpError(409, 'Ese email pertenece a la cuenta de otro empleado activo. Usá otro email.');
      }
      // Vincular: la cuenta existente pasa a ser la de este empleado y recibe el rol.
      await trx.updateTable('usuario').set({ persona_id: rel.persona_id }).where('id', '=', existente.id).execute();
      const tieneRol = await trx
        .selectFrom('usuario_rol')
        .select(['rol_id'])
        .where('usuario_id', '=', existente.id)
        .where('rol_id', '=', input.rolId)
        .executeTakeFirst();
      if (!tieneRol) {
        await trx.insertInto('usuario_rol').values({ cuenta_id: cuentaId, usuario_id: existente.id, rol_id: input.rolId }).execute();
      }
      await registrar(trx, cuentaId, usuarioId, { accion: 'usuario.vincular_acceso', recurso: 'usuario', objetoId: existente.id, detalle: { email: input.email, rol_id: input.rolId } });
      return { usuarioId: existente.id, email: input.email, vinculado: true as const };
    }

    // Crear la cuenta y asignarle el rol.
    const u = await trx
      .insertInto('usuario')
      .values({ cuenta_id: cuentaId, persona_id: rel.persona_id, email: input.email })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('usuario_rol')
      .values({ cuenta_id: cuentaId, usuario_id: u.id, rol_id: input.rolId })
      .execute();

    await registrar(trx, cuentaId, usuarioId, { accion: 'usuario.crear_acceso', recurso: 'usuario', objetoId: u.id, detalle: { email: input.email, rol_id: input.rolId } });
    return { usuarioId: u.id, email: input.email };
  });
  // Si el email ya tenía cuenta y falta confirmar, devolvemos el aviso sin enviar nada.
  if ('necesitaVincular' in r) return r;
  // Invitación por correo para que elija su contraseña (cuenta nueva o recién vinculada).
  await enviarInvitacionPorCorreo(cuentaId, r.usuarioId, r.email, input.rolId);
  return r;
}

// ---- Panel del admin: listar y gestionar usuarios y sus roles ----
export interface UsuarioListado {
  usuario_id: string;
  email: string;
  nombre: string | null;
  activo: boolean;
  tiene_password: boolean;
  telefono: string | null;
  canal_otp: string;
  roles: { rol_id: string; nombre: string }[];
}

export async function listarUsuarios(cuentaId: string, adminUsuarioId: string): Promise<UsuarioListado[]> {
  return withUsuario(cuentaId, adminUsuarioId, async (trx, autz) => {
    gate(autz);
    const usuarios = await trx
      .selectFrom('usuario as u')
      .leftJoin('persona as p', 'p.id', 'u.persona_id')
      .select(['u.id as usuario_id', 'u.email as email', 'u.activo as activo', 'u.password_hash as password_hash', 'u.telefono as telefono', 'u.canal_otp as canal_otp', 'p.nombre as nombre'])
      .orderBy('u.email')
      .execute();
    const roles = await trx
      .selectFrom('usuario_rol as ur')
      .innerJoin('rol as r', 'r.id', 'ur.rol_id')
      .select(['ur.usuario_id as usuario_id', 'r.id as rol_id', 'r.nombre as rol_nombre'])
      .execute();
    const porUsuario = new Map<string, { rol_id: string; nombre: string }[]>();
    for (const r of roles) {
      const a = porUsuario.get(r.usuario_id) || [];
      a.push({ rol_id: r.rol_id, nombre: r.rol_nombre });
      porUsuario.set(r.usuario_id, a);
    }
    return usuarios.map((u) => ({
      usuario_id: u.usuario_id,
      email: u.email,
      nombre: u.nombre ?? null,
      activo: u.activo,
      tiene_password: !!u.password_hash,
      telefono: u.telefono ?? null,
      canal_otp: u.canal_otp,
      roles: porUsuario.get(u.usuario_id) || [],
    }));
  });
}

export async function asignarRol(cuentaId: string, adminUsuarioId: string, objetivoId: string, rolId: string) {
  return withUsuario(cuentaId, adminUsuarioId, async (trx, autz) => {
    gate(autz);
    const u = await trx.selectFrom('usuario').select('id').where('id', '=', objetivoId).executeTakeFirst();
    if (!u) throw new HttpError(404, 'Usuario no encontrado.');
    const rol = await trx.selectFrom('rol').select('id').where('id', '=', rolId).executeTakeFirst();
    if (!rol) throw new HttpError(404, 'Rol no encontrado.');
    const ya = await trx
      .selectFrom('usuario_rol')
      .select('usuario_id')
      .where('usuario_id', '=', objetivoId)
      .where('rol_id', '=', rolId)
      .executeTakeFirst();
    if (!ya) {
      await trx.insertInto('usuario_rol').values({ cuenta_id: cuentaId, usuario_id: objetivoId, rol_id: rolId }).execute();
    }
    await registrar(trx, cuentaId, adminUsuarioId, { accion: 'usuario.asignar_rol', recurso: 'usuario', objetoId: objetivoId, detalle: { rol_id: rolId } });
    return { ok: true };
  });
}

export async function quitarRol(cuentaId: string, adminUsuarioId: string, objetivoId: string, rolId: string) {
  return withUsuario(cuentaId, adminUsuarioId, async (trx, autz) => {
    gate(autz);
    if (objetivoId === adminUsuarioId) {
      const rol = await trx.selectFrom('rol').select(['protegido']).where('id', '=', rolId).executeTakeFirst();
      if (rol && rol.protegido) throw new HttpError(400, 'No podés quitarte a vos mismo un rol protegido.');
    }
    await trx.deleteFrom('usuario_rol').where('usuario_id', '=', objetivoId).where('rol_id', '=', rolId).execute();
    await registrar(trx, cuentaId, adminUsuarioId, { accion: 'usuario.quitar_rol', recurso: 'usuario', objetoId: objetivoId, detalle: { rol_id: rolId } });
    return { ok: true };
  });
}

export async function setActivoUsuario(cuentaId: string, adminUsuarioId: string, objetivoId: string, activo: boolean) {
  return withUsuario(cuentaId, adminUsuarioId, async (trx, autz) => {
    gate(autz);
    if (objetivoId === adminUsuarioId && !activo) {
      throw new HttpError(400, 'No podés inhabilitar tu propio usuario.');
    }
    const u = await trx.selectFrom('usuario').select('id').where('id', '=', objetivoId).executeTakeFirst();
    if (!u) throw new HttpError(404, 'Usuario no encontrado.');
    await trx.updateTable('usuario').set({ activo }).where('id', '=', objetivoId).execute();
    await registrar(trx, cuentaId, adminUsuarioId, { accion: 'usuario.activo', recurso: 'usuario', objetoId: objetivoId, detalle: { activo } });
    return { ok: true, activo };
  });
}

export async function setCanalOtpUsuario(
  cuentaId: string,
  adminUsuarioId: string,
  objetivoId: string,
  telefono: string | null,
  canal: string,
) {
  return withUsuario(cuentaId, adminUsuarioId, async (trx, autz) => {
    gate(autz);
    if (!['email', 'sms', 'whatsapp'].includes(canal)) {
      throw new HttpError(400, 'Canal de OTP inválido.');
    }
    const tel = telefono && telefono.trim() ? telefono.trim() : null;
    if ((canal === 'sms' || canal === 'whatsapp') && !tel) {
      throw new HttpError(400, 'Para SMS o WhatsApp hace falta cargar un teléfono.');
    }
    if (tel && !/^\+?[0-9]{6,15}$/.test(tel.replace(/[\s-]/g, ''))) {
      throw new HttpError(400, 'Teléfono inválido. Usá formato internacional (ej. +59899123456).');
    }
    const u = await trx.selectFrom('usuario').select('id').where('id', '=', objetivoId).executeTakeFirst();
    if (!u) throw new HttpError(404, 'Usuario no encontrado.');
    await trx.updateTable('usuario').set({ telefono: tel, canal_otp: canal }).where('id', '=', objetivoId).execute();
    await registrar(trx, cuentaId, adminUsuarioId, {
      accion: 'usuario.canal_otp',
      recurso: 'usuario',
      objetoId: objetivoId,
      detalle: { canal, tiene_telefono: !!tel },
    });
    return { ok: true, canal, telefono: tel };
  });
}

export async function reenviarInvitacion(cuentaId: string, adminUsuarioId: string, objetivoId: string) {
  const email = await withUsuario(cuentaId, adminUsuarioId, async (trx, autz) => {
    gate(autz);
    const u = await trx.selectFrom('usuario').select(['email']).where('id', '=', objetivoId).executeTakeFirst();
    if (!u) throw new HttpError(404, 'Usuario no encontrado.');
    await registrar(trx, cuentaId, adminUsuarioId, { accion: 'usuario.reinvitar', recurso: 'usuario', objetoId: objetivoId });
    return u.email;
  });
  await enviarInvitacionPorCorreo(cuentaId, objetivoId, email);
  return { ok: true, email };
}
