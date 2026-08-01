import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as roles from '../../services/roles';

/**
 * Panel de roles.
 *
 * Sin `alcance`: en MiFirma la capacidad es binaria y el "sobre qué documentos"
 * lo dan las carpetas. Ver el encabezado de `services/roles.ts`.
 *
 * El permiso se valida en el servicio y, de verdad, en las políticas RLS.
 */
export function registrarRutasRoles(app: FastifyInstance) {
  app.get('/roles/catalogo', async (req) => {
    const { cuentaId, identidadId } = req.identidad;
    return roles.catalogoCapacidades(cuentaId, identidadId);
  });

  app.get('/roles/detalle', async (req) => {
    const { cuentaId, identidadId } = req.identidad;
    return { roles: await roles.listarRolesDetalle(cuentaId, identidadId) };
  });

  app.post('/roles', async (req) => {
    const b = z
      .object({ codigo: z.string().min(1).max(40), nombre: z.string().min(1).max(80) })
      .parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return roles.crearRol(cuentaId, identidadId, b.codigo, b.nombre);
  });

  app.patch('/roles/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z
      .object({ nombre: z.string().min(1).max(80), idioma: z.string().max(12).optional() })
      .parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return roles.renombrarRol(cuentaId, identidadId, id, b.nombre, b.idioma ?? 'es');
  });

  app.delete('/roles/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { cuentaId, identidadId } = req.identidad;
    return roles.borrarRol(cuentaId, identidadId, id);
  });

  app.put('/roles/:id/capacidad', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ capacidad_id: z.string().uuid(), activa: z.boolean() }).parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return roles.setCapacidad(cuentaId, identidadId, id, b.capacidad_id, b.activa);
  });
}
