import { withUsuario, exigir } from '../auth/authz';
import { withOperador } from '../db/pool';
import { registrar } from './auditoria';
import { HttpError } from '../http/errors';

/**
 * Industria o rubro de la cuenta.
 *
 * El catálogo es global y lo administra el operador; cada cuenta de tipo
 * empresa elige la suya. No es por país a propósito: "construcción" es
 * construcción en Montevideo y en São Paulo, y partirlo por país obligaría a
 * mantener tres listas que dicen lo mismo.
 *
 * El nombre es `jsonb` por idioma, como todos los catálogos nuestros: lo ve un
 * usuario brasileño en portugués sin que nadie traduzca nada a mano.
 */

function textoI18n(v: unknown, idioma = 'es'): string | null {
  if (!v || typeof v !== 'object') return null;
  const m = v as Record<string, string>;
  return m[idioma] ?? m.es ?? m.en ?? Object.values(m)[0] ?? null;
}

// ============================ LADO OPERADOR ============================

export interface IndustriaInput {
  codigo?: string;
  nombres?: Record<string, string>;
}

export async function listarIndustriasOperador(operadorId: string) {
  return withOperador(operadorId, async (trx) => {
    const filas = await trx.selectFrom('industria').select(['id', 'codigo', 'nombre_i18n']).execute();
    return filas
      .map((f) => ({ id: f.id, codigo: f.codigo, nombre: textoI18n(f.nombre_i18n) ?? f.codigo, nombres: f.nombre_i18n }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  });
}

export async function crearIndustria(operadorId: string, input: IndustriaInput): Promise<{ id: string }> {
  const codigo = (input.codigo || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (!codigo) throw new HttpError(400, 'Falta el código de la industria.');
  if (!input.nombres || !Object.keys(input.nombres).length) {
    throw new HttpError(400, 'Falta el nombre en al menos un idioma.');
  }
  return withOperador(operadorId, async (trx) => {
    const ya = await trx.selectFrom('industria').select('id').where('codigo', '=', codigo).executeTakeFirst();
    if (ya) throw new HttpError(409, 'Ya existe una industria con ese código.');
    const r = await trx
      .insertInto('industria')
      .values({ codigo, nombre_i18n: JSON.stringify(input.nombres) })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { id: r.id };
  });
}

export async function editarIndustria(
  operadorId: string,
  id: string,
  input: IndustriaInput,
): Promise<{ ok: true }> {
  return withOperador(operadorId, async (trx) => {
    const ind = await trx.selectFrom('industria').select(['id', 'nombre_i18n']).where('id', '=', id).executeTakeFirst();
    if (!ind) throw new HttpError(404, 'Industria no encontrada.');
    const previo = (ind.nombre_i18n ?? {}) as Record<string, string>;
    await trx
      .updateTable('industria')
      .set({ nombre_i18n: JSON.stringify({ ...previo, ...(input.nombres ?? {}) }) })
      .where('id', '=', id)
      .execute();
    return { ok: true as const };
  });
}

/**
 * Borrar una industria en uso rompería la referencia de las cuentas que la
 * eligieron. Se avisa en vez de dejar que falle la FK: el operador tiene que
 * poder entender por qué no puede.
 */
export async function borrarIndustria(operadorId: string, id: string): Promise<{ ok: true }> {
  return withOperador(operadorId, async (trx) => {
    const enUso = await trx.selectFrom('empresa').select('cuenta_id').where('industria_id', '=', id).executeTakeFirst();
    if (enUso) throw new HttpError(409, 'Hay cuentas usando esa industria. Reasignalas antes de borrarla.');
    await trx.deleteFrom('industria').where('id', '=', id).execute();
    return { ok: true as const };
  });
}

// ============================ LADO CUENTA ============================

/** Catálogo para el selector, en el idioma de la sesión. */
export async function listarIndustrias(cuentaId: string, identidadId: string) {
  return withUsuario(cuentaId, identidadId, async (trx) => {
    const filas = await trx.selectFrom('industria').select(['id', 'codigo', 'nombre_i18n']).execute();
    return filas
      .map((f) => ({ id: f.id, codigo: f.codigo, nombre: textoI18n(f.nombre_i18n) ?? f.codigo }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  });
}

export async function verIndustriaCuenta(cuentaId: string, identidadId: string) {
  return withUsuario(cuentaId, identidadId, async (trx) => {
    const r = await trx
      .selectFrom('empresa as e')
      .leftJoin('industria as i', 'i.id', 'e.industria_id')
      .select(['e.industria_id as industria_id', 'i.codigo as codigo', 'i.nombre_i18n as nombre_i18n'])
      .where('e.cuenta_id', '=', cuentaId)
      .executeTakeFirst();
    return {
      industria_id: r?.industria_id ?? null,
      nombre: r?.nombre_i18n ? textoI18n(r.nombre_i18n) : null,
    };
  });
}

export async function setIndustriaCuenta(
  cuentaId: string,
  identidadId: string,
  industriaId: string | null,
): Promise<{ ok: true }> {
  return withUsuario(cuentaId, identidadId, async (trx, autz) => {
    exigir(autz, 'cuenta', 'administrar', 'No tenés permiso para editar los datos de la cuenta.');

    if (industriaId) {
      const ind = await trx.selectFrom('industria').select('id').where('id', '=', industriaId).executeTakeFirst();
      if (!ind) throw new HttpError(400, 'Esa industria no existe.');
    }

    const e = await trx.selectFrom('empresa').select('cuenta_id').where('cuenta_id', '=', cuentaId).executeTakeFirst();
    if (!e) throw new HttpError(400, 'Esta cuenta no es de tipo empresa.');

    await trx
      .updateTable('empresa')
      .set({ industria_id: industriaId, actualizada_en: new Date() })
      .where('cuenta_id', '=', cuentaId)
      .execute();

    await registrar(trx, cuentaId, identidadId, {
      accion: 'cuenta.industria',
      recursoTipo: 'cuenta',
      recursoId: cuentaId,
      despues: { industria_id: industriaId },
    });
    return { ok: true as const };
  });
}
