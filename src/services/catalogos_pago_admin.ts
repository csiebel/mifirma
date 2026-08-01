import { operadorDb } from '../db/pool';
import { HttpError } from '../http/errors';

// =============================================================================
// CRUD de los catálogos de pago (banco y tipo de cuenta bancaria) para el operador.
// Son catálogos de plataforma por país (los mismos que la empresa elige al cargar un
// medio de pago). Hasta ahora venían solo con seed + lectura; esto permite mantenerlos
// desde la consola del operador. Usan operadorDb (no llevan RLS: son compartidos por país).
//
// Las dos tablas tienen la misma forma (id, pais, nombre, activo, orden), así que se
// manejan con funciones genéricas parametrizadas por la tabla.
// =============================================================================

export type TablaCatalogoPago = 'banco' | 'tipo_cuenta_bancaria';

function tablaValida(t: string): TablaCatalogoPago {
  if (t === 'banco' || t === 'tipo_cuenta_bancaria') return t;
  throw new HttpError(400, 'Catálogo inválido.');
}

export async function listarCatalogoPagoAdmin(tabla: TablaCatalogoPago, pais?: string) {
  let q = operadorDb()
    .selectFrom(tabla)
    .select(['id', 'pais', 'nombre', 'activo', 'orden']);
  if (pais) q = q.where('pais', '=', pais.trim().toUpperCase());
  const filas = await q.orderBy('pais').orderBy('orden').orderBy('nombre').execute();
  return { items: filas };
}

export async function crearCatalogoPago(
  tabla: TablaCatalogoPago,
  d: { pais: string; nombre: string; orden?: number },
) {
  const pais = (d.pais || '').trim().toUpperCase();
  const nombre = (d.nombre || '').trim();
  if (!pais || !nombre) throw new HttpError(400, 'País y nombre son obligatorios.');
  if (tabla === 'banco') {
    await operadorDb().insertInto('banco').values({ pais, nombre, orden: d.orden ?? 0 }).execute();
  } else {
    // El tipo de cuenta es catálogo nuestro y se muestra traducido; el nombre de
    // un banco, no: "Banco República" es "Banco República" en portugués.
    const codigo = nombre.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    await operadorDb()
      .insertInto('tipo_cuenta_bancaria')
      .values({ pais, codigo, nombre_i18n: JSON.stringify({ es: nombre }), orden: d.orden ?? 0 })
      .execute();
  }
  return { ok: true };
}

export async function editarCatalogoPago(
  tabla: TablaCatalogoPago,
  id: string,
  c: { nombre?: string; activo?: boolean; orden?: number },
) {
  const set: { nombre?: string; activo?: boolean; orden?: number } = {};
  if (c.nombre !== undefined) set.nombre = c.nombre.trim();
  if (c.activo !== undefined) set.activo = c.activo;
  if (c.orden !== undefined) set.orden = c.orden;
  if (Object.keys(set).length === 0) return { ok: true };
  const r = await operadorDb().updateTable(tabla).set(set).where('id', '=', id).executeTakeFirst();
  if (Number(r.numUpdatedRows) === 0) throw new HttpError(404, 'No encontrado.');
  return { ok: true };
}

export async function eliminarCatalogoPago(tabla: TablaCatalogoPago, id: string) {
  const r = await operadorDb().deleteFrom(tabla).where('id', '=', id).executeTakeFirst();
  if (Number(r.numDeletedRows) === 0) throw new HttpError(404, 'No encontrado.');
  return { ok: true };
}

export { tablaValida };
