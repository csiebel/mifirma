import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from 'kysely';
import { db } from '../../db/pool';
import { fijarContexto } from '../../db/contexto';

/**
 * Endpoints públicos, sin token: los consume el sitio comercial.
 *
 * ⚠ Todo lo que se agregue acá es accesible desde internet sin autenticación.
 * La regla es que sólo salgan catálogos nuestros —planes, industrias, países—
 * y nunca nada que dependa de una cuenta. Un endpoint público que acepte un
 * `cuenta_id` es un oráculo para enumerar clientes.
 *
 * El alta self-service NO vive acá: está en `/auth/registro`, que tiene su
 * propio tope de altas por IP. Duplicarla en dos rutas duplicaría también el
 * lugar donde hay que acordarse de poner el freno.
 */

/** Contexto anónimo: sin identidad, sin cuenta. Sólo lee catálogos. */
async function anonimo<T>(fn: (trx: any) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await fijarContexto(trx, { actor: 'anonimo' });
    return fn(trx);
  });
}

function listaI18n(v: unknown, idioma: string): string[] {
  if (!v || typeof v !== 'object') return [];
  const m = v as Record<string, string[]>;
  return m[idioma] ?? m.es ?? m.en ?? Object.values(m)[0] ?? [];
}

function textoI18n(v: unknown, idioma: string): string | null {
  if (!v || typeof v !== 'object') return null;
  const m = v as Record<string, string>;
  return m[idioma] ?? m.es ?? m.en ?? Object.values(m)[0] ?? null;
}

function idiomaDe(req: { headers: Record<string, unknown> }): string {
  const h = String(req.headers['accept-language'] ?? '');
  if (/^pt/i.test(h)) return 'pt';
  if (/^en/i.test(h)) return 'en';
  return 'es';
}

export function registrarRutasPublico(app: FastifyInstance) {
  // Rubros, para el selector del alta. Es catálogo nuestro y no revela nada.
  app.get('/publico/industrias', async (req) => {
    const idioma = idiomaDe(req as any);
    const filas: any[] = await anonimo((trx) =>
      trx.selectFrom('industria').select(['id', 'codigo', 'nombre_i18n']).execute(),
    );
    return {
      industrias: filas
        .map((f: any) => ({ id: f.id, codigo: f.codigo, nombre: textoI18n(f.nombre_i18n, idioma) ?? f.codigo }))
        .sort((a: any, b: any) => a.nombre.localeCompare(b.nombre, idioma)),
    };
  });

  // Planes activos, para mostrar precios en el sitio.
  app.get('/publico/planes', async (req) => {
    const idioma = idiomaDe(req as any);
    const filas: any[] = await anonimo((trx) =>
      trx
        .selectFrom('plan')
        .select(['id', 'codigo', 'nombre_i18n', 'orden'])
        .where('activo', '=', true)
        .orderBy('orden')
        .execute(),
    );
    return {
      planes: filas.map((f: any) => ({
        id: f.id,
        codigo: f.codigo,
        nombre: textoI18n(f.nombre_i18n, idioma) ?? f.codigo,
      })),
    };
  });

  // Salud del servicio, para el monitoreo. No dice nada del contenido.
  app.get('/publico/salud', async () => {
    await anonimo((trx) => sql`select 1`.execute(trx));
    return { ok: true };
  });
}
