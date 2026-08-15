import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as usuarios from '../../services/usuarios';

/**
 * Panel de accesos.
 *
 * Se fueron dos endpoints de payroll y conviene saber por qué:
 *
 *   · `PUT /usuarios/:id/canal-otp` — el teléfono y el canal del segundo factor
 *     son de la identidad, que es global. El admin de una empresa no los toca.
 *     Cada persona los administra en su perfil: `GET /mi/acceso`,
 *     `POST /mi/telefono/codigo`, `POST /mi/telefono/confirmar`, `PUT /mi/canal`
 *     — en `routes/perfil.ts`.
 *
 *     ⚠ Este comentario nombró durante días una ruta `/mi/telefono` que NO
 *     existía: el archivo se escribió cuando se decidió, y la ruta nunca se
 *     construyó. **Un comentario que nombra una ruta es una afirmación
 *     comprobable** — y ésta era falsa. Las de arriba existen; están en
 *     `server.ts` registradas con `registrarRutasPerfil`.
 *
 *     Lo que el admin SÍ puede es PROPONER un celular al dar acceso
 *     (`telefono_propuesto`), que no habilita nada hasta que su dueño lo
 *     confirma. Migración 061.
 *   · `POST /usuarios/invitar` — era un alta que creaba persona + usuario. Acá
 *     dar acceso es una sola operación: `POST /usuarios`.
 */
export function registrarRutasUsuarios(app: FastifyInstance) {
  app.get('/usuarios/roles', async (req) => {
    const { cuentaId, identidadId } = req.identidad;
    return { roles: await usuarios.listarRoles(cuentaId, identidadId) };
  });

  app.get('/usuarios', async (req) => {
    const { cuentaId, identidadId } = req.identidad;
    return { usuarios: await usuarios.listarUsuarios(cuentaId, identidadId) };
  });

  app.post('/usuarios', async (req) => {
    const b = z
      .object({
        email: z.string().email(),
        rol_id: z.string().uuid(),
        nombre: z.string().max(120).optional(),
        persona_id: z.string().uuid().nullable().optional(),
        // ⚠ PROPUESTA, no teléfono confirmado. Ver `DarAccesoInput`.
        telefono_propuesto: z.string().max(24).nullable().optional(),
      })
      .parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return usuarios.darAcceso(cuentaId, identidadId, {
      email: b.email,
      rolId: b.rol_id,
      nombre: b.nombre ?? null,
      personaId: b.persona_id ?? null,
      telefonoPropuesto: b.telefono_propuesto ?? null,
    });
  });

  app.post('/usuarios/:id/roles', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { rol_id } = z.object({ rol_id: z.string().uuid() }).parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return usuarios.asignarRol(cuentaId, identidadId, id, rol_id);
  });

  app.delete('/usuarios/:id/roles/:rolId', async (req) => {
    const p = z.object({ id: z.string().uuid(), rolId: z.string().uuid() }).parse(req.params);
    const { cuentaId, identidadId } = req.identidad;
    return usuarios.quitarRol(cuentaId, identidadId, p.id, p.rolId);
  });

  // Suspender o terminar el acceso a ESTA cuenta. No desactiva a la persona:
  // su identidad, sus documentos y su acceso a otras empresas siguen intactos.
  app.put('/usuarios/:id/estado', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { estado } = z
      .object({ estado: z.enum(['activa', 'suspendida', 'terminada']) })
      .parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return usuarios.setEstadoAcceso(cuentaId, identidadId, id, estado);
  });

  app.post('/usuarios/:id/reinvitar', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { cuentaId, identidadId } = req.identidad;
    return usuarios.reenviarInvitacion(cuentaId, identidadId, id);
  });
}
