import { ownerDb } from '../db/owner';
import { HttpError } from '../http/errors';
import { cifrar, descifrar, enmascarar } from '../operador/cripto';

// Entrega del código OTP por SMS o WhatsApp vía Twilio. Twilio se usa como
// TRANSPORTE: el código lo genera y valida nuestro motor de OTP (otp_login); acá
// solo lo mandamos. Conexión de PLATAFORMA (cuenta del operador), espejando
// correo.ts: una sola cuenta envía por todas las empresas. El Auth Token se guarda
// cifrado (AES-256-GCM) y solo se descifra al momento de enviar; nunca se expone
// por HTTP. Corre en el servidor del usuario (necesita salida a internet).
//
// Para WhatsApp, los mensajes iniciados por la empresa (como un OTP) requieren una
// plantilla aprobada: se configura su Content SID en wa_content_sid. Sin plantilla,
// el envío de WhatsApp solo funciona dentro de la ventana de sesión / el sandbox.

const TWILIO_API = 'https://api.twilio.com/2010-04-01';

export interface DatosTwilio {
  accountSid: string;
  fromSms?: string;
  fromWhatsapp?: string;
  waContentSid?: string;
  authToken?: string; // vacío en edición = no se cambia
}

interface FilaTwilio {
  account_sid: string;
  auth_token_cifrado: string | null;
  from_sms: string | null;
  from_whatsapp: string | null;
  wa_content_sid: string | null;
}

async function fila() {
  return ownerDb().selectFrom('twilio_config').selectAll().executeTakeFirst();
}

/** Config actual con el token enmascarado (nunca en claro). null si no hay. */
export async function verTwilio() {
  const c = await fila();
  if (!c) return { config: null as null };
  return {
    config: {
      account_sid: c.account_sid,
      from_sms: c.from_sms || '',
      from_whatsapp: c.from_whatsapp || '',
      wa_content_sid: c.wa_content_sid || '',
      token_mask: enmascarar(c.auth_token_cifrado),
      tiene_token: !!c.auth_token_cifrado,
      activo: c.activa,
    },
  };
}

/** Crea o actualiza la conexión (singleton). El token vacío no se toca. */
export async function guardarTwilio(d: DatosTwilio) {
  if (!d.accountSid) throw new HttpError(400, 'Falta el Account SID de Twilio.');
  if (!d.fromSms && !d.fromWhatsapp) {
    throw new HttpError(400, 'Indicá al menos un remitente: número de SMS o de WhatsApp.');
  }
  const existe = await fila();
  if (existe) {
    const set: Record<string, unknown> = {
      account_sid: d.accountSid,
      from_sms: d.fromSms || null,
      from_whatsapp: d.fromWhatsapp || null,
      wa_content_sid: d.waContentSid || null,
    };
    if (d.authToken) set.auth_token_cifrado = cifrar(d.authToken);
    await ownerDb().updateTable('twilio_config').set(set).where('id', '=', existe.id).execute();
  } else {
    await ownerDb()
      .insertInto('twilio_config')
      .values({
        account_sid: d.accountSid,
        from_sms: d.fromSms || null,
        from_whatsapp: d.fromWhatsapp || null,
        wa_content_sid: d.waContentSid || null,
        auth_token_cifrado: d.authToken ? cifrar(d.authToken) : null,
        activa: false,
      })
      .execute();
  }
  return { ok: true };
}

/** Activa o desactiva. Para activar exige token + al menos un remitente. */
export async function setTwilioActivo(activo: boolean) {
  const c = await fila();
  if (!c) throw new HttpError(404, 'No hay conexión de Twilio configurada.');
  if (activo) {
    if (!c.auth_token_cifrado) throw new HttpError(400, 'No se puede activar: falta el Auth Token.');
    if (!c.from_sms && !c.from_whatsapp) {
      throw new HttpError(400, 'No se puede activar: falta un remitente (número de SMS o de WhatsApp).');
    }
  }
  await ownerDb().updateTable('twilio_config').set({ activa: activo }).where('id', '=', c.id).execute();
  return { ok: true };
}

/** Devuelve la config si está activa y con token; null si no. El dispatcher de OTP
 *  la usa para decidir si puede mandar por SMS/WhatsApp o si tiene que caer a email. */
export async function twilioActivo(): Promise<FilaTwilio | null> {
  const c = await fila();
  if (!c || !c.activa || !c.auth_token_cifrado) return null;
  return c;
}

function textoOtp(codigo: string, ttlMin: number): string {
  return `Tu código de acceso a MiFirma es ${codigo}. Vence en ${ttlMin} minutos.`;
}

async function enviarMensaje(c: FilaTwilio, params: Record<string, string>) {
  const token = descifrar(c.auth_token_cifrado);
  if (!token) throw new HttpError(503, 'La conexión de Twilio no tiene Auth Token.');
  const url = `${TWILIO_API}/Accounts/${encodeURIComponent(c.account_sid)}/Messages.json`;
  const auth = Buffer.from(`${c.account_sid}:${token}`).toString('base64');
  let r: Awaited<ReturnType<typeof fetch>>;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error de red';
    throw new HttpError(502, 'No se pudo contactar a Twilio: ' + msg);
  }
  if (!r.ok) {
    let detalle = '';
    try {
      const j = (await r.json()) as { message?: string; code?: number; more_info?: string };
      const partes: string[] = [];
      if (j.code) partes.push('[' + j.code + ']');
      if (j.message) partes.push(j.message);
      if (j.more_info) partes.push('(' + j.more_info + ')');
      detalle = partes.join(' ');
    } catch {
      /* sin cuerpo JSON */
    }
    throw new HttpError(502, 'Twilio rechazó el envío' + (detalle ? ': ' + detalle : ` (HTTP ${r.status}).`));
  }
}

/** Manda el código por SMS. Requiere from_sms. */
async function enviarSms(c: FilaTwilio, telefono: string, codigo: string, ttlMin: number) {
  if (!c.from_sms) throw new HttpError(503, 'No hay número de SMS configurado en Twilio.');
  await enviarMensaje(c, { To: telefono, From: c.from_sms, Body: textoOtp(codigo, ttlMin) });
}

/** Manda el código por WhatsApp. Usa la plantilla aprobada (Content SID) si está
 *  configurada; si no, manda texto plano (solo válido en sandbox o ventana de 24h). */
async function enviarWhatsapp(c: FilaTwilio, telefono: string, codigo: string, ttlMin: number) {
  if (!c.from_whatsapp) throw new HttpError(503, 'No hay remitente de WhatsApp configurado en Twilio.');
  const to = telefono.startsWith('whatsapp:') ? telefono : `whatsapp:${telefono}`;
  const from = c.from_whatsapp.startsWith('whatsapp:') ? c.from_whatsapp : `whatsapp:${c.from_whatsapp}`;
  if (c.wa_content_sid) {
    await enviarMensaje(c, {
      To: to,
      From: from,
      ContentSid: c.wa_content_sid,
      ContentVariables: JSON.stringify({ '1': codigo }),
    });
  } else {
    await enviarMensaje(c, { To: to, From: from, Body: textoOtp(codigo, ttlMin) });
  }
}

/** Dispatcher: manda el código por el canal pedido. Lanza HttpError si falla. */
export async function enviarOtpPorTwilio(
  canal: 'sms' | 'whatsapp',
  telefono: string,
  codigo: string,
  ttlMin: number,
) {
  const c = await twilioActivo();
  if (!c) throw new HttpError(503, 'No hay conexión de Twilio activa.');
  if (canal === 'whatsapp') await enviarWhatsapp(c, telefono, codigo, ttlMin);
  else await enviarSms(c, telefono, codigo, ttlMin);
}

/** Envío de prueba desde la consola del operador, con un código de ejemplo. */
export async function enviarPruebaTwilio(canal: 'sms' | 'whatsapp', telefono: string) {
  const limpio = telefono.replace(/[\s-]/g, '');
  if (!/^\+?[0-9]{6,15}$/.test(limpio)) {
    throw new HttpError(400, 'Indicá un teléfono válido en formato internacional (ej. +59899123456).');
  }
  const c = await twilioActivo();
  if (!c) throw new HttpError(503, 'Activá la conexión de Twilio antes de probar.');
  const codigo = '123456';
  if (canal === 'whatsapp') await enviarWhatsapp(c, limpio, codigo, 10);
  else await enviarSms(c, limpio, codigo, 10);
  return { ok: true, canal, telefono: limpio };
}
