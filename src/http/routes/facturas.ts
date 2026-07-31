import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  montoPropuesto,
  listarFacturasDeRelacion,
  registrarFactura,
  marcarFacturaPagada,
  archivoDeFactura,
} from '../../services/facturas';

const FECHA = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
const PERIODO = z.string().regex(/^[0-9]{4}-[0-9]{2}$/);

// Facturas del proveedor unipersonal (flujo empresa->proveedor). Gateadas en el servicio.
export function registrarRutasFacturas(app: FastifyInstance) {
  // Monto sugerido (honorarios de la versión vigente) para un período.
  app.get('/empleados/:relacionId/facturas/monto-propuesto', async (req) => {
    const { relacionId } = z.object({ relacionId: z.string().uuid() }).parse(req.params);
    const { periodo } = z.object({ periodo: PERIODO }).parse(req.query);
    const { cuentaId, usuarioId } = req.identidad;
    return montoPropuesto(cuentaId, usuarioId, relacionId, periodo);
  });

  // Listar las facturas de un proveedor.
  app.get('/empleados/:relacionId/facturas', async (req) => {
    const { relacionId } = z.object({ relacionId: z.string().uuid() }).parse(req.params);
    const { cuentaId, usuarioId } = req.identidad;
    return listarFacturasDeRelacion(cuentaId, usuarioId, relacionId);
  });

  // Registrar una factura.
  app.post('/empleados/:relacionId/facturas', async (req) => {
    const { relacionId } = z.object({ relacionId: z.string().uuid() }).parse(req.params);
    const b = z
      .object({
        periodo: PERIODO,
        numero: z.string().min(1),
        fecha_emision: FECHA,
        monto: z.number().positive(),
        moneda: z.string().optional(),
        archivo: z
          .object({ base64: z.string(), mime: z.string(), nombre: z.string().optional() })
          .nullish(),
      })
      .parse(req.body);
    const { cuentaId, usuarioId } = req.identidad;
    return registrarFactura(cuentaId, usuarioId, {
      relacionId,
      periodo: b.periodo,
      numero: b.numero,
      fechaEmision: b.fecha_emision,
      monto: b.monto,
      moneda: b.moneda,
      archivo: b.archivo ?? null,
    });
  });

  // Descargar/ver el adjunto de una factura.
  app.get('/empleados/:relacionId/facturas/:id/archivo', async (req, reply) => {
    const { id } = z.object({ relacionId: z.string().uuid(), id: z.string().uuid() }).parse(req.params);
    const { cuentaId, usuarioId } = req.identidad;
    const a = await archivoDeFactura(cuentaId, usuarioId, id);
    if (!a) return reply.code(404).send({ error: 'Sin adjunto' });
    reply.header('Content-Type', a.mime);
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(a.buffer);
  });

  // Marcar una factura como pagada.
  app.post('/facturas/:id/pagar', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { cuentaId, usuarioId } = req.identidad;
    return marcarFacturaPagada(cuentaId, usuarioId, id);
  });
}
