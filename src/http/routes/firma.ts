import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { abrirParaFirmar, documentoParaFirmar, firmar, rechazar } from '../../services/firma';
import { HttpError } from '../errors';

/**
 * La pantalla del firmante externo.
 *
 * ═══ POR QUÉ EL TOKEN SE CAMBIA POR UNA COOKIE ═══
 *
 * El enlace trae el token en el FRAGMENTO (`/firmar#t=…`), que no viaja al
 * servidor: no queda en logs de acceso ni se filtra por el Referer. Pero el
 * visor necesita pedir el PDF con un `<iframe src=…>`, y ahí no se pueden poner
 * cabeceras — el token tendría que ir en la query, que es exactamente lo que se
 * estaba evitando.
 *
 * La salida es cambiarlo una vez: el navegador postea el token, el servidor lo
 * verifica y deja una cookie httpOnly acotada a `/firmar`, y a partir de ahí el
 * PDF y la firma viajan con la cookie. El token nunca aparece en una URL que el
 * servidor registre.
 *
 * La cookie es SameSite=Lax, así que no viaja en un POST cross-site: eso es lo
 * que evita que otro sitio pueda hacer firmar a alguien sin que se entere.
 */

const COOKIE = 'firma';
const TTL_SEG = 2 * 60 * 60;

function guardarToken(req: FastifyRequest, reply: FastifyReply, token: string) {
  reply.setCookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.protocol === 'https',
    path: '/firmar',
    maxAge: TTL_SEG,
  });
}

function tokenDe(req: FastifyRequest): string {
  const t = (req as any).cookies?.[COOKIE];
  if (!t) throw new HttpError(401, 'Volvé a abrir el enlace que te llegó por correo.');
  return t;
}

export function registrarRutasFirma(app: FastifyInstance) {
  // Cambia el token del enlace por la cookie y devuelve todo lo que la pantalla
  // necesita mostrar. Es también el momento en que se anota `documento.abierto`.
  app.post('/firmar/abrir', async (req, reply) => {
    const b = z
      .object({ t: z.string().min(10), zona_horaria: z.string().max(60).optional() })
      .parse(req.body);

    const datos = await abrirParaFirmar(b.t, {
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
      zonaHoraria: b.zona_horaria ?? null,
    });
    guardarToken(req, reply, b.t);
    return datos;
  });

  app.get('/firmar/documento', async (req, reply) => {
    const r = await documentoParaFirmar(tokenDe(req));
    reply
      .header('Content-Type', r.mime)
      .header('Content-Disposition', 'inline')
      .header('X-Content-Type-Options', 'nosniff')
      .header('X-Frame-Options', 'SAMEORIGIN')
      .header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'self'; object-src 'none'")
      .header('Cache-Control', 'private, no-store');
    return reply.send(r.contenido);
  });

  app.post('/firmar/firmar', async (req) => {
    const b = z
      .object({
        consentimiento: z.boolean(),
        nombre_escrito: z.string().max(120).optional(),
        zona_horaria: z.string().max(60).optional(),
        huella: z.string().max(120).optional(),
      })
      .parse(req.body);

    return firmar(tokenDe(req), {
      consentimiento: b.consentimiento,
      nombreEscrito: b.nombre_escrito ?? null,
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
      zonaHoraria: b.zona_horaria ?? null,
      huellaDispositivo: b.huella ?? null,
    });
  });

  app.post('/firmar/rechazar', async (req) => {
    const b = z.object({ motivo: z.string().min(1).max(500) }).parse(req.body);
    return rechazar(tokenDe(req), b.motivo, {
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
  });
}
