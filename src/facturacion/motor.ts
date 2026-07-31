import Decimal from 'decimal.js';

/**
 * MOTOR DE FACTURACIÓN DE PLATAFORMA (empresa -> SaaS), puro y determinista.
 * Hermano del motor de liquidación: dadas las reglas del plan (datos) y el uso del
 * período (cantidad de funcionarios), calcula el monto. No conoce la base de datos.
 *
 * Modalidades de precio:
 *   - 'fijo': un monto único, sin importar la cantidad de funcionarios.
 *   - 'por_funcionario':
 *       * con FRANJAS: cada franja tiene [desde, hasta] y un precio/func. El cálculo
 *         es GRADUADO: cada funcionario se cobra según la franja en la que cae.
 *         Ej. franjas 0-10:0, 11-50:2, 51+:1 ; 60 funcionarios => 0 + 40*2 + 10*1 = 90.
 *       * sin franjas: modelo simple, gratis + precio/func.
 *         facturables = max(0, contados - gratis) ; monto = facturables * precio.
 *
 * La periodicidad (mensual / semestral / anual) NO entra aca: el precio que carga el
 * operador ya es el de UN periodo de esa periodicidad. La periodicidad solo define
 * cada cuanto se factura y la ventana de conteo (eso vive en el servicio).
 */
export type ModoPrecio = 'fijo' | 'por_funcionario';

export interface TramoPrecio {
  desde: number;
  hasta: number | null; // null = sin tope
  precio: Decimal;
}

export interface ReglasPlan {
  modo: ModoPrecio;
  precioFijo: Decimal;
  precioPorFuncionario: Decimal;
  funcionariosGratis: number;
  tramos: TramoPrecio[];
  moneda: string;
}

export interface ResultadoFactura {
  funcionariosContados: number;
  funcionariosFacturables: number;
  precioUnitario: Decimal;
  monto: Decimal;
  moneda: string;
}

export function calcularFactura(plan: ReglasPlan, funcionariosContados: number): ResultadoFactura {
  const contados = Math.max(0, Math.trunc(funcionariosContados));

  if (plan.modo === 'fijo') {
    // El monto es el precio fijo; la cantidad de funcionarios queda informativa.
    return {
      funcionariosContados: contados,
      funcionariosFacturables: 1,
      precioUnitario: plan.precioFijo,
      monto: plan.precioFijo,
      moneda: plan.moneda,
    };
  }

  // por_funcionario con FRANJAS (graduado).
  if (plan.tramos && plan.tramos.length > 0) {
    const tramos = [...plan.tramos].sort((a, b) => a.desde - b.desde);
    let monto = new Decimal(0);
    let facturables = 0;
    for (const t of tramos) {
      const ini = Math.max(t.desde, 1); // los funcionarios se cuentan desde 1
      const tope = t.hasta == null ? contados : Math.min(contados, t.hasta);
      const enTramo = Math.max(0, tope - ini + 1);
      if (enTramo > 0) {
        monto = monto.plus(t.precio.mul(enTramo));
        if (t.precio.gt(0)) facturables += enTramo;
      }
    }
    return {
      funcionariosContados: contados,
      funcionariosFacturables: facturables,
      precioUnitario: new Decimal(0), // con franjas no hay un precio unitario único
      monto,
      moneda: plan.moneda,
    };
  }

  // por_funcionario simple (gratis + precio/func).
  const facturables = Math.max(0, contados - plan.funcionariosGratis);
  const monto = plan.precioPorFuncionario.mul(facturables);
  return {
    funcionariosContados: contados,
    funcionariosFacturables: facturables,
    precioUnitario: plan.precioPorFuncionario,
    monto,
    moneda: plan.moneda,
  };
}
