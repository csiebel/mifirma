import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withUsuario } from '../../auth/authz';
import {
  subirDocumento,
  listarDocumentos,
  bajarDocumento,
  verificarFirmas,
  moverDocumento,
} from '../../services/repositorio';
import { expediente, verificarCadena } from '../../services/evidencia';
import { listarBitacora } from '../../services/auditoria';
import { HttpError } from '../errors';

/**
 * Repositorio de documentos.
 *
 * La subida va por multipart y no por JSON con base64: base64 infla un 33% y
 * obliga a tener el archivo entero en memoria dos veces, una como texto y otra
 * como buffer. Con PDF de veinte megas y envío masivo, eso se nota.
 */
export function registrarRutasRepositorio(app: FastifyInstance) {
  app.post('/documentos', async (req) => {
    const parte = await (req as any).file();
    if (!parte) throw new HttpError(400, 'No llegó ningún archivo.');

    const contenido = await parte.toBuffer();

    // Los campos de texto del mismo formulario. Van DESPUÉS del archivo en el
    // objeto `fields`, así que se leen una vez consumido el stream.
    const campos: Record<string, string> = {};
    for (const [k, v] of Object.entries<any>(parte.fields ?? {})) {
      if (v && typeof v.value === 'string') campos[k] = v.value;
    }

    const b = z
      .object({ carpeta_id: z.string().uuid(), titulo: z.string().max(200).optional() })
      .parse(campos);

    const { cuentaId, identidadId } = req.identidad;
    return subirDocumento(cuentaId, identidadId, {
      carpetaId: b.carpeta_id,
      titulo: b.titulo || parte.filename,
      nombreArchivo: parte.filename,
      mime: parte.mimetype,
      contenido,
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
  });

  app.get('/documentos', async (req) => {
    const q = z
      .object({
        carpeta_id: z.string().uuid(),
        // `sub=1` incluye toda la rama. Se acepta como texto porque viene de un
        // query string, donde no existen los booleanos.
        sub: z.enum(['0', '1']).optional(),
      })
      .parse(req.query);
    const { cuentaId, identidadId } = req.identidad;
    return {
      documentos: await listarDocumentos(cuentaId, identidadId, q.carpeta_id, q.sub === '1'),
    };
  });

  app.get('/documentos/:id/archivo', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { cuentaId, identidadId } = req.identidad;
    const r = await bajarDocumento(cuentaId, identidadId, id, {
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });

    // `inline` para que el navegador lo muestre en vez de bajarlo: el camino
    // normal es mirar el documento, no archivarlo. Y nosniff porque esto es
    // contenido subido por un usuario.
    //
    // ⚠ Y acá se afloja el marco, sólo para esta ruta.
    //
    // El hook global manda `X-Frame-Options: DENY`, que significa "no me embebas
    // nunca, ni siquiera desde el mismo origen". Con eso, el visor de la consola
    // muestra un cuadro vacío y el único camino para volver es el botón atrás
    // del navegador. Se baja a SAMEORIGIN y se acota el CSP a `frame-ancestors
    // 'self'`: nuestra propia consola puede mostrarlo, cualquier otro sitio no.
    //
    // Es deliberadamente estrecho —una ruta, no una excepción global— porque
    // esto es contenido subido por usuarios y permitir que un tercero lo embeba
    // sería regalar el documento de un cliente a la página que lo enmarque.
    reply
      .header('Content-Type', r.mime)
      .header('Content-Disposition', `inline; filename="${encodeURIComponent(r.nombre)}"`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('X-Frame-Options', 'SAMEORIGIN')
      .header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'self'; object-src 'none'")
      .header('Cache-Control', 'private, no-store');
    return reply.send(r.contenido);
  });

  /**
   * Mover el documento a otra carpeta.
   *
   * PATCH y no POST: no crea nada, cambia un campo de algo que ya existe.
   */
  app.patch('/documentos/:id/carpeta', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ carpeta_id: z.string().uuid() }).parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return moverDocumento(cuentaId, identidadId, id, b.carpeta_id);
  });

  /**
   * Las firmas criptográficas del PDF, verificadas abriendo el archivo.
   *
   * No consulta la base para decidir si son válidas: recalcula los digest sobre
   * los bytes. Es la misma comprobación que haría un tercero con el PDF y sin
   * acceso a nada nuestro.
   */
  app.get('/documentos/:id/firmas', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { cuentaId, identidadId } = req.identidad;
    return verificarFirmas(cuentaId, identidadId, id);
  });

  /**
   * El expediente de evidencias de un documento.
   *
   * Devuelve los eventos crudos más el resultado de verificar la cadena. Se
   * verifica al leer y no sólo al emitir el certificado: si algo se rompió, es
   * mejor enterarse mirando la pantalla que descubrirlo el día del juicio.
   */
  app.get('/documentos/:id/evidencia', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { cuentaId, identidadId } = req.identidad;
    return withUsuario(cuentaId, identidadId, async (trx) => {
      const eventos = await expediente(trx, id);
      if (!eventos.length) throw new HttpError(404, 'No hay expediente para ese documento.');
      return { eventos, cadena: await verificarCadena(trx, id) };
    });
  });

  /**
   * La bitácora de la cuenta: quién hizo qué acá adentro.
   *
   * Exige la capacidad `bitacora.leer` —hoy sólo la tiene el rol
   * administrador— y la política RLS la acota a esta cuenta. Una empresa no ve
   * la actividad de otra, ni siquiera un renglón.
   *
   * ⚠ NO confundir con el expediente. Esto es administrativo —se dio un acceso,
   * se cambió un permiso, salió o falló un correo— y se purga por política de
   * retención. El expediente es del documento, es inmutable y se conserva por
   * el plazo legal.
   */
  app.get('/bitacora', async (req) => {
    const q = z
      .object({
        q: z.string().max(120).optional(),
        accion: z.string().max(60).optional(),
        desde: z.string().max(30).optional(),
        hasta: z.string().max(30).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      })
      .parse(req.query);
    const { cuentaId, identidadId } = req.identidad;
    return { eventos: await listarBitacora(cuentaId, identidadId, q) };
  });
}
