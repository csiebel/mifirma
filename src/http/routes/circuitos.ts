import type { FastifyInstance } from 'fastify';
import { verMarcas, definirMarcas } from '../../services/marcas';
import { z } from 'zod';
import {
  verCircuito,
  agregarFirmante,
  quitarFirmante,
  configurarCircuito,
  despachar,
  cancelar,
  reenviarAvisos,
  enlaceDeFirma,
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
  // Cancelar un documento en curso. Motivo obligatorio: va al expediente y es
  // lo que el firmante va a leer en el aviso.
  app.post('/circuitos/:id/cancelar', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ motivo: z.string().min(1).max(500) }).parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return cancelar(cuentaId, identidadId, id, b.motivo, {
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
  });

  app.post('/circuitos/:id/despachar', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { cuentaId, identidadId } = req.identidad;
    return despachar(cuentaId, identidadId, id, {
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
  });

  // El enlace personal de firma, para que el emisor lo entregue por su cuenta:
  // WhatsApp, en persona, o cuando el correo simplemente no llega. Queda
  // anotado en el expediente — ver el comentario del servicio.
  app.post('/circuitos/:id/firmantes/:pid/enlace', async (req) => {
    const p = z.object({ id: z.string().uuid(), pid: z.string().uuid() }).parse(req.params);
    const { cuentaId, identidadId } = req.identidad;
    return enlaceDeFirma(cuentaId, identidadId, p.id, p.pid, {
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
  });

  // Reenviar el aviso. No emite un otorgamiento nuevo: reusa el que ya existe,
  // así el enlace del correo original —si alguna vez llegó— sigue sirviendo.
  app.post('/circuitos/:id/reenviar', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { cuentaId, identidadId } = req.identidad;
    return reenviarAvisos(cuentaId, identidadId, id);
  });
  // ==========================================================================
  // Marcas: dónde se estampa la representación VISUAL de cada firmante.
  //
  // ⚠ No es la firma. Un documento sin marcas está firmado igual.
  // ==========================================================================

  app.get('/documentos/:id/marcas', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { cuentaId, identidadId } = req.identidad;
    return verMarcas(cuentaId, identidadId, id);
  });

  /**
   * Define las marcas de UN firmante. Reemplaza las que tuviera.
   *
   * PUT y no PATCH: el editor manda el estado completo de lo que el usuario ve.
   */
  app.put('/participaciones/:id/marcas', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z
      .object({
        marcas: z
          .array(
            z.object({
              tipo: z.enum(['firma', 'rubrica']),
              pagina: z.number().int().min(0).max(5000).optional(),
              x: z.number().min(0).max(20000),
              y: z.number().min(0).max(20000),
              ancho: z.number().min(8).max(2000),
              alto: z.number().min(8).max(2000),
              todas_las_paginas: z.boolean().optional(),
            }),
          )
          // El mismo tope que `definirMarcas`, y por la misma razón: un contrato
          // de 500 hojas rubricado entero son 500 marcas. Si acá fuera más bajo,
          // el caso que motivó la pantalla —el contrato largo— fallaría con un
          // error de validación en vez de con el mensaje que explica el límite.
          .max(1000),
      })
      .parse(req.body);

    const { cuentaId, identidadId } = req.identidad;
    return definirMarcas(
      cuentaId,
      identidadId,
      id,
      b.marcas.map((m) => ({ ...m, todasLasPaginas: m.todas_las_paginas })),
    );
  });

}
