import Decimal from 'decimal.js';
import type { Transaction } from 'kysely';
import type { DB } from '../db/schema';
import { withProvision, ownerDb } from '../db/owner';
import { withUsuario, puede } from '../auth/authz';
import { HttpError } from '../http/errors';
import { registrar } from './auditoria';
import { costoIaPeriodo } from './consumo_ia';
import { calcularFactura, type ReglasPlan, type TramoPrecio } from '../facturacion/motor';

// §billing multi-país: el tipo de comprobante lo define el país del cliente. Interfase
// factura todo desde UY: cliente UY -> e-Factura; cliente del exterior -> e-Factura de
// Exportación (IVA 0%). El detalle fiscal lo emite el ERP; acá sólo se resuelve el tipo.
export function resolverTipoComprobante(pais: string | null | undefined): string {
  return (pais || '').toUpperCase() === 'UY' ? 'efactura' : 'efactura_exportacion';
}

// Franja de precio tal como la maneja el servicio/rutas (precio como número o texto).
export interface FranjaEntrada {
  desde: number;
  hasta: number | null;
  precio: number | string;
}

async function cargarTramos(trx: Transaction<DB>, codigo: string): Promise<TramoPrecio[]> {
  const filas = await trx
    .selectFrom('plan_tramo')
    .select(['desde', 'hasta', 'precio_por_funcionario'])
    .where('plan_codigo', '=', codigo)
    .orderBy('desde')
    .execute();
  return filas.map((f) => ({ desde: f.desde, hasta: f.hasta, precio: new Decimal(f.precio_por_funcionario) }));
}

type Periodicidad = 'mensual' | 'semestral' | 'anual';

// Interpreta el período en cualquiera de los tres formatos y devuelve la ventana de
// fechas y la periodicidad que implica:
//   anual  -> YYYY        | semestral -> YYYY-S1 / YYYY-S2 | mensual -> YYYY-MM
function ventanaPeriodo(periodo: string): { inicio: string; fin: string; periodicidad: Periodicidad } {
  const pad = (n: number) => String(n).padStart(2, '0');

  if (/^[0-9]{4}$/.test(periodo)) {
    const y = Number(periodo);
    return { inicio: `${y}-01-01`, fin: `${y}-12-31`, periodicidad: 'anual' };
  }
  const sem = /^([0-9]{4})-S([12])$/.exec(periodo);
  if (sem) {
    const y = Number(sem[1]);
    const primero = sem[2] === '1';
    return {
      inicio: primero ? `${y}-01-01` : `${y}-07-01`,
      fin: primero ? `${y}-06-30` : `${y}-12-31`,
      periodicidad: 'semestral',
    };
  }
  const mes = /^([0-9]{4})-(0[1-9]|1[0-2])$/.exec(periodo);
  if (mes) {
    const y = Number(mes[1]);
    const m = Number(mes[2]);
    return { inicio: `${periodo}-01`, fin: `${y}-${pad(m)}-${pad(new Date(y, m, 0).getDate())}`, periodicidad: 'mensual' };
  }
  throw new HttpError(400, `Período inválido: ${periodo} (esperado YYYY-MM, YYYY-S1/S2 o YYYY)`);
}

// Cuenta funcionarios activos (relaciones vigentes) en una ventana de fechas.
async function contarFuncionariosActivos(
  trx: Transaction<DB>,
  cuentaId: string | null,
  inicio: string,
  fin: string,
): Promise<number> {
  let q = trx
    .selectFrom('relacion_laboral')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('fecha_ingreso', '<=', fin)
    .where((eb) => eb.or([eb('fecha_egreso', 'is', null), eb('fecha_egreso', '>=', inicio)]));
  if (cuentaId) q = q.where('cuenta_id', '=', cuentaId); // operador (owner) filtra explícito
  const r = await q.executeTakeFirst();
  return Number(r?.n ?? 0);
}

async function cargarReglasPlan(
  trx: Transaction<DB>,
  codigo: string,
): Promise<{ reglas: ReglasPlan; periodicidad: Periodicidad }> {
  const p = await trx
    .selectFrom('plan')
    .select(['modo_precio', 'precio_fijo', 'precio_por_funcionario', 'funcionarios_gratis', 'moneda', 'periodo'])
    .where('codigo', '=', codigo)
    .where('activo', '=', true)
    .executeTakeFirst();
  if (!p) throw new HttpError(404, `Plan no encontrado o inactivo: ${codigo}`);
  const tramos = p.modo_precio === 'por_funcionario' ? await cargarTramos(trx, codigo) : [];
  return {
    reglas: {
      modo: p.modo_precio === 'fijo' ? 'fijo' : 'por_funcionario',
      precioFijo: new Decimal(p.precio_fijo),
      precioPorFuncionario: new Decimal(p.precio_por_funcionario),
      funcionariosGratis: p.funcionarios_gratis,
      tramos,
      moneda: p.moneda,
    },
    periodicidad: p.periodo as Periodicidad,
  };
}

// ===================== OPERADOR (conexión privilegiada) =====================

/** Cupo del plan: si el plan de la empresa tiene tope de empleados (free tier), verifica que no
 * se supere al dar de alta. Si el plan no tiene tope (NULL) o no hay suscripción, no limita.
 * Vive en el dominio de facturación; se llama desde el alta de empleados. */
export async function verificarCupoAlta(trx: Transaction<DB>, cuentaId: string): Promise<void> {
  const sus = await trx
    .selectFrom('suscripcion')
    .innerJoin('plan', 'plan.codigo', 'suscripcion.plan_codigo')
    .select(['plan.limite_funcionarios as limite', 'plan.nombre as planNombre'])
    .where('suscripcion.cuenta_id', '=', cuentaId)
    .executeTakeFirst();
  if (!sus || sus.limite == null) return;
  const r = await trx
    .selectFrom('relacion_laboral')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('cuenta_id', '=', cuentaId)
    .where('fecha_egreso', 'is', null)
    .executeTakeFirst();
  const activos = Number(r?.n ?? 0);
  if (activos >= sus.limite) {
    throw new HttpError(
      402,
      `Tu plan ${sus.planNombre} permite hasta ${sus.limite} empleados activos. Pasá a un plan superior para agregar más.`,
    );
  }
}

/** Asigna (o cambia) el plan de una empresa. Operación del operador / webhook de pago. */
export async function suscribir(cuentaId: string, planCodigo: string, estado = 'activa') {
  return withProvision(cuentaId, async (trx) => {
    await cargarReglasPlan(trx, planCodigo); // valida que el plan exista
    await trx
      .insertInto('suscripcion')
      .values({ cuenta_id: cuentaId, plan_codigo: planCodigo, estado })
      .onConflict((oc) => oc.column('cuenta_id').doUpdateSet({ plan_codigo: planCodigo, estado }))
      .execute();
    return { cuenta_id: cuentaId, plan_codigo: planCodigo, estado };
  });
}

/**
 * Factura un período a una empresa: cuenta sus funcionarios activos, aplica el plan
 * y emite una factura inmutable. Idempotente: si ya hay factura del período, la
 * devuelve sin recalcular. Operación del operador.
 */
export async function facturarPeriodo(cuentaId: string, periodo: string) {
  const v = ventanaPeriodo(periodo);
  return withProvision(cuentaId, async (trx) => {
    const existente = await trx
      .selectFrom('factura_plataforma')
      .select(['id', 'monto', 'moneda', 'funcionarios_facturables'])
      .where('cuenta_id', '=', cuentaId)
      .where('periodo', '=', periodo)
      .executeTakeFirst();
    if (existente) {
      return { id: existente.id, periodo, monto: existente.monto, moneda: existente.moneda, ya_existia: true };
    }

    const sus = await trx
      .selectFrom('suscripcion')
      .select(['plan_codigo'])
      .where('cuenta_id', '=', cuentaId)
      .executeTakeFirst();
    if (!sus) throw new HttpError(400, 'La empresa no tiene un plan asignado (suscribila primero).');

    const { reglas, periodicidad } = await cargarReglasPlan(trx, sus.plan_codigo);
    // El formato del período debe coincidir con la periodicidad del plan.
    if (periodicidad !== v.periodicidad) {
      const formato = periodicidad === 'anual' ? 'YYYY' : periodicidad === 'semestral' ? 'YYYY-S1/S2' : 'YYYY-MM';
      throw new HttpError(400, `El plan es ${periodicidad}; el período debe tener formato ${formato}.`);
    }

    const contados = await contarFuncionariosActivos(trx, cuentaId, v.inicio, v.fin);
    const r = calcularFactura(reglas, contados);

    // §billing IA: costo del asistente en el período (con margen e incluido de la empresa).
    const ia = await costoIaPeriodo(trx, cuentaId, periodo);
    const montoTotal = r.monto.add(ia.facturable);

    // §billing multi-país: snapshot de los datos fiscales del receptor + tipo de
    // comprobante resuelto por su país, congelados en la factura (comprobante inmutable).
    const emp = await trx
      .selectFrom('empresa')
      .select(['pais', 'razon_social', 'nombre', 'id_fiscal'])
      .where('id', '=', cuentaId)
      .executeTakeFirst();
    const receptorPais = emp?.pais ?? null;

    const fila = await trx
      .insertInto('factura_plataforma')
      .values({
        cuenta_id: cuentaId,
        periodo,
        plan_codigo: sus.plan_codigo,
        moneda: r.moneda,
        funcionarios_contados: r.funcionariosContados,
        funcionarios_facturables: r.funcionariosFacturables,
        precio_unitario: r.precioUnitario.toFixed(4),
        monto: montoTotal.toFixed(4),
        monto_base: r.monto.toFixed(4),
        monto_ia: ia.facturable.toFixed(4),
        tipo_comprobante: resolverTipoComprobante(receptorPais),
        receptor_pais: receptorPais,
        receptor_razon_social: emp?.razon_social ?? emp?.nombre ?? null,
        receptor_id_fiscal: emp?.id_fiscal ?? null,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    return {
      id: fila.id,
      periodo,
      plan_codigo: sus.plan_codigo,
      moneda: r.moneda,
      funcionarios_contados: r.funcionariosContados,
      funcionarios_facturables: r.funcionariosFacturables,
      monto_base: r.monto.toFixed(2),
      monto_ia: ia.facturable.toFixed(2),
      monto: montoTotal.toFixed(2),
      ya_existia: false,
    };
  });
}

/** Marca una factura como pagada (lo dispararía el webhook de la pasarela). Operador. */
export async function marcarFacturaPagada(cuentaId: string, periodo: string) {
  return withProvision(cuentaId, async (trx) => {
    await trx
      .updateTable('factura_plataforma')
      .set({ estado: 'pagada' })
      .where('cuenta_id', '=', cuentaId)
      .where('periodo', '=', periodo)
      .execute();
    return { ok: true };
  });
}

// ===================== CLIENTE (lecturas con su identidad) =====================

/** El admin de la empresa ve su plan, estado y una estimación de lo que pagaría. */
export async function verSuscripcion(cuentaId: string, usuarioId: string) {
  return withUsuario(cuentaId, usuarioId, async (trx) => {
    const s = await trx
      .selectFrom('suscripcion')
      .select(['plan_codigo', 'estado', 'inicio', 'fin', 'medio_cobro'])
      .where('cuenta_id', '=', cuentaId)
      .executeTakeFirst();
    if (!s) return { suscripto: false };

    // §billing multi-país: país del cliente (define el comprobante que recibirá) y si
    // el giro bancario está disponible (sólo UY). RLS limita a su propia empresa.
    const emp = await trx.selectFrom('empresa').select(['pais']).where('id', '=', cuentaId).executeTakeFirst();
    const pais = emp?.pais ?? null;

    const plan = await trx
      .selectFrom('plan')
      .select([
        'codigo',
        'nombre',
        'moneda',
        'modo_precio',
        'precio_fijo',
        'precio_por_funcionario',
        'funcionarios_gratis',
        'periodo',
      ])
      .where('codigo', '=', s.plan_codigo)
      .executeTakeFirst();

    const hoy = new Date().toISOString().slice(0, 10);
    const contados = await contarFuncionariosActivos(trx, null, hoy, hoy); // RLS limita a su empresa

    const tramos = plan && plan.modo_precio === 'por_funcionario' ? await cargarTramos(trx, plan.codigo) : [];

    let estimado: { facturables: number; monto: string; moneda: string } | null = null;
    if (plan) {
      const r = calcularFactura(
        {
          modo: plan.modo_precio === 'fijo' ? 'fijo' : 'por_funcionario',
          precioFijo: new Decimal(plan.precio_fijo),
          precioPorFuncionario: new Decimal(plan.precio_por_funcionario),
          funcionariosGratis: plan.funcionarios_gratis,
          tramos,
          moneda: plan.moneda,
        },
        contados,
      );
      estimado = { facturables: r.funcionariosFacturables, monto: r.monto.toFixed(2), moneda: r.moneda };
    }

    const franjas = tramos.map((t) => ({ desde: t.desde, hasta: t.hasta, precio: t.precio.toFixed(2) }));
    return {
      suscripto: true,
      plan,
      estado: s.estado,
      inicio: s.inicio,
      funcionarios_contados: contados,
      franjas,
      estimado,
      medio_cobro: s.medio_cobro,
      pais,
      giro_disponible: (pais || '').toUpperCase() === 'UY',
      tipo_comprobante: resolverTipoComprobante(pais),
    };
  });
}

/**
 * Cambia el medio de cobro de la empresa (tarjeta | giro). El giro bancario sólo se
 * admite para clientes uruguayos; para el resto, sólo tarjeta. Gateado por admin de
 * empresa (mismo permiso que el resto de la configuración). Dominio billing.
 */
export async function fijarMedioCobro(cuentaId: string, usuarioId: string, medio: string) {
  if (medio !== 'tarjeta' && medio !== 'giro') throw new HttpError(400, 'Medio de cobro inválido.');
  return withUsuario(cuentaId, usuarioId, async (trx, autz) => {
    if (!puede(autz, 'usuario', 'escribir')) throw new HttpError(403, 'No tenés permiso para cambiar la facturación.');
    if (medio === 'giro') {
      const emp = await trx.selectFrom('empresa').select(['pais']).where('id', '=', cuentaId).executeTakeFirst();
      if ((emp?.pais || '').toUpperCase() !== 'UY') throw new HttpError(400, 'El giro bancario sólo está disponible para empresas de Uruguay.');
    }
    await trx.updateTable('suscripcion').set({ medio_cobro: medio }).where('cuenta_id', '=', cuentaId).execute();
    await registrar(trx, cuentaId, usuarioId, { accion: 'editar', recurso: 'suscripcion', detalle: 'medio_cobro=' + medio });
    return { medio_cobro: medio };
  });
}

/** El admin de la empresa ve sus facturas de plataforma. */
export async function listarFacturas(cuentaId: string, usuarioId: string) {
  return withUsuario(cuentaId, usuarioId, async (trx) => {
    const facturas = await trx
      .selectFrom('factura_plataforma')
      .select([
        'id',
        'periodo',
        'plan_codigo',
        'moneda',
        'funcionarios_contados',
        'funcionarios_facturables',
        'precio_unitario',
        'monto',
        'estado',
        'emitida_at',
      ])
      .orderBy('periodo desc')
      .execute();
    return { facturas };
  });
}

// ===================== OPERADOR: administración (consola aparte) =====================
// Estas operaciones cruzan empresas y tocan los planes globales: son del operador del
// SaaS, no de un cliente. Por eso usan la conexión privilegiada (owner) directamente.

export interface DatosPlan {
  codigo: string;
  nombre: string;
  moneda?: string;
  modoPrecio?: 'fijo' | 'por_funcionario';
  precioFijo?: string | number;
  precioPorFuncionario?: string | number;
  funcionariosGratis?: number;
  periodo?: 'mensual' | 'semestral' | 'anual';
  vigenteDesde?: string;
  tramos?: FranjaEntrada[];
  // §billing IA (valores por defecto del asistente para el plan)
  asistenteIa?: boolean;
  iaCobra?: boolean;
  iaMargenPct?: string | number;
  iaIncluido?: string | number;
}

export interface CambiosPlan {
  nombre?: string;
  moneda?: string;
  modoPrecio?: 'fijo' | 'por_funcionario';
  precioFijo?: string | number;
  precioPorFuncionario?: string | number;
  funcionariosGratis?: number;
  periodo?: 'mensual' | 'semestral' | 'anual';
  activo?: boolean;
  vigenteHasta?: string | null;
  tramos?: FranjaEntrada[];
  // §billing IA
  asistenteIa?: boolean;
  iaCobra?: boolean;
  iaMargenPct?: string | number;
  iaIncluido?: string | number;
}

// Normaliza y ordena las franjas que llegan de afuera (descarta vacías/ inválidas).
function normalizarFranjas(tramos: FranjaEntrada[]): FranjaEntrada[] {
  return tramos
    .map((t) => ({
      desde: Math.max(0, Math.trunc(Number(t.desde))),
      hasta: t.hasta == null ? null : Math.trunc(Number(t.hasta)),
      precio: String(t.precio ?? 0),
    }))
    .filter((t) => Number.isFinite(t.desde) && (t.hasta == null || Number.isFinite(t.hasta)))
    .sort((a, b) => a.desde - b.desde);
}

async function reemplazarTramos(trx: Transaction<DB>, codigo: string, tramos: FranjaEntrada[]) {
  await trx.deleteFrom('plan_tramo').where('plan_codigo', '=', codigo).execute();
  const limpias = normalizarFranjas(tramos);
  if (limpias.length) {
    await trx
      .insertInto('plan_tramo')
      .values(
        limpias.map((t) => ({
          plan_codigo: codigo,
          desde: t.desde,
          hasta: t.hasta,
          precio_por_funcionario: String(t.precio),
        })),
      )
      .execute();
  }
}

export async function listarPlanes() {
  const planes = await ownerDb()
    .selectFrom('plan')
    .select([
      'codigo',
      'nombre',
      'moneda',
      'modo_precio',
      'precio_fijo',
      'precio_por_funcionario',
      'funcionarios_gratis',
      'periodo',
      'vigente_desde',
      'vigente_hasta',
      'activo',
      'asistente_ia',
      'ia_cobra',
      'ia_margen_pct',
      'ia_incluido',
    ])
    .orderBy('codigo')
    .execute();

  const tramos = await ownerDb()
    .selectFrom('plan_tramo')
    .select(['plan_codigo', 'desde', 'hasta', 'precio_por_funcionario'])
    .orderBy('desde')
    .execute();
  const porPlan = new Map<string, { desde: number; hasta: number | null; precio: string }[]>();
  for (const t of tramos) {
    const a = porPlan.get(t.plan_codigo) ?? [];
    a.push({ desde: t.desde, hasta: t.hasta, precio: t.precio_por_funcionario });
    porPlan.set(t.plan_codigo, a);
  }

  const subs = await ownerDb()
    .selectFrom('suscripcion')
    .select(['plan_codigo', (eb) => eb.fn.countAll<string>().as('n')])
    .groupBy('plan_codigo')
    .execute();
  const empresasPorPlan = new Map(subs.map((s) => [s.plan_codigo, Number(s.n)]));

  return {
    planes: planes.map((p) => ({
      ...p,
      tramos: porPlan.get(p.codigo) ?? [],
      empresas: empresasPorPlan.get(p.codigo) ?? 0,
    })),
  };
}

/**
 * Catálogo PÚBLICO de planes, para el sitio comercial y el enrolamiento.
 * Devuelve solo planes activos y solo lo necesario para mostrar el precio
 * (modalidad, importe / franjas, periodicidad). Sin conteos ni datos internos.
 * Las cifras salen del plan (datos versionados), nunca de texto suelto.
 */
export async function listarPlanesPublicos() {
  const planes = await ownerDb()
    .selectFrom('plan')
    .select([
      'codigo',
      'nombre',
      'moneda',
      'modo_precio',
      'precio_fijo',
      'precio_por_funcionario',
      'funcionarios_gratis',
      'periodo',
    ])
    .where('activo', '=', true)
    .orderBy('precio_fijo')
    .orderBy('codigo')
    .execute();

  const tramos = await ownerDb()
    .selectFrom('plan_tramo')
    .select(['plan_codigo', 'desde', 'hasta', 'precio_por_funcionario'])
    .orderBy('desde')
    .execute();
  const porPlan = new Map<string, { desde: number; hasta: number | null; precio: string }[]>();
  for (const t of tramos) {
    const a = porPlan.get(t.plan_codigo) ?? [];
    a.push({ desde: t.desde, hasta: t.hasta, precio: t.precio_por_funcionario });
    porPlan.set(t.plan_codigo, a);
  }

  return {
    planes: planes.map((p) => ({ ...p, tramos: porPlan.get(p.codigo) ?? [] })),
  };
}

export async function crearPlan(d: DatosPlan) {
  const existe = await ownerDb()
    .selectFrom('plan')
    .select('codigo')
    .where('codigo', '=', d.codigo)
    .executeTakeFirst();
  if (existe) throw new HttpError(409, `Ya existe un plan con código "${d.codigo}".`);

  return ownerDb()
    .transaction()
    .execute(async (trx) => {
      await trx
        .insertInto('plan')
        .values({
          codigo: d.codigo,
          nombre: d.nombre,
          moneda: d.moneda ?? 'USD',
          modo_precio: d.modoPrecio ?? 'por_funcionario',
          precio_fijo: String(d.precioFijo ?? 0),
          precio_por_funcionario: String(d.precioPorFuncionario ?? 0),
          funcionarios_gratis: d.funcionariosGratis ?? 0,
          periodo: d.periodo ?? 'mensual',
          asistente_ia: d.asistenteIa ?? true,
          ia_cobra: d.iaCobra ?? false,
          ia_margen_pct: String(d.iaMargenPct ?? 0),
          ia_incluido: String(d.iaIncluido ?? 0),
          ...(d.vigenteDesde ? { vigente_desde: d.vigenteDesde } : {}),
        })
        .execute();
      if (d.modoPrecio === 'por_funcionario' && d.tramos) {
        await reemplazarTramos(trx, d.codigo, d.tramos);
      }
      return { ok: true, codigo: d.codigo };
    });
}

export async function editarPlan(codigo: string, c: CambiosPlan) {
  const set: Partial<{
    nombre: string;
    moneda: string;
    modo_precio: string;
    precio_fijo: string;
    precio_por_funcionario: string;
    funcionarios_gratis: number;
    periodo: string;
    activo: boolean;
    vigente_hasta: string | null;
    asistente_ia: boolean;
    ia_cobra: boolean;
    ia_margen_pct: string;
    ia_incluido: string;
  }> = {};
  if (c.nombre !== undefined) set.nombre = c.nombre;
  if (c.moneda !== undefined) set.moneda = c.moneda;
  if (c.modoPrecio !== undefined) set.modo_precio = c.modoPrecio;
  if (c.precioFijo !== undefined) set.precio_fijo = String(c.precioFijo);
  if (c.precioPorFuncionario !== undefined) set.precio_por_funcionario = String(c.precioPorFuncionario);
  if (c.funcionariosGratis !== undefined) set.funcionarios_gratis = c.funcionariosGratis;
  if (c.periodo !== undefined) set.periodo = c.periodo;
  if (c.activo !== undefined) set.activo = c.activo;
  if (c.vigenteHasta !== undefined) set.vigente_hasta = c.vigenteHasta;
  if (c.asistenteIa !== undefined) set.asistente_ia = c.asistenteIa;
  if (c.iaCobra !== undefined) set.ia_cobra = c.iaCobra;
  if (c.iaMargenPct !== undefined) set.ia_margen_pct = String(c.iaMargenPct);
  if (c.iaIncluido !== undefined) set.ia_incluido = String(c.iaIncluido);

  return ownerDb()
    .transaction()
    .execute(async (trx) => {
      if (Object.keys(set).length > 0) {
        const r = await trx.updateTable('plan').set(set).where('codigo', '=', codigo).executeTakeFirstOrThrow();
        if (Number(r.numUpdatedRows) === 0) throw new HttpError(404, `Plan no encontrado: ${codigo}`);
      }
      // Si mandan franjas, reemplazan a las anteriores. Si el modo pasa a 'fijo', se limpian.
      if (c.tramos !== undefined) {
        await reemplazarTramos(trx, codigo, c.tramos);
      } else if (c.modoPrecio === 'fijo') {
        await trx.deleteFrom('plan_tramo').where('plan_codigo', '=', codigo).execute();
      }
      return { ok: true, codigo };
    });
}

/** Borra un plan, solo si ninguna empresa lo tiene asignado. Sus franjas caen en cascada. */
export async function eliminarPlan(codigo: string) {
  const r = await ownerDb()
    .selectFrom('suscripcion')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('plan_codigo', '=', codigo)
    .executeTakeFirst();
  if (Number(r?.n ?? 0) > 0) {
    throw new HttpError(409, 'No se puede borrar: el plan tiene empresas asignadas.');
  }
  const del = await ownerDb().deleteFrom('plan').where('codigo', '=', codigo).executeTakeFirstOrThrow();
  if (Number(del.numDeletedRows) === 0) throw new HttpError(404, `Plan no encontrado: ${codigo}`);
  return { ok: true, codigo };
}

/** Todas las empresas con su plan/estado y cuántos funcionarios activos tienen hoy. */
export async function listarEmpresasConPlan() {
  const empresas = await ownerDb()
    .selectFrom('empresa')
    .leftJoin('suscripcion', 'suscripcion.cuenta_id', 'empresa.id')
    .leftJoin('plan', 'plan.codigo', 'suscripcion.plan_codigo')
    .select([
      'empresa.id as id',
      'empresa.nombre as nombre',
      'empresa.pais as pais',
      'empresa.moneda as moneda',
      'empresa.ofertas_habilitado as ofertas_habilitado',
      'suscripcion.plan_codigo as plan_codigo',
      'suscripcion.estado as estado',
      'plan.periodo as plan_periodo',
      'plan.modo_precio as plan_modo',
      // §billing IA: override de la empresa (NULL = hereda) + default del plan
      'suscripcion.asistente_ia as ia_asistente_ovr',
      'suscripcion.ia_cobra as ia_cobra_ovr',
      'suscripcion.ia_margen_pct as ia_margen_ovr',
      'suscripcion.ia_incluido as ia_incluido_ovr',
      'plan.asistente_ia as ia_asistente_plan',
      'plan.ia_cobra as ia_cobra_plan',
      'plan.ia_margen_pct as ia_margen_plan',
      'plan.ia_incluido as ia_incluido_plan',
    ])
    .orderBy('empresa.nombre')
    .execute();

  const hoy = new Date().toISOString().slice(0, 10);
  const conteos = await ownerDb()
    .selectFrom('relacion_laboral')
    .select(['cuenta_id', (eb) => eb.fn.countAll<string>().as('n')])
    .where('fecha_ingreso', '<=', hoy)
    .where((eb) => eb.or([eb('fecha_egreso', 'is', null), eb('fecha_egreso', '>=', hoy)]))
    .groupBy('cuenta_id')
    .execute();
  const mapa = new Map(conteos.map((c) => [c.cuenta_id, Number(c.n)]));

  return { empresas: empresas.map((e) => ({ ...e, funcionarios: mapa.get(e.id) ?? 0 })) };
}

/** Facturas de una empresa (vista del operador, sin pasar por RLS del cliente). */
export async function facturasDeEmpresa(cuentaId: string) {
  const facturas = await ownerDb()
    .selectFrom('factura_plataforma')
    .select(['id', 'periodo', 'plan_codigo', 'moneda', 'funcionarios_facturables', 'monto', 'estado', 'emitida_at'])
    .where('cuenta_id', '=', cuentaId)
    .orderBy('periodo desc')
    .execute();
  return { facturas };
}
