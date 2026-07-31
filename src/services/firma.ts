import { withUsuario, puede } from '../auth/authz';
import { ownerDb } from '../db/owner';
import { HttpError } from '../http/errors';

// Firma de recibos. La versión simple (acuse de conformidad con sello de tiempo) vive
// acá completa. La avanzada se apoya en proveedores acreditados por país, que son un
// catálogo de plataforma que gestiona el operador; la integración real con cada uno es
// una fase posterior. La firma nunca modifica el recibo (inmutable).

// data:image/png;base64,... -> { bytes, mime }. Acotado a PNG/JPEG/WebP y a ~2MB.
function prepararImagenFirma(dataUrl: string | null | undefined): { bytes: Buffer; mime: string } | null {
  if (!dataUrl) return null;
  const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(dataUrl.trim());
  if (!m) return null;
  try {
    const bytes = Buffer.from(m[2], 'base64');
    if (!bytes.length || bytes.length > 2_000_000) return null;
    return { bytes, mime: m[1] };
  } catch {
    return null;
  }
}

// ===================== LADO OPERADOR (catálogo, ownerDb) =====================

export interface FirmaProveedorInput {
  pais?: string;
  nombre?: string;
  sitio_url?: string | null;
  orden?: number;
}

export async function listarFirmaProveedores() {
  const proveedores = await ownerDb()
    .selectFrom('firma_proveedor')
    .selectAll()
    .orderBy('pais')
    .orderBy('orden')
    .orderBy('nombre')
    .execute();
  return { proveedores };
}

export async function crearFirmaProveedor(input: FirmaProveedorInput): Promise<{ id: string }> {
  const pais = (input.pais || '').trim().toUpperCase();
  const nombre = (input.nombre || '').trim();
  if (!pais) throw new HttpError(400, 'Indicá el país (por ejemplo UY o PY).');
  if (!nombre) throw new HttpError(400, 'El proveedor necesita un nombre.');
  const row = await ownerDb()
    .insertInto('firma_proveedor')
    .values({ pais, nombre, sitio_url: input.sitio_url?.trim() || null, orden: input.orden ?? 0 })
    .returning(['id'])
    .executeTakeFirstOrThrow();
  return { id: row.id };
}

export async function editarFirmaProveedor(id: string, input: FirmaProveedorInput): Promise<{ ok: true }> {
  const set: Record<string, unknown> = {};
  if (input.pais !== undefined) set.pais = (input.pais || '').trim().toUpperCase();
  if (input.nombre !== undefined) {
    const n = input.nombre.trim();
    if (!n) throw new HttpError(400, 'El nombre no puede quedar vacío.');
    set.nombre = n;
  }
  if (input.sitio_url !== undefined) set.sitio_url = input.sitio_url?.trim() || null;
  if (input.orden !== undefined) set.orden = input.orden;
  if (Object.keys(set).length) {
    await ownerDb().updateTable('firma_proveedor').set(set).where('id', '=', id).execute();
  }
  return { ok: true };
}

export async function setFirmaProveedorActivo(id: string, activo: boolean): Promise<{ ok: true }> {
  await ownerDb().updateTable('firma_proveedor').set({ activo }).where('id', '=', id).execute();
  return { ok: true };
}

export async function setFirmaProveedorIntegrado(id: string, integrado: boolean): Promise<{ ok: true }> {
  await ownerDb().updateTable('firma_proveedor').set({ integrado }).where('id', '=', id).execute();
  return { ok: true };
}

export async function borrarFirmaProveedor(id: string): Promise<{ ok: true }> {
  await ownerDb().deleteFrom('firma_proveedor').where('id', '=', id).execute();
  return { ok: true };
}

// ===================== LADO EMPLEADO (firma simple, RLS) =====================

/** Firma del empleado sobre su recibo, con sello de tiempo. Si hay dibujo (o firma guardada),
 *  queda como firma gráfica con la imagen incrustada; si no, es el acuse simple. */
export async function firmarRecibo(
  cuentaId: string,
  usuarioId: string,
  reciboId: string,
  meta: { ip?: string; userAgent?: string; imagen?: string },
): Promise<{ ok: true; firmado_at: string }> {
  return withUsuario(cuentaId, usuarioId, async (trx) => {
    const empresa = await trx
      .selectFrom('empresa')
      .select(['firma_modalidad'])
      .where('id', '=', cuentaId)
      .executeTakeFirst();
    if (empresa?.firma_modalidad === 'ninguna') {
      throw new HttpError(409, 'La firma de recibos no está habilitada en tu empresa.');
    }

    const usuario = await trx
      .selectFrom('usuario')
      .select(['persona_id'])
      .where('id', '=', usuarioId)
      .executeTakeFirst();
    if (!usuario?.persona_id) throw new HttpError(403, 'Tu usuario no tiene una persona asociada.');

    const recibo = await trx
      .selectFrom('recibo as r')
      .innerJoin('relacion_laboral as rl', 'rl.id', 'r.relacion_id')
      .select(['r.id as id'])
      .where('r.id', '=', reciboId)
      .where('rl.persona_id', '=', usuario.persona_id)
      .executeTakeFirst();
    if (!recibo) throw new HttpError(404, 'No encontramos ese recibo entre los tuyos.');

    // Firma gráfica: si vino un dibujo nuevo lo guardamos como su firma reutilizable;
    // si no, usamos la que ya tenga guardada. La imagen queda congelada en este recibo.
    let firmaImg = prepararImagenFirma(meta.imagen);
    if (firmaImg) {
      await trx
        .insertInto('firma_empleado')
        .values({
          cuenta_id: cuentaId,
          persona_id: usuario.persona_id,
          imagen_bytes: firmaImg.bytes,
          imagen_mime: firmaImg.mime,
        })
        .onConflict((oc) =>
          oc.columns(['cuenta_id', 'persona_id']).doUpdateSet({ imagen_bytes: firmaImg!.bytes, imagen_mime: firmaImg!.mime }),
        )
        .execute();
    } else {
      const fe = await trx
        .selectFrom('firma_empleado')
        .select(['imagen_bytes', 'imagen_mime'])
        .where('persona_id', '=', usuario.persona_id)
        .executeTakeFirst();
      if (fe?.imagen_bytes) {
        firmaImg = {
          bytes: Buffer.isBuffer(fe.imagen_bytes) ? fe.imagen_bytes : Buffer.from(fe.imagen_bytes as unknown as Buffer),
          mime: fe.imagen_mime || 'image/png',
        };
      }
    }
    const modalidad = firmaImg ? 'grafica' : 'simple';

    const ahora = new Date();
    await trx
      .insertInto('recibo_firma')
      .values({
        cuenta_id: cuentaId,
        recibo_id: reciboId,
        usuario_id: usuarioId,
        modalidad,
        firmado_at: ahora,
        ip: meta.ip || null,
        user_agent: meta.userAgent || null,
        firma_bytes: firmaImg?.bytes ?? null,
        firma_mime: firmaImg?.mime ?? null,
      })
      .onConflict((oc) =>
        firmaImg
          ? oc.column('recibo_id').doUpdateSet({ modalidad, firma_bytes: firmaImg.bytes, firma_mime: firmaImg.mime })
          : oc.column('recibo_id').doNothing(),
      )
      .execute();

    const fila = await trx
      .selectFrom('recibo_firma')
      .select(['firmado_at'])
      .where('recibo_id', '=', reciboId)
      .executeTakeFirst();
    return { ok: true, firmado_at: (fila?.firmado_at ?? ahora).toISOString() };
  });
}

// ===================== CONFIG DE FIRMA POR EMPRESA (lado empresa) =====================

/** Devuelve la modalidad/proveedor de firma de la empresa y los proveedores de su país. */
export async function verConfigFirma(cuentaId: string, usuarioId: string) {
  return withUsuario(cuentaId, usuarioId, async (trx) => {
    const empresa = await trx
      .selectFrom('empresa')
      .select(['firma_modalidad', 'firma_proveedor_id', 'pais'])
      .where('id', '=', cuentaId)
      .executeTakeFirst();
    const proveedores = await trx
      .selectFrom('firma_proveedor')
      .select(['id', 'nombre', 'integrado'])
      .where('pais', '=', empresa?.pais ?? '')
      .where('activo', '=', true)
      .orderBy('orden')
      .orderBy('nombre')
      .execute();
    return {
      modalidad: empresa?.firma_modalidad ?? 'simple',
      proveedor_id: empresa?.firma_proveedor_id ?? null,
      proveedores,
    };
  });
}

/** Guarda la modalidad de firma (y el proveedor si es avanzada). Requiere usuario:escribir. */
export async function setConfigFirma(
  cuentaId: string,
  usuarioId: string,
  modalidad: string,
  proveedorId: string | null,
): Promise<{ ok: true }> {
  if (!['ninguna', 'simple', 'avanzada'].includes(modalidad)) {
    throw new HttpError(400, 'Modalidad de firma inválida.');
  }
  return withUsuario(cuentaId, usuarioId, async (trx, autz) => {
    if (!puede(autz, 'usuario', 'escribir')) {
      throw new HttpError(403, 'No tenés permiso para configurar la empresa.');
    }
    let provId: string | null = null;
    if (modalidad === 'avanzada') {
      if (!proveedorId) throw new HttpError(400, 'Elegí un proveedor de firma avanzada.');
      const empresa = await trx
        .selectFrom('empresa')
        .select(['pais'])
        .where('id', '=', cuentaId)
        .executeTakeFirst();
      const prov = await trx
        .selectFrom('firma_proveedor')
        .select(['id'])
        .where('id', '=', proveedorId)
        .where('pais', '=', empresa?.pais ?? '')
        .where('activo', '=', true)
        .executeTakeFirst();
      if (!prov) throw new HttpError(400, 'El proveedor elegido no es válido para tu país.');
      provId = proveedorId;
    }
    await trx
      .updateTable('empresa')
      .set({ firma_modalidad: modalidad, firma_proveedor_id: provId })
      .where('id', '=', cuentaId)
      .execute();
    return { ok: true };
  });
}

// ===================== FIRMA REUTILIZABLE DEL EMPLEADO (RLS, alcance propio) =====================

/** Devuelve la firma guardada del empleado como data URL, o null si no tiene. */
export async function obtenerFirmaEmpleado(
  cuentaId: string,
  usuarioId: string,
): Promise<{ imagen: string } | null> {
  return withUsuario(cuentaId, usuarioId, async (trx) => {
    const usuario = await trx.selectFrom('usuario').select(['persona_id']).where('id', '=', usuarioId).executeTakeFirst();
    if (!usuario?.persona_id) return null;
    const f = await trx
      .selectFrom('firma_empleado')
      .select(['imagen_bytes', 'imagen_mime'])
      .where('persona_id', '=', usuario.persona_id)
      .executeTakeFirst();
    if (!f?.imagen_bytes) return null;
    const buf = Buffer.isBuffer(f.imagen_bytes) ? f.imagen_bytes : Buffer.from(f.imagen_bytes as unknown as Buffer);
    return { imagen: 'data:' + (f.imagen_mime || 'image/png') + ';base64,' + buf.toString('base64') };
  });
}

/** Igual que obtenerFirmaEmpleado pero devuelve los bytes crudos (para incrustar en PDFs). */
export async function obtenerFirmaEmpleadoBytes(
  cuentaId: string,
  usuarioId: string,
): Promise<{ bytes: Buffer; mime: string } | null> {
  return withUsuario(cuentaId, usuarioId, async (trx) => {
    const usuario = await trx.selectFrom('usuario').select(['persona_id']).where('id', '=', usuarioId).executeTakeFirst();
    if (!usuario?.persona_id) return null;
    const f = await trx
      .selectFrom('firma_empleado')
      .select(['imagen_bytes', 'imagen_mime'])
      .where('persona_id', '=', usuario.persona_id)
      .executeTakeFirst();
    if (!f?.imagen_bytes) return null;
    return {
      bytes: Buffer.isBuffer(f.imagen_bytes) ? f.imagen_bytes : Buffer.from(f.imagen_bytes as unknown as Buffer),
      mime: f.imagen_mime || 'image/png',
    };
  });
}

/** Guarda (o reemplaza) la firma reutilizable del empleado a partir de un data URL. */
export async function guardarFirmaEmpleado(
  cuentaId: string,
  usuarioId: string,
  imagen: string,
): Promise<{ ok: true }> {
  const img = prepararImagenFirma(imagen);
  if (!img) throw new HttpError(400, 'No pudimos leer la firma. Dibujala de nuevo e intentá otra vez.');
  return withUsuario(cuentaId, usuarioId, async (trx) => {
    const usuario = await trx.selectFrom('usuario').select(['persona_id']).where('id', '=', usuarioId).executeTakeFirst();
    if (!usuario?.persona_id) throw new HttpError(403, 'Tu usuario no tiene una persona asociada.');
    await trx
      .insertInto('firma_empleado')
      .values({ cuenta_id: cuentaId, persona_id: usuario.persona_id, imagen_bytes: img.bytes, imagen_mime: img.mime })
      .onConflict((oc) => oc.columns(['cuenta_id', 'persona_id']).doUpdateSet({ imagen_bytes: img.bytes, imagen_mime: img.mime }))
      .execute();
    return { ok: true };
  });
}
