import { sql } from 'kysely';
import { withOperador } from '../db/pool';
import { HttpError } from '../http/errors';

/**
 * Planes comerciales y su lista de precios. Todo esto es parametría del
 * operador: ni un monto ni una moneda viven en el código.
 *
 * ═══ POR QUÉ SQL CRUDO ═══
 *
 * `precio_metrica` y las columnas comerciales de `plan` llegaron en la
 * migración 019, posterior a la generación de `db/schema.ts` — que además
 * arrastra columnas de payroll (`asistente_ia`, `ia_margen_pct`) que la tabla
 * real no tiene. Hasta que se regenere por introspección, el tipo lo declara
 * cada consulta.
 *
 * ═══ EL VERSIONADO NO ES BUROCRACIA ═══
 *
 * Un precio no se pisa: se cierra y se abre otro. La factura de marzo tiene que
 * costear con los precios de marzo, y si el histórico se sobreescribe no hay
 * forma de reconstruir una factura vieja — cualquier reclamo se vuelve
 * indefendible.
 *
 * El intervalo es SEMIABIERTO: `[vigente_desde, vigente_hasta)`. El que lee un
 * precio para la fecha D busca
 *   `vigente_desde <= D and (vigente_hasta is null or vigente_hasta > D)`.
 * Así cerrar hoy y abrir hoy no se superponen, y el precio de hoy es uno solo.
 */

const METRICAS = ['abono', 'firma', 'documento', 'circuito', 'sms'] as const;
type Metrica = (typeof METRICAS)[number];

const NIVELES = ['simple', 'avanzada'] as const;

/** Sólo las métricas de firma distinguen nivel. El abono es el abono del plan. */
const ADMITE_NIVEL: Record<Metrica, boolean> = {
  abono: false,
  firma: true,
  documento: true,
  circuito: true,
  sms: false,
};

export interface PlanComercial {
  id: string;
  codigo: string;
  nombre_i18n: Record<string, string>;
  descripcion_i18n: Record<string, string>;
  incluye_i18n: Record<string, string[]>;
  activo: boolean;
  publico: boolean;
  destacado: boolean;
  orden: number;
}

function objeto(v: unknown): Record<string, any> {
  return v && typeof v === 'object' ? (v as Record<string, any>) : {};
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

export async function listarPlanes(operadorId: string) {
  return withOperador(operadorId, async (trx) => {
    const planes = await sql<{
      id: string; codigo: string; nombre_i18n: unknown; descripcion_i18n: unknown;
      incluye_i18n: unknown; activo: boolean; publico: boolean; destacado: boolean; orden: number;
    }>`
      select id, codigo, nombre_i18n, descripcion_i18n, incluye_i18n,
             activo, publico, destacado, orden
        from plan
       order by orden, codigo
    `.execute(trx);

    const precios = await sql<{
      id: string; plan_id: string; pais: string; moneda: string; metrica: string;
      nivel_firma: string | null; precio: string; vigente_desde: string;
    }>`
      select id, plan_id, pais, moneda, metrica, nivel_firma,
             precio_unitario::text as precio, vigente_desde::text as vigente_desde
        from precio_metrica
       where vigente_hasta is null
       order by pais, metrica, nivel_firma nulls first
    `.execute(trx);

    const porPlan = new Map<string, any[]>();
    for (const p of precios.rows) {
      const a = porPlan.get(p.plan_id) ?? [];
      a.push(p);
      porPlan.set(p.plan_id, a);
    }

    return {
      metricas: METRICAS,
      niveles: NIVELES,
      admite_nivel: ADMITE_NIVEL,
      planes: planes.rows.map((p) => ({
        id: p.id,
        codigo: p.codigo,
        nombre_i18n: objeto(p.nombre_i18n),
        descripcion_i18n: objeto(p.descripcion_i18n),
        incluye_i18n: objeto(p.incluye_i18n),
        activo: p.activo,
        publico: p.publico,
        destacado: p.destacado,
        orden: p.orden,
        precios: porPlan.get(p.id) ?? [],
      })),
    };
  });
}

/** El histórico de un plan, para entender por qué una factura vieja dice lo que dice. */
export async function historialPrecios(operadorId: string, planId: string) {
  return withOperador(operadorId, async (trx) => {
    const r = await sql<{
      pais: string; moneda: string; metrica: string; nivel_firma: string | null;
      precio: string; vigente_desde: string; vigente_hasta: string | null;
    }>`
      select pais, moneda, metrica, nivel_firma, precio_unitario::text as precio,
             vigente_desde::text as vigente_desde, vigente_hasta::text as vigente_hasta
        from precio_metrica
       where plan_id = ${planId}::uuid
       order by pais, metrica, vigente_desde desc
    `.execute(trx);
    return { historial: r.rows };
  });
}

// ---------------------------------------------------------------------------
// Escritura de planes
// ---------------------------------------------------------------------------

export interface DatosPlan {
  nombre_i18n: Record<string, string>;
  descripcion_i18n?: Record<string, string>;
  incluye_i18n?: Record<string, string[]>;
  activo?: boolean;
  publico?: boolean;
  destacado?: boolean;
  orden?: number;
}

export async function crearPlan(operadorId: string, codigo: string, d: DatosPlan) {
  const cod = (codigo || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!cod) throw new HttpError(400, 'Falta el código del plan.');
  if (!Object.keys(d.nombre_i18n || {}).length) throw new HttpError(400, 'Falta el nombre del plan.');

  return withOperador(operadorId, async (trx) => {
    const ya = await sql<{ id: string }>`select id from plan where codigo = ${cod}`.execute(trx);
    if (ya.rows.length) throw new HttpError(409, 'Ya existe un plan con ese código.');

    const r = await sql<{ id: string }>`
      insert into plan (codigo, nombre_i18n, descripcion_i18n, incluye_i18n,
                        activo, publico, destacado, orden)
      values (${cod},
              ${JSON.stringify(d.nombre_i18n)}::jsonb,
              ${JSON.stringify(d.descripcion_i18n ?? {})}::jsonb,
              ${JSON.stringify(d.incluye_i18n ?? {})}::jsonb,
              ${d.activo ?? true}, ${d.publico ?? false}, ${d.destacado ?? false},
              ${d.orden ?? 100})
      returning id
    `.execute(trx);
    return { id: r.rows[0]!.id, codigo: cod };
  });
}

/**
 * Reemplazo completo, no parche.
 *
 * La pantalla manda el plan entero, así que lo que se ve es lo que queda. Un
 * PATCH campo por campo obliga a decidir en el cliente qué cambió y es la forma
 * de que una casilla desmarcada se guarde como "no la mandé".
 */
export async function editarPlan(operadorId: string, planId: string, d: DatosPlan) {
  if (!Object.keys(d.nombre_i18n || {}).length) throw new HttpError(400, 'Falta el nombre del plan.');

  return withOperador(operadorId, async (trx) => {
    const r = await sql<{ id: string }>`
      update plan set
        nombre_i18n      = ${JSON.stringify(d.nombre_i18n)}::jsonb,
        descripcion_i18n = ${JSON.stringify(d.descripcion_i18n ?? {})}::jsonb,
        incluye_i18n     = ${JSON.stringify(d.incluye_i18n ?? {})}::jsonb,
        activo           = ${d.activo ?? true},
        publico          = ${d.publico ?? false},
        destacado        = ${d.destacado ?? false},
        orden            = ${d.orden ?? 100}
       where id = ${planId}::uuid
      returning id
    `.execute(trx);
    if (!r.rows.length) throw new HttpError(404, 'Ese plan no existe.');
    return { ok: true };
  });
}

/**
 * Un plan no se borra si alguien lo está usando.
 *
 * Borrarlo arrastraría sus precios en cascada y dejaría a las cuentas de ese
 * plan sin con qué facturar. Se desactiva, que es lo que en realidad se quiere:
 * dejar de ofrecerlo sin romper a los que ya lo tienen.
 */
export async function borrarPlan(operadorId: string, planId: string) {
  return withOperador(operadorId, async (trx) => {
    const uso = await sql<{ n: string }>`
      select count(*)::text as n from cuenta where plan_id = ${planId}::uuid
    `.execute(trx);
    if (Number(uso.rows[0]?.n ?? 0) > 0) {
      throw new HttpError(409, 'Hay cuentas en ese plan. Desactivalo en vez de borrarlo.');
    }
    await sql`delete from plan where id = ${planId}::uuid`.execute(trx);
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Precios
// ---------------------------------------------------------------------------

export async function setPrecio(
  operadorId: string,
  d: {
    plan_id: string;
    pais: string;
    moneda: string;
    metrica: string;
    nivel_firma?: string | null;
    precio: number;
  },
) {
  const metrica = d.metrica as Metrica;
  if (!(METRICAS as readonly string[]).includes(metrica)) {
    throw new HttpError(400, `Métrica desconocida: ${d.metrica}.`);
  }
  const nivel = d.nivel_firma || null;
  if (nivel && !(NIVELES as readonly string[]).includes(nivel)) {
    throw new HttpError(400, `Nivel de firma desconocido: ${nivel}.`);
  }
  if (nivel && !ADMITE_NIVEL[metrica]) {
    throw new HttpError(400, `La métrica "${metrica}" no distingue nivel de firma.`);
  }
  const pais = (d.pais || '').toUpperCase();
  const moneda = (d.moneda || '').toUpperCase();
  if (pais.length !== 2) throw new HttpError(400, 'El país va en dos letras (ISO 3166).');
  if (moneda.length !== 3) throw new HttpError(400, 'La moneda va en tres letras (ISO 4217).');
  if (!(d.precio >= 0)) throw new HttpError(400, 'El precio no puede ser negativo.');

  return withOperador(operadorId, async (trx) => {
    const vigente = await sql<{ id: string; precio: string; moneda: string; desde: string; hoy: boolean }>`
      select id, precio_unitario::text as precio, moneda, vigente_desde::text as desde,
             (vigente_desde = current_date) as hoy
        from precio_metrica
       where plan_id = ${d.plan_id}::uuid and pais = ${pais} and moneda = ${moneda}
         and metrica = ${metrica} and coalesce(nivel_firma,'') = ${nivel ?? ''}
         and vigente_hasta is null
    `.execute(trx);

    const actual = vigente.rows[0];
    if (actual && Number(actual.precio) === Number(d.precio)) {
      return { ok: true, sin_cambios: true };
    }

    if (actual) {
      if (actual.hoy) {
        // Corregir un precio que se cargó hoy y todavía no rigió ni un día no
        // genera historia: sería un tramo de duración cero.
        await sql`
          update precio_metrica set precio_unitario = ${d.precio}
           where id = ${actual.id}::uuid
        `.execute(trx);
        return { ok: true, corregido: true };
      }
      await sql`
        update precio_metrica set vigente_hasta = current_date
         where id = ${actual.id}::uuid
      `.execute(trx);
    }

    const r = await sql<{ id: string }>`
      insert into precio_metrica (plan_id, pais, moneda, metrica, nivel_firma,
                                  precio_unitario, creado_por)
      values (${d.plan_id}::uuid, ${pais}, ${moneda}, ${metrica},
              ${nivel}, ${d.precio}, ${operadorId}::uuid)
      returning id
    `.execute(trx);
    return { ok: true, id: r.rows[0]!.id };
  });
}

/**
 * Dar de baja un precio. No se borra la fila: se cierra su vigencia.
 *
 * Borrarla dejaría sin costear las facturas del período en que rigió. Cerrarla
 * la saca de la lista pública —y si era el último precio del país, deja de
 * ofrecerse ahí, que es el mecanismo para cerrar un país.
 */
export async function bajaPrecio(operadorId: string, precioId: string) {
  return withOperador(operadorId, async (trx) => {
    const r = await sql<{ id: string }>`
      update precio_metrica set vigente_hasta = current_date
       where id = ${precioId}::uuid and vigente_hasta is null
      returning id
    `.execute(trx);
    if (!r.rows.length) throw new HttpError(404, 'Ese precio no existe o ya estaba dado de baja.');
    return { ok: true };
  });
}
