import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as roles from '../../services/roles';

const ALCANCE = z.enum(['propio', 'equipo', 'area', 'empresa']);

// Módulo de definición de roles (panel del admin). Rutas autenticadas; el permiso
// usuario:escribir se valida en el servicio. El catálogo describe los "ladrillos"
// del modelo de permisos para que la UI arme la matriz.
export function registrarRutasRoles(app: FastifyInstance) {
  app.get('/roles/catalogo', async () => roles.catalogoCapacidades());

  app.get('/roles/detalle', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    return { roles: await roles.listarRolesDetalle(cuentaId, usuarioId) };
  });

  app.post('/roles', async (req) => {
    const { nombre } = z.object({ nombre: z.string().min(1) }).parse(req.body);
    const { cuentaId, usuarioId } = req.identidad;
    return roles.crearRol(cuentaId, usuarioId, nombre);
  });

  app.patch('/roles/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { nombre } = z.object({ nombre: z.string().min(1) }).parse(req.body);
    const { cuentaId, usuarioId } = req.identidad;
    return roles.renombrarRol(cuentaId, usuarioId, id, nombre);
  });

  app.delete('/roles/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { cuentaId, usuarioId } = req.identidad;
    return roles.borrarRol(cuentaId, usuarioId, id);
  });

  app.put('/roles/:id/capacidad', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z
      .object({ recurso: z.string().min(1), accion: z.string().min(1), alcance: ALCANCE.nullable() })
      .parse(req.body);
    const { cuentaId, usuarioId } = req.identidad;
    return roles.setCapacidad(cuentaId, usuarioId, id, b.recurso, b.accion, b.alcance);
  });
}
