import { sql, type Transaction } from 'kysely';
import type { DB } from '../db/schema';
import { withUsuario, exigir } from '../auth/authz';
import { registrar } from './auditoria';
import { HttpError } from '../http/errors';

/**
 * Carpetas del repositorio.
 *
 * ═══ DÓNDE SE DECIDE QUIÉN VE QUÉ ═══
 *
 * Los ROLES dicen qué puede hacer una persona (subir, despachar, cancelar).
 * Las CARPETAS dicen sobre QUÉ documentos puede hacerlo. Son dos preguntas
 * distintas y por eso viven en dos lados: en payroll se mezclaban en el
 * "alcance" de cada capacidad, atado al organigrama.
 *
 * ═══ HERENCIA ═══
 *
 * El permiso otorgado en una carpeta vale para toda su rama, y es ADITIVO: no
 * existe la denegación explícita. Si un rol tiene `leer` en la raíz, lo tiene
 * en todo lo que cuelgue de ella, y la única forma de que no vea una rama es
 * no dárselo arriba.
 *
 * Es deliberado. Un modelo con denegaciones que pisan herencias es imposible de
 * explicar en pantalla —y peor, imposible de auditar: nadie puede mirar un
 * árbol de cincuenta carpetas y decir con certeza quién ve qué. Con herencia
 * aditiva, la respuesta es siempre "mirá hacia arriba hasta encontrar el
 * permiso".
 *
 * La herencia la resuelve la base con `ltree` y un índice GiST
 * (`app.puede_en_carpeta`, migración 005), no este archivo. Acá sólo se arma el
 * árbol para mostrarlo.
 */

const ACCIONES = ['ver', 'leer', 'crear', 'enviar', 'mover', 'organizar', 'permisos'] as const;
export type AccionCarpeta = (typeof ACCIONES)[number];

export interface CarpetaNodo {
  id: string;
  padre_id: string | null;
  nombre: string;
  ruta: string;
  profundidad: number;
  sistema: string | null;
  hijos: CarpetaNodo[];
}

function textoI18n(v: unknown, idioma = 'es'): string | null {
  if (!v || typeof v !== 'object') return null;
  const m = v as Record<string, string>;
  return m[idioma] ?? m.es ?? m.en ?? Object.values(m)[0] ?? null;
}

/**
 * Convierte un nombre en una etiqueta válida de `ltree`.
 *
 * `ltree` sólo admite letras sin acento, dígitos y guión bajo. "Contratos de
 * alquiler 2026" pasa a `contratos_de_alquiler_2026`. La etiqueta es interna:
 * lo que ve el usuario es `nombre_i18n`, que no tiene ninguna restricción.
 */
function etiqueta(nombre: string): string {
  const base = nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return base || 'carpeta';
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

/**
 * El árbol que esta persona puede ver.
 *
 * No hace falta filtrar acá: la política de SELECT de `carpeta` ya sólo
 * devuelve aquellas donde el usuario tiene `ver`. Si una rama no aparece, es
 * porque la base decidió que no la ve.
 */
export async function listarArbol(cuentaId: string, identidadId: string): Promise<CarpetaNodo[]> {
  return withUsuario(cuentaId, identidadId, async (trx) => {
    const filas = await sql<{
      id: string; padre_id: string | null; nombre_i18n: unknown;
      ruta: string; sistema: string | null; profundidad: number;
    }>`
      select id, padre_id, nombre_i18n, ruta::text as ruta, sistema,
             nlevel(ruta) as profundidad
        from carpeta
       where cuenta_id = ${cuentaId}::uuid
       order by ruta
    `.execute(trx);

    const nodos = new Map<string, CarpetaNodo>();
    const raiz: CarpetaNodo[] = [];

    for (const f of filas.rows) {
      nodos.set(f.id, {
        id: f.id,
        padre_id: f.padre_id,
        nombre: textoI18n(f.nombre_i18n) ?? f.ruta,
        ruta: f.ruta,
        profundidad: Number(f.profundidad),
        sistema: f.sistema,
        hijos: [],
      });
    }
    // Un hijo cuyo padre no es visible se muestra en la raíz en vez de
    // desaparecer: es preferible ver la carpeta a la que sí tenés acceso, aunque
    // esté colgando de un lugar que no ves.
    for (const n of nodos.values()) {
      const padre = n.padre_id ? nodos.get(n.padre_id) : null;
      if (padre) padre.hijos.push(n);
      else raiz.push(n);
    }
    return raiz;
  });
}

export async function permisosDeCarpeta(cuentaId: string, identidadId: string, carpetaId: string) {
  return withUsuario(cuentaId, identidadId, async (trx) => {
    await exigirCarpeta(trx, carpetaId, 'permisos');

    const roles = await trx
      .selectFrom('rol')
      .select(['id', 'codigo', 'nombre_i18n', 'sistema'])
      .where((eb) => eb.or([eb('cuenta_id', '=', cuentaId), eb('cuenta_id', 'is', null)]))
      .execute();

    // Los permisos PROPIOS de esta carpeta y los HEREDADOS de sus ancestros van
    // separados: si se muestran mezclados, el usuario quita uno heredado desde
    // acá, no pasa nada, y no entiende por qué.
    const propios = await trx
      .selectFrom('carpeta_permiso')
      .select(['rol_id', 'acciones'])
      .where('carpeta_id', '=', carpetaId)
      .execute();

    const heredados = await sql<{ rol_id: string; acciones: string[]; desde: string }>`
      select cp.rol_id, cp.acciones, cor.nombre_i18n->>'es' as desde
        from carpeta obj
        join carpeta cor on cor.cuenta_id = obj.cuenta_id
                        and cor.ruta @> obj.ruta and cor.id <> obj.id
        join carpeta_permiso cp on cp.carpeta_id = cor.id
       where obj.id = ${carpetaId}::uuid
    `.execute(trx);

    const mapaPropios = new Map(propios.map((p) => [p.rol_id, p.acciones]));
    const mapaHeredados = new Map(heredados.rows.map((h) => [h.rol_id, h]));

    return {
      acciones: ACCIONES,
      roles: roles.map((r) => ({
        rol_id: r.id,
        nombre: textoI18n(r.nombre_i18n) ?? r.codigo,
        sistema: r.sistema,
        propias: mapaPropios.get(r.id) ?? [],
        heredadas: mapaHeredados.get(r.id)?.acciones ?? [],
        heredadas_de: mapaHeredados.get(r.id)?.desde ?? null,
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------------

export async function crearCarpeta(
  cuentaId: string,
  identidadId: string,
  padreId: string,
  nombre: string,
) {
  const n = (nombre || '').trim();
  if (!n) throw new HttpError(400, 'Falta el nombre de la carpeta.');
  if (n.length > 80) throw new HttpError(400, 'El nombre no puede pasar de 80 caracteres.');

  return withUsuario(cuentaId, identidadId, async (trx) => {
    const padre = await exigirCarpeta(trx, padreId, 'organizar');

    // La etiqueta se desambigua con un sufijo si ya existe: dos carpetas
    // pueden llamarse igual para el usuario, pero su ruta interna no.
    let etq = etiqueta(n);
    for (let i = 2; i < 100; i++) {
      const existe = await sql<{ n: string }>`
        select count(*)::text as n from carpeta
         where cuenta_id = ${cuentaId}::uuid and ruta = (${padre.ruta} || '.' || ${etq})::ltree
      `.execute(trx);
      if (Number(existe.rows[0]?.n ?? 0) === 0) break;
      etq = etiqueta(n) + '_' + i;
    }

    const r = await sql<{ id: string }>`
      insert into carpeta (cuenta_id, padre_id, nombre_i18n, ruta, creada_por)
      values (${cuentaId}::uuid, ${padreId}::uuid, ${JSON.stringify({ es: n })}::jsonb,
              (${padre.ruta} || '.' || ${etq})::ltree, ${identidadId}::uuid)
      returning id
    `.execute(trx);

    const id = r.rows[0]?.id;
    if (!id) throw new HttpError(500, 'No se pudo crear la carpeta.');

    await registrar(trx, cuentaId, identidadId, {
      accion: 'carpeta.creada',
      recursoTipo: 'carpeta',
      recursoId: id,
      despues: { nombre: n, padre: padre.ruta },
    });
    return { id, nombre: n };
  });
}

export async function renombrarCarpeta(
  cuentaId: string,
  identidadId: string,
  carpetaId: string,
  nombre: string,
  idioma = 'es',
) {
  const n = (nombre || '').trim();
  if (!n) throw new HttpError(400, 'Falta el nombre.');

  return withUsuario(cuentaId, identidadId, async (trx) => {
    const c = await exigirCarpeta(trx, carpetaId, 'organizar');
    if (c.sistema) throw new HttpError(400, 'Las carpetas del sistema no se renombran.');

    const previo = (c.nombre_i18n ?? {}) as Record<string, string>;
    await trx
      .updateTable('carpeta')
      .set({ nombre_i18n: JSON.stringify({ ...previo, [idioma]: n }) })
      .where('id', '=', carpetaId)
      .execute();

    // La `ruta` NO se toca al renombrar. Es un identificador interno, y
    // cambiarla obligaría a reescribir la de todos los descendientes y a
    // invalidar cualquier referencia guardada. El nombre es presentación.
    await registrar(trx, cuentaId, identidadId, {
      accion: 'carpeta.renombrada',
      recursoTipo: 'carpeta',
      recursoId: carpetaId,
      antes: { nombre: previo[idioma] ?? null },
      despues: { nombre: n },
    });
    return { ok: true };
  });
}

export async function borrarCarpeta(cuentaId: string, identidadId: string, carpetaId: string) {
  return withUsuario(cuentaId, identidadId, async (trx) => {
    const c = await exigirCarpeta(trx, carpetaId, 'organizar');
    if (c.sistema) throw new HttpError(400, 'Las carpetas del sistema no se borran.');

    const hijos = await trx
      .selectFrom('carpeta')
      .select('id')
      .where('padre_id', '=', carpetaId)
      .executeTakeFirst();
    if (hijos) throw new HttpError(409, 'La carpeta tiene subcarpetas. Vaciala primero.');

    // Un documento no vive "en una carpeta": vive en una carpeta POR CADA
    // repositorio que lo tiene (migración 007). El mismo contrato está en
    // contratos/2026 de la empresa y en la bandeja de entrada del firmante.
    // Por eso lo que se consulta es `ubicacion`, no `instancia`.
    const conDocs = await trx
      .selectFrom('ubicacion')
      .select('id')
      .where('carpeta_id', '=', carpetaId)
      .executeTakeFirst();
    if (conDocs) {
      throw new HttpError(409, 'La carpeta tiene documentos. Movelos antes de borrarla.');
    }

    await trx.deleteFrom('carpeta_permiso').where('carpeta_id', '=', carpetaId).execute();
    await trx.deleteFrom('carpeta').where('id', '=', carpetaId).execute();

    await registrar(trx, cuentaId, identidadId, {
      accion: 'carpeta.borrada',
      recursoTipo: 'carpeta',
      recursoId: carpetaId,
      antes: { ruta: c.ruta },
    });
    return { ok: true };
  });
}

/**
 * Fija las acciones de un rol sobre una carpeta. Lista vacía = quitar.
 *
 * Es un reemplazo completo y no un agregado incremental, a propósito: el
 * usuario ve una fila con casillas y espera que lo que ve sea lo que queda.
 */
export async function setPermiso(
  cuentaId: string,
  identidadId: string,
  carpetaId: string,
  rolId: string,
  acciones: string[],
) {
  const limpias = [...new Set(acciones)].filter((a) => (ACCIONES as readonly string[]).includes(a));
  if (limpias.length !== acciones.length) throw new HttpError(400, 'Hay acciones que no existen.');

  // `ver` es la base de todo: sin ella la carpeta no aparece, y cualquier otra
  // acción sobre algo invisible es una trampa para el que la configura.
  if (limpias.length && !limpias.includes('ver')) limpias.push('ver');

  return withUsuario(cuentaId, identidadId, async (trx) => {
    await exigirCarpeta(trx, carpetaId, 'permisos');

    const rol = await trx
      .selectFrom('rol')
      .select('id')
      .where('id', '=', rolId)
      .where('cuenta_id', '=', cuentaId)
      .executeTakeFirst();
    if (!rol) throw new HttpError(400, 'Ese rol no es de tu cuenta.');

    const previo = await trx
      .selectFrom('carpeta_permiso')
      .select('acciones')
      .where('carpeta_id', '=', carpetaId)
      .where('rol_id', '=', rolId)
      .executeTakeFirst();

    if (!limpias.length) {
      await trx
        .deleteFrom('carpeta_permiso')
        .where('carpeta_id', '=', carpetaId)
        .where('rol_id', '=', rolId)
        .execute();
    } else {
      await trx
        .insertInto('carpeta_permiso')
        .values({
          carpeta_id: carpetaId,
          cuenta_id: cuentaId,
          rol_id: rolId,
          acciones: limpias,
          otorgado_por: identidadId,
        })
        .onConflict((oc) =>
          oc.columns(['carpeta_id', 'rol_id']).doUpdateSet({ acciones: limpias, otorgado_por: identidadId }),
        )
        .execute();
    }

    await registrar(trx, cuentaId, identidadId, {
      accion: 'carpeta.permisos',
      recursoTipo: 'carpeta',
      recursoId: carpetaId,
      antes: { rol_id: rolId, acciones: previo?.acciones ?? [] },
      despues: { rol_id: rolId, acciones: limpias },
    });
    return { ok: true, acciones: limpias };
  });
}

// ---------------------------------------------------------------------------
// Internos
// ---------------------------------------------------------------------------

/**
 * La carpeta existe, es de esta cuenta y el usuario puede hacer `accion` ahí.
 *
 * La RLS ya lo garantiza —el INSERT o el UPDATE fallarían— pero fallaría con un
 * mensaje que no le dice nada a nadie, o peor, con cero filas afectadas y
 * apariencia de éxito. Esto convierte eso en un 403 con texto.
 */
async function exigirCarpeta(trx: Transaction<DB>, carpetaId: string, accion: AccionCarpeta) {
  const c = await sql<{
    id: string; ruta: string; sistema: string | null; nombre_i18n: unknown; puede: boolean;
  }>`
    select id, ruta::text as ruta, sistema, nombre_i18n,
           app.puede_en_carpeta(id, ${accion}) as puede
      from carpeta where id = ${carpetaId}::uuid
  `.execute(trx);

  const fila = c.rows[0];
  if (!fila) throw new HttpError(404, 'Esa carpeta no existe.');
  if (!fila.puede) throw new HttpError(403, `No tenés permiso para ${accion} en esa carpeta.`);
  return fila;
}
