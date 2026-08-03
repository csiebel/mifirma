import { sql, type Transaction } from 'kysely';
import { db } from '../db/pool';
import type { DB } from '../db/schema';
import { hashPassword, validarPassword } from '../auth/password';
import { generarToken, hashToken } from '../auth/token';
import { enviarCorreo } from './correo';
import { registrarSistema } from './auditoria';
import { HttpError } from '../http/errors';

/**
 * Elegir contraseña: recupero e invitación.
 *
 * Los dos usan el mismo mecanismo —un token de un solo uso, con vencimiento,
 * que llega por correo— y difieren sólo en el texto y en cuánto duran.
 *
 * ═══ QUÉ CAMBIÓ RESPECTO DE PAYROLL NG ═══
 *
 * Allá la contraseña vivía en `usuario`, que era por empresa, así que pedir
 * recupero con un correo presente en tres empresas mandaba TRES mails, cada uno
 * con su enlace. Acá la contraseña es de la identidad, que es única: un correo,
 * un enlace, una contraseña.
 *
 * ═══ ANTI-ENUMERACIÓN ═══
 *
 * `solicitarReset` devuelve `{ok:true}` siempre, exista o no el correo. Si
 * distinguiera, sería un formulario público para averiguar quién está en el
 * sistema — y en un producto de firma, saber que alguien tiene cuenta ya es
 * información. Los fallos de envío quedan en el log del servidor, con el correo
 * enmascarado, para que el operador pueda diagnosticar sin exponer nada.
 */

const RESET_TTL_MIN = 30;
const INVITACION_TTL_DIAS = 7;
const VENTANA_ANTIABUSO_MS = 60 * 60 * 1000;
const RESET_MAX_POR_VENTANA = 3;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function baseUrl(): string {
  return (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

/**
 * ⚠ Va a `/entrar`, NO a `/app`.
 *
 * `/app` sirve la consola. Sin sesión, la consola hace `location.href =
 * '/entrar'` y **en ese salto se pierde el fragmento**, o sea el token: la
 * persona termina en el login pelado, sin forma de elegir su contraseña.
 *
 * Estuvo mal desde el principio y no lo notó nadie porque ni el recupero ni la
 * invitación se habían recorrido enteros hasta el 3/8/2026. Es la lección 12
 * otra vez: un camino ejercido cero veces no está de más, está sin probar.
 *
 * El token va en el FRAGMENTO y no en la query a propósito: el fragmento no
 * viaja al servidor, así que no queda en los logs ni se filtra por el Referer.
 */
function enlace(token: string, tipo: 'reset' | 'invitacion'): string {
  return `${baseUrl()}/entrar#token=${token}&t=${tipo === 'invitacion' ? 'inv' : 'reset'}`;
}

function enmascararEmailLog(email: string): string {
  const i = email.indexOf('@');
  return i <= 1 ? '***' : `${email.slice(0, 1)}***${email.slice(i)}`;
}

const escHtml = (s: string) =>
  s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));

/** Modo sistema sin cuenta: el recupero ocurre antes de saber a qué cuenta se entra. */
async function enSistema<T>(fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`select
      set_config('app.actor','sistema',true),
      set_config('app.cuenta_id','',true),
      set_config('app.identidad_id','',true),
      set_config('app.anclajes_probados','',true),
      set_config('app.nivel_garantia','ninguno',true),
      set_config('app.idioma','es',true),
      set_config('app.otorgamiento_id','',true)
    `.execute(trx);
    return fn(trx);
  });
}

// ---------------------------------------------------------------------------
// Recupero
// ---------------------------------------------------------------------------

export async function solicitarReset(email: string): Promise<{ ok: true }> {
  const emailN = email.trim().toLowerCase();
  if (!EMAIL_RE.test(emailN)) return { ok: true };

  const yo = await enSistema((trx) =>
    trx
      .selectFrom('identidad as i')
      .innerJoin('credencial as c', 'c.identidad_id', 'i.id')
      .select(['i.id as id', 'i.email_mostrado as email', 'i.estado as estado'])
      .where('i.email_normalizado', '=', emailN)
      .executeTakeFirst(),
  );

  // Sin credencial no hay contraseña que restablecer: es una identidad latente,
  // alguien a quien invitaron a firmar y nunca se registró. Respuesta idéntica.
  if (!yo || yo.estado !== 'activa') return { ok: true };

  const recientes = await enSistema((trx) =>
    trx
      .selectFrom('token_acceso')
      .select('id')
      .where('identidad_id', '=', yo.id)
      .where('tipo', '=', 'reset')
      .where('creado_en', '>', new Date(Date.now() - VENTANA_ANTIABUSO_MS))
      .execute(),
  );
  // Se omite el envío en silencio: seguimos devolviendo ok por anti-enumeración.
  if (recientes.length >= RESET_MAX_POR_VENTANA) return { ok: true };

  const { token, hash } = generarToken();
  await enSistema((trx) =>
    trx
      .insertInto('token_acceso')
      .values({
        identidad_id: yo.id,
        tipo: 'reset',
        token_hash: hash,
        expira_en: new Date(Date.now() + RESET_TTL_MIN * 60000),
      })
      .execute(),
  );

  try {
    await enviarCorreo({
      para: yo.email,
      asunto: 'Restablecer tu contraseña · MiFirma',
      html:
        `<p>Pediste restablecer tu contraseña de MiFirma.</p>` +
        `<p><a href="${enlace(token, 'reset')}">Elegí una nueva contraseña</a> (el enlace vence en ${RESET_TTL_MIN} minutos).</p>` +
        `<p>Si no fuiste vos, ignorá este correo: tu contraseña sigue siendo la de siempre.</p>`,
      texto: `Restablecé tu contraseña de MiFirma: ${enlace(token, 'reset')} (vence en ${RESET_TTL_MIN} minutos). Si no fuiste vos, ignorá este correo.`,
    });
  } catch (e) {
    console.warn(
      '[reset] no se pudo enviar el correo a',
      enmascararEmailLog(yo.email),
      '-',
      e instanceof Error ? e.message : e,
    );
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Confirmar
// ---------------------------------------------------------------------------

export async function confirmarReset(token: string, password: string): Promise<{ ok: true }> {
  const errPwd = validarPassword(password);
  if (errPwd) throw new HttpError(400, errPwd);

  const fila = await enSistema((trx) =>
    trx
      .selectFrom('token_acceso')
      .select(['id', 'identidad_id', 'cuenta_id', 'tipo', 'expira_en'])
      .where('token_hash', '=', hashToken(token))
      .where('usado_en', 'is', null)
      .orderBy('creado_en', 'desc')
      .executeTakeFirst(),
  );
  if (!fila) throw new HttpError(400, 'El enlace venció o ya se usó. Pedí uno nuevo.');

  if (new Date(fila.expira_en).getTime() < Date.now()) {
    await enSistema((trx) =>
      trx.updateTable('token_acceso').set({ usado_en: new Date() }).where('id', '=', fila.id).execute(),
    );
    throw new HttpError(400, 'El enlace venció. Pedí uno nuevo.');
  }

  await enSistema(async (trx) => {
    // La credencial puede no existir todavía: una invitación es la primera vez
    // que esta identidad tiene forma de entrar. Antes era sólo un destinatario
    // de documentos.
    await trx
      .insertInto('credencial')
      .values({
        identidad_id: fila.identidad_id,
        hash_password: hashPassword(password),
        password_cambiada_en: new Date(),
      })
      .onConflict((oc) =>
        oc.column('identidad_id').doUpdateSet({
          hash_password: hashPassword(password),
          password_cambiada_en: new Date(),
          intentos_fallidos: 0,
          bloqueada_hasta: null,
        }),
      )
      .execute();

    // La identidad latente pasa a activa: ya no es sólo alguien a quien le
    // mandaron un documento, ahora entra por la puerta.
    await trx
      .updateTable('identidad')
      .set({ estado: 'activa' })
      .where('id', '=', fila.identidad_id)
      .where('estado', '=', 'latente')
      .execute();

    await trx.updateTable('token_acceso').set({ usado_en: new Date() }).where('id', '=', fila.id).execute();

    // Cambiar la contraseña revoca los dispositivos de confianza y quema los OTP
    // pendientes. Sin esto, quien te robó la sesión en un equipo "confiable"
    // sigue entrando sin segundo factor después de que cambiaste la clave — que
    // es exactamente el momento en que la gente cree haberse puesto a salvo.
    //
    // Se REVOCA, no se borra: el registro de que ese equipo estuvo confiado es
    // parte de poder reconstruir qué pasó.
    await trx
      .updateTable('dispositivo_confiable')
      .set({ revocado_en: new Date() })
      .where('identidad_id', '=', fila.identidad_id)
      .where('revocado_en', 'is', null)
      .execute();

    await trx
      .updateTable('otp_login')
      .set({ usado: true })
      .where('identidad_id', '=', fila.identidad_id)
      .where('usado', '=', false)
      .execute();
  });

  if (fila.cuenta_id) {
    await registrarSistema(fila.cuenta_id, fila.identidad_id, {
      accion: fila.tipo === 'invitacion' ? 'password.elegida' : 'password.reset',
      recursoTipo: 'credencial',
      recursoId: fila.identidad_id,
    });
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Invitación
// ---------------------------------------------------------------------------

/**
 * Manda el correo para elegir contraseña. Lo dispara `darAcceso` en
 * `usuarios.ts` y el botón de "reenviar invitación".
 *
 * TODO: el texto va a salir de `plantilla_mensaje` + `bloque_mensaje`
 * (migración 014), en el idioma efectivo del destinatario. Mientras el catálogo
 * de plantillas no esté cargado, el texto por defecto vive acá. Ver
 * `claude/multiidioma-y-textos.md` §4.
 */
export async function enviarInvitacionPorCorreo(
  cuentaId: string,
  identidadId: string,
  email: string,
  _rolId?: string,
): Promise<void> {
  const { token, hash } = generarToken();

  const datos = await enSistema(async (trx) => {
    const cuenta = await trx
      .selectFrom('cuenta')
      .select(['nombre_mostrado'])
      .where('id', '=', cuentaId)
      .executeTakeFirst();
    const ident = await trx
      .selectFrom('identidad as i')
      .leftJoin('credencial as c', 'c.identidad_id', 'i.id')
      .select(['i.nombre_mostrado as nombre', 'c.hash_password as hash'])
      .where('i.id', '=', identidadId)
      .executeTakeFirst();

    await trx
      .insertInto('token_acceso')
      .values({
        identidad_id: identidadId,
        cuenta_id: cuentaId,
        tipo: 'invitacion',
        token_hash: hash,
        expira_en: new Date(Date.now() + INVITACION_TTL_DIAS * 86400000),
      })
      .execute();

    return {
      cuenta: cuenta?.nombre_mostrado ?? 'MiFirma',
      nombre: (ident?.nombre ?? '').trim(),
      yaTienePassword: !!ident?.hash,
    };
  });

  const link = enlace(token, 'invitacion');
  const saludo = datos.nombre ? `Hola ${escHtml(datos.nombre)}: ` : '';

  // Quien ya tiene contraseña no necesita elegir una: sólo enterarse de que
  // ahora tiene acceso a esta cuenta. Mandarle "elegí tu contraseña" a alguien
  // que ya la tiene invita a cambiarla sin motivo, y encima le revoca los
  // dispositivos de confianza al hacerlo.
  const asunto = datos.yaTienePassword
    ? `Ya tenés acceso a ${datos.cuenta} · MiFirma`
    : `Te invitaron a ${datos.cuenta} · MiFirma`;

  const html = datos.yaTienePassword
    ? `<p>${saludo}te habilitaron el acceso a <b>${escHtml(datos.cuenta)}</b> en MiFirma.</p>` +
      `<p>Entrá con tu correo y tu contraseña de siempre en <a href="${baseUrl()}/app">${baseUrl()}/app</a>.</p>`
    : `<p>${saludo}te crearon un acceso en <b>${escHtml(datos.cuenta)}</b>.</p>` +
      `<p style="margin:16px 0"><a href="${link}" style="background:#0a2540;color:#ffffff;padding:11px 18px;border-radius:8px;text-decoration:none;font-weight:600">Elegí tu contraseña</a></p>` +
      `<p style="color:#666;font-size:13px">El enlace vence en ${INVITACION_TTL_DIAS} días.</p>`;

  const texto = datos.yaTienePassword
    ? `Te habilitaron el acceso a ${datos.cuenta} en MiFirma. Entrá con tu correo y tu contraseña de siempre: ${baseUrl()}/app`
    : `Te crearon un acceso en ${datos.cuenta}. Elegí tu contraseña: ${link} (vence en ${INVITACION_TTL_DIAS} días).`;

  try {
    await enviarCorreo({ para: email, asunto, html, texto });
  } catch {
    throw new HttpError(503, 'No se pudo enviar la invitación por correo. Revisá la configuración de correo.');
  }
}
