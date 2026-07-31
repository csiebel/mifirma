import { test } from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import { calcularFactura } from '../src/facturacion/motor';

const planPro = {
  modo: 'por_funcionario' as const,
  precioFijo: new Decimal(0),
  precioPorFuncionario: new Decimal('2.00'),
  funcionariosGratis: 3,
  tramos: [],
  moneda: 'USD',
};

const planFijo = {
  modo: 'fijo' as const,
  precioFijo: new Decimal('49.00'),
  precioPorFuncionario: new Decimal(0),
  funcionariosGratis: 0,
  tramos: [],
  moneda: 'USD',
};

const planFranjas = {
  modo: 'por_funcionario' as const,
  precioFijo: new Decimal(0),
  precioPorFuncionario: new Decimal(0),
  funcionariosGratis: 0,
  // 0-10 gratis, 11-50 a 2, 51+ a 1
  tramos: [
    { desde: 0, hasta: 10, precio: new Decimal(0) },
    { desde: 11, hasta: 50, precio: new Decimal('2.00') },
    { desde: 51, hasta: null, precio: new Decimal('1.00') },
  ],
  moneda: 'USD',
};

test('por funcionario simple: cobra los que están por encima del umbral gratis', () => {
  const r = calcularFactura(planPro, 10); // 10 - 3 = 7 ; 7 * 2.00 = 14.00
  assert.equal(r.funcionariosFacturables, 7);
  assert.equal(r.monto.toFixed(2), '14.00');
});

test('precio fijo: el monto no depende de la cantidad de funcionarios', () => {
  assert.equal(calcularFactura(planFijo, 2).monto.toFixed(2), '49.00');
  assert.equal(calcularFactura(planFijo, 500).monto.toFixed(2), '49.00');
});

test('franjas graduadas: 60 funcionarios => 0 + 40*2 + 10*1 = 90', () => {
  const r = calcularFactura(planFranjas, 60);
  assert.equal(r.monto.toFixed(2), '90.00');
  assert.equal(r.funcionariosFacturables, 50); // los 50 que caen en tramos con precio > 0
});

test('franjas graduadas: dentro del primer tramo gratis no se cobra', () => {
  const r = calcularFactura(planFranjas, 8);
  assert.equal(r.monto.toFixed(2), '0.00');
});

test('franjas graduadas: borde del segundo tramo (11 => 1 pago)', () => {
  const r = calcularFactura(planFranjas, 11); // 10 gratis + 1 a 2.00
  assert.equal(r.monto.toFixed(2), '2.00');
  assert.equal(r.funcionariosFacturables, 1);
});
