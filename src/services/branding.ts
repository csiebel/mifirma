import { withUsuario, puede } from '../auth/authz';
import { HttpError } from '../http/errors';

// El logo es identidad visual de la empresa. Vive en el dominio del tenant
// (tabla empresa, bajo RLS). Cargarlo/quitarlo lo puede hacer quien administra
// la empresa (mismo permiso que gestionar usuarios: 'usuario' + 'escribir').

const MIMES = new Set(['image/png', 'image/jpeg']);
const MAX_BYTES = 500 * 1024; // 500 KB

export interface Logo {
  buffer: Buffer;
  mime: string;
}

// Devuelve el logo actual (bytes + mime) o null si no hay.
export async function verLogo(cuentaId: string, usuarioId: string): Promise<Logo | null> {
  return withUsuario(cuentaId, usuarioId, async (trx) => {
    const row = await trx
      .selectFrom('empresa')
      .select(['logo', 'logo_mime'])
      .where('id', '=', cuentaId)
      .executeTakeFirst();
    if (!row?.logo || !row.logo_mime) return null;
    return { buffer: row.logo as Buffer, mime: row.logo_mime };
  });
}

// Guarda el logo (base64 ya sin el prefijo data:). Valida formato y tamaño.
export async function guardarLogo(
  cuentaId: string,
  usuarioId: string,
  base64: string,
  mime: string,
): Promise<{ ok: true; bytes: number; mime: string }> {
  if (!MIMES.has(mime)) throw new HttpError(400, 'Formato no soportado: usá PNG o JPG.');
  let buffer: Buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch {
    throw new HttpError(400, 'No se pudo leer la imagen.');
  }
  if (buffer.length === 0) throw new HttpError(400, 'La imagen está vacía.');
  if (buffer.length > MAX_BYTES) throw new HttpError(400, 'La imagen supera 500 KB. Subí una más liviana.');

  return withUsuario(cuentaId, usuarioId, async (trx, autz) => {
    if (!puede(autz, 'usuario', 'escribir')) {
      throw new HttpError(403, 'No tenés permiso para configurar la empresa.');
    }
    await trx
      .updateTable('empresa')
      .set({ logo: buffer, logo_mime: mime })
      .where('id', '=', cuentaId)
      .execute();
    return { ok: true, bytes: buffer.length, mime };
  });
}

// Quita el logo.
export async function borrarLogo(cuentaId: string, usuarioId: string): Promise<{ ok: true }> {
  return withUsuario(cuentaId, usuarioId, async (trx, autz) => {
    if (!puede(autz, 'usuario', 'escribir')) {
      throw new HttpError(403, 'No tenés permiso para configurar la empresa.');
    }
    await trx
      .updateTable('empresa')
      .set({ logo: null, logo_mime: null })
      .where('id', '=', cuentaId)
      .execute();
    return { ok: true };
  });
}
