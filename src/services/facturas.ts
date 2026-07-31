import { withUsuario, puede, relacionEnAlcance, alcanceMaximoLectura } from '../auth/authz';
import { HttpError } from '../http/errors';
import { versionVigenteAFecha } from '../repositories/relaciones';
import { registrar } from './auditoria';
import type { Transaction } from 'kysely';
import type { DB } from '../db/schema';

/**
 * Facturas del proveedor unipersonal — su DOCUMENTO DE COBRO (flujo empresa->proveedor).
 *
 * Es un sub-dominio aparte del recibo de empleado y del billing del SaaS. La empresa
 * (rol con corrida:escribir, p.ej. liquidador/admin) las registra desde la consola; el
 * propio proveedor podrá cargarlas desde su portal (se agrega después). El monto es lo
 * que dice la factura; el sistema sólo SUGIERE los honorarios. Las retenciones fiscales
 * (IVA/IRPF) no se calculan acá — eso lo define el contador.
 *
 * Permisos (reusa los existentes, sin tocar la matriz de roles):
 *   - leer/listar  -> recibo:leer  (+ alcance de la relación)
 *   - registrar/pagar -> corrida:escribir
 */

export interface RegistrarFacturaInput {
  relacionId: string;
  periodo: string; // 'YYYY-MM'
  numero: string; // número de la factura que emite el proveedor
  fechaEmision: string; // 'YYYY-MM-DD'
  monto: number;
  moneda?: string; // si no viene, la de la empresa
  archivo?: ArchivoInput | null; // adjunto opcional (PDF/imagen)
}

// 'YYYY-MM' -> último día del mes 'YYYY-MM-DD' (para resolver la versión vigente).
function finDePeriodo(periodo: string): string {
  const [a, m] = periodo.split('-').map(Number);
  const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return `${periodo}-${String(ultimo).padStart(2, '0')}`;
}

async function regimenCodigoDe(trx: Transaction<DB>, relacionId: string): Promise<string | null> {
  const r = await trx
    .selectFrom('relacion_laboral as rl')
    .leftJoin('regimen as rg', 'rg.id', 'rl.regimen_id')
    .select('rg.codigo as codigo')
    .where('rl.id', '=', relacionId)
    .executeTakeFirst();
  return r?.codigo ?? null;
}

async function monedaEmpresa(trx: Transaction<DB>, cuentaId: string): Promise<string> {
  const e = await trx
    .selectFrom('empresa')
    .select('moneda')
    .where('id', '=', cuentaId)
    .executeTakeFirstOrThrow();
  return e.moneda;
}

const FACTURA_MIMES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);
const FACTURA_MAX = 3_000_000; // ~3 MB (el bodyLimit del server es 5 MB)

export interface ArchivoInput {
  base64: string;
  mime: string;
  nombre?: string;
}

// Valida el adjunto (PDF o imagen) y lo deja listo para persistir como bytea.
function prepararArchivo(
  archivo?: ArchivoInput | null,
): { bytes: Buffer; mime: string; nombre: string | null } | null {
  if (!archivo || !archivo.base64) return null;
  if (!FACTURA_MIMES.has(archivo.mime)) {
    throw new HttpError(400, 'Adjunto no soportado: subí un PDF o una imagen (PNG/JPG/WebP).');
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(archivo.base64, 'base64');
  } catch {
    throw new HttpError(400, 'No se pudo leer el adjunto.');
  }
  if (bytes.length === 0) throw new HttpError(400, 'El adjunto está vacío.');
  if (bytes.length > FACTURA_MAX) throw new HttpError(400, 'El adjunto supera 3 MB. Subí uno más liviano.');
  return { bytes, mime: archivo.mime, nombre: archivo.nombre ? archivo.nombre.slice(0, 200) : null };
}

/**
 * Monto sugerido para una factura del proveedor en un período: los honorarios
 * (tarifa mensual) de la versión vigente al fin del período. Es sólo una sugerencia
 * que quien carga la factura puede ajustar; el motor de liquidación no participa.
 */
export async function montoPropuesto(
  cuentaId: string,
  usuarioId: string,
  relacionId: string,
  periodo: string,
) {
  return withUsuario(cuentaId, usuarioId, async (trx, autz) => {
    if (!puede(autz, 'recibo', 'leer')) throw new HttpError(403, 'No tenés permiso para ver facturas.');
    if (!(await relacionEnAlcance(trx, relacionId, alcanceMaximoLectura(autz)))) {
      throw new HttpError(403, 'Ese proveedor está fuera de tu alcance.');
    }
    const version = await versionVigenteAFecha(trx, relacionId, finDePeriodo(periodo));
    return { monto: version ? version.tarifa : '0', moneda: await monedaEmpresa(trx, cuentaId) };
  });
}

/** Lista las facturas de un proveedor (relación). Lectura, con alcance. */
export async function listarFacturasDeRelacion(
  cuentaId: string,
  usuarioId: string,
  relacionId: string,
) {
  return withUsuario(cuentaId, usuarioId, async (trx, autz) => {
    if (!puede(autz, 'recibo', 'leer')) throw new HttpError(403, 'No tenés permiso para ver facturas.');
    if (!(await relacionEnAlcance(trx, relacionId, alcanceMaximoLectura(autz)))) {
      throw new HttpError(403, 'Ese proveedor está fuera de tu alcance.');
    }
    const filas = await trx
      .selectFrom('factura_proveedor')
      .select(['id', 'periodo', 'numero', 'fecha_emision', 'moneda', 'monto', 'estado', 'archivo_mime', 'created_at'])
      .where('relacion_id', '=', relacionId)
      .orderBy('fecha_emision', 'desc')
      .execute();
    const facturas = filas.map((f) => ({ ...f, tiene_archivo: !!f.archivo_mime }));
    return { puede_registrar: puede(autz, 'corrida', 'escribir'), facturas };
  });
}

/** Registra una factura del proveedor (escritura: gate corrida:escribir). */
export async function registrarFactura(
  cuentaId: string,
  usuarioId: string,
  input: RegistrarFacturaInput,
) {
  return withUsuario(cuentaId, usuarioId, async (trx, autz) => {
    if (!puede(autz, 'corrida', 'escribir')) {
      throw new HttpError(403, 'No tenés permiso para registrar facturas.');
    }
    if ((await regimenCodigoDe(trx, input.relacionId)) !== 'no_dependiente') {
      throw new HttpError(400, 'Las facturas son sólo para proveedores unipersonales.');
    }
    if (!/^[0-9]{4}-[0-9]{2}$/.test(input.periodo)) throw new HttpError(400, 'Período inválido (AAAA-MM).');
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(input.fechaEmision)) {
      throw new HttpError(400, 'Fecha inválida (AAAA-MM-DD).');
    }
    if (!input.numero?.trim()) throw new HttpError(400, 'El número de factura es obligatorio.');
    if (!(input.monto > 0)) throw new HttpError(400, 'El monto debe ser mayor a cero.');

    const moneda = (input.moneda ?? (await monedaEmpresa(trx, cuentaId))).slice(0, 3);
    const adj = prepararArchivo(input.archivo);
    const fila = await trx
      .insertInto('factura_proveedor')
      .values({
        cuenta_id: cuentaId,
        relacion_id: input.relacionId,
        periodo: input.periodo,
        numero: input.numero.trim(),
        fecha_emision: input.fechaEmision,
        moneda,
        monto: input.monto.toFixed(2),
        estado: 'recibida',
        archivo_bytes: adj?.bytes ?? null,
        archivo_mime: adj?.mime ?? null,
        archivo_ref: adj?.nombre ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await registrar(trx, cuentaId, usuarioId, {
      accion: 'factura.crear',
      recurso: 'factura_proveedor',
      objetoId: fila.id,
      detalle: { periodo: input.periodo, numero: input.numero.trim() },
    });
    return { id: fila.id };
  });
}

/** Marca una factura como pagada (escritura: gate corrida:escribir). */
export async function marcarFacturaPagada(cuentaId: string, usuarioId: string, facturaId: string) {
  return withUsuario(cuentaId, usuarioId, async (trx, autz) => {
    if (!puede(autz, 'corrida', 'escribir')) {
      throw new HttpError(403, 'No tenés permiso para actualizar facturas.');
    }
    const r = await trx
      .updateTable('factura_proveedor')
      .set({ estado: 'pagada' })
      .where('id', '=', facturaId)
      .executeTakeFirst();
    if (!r.numUpdatedRows) throw new HttpError(404, 'Factura no encontrada.');
    await registrar(trx, cuentaId, usuarioId, {
      accion: 'factura.pagar',
      recurso: 'factura_proveedor',
      objetoId: facturaId,
    });
    return { ok: true };
  });
}

// ---- Portal del proveedor (mi.html): opera sobre SU PROPIA relación ----
// No requiere permisos de empresa: la autorización es "es mi propia relación",
// resuelta por la persona del usuario logueado. La RLS sigue aplicando.

async function relacionDelUsuario(
  trx: Transaction<DB>,
  usuarioId: string,
): Promise<{ id: string; regimen_codigo: string | null } | null> {
  const u = await trx
    .selectFrom('usuario')
    .select('persona_id')
    .where('id', '=', usuarioId)
    .executeTakeFirst();
  if (!u?.persona_id) return null;
  const rel = await trx
    .selectFrom('relacion_laboral as rl')
    .leftJoin('regimen as rg', 'rg.id', 'rl.regimen_id')
    .select(['rl.id as id', 'rg.codigo as regimen_codigo'])
    .where('rl.persona_id', '=', u.persona_id)
    .where('rl.fecha_egreso', 'is', null)
    .orderBy('rl.fecha_ingreso', 'desc')
    .executeTakeFirst();
  return rel ?? null;
}

/** Facturas del proveedor logueado (su propia relación). */
export async function misFacturas(cuentaId: string, usuarioId: string) {
  return withUsuario(cuentaId, usuarioId, async (trx) => {
    const rel = await relacionDelUsuario(trx, usuarioId);
    if (!rel || rel.regimen_codigo !== 'no_dependiente') {
      return { es_proveedor: false, facturas: [] as unknown[] };
    }
    const filas = await trx
      .selectFrom('factura_proveedor')
      .select(['id', 'periodo', 'numero', 'fecha_emision', 'moneda', 'monto', 'estado', 'archivo_mime', 'created_at'])
      .where('relacion_id', '=', rel.id)
      .orderBy('fecha_emision', 'desc')
      .execute();
    const facturas = filas.map((f) => ({ ...f, tiene_archivo: !!f.archivo_mime }));
    return { es_proveedor: true, facturas };
  });
}

/** Monto sugerido (honorarios de la versión vigente) para el proveedor logueado. */
export async function miMontoPropuesto(cuentaId: string, usuarioId: string, periodo: string) {
  return withUsuario(cuentaId, usuarioId, async (trx) => {
    const moneda = await monedaEmpresa(trx, cuentaId);
    const rel = await relacionDelUsuario(trx, usuarioId);
    if (!rel || rel.regimen_codigo !== 'no_dependiente') return { monto: '0', moneda };
    const version = await versionVigenteAFecha(trx, rel.id, finDePeriodo(periodo));
    return { monto: version ? version.tarifa : '0', moneda };
  });
}

/** El proveedor logueado registra su propia factura. */
export async function registrarMiFactura(
  cuentaId: string,
  usuarioId: string,
  input: { periodo: string; numero: string; fechaEmision: string; monto: number; moneda?: string; archivo?: ArchivoInput | null },
) {
  return withUsuario(cuentaId, usuarioId, async (trx) => {
    const rel = await relacionDelUsuario(trx, usuarioId);
    if (!rel || rel.regimen_codigo !== 'no_dependiente') {
      throw new HttpError(403, 'Sólo un proveedor unipersonal puede cargar facturas.');
    }
    if (!/^[0-9]{4}-[0-9]{2}$/.test(input.periodo)) throw new HttpError(400, 'Período inválido (AAAA-MM).');
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(input.fechaEmision)) {
      throw new HttpError(400, 'Fecha inválida (AAAA-MM-DD).');
    }
    if (!input.numero?.trim()) throw new HttpError(400, 'El número de factura es obligatorio.');
    if (!(input.monto > 0)) throw new HttpError(400, 'El monto debe ser mayor a cero.');

    const moneda = (input.moneda ?? (await monedaEmpresa(trx, cuentaId))).slice(0, 3);
    const adj = prepararArchivo(input.archivo);
    const fila = await trx
      .insertInto('factura_proveedor')
      .values({
        cuenta_id: cuentaId,
        relacion_id: rel.id,
        periodo: input.periodo,
        numero: input.numero.trim(),
        fecha_emision: input.fechaEmision,
        moneda,
        monto: input.monto.toFixed(2),
        estado: 'recibida',
        archivo_bytes: adj?.bytes ?? null,
        archivo_mime: adj?.mime ?? null,
        archivo_ref: adj?.nombre ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await registrar(trx, cuentaId, usuarioId, {
      accion: 'factura.crear_propia',
      recurso: 'factura_proveedor',
      objetoId: fila.id,
      detalle: { periodo: input.periodo, numero: input.numero.trim() },
    });
    return { id: fila.id };
  });
}

/** Devuelve el adjunto de una factura (empresa: gate recibo:leer + alcance). null si no tiene. */
export async function archivoDeFactura(cuentaId: string, usuarioId: string, facturaId: string) {
  return withUsuario(cuentaId, usuarioId, async (trx, autz) => {
    if (!puede(autz, 'recibo', 'leer')) throw new HttpError(403, 'No tenés permiso para ver facturas.');
    const f = await trx
      .selectFrom('factura_proveedor')
      .select(['relacion_id', 'archivo_bytes', 'archivo_mime', 'archivo_ref'])
      .where('id', '=', facturaId)
      .executeTakeFirst();
    if (!f || !f.archivo_bytes || !f.archivo_mime) return null;
    if (!(await relacionEnAlcance(trx, f.relacion_id, alcanceMaximoLectura(autz)))) {
      throw new HttpError(403, 'Ese proveedor está fuera de tu alcance.');
    }
    return { buffer: f.archivo_bytes as Buffer, mime: f.archivo_mime, nombre: f.archivo_ref ?? 'factura' };
  });
}

/** Devuelve el adjunto de una de MIS facturas (proveedor). null si no tiene o no es suya. */
export async function miArchivoDeFactura(cuentaId: string, usuarioId: string, facturaId: string) {
  return withUsuario(cuentaId, usuarioId, async (trx) => {
    const rel = await relacionDelUsuario(trx, usuarioId);
    if (!rel) return null;
    const f = await trx
      .selectFrom('factura_proveedor')
      .select(['archivo_bytes', 'archivo_mime', 'archivo_ref'])
      .where('id', '=', facturaId)
      .where('relacion_id', '=', rel.id)
      .executeTakeFirst();
    if (!f || !f.archivo_bytes || !f.archivo_mime) return null;
    return { buffer: f.archivo_bytes as Buffer, mime: f.archivo_mime, nombre: f.archivo_ref ?? 'factura' };
  });
}
