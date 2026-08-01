import { withUsuario, exigir } from '../auth/authz';
import { registrar } from './auditoria';
import { HttpError } from '../http/errors';

/**
 * Roles de la cuenta: el cliente arma los suyos y les prende capacidades.
 *
 * ═══ QUÉ CAMBIÓ RESPECTO DE PAYROLL NG ═══
 *
 * Allá una capacidad llevaba ALCANCE —propio, equipo, área, empresa— porque la
 * pregunta era "sobre QUIÉNES puede hacer esto": el jefe ve los recibos de su
 * área, el empleado sólo el suyo. Eso colgaba del organigrama.
 *
 * En MiFirma la pregunta no es sobre quiénes, es sobre QUÉ DOCUMENTOS, y la
 * respuesta la dan dos cosas que no son el rol:
 *
 *   · las CARPETAS, con permiso por rol y herencia aditiva (migración 005)
 *   · los OTORGAMIENTOS, que cruzan la frontera de la cuenta (migración 008)
 *
 * Así que la capacidad quedó binaria: la tenés o no la tenés. El "sobre qué"
 * se configura en el árbol de carpetas, que es donde el usuario lo espera.
 *
 * ═══ DÓNDE SE APLICA ═══
 *
 * Acá no. Este servicio edita filas de `rol` y `rol_capacidad`. Quien autoriza
 * es la capa de datos: `app.tiene_capacidad()` dentro de las políticas RLS.
 */

const CAP = ['usuario', 'administrar'] as const;

function textoI18n(v: unknown, idioma = 'es'): string | null {
  if (!v || typeof v !== 'object') return null;
  const m = v as Record<string, string>;
  return m[idioma] ?? m.es ?? m.en ?? Object.values(m)[0] ?? null;
}

/**
 * Catálogo de capacidades.
 *
 * Sale de la tabla `capacidad`, no de una lista en el código: agregar una
 * capacidad nueva es una migración con su fila y su descripción traducida, y la
 * consola la muestra sin desplegar nada. En payroll el catálogo estaba
 * hardcodeado acá y había que tocar dos lugares.
 */
export async function catalogoCapacidades(cuentaId: string, identidadId: string) {
  return withUsuario(cuentaId, identidadId, async (trx, autz) => {
    exigir(autz, ...CAP, 'No tenés permiso para configurar roles.');
    const filas = await trx
      .selectFrom('capacidad')
      .select(['id', 'recurso', 'accion', 'descripcion_i18n'])
      .execute();

    const porRecurso = new Map<string, { id: string; accion: string; descripcion: string }[]>();
    for (const f of filas) {
      const a = porRecurso.get(f.recurso) ?? [];
      a.push({
        id: f.id,
        accion: f.accion,
        descripcion: textoI18n(f.descripcion_i18n) ?? `${f.recurso}.${f.accion}`,
      });
      porRecurso.set(f.recurso, a);
    }
    return {
      recursos: [...porRecurso.entries()].map(([recurso, acciones]) => ({ recurso, acciones })),
    };
  });
}

export async function listarRolesDetalle(cuentaId: string, identidadId: string) {
  return withUsuario(cuentaId, identidadId, async (trx, autz) => {
    exigir(autz, ...CAP, 'No tenés permiso para configurar roles.');

    const roles = await trx
      .selectFrom('rol')
      .select(['id', 'codigo', 'nombre_i18n', 'sistema'])
      .where((eb) => eb.or([eb('cuenta_id', '=', cuentaId), eb('cuenta_id', 'is', null)]))
      .execute();

    const caps = await trx
      .selectFrom('rol_capacidad as rc')
      .innerJoin('capacidad as c', 'c.id', 'rc.capacidad_id')
      .select(['rc.rol_id as rol_id', 'c.id as capacidad_id', 'c.recurso as recurso', 'c.accion as accion'])
      .execute();

    const porRol = new Map<string, { capacidad_id: string; recurso: string; accion: string }[]>();
    for (const c of caps) {
      const a = porRol.get(c.rol_id) ?? [];
      a.push({ capacidad_id: c.capacidad_id, recurso: c.recurso, accion: c.accion });
      porRol.set(c.rol_id, a);
    }

    return roles
      .map((r) => ({
        rol_id: r.id,
        codigo: r.codigo,
        nombre: textoI18n(r.nombre_i18n) ?? r.codigo,
        sistema: r.sistema,
        capacidades: porRol.get(r.id) ?? [],
      }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  });
}

export async function crearRol(
  cuentaId: string,
  identidadId: string,
  codigo: string,
  nombre: string,
) {
  const cod = (codigo || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const n = (nombre || '').trim();
  if (!cod) throw new HttpError(400, 'Falta el código del rol.');
  if (!n) throw new HttpError(400, 'Falta el nombre del rol.');

  return withUsuario(cuentaId, identidadId, async (trx, autz) => {
    exigir(autz, ...CAP, 'No tenés permiso para configurar roles.');

    const ya = await trx
      .selectFrom('rol')
      .select('id')
      .where('cuenta_id', '=', cuentaId)
      .where('codigo', '=', cod)
      .executeTakeFirst();
    if (ya) throw new HttpError(409, 'Ya existe un rol con ese código.');

    // El nombre nace en el idioma de la cuenta; el cliente puede traducirlo
    // después. Obligar a cargar tres idiomas para crear un rol es la clase de
    // fricción que hace abandonar el producto en el primer uso.
    const r = await trx
      .insertInto('rol')
      .values({ cuenta_id: cuentaId, codigo: cod, nombre_i18n: JSON.stringify({ es: n }), sistema: false })
      .returning('id')
      .executeTakeFirstOrThrow();

    await registrar(trx, cuentaId, identidadId, {
      accion: 'rol.creado',
      recursoTipo: 'rol',
      recursoId: r.id,
      despues: { codigo: cod, nombre: n },
    });
    return { rol_id: r.id, codigo: cod, nombre: n };
  });
}

export async function renombrarRol(
  cuentaId: string,
  identidadId: string,
  rolId: string,
  nombre: string,
  idioma = 'es',
) {
  const n = (nombre || '').trim();
  if (!n) throw new HttpError(400, 'Falta el nombre del rol.');

  return withUsuario(cuentaId, identidadId, async (trx, autz) => {
    exigir(autz, ...CAP, 'No tenés permiso para configurar roles.');
    const rol = await exigirRolPropio(trx, cuentaId, rolId);

    const previo = (rol.nombre_i18n ?? {}) as Record<string, string>;
    const nuevo = { ...previo, [idioma]: n };

    await trx
      .updateTable('rol')
      .set({ nombre_i18n: JSON.stringify(nuevo) })
      .where('id', '=', rolId)
      .execute();

    await registrar(trx, cuentaId, identidadId, {
      accion: 'rol.renombrado',
      recursoTipo: 'rol',
      recursoId: rolId,
      antes: { nombre: previo[idioma] ?? null },
      despues: { nombre: n },
    });
    return { ok: true };
  });
}

export async function borrarRol(cuentaId: string, identidadId: string, rolId: string) {
  return withUsuario(cuentaId, identidadId, async (trx, autz) => {
    exigir(autz, ...CAP, 'No tenés permiso para configurar roles.');
    const rol = await exigirRolPropio(trx, cuentaId, rolId);

    const asignado = await trx
      .selectFrom('usuario_rol')
      .select('id')
      .where('rol_id', '=', rolId)
      .where('cuenta_id', '=', cuentaId)
      .executeTakeFirst();
    if (asignado) {
      throw new HttpError(
        409,
        'Ese rol todavía está asignado a alguien. Quitáselo primero y después borralo.',
      );
    }

    await trx.deleteFrom('rol_capacidad').where('rol_id', '=', rolId).execute();
    await trx.deleteFrom('rol').where('id', '=', rolId).execute();

    await registrar(trx, cuentaId, identidadId, {
      accion: 'rol.borrado',
      recursoTipo: 'rol',
      recursoId: rolId,
      antes: { codigo: rol.codigo },
    });
    return { ok: true };
  });
}

/**
 * Prende o apaga una capacidad de un rol.
 *
 * El anti-lockout no mira este rol aislado sino la cuenta entera: lo que no se
 * puede es quedarse sin NADIE que administre accesos. Mirarlo rol por rol
 * prohíbe cosas legítimas —sacarle la capacidad a un rol cuando otro la
 * tiene— y no impide el caso que importa.
 */
export async function setCapacidad(
  cuentaId: string,
  identidadId: string,
  rolId: string,
  capacidadId: string,
  activa: boolean,
) {
  return withUsuario(cuentaId, identidadId, async (trx, autz) => {
    exigir(autz, ...CAP, 'No tenés permiso para configurar roles.');
    await exigirRolPropio(trx, cuentaId, rolId);

    const cap = await trx
      .selectFrom('capacidad')
      .select(['id', 'recurso', 'accion'])
      .where('id', '=', capacidadId)
      .executeTakeFirst();
    if (!cap) throw new HttpError(400, 'Esa capacidad no existe.');

    if (!activa && cap.recurso === 'usuario' && cap.accion === 'administrar') {
      const otros = await trx
        .selectFrom('usuario_rol as ur')
        .innerJoin('rol_capacidad as rc', 'rc.rol_id', 'ur.rol_id')
        .select('ur.id')
        .where('ur.cuenta_id', '=', cuentaId)
        .where('rc.capacidad_id', '=', capacidadId)
        .where('ur.rol_id', '!=', rolId)
        .executeTakeFirst();
      if (!otros) {
        throw new HttpError(
          400,
          'No podés quitar esta capacidad: nadie más en la cuenta quedaría con permiso para administrar accesos.',
        );
      }
    }

    if (activa) {
      await trx
        .insertInto('rol_capacidad')
        .values({ rol_id: rolId, capacidad_id: capacidadId })
        .onConflict((oc) => oc.columns(['rol_id', 'capacidad_id']).doNothing())
        .execute();
    } else {
      await trx
        .deleteFrom('rol_capacidad')
        .where('rol_id', '=', rolId)
        .where('capacidad_id', '=', capacidadId)
        .execute();
    }

    await registrar(trx, cuentaId, identidadId, {
      accion: activa ? 'rol.capacidad_agregada' : 'rol.capacidad_quitada',
      recursoTipo: 'rol',
      recursoId: rolId,
      despues: { recurso: cap.recurso, accion: cap.accion },
    });
    return { ok: true };
  });
}

/**
 * El rol tiene que ser de esta cuenta y no ser del sistema.
 *
 * Los roles con `cuenta_id` nulo son plantillas nuestras, compartidas por todas
 * las cuentas: editarlos desde el panel de un cliente cambiaría los roles de
 * todos los demás. La RLS ya los deja leer, así que el corte va acá.
 */
async function exigirRolPropio(trx: any, cuentaId: string, rolId: string) {
  const rol = await trx
    .selectFrom('rol')
    .select(['id', 'codigo', 'nombre_i18n', 'sistema', 'cuenta_id'])
    .where('id', '=', rolId)
    .executeTakeFirst();
  if (!rol) throw new HttpError(404, 'Rol no encontrado.');
  if (rol.cuenta_id !== cuentaId) {
    throw new HttpError(400, 'Ese rol es una plantilla del sistema y no se edita desde acá.');
  }
  if (rol.sistema) throw new HttpError(400, 'Ese rol es del sistema y no se puede modificar.');
  return rol as { id: string; codigo: string; nombre_i18n: unknown; sistema: boolean; cuenta_id: string };
}
