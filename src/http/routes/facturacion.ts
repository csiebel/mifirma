import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verSuscripcion, listarFacturas, fijarMedioCobro } from '../../services/facturacion';

export function registrarRutasFacturacion(app: FastifyInstance) {
  app.get('/suscripcion', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    return verSuscripcion(cuentaId, usuarioId);
  });

  app.put('/suscripcion/medio-cobro', async (req) => {
    const b = z.object({ medio_cobro: z.enum(['tarjeta', 'giro']) }).parse(req.body);
    const { cuentaId, usuarioId } = req.identidad;
    return fijarMedioCobro(cuentaId, usuarioId, b.medio_cobro);
  });

  app.get('/facturas', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    return listarFacturas(cuentaId, usuarioId);
  });
}
