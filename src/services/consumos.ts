import { sql } from 'kysely';
import { withOperador } from '../db/pool';

/**
 * Qué consumió cada empresa en un período, y qué le debemos a cada proveedor.
 *
 * ═══ ⚠⚠ DE DÓNDE SALE, Y DE DÓNDE NO ═══
 *
 * Las firmas salen de `firma_facturable` (073): una línea por firma, escrita al
 * firmar con el precio y el costo VIGENTES ESE DÍA. No se recalcula desde la
 * lista de precios de hoy — un precio que cambió en marzo no puede cambiar lo
 * que se consumió en febrero.
 *
 * Esa tabla la llena el MEDIDOR (`app.medir_firma`, migración 076), que
 * escribe desde `firmar()` y midió su primera firma en producción el 8/9. Hasta
 * ese día esta pantalla mostraba ceros y lo decía; ahora un cero es un cero.
 *
 * La IA sí tiene datos desde la 013: `consumo_ia` acumula tokens y costo por
 * (cuenta, período, modelo). Lo que ahí NO está es el margen —vive en la
 * prestación del plan— así que el precio de venta se arma acá, sobre el costo
 * de cada línea.
 */

export async function consumosDelPeriodo(operadorId: string, periodo: string, cuentaId?: string) {
  return withOperador(operadorId, async (trx) => {
    // ── Firmas, por cuenta, nivel y proveedor
    const firmas = await sql<{
      cuenta_id: string; nombre: string; nivel_firma: string;
      proveedor: string | null; moneda: string;
      firmas: string; cobradas: string; ingreso: string; costo: string; a_liquidar: string;
    }>`
      select f.cuenta_id, c.nombre_mostrado as nombre, f.nivel_firma,
             pf.nombre_mostrado as proveedor, f.moneda,
             count(*)::text as firmas,
             count(*) filter (where f.cobrada)::text as cobradas,
             coalesce(sum(f.precio_unitario) filter (where f.cobrada), 0)::text as ingreso,
             coalesce(sum(f.costo_proveedor), 0)::text as costo,
             coalesce(sum(f.a_liquidar), 0)::text as a_liquidar
        from firma_facturable f
        join cuenta c on c.id = f.cuenta_id
        left join proveedor_firma pf on pf.id = f.proveedor_id
       where f.periodo = ${periodo}
         and (${cuentaId ?? null}::uuid is null or f.cuenta_id = ${cuentaId ?? null}::uuid)
       group by f.cuenta_id, c.nombre_mostrado, f.nivel_firma, pf.nombre_mostrado, f.moneda
       order by c.nombre_mostrado, f.nivel_firma, pf.nombre_mostrado nulls first
    `.execute(trx);

    // ── IA, con su costo y lo que se le cobra
    //
    // El margen sale de la prestación EFECTIVA de esa cuenta (override o plan),
    // no de una constante: dos empresas con el mismo consumo pueden pagar
    // distinto, y es a propósito.
    const ia = await sql<{
      cuenta_id: string; nombre: string; modelo: string; moneda: string;
      input_tokens: string; output_tokens: string; costo: string;
      margen_pct: string; incluido: string; cobra: boolean;
    }>`
      select ci.cuenta_id, c.nombre_mostrado as nombre, ci.modelo, ci.moneda,
             ci.input_tokens::text, ci.output_tokens::text, ci.costo_base::text as costo,
             p.margen_pct::text as margen_pct, p.cantidad_incluida::text as incluido, p.cobra
        from consumo_ia ci
        join cuenta c on c.id = ci.cuenta_id
        cross join lateral app.prestacion_de_cuenta(ci.cuenta_id, 'asistente_ia') p
       where ci.periodo = ${periodo}
         and (${cuentaId ?? null}::uuid is null or ci.cuenta_id = ${cuentaId ?? null}::uuid)
       order by c.nombre_mostrado, ci.modelo
    `.execute(trx);

    // ── Almacenamiento: lo que ocupa hoy cada cuenta contra su tope
    //
    // ⚠ Es una foto de HOY, no del período: el disco se mide cuando se mira. Se
    // dice en la pantalla para que nadie lo lea como «lo que ocupó en marzo».
    const disco = await sql<{
      cuenta_id: string; nombre: string; documentos: string; bytes: string;
      modo: string; tope_documentos: number | null; tope_bytes: string | null;
    }>`
      select c.id as cuenta_id, c.nombre_mostrado as nombre,
             u.documentos::text, u.bytes::text,
             cu.modo, cu.tope_documentos, cu.tope_bytes::text
        from cuenta c
        cross join lateral app.custodia_usada(c.id) u
        cross join lateral app.custodia_de_cuenta(c.id) cu
       where c.tipo = 'empresa'
         and (${cuentaId ?? null}::uuid is null or c.id = ${cuentaId ?? null}::uuid)
         and u.documentos > 0
       order by u.bytes desc
       limit 100
    `.execute(trx);

    const n = (x: string | null | undefined) => Number(x ?? 0);
    return {
      periodo,
      // Lo que la pantalla necesita para no mentir con un cero.
      medidor_activo: firmas.rows.length > 0,
      firmas: firmas.rows.map((x) => ({
        ...x,
        firmas: n(x.firmas), cobradas: n(x.cobradas), ingreso: n(x.ingreso),
        costo: n(x.costo), a_liquidar: n(x.a_liquidar),
      })),
      ia: ia.rows.map((x) => {
        const costo = n(x.costo);
        const margen = n(x.margen_pct);
        return {
          cuenta_id: x.cuenta_id, nombre: x.nombre, modelo: x.modelo, moneda: x.moneda,
          input_tokens: n(x.input_tokens), output_tokens: n(x.output_tokens),
          costo,
          margen_pct: margen,
          // Lo que se le cobra: el costo con el margen encima, si el plan cobra.
          precio: x.cobra ? Number((costo * (1 + margen / 100)).toFixed(6)) : 0,
          incluido: n(x.incluido),
          cobra: x.cobra,
        };
      }),
      disco: disco.rows.map((x) => ({
        cuenta_id: x.cuenta_id, nombre: x.nombre,
        documentos: n(x.documentos), bytes: n(x.bytes),
        modo: x.modo, tope_documentos: x.tope_documentos,
        tope_bytes: x.tope_bytes == null ? null : n(x.tope_bytes),
      })),
    };
  });
}

/** Lo que le debemos a cada proveedor este período, y lo ya liquidado. */
export async function liquidaciones(operadorId: string, periodo: string) {
  return withOperador(operadorId, async (trx) => {
    const pendiente = await sql<{
      proveedor_id: string; codigo: string; nombre: string; pais: string; moneda: string;
      firmas: string; ingreso: string; a_liquidar: string;
    }>`
      select proveedor_id, codigo, nombre, pais, moneda,
             firmas::text, ingreso::text, a_liquidar::text
        from app.liquidacion_pendiente(${periodo})
    `.execute(trx);

    const emitidas = await sql<{
      id: string; proveedor: string; pais: string; periodo: string; moneda: string;
      firmas: string; ingreso: string; a_liquidar: string; estado: string;
      emitida_en: string | null; pagada_en: string | null; referencia_pago: string | null;
    }>`
      select l.id, pf.nombre_mostrado as proveedor, l.pais, l.periodo, l.moneda,
             l.firmas::text, l.ingreso::text, l.a_liquidar::text, l.estado,
             l.emitida_en::text, l.pagada_en::text, l.referencia_pago
        from liquidacion_proveedor l
        join proveedor_firma pf on pf.id = l.proveedor_id
       order by l.periodo desc, pf.nombre_mostrado
       limit 100
    `.execute(trx);

    const n = (x: string | null | undefined) => Number(x ?? 0);
    return {
      periodo,
      pendiente: pendiente.rows.map((x) => ({
        ...x, firmas: n(x.firmas), ingreso: n(x.ingreso), a_liquidar: n(x.a_liquidar),
      })),
      emitidas: emitidas.rows.map((x) => ({
        ...x, firmas: n(x.firmas), ingreso: n(x.ingreso), a_liquidar: n(x.a_liquidar),
      })),
    };
  });
}

/** Emitir la liquidación de un proveedor: congela el número y marca las líneas. */
export async function emitirLiquidacion(
  operadorId: string,
  d: { proveedor_id: string; pais: string; periodo: string; moneda: string },
) {
  return withOperador(operadorId, async (trx) => {
    const r = await sql<{ id: string }>`
      select app.liquidacion_emitir(${d.proveedor_id}::uuid, ${d.pais}, ${d.periodo},
                                    ${d.moneda}, ${operadorId}) as id
    `.execute(trx);
    return { ok: true, id: r.rows[0]?.id };
  });
}

/** Marcarla pagada. Lo único que le pasa a una liquidación después de emitida. */
export async function pagarLiquidacion(operadorId: string, id: string, referencia?: string) {
  return withOperador(operadorId, async (trx) => {
    await sql`
      update liquidacion_proveedor
         set estado = 'pagada', pagada_en = now(), referencia_pago = ${referencia ?? null}
       where id = ${id}::uuid and estado = 'emitida'
    `.execute(trx);
    return { ok: true };
  });
}
