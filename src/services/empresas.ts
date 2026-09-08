import { sql } from 'kysely';
import { withOperador } from '../db/pool';
import { HttpError } from '../http/errors';
import { PRESTACIONES } from './planes';

/**
 * Las empresas vistas por el operador: qué plan tienen, qué les trae ese plan de
 * verdad, cuánto guardan y cuánto consumieron.
 *
 * ═══ POR QUÉ ESTA PANTALLA NO EXISTÍA, Y POR QUÉ HACÍA FALTA ═══
 *
 * Toda la parametría de las migraciones 019, 071, 072 y 073 —precios,
 * prestaciones, custodia, proveedores del plan— se administra por PLAN. Pero
 * quien llama por teléfono es una EMPRESA, y hasta el 7/9 la única forma de
 * saber qué plan tenía una cuenta era `psql`. Se hizo dos veces esa misma noche:
 * para descubrir que la única suscripción activa era la de Empresa A, y para
 * crear la de Claudio cuando la tarjeta de tuID no aparecía en la pantalla de
 * firma.
 *
 * ⚠ Todo lo que devuelve sale de las funciones de la base —
 * `app.prestaciones_de_cuenta`, `app.custodia_de_cuenta`, `app.custodia_usada`—
 * y no de una copia hecha acá. Si la regla cambia, cambia en un solo lugar y
 * esta pantalla la refleja sola.
 */

export interface EmpresaEnLista {
  id: string;
  nombre_mostrado: string;
  pais: string;
  moneda: string;
  estado: string;
  estado_cobranza: string;
  creada_en: string | null;
  plan_codigo: string | null;
  plan_id: string | null;
  suscripcion_id: string | null;
  suscripcion_desde: string | null;
  usuarios: number;
  documentos: number;
}

export async function listarEmpresas(operadorId: string, q?: string) {
  const filtro = (q ?? '').trim();
  return withOperador(operadorId, async (trx) => {
    const r = await sql<EmpresaEnLista>`
      select c.id, c.nombre_mostrado, c.pais, c.moneda, c.estado, c.estado_cobranza,
             c.creada_en::text as creada_en,
             p.codigo as plan_codigo, p.id as plan_id,
             s.id as suscripcion_id, s.inicio::text as suscripcion_desde,
             -- ⚠⚠ Los dos conteos van por FUNCION, no por tabla. app_operador no
             -- tiene select sobre usuario_rol ni sobre archivo, y no debe tenerlo:
             -- necesita saber cuantos documentos guarda una empresa, no cuales.
             -- Consultarlas directo fue el 500 del 7/9. Ver migracion 075.
             app.usuarios_de_cuenta(c.id)::int as usuarios,
             (select documentos from app.custodia_usada(c.id))::int as documentos
        from cuenta c
        left join suscripcion s on s.cuenta_id = c.id and s.estado = 'activa'
        left join plan p on p.id = s.plan_id
       where c.tipo = 'empresa'
         and (${filtro} = '' or c.nombre_mostrado ilike ${'%' + filtro + '%'})
       order by c.nombre_mostrado
       limit 200
    `.execute(trx);
    return { empresas: r.rows };
  });
}

/**
 * El detalle de una empresa: su plan, sus prestaciones EFECTIVAS (que pueden
 * diferir del plan porque hay override por suscripción), su custodia y lo que
 * lleva usado.
 */
export async function verEmpresa(operadorId: string, cuentaId: string) {
  return withOperador(operadorId, async (trx) => {
    const c = await sql<{
      id: string; nombre_mostrado: string; pais: string; moneda: string; idioma: string;
      estado: string; estado_cobranza: string; en_mora_desde: string | null; creada_en: string;
      plan_id: string | null; plan_codigo: string | null; plan_nombre: unknown;
      suscripcion_id: string | null; medio_cobro: string | null; suscripcion_desde: string | null;
    }>`
      select c.id, c.nombre_mostrado, c.pais, c.moneda, c.idioma, c.estado, c.estado_cobranza,
             c.en_mora_desde::text as en_mora_desde, c.creada_en::text as creada_en,
             p.id as plan_id, p.codigo as plan_codigo, p.nombre_i18n as plan_nombre,
             s.id as suscripcion_id, s.medio_cobro, s.inicio::text as suscripcion_desde
        from cuenta c
        left join suscripcion s on s.cuenta_id = c.id and s.estado = 'activa'
        left join plan p on p.id = s.plan_id
       where c.id = ${cuentaId}::uuid and c.tipo = 'empresa'
    `.execute(trx);
    const empresa = c.rows[0];
    if (!empresa) throw new HttpError(404, 'No existe esa empresa.');

    // Las prestaciones EFECTIVAS, con su origen: «suscripcion» significa que hay
    // un override y la pantalla lo tiene que decir — si no, el operador cambia
    // el plan y no entiende por qué esa empresa sigue igual.
    const prest = await sql<{
      prestacion: string; incluida: boolean; cobra: boolean;
      cantidad_incluida: string; margen_pct: string; origen: string;
    }>`
      select prestacion, incluida, cobra,
             cantidad_incluida::text as cantidad_incluida, margen_pct::text as margen_pct, origen
        from app.prestaciones_de_cuenta(${cuentaId}::uuid)
    `.execute(trx);

    const cust = await sql<{
      modo: string; tope_documentos: number | null; tope_bytes: string | null;
      dias_emisor: number | null; dias_firmante: number | null; origen: string;
    }>`
      select modo, tope_documentos, tope_bytes::text as tope_bytes, dias_emisor, dias_firmante, origen
        from app.custodia_de_cuenta(${cuentaId}::uuid)
    `.execute(trx);

    const usada = await sql<{ documentos: string; bytes: string }>`
      select documentos::text as documentos, bytes::text as bytes
        from app.custodia_usada(${cuentaId}::uuid)
    `.execute(trx);

    const planes = await sql<{ id: string; codigo: string; activo: boolean }>`
      select id, codigo, activo from plan order by orden, codigo
    `.execute(trx);

    const c0 = cust.rows[0]!;
    return {
      empresa,
      prestaciones: prest.rows.map((x) => ({
        ...x,
        cantidad_incluida: Number(x.cantidad_incluida),
        margen_pct: Number(x.margen_pct),
      })),
      custodia: {
        ...c0,
        tope_bytes: c0.tope_bytes == null ? null : Number(c0.tope_bytes),
      },
      usado: {
        documentos: Number(usada.rows[0]?.documentos ?? 0),
        bytes: Number(usada.rows[0]?.bytes ?? 0),
      },
      planes: planes.rows,
    };
  });
}

/**
 * Ponerle o cambiarle el plan a una empresa.
 *
 * ⚠⚠ Hasta el 7/9 NADA en el producto creaba suscripciones: las dos que había
 * se cargaron a mano por psql. Una cuenta que se registra sola quedaba sin plan
 * para siempre, y sin plan no hay prestaciones ni precios — o sea, no se le
 * puede cobrar.
 *
 * La suscripción anterior no se borra: se cancela y queda. Es lo que permite
 * contestar «en qué plan estaba esta empresa en marzo», que es la pregunta de
 * cualquier reclamo de facturación.
 */
export async function asignarPlan(
  operadorId: string,
  cuentaId: string,
  planId: string,
  medioCobro?: string,
) {
  return withOperador(operadorId, async (trx) => {
    const c = await sql<{ moneda: string; nombre: string }>`
      select moneda, nombre_mostrado as nombre from cuenta
       where id = ${cuentaId}::uuid and tipo = 'empresa'
    `.execute(trx);
    if (!c.rows[0]) throw new HttpError(404, 'No existe esa empresa.');

    const p = await sql<{ codigo: string; activo: boolean }>`
      select codigo, activo from plan where id = ${planId}::uuid
    `.execute(trx);
    if (!p.rows[0]) throw new HttpError(404, 'No existe ese plan.');
    if (!p.rows[0].activo) {
      throw new HttpError(400, `El plan «${p.rows[0].codigo}» está desactivado: no se puede contratar.`);
    }

    const ya = await sql<{ id: string; plan_id: string }>`
      select id, plan_id from suscripcion where cuenta_id = ${cuentaId}::uuid and estado = 'activa'
    `.execute(trx);
    if (ya.rows[0]?.plan_id === planId) return { ok: true, sin_cambios: true };

    if (ya.rows[0]) {
      await sql`
        update suscripcion set estado = 'cancelada', fin = current_date, actualizada_en = now()
         where id = ${ya.rows[0].id}::uuid
      `.execute(trx);
    }

    await sql`
      insert into suscripcion (cuenta_id, plan_id, moneda, medio_cobro)
      values (${cuentaId}::uuid, ${planId}::uuid, ${c.rows[0].moneda},
              ${medioCobro ?? 'tarjeta'})
    `.execute(trx);

    return { ok: true, plan: p.rows[0].codigo, anterior: ya.rows.length > 0 };
  });
}

/**
 * El override por empresa de una prestación. NULL en un campo = vuelve a heredar
 * del plan, que es distinto de ponerle el mismo valor: si el plan cambia, lo
 * heredado cambia y lo fijado no.
 *
 * ⚠ Hasta hoy sólo la IA tenía forma de hacer esto (`PATCH /operador/empresas/
 * :id/ia`, de la 013, que apuntaba a una pantalla que nunca se construyó). Las
 * otras cinco prestaciones no tenían ninguna.
 */
export async function setOverridePrestacion(
  operadorId: string,
  cuentaId: string,
  prestacion: string,
  v: {
    incluida?: boolean | null;
    cobra?: boolean | null;
    cantidad_incluida?: number | null;
    margen_pct?: number | null;
  },
) {
  if (!(PRESTACIONES as readonly string[]).includes(prestacion)) {
    throw new HttpError(400, `Prestación desconocida: ${prestacion}.`);
  }
  return withOperador(operadorId, async (trx) => {
    const s = await sql<{ id: string }>`
      select id from suscripcion where cuenta_id = ${cuentaId}::uuid and estado = 'activa'
    `.execute(trx);
    if (!s.rows[0]) {
      throw new HttpError(400, 'Esa empresa no tiene un plan contratado: asignale uno antes de ajustarle una prestación.');
    }
    const num = (x: number | null | undefined) => (x == null ? null : String(x));
    await sql`
      insert into suscripcion_prestacion
        (suscripcion_id, prestacion, incluida, cobra, cantidad_incluida, margen_pct)
      values (${s.rows[0].id}::uuid, ${prestacion}, ${v.incluida ?? null}, ${v.cobra ?? null},
              ${num(v.cantidad_incluida)}::numeric, ${num(v.margen_pct)}::numeric)
      on conflict (suscripcion_id, prestacion) do update set
        incluida = excluded.incluida, cobra = excluded.cobra,
        cantidad_incluida = excluded.cantidad_incluida, margen_pct = excluded.margen_pct,
        actualizado_en = now()
    `.execute(trx);
    return { ok: true };
  });
}

/** Quitar el override: la empresa vuelve a lo que dice su plan. */
export async function quitarOverridePrestacion(operadorId: string, cuentaId: string, prestacion: string) {
  return withOperador(operadorId, async (trx) => {
    const r = await sql`
      delete from suscripcion_prestacion sp
       using suscripcion s
       where sp.suscripcion_id = s.id and s.cuenta_id = ${cuentaId}::uuid
         and s.estado = 'activa' and sp.prestacion = ${prestacion}
    `.execute(trx);
    return { ok: true, quitado: Number(r.numAffectedRows ?? 0) > 0 };
  });
}
