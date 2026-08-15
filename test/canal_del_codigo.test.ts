import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canalTelefono } from '../src/services/canal_otp';

/**
 * Por dónde sale el código de acceso, cuando la persona eligió (migración 061).
 *
 * ⚠⚠ Por qué existe. Hasta el 15/8 esta decisión decía, textual:
 *
 *     if (c.from_sms) return 'sms';
 *     if (c.from_whatsapp) return 'whatsapp';
 *
 * O sea: con SMS y WhatsApp conectados los dos, **siempre SMS**. La pantalla de
 * entrada preguntaba «¿por dónde querés el código?» en tres idiomas, la persona
 * apretaba «Por WhatsApp»… y le llegaba un SMS. **La elección se pedía y se
 * ignoraba**, sin error, sin log y sin que nadie pudiera notarlo salvo mirando
 * a qué aplicación le llegó el mensaje.
 *
 * Y desde la 061 la elección además se guarda (`credencial.otp_canal`), así que
 * el mismo defecto se habría hecho permanente: elegir WhatsApp una vez para
 * recibir SMS siempre.
 *
 * El camino completo —que el mensaje SALGA de verdad— no se puede probar acá:
 * necesita Twilio conectado y el teléfono de una persona. Esto prueba la
 * DECISIÓN, que es donde estaba el defecto.
 */

const LOS_DOS = { from_sms: '+18312759901', from_whatsapp: 'whatsapp:+14155238886' };
const SOLO_SMS = { from_sms: '+18312759901', from_whatsapp: null };
const SOLO_WA = { from_sms: null, from_whatsapp: 'whatsapp:+14155238886' };
const TEL = '+59899662634';

test('lo elegido manda: WhatsApp elegido no termina en SMS', () => {
  // ⚠ ÉSTE es el test que falla contra el código viejo.
  assert.equal(canalTelefono(TEL, LOS_DOS, 'whatsapp'), 'whatsapp');
});

test('lo elegido manda: SMS elegido sale por SMS', () => {
  assert.equal(canalTelefono(TEL, LOS_DOS, 'sms'), 'sms');
});

test('el canal elegido no está conectado: sale por correo, NO por el otro', () => {
  // null = «no hay canal de teléfono», y quien llama cae al correo. Es la
  // decisión del 15/8: «casi lo que pediste» no es mejor que el respaldo.
  assert.equal(canalTelefono(TEL, SOLO_SMS, 'whatsapp'), null);
  assert.equal(canalTelefono(TEL, SOLO_WA, 'sms'), null);
});

test('sin preferencia, se mantiene lo de siempre: SMS primero', () => {
  assert.equal(canalTelefono(TEL, LOS_DOS), 'sms');
  assert.equal(canalTelefono(TEL, SOLO_WA), 'whatsapp');
});

test('sin teléfono confirmado no hay canal de teléfono, aunque haya elegido uno', () => {
  // ⚠⚠ La promesa de la 061: un teléfono que la persona no confirmó no llega
  // hasta acá. Si esto devolviera un canal con el teléfono vacío, un número
  // propuesto por el administrador podría convertirse en un destino.
  assert.equal(canalTelefono('', LOS_DOS, 'sms'), null);
  assert.equal(canalTelefono('   '.trim(), LOS_DOS, 'whatsapp'), null);
});

test('sin Twilio conectado, nunca hay canal de teléfono', () => {
  assert.equal(canalTelefono(TEL, null, 'whatsapp'), null);
  assert.equal(canalTelefono(TEL, null), null);
});

test('una configuración vacía tampoco alcanza', () => {
  assert.equal(canalTelefono(TEL, { from_sms: null, from_whatsapp: null }), null);
  assert.equal(canalTelefono(TEL, { from_sms: null, from_whatsapp: null }, 'sms'), null);
});
