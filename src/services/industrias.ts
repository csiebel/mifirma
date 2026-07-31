import { withUsuario, puede } from '../auth/authz';
import { ownerDb } from '../db/owner';
import { HttpError } from '../http/errors';

// Industria / rubro de empresa. El catálogo es de plataforma y lo gestiona el operador
// (ownerDb). Cada empresa elige su industria; la segmentación de ofertas por industria es
// una fase aparte. La industria no es por país: es un catálogo global.

// ============================ LADO OPERADOR (ownerDb) ============================

export interface IndustriaInput {
  nombre?: string;
  orden?: number;
}

export async function listarIndustrias() {
  const industrias = await ownerDb()
    .selectFrom('industria')
    .selectAll()
    .orderBy('orden')
    .orderBy('nombre')
    .execute();
  return { industrias };
}

export async function crearIndustria(input: IndustriaInput): Promise<{ id: string }> {
  const nombre = (input.nombre || '').trim();
  if (!nombre) throw new HttpError(400, 'La industria necesita un nombre.');
  const row = await ownerDb()
    .insertInto('industria')
    .values({ nombre, orden: input.orden ?? 0 })
    .returning(['id'])
    .executeTakeFirstOrThrow();
  return { id: row.id };
}

export async function editarIndustria(id: string, input: IndustriaInput): Promise<{ ok: true }> {
  const set: Record<string, unknown> = {};
  if (input.nombre !== undefined) {
    const n = input.nombre.trim();
    if (!n) throw new HttpError(400, 'El nombre no puede quedar vacío.');
    set.nombre = n;
  }
  if (input.orden !== undefined) set.orden = input.orden;
  if (Object.keys(set).length) {
    await ownerDb().updateTable('industria').set(set).where('id', '=', id).execute();
  }
  return { ok: true };
}

export async function setIndustriaActiva(id: string, activo: boolean): Promise<{ ok: true }> {
  await ownerDb().updateTable('industria').set({ activo }).where('id', '=', id).execute();
  return { ok: true };
}

export async function borrarIndustria(id: string): Promise<{ ok: true }> {
  // Si alguna empresa la tiene asignada, la FK la dejaría colgada: primero la desvinculamos.
  await ownerDb().updateTable('empresa').set({ industria_id: null }).where('industria_id', '=', id).execute();
  await ownerDb().deleteFrom('industria').where('id', '=', id).execute();
  return { ok: true };
}

// ============================ LADO EMPRESA (RLS) ============================

/** Industria actual de la empresa y el catálogo de industrias activas para elegir. */
export async function verIndustriaEmpresa(cuentaId: string, usuarioId: string) {
  return withUsuario(cuentaId, usuarioId, async (trx) => {
    const empresa = await trx
      .selectFrom('empresa')
      .select(['industria_id'])
      .where('id', '=', cuentaId)
      .executeTakeFirst();
    const industrias = await trx
      .selectFrom('industria')
      .select(['id', 'nombre'])
      .where('activo', '=', true)
      .orderBy('orden')
      .orderBy('nombre')
      .execute();
    return { industria_id: empresa?.industria_id ?? null, industrias };
  });
}

/** La empresa elige (o limpia) su industria. Requiere usuario:escribir. */
export async function setIndustriaEmpresa(
  cuentaId: string,
  usuarioId: string,
  industriaId: string | null,
): Promise<{ ok: true }> {
  return withUsuario(cuentaId, usuarioId, async (trx, autz) => {
    if (!puede(autz, 'usuario', 'escribir')) {
      throw new HttpError(403, 'No tenés permiso para configurar la empresa.');
    }
    let provId: string | null = null;
    if (industriaId) {
      const ind = await trx
        .selectFrom('industria')
        .select(['id'])
        .where('id', '=', industriaId)
        .where('activo', '=', true)
        .executeTakeFirst();
      if (!ind) throw new HttpError(400, 'La industria elegida no es válida.');
      provId = industriaId;
    }
    await trx.updateTable('empresa').set({ industria_id: provId }).where('id', '=', cuentaId).execute();
    return { ok: true };
  });
}
