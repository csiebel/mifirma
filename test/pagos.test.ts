import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decimalesDe, formatearMonto } from '../src/services/pagos/moneda';
import {
  PayPalAdapter,
  monedaSoportadaPaypal,
  baseUrlPaypal,
  estadoDeOrdenPaypal,
  estadoDeEventoPaypal,
  normalizarEventoPaypal,
} from '../src/services/pagos/paypal';
import type { FetchLike } from '../src/services/pagos/tipos';

// ---------------- Formateo de monto currency-aware ----------------
test('formateo de monto: decimales por moneda (no hardcodear 2)', () => {
  // Zero-decimal
  assert.equal(decimalesDe('PYG'), 0);
  assert.equal(decimalesDe('JPY'), 0);
  // Dos decimales
  assert.equal(decimalesDe('USD'), 2);
  assert.equal(decimalesDe('UYU'), 2);
  assert.equal(decimalesDe('eur'), 2); // case-insensitive

  // PYG sin decimales; USD/UYU con 2.
  assert.equal(formatearMonto('1000', 'PYG'), '1000');
  assert.equal(formatearMonto(1000, 'PYG'), '1000');
  assert.equal(formatearMonto('1000.4', 'PYG'), '1000'); // redondeo a 0 decimales
  assert.equal(formatearMonto('10', 'USD'), '10.00');
  assert.equal(formatearMonto('10.5', 'USD'), '10.50');
  assert.equal(formatearMonto('1234.5', 'UYU'), '1234.50');
  assert.equal(formatearMonto('5000', 'JPY'), '5000');
});

// ---------------- Monedas soportadas por PayPal ----------------
test('PayPal: lista de monedas soportadas (USD sí; UYU/PYG no)', () => {
  assert.equal(monedaSoportadaPaypal('USD'), true);
  assert.equal(monedaSoportadaPaypal('usd'), true);
  assert.equal(monedaSoportadaPaypal('EUR'), true);
  assert.equal(monedaSoportadaPaypal('JPY'), true);
  // Monedas locales: NO soportadas por PayPal (van por Mercado Pago/Bancard en fases 4).
  assert.equal(monedaSoportadaPaypal('UYU'), false);
  assert.equal(monedaSoportadaPaypal('PYG'), false);
});

// ---------------- Helpers puros ----------------
test('PayPal: base URL por modo y mapeos de estado', () => {
  assert.equal(baseUrlPaypal('sandbox'), 'https://api-m.sandbox.paypal.com');
  assert.equal(baseUrlPaypal('produccion'), 'https://api-m.paypal.com');
  assert.equal(baseUrlPaypal(''), 'https://api-m.sandbox.paypal.com'); // default seguro: sandbox

  assert.equal(estadoDeOrdenPaypal('CREATED'), 'creado');
  assert.equal(estadoDeOrdenPaypal('APPROVED'), 'aprobado');
  assert.equal(estadoDeOrdenPaypal('COMPLETED'), 'pagado');
  assert.equal(estadoDeOrdenPaypal('VOIDED'), 'cancelado');
  assert.equal(estadoDeOrdenPaypal('LO_QUE_SEA'), 'desconocido');

  assert.equal(estadoDeEventoPaypal('CHECKOUT.ORDER.APPROVED'), 'aprobado');
  assert.equal(estadoDeEventoPaypal('PAYMENT.CAPTURE.COMPLETED'), 'pagado');
  assert.equal(estadoDeEventoPaypal('PAYMENT.CAPTURE.REFUNDED'), 'reembolsado');
  assert.equal(estadoDeEventoPaypal('PAYMENT.CAPTURE.DENIED'), 'fallido');
  assert.equal(estadoDeEventoPaypal('OTRO'), 'desconocido');
});

test('PayPal: normalización de evento de webhook', () => {
  const ev = normalizarEventoPaypal({ event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-1' } });
  assert.equal(ev.tipoEvento, 'PAYMENT.CAPTURE.COMPLETED');
  assert.equal(ev.referenciaExterna, 'CAP-1');
  assert.equal(ev.estado, 'pagado');
});

// ---------------- Adaptador con fetch mockeado (sin red ni credenciales) ----------------
function mockFetch(rutas: Array<[string, { status?: number; body: unknown }]>): { f: FetchLike; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, init });
    for (const [match, resp] of rutas) {
      if (url.includes(match)) return new Response(JSON.stringify(resp.body), { status: resp.status ?? 200 });
    }
    return new Response('{}', { status: 404 });
  };
  return { f, calls };
}

function nuevoAdapter(f: FetchLike) {
  return new PayPalAdapter({ clientId: 'cid', clientSecret: 'secret', modo: 'sandbox', webhookId: 'WH-1' }, f);
}

test('PayPal.iniciarCobro: arma el POST correcto y parsea el link de aprobación', async () => {
  const { f, calls } = mockFetch([
    ['/v1/oauth2/token', { body: { access_token: 'TOK', expires_in: 3600 } }],
    ['/v2/checkout/orders', { body: { id: 'ORDER-123', status: 'CREATED', links: [{ rel: 'approve', href: 'https://paypal/approve/ORDER-123' }] } }],
  ]);
  const r = await nuevoAdapter(f).iniciarCobro({ referencia: 'ref-1', monto: '10.00', moneda: 'USD', descripcion: 'test' });
  assert.equal(r.referenciaExterna, 'ORDER-123');
  assert.equal(r.estado, 'creado');
  assert.equal(r.linkAprobacion, 'https://paypal/approve/ORDER-123');

  // Verificar el cuerpo enviado a /v2/checkout/orders.
  const ordersCall = calls.find((c) => c.url.includes('/v2/checkout/orders'));
  assert.ok(ordersCall, 'debe haber llamado a orders');
  const body = JSON.parse(String(ordersCall!.init!.body));
  assert.equal(body.intent, 'CAPTURE');
  assert.equal(body.purchase_units[0].amount.currency_code, 'USD');
  assert.equal(body.purchase_units[0].amount.value, '10.00');
});

test('PayPal.iniciarCobro: rechaza moneda no soportada ANTES de llamar a la API', async () => {
  const { f, calls } = mockFetch([['/v1/oauth2/token', { body: { access_token: 'TOK' } }]]);
  await assert.rejects(
    () => nuevoAdapter(f).iniciarCobro({ referencia: 'r', monto: '1000', moneda: 'UYU' }),
    /PayPal no soporta la moneda UYU/,
  );
  assert.equal(calls.length, 0, 'no debe hacer ninguna llamada HTTP si la moneda no sirve');
});

test('PayPal.confirmarPorWebhook: SUCCESS -> normaliza; FAILURE -> rechaza', async () => {
  const evento = { event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-9' } };
  const headers = {
    'paypal-transmission-id': 'tid',
    'paypal-transmission-time': 'ttime',
    'paypal-cert-url': 'curl',
    'paypal-auth-algo': 'algo',
    'paypal-transmission-sig': 'sig',
  };

  const ok = mockFetch([
    ['/v1/oauth2/token', { body: { access_token: 'TOK' } }],
    ['/v1/notifications/verify-webhook-signature', { body: { verification_status: 'SUCCESS' } }],
  ]);
  const norm = await nuevoAdapter(ok.f).confirmarPorWebhook(headers, evento);
  assert.equal(norm.estado, 'pagado');
  assert.equal(norm.referenciaExterna, 'CAP-9');

  const bad = mockFetch([
    ['/v1/oauth2/token', { body: { access_token: 'TOK' } }],
    ['/v1/notifications/verify-webhook-signature', { body: { verification_status: 'FAILURE' } }],
  ]);
  await assert.rejects(() => nuevoAdapter(bad.f).confirmarPorWebhook(headers, evento), /firma de webhook inválida/i);
});

test('PayPal: recurrente lanza "no implementado" en Fase 1', async () => {
  const { f } = mockFetch([]);
  const a = nuevoAdapter(f);
  await assert.rejects(() => a.crearAcuerdo({ referencia: 'r', monto: '10.00', moneda: 'USD' }), /no implementado en Fase 1/i);
  await assert.rejects(() => a.cobrarAcuerdo('acc', '10.00', 'USD'), /no implementado en Fase 1/i);
  await assert.rejects(() => a.cancelarAcuerdo('acc'), /no implementado en Fase 1/i);
});
