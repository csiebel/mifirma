import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAyudas } from '../../ayuda/textos';
import { getI18nConOverrides } from '../../services/traducciones';
import { marcoLaboral } from '../../services/marco';

// /ayudas y /i18n son PÚBLICOS (texto de interfaz, no sensible): los consumen
// tanto la consola como el sitio. /marco-laboral requiere token: resuelve el
// país por la identidad y devuelve los parámetros vigentes de la empresa.
export function registrarRutasAyuda(app: FastifyInstance) {
  app.get('/i18n', async (req) => {
    const { idioma } = z.object({ idioma: z.string().optional() }).parse(req.query);
    return getI18nConOverrides(idioma);
  });

  app.get('/ayudas', async (req) => {
    const { idioma } = z.object({ idioma: z.string().optional() }).parse(req.query);
    return getAyudas(idioma);
  });

  app.get('/marco-laboral', async (req) => {
    const { cuentaId, usuarioId } = req.identidad;
    return marcoLaboral(cuentaId, usuarioId);
  });
}
