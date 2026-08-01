import { withUsuario, exigir } from '../auth/authz';
import { registrar } from './auditoria';
import { HttpError } from '../http/errors';

/**
 * Logo y colores de la cuenta.
 *
 * Importa más que en payroll: esto es lo que ve un firmante externo al abrir el
 * documento, muchas veces sin haber oído hablar de nosotros. Es la prueba
 * visual de que el correo no es una estafa. Por eso la lectura no exige
 * membresía —el externo tiene que poder verlo— y la escritura sí exige
 * administrar la cuenta.
 *
 * Vive en `marca` (migración 017), no en `empresa`: también una cuenta de tipo
 * persona puede tener la suya.
 */

const MAX_BYTES = 512 * 1024;
const MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'] as const;
type Mime = (typeof MIMES)[number];

export interface Logo {
  bytes: Buffer;
  mime: string;
}

export async function verLogo(cuentaId: string, identidadId: string): Promise<Logo | null> {
  return withUsuario(cuentaId, identidadId, async (trx) => {
    const r = await trx
      .selectFrom('marca')
      .select(['logo', 'logo_mime'])
      .where('cuenta_id', '=', cuentaId)
      .executeTakeFirst();
    if (!r?.logo || !r.logo_mime) return null;
    return { bytes: Buffer.from(r.logo as unknown as Uint8Array), mime: r.logo_mime };
  });
}

export async function verMarca(cuentaId: string, identidadId: string) {
  return withUsuario(cuentaId, identidadId, async (trx) => {
    const r = await trx
      .selectFrom('marca')
      .select(['logo_mime', 'logo_bytes', 'color_primario', 'color_texto'])
      .where('cuenta_id', '=', cuentaId)
      .executeTakeFirst();
    return {
      tiene_logo: !!r?.logo_mime,
      logo_mime: r?.logo_mime ?? null,
      logo_bytes: r?.logo_bytes ?? null,
      color_primario: r?.color_primario ?? null,
      color_texto: r?.color_texto ?? null,
    };
  });
}

export async function guardarLogo(
  cuentaId: string,
  identidadId: string,
  bytes: Buffer,
  mime: string,
): Promise<{ ok: true }> {
  if (!MIMES.includes(mime as Mime)) {
    throw new HttpError(400, 'El logo tiene que ser PNG, JPEG, WebP o SVG.');
  }
  if (bytes.length > MAX_BYTES) {
    throw new HttpError(400, `El logo no puede pasar de ${Math.round(MAX_BYTES / 1024)} KB.`);
  }

  return withUsuario(cuentaId, identidadId, async (trx, autz) => {
    exigir(autz, 'cuenta', 'administrar', 'No tenés permiso para cambiar la marca de la cuenta.');
    await trx
      .insertInto('marca')
      .values({ cuenta_id: cuentaId, logo: bytes, logo_mime: mime, logo_bytes: bytes.length })
      .onConflict((oc) =>
        oc.column('cuenta_id').doUpdateSet({
          logo: bytes,
          logo_mime: mime,
          logo_bytes: bytes.length,
          actualizada_en: new Date(),
        }),
      )
      .execute();
    await registrar(trx, cuentaId, identidadId, {
      accion: 'marca.logo_cambiado',
      recursoTipo: 'marca',
      recursoId: cuentaId,
      despues: { mime, bytes: bytes.length },
    });
    return { ok: true as const };
  });
}

export async function setColores(
  cuentaId: string,
  identidadId: string,
  primario: string | null,
  texto: string | null,
): Promise<{ ok: true }> {
  const ok = (c: string | null) => c === null || /^#[0-9a-fA-F]{6}$/.test(c);
  if (!ok(primario) || !ok(texto)) throw new HttpError(400, 'Los colores van en formato #RRGGBB.');

  return withUsuario(cuentaId, identidadId, async (trx, autz) => {
    exigir(autz, 'cuenta', 'administrar', 'No tenés permiso para cambiar la marca de la cuenta.');
    await trx
      .insertInto('marca')
      .values({ cuenta_id: cuentaId, color_primario: primario, color_texto: texto })
      .onConflict((oc) =>
        oc.column('cuenta_id').doUpdateSet({
          color_primario: primario,
          color_texto: texto,
          actualizada_en: new Date(),
        }),
      )
      .execute();
    await registrar(trx, cuentaId, identidadId, {
      accion: 'marca.colores',
      recursoTipo: 'marca',
      recursoId: cuentaId,
      despues: { primario, texto },
    });
    return { ok: true as const };
  });
}

export async function borrarLogo(cuentaId: string, identidadId: string): Promise<{ ok: true }> {
  return withUsuario(cuentaId, identidadId, async (trx, autz) => {
    exigir(autz, 'cuenta', 'administrar', 'No tenés permiso para cambiar la marca de la cuenta.');
    await trx
      .updateTable('marca')
      .set({ logo: null, logo_mime: null, logo_bytes: null, actualizada_en: new Date() })
      .where('cuenta_id', '=', cuentaId)
      .execute();
    await registrar(trx, cuentaId, identidadId, {
      accion: 'marca.logo_borrado',
      recursoTipo: 'marca',
      recursoId: cuentaId,
    });
    return { ok: true as const };
  });
}
