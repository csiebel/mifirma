import { HttpError } from '../../http/errors';
import type { Cobro, EstadoPago, EventoWebhook, FetchLike, PasarelaAdapter, ResultadoCobro, WebhookHeaders } from './tipos';

// Adaptador de PayPal (piloto en SANDBOX). Habla la API REST de PayPal. NO maneja monedas
// locales: PayPal NO soporta UYU ni PYG → esas van por Mercado Pago/Bancard (fases 4). Este
// adaptador valida que la moneda esté en la lista de PayPal (camino USD y afines).

// Monedas soportadas por PayPal (developer.paypal.com/api/rest/reference/currency-codes).
// NO incluye UYU ni PYG a propósito.
export const PAYPAL_MONEDAS = new Set([
  'AUD', 'BRL', 'CAD', 'CNY', 'CZK', 'DKK', 'EUR', 'HKD', 'HUF', 'ILS', 'JPY', 'MYR', 'MXN',
  'TWD', 'NZD', 'NOK', 'PHP', 'PLN', 'GBP', 'RUB', 'SGD', 'SEK', 'CHF', 'THB', 'USD',
]);

export function monedaSoportadaPaypal(moneda: string): boolean {
  return PAYPAL_MONEDAS.has((moneda || '').toUpperCase());
}

export function baseUrlPaypal(modo: string): string {
  return modo === 'produccion' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

// Estado de una ORDEN de PayPal (v2/checkout/orders) -> EstadoPago del núcleo.
export function estadoDeOrdenPaypal(status: string): EstadoPago {
  switch (status) {
    case 'CREATED':
    case 'SAVED':
    case 'PAYER_ACTION_REQUIRED':
      return 'creado';
    case 'APPROVED':
      return 'aprobado';
    case 'COMPLETED':
      return 'pagado';
    case 'VOIDED':
      return 'cancelado';
    default:
      return 'desconocido';
  }
}

// event_type de un WEBHOOK de PayPal -> EstadoPago del núcleo.
export function estadoDeEventoPaypal(eventType: string): EstadoPago {
  switch (eventType) {
    case 'CHECKOUT.ORDER.APPROVED':
      return 'aprobado';
    case 'CHECKOUT.ORDER.COMPLETED':
    case 'PAYMENT.CAPTURE.COMPLETED':
      return 'pagado';
    case 'PAYMENT.CAPTURE.REFUNDED':
    case 'PAYMENT.CAPTURE.REVERSED':
      return 'reembolsado';
    case 'PAYMENT.CAPTURE.DENIED':
    case 'PAYMENT.CAPTURE.DECLINED':
      return 'fallido';
    default:
      return 'desconocido';
  }
}

// Normaliza el cuerpo de un webhook de PayPal (ya verificado) a EventoWebhook.
export function normalizarEventoPaypal(cuerpo: unknown): EventoWebhook {
  const ev = (cuerpo && typeof cuerpo === 'object' ? cuerpo : {}) as Record<string, unknown>;
  const tipoEvento = typeof ev.event_type === 'string' ? ev.event_type : '';
  const resource = (ev.resource && typeof ev.resource === 'object' ? ev.resource : {}) as Record<string, unknown>;
  const referenciaExterna = typeof resource.id === 'string' ? resource.id : '';
  return { referenciaExterna, estado: estadoDeEventoPaypal(tipoEvento), tipoEvento, crudo: cuerpo };
}

function header(h: WebhookHeaders, nombre: string): string {
  const v = h[nombre] ?? h[nombre.toLowerCase()];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

export interface CredencialesPaypal {
  clientId: string;
  clientSecret: string;
  modo: string; // 'sandbox' | 'produccion'
  webhookId: string; // el Webhook ID de PayPal (guardado en webhook_secret_cifrado)
}

const NO_IMPL_FASE1 = 'Cobro recurrente (acuerdos) no implementado en Fase 1 (piloto one-time).';

export class PayPalAdapter implements PasarelaAdapter {
  private readonly base: string;
  private tokenCache?: { token: string; expira: number };

  constructor(
    private readonly cred: CredencialesPaypal,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    if (!cred.clientId || !cred.clientSecret) throw new HttpError(400, 'PayPal: faltan credenciales (Client ID / Secret).');
    this.base = baseUrlPaypal(cred.modo);
  }

  private validarMoneda(moneda: string): void {
    if (!monedaSoportadaPaypal(moneda)) {
      throw new HttpError(
        400,
        `PayPal no soporta la moneda ${moneda}. Para monedas locales (UYU/PYG) usá una pasarela local (Mercado Pago/Bancard).`,
      );
    }
  }

  // OAuth2 client-credentials. Cachea el token hasta poco antes de expirar.
  private async token(): Promise<string> {
    const ahora = Date.now();
    if (this.tokenCache && this.tokenCache.expira > ahora + 60_000) return this.tokenCache.token;
    const basic = Buffer.from(`${this.cred.clientId}:${this.cred.clientSecret}`).toString('base64');
    const r = await this.fetchImpl(`${this.base}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const j = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!r.ok || !j.access_token) throw new HttpError(502, 'PayPal: no se pudo obtener el token — ' + (j.error_description || r.status));
    this.tokenCache = { token: j.access_token, expira: ahora + (j.expires_in ?? 3600) * 1000 };
    return j.access_token;
  }

  private async api(path: string, method: string, body?: unknown): Promise<{ status: number; json: any }> {
    const tok = await this.token();
    const r = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json: any = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (json && (json.message || json.error_description)) || `HTTP ${r.status}`;
      throw new HttpError(502, `PayPal (${path}): ${msg}`);
    }
    return { status: r.status, json };
  }

  async iniciarCobro(cobro: Cobro): Promise<ResultadoCobro> {
    this.validarMoneda(cobro.moneda);
    const { json } = await this.api('/v2/checkout/orders', 'POST', {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: cobro.referencia,
          description: cobro.descripcion,
          amount: { currency_code: cobro.moneda.toUpperCase(), value: cobro.monto },
        },
      ],
      application_context: {
        return_url: cobro.urlRetorno,
        cancel_url: cobro.urlCancelacion,
      },
    });
    const links: Array<{ rel?: string; href?: string }> = Array.isArray(json.links) ? json.links : [];
    const aprobar = links.find((l) => l.rel === 'approve' || l.rel === 'payer-action');
    return {
      referenciaExterna: String(json.id || ''),
      estado: estadoDeOrdenPaypal(String(json.status || '')),
      linkAprobacion: aprobar?.href,
    };
  }

  async consultarEstado(referenciaExterna: string): Promise<EstadoPago> {
    const { json } = await this.api(`/v2/checkout/orders/${encodeURIComponent(referenciaExterna)}`, 'GET');
    return estadoDeOrdenPaypal(String(json.status || ''));
  }

  async reembolsar(referenciaExterna: string, monto?: string): Promise<{ ok: boolean; reembolsoId?: string }> {
    // referenciaExterna aquí es el capture id. (En Fase 2 lo resolvemos desde la orden.)
    const body = monto ? { amount: { value: monto } } : undefined;
    const { json } = await this.api(`/v2/payments/captures/${encodeURIComponent(referenciaExterna)}/refund`, 'POST', body);
    return { ok: String(json.status || '') === 'COMPLETED', reembolsoId: json.id ? String(json.id) : undefined };
  }

  async confirmarPorWebhook(headers: WebhookHeaders, cuerpo: unknown): Promise<EventoWebhook> {
    if (!this.cred.webhookId) {
      throw new HttpError(400, 'PayPal: falta el Webhook ID (cargalo en la config de la pasarela) para verificar la firma.');
    }
    const { json } = await this.api('/v1/notifications/verify-webhook-signature', 'POST', {
      auth_algo: header(headers, 'paypal-auth-algo'),
      cert_url: header(headers, 'paypal-cert-url'),
      transmission_id: header(headers, 'paypal-transmission-id'),
      transmission_sig: header(headers, 'paypal-transmission-sig'),
      transmission_time: header(headers, 'paypal-transmission-time'),
      webhook_id: this.cred.webhookId,
      webhook_event: cuerpo,
    });
    if (String(json.verification_status || '') !== 'SUCCESS') {
      throw new HttpError(400, 'PayPal: firma de webhook inválida.');
    }
    return normalizarEventoPaypal(cuerpo);
  }

  // --- Recurrente: Fase 3. En Fase 1 no está implementado (mantiene la firma de la interfaz). ---
  async crearAcuerdo(_cobro: Cobro): Promise<{ acuerdoId: string; linkAprobacion?: string }> {
    throw new HttpError(501, NO_IMPL_FASE1);
  }
  async cobrarAcuerdo(_acuerdoId: string, _monto: string, _moneda: string): Promise<{ referenciaExterna: string; estado: EstadoPago }> {
    throw new HttpError(501, NO_IMPL_FASE1);
  }
  async cancelarAcuerdo(_acuerdoId: string): Promise<{ ok: boolean }> {
    throw new HttpError(501, NO_IMPL_FASE1);
  }
}
