import { ownerDb } from '../db/owner';
import { withUsuario, puede } from '../auth/authz';
import { hashPassword, validarPassword } from '../auth/password';
import { generarToken, hashToken } from '../auth/token';
import { enviarCorreo } from './correo';
import { registrar, registrarSistema } from './auditoria';
import { HttpError } from '../http/errors';

// Recupero de contraseña e invitación de usuarios. Ambos usan el mismo mecanismo:
// un token de un solo uso, con vencimiento, que llega por correo y habilita poner
// (o cambiar) la contraseña. El flujo público (solicitar/confirmar) corre con la
// conexión privilegiada (ownerDb). La invitación la dispara el admin (sesión).

const RESET_TTL_MIN = 30;
const INVITACION_TTL_DIAS = 7;
// Anti-abuso: tope de mails de reset por usuario dentro de la ventana (flujo no autenticado).
const VENTANA_ANTIABUSO_MS = 60 * 60 * 1000;
const RESET_MAX_POR_VENTANA = 3;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function baseUrl(): string {
  return (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}
function enlace(token: string, tipo: 'reset' | 'invitacion', destino = '/app'): string {
  return `${baseUrl()}${destino}#token=${token}&t=${tipo === 'invitacion' ? 'inv' : 'reset'}`;
}
// Enmascara el email para el log del server (no dejar PII completa en los logs).
function enmascararEmailLog(email: string): string {
  const i = email.indexOf('@');
  return i <= 1 ? '***' : `${email.slice(0, 1)}***${email.slice(i)}`;
}

// --- Recupero de contraseña (self-service) ---------------------------------
// Siempre responde ok: no revela si la empresa o el email existen.
export async function solicitarReset(email: string): Promise<{ ok: true }> {
  const db = ownerDb();
  const emailN = email.trim();
  // Un email puede estar en varias empresas: se manda un enlace por cada cuenta
  // (cada uno específico de esa empresa). Todos van al propio correo del titular.
  const cuentas = await db
    .selectFrom('usuario as u')
    .innerJoin('empresa as e', 'e.id', 'u.cuenta_id')
    .select(['u.id as usuarioId', 'u.email as email', 'e.id as cuentaId', 'e.nombre as empresaNombre'])
    .where('u.email', '=', emailN)
    .execute();
  for (const c of cuentas) {
    // Anti-abuso: no más de N mails de reset por usuario en la ventana. Si se pasa,
    // se omite el envío en silencio (se sigue devolviendo ok por anti-enumeración).
    const recientes = await db
      .selectFrom('token_acceso')
      .select('id')
      .where('cuenta_id', '=', c.cuentaId)
      .where('usuario_id', '=', c.usuarioId)
      .where('tipo', '=', 'reset')
      .where('created_at', '>', new Date(Date.now() - VENTANA_ANTIABUSO_MS))
      .execute();
    if (recientes.length >= RESET_MAX_POR_VENTANA) continue;
    // Destino del enlace: si el usuario es empleado (su persona tiene relación laboral
    // activa), lo llevamos a su app /mi; si no, a la consola /app. Igual que la invitación.
    const empleado = await db
      .selectFrom('usuario as u')
      .innerJoin('relacion_laboral as rl', 'rl.persona_id', 'u.persona_id')
      .select('u.id')
      .where('u.id', '=', c.usuarioId)
      .where('u.cuenta_id', '=', c.cuentaId)
      .where('rl.fecha_egreso', 'is', null)
      .executeTakeFirst();
    const destino = empleado ? '/mi' : '/app';
    const { token, hash } = generarToken();
    await db
      .insertInto('token_acceso')
      .values({
        cuenta_id: c.cuentaId,
        usuario_id: c.usuarioId,
        tipo: 'reset',
        token_hash: hash,
        expira_at: new Date(Date.now() + RESET_TTL_MIN * 60000),
      })
      .execute();
    try {
      await enviarCorreo({
        para: c.email,
        asunto: `Restablecer tu contraseña · ${c.empresaNombre || 'MiFirma'}`,
        html:
          `<p>Pediste restablecer tu contraseña de acceso a <strong>${c.empresaNombre || ''}</strong>.</p>` +
          `<p><a href="${enlace(token, 'reset', destino)}">Hacé clic acá para elegir una nueva</a> (vence en ${RESET_TTL_MIN} minutos).</p>` +
          `<p>Si no fuiste vos, ignorá este correo.</p>`,
        texto: `Restablecé tu contraseña de ${c.empresaNombre || ''}: ${enlace(token, 'reset', destino)} (vence en ${RESET_TTL_MIN} minutos).`,
      });
    } catch (e) {
      // Al cliente NO se le revela (anti-enumeración), pero lo dejamos en el log del server
      // para que el operador pueda diagnosticar por qué no salen los mails de reset.
      console.warn('[reset] no se pudo enviar el correo a', enmascararEmailLog(c.email), '-', e instanceof Error ? e.message : e);
    }
    await registrarSistema(c.cuentaId, c.usuarioId, { accion: 'password.reset_solicitado' });
  }
  return { ok: true };
}

// --- Confirmar: fijar la contraseña con el token (reset o invitación) -------
export async function confirmarReset(token: string, password: string): Promise<{ ok: true }> {
  const errPwd = validarPassword(password);
  if (errPwd) throw new HttpError(400, errPwd);

  const db = ownerDb();
  const fila = await db
    .selectFrom('token_acceso')
    .select(['id', 'usuario_id', 'cuenta_id', 'expira_at'])
    .where('token_hash', '=', hashToken(token))
    .where('usado', '=', false)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  if (!fila) throw new HttpError(400, 'El enlace venció o ya se usó. Pedí uno nuevo.');
  if (new Date(fila.expira_at).getTime() < Date.now()) {
    await db.updateTable('token_acceso').set({ usado: true }).where('id', '=', fila.id).execute();
    throw new HttpError(400, 'El enlace venció. Pedí uno nuevo.');
  }

  await db
    .updateTable('usuario')
    .set({ password_hash: hashPassword(password), password_actualizado: new Date(), activo: true })
    .where('id', '=', fila.usuario_id)
    .execute();
  await db.updateTable('token_acceso').set({ usado: true }).where('id', '=', fila.id).execute();
  // Seguridad: al cambiar la contraseña se revocan los equipos de confianza y los OTP
  // pendientes, para que un equipo "confiable" viejo no saltee el segundo factor.
  await db.deleteFrom('dispositivo_confiable').where('usuario_id', '=', fila.usuario_id).execute();
  await db.deleteFrom('otp_login').where('usuario_id', '=', fila.usuario_id).execute();
  await registrarSistema(fila.cuenta_id, fila.usuario_id, { accion: 'password.reset' });
  return { ok: true };
}

// --- Invitar a un usuario nuevo (lo dispara el admin de la empresa) ---------
export interface InvitacionInput {
  nombre: string;
  email: string;
  documento: string;
  rolId?: string;
}

// Genera un token de invitación y manda el correo con el enlace para elegir clave.
// Lo usan tanto la invitación de un usuario nuevo como el "reenviar invitación".
export async function enviarInvitacionPorCorreo(
  cuentaId: string,
  usuarioId: string,
  email: string,
  rolId?: string,
): Promise<void> {
  const { token, hash } = generarToken();
  const db = ownerDb();
  const emp = await db.selectFrom('empresa').select(['nombre']).where('id', '=', cuentaId).executeTakeFirst();
  // Destino del enlace: si el usuario es empleado (su persona tiene relación laboral activa),
  // lo llevamos a su app /mi; si no, a la consola /app. Esto NO depende del rol.
  const empleado = await db
    .selectFrom('usuario as u')
    .innerJoin('relacion_laboral as rl', 'rl.persona_id', 'u.persona_id')
    .select('u.id')
    .where('u.id', '=', usuarioId)
    .where('u.cuenta_id', '=', cuentaId)
    .where('rl.fecha_egreso', 'is', null)
    .executeTakeFirst();
  const destino = empleado ? '/mi' : '/app';
  // Nombre de la persona, para el placeholder {nombre} de la plantilla.
  const per = await db
    .selectFrom('usuario as u')
    .leftJoin('persona as p', 'p.id', 'u.persona_id')
    .select(['p.nombre as nombre'])
    .where('u.id', '=', usuarioId)
    .executeTakeFirst();
  const nombre = (per?.nombre || '').trim();
  // Plantilla del rol con el que se invita; si no se pasó, la del primer rol del usuario.
  let rolUsado = rolId || null;
  if (!rolUsado) {
    const ur = await db
      .selectFrom('usuario_rol')
      .select(['rol_id'])
      .where('usuario_id', '=', usuarioId)
      .where('cuenta_id', '=', cuentaId)
      .executeTakeFirst();
    rolUsado = ur?.rol_id || null;
  }
  const plantilla = rolUsado
    ? await db
        .selectFrom('invitacion_plantilla')
        .select(['asunto', 'cuerpo'])
        .where('cuenta_id', '=', cuentaId)
        .where('rol_id', '=', rolUsado)
        .executeTakeFirst()
    : undefined;
  await db
    .insertInto('token_acceso')
    .values({
      cuenta_id: cuentaId,
      usuario_id: usuarioId,
      tipo: 'invitacion',
      token_hash: hash,
      expira_at: new Date(Date.now() + INVITACION_TTL_DIAS * 86400000),
    })
    .execute();

  const link = enlace(token, 'invitacion', destino);
  const nombreEmp = emp?.nombre || 'MiFirma';
  const urlApp = `${baseUrl()}/mi`;
  // El sistema siempre agrega el botón con el enlace y, si es empleado, las instrucciones de la app.
  const botonHtml =
    `<p style="margin:16px 0"><a href="${link}" style="background:#0a2540;color:#ffffff;padding:11px 18px;border-radius:8px;text-decoration:none;font-weight:600">Elegí tu contraseña</a></p>` +
    `<p style="color:#666;font-size:13px">El enlace vence en ${INVITACION_TTL_DIAS} días.</p>`;
  const pwaHtml = empleado
    ? `<hr style="border:none;border-top:1px solid #e5e5e5;margin:22px 0">` +
      `<p style="font-weight:600;margin:0 0 6px">Tené la app a mano en tu teléfono</p>` +
      `<p style="margin:0 0 8px;color:#333">Una vez que elijas tu contraseña, podés instalarla como app:</p>` +
      `<ul style="margin:0 0 10px;padding-left:18px;color:#333">` +
      `<li style="margin-bottom:4px"><b>iPhone (Safari):</b> tocá el botón Compartir y elegí "Agregar a inicio".</li>` +
      `<li><b>Android (Chrome):</b> tocá el menú de tres puntos y elegí "Instalar app" o "Agregar a pantalla de inicio".</li>` +
      `</ul>` +
      `<p style="color:#666;font-size:13px;margin:0">También podés abrirla desde el navegador en <a href="${urlApp}">${urlApp}</a>.</p>`
    : '';
  const pwaTxt = empleado
    ? `\n\nInstalá la app en tu teléfono:\n- iPhone (Safari): Compartir > Agregar a inicio.\n- Android (Chrome): menú de tres puntos > Instalar app.\nTambién podés usarla en el navegador: ${urlApp}`
    : '';

  let asunto: string, html: string, texto: string;
  if (plantilla) {
    const aplicar = (s: string) => s.replace(/\{empresa\}/g, nombreEmp).replace(/\{nombre\}/g, nombre);
    const escHtml = (s: string) => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
    asunto = aplicar(plantilla.asunto);
    const cuerpoTxt = aplicar(plantilla.cuerpo);
    html = `<p>${escHtml(cuerpoTxt).replace(/\n/g, '<br>')}</p>` + botonHtml + pwaHtml;
    texto = `${cuerpoTxt}\n\nElegí tu contraseña: ${link} (vence en ${INVITACION_TTL_DIAS} días).` + pwaTxt;
  } else if (empleado) {
    asunto = `Tu acceso a ${nombreEmp}`;
    html = `<p>Te crearon tu acceso en <b>${nombreEmp}</b>.</p>` + botonHtml + pwaHtml;
    texto =
      `Te crearon tu acceso en ${nombreEmp}.\n` +
      `Elegí tu contraseña: ${link} (vence en ${INVITACION_TTL_DIAS} días).` +
      pwaTxt;
  } else {
    asunto = `Te invitaron a ${nombreEmp}`;
    html =
      `<p>Te crearon un usuario en <b>${nombreEmp}</b>.</p>` +
      `<p><a href="${link}">Hacé clic acá para elegir tu contraseña</a> (el enlace vence en ${INVITACION_TTL_DIAS} días).</p>`;
    texto = `Elegí tu contraseña: ${link} (vence en ${INVITACION_TTL_DIAS} días).`;
  }
  try {
    await enviarCorreo({ para: email, asunto, html, texto });
  } catch {
    throw new HttpError(503, 'No se pudo enviar la invitación por correo. Revisá la conexión de correo.');
  }
}

export async function invitarUsuario(
  cuentaId: string,
  adminUsuarioId: string,
  datos: InvitacionInput,
): Promise<{ ok: true; usuario_id: string; email: string }> {
  const email = (datos.email || '').trim();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Email inválido.');
  const documento = (datos.documento || '').trim();
  if (!documento) throw new HttpError(400, 'Falta el documento.');

  // Crear persona + usuario (sin contraseña) con la sesión del admin (RLS).
  const nuevo = await withUsuario(cuentaId, adminUsuarioId, async (trx, autz) => {
    if (!puede(autz, 'usuario', 'escribir')) throw new HttpError(403, 'No tenés permiso para invitar usuarios.');
    const yaEmail = await trx
      .selectFrom('usuario')
      .select('id')
      .where('cuenta_id', '=', cuentaId)
      .where('email', '=', email)
      .executeTakeFirst();
    if (yaEmail) throw new HttpError(409, 'Ya existe un usuario con ese email en la empresa.');
    const yaDoc = await trx
      .selectFrom('persona')
      .select('id')
      .where('cuenta_id', '=', cuentaId)
      .where('documento', '=', documento)
      .executeTakeFirst();
    if (yaDoc) throw new HttpError(409, 'Ya existe una persona con ese documento en la empresa.');
    const persona = await trx
      .insertInto('persona')
      .values({ cuenta_id: cuentaId, documento, nombre: datos.nombre, email })
      .returning('id')
      .executeTakeFirstOrThrow();
    const usuario = await trx
      .insertInto('usuario')
      .values({ cuenta_id: cuentaId, persona_id: persona.id, email, activo: true })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (datos.rolId) {
      const rol = await trx.selectFrom('rol').select('id').where('cuenta_id', '=', cuentaId).where('id', '=', datos.rolId).executeTakeFirst();
      if (rol) await trx.insertInto('usuario_rol').values({ cuenta_id: cuentaId, usuario_id: usuario.id, rol_id: datos.rolId }).execute();
    }
    await registrar(trx, cuentaId, adminUsuarioId, { accion: 'usuario.invitar', recurso: 'usuario', objetoId: usuario.id, detalle: { email, rol_id: datos.rolId } });
    return { usuarioId: usuario.id };
  });

  await enviarInvitacionPorCorreo(cuentaId, nuevo.usuarioId, email, datos.rolId);
  return { ok: true, usuario_id: nuevo.usuarioId, email };
}
