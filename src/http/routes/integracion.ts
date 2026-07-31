import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  crearApiToken,
  listarApiTokens,
  revocarApiToken,
  resolverEmpresaPorToken,
  ingestarAsistencia,
} from '../../services/integracion';
import { HttpError } from '../errors';

const PERIODO = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/, 'Período inválido (YYYY-MM)');

const ITEM = z
  .object({
    relacion_id: z.string().uuid().optional(),
    documento: z.string().min(1).optional(),
    dias_trabajados: z.number().min(0).optional(),
    faltas: z.number().min(0).optional(),
    tardanza_min: z.number().min(0).optional(),
    horas_descuento: z.number().min(0).optional(),
    horas_extra: z.number().min(0).optional(),
  })
  .refine((i) => i.relacion_id || i.documento, {
    message: 'Cada item necesita relacion_id o documento',
  });

export function registrarRutasIntegracion(app: FastifyInstance) {
  // --- Gestión de tokens (identidad de admin vía JWT) ---
  app.post('/integracion/tokens', async (req) => {
    const { nombre } = z.object({ nombre: z.string().min(1) }).parse(req.body);
    const { cuentaId, usuarioId } = req.identidad;
    return crearApiToken(cuentaId, usuarioId, nombre);
  });

  app.get('/integracion/tokens', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    return listarApiTokens(cuentaId, usuarioId);
  });

  app.post('/integracion/tokens/:id/baja', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { cuentaId, usuarioId } = req.identidad;
    return revocarApiToken(cuentaId, usuarioId, id);
  });

  // --- Ingesta de asistencia (token de SERVICIO, no login de usuario) ---
  // Esta ruta está en PUBLICAS para el hook de JWT; hace su propia auth con el token.
  app.post('/integracion/asistencia', async (req) => {
    const auth = req.headers.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
    const cuentaId = await resolverEmpresaPorToken(token);
    if (!cuentaId) throw new HttpError(401, 'Token de integración inválido o revocado.');

    const body = z.object({ periodo: PERIODO, items: z.array(ITEM).min(1) }).parse(req.body);
    return ingestarAsistencia(cuentaId, body.periodo, body.items);
  });
}
