import { withUsuario, puede, type ContextoAutz } from '../auth/authz';
import { HttpError } from '../http/errors';

// Texto por defecto que se muestra como punto de partida en la consola. Si la empresa no
// guarda una plantilla para un rol, el envío usa el texto por defecto del código (ver
// auth_reset.ts), que además distingue empleado (con instrucciones de la app) de consola.
export const DEFAULT_INV_ASUNTO = 'Tu acceso a {empresa}';
export const DEFAULT_INV_CUERPO = 'Te crearon tu acceso en {empresa}. Tocá el botón para elegir tu contraseña.';

function gate(autz: ContextoAutz) {
  if (!puede(autz, 'usuario', 'escribir')) throw new HttpError(403, 'No tenés permiso para gestionar accesos.');
}

// Lista los roles de la empresa con su plantilla de correo (o el texto por defecto).
export async function listarPlantillas(cuentaId: string, usuarioId: string) {
  return withUsuario(cuentaId, usuarioId, async (trx, autz) => {
    gate(autz);
    const roles = await trx.selectFrom('rol').select(['id', 'nombre', 'protegido']).orderBy('nombre').execute();
    const plantillas = await trx.selectFrom('invitacion_plantilla').select(['rol_id', 'asunto', 'cuerpo']).execute();
    const map = new Map(plantillas.map((p) => [p.rol_id, p] as const));
    return roles.map((r) => {
      const p = map.get(r.id);
      return {
        rol_id: r.id,
        nombre: r.nombre,
        protegido: r.protegido,
        asunto: p ? p.asunto : DEFAULT_INV_ASUNTO,
        cuerpo: p ? p.cuerpo : DEFAULT_INV_CUERPO,
        personalizada: !!p,
      };
    });
  });
}

// Crea o actualiza la plantilla de un rol. El cuerpo es TEXTO PLANO; soporta {empresa} y
// {nombre}. El enlace y las instrucciones de la app los agrega el sistema al enviar.
export async function guardarPlantilla(
  cuentaId: string,
  usuarioId: string,
  rolId: string,
  asunto: string,
  cuerpo: string,
) {
  return withUsuario(cuentaId, usuarioId, async (trx, autz) => {
    gate(autz);
    const a = (asunto || '').trim();
    const c = (cuerpo || '').trim();
    if (!a) throw new HttpError(400, 'El asunto no puede estar vacío.');
    if (!c) throw new HttpError(400, 'El cuerpo no puede estar vacío.');
    if (a.length > 200) throw new HttpError(400, 'El asunto es demasiado largo (máx. 200 caracteres).');
    if (c.length > 3000) throw new HttpError(400, 'El cuerpo es demasiado largo (máx. 3000 caracteres).');
    const rol = await trx.selectFrom('rol').select(['id']).where('id', '=', rolId).executeTakeFirst();
    if (!rol) throw new HttpError(404, 'Ese rol no existe en tu empresa.');
    await trx
      .insertInto('invitacion_plantilla')
      .values({ cuenta_id: cuentaId, rol_id: rolId, asunto: a, cuerpo: c })
      .onConflict((oc) => oc.columns(['cuenta_id', 'rol_id']).doUpdateSet({ asunto: a, cuerpo: c }))
      .execute();
    return { ok: true as const };
  });
}

// Borra la plantilla de un rol: vuelve a usarse el texto por defecto.
export async function resetPlantilla(cuentaId: string, usuarioId: string, rolId: string) {
  return withUsuario(cuentaId, usuarioId, async (trx, autz) => {
    gate(autz);
    await trx.deleteFrom('invitacion_plantilla').where('rol_id', '=', rolId).execute();
    return { ok: true as const };
  });
}
