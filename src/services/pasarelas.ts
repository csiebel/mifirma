import { ownerDb } from '../db/owner';
import { HttpError } from '../http/errors';
import { cifrar, descifrar, enmascarar } from '../operador/cripto';

// Proveedores soportados por la UI (PayPal primero; el resto se implementa después).
export const PROVEEDORES = ['paypal', 'stripe', 'mercadopago', 'dlocal'] as const;
export type Proveedor = (typeof PROVEEDORES)[number];

export interface DatosPasarela {
  proveedor: string;
  nombre: string;
  modo?: 'sandbox' | 'produccion';
  clientId?: string | null;
  clientSecret?: string; // si viene vacío en edición, NO se cambia
  webhookSecret?: string; // idem
}

/** Lista las pasarelas configuradas. Los secretos se devuelven enmascarados. */
export async function listarPasarelas() {
  const filas = await ownerDb()
    .selectFrom('pasarela_pago')
    .select([
      'proveedor',
      'nombre',
      'modo',
      'client_id',
      'client_secret_cifrado',
      'webhook_secret_cifrado',
      'activa',
    ])
    .orderBy('proveedor')
    .execute();
  return {
    pasarelas: filas.map((p) => ({
      proveedor: p.proveedor,
      nombre: p.nombre,
      modo: p.modo,
      client_id: p.client_id ?? '',
      client_secret_mask: enmascarar(p.client_secret_cifrado),
      webhook_secret_mask: enmascarar(p.webhook_secret_cifrado),
      tiene_secret: !!p.client_secret_cifrado,
      activo: p.activa,
    })),
  };
}

/** Crea o actualiza la configuración de una pasarela. Los secretos vacíos no se tocan. */
export async function guardarPasarela(d: DatosPasarela) {
  if (!(PROVEEDORES as readonly string[]).includes(d.proveedor)) {
    throw new HttpError(400, `Proveedor no soportado: ${d.proveedor}`);
  }
  const existe = await ownerDb()
    .selectFrom('pasarela_pago')
    .select('id')
    .where('proveedor', '=', d.proveedor)
    .executeTakeFirst();

  if (existe) {
    const set: Partial<{
      nombre: string;
      modo: string;
      client_id: string | null;
      client_secret_cifrado: string;
      webhook_secret_cifrado: string;
    }> = {
      nombre: d.nombre,
      modo: d.modo ?? 'sandbox',
      client_id: d.clientId ?? null,
    };
    if (d.clientSecret) set.client_secret_cifrado = cifrar(d.clientSecret);
    if (d.webhookSecret) set.webhook_secret_cifrado = cifrar(d.webhookSecret);
    await ownerDb().updateTable('pasarela_pago').set(set).where('proveedor', '=', d.proveedor).execute();
  } else {
    await ownerDb()
      .insertInto('pasarela_pago')
      .values({
        proveedor: d.proveedor,
        nombre: d.nombre,
        modo: d.modo ?? 'sandbox',
          client_id: d.clientId ?? null,
        client_secret_cifrado: d.clientSecret ? cifrar(d.clientSecret) : null,
        webhook_secret_cifrado: d.webhookSecret ? cifrar(d.webhookSecret) : null,
        activa: false,
      })
      .execute();
  }
  return { ok: true, proveedor: d.proveedor };
}

/** Activa o desactiva una pasarela. Para activar exige credenciales cargadas. */
export async function setPasarelaActiva(proveedor: string, activo: boolean) {
  const p = await ownerDb()
    .selectFrom('pasarela_pago')
    .select(['client_id', 'client_secret_cifrado'])
    .where('proveedor', '=', proveedor)
    .executeTakeFirst();
  if (!p) throw new HttpError(404, `Pasarela no encontrada: ${proveedor}`);
  if (activo && (!p.client_id || !p.client_secret_cifrado)) {
    throw new HttpError(400, 'No se puede activar: faltan credenciales (Client ID y Client Secret).');
  }
  await ownerDb().updateTable('pasarela_pago').set({ activa: activo }).where('proveedor', '=', proveedor).execute();
  return { ok: true };
}

export async function eliminarPasarela(proveedor: string) {
  const del = await ownerDb()
    .deleteFrom('pasarela_pago')
    .where('proveedor', '=', proveedor)
    .executeTakeFirstOrThrow();
  if (Number(del.numDeletedRows) === 0) throw new HttpError(404, `Pasarela no encontrada: ${proveedor}`);
  return { ok: true };
}

/**
 * Credenciales descifradas de una pasarela activa, para uso INTERNO del cobro
 * (no se expone por HTTP). Lo usará la integración funcional del próximo paso.
 */
export async function credencialesDe(proveedor: string) {
  const p = await ownerDb()
    .selectFrom('pasarela_pago')
    .select(['proveedor', 'modo', 'client_id', 'client_secret_cifrado', 'webhook_secret_cifrado', 'activa'])
    .where('proveedor', '=', proveedor)
    .executeTakeFirst();
  if (!p) return null;
  return {
    proveedor: p.proveedor,
    modo: p.modo,
    activo: p.activa,
    clientId: p.client_id ?? '',
    clientSecret: descifrar(p.client_secret_cifrado),
    webhookSecret: descifrar(p.webhook_secret_cifrado),
  };
}
