import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  verCircuito,
  agregarFirmante,
  quitarFirmante,
  configurarCircuito,
  despachar,
} from '../../services/circuito';

/**
 * Preparación y despacho de un circuito de firma.
 *
 * Todo lo de acá vale sólo en borrador, menos la lectura. Después del despacho
 * el circuito está congelado por un trigger de la base: la ruta corta antes
 * para dar un mensaje entendible, pero aunque no lo hiciera, la base no lo
 * dejaría pasar.
 */
export function registrarRutasCircuitos(app: FastifyInstance) {
  app.get('/circuitos/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { cuentaId, identidadId } = req.identidad;
    return verCircuito(cuentaId, identidadId, id);
  });

  app.patch('/circuitos/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z
      .object({
        titulo: z.string().min(1).max(200).optional(),
        modo: z.enum(['serie', 'paralelo']).optional(),
        nivel_firma: z.enum(['simple', 'avanzada']).optional(),
        dias_vigencia: z.coerce.number().int().min(1).max(365).nullable().optional(),
        politica_rechazo: z.enum(['bloqueante', 'continua']).optional(),
      })
      .parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return configurarCircuito(cuentaId, identidadId, id, {
      titulo: b.titulo,
      modo: b.modo,
      nivelFirma: b.nivel_firma,
      diasVigencia: b.dias_vigencia,
      politicaRechazo: b.politica_rechazo,
    });
  });

  app.post('/circuitos/:id/firmantes', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z
      .object({
        email: z.string().email(),
        nombre: z.string().max(120).optional(),
        papel: z.enum(['firmante', 'veedor', 'copia']).optional(),
        orden: z.coerce.number().int().min(1).max(99).optional(),
        nivel_garantia_minimo: z.enum(['bajo', 'sustancial', 'alto']).optional(),
      })
      .parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return agregarFirmante(cuentaId, identidadId, id, {
      email: b.email,
      nombre: b.nombre ?? null,
      papel: b.papel,
      orden: b.orden,
      nivelGarantiaMinimo: b.nivel_garantia_minimo,
    });
  });

  app.delete('/circuitos/:id/firmantes/:pid', async (req) => {
    const p = z.object({ id: z.string().uuid(), pid: z.string().uuid() }).parse(req.params);
    const { cuentaId, identidadId } = req.identidad;
    return quitarFirmante(cuentaId, identidadId, p.id, p.pid);
  });

  // El acto. A partir de acá el circuito está congelado y hay gente afuera con
  // un enlace en la mano.
  app.post('/circuitos/:id/despachar', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { cuentaId, identidadId } = req.identidad;
    return despachar(cuentaId, identidadId, id, {
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
  });
}
