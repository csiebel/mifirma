import nodemailer from 'nodemailer';
import { operadorDb } from '../db/pool';
import { HttpError } from '../http/errors';
import { cifrar, descifrar, enmascarar, huellaClave } from '../operador/cripto';

// Conexión de correo saliente de la PLATAFORMA (dominio del operador). Una sola
// casilla envía los recibos por todas las empresas. La contraseña se guarda cifrada
// (AES-256-GCM) y solo se descifra al enviar; nunca se expone por HTTP.
//
// Gmail: host smtp.gmail.com, puerto 465 (SSL). Requiere verificación en dos pasos
// y una "contraseña de aplicación" de 16 caracteres (la contraseña normal no sirve).

// Presets de los proveedores que usamos. `seguridad` toma los valores del CHECK
// de la migración 014 —'tls' | 'starttls' | 'ninguna'—, no los de nodemailer:
// el código venía escribiendo 'ssl', que la base rechaza. Un insert que viola un
// CHECK sale como 500 sin decir qué columna, y el sintoma aparece recien cuando
// alguien intenta entrar y no le llega el codigo.
export const PRESET_GMAIL  = { proveedor: 'gmail',  host: 'smtp.gmail.com',   puerto: 465, seguridad: 'tls' as const };
export const PRESET_ICLOUD = { proveedor: 'icloud', host: 'smtp.mail.me.com', puerto: 587, seguridad: 'starttls' as const };

export interface DatosCorreo {
  proveedor?: string;
  host: string;
  puerto: number;
  seguridad?: 'tls' | 'starttls' | 'ninguna';
  usuario: string;
  remitenteNombre: string;
  remitenteEmail: string;
  password?: string; // vacío en edición = no se cambia
}

async function fila() {
  return operadorDb().selectFrom('correo_config').selectAll().executeTakeFirst();
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
      // Guardada pero ilegible: la clave de cifrado no es la que se usó para
      // guardarla. Distinguirlo de "no hay contraseña" es la diferencia entre
      // buscar el problema en la base o en el entorno.
      password_descifrable: !!c.password_cifrado && !!descifrar(c.password_cifrado),
      huella_clave: huellaClave(),
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
      seguridad: d.seguridad ?? 'tls',
      usuario: d.usuario,
      remitente_nombre: d.remitenteNombre,
      remitente_email: d.remitenteEmail,
    };
    if (d.password) set.password_cifrado = cifrar(d.password);
    await operadorDb().updateTable('correo_config').set(set).where('id', '=', existe.id).execute();
  } else {
    await operadorDb()
      .insertInto('correo_config')
      .values({
        proveedor: d.proveedor ?? 'gmail',
        host: d.host,
        puerto: d.puerto,
        seguridad: d.seguridad ?? 'tls',
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
  await operadorDb().updateTable('correo_config').set({ activa: activo }).where('id', '=', c.id).execute();
  return { ok: true };
}

/** Transporte nodemailer desde la config activa. Uso interno; requiere red. */
async function transporte() {
  const c = await fila();
  if (!c || !c.activa) throw new HttpError(503, 'No hay conexión de correo activa.');
  if (!c.password_cifrado) {
    throw new HttpError(503, 'La conexión de correo no tiene contraseña cargada.');
  }
  const pass = descifrar(c.password_cifrado);
  if (!pass) {
    // Hay contraseña guardada y no se puede leer: cambió la clave de cifrado.
    // Decir "no hay contraseña" acá manda a cargarla de nuevo una y otra vez
    // sin que nada mejore, que es exactamente lo que pasó.
    throw new HttpError(
      503,
      'La contraseña del correo está guardada pero no se puede descifrar: la clave de cifrado ' +
        `del servidor (huella ${huellaClave()}) no es la que se usó para guardarla. ` +
        'Revisá GATEWAY_ENC_KEY en el entorno del servidor y volvé a cargar la contraseña.',
    );
  }
  const t = nodemailer.createTransport({
    host: c.host,
    port: Number(c.puerto),
    secure: c.seguridad === 'tls', // 465 = TLS directo (true); 587 = STARTTLS (false)
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
  /**
   * Etiqueta propia que viaja con el mensaje y que el relay devuelve en sus
   * eventos. Es lo que permitiría atar «este correo se entregó» al documento y
   * al firmante correctos del expediente, que hoy no se puede: los ocho lugares
   * que llaman a esta funcion descartan el identificador que devuelve.
   *
   * Ver `http/routes/correo_webhook.ts`.
   *
   * ⚠ TODAVÍA NO ESTÁ COMPROBADO que Brevo la devuelva cuando el mensaje entra
   * por SMTP RELAY en vez de por su API. Eso es exactamente lo que mide la fase
   * 1 del receptor. Hasta que el log lo confirme, nadie construye nada encima
   * de esta etiqueta.
   */
  etiqueta?: string;
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
      // La cabecera va SÓLO si hay etiqueta: mandarla vacía en todos los correos
      // del producto es una cabecera de más que no distingue nada.
      ...(opts.etiqueta ? { headers: { 'X-Mailin-custom': opts.etiqueta } } : {}),
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
  // Etiqueta única por prueba: es la mitad del experimento de la fase 1.
  // La otra mitad la mira el log del receptor. Que la pantalla la devuelva
  // permite comparar lo que SALIÓ con lo que VOLVIÓ sin adivinar cuál prueba
  // fue: dos pruebas seguidas serían indistinguibles sin esto.
  const etiqueta = `mifirma-prueba-${Date.now().toString(36)}`;
  const enviado = await enviarCorreo({
    etiqueta,
    para,
    asunto: 'Prueba de conexión · MiFirma',
    html: '<p>Este es un correo de prueba de <b>MiFirma</b>.</p><p>Si lo recibiste, la conexión de correo de la plataforma quedó funcionando.</p>',
    texto: 'Correo de prueba de MiFirma. Si lo recibiste, la conexión funciona.',
  });
  return { ok: true, para, etiqueta, id: enviado.id };
}
