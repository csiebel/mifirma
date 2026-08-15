/**
 * Por dónde sale el código de acceso.
 *
 * Vive en su propio archivo —y no adentro de `auth_login.ts`— por una razón:
 * es la única parte del login que se puede probar sin base, sin Twilio y sin la
 * contraseña de nadie. Metida en el login, no se podía probar nada.
 *
 * ⚠ Es una función PURA: decide, no manda. Lo que manda está en `auth_login.ts`
 * y en `twilio.ts`.
 */

/**
 * @param tel       El teléfono CONFIRMADO de la persona (`credencial.telefono_e164`).
 *                  Un teléfono propuesto por el administrador NO llega hasta acá:
 *                  la 061 y la 062 se ocupan de eso.
 * @param c         La configuración de Twilio, o null si no está conectada.
 * @param preferido El canal que la persona eligió (`credencial.otp_canal`), o el
 *                  que apretó en la pantalla. `undefined` = no eligió.
 */
export function canalTelefono(
  tel: string,
  c: { from_sms: string | null; from_whatsapp: string | null } | null,
  preferido?: 'sms' | 'whatsapp' | null,
): 'sms' | 'whatsapp' | null {
  if (!tel || !c) return null;

  // ⚠⚠ Lo elegido manda, y si ese canal no está conectado NO se sustituye por
  // el otro: devuelve null y el que llama cae al correo. Antes esta función
  // devolvía SMS siempre que hubiera SMS, así que **elegir WhatsApp no cambiaba
  // nada** — la elección se pedía en la pantalla y se ignoraba acá.
  //
  // Por qué no sustituir: quien eligió WhatsApp puede tener un motivo para no
  // querer un SMS —un teléfono de otro país, un plan sin mensajes—, y el correo
  // es el respaldo que siempre llega. «Casi lo que pediste» no es mejor que el
  // respaldo declarado.
  if (preferido === 'whatsapp') return c.from_whatsapp ? 'whatsapp' : null;
  if (preferido === 'sms') return c.from_sms ? 'sms' : null;

  // Sin preferencia: el que haya, SMS primero.
  if (c.from_sms) return 'sms';
  if (c.from_whatsapp) return 'whatsapp';
  return null;
}
