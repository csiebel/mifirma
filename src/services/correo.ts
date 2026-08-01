import nodemailer from 'nodemailer';
import { ownerDb } from '../db/owner';
import { HttpError } from '../http/errors';
import { cifrar, descifrar, enmascarar } from '../operador/cripto';

// Conexión de correo saliente de la PLATAFORMA (dominio del operador). Una sola
// casilla envía los recibos por todas las empresas. La contraseña se guarda cifrada
// (AES-256-GCM) y solo se descifra al enviar; nunca se expone por HTTP.
//
// Gmail: host smtp.gmail.com, puerto 465 (SSL). Requiere verificación en dos pasos
// y una "contraseña de aplicación" de 16 caracteres (la contraseña normal no sirve).

export const PRESET_GMAIL = { proveedor: 'gmail', host: 'smtp.gmail.com', puerto: 465, seguridad: 'ssl' as const };

export interface DatosCorreo {
  proveedor?: string;
  host: string;
  puerto: number;
  seguridad?: 'ssl' | 'starttls';
  usuario: string;
  remitenteNombre: string;
  remitenteEmail: string;
  password?: string; // vacío en edición = no se cambia
}

async function fila() {
  return ownerDb().selectFrom('correo_config').selectAll().executeTakeFirst();
}

/** Config actual con la contraseña enmascarada (nunca en claro). null si no hay. */
export async function verCorreo() {
  const c = await fila();
  if (!c) return { config: null as null };
  return {
    config: {
      proveedor: c.proveedor,
      host: c.host,
      puerto: c.puerto,
      seguridad: c.seguridad,
      usuario: c.usuario,
      remitente_nombre: c.remitente_nombre,
      remitente_email: c.remitente_email,
      password_mask: enmascarar(c.password_cifrado),
      tiene_password: !!c.password_cifrado,
      activo: c.activa,
    },
  };
}

/** Crea o actualiza la conexión (singleton). La contraseña vacía no se toca. */
export async function guardarCorreo(d: DatosCorreo) {
  if (!d.host || !d.usuario || !d.remitenteEmail) {
    throw new HttpError(400, 'Faltan datos: host, usuario y remitente.');
  }
  const existe = await fila();
  if (existe) {
    const set: Record<string, unknown> = {
      proveedor: d.proveedor ?? existe.proveedor,
      host: d.host,
      puerto: d.puerto,
      seguridad: d.seguridad ?? 'ssl',
      usuario: d.usuario,
      remitente_nombre: d.remitenteNombre,
      remitente_email: d.remitenteEmail,
    };
    if (d.password) set.password_cifrado = cifrar(d.password);
    await ownerDb().updateTable('correo_config').set(set).where('id', '=', existe.id).execute();
  } else {
    await ownerDb()
      .insertInto('correo_config')
      .values({
        proveedor: d.proveedor ?? 'gmail',
        host: d.host,
        puerto: d.puerto,
        seguridad: d.seguridad ?? 'ssl',
        usuario: d.usuario,
        remitente_nombre: d.remitenteNombre,
        remitente_email: d.remitenteEmail,
        password_cifrado: d.password ? cifrar(d.password) : null,
        activa: false,
      })
      .execute();
  }
  return { ok: true };
}

/** Activa o desactiva la conexión. Para activar exige contraseña cargada. */
export async function setCorreoActivo(activo: boolean) {
  const c = await fila();
  if (!c) throw new HttpError(404, 'No hay conexión de correo configurada.');
  if (activo && !c.password_cifrado) {
    throw new HttpError(400, 'No se puede activar: falta la contraseña (App Password).');
  }
  await ownerDb().updateTable('correo_config').set({ activa: activo }).where('id', '=', c.id).execute();
  return { ok: true };
}

/** Transporte nodemailer desde la config activa. Uso interno; requiere red. */
async function transporte() {
  const c = await fila();
  if (!c || !c.activa) throw new HttpError(503, 'No hay conexión de correo activa.');
  const pass = descifrar(c.password_cifrado);
  if (!pass) throw new HttpError(503, 'La conexión de correo no tiene contraseña cargada.');
  const t = nodemailer.createTransport({
    host: c.host,
    port: Number(c.puerto),
    secure: c.seguridad === 'ssl', // 465 = SSL (true); 587 = STARTTLS (false)
    auth: { user: c.usuario, pass },
  });
  return { t, from: `"${c.remitente_nombre}" <${c.remitente_email}>` };
}

/** Envía un correo. Corre en el servidor del usuario (necesita salida a internet). */
export async function enviarCorreo(opts: {
  para: string;
  asunto: string;
  html: string;
  texto?: string;
  adjuntos?: { filename: string; content: Buffer; contentType?: string }[];
}) {
  const { t, from } = await transporte();
  try {
    const info = await t.sendMail({
      from,
      to: opts.para,
      subject: opts.asunto,
      html: opts.html,
      text: opts.texto,
      attachments: opts.adjuntos,
    });
    return { ok: true, id: info.messageId };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error de SMTP';
    throw new HttpError(502, 'No se pudo enviar el correo: ' + msg);
  }
}

/** Correo de prueba para validar la conexión. */
export async function enviarPrueba(para: string) {
  if (!para || !/.+@.+\..+/.test(para)) throw new HttpError(400, 'Indicá un email de destino válido.');
  await enviarCorreo({
    para,
    asunto: 'Prueba de conexión · MiFirma',
    html: '<p>Este es un correo de prueba de <b>MiFirma</b>.</p><p>Si lo recibiste, la conexión de correo de la plataforma quedó funcionando.</p>',
    texto: 'Correo de prueba de MiFirma. Si lo recibiste, la conexión funciona.',
  });
  return { ok: true, para };
}
