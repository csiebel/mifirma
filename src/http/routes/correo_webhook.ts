import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';

// =============================================================================
// Receptor de eventos de correo de Brevo — FASE 1: sólo escucha.
// =============================================================================
//
// ═══ PARA QUÉ EXISTE ═══
//
// Hoy el expediente anota `notificacion.enviada` cuando el servidor SMTP no
// rechaza el mensaje. Eso NO es la entrega: un relay acepta y después no
// entrega (destinatario bloqueado, baja previa, rebote duro). La migración 058
// ya corrigió la DESCRIPCIÓN del evento para que no sobreafirme, y dejó dicho
// dónde va la otra mitad: `notificacion.entregada`, que existe en el catálogo
// desde la 020, en tres idiomas, y no la escribe nadie.
//
// Este archivo es el primer paso para que alguien la escriba.
//
// ═══ POR QUÉ ESTA FASE NO TOCA LA BASE ═══
//
// Para anotar «este correo llegó» en el expediente hace falta atar el evento
// entrante a una instancia de firma y a un firmante. Hoy NO se puede: los ocho
// lugares que llaman a `enviarCorreo()` descartan el identificador que devuelve.
//
// Y hay dos candidatos para el amarre, sin forma de decidir por documentación:
//
//   1. `message-id` — el que genera nuestro servidor. Brevo puede conservarlo
//      o reemplazarlo por el suyo, y hay reportes de que en algunos eventos
//      directamente no viene.
//   2. `X-Mailin-custom` — una etiqueta propia. Brevo la devuelve en el
//      webhook cuando se manda por su API; mandamos por SMTP RELAY, que es
//      otro camino, y su propia comunidad pregunta esto sin respuesta clara.
//
// La respuesta se mide, no se razona: esta ruta imprime lo que llegó de verdad,
// se manda un correo real, y el log dice cuál de los dos sobrevivió. Recién con
// eso escrito se puede hacer la fase 2 sin adivinar.
//
// Mismo camino que `pagos_webhook.ts`, que también arrancó en «verifica y sólo
// loguea».
//
// ═══ CÓMO SE AUTENTICA ═══
//
// ⚠ Brevo NO firma sus webhooks (no hay equivalente a la firma de Stripe, que
// es lo que verifica el adaptador de pagos). Lo que ofrece es: lista blanca de
// IP, usuario y contraseña embebidos en la dirección, un bearer, o cabeceras
// propias definidas al crear el webhook.
//
// Acá se acepta el secreto por `Authorization`, en cualquiera de las dos formas
// que se pueden configurar del lado de Brevo:
//
//   Authorization: Bearer <secreto>              (webhook con auth de tipo bearer)
//   Authorization: Basic base64(loquesea:<secreto>)   (usuario:contraseña en la URL)
//
// ⚠⚠ FALLA CERRADO. Sin `BREVO_WEBHOOK_SECRET` en el entorno, la ruta NO
// procesa nada. Una ruta pública que acepta cualquier cosa «porque todavía no
// escribe en la base» es exactamente la que se olvida abierta cuando sí escribe.
// =============================================================================

/** Compara sin filtrar el largo ni la posición de la primera diferencia. */
function igualSeguro(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * El secreto que trajo el pedido, venga como bearer o como basic.
 * Devuelve '' si no vino ninguno.
 */
function secretoDelPedido(authorization: string | undefined): string {
  const h = (authorization || '').trim();
  if (!h) return '';
  if (/^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  if (/^Basic\s+/i.test(h)) {
    const crudo = Buffer.from(h.replace(/^Basic\s+/i, '').trim(), 'base64').toString('utf8');
    // usuario:contraseña — el usuario no nos importa, el secreto es la contraseña.
    const i = crudo.indexOf(':');
    return i === -1 ? crudo : crudo.slice(i + 1);
  }
  return '';
}

/**
 * Enmascara una dirección para el log. Los logs de Railway no son lugar para
 * las direcciones de los firmantes: alcanza con poder distinguir dos destinos
 * distintos mientras se depura.
 */
function enmascararEmail(email: string): string {
  const e = (email || '').trim();
  const i = e.indexOf('@');
  if (i <= 0) return e ? '•••' : '';
  const usuario = e.slice(0, i);
  const dominio = e.slice(i + 1);
  const visible = usuario.length <= 2 ? usuario.slice(0, 1) : usuario.slice(0, 2);
  return `${visible}•••@${dominio}`;
}

/** Un evento de Brevo, con las claves que nos interesan y el resto sin abrir. */
interface EventoBrevo {
  event?: string;
  email?: string;
  'message-id'?: string;
  'X-Mailin-custom'?: string;
  tags?: unknown;
  reason?: string;
  subject?: string;
  ts_event?: number;
}

export function registrarRutasCorreoWebhook(app: FastifyInstance) {
  app.post('/correo/webhook/brevo', async (req, reply) => {
    const esperado = (process.env.BREVO_WEBHOOK_SECRET || '').trim();

    // ⚠ Dos motivos distintos, dos mensajes distintos. «Está apagado porque
    // falta la variable» y «el secreto no coincide» mandan a buscar el problema
    // a lugares opuestos: si los dos dijeran lo mismo, no se podrían distinguir
    // justo cuando importa.
    if (!esperado) {
      req.log.error(
        { evento_correo: 'webhook_apagado' },
        'Correo: llegó un evento de Brevo y el receptor está APAGADO — falta BREVO_WEBHOOK_SECRET en el entorno',
      );
      return reply.code(503).send({ ok: false });
    }

    if (!igualSeguro(secretoDelPedido(req.headers.authorization), esperado)) {
      req.log.warn(
        { evento_correo: 'webhook_rechazado' },
        'Correo: evento de Brevo rechazado — el secreto no coincide',
      );
      return reply.code(401).send({ ok: false });
    }

    // Brevo manda normalmente un evento por pedido, pero tolerar el lote sale
    // gratis y evita perder eventos en silencio si algún día cambia.
    const cuerpo = req.body as EventoBrevo | EventoBrevo[] | null;
    const eventos: EventoBrevo[] = Array.isArray(cuerpo) ? cuerpo : cuerpo ? [cuerpo] : [];

    if (eventos.length === 0) {
      req.log.warn({ evento_correo: 'webhook_vacio' }, 'Correo: evento de Brevo sin cuerpo');
      return { ok: true };
    }

    for (const e of eventos) {
      // ⚠⚠ ESTO ES EL EXPERIMENTO, Y ES TODO LO QUE HACE LA FASE 1.
      //
      // `claves` es la lista de nombres de campo que Brevo mandó de verdad —no
      // los que dice su documentación—, y es lo que decide con qué se ata el
      // evento al expediente en la fase 2. Se loguean los NOMBRES, no los
      // valores: el payload trae la dirección del firmante y el asunto del
      // documento, que no van al log.
      req.log.info(
        {
          evento_correo: 'webhook_recibido',
          tipo: e.event ?? '(sin event)',
          destino: enmascararEmail(e.email ?? ''),
          message_id: e['message-id'] ?? '(no vino)',
          custom: e['X-Mailin-custom'] ?? '(no vino)',
          tags: e.tags ?? '(no vino)',
          motivo: e.reason ?? undefined,
          claves: Object.keys(e ?? {}).sort(),
        },
        'Correo: evento de Brevo recibido (fase 1: sólo se anota en el log, no toca la base)',
      );
    }

    // Siempre 200 cuando el secreto es bueno: un error nuestro no tiene por qué
    // hacer que Brevo reintente y termine desactivando el webhook.
    return { ok: true, recibidos: eventos.length };
  });
}
