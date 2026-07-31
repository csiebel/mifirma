import { ownerDb } from '../db/owner';
import { HttpError } from '../http/errors';
import { cifrar, descifrar, enmascarar } from '../operador/cripto';

// Config única del conector de facturación de la plataforma. Por ahora un solo
// proveedor (Nodum, el ERP de Interfase). El operador elige el modo de entrega.
const PROVEEDOR = 'nodum';

export interface DatosIntegracionFact {
  modo: 'api' | 'archivo';
  apiUrl?: string | null;
  apiCredencial?: string; // si viene vacío en edición, NO se cambia
  archivoFormato?: string | null;
}

/** Config actual (la credencial se devuelve enmascarada, nunca en claro). */
export async function verIntegracionFacturacion() {
  const r = await ownerDb()
    .selectFrom('integracion_facturacion')
    .select(['proveedor', 'modo', 'api_url', 'api_credencial_cifrada', 'archivo_formato', 'activo'])
    .where('proveedor', '=', PROVEEDOR)
    .executeTakeFirst();
  if (!r) {
    return { proveedor: PROVEEDOR, modo: 'archivo', api_url: '', archivo_formato: '', credencial_mask: '', tiene_credencial: false, activo: false };
  }
  return {
    proveedor: r.proveedor,
    modo: r.modo,
    api_url: r.api_url ?? '',
    archivo_formato: r.archivo_formato ?? '',
    credencial_mask: enmascarar(r.api_credencial_cifrada),
    tiene_credencial: !!r.api_credencial_cifrada,
    activo: r.activo,
  };
}

/** Crea o actualiza la config. La credencial vacía no se toca (igual que pasarelas). */
export async function guardarIntegracionFacturacion(d: DatosIntegracionFact) {
  if (d.modo !== 'api' && d.modo !== 'archivo') throw new HttpError(400, 'Modo inválido (api | archivo).');
  const existe = await ownerDb()
    .selectFrom('integracion_facturacion')
    .select('id')
    .where('proveedor', '=', PROVEEDOR)
    .executeTakeFirst();

  if (existe) {
    const set: Partial<{ modo: string; api_url: string | null; api_credencial_cifrada: string; archivo_formato: string | null }> = {
      modo: d.modo,
      api_url: d.apiUrl ?? null,
      archivo_formato: d.archivoFormato ?? null,
    };
    if (d.apiCredencial) set.api_credencial_cifrada = cifrar(d.apiCredencial);
    await ownerDb().updateTable('integracion_facturacion').set(set).where('proveedor', '=', PROVEEDOR).execute();
  } else {
    await ownerDb()
      .insertInto('integracion_facturacion')
      .values({
        proveedor: PROVEEDOR,
        modo: d.modo,
        api_url: d.apiUrl ?? null,
        api_credencial_cifrada: d.apiCredencial ? cifrar(d.apiCredencial) : null,
        archivo_formato: d.archivoFormato ?? null,
        activo: false,
      })
      .execute();
  }
  return { ok: true };
}

/** Activa o desactiva el conector. Para activar exige lo mínimo de cada modo. */
export async function setIntegracionFacturacionActiva(activo: boolean) {
  const r = await ownerDb()
    .selectFrom('integracion_facturacion')
    .select(['modo', 'api_url', 'api_credencial_cifrada', 'archivo_formato'])
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
  await ownerDb().updateTable('integracion_facturacion').set({ activo }).where('proveedor', '=', PROVEEDOR).execute();
  return { ok: true };
}

/**
 * Config con la credencial DESCIFRADA, para uso INTERNO de la entrega a Nodum (no se
 * expone por HTTP). La lógica de envío real se implementa cuando Interfase confirme
 * el endpoint/layout; esta función deja lista la lectura de la config.
 */
export async function configIntegracionInterna() {
  const r = await ownerDb()
    .selectFrom('integracion_facturacion')
    .select(['proveedor', 'modo', 'api_url', 'api_credencial_cifrada', 'archivo_formato', 'activo'])
    .where('proveedor', '=', PROVEEDOR)
    .executeTakeFirst();
  if (!r) return null;
  return {
    proveedor: r.proveedor,
    modo: r.modo,
    activo: r.activo,
    apiUrl: r.api_url ?? '',
    apiCredencial: descifrar(r.api_credencial_cifrada),
    archivoFormato: r.archivo_formato ?? '',
  };
}
