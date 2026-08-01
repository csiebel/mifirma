import webpush from 'web-push';
import { withUsuario } from '../auth/authz';
import { withTenant } from '../db/pool';
import { HttpError } from '../http/errors';
import { registrarSistema } from './auditoria';

// Notificaciones push (Web Push). El envío real lo hace web-push con un par de
// claves VAPID que viven en variables de entorno (VAPID_PUBLIC_KEY /
// VAPID_PRIVATE_KEY / VAPID_SUBJECT). Si no están configuradas, el módulo queda
// inerte: las suscripciones se guardan igual, pero notificarUsuario no envía nada.

let configurado = false;

function configurar(): boolean {
  if (configurado) return true;
  // trim(): un espacio o salto de línea pegado al copiar la variable invalida el
  // JWT ante Apple (BadJwtToken) sin que la librería se queje. Nos pasó.
  const pub = (process.env.VAPID_PUBLIC_KEY || '').trim();
  const priv = (process.env.VAPID_PRIVATE_KEY || '').trim();
  const subject = (process.env.VAPID_SUBJECT || 'mailto:soporte@mi-firma.digital').trim();
  if (!pub || !priv) return false;
  try {
    webpush.setVapidDetails(subject, pub, priv);
    configurado = true;
    return true;
  } catch (e) {
    // Claves o subject mal formados: no dejamos que esto tumbe el envío en silencio.
    console.error('push: VAPID inválido (revisá VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT):', e);
    return false;
  }
}

/** Clave pública VAPID para que el front se suscriba. No es secreta. */
export function clavePublica(): string | null {
  return process.env.VAPID_PUBLIC_KEY || null;
}

export interface SuscripcionInput {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
  userAgent?: string;
}

/** Guarda (o actualiza) la suscripción del usuario logueado. */
export async function registrarSuscripcion(
  cuentaId: string,
  identidadId: string,
  input: SuscripcionInput,
): Promise<{ ok: true }> {
  const endpoint = input.endpoint || '';
  const p256dh = input.keys?.p256dh || '';
  const auth = input.keys?.auth || '';
  if (!endpoint || !p256dh || !auth) {
    throw new HttpError(400, 'Suscripción de notificaciones incompleta.');
  }
  return withUsuario(cuentaId, identidadId, async (trx) => {
    await trx
      .insertInto('push_suscripcion')
      .values({
        identidad_id: identidadId,
        endpoint,
        p256dh,
        auth,
        user_agent: input.userAgent || null,
      })
      .onConflict((oc) =>
        oc.column('endpoint').doUpdateSet({ identidad_id: identidadId, p256dh, auth }),
      )
      .execute();
    return { ok: true as const };
  });
}

/** Borra la suscripción del usuario logueado (al desactivar en el dispositivo). */
export async function borrarSuscripcion(
  cuentaId: string,
  identidadId: string,
  endpoint: string,
): Promise<{ ok: true }> {
  return withUsuario(cuentaId, identidadId, async (trx) => {
    if (endpoint) {
      await trx.deleteFrom('push_suscripcion').where('endpoint', '=', endpoint).execute();
    }
    return { ok: true as const };
  });
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
}

/**
 * Envío de sistema, best-effort. El destinatario NO es el usuario logueado, así
 * que abre el contexto de su empresa con withTenant (app_user, sujeto a RLS) y
 * filtra por usuario. Las suscripciones que el navegador ya invalidó (404/410)
 * se borran. Nunca lanza: si algo falla, el flujo que la llama no se ve afectado.
 */
export async function notificarUsuario(
  cuentaId: string,
  identidadId: string,
  payload: PushPayload,
): Promise<void> {
  try {
    if (!configurar()) {
      await registrarSistema(cuentaId, identidadId, { accion: 'push.fallido', recursoTipo: 'push', despues: { motivo: 'sin_vapid', titulo: payload.title } });
      return; // sin VAPID (o VAPID inválido), no hay envío
    }
    // Leemos las suscripciones con app_user + contexto de empresa: el RLS filtra
    // por empresa (la regla de oro nº2 vive en los datos), y app_user sí tiene
    // permiso sobre la tabla (el rol privilegiado no lo tiene).
    const subs = await withTenant(cuentaId, (trx) =>
      trx
        .selectFrom('push_suscripcion')
        .select(['id', 'endpoint', 'p256dh', 'auth'])
        .where('identidad_id', '=', identidadId)
        .execute(),
    );
    if (subs.length === 0) {
      await registrarSistema(cuentaId, identidadId, { accion: 'push.fallido', recursoTipo: 'push', despues: { motivo: 'sin_suscripcion', titulo: payload.title } });
      return;
    }
    const data = JSON.stringify(payload);
    let ok = 0;
    let fail = 0;
    const muertas: string[] = [];
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            data,
          );
          ok++;
        } catch (e: unknown) {
          fail++;
          const err = e as { statusCode?: number; body?: string };
          console.error('push send falló:', err?.statusCode, (err?.body || '').slice(0, 300));
          if (err?.statusCode === 404 || err?.statusCode === 410) muertas.push(s.id);
        }
      }),
    );
    // Las suscripciones que el navegador ya invalidó (404/410) se borran (con RLS).
    if (muertas.length) {
      await withTenant(cuentaId, (trx) =>
        trx.deleteFrom('push_suscripcion').where('id', 'in', muertas).execute(),
      ).catch(() => {});
    }
    await registrarSistema(cuentaId, identidadId, {
      accion: ok === 0 && fail > 0 ? 'push.fallido' : 'push.enviado',
      detalle: { titulo: payload.title, enviadas: ok, fallidas: fail },
    });
  } catch (e) {
    // Nunca lanza: si algo inesperado falla, lo dejamos en los logs y lo anotamos.
    console.error('notificarUsuario:', e);
    await registrarSistema(cuentaId, identidadId, { accion: 'push.fallido', recursoTipo: 'push', despues: { motivo: 'error', titulo: payload.title } }).catch(() => {});
  }
}
