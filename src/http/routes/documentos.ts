import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { generarReciboPDF, previewReciboPDF } from '../../services/recibo_pdf';
import { verPlantilla, guardarPlantilla, restablecerPlantilla } from '../../services/recibo_plantilla';
import { enviarReciboUno, enviarRecibosCorrida } from '../../services/envio_recibos';
import { registrarSesion } from '../../services/auditoria';
import * as branding from '../../services/branding';
import { verConfigFirma, setConfigFirma } from '../../services/firma';
import { verIndustriaEmpresa, setIndustriaEmpresa } from '../../services/industrias';
import { verDatosEmpresa, setDatosEmpresa } from '../../services/empresa';

const PERIODO = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/);

// Documentos binarios y branding. Todo pasa por req.identidad (token de empresa)
// y, en el caso del recibo, por el RLS de `recibo` (alcance jerárquico).
export function registrarRutasDocumentos(app: FastifyInstance) {
  // Recibo en PDF. Si el usuario no puede ver ese recibo (alcance), da 404.
  app.get('/recibos/:relacionId/pdf', async (req, reply) => {
    const { relacionId } = z.object({ relacionId: z.string().uuid() }).parse(req.params);
    const { periodo } = z.object({ periodo: PERIODO }).parse(req.query);
    const { cuentaId, usuarioId } = req.identidad;
    const { buffer, filename } = await generarReciboPDF(cuentaId, usuarioId, relacionId, periodo);
    await registrarSesion(cuentaId, usuarioId, { accion: 'recibo.ver_pdf', recurso: 'recibo', objetoId: relacionId, detalle: { periodo } });
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `inline; filename="${filename}"`);
    reply.header('Cache-Control', 'no-store');
    return reply.send(buffer);
  });

  // Enviar UN recibo por correo (al email del empleado). La corrida debe estar emitida.
  app.post('/recibos/:relacionId/enviar', async (req) => {
    const { relacionId } = z.object({ relacionId: z.string().uuid() }).parse(req.params);
    const { periodo } = z.object({ periodo: PERIODO }).parse(req.query);
    const { cuentaId, usuarioId } = req.identidad;
    return enviarReciboUno(cuentaId, usuarioId, relacionId, periodo);
  });

  // Enviar TODOS los recibos de una corrida emitida (envío masivo).
  app.post('/corridas/:id/enviar', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { cuentaId, usuarioId } = req.identidad;
    return enviarRecibosCorrida(cuentaId, usuarioId, id);
  });

  // Logo de la empresa (imagen). La consola lo baja con el token y lo muestra.
  app.get('/empresa/logo', async (req, reply) => {
    const { cuentaId, usuarioId } = req.identidad;
    const logo = await branding.verLogo(cuentaId, usuarioId);
    if (!logo) return reply.code(404).send({ error: 'Sin logo' });
    reply.header('Content-Type', logo.mime);
    reply.header('Cache-Control', 'no-store');
    return reply.send(logo.buffer);
  });

  // Subir/reemplazar el logo (base64 sin el prefijo data:). Gateado en el servicio.
  const logoBody = z.object({ base64: z.string().min(1), mime: z.enum(['image/png', 'image/jpeg']) });
  app.put('/empresa/logo', async (req) => {
    const { base64, mime } = logoBody.parse(req.body);
    const { cuentaId, usuarioId } = req.identidad;
    return branding.guardarLogo(cuentaId, usuarioId, base64, mime);
  });

  app.delete('/empresa/logo', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    return branding.borrarLogo(cuentaId, usuarioId);
  });

  // Config de firma de recibos (modalidad y, si avanzada, proveedor). Gateado en el servicio.
  app.get('/empresa/firma', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    return verConfigFirma(cuentaId, usuarioId);
  });
  app.put('/empresa/firma', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    const b = z
      .object({ modalidad: z.enum(['ninguna', 'simple', 'avanzada']), proveedor_id: z.string().nullable().optional() })
      .parse(req.body);
    return setConfigFirma(cuentaId, usuarioId, b.modalidad, b.proveedor_id ?? null);
  });

  // Industria / rubro de la empresa.
  app.get('/empresa/industria', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    return verIndustriaEmpresa(cuentaId, usuarioId);
  });
  app.put('/empresa/industria', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    const b = z.object({ industria_id: z.string().nullable().optional() }).parse(req.body);
    return setIndustriaEmpresa(cuentaId, usuarioId, b.industria_id ?? null);
  });

  // Datos de la empresa (nombre, razon social, identificacion fiscal, BPS/IPS, domicilio).
  // Pais y moneda son de solo lectura: los define el proveedor del servicio.
  app.get('/empresa/datos', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    return verDatosEmpresa(cuentaId, usuarioId);
  });
  app.put('/empresa/datos', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    const b = z.object({
      nombre: z.string().min(1),
      razon_social: z.string().nullable().optional(),
      id_fiscal: z.string().nullable().optional(),
      num_seguridad_social: z.string().nullable().optional(),
      domicilio: z.string().nullable().optional(),
    }).parse(req.body);
    return setDatosEmpresa(cuentaId, usuarioId, b);
  });

  // Plantilla del recibo (presentacional, por empresa). Gateada en el servicio (admin).
  app.get('/recibo-plantilla', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    return verPlantilla(cuentaId, usuarioId);
  });
  app.put('/recibo-plantilla', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    return guardarPlantilla(cuentaId, usuarioId, req.body);
  });
  app.delete('/recibo-plantilla', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    return restablecerPlantilla(cuentaId, usuarioId);
  });

  // Vista previa: PDF de muestra con la plantilla en edición (no guardada).
  app.post('/recibo-plantilla/preview', async (req, reply) => {
    const { cuentaId, usuarioId } = req.identidad;
    const { buffer, filename } = await previewReciboPDF(cuentaId, usuarioId, req.body);
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `inline; filename="${filename}"`);
    reply.header('Cache-Control', 'no-store');
    return reply.send(buffer);
  });
}
