import { operadorDb } from '../db/pool';
import { HttpError } from '../http/errors';
import { getI18n, IDIOMAS, type Idioma } from '../i18n/textos';

// Diccionario editable del operador. Los textos de interfaz viven en código
// (i18n/textos.ts) como DEFAULTS; esta capa guarda solo los OVERRIDES que el
// operador edita en la consola. Es config global de plataforma → todo va por
// operadorDb (mifirma_owner), igual que correo/twilio/pasarela. No hay RLS.

function esIdiomaValido(id: string): id is Idioma {
  return (IDIOMAS as readonly string[]).includes(id);
}

// {placeholders} que un texto necesita conservar (ej. {email}, {canal}).
function placeholdersDe(s: string): string[] {
  return s.match(/\{[^}]+\}/g) || [];
}

// Overrides de un idioma como mapa clave -> valor.
async function overridesDe(idioma: string): Promise<Record<string, string>> {
  const filas = await operadorDb()
    .selectFrom('traduccion_override')
    .select(['clave', 'valor'])
    .where('idioma', '=', idioma)
    .execute();
  const m: Record<string, string> = {};
  for (const f of filas) m[f.clave] = f.valor;
  return m;
}

// i18n para servir al cliente: defaults de código con los overrides aplicados
// encima. Resiliente: si la base falla, cae a los defaults (no rompe la UI).
export async function getI18nConOverrides(idioma?: string) {
  const base = getI18n(idioma);
  let ov: Record<string, string> = {};
  try {
    ov = await overridesDe(base.idioma);
  } catch {
    ov = {};
  }
  return { ...base, ui: { ...base.ui, ...ov } };
}

// Para el editor del operador: todas las claves de ese idioma con su valor por
// defecto (de código, con fallback a ES) y su override actual si existe.
export async function listarTraducciones(idioma: string) {
  if (!esIdiomaValido(idioma)) throw new HttpError(400, 'Idioma inválido.');
  const def = getI18n(idioma).ui as Record<string, string>;
  const ov = await overridesDe(idioma);
  const claves = new Set<string>([...Object.keys(def), ...Object.keys(ov)]);
  const items = [...claves].sort().map((clave) => ({
    clave,
    def: def[clave] ?? '',
    ov: ov[clave] ?? null,
  }));
  return { idioma, items };
}

export async function setTraduccion(idioma: string, clave: string, valor: string) {
  if (!esIdiomaValido(idioma)) throw new HttpError(400, 'Idioma inválido.');
  const c = (clave || '').trim();
  if (!c) throw new HttpError(400, 'Falta la clave.');
  const v = valor ?? '';
  if (!v.trim()) {
    throw new HttpError(400, 'El texto no puede quedar vacío. Para volver al original, usá restablecer.');
  }
  // El override debe conservar los {placeholders} que el texto original necesita.
  const def = (getI18n(idioma).ui as Record<string, string>)[c];
  if (def) {
    const faltan = placeholdersDe(def).filter((p) => !v.includes(p));
    if (faltan.length) {
      throw new HttpError(400, 'Faltan variables que el texto necesita: ' + faltan.join(', '));
    }
  }
  await operadorDb()
    .insertInto('traduccion_override')
    .values({ idioma, clave: c, valor: v })
    .onConflict((oc) => oc.columns(['idioma', 'clave']).doUpdateSet({ valor: v }))
    .execute();
  return { ok: true };
}

export async function borrarTraduccion(idioma: string, clave: string) {
  if (!esIdiomaValido(idioma)) throw new HttpError(400, 'Idioma inválido.');
  await operadorDb()
    .deleteFrom('traduccion_override')
    .where('idioma', '=', idioma)
    .where('clave', '=', clave)
    .execute();
  return { ok: true };
}
