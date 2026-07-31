import Decimal from 'decimal.js';

// Formateo de montos SENSIBLE A LA MONEDA. Distintas monedas tienen distinta cantidad de
// "unidades menores" (decimales): USD/UYU llevan 2; PYG (y otras) llevan 0 → NO se formatean
// con decimales. Nunca hardcodear 2. Las pasarelas exigen el monto con los decimales exactos
// de la moneda (p. ej. PayPal rechaza "1000.00" en JPY/PYG y espera "1000").

// Monedas ISO con CERO decimales (unidad menor = la unidad). Incluye PYG (Paraguay) y las
// zero-decimal más comunes. USD/UYU NO están → 2 decimales.
const CERO_DECIMALES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

/** Cantidad de decimales de una moneda (0 para las zero-decimal como PYG, 2 para el resto). */
export function decimalesDe(moneda: string): number {
  return CERO_DECIMALES.has((moneda || '').toUpperCase()) ? 0 : 2;
}

/** Formatea un monto como string con los decimales EXACTOS de la moneda (para las pasarelas). */
export function formatearMonto(monto: Decimal.Value, moneda: string): string {
  return new Decimal(monto).toFixed(decimalesDe(moneda));
}
