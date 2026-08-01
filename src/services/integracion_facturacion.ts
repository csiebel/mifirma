import { operadorDb } from '../db/pool';
import { HttpError } from '../http/errors';
import { cifrar, descifrar, enmascarar } from '../operador/cripto';

// Conector de facturación electrónica de la plataforma.
//
// ⚠ ES POR PAÍS, no único. Cada país tiene su régimen y su proveedor homologado
// —DGI en Uruguay, SET en Paraguay, NF-e / NFS-e en Brasil— y una factura
// emitida bajo el régimen equivocado no es un problema de software: es un
// problema fiscal. Por eso la tabla tiene clave (pais, proveedor, modo) y todas
// estas funciones reciben el país.
const PROVEEDOR = 'nodum';

export interface DatosIntegracionFact {
  modo: 'api' | 'archivo';
  apiUrl?: string | null;
  apiCredencial?: string; // si viene vacío en edición, NO se cambia
  archivoFormato?: string | null;
}

/** Config actual (la credencial se devuelve enmascarada, nunca en claro). */
export async function verIntegracionFacturacion(pais: string) {
  const r = await operadorDb()
    .selectFrom('integracion_facturacion')
    .select(['proveedor', 'modo', 'api_url', 'api_credencial_cifrada', 'archivo_formato', 'activa'])
    .where('pais', '=', pais)
    .where('proveedor', '=', PROVEEDOR)
    .executeTakeFirst();
  if (!r) {
    return { pais, proveedor: PROVEEDOR, modo: 'archivo', api_url: '', archivo_formato: '', credencial_mask: '', tiene_credencial: false, activo: false };
  }
  return {
    proveedor: r.proveedor,
    modo: r.modo,
    api_url: r.api_url ?? '',
    archivo_formato: r.archivo_formato ?? '',
    credencial_mask: enmascarar(r.api_credencial_cifrada),
    tiene_credencial: !!r.api_credencial_cifrada,
    activo: r.activa,
  };
}

/** Crea o actualiza la config. La credencial vacía no se toca (igual que pasarelas). */
export async function guardarIntegracionFacturacion(pais: string, d: DatosIntegracionFact) {
  if (d.modo !== 'api' && d.modo !== 'archivo') throw new HttpError(400, 'Modo inválido (api | archivo).');
  const existe = await operadorDb()
    .selectFrom('integracion_facturacion')
    .select('id')
    .where('pais', '=', pais)
    .where('proveedor', '=', PROVEEDOR)
    .executeTakeFirst();

  if (existe) {
    const set: Partial<{ modo: string; api_url: string | null; api_credencial_cifrada: string; archivo_formato: string | null }> = {
      modo: d.modo,
      api_url: d.apiUrl ?? null,
      archivo_formato: d.archivoFormato ?? null,
    };
    if (d.apiCredencial) set.api_credencial_cifrada = cifrar(d.apiCredencial);
    await operadorDb().updateTable('integracion_facturacion').set(set).where('pais', '=', pais)
    .where('pais', '=', pais).where('proveedor', '=', PROVEEDOR).execute();
  } else {
    await operadorDb()
      .insertInto('integracion_facturacion')
      .values({
        pais,
        proveedor: PROVEEDOR,
        modo: d.modo,
        api_url: d.apiUrl ?? null,
        api_credencial_cifrada: d.apiCredencial ? cifrar(d.apiCredencial) : null,
        archivo_formato: d.archivoFormato ?? null,
        activa: false,
      })
      .execute();
  }
  return { ok: true };
}

/** Activa o desactiva el conector. Para activar exige lo mínimo de cada modo. */
export async function setIntegracionFacturacionActiva(pais: string, activo: boolean) {
  const r = await operadorDb()
    .selectFrom('integracion_facturacion')
    .select(['modo', 'api_url', 'api_credencial_cifrada', 'archivo_formato'])
    .where('pais', '=', pais)
    .where('proveedor', '=', PROVEEDOR)
    .executeTakeFirst();
  if (!r) throw new HttpError(404, 'La integración no está configurada todavía.');
  if (activo) {
    if (r.modo === 'api' && (!r.api_url || !r.api_credencial_cifrada)) {
      throw new HttpError(400, 'Para activar el modo API faltan la URL y la credencial.');
    }
    if (r.modo === 'archivo' && !r.archivo_formato) {
      throw new HttpError(400, 'Para activar el modo Archivo falta indicar el formato.');
    }
  }
  await operadorDb().updateTable('integracion_facturacion').set({ activa: activo }).where('pais', '=', pais)
    .where('pais', '=', pais).where('proveedor', '=', PROVEEDOR).execute();
  return { ok: true };
}

/**
 * Config con la credencial DESCIFRADA, para uso INTERNO de la entrega a Nodum (no se
 * expone por HTTP). La lógica de envío real se implementa cuando Interfase confirme
 * el endpoint/layout; esta función deja lista la lectura de la config.
 */
export async function configIntegracionInterna(pais: string) {
  const r = await operadorDb()
    .selectFrom('integracion_facturacion')
    .select(['proveedor', 'modo', 'api_url', 'api_credencial_cifrada', 'archivo_formato', 'activa'])
    .where('pais', '=', pais)
    .where('proveedor', '=', PROVEEDOR)
    .executeTakeFirst();
  if (!r) return null;
  return {
    proveedor: r.proveedor,
    modo: r.modo,
    activo: r.activa,
    apiUrl: r.api_url ?? '',
    apiCredencial: descifrar(r.api_credencial_cifrada),
    archivoFormato: r.archivo_formato ?? '',
  };
}
