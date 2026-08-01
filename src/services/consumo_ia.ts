import Decimal from 'decimal.js';
import type { Transaction } from 'kysely';
import type { DB } from '../db/schema';
import { withUsuario } from '../auth/authz';
import { operadorDb } from '../db/pool';
import { HttpError } from '../http/errors';

// =============================================================================
// Consumo y costeo del asistente conversacional (dominio platform billing).
//
// - registrarConsumoIA: guarda los tokens de una conversación y congela su costo
//   base según la tarifa vigente del modelo (regla de oro nº1: se mide, no se estima).
// - asistenteHabilitado: gate on/off del asistente por empresa (override -> plan).
// - costoIaPeriodo: lo usa facturarPeriodo para agregar la línea de IA a la factura.
//
// La configuración efectiva de cada empresa es el override de su suscripción sobre los
// valores por defecto del plan (NULL en la suscripción = hereda del plan). Así se decide
// por cliente: no cobrar, cambiar el margen, o apagar el asistente para una empresa puntual.
//
// NOTA DE MONEDA: el costo se calcula en la moneda de la tarifa del modelo. Para que el
// margen y el crédito incluido (que están en la moneda del plan) se combinen bien, la
// tarifa del modelo debe cargarse en la MISMA moneda que el plan. La conversión
// multi-moneda (tarifa en USD -> factura en UYU/PYG con tipo de cambio) queda pendiente.
// =============================================================================

export interface ConfigIA {
  habilitado: boolean;
  cobra: boolean;
  margenPct: Decimal;
  incluido: Decimal;
  moneda: string;
}

const CONFIG_APAGADA: ConfigIA = {
  habilitado: false,
  cobra: false,
  margenPct: new Decimal(0),
  incluido: new Decimal(0),
  moneda: 'UYU',
};

// Config efectiva del asistente para una empresa: override de suscripción sobre el plan.
async function configIA(trx: Transaction<DB>, cuentaId: string): Promise<ConfigIA> {
  const row = await trx
    .selectFrom('suscripcion as s')
    .innerJoin('plan as p', 'p.id', 's.plan_id')
    .select([
      's.asistente_ia as s_hab',
      'p.asistente_ia as p_hab',
      's.ia_cobra as s_cobra',
      'p.ia_cobra as p_cobra',
      's.ia_margen_pct as s_margen',
      'p.ia_margen_pct as p_margen',
      's.ia_incluido as s_incl',
      'p.ia_incluido as p_incl',
      's.moneda as moneda',
    ])
    .where('s.cuenta_id', '=', cuentaId)
    .executeTakeFirst();
  if (!row) return CONFIG_APAGADA;
  const pick = <T,>(s: T | null | undefined, p: T | null | undefined): T | null | undefined =>
    s === null || s === undefined ? p : s;
  return {
    habilitado: pick(row.s_hab, row.p_hab) ?? true,
    cobra: pick(row.s_cobra, row.p_cobra) ?? false,
    margenPct: new Decimal(pick(row.s_margen, row.p_margen) ?? 0),
    incluido: new Decimal(pick(row.s_incl, row.p_incl) ?? 0),
    moneda: row.moneda,
  };
}

async function tarifaVigente(trx: Transaction<DB>, modelo: string) {
  const hoy = new Date();
  const t = await trx
    .selectFrom('tarifa_ia')
    .select(['precio_input_millon', 'precio_output_millon', 'moneda'])
    .where('modelo', '=', modelo)
    .where('vigente_desde', '<=', hoy)
    .where((eb) => eb.or([eb('vigente_hasta', 'is', null), eb('vigente_hasta', '>=', hoy)]))
    .orderBy('vigente_desde', 'desc')
    .executeTakeFirst();
  if (!t) return null;
  return {
    input: new Decimal(t.precio_input_millon),
    output: new Decimal(t.precio_output_millon),
    moneda: t.moneda,
  };
}

/**
 * Registra el consumo de una conversación y congela su costo base con la tarifa del
 * momento. Corre bajo la identidad del usuario => RLS por empresa. Nunca tira: medir
 * no debe romper la conversación (si algo falla, se loguea y sigue).
 */
export async function registrarConsumoIA(
  cuentaId: string,
  usuarioId: string,
  datos: { periodo: string; modelo: string; inputTokens: number; outputTokens: number },
): Promise<void> {
  try {
    await withUsuario(cuentaId, usuarioId, async (trx) => {
      const tarifa = await tarifaVigente(trx, datos.modelo);
      const costo = tarifa
        ? new Decimal(datos.inputTokens)
            .div(1_000_000)
            .mul(tarifa.input)
            .add(new Decimal(datos.outputTokens).div(1_000_000).mul(tarifa.output))
        : new Decimal(0);
      await trx
        .insertInto('consumo_ia')
        .values({
          cuenta_id: cuentaId,
          periodo: datos.periodo,
          modelo: datos.modelo,
          input_tokens: datos.inputTokens,
          output_tokens: datos.outputTokens,
          costo_base: costo.toFixed(6),
          moneda: tarifa?.moneda ?? 'USD',
        })
        .execute();
    });
  } catch (e) {
    console.error('registrarConsumoIA:', (e as Error).message);
  }
}

/** ¿Está habilitado el asistente para esta empresa? (override de suscripción -> plan) */
export async function asistenteHabilitado(cuentaId: string, usuarioId: string): Promise<boolean> {
  try {
    return await withUsuario(cuentaId, usuarioId, async (trx) => (await configIA(trx, cuentaId)).habilitado);
  } catch {
    return true; // ante un fallo de lectura, no bloquear el asistente
  }
}

/**
 * Costo de IA de un período para la factura. Lo llama facturarPeriodo con su transacción
 * de provisión. Devuelve el costo base (sin margen) y el facturable (con margen, menos el
 * crédito incluido, nunca negativo). Si la empresa no cobra IA, facturable = 0.
 */
export async function costoIaPeriodo(
  trx: Transaction<DB>,
  cuentaId: string,
  periodo: string,
): Promise<{ base: Decimal; facturable: Decimal; moneda: string }> {
  const cfg = await configIA(trx, cuentaId);
  const row = await trx
    .selectFrom('consumo_ia')
    .select((eb) => [eb.fn.sum('costo_base').as('total')])
    .where('cuenta_id', '=', cuentaId)
    .where('periodo', '=', periodo)
    .executeTakeFirst();
  const base = new Decimal((row?.total as string | null) ?? 0);
  if (!cfg.cobra) return { base, facturable: new Decimal(0), moneda: cfg.moneda };
  const conMargen = base.mul(new Decimal(1).add(cfg.margenPct.div(100)));
  const facturable = Decimal.max(new Decimal(0), conMargen.sub(cfg.incluido));
  return { base, facturable, moneda: cfg.moneda };
}

// =============================================================================
// CRUD de tarifas de IA (catálogo de plataforma, lo mantiene el operador con operadorDb).
// Versionado por fecha: al guardar una tarifa nueva de un modelo, se cierra la vigencia
// de la anterior. Nunca se edita una tarifa pasada (queda como histórico).
// =============================================================================

export async function listarTarifasIa() {
  const tarifas = await operadorDb()
    .selectFrom('tarifa_ia')
    .select([
      'id',
      'modelo',
      'moneda',
      'precio_input_millon',
      'precio_output_millon',
      'vigente_desde',
      'vigente_hasta',
    ])
    .orderBy('modelo')
    .orderBy('vigente_desde', 'desc')
    .execute();
  return { tarifas };
}

export async function guardarTarifaIa(d: {
  modelo: string;
  moneda?: string;
  precioInputMillon: number | string;
  precioOutputMillon: number | string;
  vigenteDesde?: string;
}) {
  const desde =
    d.vigenteDesde && /^\d{4}-\d{2}-\d{2}$/.test(d.vigenteDesde)
      ? d.vigenteDesde
      : new Date().toISOString().slice(0, 10);
  const anterior = new Date(new Date(desde).getTime() - 86400000).toISOString().slice(0, 10);
  return operadorDb()
    .transaction()
    .execute(async (trx) => {
      // Cerrar la versión vigente anterior del mismo modelo (si la hay).
      await trx
        .updateTable('tarifa_ia')
        .set({ vigente_hasta: anterior })
        .where('modelo', '=', d.modelo)
        .where('vigente_hasta', 'is', null)
        .execute();
      await trx
        .insertInto('tarifa_ia')
        .values({
          modelo: d.modelo,
          moneda: d.moneda ?? 'USD',
          precio_input_millon: String(d.precioInputMillon),
          precio_output_millon: String(d.precioOutputMillon),
          vigente_desde: desde,
        })
        .execute();
      return { ok: true };
    });
}

export async function eliminarTarifaIa(id: string) {
  const r = await operadorDb().deleteFrom('tarifa_ia').where('id', '=', id).executeTakeFirst();
  if (Number(r.numDeletedRows) === 0) throw new HttpError(404, 'Tarifa no encontrada.');
  return { ok: true };
}

// Override de la config de IA de una empresa (en su suscripción). NULL = hereda del plan.
export async function setOverrideIaEmpresa(
  cuentaId: string,
  c: {
    asistenteIa?: boolean | null;
    iaCobra?: boolean | null;
    iaMargenPct?: number | string | null;
    iaIncluido?: number | string | null;
  },
) {
  const set: Record<string, unknown> = {};
  if (c.asistenteIa !== undefined) set.asistente_ia = c.asistenteIa;
  if (c.iaCobra !== undefined) set.ia_cobra = c.iaCobra;
  if (c.iaMargenPct !== undefined) set.ia_margen_pct = c.iaMargenPct === null ? null : String(c.iaMargenPct);
  if (c.iaIncluido !== undefined) set.ia_incluido = c.iaIncluido === null ? null : String(c.iaIncluido);
  if (Object.keys(set).length === 0) return { ok: true };
  const r = await operadorDb()
    .updateTable('suscripcion')
    .set(set)
    .where('cuenta_id', '=', cuentaId)
    .executeTakeFirst();
  if (Number(r.numUpdatedRows) === 0) throw new HttpError(404, 'La empresa no tiene suscripción activa.');
  return { ok: true };
}
