import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as carpetas from '../../services/carpetas';

/**
 * Árbol de carpetas y sus permisos.
 *
 * Ninguna de estas rutas decide nada: el permiso lo resuelve
 * `app.puede_en_carpeta` dentro de las políticas RLS. Si una carpeta no
 * aparece en el árbol es porque la base no la devolvió.
 */
export function registrarRutasCarpetas(app: FastifyInstance) {
  app.get('/carpetas', async (req) => {
    const { cuentaId, identidadId } = req.identidad;
    return { carpetas: await carpetas.listarArbol(cuentaId, identidadId) };
  });

  app.post('/carpetas', async (req) => {
    const b = z
      .object({ padre_id: z.string().uuid(), nombre: z.string().min(1).max(80) })
      .parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return carpetas.crearCarpeta(cuentaId, identidadId, b.padre_id, b.nombre);
  });

  app.patch('/carpetas/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z
      .object({ nombre: z.string().min(1).max(80), idioma: z.string().max(12).optional() })
      .parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return carpetas.renombrarCarpeta(cuentaId, identidadId, id, b.nombre, b.idioma ?? 'es');
  });

  app.delete('/carpetas/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { cuentaId, identidadId } = req.identidad;
    return carpetas.borrarCarpeta(cuentaId, identidadId, id);
  });

  app.get('/carpetas/:id/permisos', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { cuentaId, identidadId } = req.identidad;
    return carpetas.permisosDeCarpeta(cuentaId, identidadId, id);
  });

  app.put('/carpetas/:id/permisos', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z
      .object({ rol_id: z.string().uuid(), acciones: z.array(z.string()) })
      .parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return carpetas.setPermiso(cuentaId, identidadId, id, b.rol_id, b.acciones);
  });
}
