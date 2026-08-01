import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as usuarios from '../../services/usuarios';
import { invitarUsuario } from '../../services/auth_reset';
import { cambiarMiPassword } from '../../services/cuenta';

// Gestión de accesos: crear la cuenta de un empleado y asignarle un rol, y
// listar los roles disponibles. Gateadas por permiso en el servicio (admin).
export function registrarRutasUsuarios(app: FastifyInstance) {
  app.get('/roles', async (req) => {
    const { cuentaId, identidadId } = req.identidad;
    return usuarios.listarRoles(cuentaId, identidadId);
  });

  app.post('/usuarios', async (req) => {
    const b = z
      .object({ relacion_id: z.string().uuid(), email: z.string().min(3), rol_id: z.string().uuid(), vincular: z.boolean().optional() })
      .parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return usuarios.crearAcceso(cuentaId, identidadId, { relacionId: b.relacion_id, email: b.email, rolId: b.rol_id, vincular: b.vincular });
  });

  // Listado de usuarios de la empresa (con sus roles y estado).
  app.get('/usuarios', async (req) => {
    const { cuentaId, identidadId } = req.identidad;
    return { usuarios: await usuarios.listarUsuarios(cuentaId, identidadId) };
  });

  // Invitar a un usuario NUEVO (crea la persona y manda la invitación por correo).
  app.post('/usuarios/invitar', async (req) => {
    const b = z
      .object({
        nombre: z.string().min(1),
        email: z.string().min(1),
        documento: z.string().min(1),
        rol_id: z.string().uuid().optional(),
      })
      .parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return invitarUsuario(cuentaId, identidadId, { nombre: b.nombre, email: b.email, documento: b.documento, rolId: b.rol_id });
  });

  app.post('/usuarios/:id/roles', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { rol_id } = z.object({ rol_id: z.string().uuid() }).parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return usuarios.asignarRol(cuentaId, identidadId, id, rol_id);
  });

  app.delete('/usuarios/:id/roles/:rolId', async (req) => {
    const { id, rolId } = z.object({ id: z.string().uuid(), rolId: z.string().uuid() }).parse(req.params);
    const { cuentaId, identidadId } = req.identidad;
    return usuarios.quitarRol(cuentaId, identidadId, id, rolId);
  });

  app.post('/usuarios/:id/activo', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { activo } = z.object({ activo: z.boolean() }).parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return usuarios.setActivoUsuario(cuentaId, identidadId, id, activo);
  });

  app.post('/usuarios/:id/reinvitar', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { cuentaId, identidadId } = req.identidad;
    return usuarios.reenviarInvitacion(cuentaId, identidadId, id);
  });

  app.post('/usuarios/:id/otp', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { telefono, canal } = z
      .object({ telefono: z.string().nullable().optional(), canal: z.enum(['email', 'sms', 'whatsapp']) })
      .parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return usuarios.setCanalOtpUsuario(cuentaId, identidadId, id, telefono ?? null, canal);
  });

  // Cambiar la propia contraseña (cualquier usuario autenticado, sólo la suya).
  app.put('/yo/password', async (req) => {
    const b = z.object({ actual: z.string().min(1), nueva: z.string().min(1) }).parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return cambiarMiPassword(cuentaId, identidadId, b.actual, b.nueva);
  });
}
