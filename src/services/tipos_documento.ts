import { withUsuario, puede, alcanceEscritura, type ContextoAutz } from '../auth/authz';
import { HttpError } from '../http/errors';
import { registrar } from './auditoria';

// Configurar el catálogo de tipos de documento del legajo es tarea del admin de la empresa
// (igual gate que gestionar usuarios/estructura). RRHH y el empleado suben archivos sobre
// estos tipos, pero no los definen.
function gateAdminEmpresa(ctx: ContextoAutz) {
  if (!puede(ctx, 'usuario', 'escribir') || alcanceEscritura(ctx, 'usuario') !== 'empresa') {
    throw new HttpError(403, 'Sólo un administrador puede configurar los tipos de documento.');
  }
}

export async function listarTiposDocumento(cuentaId: string, usuarioId: string, soloActivos = false) {
  return withUsuario(cuentaId, usuarioId, async (trx) => {
    let q = trx
      .selectFrom('tipo_documento')
      .select(['id', 'nombre', 'obligatorio', 'activo', 'orden'])
      .where('cuenta_id', '=', cuentaId);
    if (soloActivos) q = q.where('activo', '=', true);
    const tipos = await q.orderBy('orden').orderBy('nombre').execute();
    return { tipos };
  });
}

export async function crearTipoDocumento(
  cuentaId: string,
  usuarioId: string,
  input: { nombre: string; obligatorio?: boolean; orden?: number },
) {
  return withUsuario(cuentaId, usuarioId, async (trx, ctx) => {
    gateAdminEmpresa(ctx);
    const nombre = (input.nombre || '').trim();
    if (!nombre) throw new HttpError(400, 'Poné un nombre para el tipo de documento.');
    const row = await trx
      .insertInto('tipo_documento')
      .values({ cuenta_id: cuentaId, nombre, obligatorio: !!input.obligatorio, orden: input.orden ?? 0 })
      .returning('id')
      .executeTakeFirstOrThrow();
    await registrar(trx, cuentaId, usuarioId, { accion: 'tipo_doc.crear', recurso: 'legajo', objetoId: row.id, detalle: { nombre } });
    return { id: row.id };
  });
}

export async function editarTipoDocumento(
  cuentaId: string,
  usuarioId: string,
  tipoId: string,
  input: { nombre?: string; obligatorio?: boolean; activo?: boolean; orden?: number },
) {
  return withUsuario(cuentaId, usuarioId, async (trx, ctx) => {
    gateAdminEmpresa(ctx);
    const set: { nombre?: string; obligatorio?: boolean; activo?: boolean; orden?: number } = {};
    if (input.nombre !== undefined) {
      const n = input.nombre.trim();
      if (!n) throw new HttpError(400, 'El nombre no puede quedar vacío.');
      set.nombre = n;
    }
    if (input.obligatorio !== undefined) set.obligatorio = !!input.obligatorio;
    if (input.activo !== undefined) set.activo = !!input.activo;
    if (input.orden !== undefined) set.orden = input.orden;
    if (!Object.keys(set).length) return { ok: true };
    const r = await trx
      .updateTable('tipo_documento')
      .set(set)
      .where('id', '=', tipoId)
      .where('cuenta_id', '=', cuentaId)
      .executeTakeFirst();
    if (!r || Number(r.numUpdatedRows) === 0) throw new HttpError(404, 'Tipo de documento no encontrado.');
    await registrar(trx, cuentaId, usuarioId, { accion: 'tipo_doc.editar', recurso: 'legajo', objetoId: tipoId });
    return { ok: true };
  });
}

// Baja lógica: no se borra para no afectar documentos que ya lo referencian.
export async function eliminarTipoDocumento(cuentaId: string, usuarioId: string, tipoId: string) {
  return editarTipoDocumento(cuentaId, usuarioId, tipoId, { activo: false });
}
