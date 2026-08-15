import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  moverMarca, agregarMarca, quitarMarca, misMarcas,
  marcasEnTodasLasHojas, quitarMisMarcas,
} from '../../services/marcas';
import {
  firmasVisualesDelFirmante,
  guardarFirmaVisualDelFirmante,
  bajarFirmaVisualDelFirmante,
  quitarFirmaVisualDelFirmante,
} from '../../services/firma_visual';
import { z } from 'zod';
import {
  abrirParaFirmar, documentoParaFirmar, firmar, rechazar,
  caracterParaFirmar, declararCaracter,
} from '../../services/firma';
import { estadoDeCuenta, crearCuentaDesdeFirma } from '../../services/cuenta_del_firmante';
import { camposParaFirmar, guardarValor } from '../../services/campos';
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
  //
  // ⚠ `t` es opcional A PROPÓSITO (15/8). La pantalla se saca la llave de la
  // barra de direcciones apenas entra —para que no quede en el historial— y
  // Safari en el teléfono recarga pestañas cuando quiere: esa recarga llega
  // acá SIN token pero CON la cookie del primer ingreso. Rechazarla era echar
  // al firmante a mitad del documento (pasó en la hoja 36 del contrato de
  // prueba de 500). La cookie es el mismo token que ya se verificó: usarla de
  // respaldo no abre ninguna puerta nueva, renueva la que ya estaba abierta.
  app.post('/firmar/abrir', async (req, reply) => {
    const b = z
      .object({ t: z.string().min(10).optional(), zona_horaria: z.string().max(60).optional() })
      .parse(req.body);

    const token = b.t ?? (req as any).cookies?.[COOKIE];
    if (!token) throw new HttpError(401, 'Volvé a abrir el enlace que te llegó por correo.');

    const datos = await abrirParaFirmar(token, {
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
      zonaHoraria: b.zona_horaria ?? null,
    });
    guardarToken(req, reply, token);
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

  // ---- Campos rellenables ----
  //
  // Un campo por llamada: el error de uno no se lleva puestos los otros cuatro
  // que estaban bien. Quién puede completar qué lo decide la RLS, no esto.
  app.post('/firmar/campos', async (req) => camposParaFirmar(tokenDe(req)));

  app.post('/firmar/campos/guardar', async (req) => {
    const b = z
      .object({ campo_id: z.string().uuid(), valor: z.string().max(2000).nullable() })
      .parse(req.body);
    return guardarValor(tokenDe(req), b.campo_id, b.valor);
  });

  // ---- Quedarse con el documento ----
  //
  // ⚠ Estas dos rutas NO reciben el correo: sale de la identidad del
  // otorgamiento que trae la cookie. Es lo que las hace seguras y lo que las
  // distingue del alta en frío. Ver `services/cuenta_del_firmante.ts`.
  app.post('/firmar/cuenta', async (req) => estadoDeCuenta(tokenDe(req)));

  app.post(
    '/firmar/cuenta/crear',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (req) => {
      const b = z
        .object({ pais: z.string().length(2), password: z.string().min(1).optional() })
        .parse(req.body);
      return crearCuentaDesdeFirma(tokenDe(req), { pais: b.pais.toUpperCase(), password: b.password });
    },
  );

  app.post('/firmar/rechazar', async (req) => {
    const b = z.object({ motivo: z.string().min(1).max(500) }).parse(req.body);
    return rechazar(tokenDe(req), b.motivo, {
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
  });
  /**
   * El firmante acomoda su marca dentro de la hoja: la corre y la redimensiona.
   *
   * ⚠ La página NO se cambia. Correr o agrandar la firma es acomodarla; ponerla
   * en otra hoja es firmar en otro lado del contrato, y eso es del emisor.
   *
   * Los dos cambios van al expediente, cada uno con su evento. Ver `moverMarca`.
   */
  // ⚠ Ruta SIN parámetro en el camino, y el id va en el cuerpo. No es capricho:
  // `PUBLICAS` en server.ts compara la ruta EXACTA, así que `/firmar/marcas/:id`
  // nunca coincidiría y el firmante externo —que no tiene sesión de cuenta—
  // recibiría 401. Es el mismo error que ya nos costó tres rutas del login.
  app.post('/firmar/marca', async (req) => {
    // El token sale de la COOKIE, igual que en todas las demás de esta pantalla.
    // Antes venía en el cuerpo, y eso obligaba al navegador a conservar el token
    // del enlace después de habérselo sacado de la barra de direcciones — que es
    // justo lo que la cookie existe para evitar.
    const b = z
      .object({
        marca_id: z.string().uuid(),
        x: z.number().min(0).max(20000),
        y: z.number().min(0).max(20000),
        // Opcionales: arrastrar manda sólo x/y y el tamaño queda como estaba.
        // Los límites de verdad los pone el servicio —esto es la primera red,
        // no la única— porque la regla tiene que seguir puesta el día que esto
        // se llame desde un lote o desde la API.
        ancho: z.number().positive().max(2000).optional(),
        alto: z.number().positive().max(2000).optional(),
      })
      .parse(req.body);
    return moverMarca(
      tokenDe(req),
      b.marca_id,
      b.x,
      b.y,
      { ancho: b.ancho, alto: b.alto },
      { ip: req.ip, userAgent: req.headers['user-agent'] ?? null },
    );
  });


  // ==========================================================================
  // La rúbrica del firmante
  //
  // ⚠ Quien pone su firma autógrafa en un documento es el FIRMANTE, en el acto
  // de firmar. El emisor reserva dónde va; la imagen es de la persona. Estas
  // rutas son la mitad de esa historia que faltaba: la de quien no tiene cuenta
  // y por lo tanto no puede llegar a `/mi/firma-visual`.
  //
  // ⚠ NINGUNA lleva parámetro en el camino. `PUBLICAS` en server.ts compara la
  // ruta EXACTA, así que `/firmar/rubrica/:tipo` nunca coincidiría y el firmante
  // externo —que no tiene sesión de cuenta— recibiría 401. Es el mismo error que
  // ya nos costó tres rutas del login. El tipo va en el cuerpo o en la query.
  // ==========================================================================

  /** Qué imágenes tiene cargadas hoy. Sin bytes: la lista no necesita la imagen. */
  app.post('/firmar/rubrica', async (req) => firmasVisualesDelFirmante(tokenDe(req)));

  app.post('/firmar/rubrica/cargar', async (req) => {
    const parte = await (req as any).file();
    if (!parte) throw new HttpError(400, 'No llegó ninguna imagen.');
    const contenido = await parte.toBuffer();

    // Los campos del multipart llegan junto al archivo, no en `req.body`.
    const campos: Record<string, string> = {};
    for (const [k, v] of Object.entries<any>(parte.fields ?? {})) {
      if (v && typeof v.value === 'string') campos[k] = v.value;
    }
    const tipo = campos.tipo === 'rubrica' ? 'rubrica' : 'firma';
    const origen = campos.origen === 'subida' ? 'subida' : 'dibujada';

    return guardarFirmaVisualDelFirmante(tokenDe(req), tipo, contenido, origen);
  });

  app.get('/firmar/rubrica/imagen', async (req, reply) => {
    const { tipo } = z
      .object({ tipo: z.enum(['firma', 'rubrica']).default('firma') })
      .parse(req.query);
    const r = await bajarFirmaVisualDelFirmante(tokenDe(req), tipo);
    // `no-store` y no `private`: es una imagen que sirve para suplantar a
    // alguien. Que no quede en el disco de un locutorio.
    reply
      .header('Content-Type', r.mime)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'no-store');
    return reply.send(r.contenido);
  });

  app.post('/firmar/rubrica/quitar', async (req) => {
    const { tipo } = z.object({ tipo: z.enum(['firma', 'rubrica']) }).parse(req.body);
    return quitarFirmaVisualDelFirmante(tokenDe(req), tipo);
  });

  // ==========================================================================
  // Dónde va: colocar, mover y sacar
  // ==========================================================================

  /** Las marcas del documento: las suyas, arrastrables, y las ajenas, para no pisarlas. */
  /**
   * Con qué carácter firma. ⚠ Lo declara quien firma, nunca quien manda el
   * documento: es una afirmación sobre quién es esa persona.
   */
  app.post('/firmar/caracter', async (req) => caracterParaFirmar(tokenDe(req)));

  app.post('/firmar/caracter/declarar', async (req) => {
    const b = z
      .object({
        caracter: z.enum(['personal', 'representacion']),
        cuenta_representada_id: z.string().uuid().nullable().optional(),
      })
      .parse(req.body);
    return declararCaracter(tokenDe(req), b.caracter, b.cuenta_representada_id ?? null);
  });

  app.post('/firmar/marcas', async (req) => misMarcas(tokenDe(req)));

  app.post('/firmar/marca/agregar', async (req) => {
    const b = z
      .object({
        tipo: z.enum(['firma', 'rubrica']),
        pagina: z.number().int().min(0).max(5000),
        x: z.number().min(0).max(20000),
        y: z.number().min(0).max(20000),
        // Un tope generoso pero real: una rúbrica de más de 400 puntos de ancho
        // no cabe en una hoja A4 con márgenes, y sin tope el cliente puede
        // mandar una que tape el contrato entero.
        ancho: z.number().min(20).max(400),
        alto: z.number().min(10).max(200),
      })
      .parse(req.body);
    return agregarMarca(tokenDe(req), b, {
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
  });

  /**
   * La misma marca en todas las hojas. Las coordenadas vienen del navegador
   * porque cada página puede tener tamaño y rotación distintos, y quien las
   * midió fue pdf.js al dibujarlas.
   */
  app.post('/firmar/marca/todas', async (req) => {
    const b = z
      .object({
        tipo: z.enum(['firma', 'rubrica']),
        hojas: z
          .array(
            z.object({
              pagina: z.number().int().min(0).max(5000),
              x: z.number().min(0).max(20000),
              y: z.number().min(0).max(20000),
              ancho: z.number().min(20).max(400),
              alto: z.number().min(10).max(200),
            }),
          )
          .min(1)
          .max(1000),
      })
      .parse(req.body);
    return marcasEnTodasLasHojas(tokenDe(req), b.tipo, b.hojas, {
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
  });

  app.post('/firmar/marca/limpiar', async (req) => {
    const b = z
      .object({ tipo: z.enum(['firma', 'rubrica']).nullable().optional() })
      .parse(req.body);
    return quitarMisMarcas(tokenDe(req), b.tipo ?? null, {
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
  });

  app.post('/firmar/marca/quitar', async (req) => {
    const b = z.object({ marca_id: z.string().uuid() }).parse(req.body);
    return quitarMarca(tokenDe(req), b.marca_id, {
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
  });

}
