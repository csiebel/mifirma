import { sql, type Transaction } from 'kysely';
import type { DB } from '../db/schema';
import { withOperador } from '../db/pool';
import { withUsuario } from '../auth/authz';
import { HttpError } from '../http/errors';

/**
 * Prepago y pospago (078, 10/9): la modalidad de cada plan y de cada empresa,
 * el saldo, las recargas, los paquetes y el freno que el operador puede
 * levantar.
 *
 * ═══ LO QUE ESTE ARCHIVO NO HACE ═══
 *
 * No calcula saldos ni decide si un despacho sale: eso lo hace la base
 * (`app.saldo_disponible`, `app.reservar_despacho`, los triggers de consumo y
 * liberación). Acá sólo se lee y se administra. Si mañana la regla cambia,
 * cambia en la migración y esta pantalla la refleja sola.
 */

export const MODALIDADES = ['prepago', 'pospago'] as const;

export interface Modalidad {
  modalidad: 'prepago' | 'pospago';
  incluido_mensual: number | null;
  tope_excedente: number | null;
  umbral_aviso_saldo: number | null;
}

function validarModalidad(m: Partial<Modalidad>): Modalidad {
  if (!(MODALIDADES as readonly string[]).includes(m.modalidad ?? '')) {
    throw new HttpError(400, 'La modalidad es «prepago» o «pospago».');
  }
  const ent = (x: unknown, nombre: string) => {
    if (x == null || x === '') return null;
    const n = Number(x);
    if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `${nombre} tiene que ser un entero ≥ 0.`);
    return n;
  };
  const num = (x: unknown, nombre: string) => {
    if (x == null || x === '') return null;
    const n = Number(x);
    if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${nombre} tiene que ser un número ≥ 0.`);
    return n;
  };
  return {
    modalidad: m.modalidad as 'prepago' | 'pospago',
    incluido_mensual: ent(m.incluido_mensual, 'Las firmas incluidas por mes'),
    tope_excedente: ent(m.tope_excedente, 'El tope de excedente'),
    umbral_aviso_saldo: num(m.umbral_aviso_saldo, 'El umbral de aviso de saldo'),
  };
}

// ── La modalidad del plan (billing_config con plan_id, sin país ni cuenta) ──

export async function modalidadDelPlan(trx: Transaction<DB>, planId: string) {
  const r = await sql<Modalidad & { id: string }>`
    select id, modalidad, incluido_mensual, tope_excedente, umbral_aviso_saldo::float8 as umbral_aviso_saldo
      from billing_config
     where plan_id = ${planId}::uuid and cuenta_id is null and pais is null
       and vigente_hasta is null
     order by vigente_desde desc limit 1
  `.execute(trx);
  return r.rows[0] ?? null;
}

export async function guardarModalidadDelPlan(operadorId: string, planId: string, m: Partial<Modalidad>) {
  const v = validarModalidad(m);
  return withOperador(operadorId, async (trx) => {
    const ya = await modalidadDelPlan(trx, planId);
    if (ya) {
      await sql`
        update billing_config
           set modalidad = ${v.modalidad}, incluido_mensual = ${v.incluido_mensual},
               tope_excedente = ${v.tope_excedente}, umbral_aviso_saldo = ${v.umbral_aviso_saldo}
         where id = ${ya.id}::uuid
      `.execute(trx);
    } else {
      // `metrica` y `modelo_comision` son columnas de la 019 que hoy no decide
      // nadie desde acá (el precio vive en precio_metrica, 072/073 — deuda 116).
      // Se guardan los valores que no cambian nada.
      await sql`
        insert into billing_config (plan_id, modalidad, metrica, modelo_comision,
                                    incluido_mensual, tope_excedente, umbral_aviso_saldo)
        values (${planId}::uuid, ${v.modalidad}, 'firma', 'precio_fijo',
                ${v.incluido_mensual}, ${v.tope_excedente}, ${v.umbral_aviso_saldo})
      `.execute(trx);
    }
    return { ok: true };
  });
}

// ── El override por empresa ──

export async function guardarModalidadDeEmpresa(operadorId: string, cuentaId: string, m: Partial<Modalidad>) {
  const v = validarModalidad(m);
  return withOperador(operadorId, async (trx) => {
    const ya = await sql<{ id: string }>`
      select id from billing_config where cuenta_id = ${cuentaId}::uuid and vigente_hasta is null
      order by vigente_desde desc limit 1
    `.execute(trx);
    if (ya.rows[0]) {
      await sql`
        update billing_config
           set modalidad = ${v.modalidad}, incluido_mensual = ${v.incluido_mensual},
               tope_excedente = ${v.tope_excedente}, umbral_aviso_saldo = ${v.umbral_aviso_saldo}
         where id = ${ya.rows[0].id}::uuid
      `.execute(trx);
    } else {
      await sql`
        insert into billing_config (cuenta_id, modalidad, metrica, modelo_comision,
                                    incluido_mensual, tope_excedente, umbral_aviso_saldo)
        values (${cuentaId}::uuid, ${v.modalidad}, 'firma', 'precio_fijo',
                ${v.incluido_mensual}, ${v.tope_excedente}, ${v.umbral_aviso_saldo})
      `.execute(trx);
    }
    return { ok: true };
  });
}

/** Quitar el override: la empresa vuelve a la modalidad de su plan. */
export async function quitarModalidadDeEmpresa(operadorId: string, cuentaId: string) {
  return withOperador(operadorId, async (trx) => {
    const r = await sql`delete from billing_config where cuenta_id = ${cuentaId}::uuid`.execute(trx);
    return { ok: true, quitado: Number(r.numAffectedRows ?? 0) > 0 };
  });
}

// ── El estado de saldo de una empresa (lo que ven el operador y el emisor) ──

export async function estadoDeSaldo(trx: Transaction<DB>, cuentaId: string) {
  const e = await sql<{
    modalidad: string; moneda: string; saldo: string; reservado: string; consumidas_mes: string;
    incluido_mensual: number | null; tope_excedente: number | null; umbral_aviso_saldo: string | null;
    cerca_del_limite: boolean; frenada: boolean; levante_hasta: string | null; levante_monto: string | null;
  }>`
    select modalidad, moneda, saldo::text, reservado::text, consumidas_mes::text,
           incluido_mensual, tope_excedente, umbral_aviso_saldo::text,
           cerca_del_limite, frenada, levante_hasta::text, levante_monto::text
      from app.estado_de_saldo(${cuentaId}::uuid)
  `.execute(trx);
  const x = e.rows[0];
  if (!x) return null;
  const n = (s: string | null) => (s == null ? null : Number(s));
  const origen = await sql<{ origen: string }>`
    select origen from app.modalidad_de_cuenta(${cuentaId}::uuid)
  `.execute(trx);
  return {
    modalidad: x.modalidad, moneda: x.moneda, origen: origen.rows[0]?.origen ?? 'por_omision',
    saldo: n(x.saldo), reservado: n(x.reservado), consumidas_mes: n(x.consumidas_mes),
    incluido_mensual: x.incluido_mensual, tope_excedente: x.tope_excedente,
    umbral_aviso_saldo: n(x.umbral_aviso_saldo),
    cerca_del_limite: x.cerca_del_limite, frenada: x.frenada,
    levante: x.levante_hasta ? { hasta: x.levante_hasta, monto_extra: n(x.levante_monto) } : null,
  };
}

/** Para el operador: estado + últimas recargas + movimientos + levantes. */
export async function saldoDeEmpresa(operadorId: string, cuentaId: string) {
  return withOperador(operadorId, async (trx) => {
    const estado = await estadoDeSaldo(trx, cuentaId);
    const recargas = await sql<{
      id: string; moneda: string; monto_pagado: string; monto_acreditado: string; medio: string;
      estado: string; motivo: string | null; creada_por: string | null; creada_en: string; acreditada_en: string | null;
      paquete: string | null;
    }>`
      select r.id, r.moneda, r.monto_pagado::text, r.monto_acreditado::text, r.medio, r.estado, r.motivo,
             r.creada_por, r.creada_en::text, r.acreditada_en::text, p.codigo as paquete
        from recarga r left join paquete_recarga p on p.id = r.paquete_id
       where r.cuenta_id = ${cuentaId}::uuid
       order by r.creada_en desc limit 50
    `.execute(trx);
    const movimientos = await sql<{
      id: string; moneda: string; tipo: string; monto: string; motivo: string | null;
      creado_por: string | null; creado_en: string; circuito_id: string | null;
    }>`
      select id, moneda, tipo, monto::text, motivo, creado_por, creado_en::text, circuito_id
        from movimiento_saldo where cuenta_id = ${cuentaId}::uuid
       order by creado_en desc limit 100
    `.execute(trx);
    const levantes = await sql<{
      id: string; hasta: string; monto_extra: string | null; motivo: string; por: string;
      creado_en: string; revocado_en: string | null;
    }>`
      select id, hasta::text, monto_extra::text, motivo, por, creado_en::text, revocado_en::text
        from levante_de_limite where cuenta_id = ${cuentaId}::uuid
       order by creado_en desc limit 20
    `.execute(trx);
    const n = (s: string | null) => (s == null ? null : Number(s));
    return {
      estado,
      recargas: recargas.rows.map((r) => ({ ...r, monto_pagado: n(r.monto_pagado), monto_acreditado: n(r.monto_acreditado) })),
      movimientos: movimientos.rows.map((m) => ({ ...m, monto: n(m.monto) })),
      levantes: levantes.rows.map((l) => ({ ...l, monto_extra: n(l.monto_extra) })),
    };
  });
}

/**
 * Una recarga que el operador acredita a mano (una transferencia recibida).
 * Se crea y se acredita en el mismo acto, por la función de la base, que es
 * idempotente y la única que escribe el movimiento.
 */
export async function recargaManual(
  operadorId: string,
  cuentaId: string,
  d: { monto: number; moneda?: string; bono?: number; motivo: string; paquete_id?: string | null },
) {
  if (!(d.monto > 0)) throw new HttpError(400, 'El monto tiene que ser mayor que cero.');
  if (!d.motivo?.trim()) throw new HttpError(400, 'Decí de dónde salió la plata (transferencia, referencia, etc.).');
  return withOperador(operadorId, async (trx) => {
    const c = await sql<{ moneda: string }>`
      select coalesce(s.moneda, c.moneda) as moneda
        from cuenta c left join suscripcion s on s.cuenta_id = c.id and s.estado = 'activa'
       where c.id = ${cuentaId}::uuid
    `.execute(trx);
    if (!c.rows[0]) throw new HttpError(404, 'No existe esa empresa.');
    const moneda = (d.moneda ?? c.rows[0].moneda).toUpperCase();
    const bono = d.bono ?? 0;
    const r = await sql<{ id: string }>`
      insert into recarga (cuenta_id, moneda, monto_pagado, monto_acreditado, paquete_id, medio, motivo, creada_por)
      values (${cuentaId}::uuid, ${moneda}, ${d.monto}, ${d.monto + bono},
              ${d.paquete_id ?? null}::uuid, 'manual', ${d.motivo.trim()}, ${operadorId})
      returning id
    `.execute(trx);
    await sql`select app.acreditar_recarga(${r.rows[0]!.id}::uuid)`.execute(trx);
    return { ok: true, id: r.rows[0]!.id, acreditado: d.monto + bono, moneda };
  });
}

/** Un ajuste a mano del operador, con motivo obligatorio y el signo que sea. */
export async function ajusteDeSaldo(operadorId: string, cuentaId: string, d: { monto: number; motivo: string }) {
  if (!Number.isFinite(d.monto) || d.monto === 0) throw new HttpError(400, 'El monto del ajuste no puede ser cero.');
  if (!d.motivo?.trim()) throw new HttpError(400, 'Un ajuste sin motivo no se puede explicar después: escribilo.');
  return withOperador(operadorId, async (trx) => {
    const c = await sql<{ moneda: string }>`
      select coalesce(s.moneda, c.moneda) as moneda
        from cuenta c left join suscripcion s on s.cuenta_id = c.id and s.estado = 'activa'
       where c.id = ${cuentaId}::uuid
    `.execute(trx);
    if (!c.rows[0]) throw new HttpError(404, 'No existe esa empresa.');
    await sql`
      insert into movimiento_saldo (cuenta_id, moneda, tipo, monto, motivo, creado_por)
      values (${cuentaId}::uuid, ${c.rows[0].moneda}, 'ajuste_operador', ${d.monto}, ${d.motivo.trim()}, ${operadorId})
    `.execute(trx);
    return { ok: true };
  });
}

/** Levantar el freno de una empresa hasta una fecha, con o sin tope extra. */
export async function levantarLimite(
  operadorId: string,
  cuentaId: string,
  d: { hasta: string; monto_extra?: number | null; motivo: string },
) {
  const hasta = new Date(d.hasta);
  if (Number.isNaN(hasta.getTime()) || hasta <= new Date()) throw new HttpError(400, '«Hasta» tiene que ser una fecha futura.');
  if (!d.motivo?.trim()) throw new HttpError(400, 'Un levante sin motivo no se puede explicar después: escribilo.');
  return withOperador(operadorId, async (trx) => {
    // Uno vigente por vez: el nuevo revoca al anterior.
    await sql`
      update levante_de_limite set revocado_en = now()
       where cuenta_id = ${cuentaId}::uuid and revocado_en is null
    `.execute(trx);
    const r = await sql<{ id: string }>`
      insert into levante_de_limite (cuenta_id, hasta, monto_extra, motivo, por)
      values (${cuentaId}::uuid, ${hasta.toISOString()}::timestamptz, ${d.monto_extra ?? null}, ${d.motivo.trim()}, ${operadorId})
      returning id
    `.execute(trx);
    return { ok: true, id: r.rows[0]!.id };
  });
}

export async function revocarLevante(operadorId: string, cuentaId: string) {
  return withOperador(operadorId, async (trx) => {
    const r = await sql`
      update levante_de_limite set revocado_en = now()
       where cuenta_id = ${cuentaId}::uuid and revocado_en is null
    `.execute(trx);
    return { ok: true, revocados: Number(r.numAffectedRows ?? 0) };
  });
}

// ── Paquetes de recarga ──

export async function listarPaquetes(operadorId: string) {
  return withOperador(operadorId, async (trx) => {
    const r = await sql<{
      id: string; codigo: string; nombre_i18n: unknown; pais: string | null; moneda: string;
      monto: string; bono: string; activo: boolean; orden: number;
    }>`
      select id, codigo, nombre_i18n, pais, moneda, monto::text, bono::text, activo, orden
        from paquete_recarga order by orden, codigo
    `.execute(trx);
    return { paquetes: r.rows.map((p) => ({ ...p, monto: Number(p.monto), bono: Number(p.bono) })) };
  });
}

export async function guardarPaquete(
  operadorId: string,
  d: { codigo: string; nombre_i18n: Record<string, string>; pais?: string | null; moneda: string; monto: number; bono?: number; activo?: boolean; orden?: number },
) {
  if (!/^[a-z0-9_-]{2,40}$/.test(d.codigo)) throw new HttpError(400, 'El código: minúsculas, números, guiones; 2 a 40.');
  if (!(d.monto > 0)) throw new HttpError(400, 'El monto tiene que ser mayor que cero.');
  if ((d.bono ?? 0) < 0) throw new HttpError(400, 'El bono no puede ser negativo.');
  return withOperador(operadorId, async (trx) => {
    await sql`
      insert into paquete_recarga (codigo, nombre_i18n, pais, moneda, monto, bono, activo, orden)
      values (${d.codigo}, ${JSON.stringify(d.nombre_i18n)}::jsonb, ${d.pais ? d.pais.toUpperCase() : null},
              ${d.moneda.toUpperCase()}, ${d.monto}, ${d.bono ?? 0}, ${d.activo ?? true}, ${d.orden ?? 100})
      on conflict (codigo) do update set
        nombre_i18n = excluded.nombre_i18n, pais = excluded.pais, moneda = excluded.moneda,
        monto = excluded.monto, bono = excluded.bono, activo = excluded.activo, orden = excluded.orden,
        actualizado_en = now()
    `.execute(trx);
    return { ok: true };
  });
}

export async function borrarPaquete(operadorId: string, codigo: string) {
  return withOperador(operadorId, async (trx) => {
    // Si alguna recarga lo usó, no se borra: se apaga.
    const usado = await sql<{ n: string }>`
      select count(*)::text as n from recarga r join paquete_recarga p on p.id = r.paquete_id where p.codigo = ${codigo}
    `.execute(trx);
    if (Number(usado.rows[0]?.n ?? 0) > 0) {
      await sql`update paquete_recarga set activo = false, actualizado_en = now() where codigo = ${codigo}`.execute(trx);
      return { ok: true, apagado: true };
    }
    await sql`delete from paquete_recarga where codigo = ${codigo}`.execute(trx);
    return { ok: true, borrado: true };
  });
}

// ── Lo que ve el emisor en /app ──

export async function saldoDeMiCuenta(cuentaId: string, identidadId: string) {
  return withUsuario(cuentaId, identidadId, async (trx: Transaction<DB>) => {
    const estado = await estadoDeSaldo(trx, cuentaId);
    const paquetes = await sql<{
      codigo: string; nombre_i18n: unknown; moneda: string; monto: string; bono: string;
    }>`
      select p.codigo, p.nombre_i18n, p.moneda, p.monto::text, p.bono::text
        from paquete_recarga p, cuenta c
       where c.id = ${cuentaId}::uuid and p.activo
         and (p.pais is null or p.pais = c.pais)
         and p.moneda = coalesce((select s.moneda from suscripcion s where s.cuenta_id = c.id and s.estado = 'activa'), c.moneda)
       order by p.orden
    `.execute(trx);
    return {
      estado,
      paquetes: paquetes.rows.map((p) => ({ ...p, monto: Number(p.monto), bono: Number(p.bono) })),
    };
  });
}
