import { sql } from 'kysely';
import { withOperador } from '../db/pool';
import { HttpError } from '../http/errors';
import { monedaDeCobro } from './paises';

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

// Las tres últimas llegaron con la 071: una prestación del plan también se
// puede tarifar por unidad (una firma con dispositivo propio, una consulta al
// asistente, una verificación de identidad).
const METRICAS = ['abono', 'firma', 'documento', 'circuito', 'sms',
                  'asistente_ia', 'dispositivo_propio', 'identidad_digital', 'almacenamiento'] as const;
type Metrica = (typeof METRICAS)[number];

const NIVELES = ['simple', 'avanzada'] as const;

/** Sólo las métricas de firma distinguen nivel. El abono es el abono del plan. */
const ADMITE_NIVEL: Record<Metrica, boolean> = {
  abono: false,
  firma: true,
  documento: true,
  circuito: true,
  sms: false,
  asistente_ia: false,
  dispositivo_propio: false,
  identidad_digital: false,
  almacenamiento: false,
};

/**
 * Las prestaciones del plan (071): qué trae cada plan, con o sin costo.
 *
 * La lista cerrada vive en la base (`app.prestaciones_conocidas()`); ésta es
 * su copia para tipar. Si se agrega una allá y no acá, la consola no la
 * muestra; si se agrega acá y no allá, la base la rechaza — que es el lado
 * bueno de la asimetría.
 *
 * Cada fila dice cuatro cosas: incluida (el plan la ofrece), cobra (el uso se
 * factura), cantidad_incluida (unidades sin cargo antes de cobrar) y
 * margen_pct (sobre el costo del proveedor). Lo mismo que la IA decía como
 * columnas de `plan` hasta la 071.
 */
// ⚠ El orden es el de la pantalla: primero las tres formas de firmar, después
// lo demás. La lista cerrada de verdad vive en `app.prestaciones_conocidas()`.
export const PRESTACIONES = ['firma_simple', 'firma_avanzada', 'dispositivo_propio',
                             'identidad_digital', 'asistente_ia', 'custodia'] as const;
export type Prestacion = (typeof PRESTACIONES)[number];

export interface PrestacionDelPlan {
  prestacion: Prestacion;
  incluida: boolean;
  cobra: boolean;
  cantidad_incluida: number;
  margen_pct: number;
}

/** Con qué proveedores se firma en el plan (072). */
export interface ProveedoresDelPlan {
  modo: 'todos' | 'lista';
  /** Ids. Sólo se miran con modo «lista». */
  ids: string[];
}

/** Si el plan guarda los documentos, con qué topes y por cuánto tiempo (072). */
export interface CustodiaDelPlan {
  modo: 'sin_custodia' | 'con_tope' | 'sin_tope';
  tope_documentos: number | null;
  tope_bytes: number | null;
  dias_emisor: number | null;
  dias_firmante: number | null;
}

/**
 * Reemplazo completo, como el resto del plan: lo que la pantalla manda es lo
 * que queda. Una prestación que no viene se guarda como NO incluida — no se
 * borra la fila, para que el operador vea el renglón y no un hueco.
 */
async function guardarPrestaciones(trx: any, planId: string, lista: PrestacionDelPlan[] | undefined) {
  if (!lista) return;
  const por = new Map(lista.map((x) => [x.prestacion, x]));
  for (const nombre of PRESTACIONES) {
    const x = por.get(nombre);
    await sql`
      insert into plan_prestacion (plan_id, prestacion, incluida, cobra, cantidad_incluida, margen_pct)
      values (${planId}::uuid, ${nombre}, ${x?.incluida ?? false}, ${x?.cobra ?? true},
              ${String(x?.cantidad_incluida ?? 0)}::numeric, ${String(x?.margen_pct ?? 0)}::numeric)
      on conflict (plan_id, prestacion) do update set
        incluida = excluded.incluida, cobra = excluded.cobra,
        cantidad_incluida = excluded.cantidad_incluida, margen_pct = excluded.margen_pct,
        actualizado_en = now()
    `.execute(trx);
  }
}

async function guardarProveedores(trx: any, planId: string, p: ProveedoresDelPlan | undefined) {
  if (!p) return;
  await sql`update plan set proveedores_modo = ${p.modo} where id = ${planId}::uuid`.execute(trx);
  // Reemplazo completo, como todo lo demás del plan.
  await sql`delete from plan_proveedor where plan_id = ${planId}::uuid`.execute(trx);
  if (p.modo === 'lista') {
    for (const id of p.ids) {
      await sql`
        insert into plan_proveedor (plan_id, proveedor_id) values (${planId}::uuid, ${id}::uuid)
        on conflict do nothing
      `.execute(trx);
    }
  }
}

async function guardarCustodia(trx: any, planId: string, c: CustodiaDelPlan | undefined) {
  if (!c) return;
  // Los topes sólo valen con modo «con_tope»; el check de la 072 rechaza lo
  // demás, así que se limpian acá en vez de dejar que la base tire un error que
  // el operador no puede interpretar.
  const conTope = c.modo === 'con_tope';
  const topeDoc = conTope ? c.tope_documentos : null;
  const topeBytes = conTope ? c.tope_bytes : null;
  if (conTope && topeDoc == null && topeBytes == null) {
    throw new HttpError(400, 'Elegiste «con tope» pero no pusiste ningún límite: poné un máximo de documentos o de espacio.');
  }
  await sql`
    insert into plan_custodia (plan_id, modo, tope_documentos, tope_bytes, dias_emisor, dias_firmante)
    values (${planId}::uuid, ${c.modo}, ${topeDoc}, ${topeBytes}, ${c.dias_emisor}, ${c.dias_firmante})
    on conflict (plan_id) do update set
      modo = excluded.modo, tope_documentos = excluded.tope_documentos,
      tope_bytes = excluded.tope_bytes, dias_emisor = excluded.dias_emisor,
      dias_firmante = excluded.dias_firmante, actualizado_en = now()
  `.execute(trx);
}

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
      proveedores_modo: string;
    }>`
      select id, codigo, nombre_i18n, descripcion_i18n, incluye_i18n,
             activo, publico, destacado, orden, proveedores_modo
        from plan
       order by orden, codigo
    `.execute(trx);

    const precios = await sql<{
      id: string; plan_id: string; pais: string; moneda: string; metrica: string;
      nivel_firma: string | null; proveedor_id: string | null; precio: string;
      cantidad_incluida: string; vigente_desde: string;
    }>`
      select id, plan_id, pais, moneda, metrica, nivel_firma, proveedor_id,
             precio_unitario::text as precio, cantidad_incluida::text as cantidad_incluida,
             vigente_desde::text as vigente_desde
        from precio_metrica
       where vigente_hasta is null
       order by pais, metrica, nivel_firma nulls first
    `.execute(trx);

    const prest = await sql<{
      plan_id: string; prestacion: string; incluida: boolean; cobra: boolean;
      cantidad_incluida: string; margen_pct: string;
    }>`
      select plan_id, prestacion, incluida, cobra,
             cantidad_incluida::text as cantidad_incluida, margen_pct::text as margen_pct
        from plan_prestacion
    `.execute(trx);
    const prestPorPlan = new Map<string, any[]>();
    for (const x of prest.rows) {
      const a = prestPorPlan.get(x.plan_id) ?? [];
      a.push({ ...x, cantidad_incluida: Number(x.cantidad_incluida), margen_pct: Number(x.margen_pct) });
      prestPorPlan.set(x.plan_id, a);
    }

    const provs = await sql<{ plan_id: string; proveedor_id: string }>`
      select plan_id, proveedor_id from plan_proveedor
    `.execute(trx);
    const provPorPlan = new Map<string, string[]>();
    for (const x of provs.rows) {
      const a = provPorPlan.get(x.plan_id) ?? [];
      a.push(x.proveedor_id);
      provPorPlan.set(x.plan_id, a);
    }

    const cust = await sql<{
      plan_id: string; modo: string; tope_documentos: number | null; tope_bytes: string | null;
      dias_emisor: number | null; dias_firmante: number | null;
    }>`
      select plan_id, modo, tope_documentos, tope_bytes::text as tope_bytes, dias_emisor, dias_firmante
        from plan_custodia
    `.execute(trx);
    const custPorPlan = new Map<string, any>();
    for (const x of cust.rows) {
      custPorPlan.set(x.plan_id, { ...x, tope_bytes: x.tope_bytes == null ? null : Number(x.tope_bytes) });
    }

    // El catálogo, para que la pantalla pueda ofrecer con qué se firma. Y con
    // qué países tiene acuerdo cada uno: es lo que le permite al operador ver
    // que sacar a un socio de la lista deja al plan sin firma avanzada ahí.
    const catalogo = await sql<{
      id: string; codigo: string; nombre_mostrado: string; activo_global: boolean;
      paises: string[] | null; exclusividades: string[] | null;
    }>`
      select pf.id, pf.codigo, pf.nombre_mostrado, pf.activo_global,
             (select array_agg(distinct pp.pais order by pp.pais)
                from proveedor_pais pp where pp.proveedor_id = pf.id and pp.activo) as paises,
             (select array_agg(distinct a.pais order by a.pais)
                from acuerdo_exclusividad a
               where a.proveedor_id = pf.id
                 and a.vigente_desde <= current_date
                 and (a.vigente_hasta is null or a.vigente_hasta >= current_date)) as exclusividades
        from proveedor_firma pf
       order by pf.orden_preferencia, pf.nombre_mostrado
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
      prestaciones: PRESTACIONES,
      catalogo_proveedores: catalogo.rows.map((x) => ({
        ...x, paises: x.paises ?? [], exclusividades: x.exclusividades ?? [],
      })),
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
        prestaciones: prestPorPlan.get(p.id) ?? [],
        proveedores: { modo: (p as any).proveedores_modo ?? 'todos', ids: provPorPlan.get(p.id) ?? [] },
        custodia: custPorPlan.get(p.id) ?? {
          modo: 'sin_tope', tope_documentos: null, tope_bytes: null, dias_emisor: null, dias_firmante: null,
        },
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
  prestaciones?: PrestacionDelPlan[];
  proveedores?: ProveedoresDelPlan;
  custodia?: CustodiaDelPlan;
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
    await guardarPrestaciones(trx, r.rows[0]!.id, d.prestaciones);
    await guardarProveedores(trx, r.rows[0]!.id, d.proveedores);
    await guardarCustodia(trx, r.rows[0]!.id, d.custodia);
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
    await guardarPrestaciones(trx, planId, d.prestaciones);
    await guardarProveedores(trx, planId, d.proveedores);
    await guardarCustodia(trx, planId, d.custodia);
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
    /** Precio para ese proveedor. NULL = para cualquiera (073). */
    proveedor_id?: string | null;
    precio: number;
    /** Unidades sin cargo antes de cobrar (072). */
    cantidad_incluida?: number;
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
  const incluida = d.cantidad_incluida ?? 0;
  if (!(incluida >= 0)) throw new HttpError(400, 'La cantidad sin cargo no puede ser negativa.');
  // La firma simple la hace el sello de la plataforma: no hay proveedor a quien
  // ponerle precio propio.
  const proveedor = d.proveedor_id || null;
  if (proveedor && nivel === 'simple') {
    throw new HttpError(400, 'La firma simple no tiene proveedor: es el sello de la plataforma.');
  }

  // ⚠ Esto lo vuelve a comprobar un trigger de la base (migración 032), y no es
  // redundancia: el trigger vale también para un script y para psql, pero su
  // mensaje NUNCA llega al usuario —el manejador de errores responde 500
  // genérico ante cualquier error que no sea un HttpError, y hace bien—. Acá se
  // explica; allá se impide.
  const local = await monedaDeCobro(pais);
  if (moneda !== local && moneda !== 'USD') {
    throw new HttpError(
      400,
      `${pais} cobra en ${local}. Un precio en ${moneda} no se puede facturar ahí: cargalo en ` +
        `${local} o en USD, o cambiá la moneda del país en Países.`,
    );
  }

  return withOperador(operadorId, async (trx) => {
    const vigente = await sql<{
      id: string; precio: string; incluida: string; moneda: string; desde: string; hoy: boolean;
    }>`
      select id, precio_unitario::text as precio, cantidad_incluida::text as incluida,
             moneda, vigente_desde::text as desde,
             (vigente_desde = current_date) as hoy
        from precio_metrica
       where plan_id = ${d.plan_id}::uuid and pais = ${pais} and moneda = ${moneda}
         and metrica = ${metrica} and coalesce(nivel_firma,'') = ${nivel ?? ''}
         and coalesce(proveedor_id, '00000000-0000-0000-0000-000000000000'::uuid)
             = coalesce(${proveedor}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
         and vigente_hasta is null
    `.execute(trx);

    const actual = vigente.rows[0];
    if (actual && Number(actual.precio) === Number(d.precio)
        && Number(actual.incluida) === Number(incluida)) {
      return { ok: true, sin_cambios: true };
    }

    if (actual) {
      if (actual.hoy) {
        // Corregir un precio que se cargó hoy y todavía no rigió ni un día no
        // genera historia: sería un tramo de duración cero.
        await sql`
          update precio_metrica
             set precio_unitario = ${d.precio}, cantidad_incluida = ${String(incluida)}::numeric
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
      insert into precio_metrica (plan_id, pais, moneda, metrica, nivel_firma, proveedor_id,
                                  precio_unitario, cantidad_incluida, creado_por)
      values (${d.plan_id}::uuid, ${pais}, ${moneda}, ${metrica},
              ${nivel}, ${proveedor}::uuid, ${d.precio}, ${String(incluida)}::numeric,
              ${operadorId}::uuid)
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
