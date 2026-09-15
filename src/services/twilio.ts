import { sql } from 'kysely';
import { operadorDb, sinCuenta } from '../db/pool';
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
  return operadorDb().selectFrom('twilio_config').selectAll().executeTakeFirst();
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
    await operadorDb().updateTable('twilio_config').set(set).where('id', '=', existe.id).execute();
  } else {
    await operadorDb()
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
  await operadorDb().updateTable('twilio_config').set({ activa: activo }).where('id', '=', c.id).execute();
  return { ok: true };
}

/** Devuelve la config si está activa y con token; null si no. El dispatcher de OTP
 *  la usa para decidir si puede mandar por SMS/WhatsApp o si tiene que caer a email. */
export async function twilioActivo(): Promise<FilaTwilio | null> {
  const c = await fila();
  if (!c || !c.activa || !c.auth_token_cifrado) return null;
  return c;
}

/**
 * A qué viene el mensaje. **No es decoración: es lo único que distingue tres
 * cosas muy distintas** que salen al mismo teléfono.
 */
export type PropositoSms = 'entrar' | 'confirmar_telefono' | 'prueba';

/**
 * ⚠⚠ POR QUÉ ESTO EXISTE. Hasta el 15/8/2026 los tres mandaban el MISMO texto:
 * «Tu código de acceso a MiFirma es 123456». El código para entrar, el de
 * confirmar un celular y el botón de prueba del operador eran indistinguibles
 * mirando el teléfono.
 *
 * Costó una discusión de cinco mensajes esa misma tarde —había que ir a la base
 * para saber cuál era cuál— y tenía un filo peor: **si alguien recibe un
 * «código de acceso» que no pidió, no puede distinguir un ataque de una prueba.**
 *
 * > Regla: si dos mensajes distintos dicen lo mismo, no se pueden distinguir
 * > cuando importa. Y el momento en que importa es siempre el peor.
 *
 * ⚠ Se cuidan los 160 caracteres: pasarse cuesta el doble por mensaje.
 * ⚠ Salen sólo en castellano, como el resto de los avisos (deuda 56).
 */
function textoSms(proposito: PropositoSms, codigo: string, ttlMin: number): string {
  if (proposito === 'prueba') {
    return `Mensaje de prueba de MiFirma. Si no lo pediste vos, ignoralo: no es un código de acceso.`;
  }
  if (proposito === 'confirmar_telefono') {
    return `Tu código para confirmar este celular en MiFirma es ${codigo}. Vence en ${ttlMin} minutos. Si no lo pediste, ignoralo.`;
  }
  return `Tu código para entrar a MiFirma es ${codigo}. Vence en ${ttlMin} minutos. Si no intentaste entrar, ignoralo.`;
}

/**
 * Lo que Twilio contesta cuando el envío salió: el identificador del mensaje y
 * en cuántos SEGMENTOS lo partió.
 *
 * ⚠⚠ Los segmentos son plata. Twilio cobra POR SEGMENTO, no por mensaje: un
 * texto largo, o uno con tildes y ñ —que fuerzan UCS-2 y bajan el límite de 160
 * a 70 caracteres— sale dos o tres veces más caro. Hasta la 081 esta respuesta
 * se descartaba y no había forma de saber cuánto se estaba gastando.
 */
interface EnviadoPorTwilio {
  sid: string | null;
  segmentos: number;
}

async function enviarMensaje(
  c: FilaTwilio,
  params: Record<string, string>,
): Promise<EnviadoPorTwilio> {
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

  // ⚠ El mensaje YA SALIÓ. Si la respuesta viniera rara, lo que no se puede
  // hacer es tirar: se devuelve un segmento, que es el mínimo que se paga, y
  // sigue. Perder la cuenta de un segmento es barato; tirar después de haber
  // mandado sería cobrarle al usuario un error nuestro.
  try {
    const j = (await r.json()) as { sid?: string; num_segments?: string | number };
    const n = Number(j.num_segments);
    return { sid: j.sid ?? null, segmentos: Number.isFinite(n) && n > 0 ? n : 1 };
  } catch {
    return { sid: null, segmentos: 1 };
  }
}

/**
 * Anota lo que acaba de salir, para que se pueda cobrar y costear.
 *
 * ⚠⚠ NUNCA TIRA. El mensaje ya salió y el código ya viaja: si medir fallara y
 * eso tumbara el envío, el usuario se quedaría sin poder entrar por un problema
 * de facturación. Misma regla que el medidor de firmas.
 *
 * ⚠ `cuentaId` en null NO es un olvido: es el SMS de entrar al producto, que
 * sale antes de que la persona elija empresa. Se mide sin cobrárselo a nadie
 * (decisión de Claudio del 15/9).
 */
async function medirMensaje(
  canal: 'sms' | 'whatsapp',
  cuentaId: string | null,
  telefono: string,
  enviado: EnviadoPorTwilio,
  proposito: PropositoSms,
) {
  try {
    // La clave de idempotencia es el identificador de Twilio: un reintento del
    // mismo envío no se cobra dos veces. Sin sid —respuesta rara— se arma una
    // clave propia, que no se repite y por eso tampoco duplica.
    const clave = enviado.sid
      ? `msg:${enviado.sid}`
      : `msg:sin-sid:${canal}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
    await sinCuenta(
      (trx) =>
        sql`select app.medir_mensaje(
          ${canal}::text,
          ${cuentaId}::uuid,
          ${enviado.segmentos}::int,
          ${telefono}::text,
          ${clave}::text,
          ${proposito}::text)`.execute(trx),
    );
  } catch (e) {
    console.error('medirMensaje:', (e as Error).message);
  }
}

/** Manda el código por SMS. Requiere from_sms. */
async function enviarSms(
  c: FilaTwilio,
  telefono: string,
  codigo: string,
  ttlMin: number,
  proposito: PropositoSms,
): Promise<EnviadoPorTwilio> {
  if (!c.from_sms) throw new HttpError(503, 'No hay número de SMS configurado en Twilio.');
  return enviarMensaje(c, { To: telefono, From: c.from_sms, Body: textoSms(proposito, codigo, ttlMin) });
}

/** Manda el código por WhatsApp. Usa la plantilla aprobada (Content SID) si está
 *  configurada; si no, manda texto plano (solo válido en sandbox o ventana de 24h). */
async function enviarWhatsapp(
  c: FilaTwilio,
  telefono: string,
  codigo: string,
  ttlMin: number,
  proposito: PropositoSms,
): Promise<EnviadoPorTwilio> {
  if (!c.from_whatsapp) throw new HttpError(503, 'No hay remitente de WhatsApp configurado en Twilio.');
  const to = telefono.startsWith('whatsapp:') ? telefono : `whatsapp:${telefono}`;
  const from = c.from_whatsapp.startsWith('whatsapp:') ? c.from_whatsapp : `whatsapp:${c.from_whatsapp}`;
  if (c.wa_content_sid) {
    // ⚠ Con plantilla aprobada, el texto lo define Meta y acá sólo viaja el
    // código: el propósito NO puede cambiarlo. Una plantilla de «authentication»
    // habla de iniciar sesión, así que para confirmar un celular el texto va a
    // quedar impreciso hasta que haya una plantilla propia para eso.
    return enviarMensaje(c, {
      To: to,
      From: from,
      ContentSid: c.wa_content_sid,
      ContentVariables: JSON.stringify({ '1': codigo }),
    });
  }
  return enviarMensaje(c, { To: to, From: from, Body: textoSms(proposito, codigo, ttlMin) });
}

/** Dispatcher: manda el código por el canal pedido. Lanza HttpError si falla. */
export async function enviarOtpPorTwilio(
  canal: 'sms' | 'whatsapp',
  telefono: string,
  codigo: string,
  ttlMin: number,
  // ⚠ Sin valor por omisión A PROPÓSITO: quien manda un código tiene que decir
  // a qué viene. Un default sería volver al problema de que todos digan lo mismo.
  proposito: PropositoSms,
  // ⚠ Sin valor por omisión A PROPÓSITO, igual que `proposito`: quien manda un
  // mensaje tiene que decir a quién se le cobra, o decir expresamente que a
  // nadie. Un default en null convertiría todo en costo nuestro por descuido.
  cuentaId: string | null,
) {
  const c = await twilioActivo();
  if (!c) throw new HttpError(503, 'No hay conexión de Twilio activa.');
  const enviado =
    canal === 'whatsapp'
      ? await enviarWhatsapp(c, telefono, codigo, ttlMin, proposito)
      : await enviarSms(c, telefono, codigo, ttlMin, proposito);
  await medirMensaje(canal, cuentaId, telefono, enviado, proposito);
}

/** Envío de prueba desde la consola del operador, con un código de ejemplo. */
export async function enviarPruebaTwilio(canal: 'sms' | 'whatsapp', telefono: string) {
  const limpio = telefono.replace(/[\s-]/g, '');
  if (!/^\+?[0-9]{6,15}$/.test(limpio)) {
    throw new HttpError(400, 'Indicá un teléfono válido en formato internacional (ej. +59899123456).');
  }
  const c = await twilioActivo();
  if (!c) throw new HttpError(503, 'Activá la conexión de Twilio antes de probar.');
  // El código sólo se usa si hay plantilla de WhatsApp (que exige una variable);
  // en SMS el texto de prueba no lleva ningún código, para que no se confunda
  // con uno real.
  const codigo = '123456';
  const enviado =
    canal === 'whatsapp'
      ? await enviarWhatsapp(c, limpio, codigo, 10, 'prueba')
      : await enviarSms(c, limpio, codigo, 10, 'prueba');
  // ⚠ La prueba del operador no es de ningún cliente, pero Twilio la cobra
  // igual: se mide sin dueño, como el SMS de entrar.
  await medirMensaje(canal, null, limpio, enviado, 'prueba');
  return { ok: true, canal, telefono: limpio, segmentos: enviado.segmentos };
}
