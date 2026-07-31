import type { FastifyInstance } from 'fastify';
import { adaptadorDe } from '../../services/pagos/registro';

// Receiver de webhooks de las pasarelas (bloque de pagos, Fase 1). Endpoint PÚBLICO (sin
// sesión): la autenticidad la da la FIRMA del proveedor, que verifica el adaptador. En Fase 1
// solo verifica y loguea el evento normalizado (todavía no hay factura_saas que marcar; eso
// es Fase 2). Idempotencia y confirmación de facturas se suman después.
export function registrarRutasPagosWebhook(app: FastifyInstance) {
  app.post('/pagos/webhook/:proveedor', async (req, reply) => {
    const { proveedor } = req.params as { proveedor: string };
    try {
      const adaptador = await adaptadorDe(proveedor);
      const evento = await adaptador.confirmarPorWebhook(req.headers, req.body);
      req.log.info(
        { evento_pago: 'webhook_verificado', proveedor, tipo: evento.tipoEvento, referencia: evento.referenciaExterna, estado: evento.estado },
        'Pagos: webhook verificado (Fase 1: solo log, sin marcar factura)',
      );
      return { ok: true };
    } catch (e) {
      // Firma inválida / pasarela no activa / error transitorio: logueamos y devolvemos 400 para
      // que quede registrado como no aceptado (sin datos sensibles).
      req.log.warn(
        { evento_pago: 'webhook_rechazado', proveedor, error: e instanceof Error ? e.message : String(e) },
        'Pagos: webhook rechazado',
      );
      return reply.code(400).send({ ok: false });
    }
  });
}
