import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as branding from '../../services/branding';
import { listarIndustrias, verIndustriaCuenta, setIndustriaCuenta } from '../../services/industrias';
import { verDatosCuenta, setDatosCuenta } from '../../services/empresa';
import { quienSoy } from '../../services/cuenta';

/**
 * Marca y datos de la cuenta.
 *
 * Lo que había acá de payroll —recibos en PDF, envío masivo de recibos,
 * plantilla del recibo, configuración de firma de recibos— se fue con el
 * dominio. Los documentos de MiFirma van a tener sus propias rutas cuando esté
 * el motor de flujo.
 */
export function registrarRutasDocumentos(app: FastifyInstance) {
  // ---- Quién soy ----
  //
  // Lo primero que pide la consola al abrir. Va acá y no en una ruta nueva
  // porque es lectura de la cuenta activa, igual que /cuenta/datos.
  app.get('/mi/quien-soy', async (req) => {
    const { cuentaId, identidadId } = req.identidad;
    return quienSoy(cuentaId, identidadId);
  });

  // ---- Logo ----
  app.get('/cuenta/logo', async (req, reply) => {
    const { cuentaId, identidadId } = req.identidad;
    const logo = await branding.verLogo(cuentaId, identidadId);
    if (!logo) return reply.code(404).send({ error: 'Sin logo' });
    reply.header('Content-Type', logo.mime);
    // no-store: si el cliente cambia el logo, nadie tiene que ver el viejo.
    reply.header('Cache-Control', 'no-store');
    return reply.send(logo.bytes);
  });

  app.get('/cuenta/marca', async (req) => {
    const { cuentaId, identidadId } = req.identidad;
    return branding.verMarca(cuentaId, identidadId);
  });

  app.put('/cuenta/logo', async (req) => {
    const b = z
      .object({
        base64: z.string().min(1),
        mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']),
      })
      .parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return branding.guardarLogo(cuentaId, identidadId, Buffer.from(b.base64, 'base64'), b.mime);
  });

  app.delete('/cuenta/logo', async (req) => {
    const { cuentaId, identidadId } = req.identidad;
    return branding.borrarLogo(cuentaId, identidadId);
  });

  app.put('/cuenta/colores', async (req) => {
    const COLOR = z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable();
    const b = z.object({ primario: COLOR, texto: COLOR }).parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return branding.setColores(cuentaId, identidadId, b.primario, b.texto);
  });

  // ---- Industria ----
  app.get('/industrias', async (req) => {
    const { cuentaId, identidadId } = req.identidad;
    return { industrias: await listarIndustrias(cuentaId, identidadId) };
  });

  app.get('/cuenta/industria', async (req) => {
    const { cuentaId, identidadId } = req.identidad;
    return verIndustriaCuenta(cuentaId, identidadId);
  });

  app.put('/cuenta/industria', async (req) => {
    const b = z.object({ industria_id: z.string().uuid().nullable().optional() }).parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return setIndustriaCuenta(cuentaId, identidadId, b.industria_id ?? null);
  });

  // ---- Datos ----
  //
  // País y moneda no se editan desde acá: definen el paquete de país que aplica
  // —marco legal, proveedores acreditados, régimen de facturación— y cambiarlos
  // por un formulario dejaría documentos firmados bajo un marco y la cuenta
  // declarando otro.
  app.get('/cuenta/datos', async (req) => {
    const { cuentaId, identidadId } = req.identidad;
    return verDatosCuenta(cuentaId, identidadId);
  });

  app.put('/cuenta/datos', async (req) => {
    const b = z
      .object({
        nombre: z.string().min(1).max(120).optional(),
        razon_social: z.string().max(200).nullable().optional(),
        identificacion_fiscal: z.string().max(40).nullable().optional(),
        domicilio: z.string().max(300).nullable().optional(),
        idioma: z.string().max(12).optional(),
      })
      .parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return setDatosCuenta(cuentaId, identidadId, {
      nombreMostrado: b.nombre,
      razonSocial: b.razon_social,
      identificacionFiscal: b.identificacion_fiscal,
      domicilio: b.domicilio,
      idioma: b.idioma,
    });
  });
}
