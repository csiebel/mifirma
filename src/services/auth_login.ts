import { randomInt } from 'node:crypto';
import { ownerDb } from '../db/owner';
import { emitirTokenDev, firmarDesafioOtp, verificarDesafioOtp, firmarDesafioEleccionEmpresa, verificarDesafioEleccionEmpresa } from '../auth/identity';
import { hashPassword, verifyPassword } from '../auth/password';
import { enviarCorreo } from './correo';
import { enviarOtpPorTwilio, twilioActivo } from './twilio';
import { registrarSistema } from './auditoria';
import { HttpError } from '../http/errors';

// Login de dos pasos por equipo.
//   Paso 1 (loginConPassword): valida la contraseña. Si el equipo ya es de
//   confianza, devuelve la sesión. Si es un equipo nuevo, genera un OTP, lo manda
//   por correo y devuelve un "desafío" firmado (sin sesión).
//   Paso 2 (verificarOtp): valida el código, marca el equipo como confiable y
//   recién ahí emite la sesión.
// Todo corre antes de que haya contexto de tenant => conexión privilegiada (ownerDb).
// Los códigos se guardan hasheados (scrypt). La contraseña en claro nunca se guarda.

const OTP_TTL_MIN = 10;
const OTP_MAX_INTENTOS = 5;
// Anti-abuso: tope de códigos generados por usuario dentro de la ventana.
const VENTANA_ANTIABUSO_MS = 60 * 60 * 1000;
const OTP_MAX_POR_VENTANA = 8;
const CONFIANZA_DIAS = 90;

export interface SesionLogin {
  tipo: 'sesion';
  token: string;
  cuenta_id: string;
  usuario_id: string;
  empresa_nombre: string;
  usuario_email: string;
}
export interface DesafioLogin {
  tipo: 'otp';
  challenge: string;
  canal: string; // 'email' | 'sms' | 'whatsapp' — canal por el que se mandó el código
  destino_masked: string; // email o teléfono enmascarado, según el canal
  email_masked: string; // compatibilidad (siempre el email del usuario, enmascarado)
}
export interface EleccionLogin {
  tipo: 'otp_elegir';
  challenge: string;
  email_masked: string; // email del usuario, enmascarado
  tel_masked: string; // teléfono del usuario, enmascarado
  canal_tel: 'sms' | 'whatsapp'; // canal real que se usará si elige teléfono
  canal_pref: string; // preferencia del perfil (para resaltar la opción por defecto)
}
export interface EleccionEmpresaLogin {
  tipo: 'elegir_empresa';
  desafio: string;
  opciones: { cuenta_id: string; empresa_nombre: string }[];
}
export type ResultadoLogin = SesionLogin | DesafioLogin | EleccionLogin | EleccionEmpresaLogin;

const INVALIDO = () => new HttpError(401, 'Empresa, usuario o contraseña inválidos.');

function enmascararEmail(email: string): string {
  const i = email.indexOf('@');
  if (i <= 0) return '***';
  const local = email.slice(0, i);
  const dominio = email.slice(i + 1);
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(2, local.length - 1))}@${dominio}`;
}

function enmascararTel(tel: string): string {
  const d = tel.replace(/[^0-9]/g, '');
  if (d.length <= 3) return '••••';
  return '•••• ' + d.slice(-3);
}

// Resuelve el canal de teléfono usable (sms/whatsapp) según la preferencia del
// usuario y lo que esté configurado en Twilio. Null = no hay teléfono o Twilio no sirve.
function canalTelefono(
  canalPref: string | null,
  tel: string,
  c: { from_sms: string | null; from_whatsapp: string | null } | null,
): 'sms' | 'whatsapp' | null {
  if (!tel || !c) return null;
  if (canalPref === 'whatsapp' && c.from_whatsapp) return 'whatsapp';
  if (c.from_sms) return 'sms';
  if (c.from_whatsapp) return 'whatsapp';
  return null;
}

function etiquetaEquipo(userAgent?: string): string | null {
  if (!userAgent) return null;
  return userAgent.slice(0, 200);
}

async function esDispositivoConfiable(cuentaId: string, usuarioId: string, deviceId: string): Promise<boolean> {
  if (!deviceId) return false;
  const ahora = new Date();
  const row = await ownerDb()
    .selectFrom('dispositivo_confiable')
    .select('id')
    .where('cuenta_id', '=', cuentaId)
    .where('usuario_id', '=', usuarioId)
    .where('device_id', '=', deviceId)
    .where('expira_at', '>', ahora)
    .executeTakeFirst();
  if (!row) return false;
  // Confianza deslizante: cada uso renueva la vigencia y la marca de uso.
  await ownerDb()
    .updateTable('dispositivo_confiable')
    .set({ ultimo_uso: ahora, expira_at: new Date(Date.now() + CONFIANZA_DIAS * 86400000) })
    .where('id', '=', row.id)
    .execute();
  return true;
}

export async function confiarDispositivo(
  cuentaId: string,
  usuarioId: string,
  deviceId: string,
  userAgent?: string,
): Promise<void> {
  if (!deviceId) return;
  const ahora = new Date();
  const expira = new Date(Date.now() + CONFIANZA_DIAS * 86400000);
  await ownerDb()
    .insertInto('dispositivo_confiable')
    .values({
      cuenta_id: cuentaId,
      usuario_id: usuarioId,
      device_id: deviceId,
      etiqueta: etiquetaEquipo(userAgent),
      confiado_at: ahora,
      ultimo_uso: ahora,
      expira_at: expira,
    })
    .onConflict((oc) =>
      oc.columns(['cuenta_id', 'usuario_id', 'device_id']).doUpdateSet({
        ultimo_uso: ahora,
        expira_at: expira,
        etiqueta: etiquetaEquipo(userAgent),
      }),
    )
    .execute();
}

interface DestinoOtp {
  email: string;
  telefono: string | null;
  canal_otp: string | null;
}

async function enviarOtpPorCorreo(emailDestino: string, codigo: string, empresaNombre: string) {
  await enviarCorreo({
    para: emailDestino,
    asunto: `Tu código de acceso · ${empresaNombre || 'MiFirma'}`,
    html:
      `<p>Tu código de acceso es:</p>` +
      `<p style="font-size:28px;font-weight:bold;letter-spacing:4px">${codigo}</p>` +
      `<p>Vence en ${OTP_TTL_MIN} minutos. Si no intentaste iniciar sesión, ignorá este correo.</p>`,
    texto: `Tu código de acceso es ${codigo}. Vence en ${OTP_TTL_MIN} minutos.`,
  });
}

async function crearYEnviarOtp(
  cuentaId: string,
  usuarioId: string,
  deviceId: string,
  usuario: DestinoOtp,
  empresaNombre: string,
  canalForzado?: 'email' | 'sms' | 'whatsapp',
  ip?: string | null,
  userAgent?: string | null,
): Promise<{ canal: string; destinoMasked: string }> {
  // Anti-abuso: límite de códigos por usuario y ventana, para no permitir floods.
  const recientes = await ownerDb()
    .selectFrom('otp_login')
    .select('id')
    .where('cuenta_id', '=', cuentaId)
    .where('usuario_id', '=', usuarioId)
    .where('created_at', '>', new Date(Date.now() - VENTANA_ANTIABUSO_MS))
    .execute();
  if (recientes.length >= OTP_MAX_POR_VENTANA) {
    await registrarSistema(cuentaId, usuarioId, { accion: 'otp.fallido', detalle: { motivo: 'limite_excedido', canal: canalForzado ?? 'auto' }, ip, userAgent });
    throw new HttpError(429, 'Pediste demasiados códigos. Esperá un rato antes de volver a intentar.');
  }

  // Invalida los OTP anteriores no usados de este equipo y crea uno nuevo.
  await ownerDb()
    .updateTable('otp_login')
    .set({ usado: true })
    .where('cuenta_id', '=', cuentaId)
    .where('usuario_id', '=', usuarioId)
    .where('device_id', '=', deviceId)
    .where('usado', '=', false)
    .execute();

  // Canal a usar: si el usuario eligió SMS/WhatsApp, tiene teléfono y Twilio está
  // activo, se manda por ahí; si no, cae a email (nunca deja a nadie afuera).
  const tel = (usuario.telefono || '').trim();
  let canal = 'email';
  if (canalForzado) {
    // El usuario eligió el canal explícitamente en el login.
    canal = canalForzado;
    if ((canal === 'sms' || canal === 'whatsapp') && !tel) canal = 'email';
  } else if ((usuario.canal_otp === 'sms' || usuario.canal_otp === 'whatsapp') && tel && (await twilioActivo())) {
    canal = usuario.canal_otp;
  }

  const codigo = String(randomInt(0, 1000000)).padStart(6, '0');
  await ownerDb()
    .insertInto('otp_login')
    .values({
      cuenta_id: cuentaId,
      usuario_id: usuarioId,
      device_id: deviceId,
      codigo_hash: hashPassword(codigo),
      expira_at: new Date(Date.now() + OTP_TTL_MIN * 60000),
      canal,
    })
    .execute();

  try {
    if (canal === 'sms' || canal === 'whatsapp') {
      await enviarOtpPorTwilio(canal, tel, codigo, OTP_TTL_MIN);
    } else {
      await enviarOtpPorCorreo(usuario.email, codigo, empresaNombre);
    }
  } catch {
    // Si falló SMS/WhatsApp, intentamos el correo como respaldo antes de rendirnos.
    if (canal !== 'email') {
      try {
        await enviarOtpPorCorreo(usuario.email, codigo, empresaNombre);
        canal = 'email';
        await ownerDb()
          .updateTable('otp_login')
          .set({ canal: 'email' })
          .where('cuenta_id', '=', cuentaId)
          .where('usuario_id', '=', usuarioId)
          .where('device_id', '=', deviceId)
          .where('usado', '=', false)
          .execute();
      } catch {
        await registrarSistema(cuentaId, usuarioId, { accion: 'otp.fallido', detalle: { motivo: 'envio_fallido', canal: 'sms+email' }, ip, userAgent });
        throw new HttpError(
          503,
          'No pudimos enviarte el código (ni por SMS/WhatsApp ni por correo). Avisale al administrador de la plataforma.',
        );
      }
    } else {
      await registrarSistema(cuentaId, usuarioId, { accion: 'otp.fallido', detalle: { motivo: 'correo_no_disponible', canal: 'email' }, ip, userAgent });
      throw new HttpError(
        503,
        'No pudimos enviarte el código por correo. Avisale al administrador de la plataforma (falta configurar el correo).',
      );
    }
  }

  const destinoMasked = canal === 'email' ? enmascararEmail(usuario.email) : enmascararTel(tel);
  await registrarSistema(cuentaId, usuarioId, { accion: 'otp.enviado', detalle: { canal, destino: destinoMasked }, ip, userAgent });
  return { canal, destinoMasked };
}

// Lógica común post-contraseña: equipo conocido => sesión directa; equipo nuevo => OTP
// (elegir canal si hay teléfono usable, o enviar por correo). Se usa tanto cuando el
// email está en una sola empresa como cuando el usuario ya eligió empresa.
async function continuarLogin(
  emp: { id: string; nombre: string },
  usr: { id: string; email: string; telefono: string | null; canal_otp: string | null },
  deviceId: string,
  userAgent?: string,
  ip?: string,
): Promise<ResultadoLogin> {
  if (await esDispositivoConfiable(emp.id, usr.id, deviceId)) {
    const token = await emitirTokenDev(emp.id, usr.id);
    return {
      tipo: 'sesion',
      token,
      cuenta_id: emp.id,
      usuario_id: usr.id,
      empresa_nombre: emp.nombre,
      usuario_email: usr.email,
    };
  }

  const challenge = await firmarDesafioOtp(emp.id, usr.id, deviceId);
  const telLogin = (usr.telefono || '').trim();
  const cTwilio = telLogin ? await twilioActivo() : null;
  const canalTel = canalTelefono(usr.canal_otp, telLogin, cTwilio);

  if (canalTel) {
    return {
      tipo: 'otp_elegir',
      challenge,
      email_masked: enmascararEmail(usr.email),
      tel_masked: enmascararTel(telLogin),
      canal_tel: canalTel,
      canal_pref: usr.canal_otp ?? '',
    };
  }

  const { canal, destinoMasked } = await crearYEnviarOtp(
    emp.id,
    usr.id,
    deviceId,
    { email: usr.email, telefono: usr.telefono, canal_otp: usr.canal_otp },
    emp.nombre,
    undefined,
    ip,
    userAgent,
  );
  return { tipo: 'otp', challenge, canal, destino_masked: destinoMasked, email_masked: enmascararEmail(usr.email) };
}

export async function loginConPassword(
  email: string,
  password: string,
  deviceId: string,
  userAgent?: string,
  ip?: string,
): Promise<ResultadoLogin> {
  const db = ownerDb();
  const emailN = email.trim();

  // Todas las cuentas (empresa + usuario) con ese email. Se valida la contraseña contra
  // todas ANTES de desambiguar, para no revelar en qué empresas existe el email.
  const filas = await db
    .selectFrom('usuario as u')
    .innerJoin('empresa as e', 'e.id', 'u.cuenta_id')
    .select([
      'u.id as usuarioId',
      'u.email as email',
      'u.password_hash as passwordHash',
      'u.activo as activo',
      'u.telefono as telefono',
      'u.canal_otp as canalOtp',
      'e.id as cuentaId',
      'e.nombre as empresaNombre',
    ])
    .where('u.email', '=', emailN)
    .execute();

  const validas = filas.filter(
    (f) => f.activo !== false && f.passwordHash && verifyPassword(password, f.passwordHash),
  );

  if (validas.length === 0) {
    for (const f of filas) {
      await registrarSistema(f.cuentaId, f.usuarioId, {
        accion: 'login.fallido',
        detalle: { email: emailN, motivo: 'password_incorrecta' },
        ip,
        userAgent,
      });
    }
    throw INVALIDO();
  }

  if (validas.length === 1) {
    const f = validas[0];
    return continuarLogin(
      { id: f.cuentaId, nombre: f.empresaNombre },
      { id: f.usuarioId, email: f.email, telefono: f.telefono, canal_otp: f.canalOtp },
      deviceId,
      userAgent,
      ip,
    );
  }

  // Varias empresas con la misma contraseña: se pide elegir. El desafío firmado prueba
  // que la contraseña ya se validó y acota las cuentas elegibles.
  const desafio = await firmarDesafioEleccionEmpresa(
    emailN,
    validas.map((f) => ({ cuentaId: f.cuentaId, usuarioId: f.usuarioId })),
  );
  return {
    tipo: 'elegir_empresa',
    desafio,
    opciones: validas.map((f) => ({ cuenta_id: f.cuentaId, empresa_nombre: f.empresaNombre })),
  };
}

// Segundo paso: el usuario eligió a qué empresa entrar. Se valida el desafío firmado y
// que la empresa elegida esté entre las habilitadas, y se sigue el flujo normal.
export async function elegirEmpresaLogin(
  desafio: string,
  cuentaId: string,
  deviceId: string,
  userAgent?: string,
  ip?: string,
): Promise<ResultadoLogin> {
  const { pares } = await verificarDesafioEleccionEmpresa(desafio);
  const par = pares.find((p) => p.cuentaId === cuentaId);
  if (!par) throw new HttpError(401, 'Selección inválida.');
  const db = ownerDb();
  const f = await db
    .selectFrom('usuario as u')
    .innerJoin('empresa as e', 'e.id', 'u.cuenta_id')
    .select([
      'u.id as usuarioId',
      'u.email as email',
      'u.activo as activo',
      'u.telefono as telefono',
      'u.canal_otp as canalOtp',
      'e.id as cuentaId',
      'e.nombre as empresaNombre',
    ])
    .where('u.id', '=', par.usuarioId)
    .where('u.cuenta_id', '=', par.cuentaId)
    .executeTakeFirst();
  if (!f || f.activo === false) throw new HttpError(401, 'La cuenta ya no está disponible.');
  return continuarLogin(
    { id: f.cuentaId, nombre: f.empresaNombre },
    { id: f.usuarioId, email: f.email, telefono: f.telefono, canal_otp: f.canalOtp },
    deviceId,
    userAgent,
    ip,
  );
}

export async function verificarOtp(challenge: string, codigo: string, userAgent?: string): Promise<SesionLogin> {
  const { cuentaId, usuarioId, deviceId } = await verificarDesafioOtp(challenge);
  const db = ownerDb();

  const otp = await db
    .selectFrom('otp_login')
    .select(['id', 'codigo_hash', 'expira_at', 'intentos'])
    .where('cuenta_id', '=', cuentaId)
    .where('usuario_id', '=', usuarioId)
    .where('device_id', '=', deviceId)
    .where('usado', '=', false)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();

  if (!otp) throw new HttpError(401, 'No hay un código pendiente. Pedí uno nuevo.');
  if (new Date(otp.expira_at).getTime() < Date.now()) {
    await db.updateTable('otp_login').set({ usado: true }).where('id', '=', otp.id).execute();
    throw new HttpError(401, 'El código venció. Pedí uno nuevo.');
  }
  if (otp.intentos >= OTP_MAX_INTENTOS) {
    await db.updateTable('otp_login').set({ usado: true }).where('id', '=', otp.id).execute();
    throw new HttpError(429, 'Demasiados intentos. Pedí un código nuevo.');
  }

  if (!verifyPassword(codigo, otp.codigo_hash)) {
    const intentos = otp.intentos + 1;
    await db
      .updateTable('otp_login')
      .set({ intentos, usado: intentos >= OTP_MAX_INTENTOS })
      .where('id', '=', otp.id)
      .execute();
    throw new HttpError(401, 'Código incorrecto.');
  }

  // Correcto: quemar el código, confiar en el equipo y emitir la sesión.
  await db
    .updateTable('otp_login')
    .set({ usado: true, intentos: otp.intentos + 1 })
    .where('id', '=', otp.id)
    .execute();
  await confiarDispositivo(cuentaId, usuarioId, deviceId, userAgent);

  const emp = await db.selectFrom('empresa').select(['nombre']).where('id', '=', cuentaId).executeTakeFirst();
  const usr = await db.selectFrom('usuario').select(['email']).where('id', '=', usuarioId).executeTakeFirst();
  const token = await emitirTokenDev(cuentaId, usuarioId);
  return {
    tipo: 'sesion',
    token,
    cuenta_id: cuentaId,
    usuario_id: usuarioId,
    empresa_nombre: emp?.nombre || '',
    usuario_email: usr?.email || '',
  };
}

export async function reenviarOtp(challenge: string, ip?: string | null, userAgent?: string | null): Promise<{ canal: string; destino_masked: string; email_masked: string }> {
  const { cuentaId, usuarioId, deviceId } = await verificarDesafioOtp(challenge);
  const db = ownerDb();
  const emp = await db.selectFrom('empresa').select(['nombre']).where('id', '=', cuentaId).executeTakeFirst();
  const usr = await db
    .selectFrom('usuario')
    .select(['email', 'telefono', 'canal_otp'])
    .where('id', '=', usuarioId)
    .executeTakeFirst();
  if (!usr) throw new HttpError(401, 'Usuario no encontrado.');
  const { canal, destinoMasked } = await crearYEnviarOtp(
    cuentaId,
    usuarioId,
    deviceId,
    { email: usr.email, telefono: usr.telefono, canal_otp: usr.canal_otp },
    emp?.nombre || '',
    undefined,
    ip,
    userAgent,
  );
  return { canal, destino_masked: destinoMasked, email_masked: enmascararEmail(usr.email) };
}

// Envía el código por el canal que el usuario eligió en el login (mail o teléfono).
// Re-valida server-side que el canal pedido sea realmente posible (no confía en el cliente).
export async function enviarOtpElegido(
  challenge: string,
  canalPedido: 'email' | 'sms' | 'whatsapp',
  ip?: string | null,
  userAgent?: string | null,
): Promise<{ canal: string; destino_masked: string }> {
  const { cuentaId, usuarioId, deviceId } = await verificarDesafioOtp(challenge);
  const db = ownerDb();
  const emp = await db.selectFrom('empresa').select(['nombre']).where('id', '=', cuentaId).executeTakeFirst();
  const usr = await db
    .selectFrom('usuario')
    .select(['email', 'telefono', 'canal_otp'])
    .where('id', '=', usuarioId)
    .executeTakeFirst();
  if (!usr) throw new HttpError(401, 'Usuario no encontrado.');

  let canalUsar: 'email' | 'sms' | 'whatsapp' = 'email';
  if (canalPedido === 'sms' || canalPedido === 'whatsapp') {
    const tel = (usr.telefono || '').trim();
    const c = tel ? await twilioActivo() : null;
    const ct = canalTelefono(canalPedido, tel, c);
    if (ct) canalUsar = ct;
  }

  const { canal, destinoMasked } = await crearYEnviarOtp(
    cuentaId,
    usuarioId,
    deviceId,
    { email: usr.email, telefono: usr.telefono, canal_otp: usr.canal_otp },
    emp?.nombre || '',
    canalUsar,
    ip,
    userAgent,
  );
  return { canal, destino_masked: destinoMasked };
}
