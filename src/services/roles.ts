import { withUsuario, puede, type ContextoAutz } from '../auth/authz';
import { registrar } from './auditoria';
import { HttpError } from '../http/errors';
import type { AlcanceDato } from '../db/schema';

// Módulo de definición de roles: el admin de la empresa arma sus propios roles y,
// para cada uno, qué puede ver/editar y sobre quién (alcance). Es la sección 11 del
// documento ("configurable por tenant"). El enforcement NO vive acá: este servicio
// solo edita filas de `rol` y `capacidad`; quien autoriza sigue siendo la capa de
// datos (RLS para el alcance, `puede()` para la capacidad). Gateado por usuario:escribir.

function gate(autz: ContextoAutz) {
  if (!puede(autz, 'usuario', 'escribir')) throw new HttpError(403, 'No tenés permiso para configurar roles.');
}

// Catálogo de "ladrillos": qué recursos hay, qué acciones y qué alcances ofrece cada acción.
const ALCANCES: AlcanceDato[] = ['propio', 'equipo', 'area', 'empresa'];
const TODOS: AlcanceDato[] = ALCANCES;
const SOLO_EMPRESA: AlcanceDato[] = ['empresa'];
interface AccionCat {
  accion: string;
  alcances: AlcanceDato[];
}
interface RecursoCat {
  recurso: string;
  acciones: AccionCat[];
}
const LE = (al: AlcanceDato[]): AccionCat[] => [
  { accion: 'leer', alcances: al },
  { accion: 'escribir', alcances: al },
];
const CATALOGO: RecursoCat[] = [
  { recurso: 'recibo', acciones: [{ accion: 'leer', alcances: TODOS }, { accion: 'ver_monto', alcances: SOLO_EMPRESA }] },
  { recurso: 'empleado', acciones: LE(TODOS) },
  { recurso: 'evaluacion', acciones: [...LE(TODOS), { accion: 'ver_detalle', alcances: SOLO_EMPRESA }] },
  { recurso: 'estudio_cert', acciones: LE(TODOS) },
  { recurso: 'legajo', acciones: [...LE(TODOS), { accion: 'ver_detalle', alcances: SOLO_EMPRESA }] },
  { recurso: 'capacitacion', acciones: LE(TODOS) },
  { recurso: 'inscripcion', acciones: LE(TODOS) },
  { recurso: 'corrida', acciones: [{ accion: 'escribir', alcances: SOLO_EMPRESA }] },
  { recurso: 'usuario', acciones: [{ accion: 'escribir', alcances: SOLO_EMPRESA }] },
  { recurso: 'auditoria', acciones: [{ accion: 'leer', alcances: SOLO_EMPRESA }] },
];
const VALIDO = new Map<string, RecursoCat>(CATALOGO.map((c) => [c.recurso, c]));

export function catalogoCapacidades() {
  return { recursos: CATALOGO, alcances: ALCANCES };
}

export async function listarRolesDetalle(cuentaId: string, adminUsuarioId: string) {
  return withUsuario(cuentaId, adminUsuarioId, async (trx, autz) => {
    gate(autz);
    const roles = await trx.selectFrom('rol').select(['id', 'nombre', 'protegido']).orderBy('nombre').execute();
    const caps = await trx.selectFrom('capacidad').select(['rol_id', 'recurso', 'accion', 'alcance']).execute();
    const porRol = new Map<string, { recurso: string; accion: string; alcance: string }[]>();
    for (const c of caps) {
      const a = porRol.get(c.rol_id) || [];
      a.push({ recurso: c.recurso, accion: c.accion, alcance: c.alcance });
      porRol.set(c.rol_id, a);
    }
    return roles.map((r) => ({
      rol_id: r.id,
      nombre: r.nombre,
      protegido: r.protegido,
      capacidades: porRol.get(r.id) || [],
    }));
  });
}

export async function crearRol(cuentaId: string, adminUsuarioId: string, nombre: string) {
  const n = (nombre || '').trim();
  if (!n) throw new HttpError(400, 'Falta el nombre del rol.');
  return withUsuario(cuentaId, adminUsuarioId, async (trx, autz) => {
    gate(autz);
    const ya = await trx.selectFrom('rol').select('id').where('nombre', '=', n).executeTakeFirst();
    if (ya) throw new HttpError(409, 'Ya existe un rol con ese nombre.');
    const r = await trx
      .insertInto('rol')
      .values({ cuenta_id: cuentaId, nombre: n, protegido: false })
      .returning('id')
      .executeTakeFirstOrThrow();
    await registrar(trx, cuentaId, adminUsuarioId, { accion: 'rol.crear', recurso: 'rol', objetoId: r.id, detalle: { nombre: n } });
    return { rol_id: r.id, nombre: n };
  });
}

export async function renombrarRol(cuentaId: string, adminUsuarioId: string, rolId: string, nombre: string) {
  const n = (nombre || '').trim();
  if (!n) throw new HttpError(400, 'Falta el nombre del rol.');
  return withUsuario(cuentaId, adminUsuarioId, async (trx, autz) => {
    gate(autz);
    const rol = await trx.selectFrom('rol').select(['id']).where('id', '=', rolId).executeTakeFirst();
    if (!rol) throw new HttpError(404, 'Rol no encontrado.');
    const ya = await trx.selectFrom('rol').select('id').where('nombre', '=', n).where('id', '!=', rolId).executeTakeFirst();
    if (ya) throw new HttpError(409, 'Ya existe un rol con ese nombre.');
    await trx.updateTable('rol').set({ nombre: n }).where('id', '=', rolId).execute();
    await registrar(trx, cuentaId, adminUsuarioId, { accion: 'rol.renombrar', recurso: 'rol', objetoId: rolId, detalle: { nombre: n } });
    return { ok: true };
  });
}

export async function borrarRol(cuentaId: string, adminUsuarioId: string, rolId: string) {
  return withUsuario(cuentaId, adminUsuarioId, async (trx, autz) => {
    gate(autz);
    const rol = await trx.selectFrom('rol').select(['id', 'nombre', 'protegido']).where('id', '=', rolId).executeTakeFirst();
    if (!rol) throw new HttpError(404, 'Rol no encontrado.');
    if (rol.protegido) throw new HttpError(400, 'Ese rol está protegido y no se puede borrar.');
    // capacidad y usuario_rol caen por ON DELETE CASCADE.
    await trx.deleteFrom('rol').where('id', '=', rolId).execute();
    await registrar(trx, cuentaId, adminUsuarioId, { accion: 'rol.borrar', recurso: 'rol', objetoId: rolId, detalle: { nombre: rol.nombre } });
    return { ok: true };
  });
}

// Prende/apaga una capacidad de un rol. alcance = null apaga (sin acceso);
// un alcance la fija (un único alcance por recurso+acción, por el UNIQUE de la tabla).
export async function setCapacidad(
  cuentaId: string,
  adminUsuarioId: string,
  rolId: string,
  recurso: string,
  accion: string,
  alcance: AlcanceDato | null,
) {
  const cat = VALIDO.get(recurso);
  if (!cat) throw new HttpError(400, 'Recurso no válido.');
  const ac = cat.acciones.find((a) => a.accion === accion);
  if (!ac) throw new HttpError(400, 'Acción no válida para ese recurso.');
  if (alcance !== null && !ac.alcances.includes(alcance)) throw new HttpError(400, 'Alcance no válido para ese recurso.');
  return withUsuario(cuentaId, adminUsuarioId, async (trx, autz) => {
    gate(autz);
    const rol = await trx.selectFrom('rol').select(['id', 'protegido']).where('id', '=', rolId).executeTakeFirst();
    if (!rol) throw new HttpError(404, 'Rol no encontrado.');
    // Anti-lockout: no se puede sacar usuario:escribir de un rol protegido.
    if (rol.protegido && recurso === 'usuario' && accion === 'escribir' && alcance === null) {
      throw new HttpError(400, 'No se puede quitar la gestión de usuarios del rol protegido.');
    }
    if (alcance === null) {
      await trx
        .deleteFrom('capacidad')
        .where('rol_id', '=', rolId)
        .where('recurso', '=', recurso)
        .where('accion', '=', accion)
        .execute();
    } else {
      await trx
        .insertInto('capacidad')
        .values({ cuenta_id: cuentaId, rol_id: rolId, recurso, accion, alcance })
        .onConflict((oc) => oc.columns(['cuenta_id', 'rol_id', 'recurso', 'accion']).doUpdateSet({ alcance }))
        .execute();
    }
    await registrar(trx, cuentaId, adminUsuarioId, { accion: 'rol.capacidad', recurso: 'rol', objetoId: rolId, detalle: { recurso, accion, alcance } });
    return { ok: true };
  });
}
