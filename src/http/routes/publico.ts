import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from 'kysely';
import { db } from '../../db/pool';
import { fijarContexto } from '../../db/contexto';
import { claveDelSitio } from '../../services/captcha';

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
 *
 * ═══ POR QUÉ LOS PRECIOS SE ARMAN CON SQL CRUDO ═══
 *
 * `precio_metrica` y las columnas comerciales de `plan` llegaron en la
 * migración 019, después de que se generara `db/schema.ts`. Consultarlas con el
 * query builder tipado obligaría a regenerar el esquema para tocar la página de
 * precios. Con `sql` explícito el tipo lo declara la consulta y no hay
 * dependencia con la generación.
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

  /**
   * En qué países se puede contratar.
   *
   * No hay ninguna tabla de "países habilitados" ni hace falta: un país está
   * abierto cuando el operador le cargó precios a por lo menos un plan público.
   * Cargar el precio ES habilitar el país, y así no existe el estado absurdo de
   * un país anunciado sin precios que nadie puede contratar.
   */
  app.get('/publico/paises', async () => {
    // Qué países se ofrecen lo sigue decidiendo tener precios cargados; el
    // catálogo `pais` sólo aporta cómo se llaman, en qué moneda se cobra y bajo
    // qué ley se firma. Hasta hoy esos tres datos estaban escritos a mano en
    // `sitio.js`, que es el peor lugar posible para una afirmación legal.
    //
    // LEFT JOIN a propósito: un país con precios y sin fila en el catálogo
    // existe y cobra en dólares. No devolverlo lo haría desaparecer de la
    // página sin que nada lo explique.
    const r = await anonimo((trx) =>
      sql<{
        pais: string; nombre_i18n: Record<string, string> | null; bandera: string | null;
        moneda: string; marco_legal: string | null; certificador: string | null;
      }>`
        select pm.pais,
               p.nombre_i18n,
               p.bandera,
               coalesce(p.moneda, 'USD') as moneda,
               p.marco_legal,
               p.certificador
          from (select distinct pm.pais
                  from precio_metrica pm
                  join plan pl on pl.id = pm.plan_id
                 where pm.vigente_hasta is null and pl.activo and pl.publico) pm
          left join pais p on p.codigo = pm.pais
         order by coalesce(p.orden, 999), pm.pais
      `.execute(trx),
    );
    return {
      paises: r.rows.map((x) => ({
        pais: x.pais,
        nombre_i18n: x.nombre_i18n ?? { es: x.pais },
        bandera: x.bandera,
        moneda: x.moneda,
        marco_legal: x.marco_legal,
        certificador: x.certificador,
      })),
    };
  });

  /**
   * Planes con sus precios para un país.
   *
   * Ni un monto ni una moneda viven en el código: salen de `precio_metrica`,
   * que carga el operador. Un plan sin precio para ese país simplemente no
   * aparece — es el mismo mecanismo que habilita el país.
   */
  app.get('/publico/planes', async (req) => {
    const idioma = idiomaDe(req as any);
    const q = z.object({ pais: z.string().length(2).optional() }).parse(req.query);
    const pais = (q.pais ?? '').toUpperCase();
    if (!pais) return { planes: [] };

    const r = await anonimo((trx) =>
      sql<{
        id: string; codigo: string; nombre_i18n: unknown; descripcion_i18n: unknown;
        incluye_i18n: unknown; destacado: boolean; orden: number;
        moneda: string; metrica: string; nivel_firma: string | null; precio_unitario: string;
      }>`
        select p.id, p.codigo, p.nombre_i18n, p.descripcion_i18n, p.incluye_i18n,
               p.destacado, p.orden,
               pm.moneda, pm.metrica, pm.nivel_firma, pm.precio_unitario
          from plan p
          join precio_metrica pm on pm.plan_id = p.id
         where pm.pais = ${pais} and pm.vigente_hasta is null
           and p.activo and p.publico
         order by p.orden, pm.metrica, pm.nivel_firma nulls first
      `.execute(trx),
    );

    const porPlan = new Map<string, any>();
    for (const f of r.rows) {
      let plan = porPlan.get(f.id);
      if (!plan) {
        plan = {
          id: f.id,
          codigo: f.codigo,
          nombre: textoI18n(f.nombre_i18n, idioma) ?? f.codigo,
          descripcion: textoI18n(f.descripcion_i18n, idioma),
          incluye: listaI18n(f.incluye_i18n, idioma),
          destacado: f.destacado,
          moneda: f.moneda,
          precios: [],
        };
        porPlan.set(f.id, plan);
      }
      plan.precios.push({
        metrica: f.metrica,
        nivel_firma: f.nivel_firma,
        // `numeric` llega como string desde pg —a propósito, para no perder
        // decimales— y así se manda: el que formatea es el navegador, con la
        // moneda al lado.
        precio: f.precio_unitario,
      });
    }
    return { planes: [...porPlan.values()] };
  });

  /**
   * La clave PÚBLICA del cartelito de «no soy un robot», o null si está apagado.
   *
   * Es pública por diseño —va escrita en el HTML de cualquier sitio que use
   * Turnstile— y no sirve para nada sin el secreto, que no sale de acá jamás.
   *
   * Existe para que la pantalla no tenga que adivinar si el cartelito está
   * encendido: si viene null, no lo dibuja. Y esconderlo no abre nada — quien
   * decide es `verificarCaptcha` del lado del servidor.
   *
   * ⚠ Va también en `PUBLICAS` de `server.ts`. Tener la ruta no alcanza: el hook
   * central exige sesión para todo lo que no esté en esa lista, y sin agregarla
   * daría 401 en vez de responder. Es la tercera vez que el proyecto tropieza con
   * lo mismo; que quede escrito acá al lado de la ruta.
   */
  app.get('/publico/captcha', async () => {
    return { site_key: claveDelSitio() };
  });

  // Salud del servicio, para el monitoreo. No dice nada del contenido.
  app.get('/publico/salud', async () => {
    await anonimo((trx) => sql`select 1`.execute(trx));
    return { ok: true };
  });
}
