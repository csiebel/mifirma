import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { responder } from '../../ai/orquestador';

const cuerpo = z.object({ pregunta: z.string().min(1) });

// La UI conversacional usa la MISMA identidad (empresa + usuario) del request,
// igual que la tradicional. No hay acceso alternativo a los datos para la IA.
export function registrarRutasChat(app: FastifyInstance) {
  app.post('/chat', async (req) => {
    const { pregunta } = cuerpo.parse(req.body);
    const respuesta = await responder(req.identidad.cuentaId, req.identidad.usuarioId, pregunta);
    return { respuesta };
  });
}
