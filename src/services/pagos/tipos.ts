// Interfaz COMÚN de pasarela de pago (bloque de pagos, Fase 1). Cada proveedor la implementa
// con un adaptador (PayPal primero; Mercado Pago/Bancard en fases siguientes). El núcleo no
// conoce detalles del proveedor: solo esta interfaz.

export type EstadoPago =
  | 'creado' // orden/intención creada, sin aprobar
  | 'aprobado' // el pagador aprobó pero todavía no se capturó
  | 'pagado' // cobrado/capturado
  | 'fallido'
  | 'reembolsado'
  | 'cancelado'
  | 'desconocido';

/** Datos para iniciar un cobro puntual (one-time). */
export interface Cobro {
  referencia: string; // referencia interna (en Fase 1, un id de prueba; en Fase 2, la factura_saas)
  monto: string; // monto ya formateado por la moneda (ver moneda.formatearMonto)
  moneda: string; // ISO-4217, p. ej. 'USD'
  descripcion?: string;
  urlRetorno?: string; // a dónde vuelve el pagador tras aprobar
  urlCancelacion?: string;
}

export interface ResultadoCobro {
  referenciaExterna: string; // id de la orden/transacción en el proveedor
  estado: EstadoPago;
  linkAprobacion?: string; // link para que el pagador apruebe el pago
}

/** Evento de webhook ya VERIFICADO (firma válida) y normalizado. */
export interface EventoWebhook {
  referenciaExterna: string;
  estado: EstadoPago;
  tipoEvento: string; // event_type crudo del proveedor (para trazabilidad)
  crudo: unknown; // payload original
}

/** Headers HTTP del webhook (para verificar la firma). */
export type WebhookHeaders = Record<string, string | string[] | undefined>;

export interface PasarelaAdapter {
  // --- Cobro puntual (one-time) ---
  iniciarCobro(cobro: Cobro): Promise<ResultadoCobro>;
  consultarEstado(referenciaExterna: string): Promise<EstadoPago>;
  reembolsar(referenciaExterna: string, monto?: string): Promise<{ ok: boolean; reembolsoId?: string }>;
  confirmarPorWebhook(headers: WebhookHeaders, cuerpo: unknown): Promise<EventoWebhook>;

  // --- Recurrente (suscripción de empresa) — Fase 3. En Fase 1 los adaptadores lanzan
  // "no implementado"; la interfaz ya los declara para no cambiarla después. ---
  crearAcuerdo(cobro: Cobro): Promise<{ acuerdoId: string; linkAprobacion?: string }>;
  cobrarAcuerdo(acuerdoId: string, monto: string, moneda: string): Promise<{ referenciaExterna: string; estado: EstadoPago }>;
  cancelarAcuerdo(acuerdoId: string): Promise<{ ok: boolean }>;
}

// Firma inyectable del cliente HTTP (por defecto el fetch global). Permite testear los
// adaptadores con un fetch mockeado, sin red ni credenciales reales.
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
