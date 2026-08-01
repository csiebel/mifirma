import { randomInt } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { db } from '../db/pool';
import type { DB } from '../db/schema';
import {
  emitirSesion,
  firmarDesafioOtp,
  verificarDesafioOtp,
  firmarDesafioCuenta,
  verificarDesafioCuenta,
  type DatosDeSesion,
} from '../auth/identity';
import type { NivelGarantia } from '../db/contexto';
import { hashPassword, verifyPassword } from '../auth/password';
import { enviarCorreo } from './correo';
import { enviarOtpPorTwilio, twilioActivo } from './twilio';
import { registrarSistema, registrarPlataforma } from './auditoria';
import { HttpError } from '../http/errors';

/**
 * Login en dos pasos, sobre identidad global.
 *
 * ═══ EL CAMBIO DE FONDO RESPECTO DE PAYROLL NG ═══
 *
 * Allá el usuario existía DENTRO de una empresa: el mismo correo podía tener
 * contraseñas distintas en dos empresas, y el login tenía que validar la
 * contraseña contra todas antes de desambiguar — no para ser prolijo, sino para
 * no revelar en qué empresas existía ese correo.
 *
 * Acá la identidad es global y precede a la cuenta. Hay UNA contraseña por
 * persona, y el orden se invierte:
 *
 *   1. Probás quién sos     (contraseña + OTP, o dispositivo de confianza)
 *   2. Elegís a dónde entrás (cuenta, si tenés más de una)
 *
 * Eso elimina de raíz el oráculo de enumeración: el paso 1 no toca ninguna
 * cuenta, así que no hay nada que filtrar.
 *
 * ═══ ANCLAJES Y NIVEL DE GARANTÍA ═══
 *
 * Cada paso deja anotado QUÉ se probó, no sólo que se entró. El token de sesión
 * viaja con los anclajes probados, y las políticas RLS los consultan para
 * decidir si un otorgamiento que exige nivel sustancial se abre o no.
 *
 * Un dispositivo de confianza no inventa una prueba nueva: extiende en el
 * tiempo la que ocurrió el día que se lo marcó como confiable, y por eso guarda
 * cuál fue (migración 016).
 *
 * ═══ POR QUÉ NO HAY CONEXIÓN PRIVILEGIADA ═══
 *
 * En payroll todo esto corría con `ownerDb()` porque pasa antes de que exista
 * contexto de tenant. Acá corre con el pool normal en modo 'sistema': las
 * políticas de `identidad`, `credencial`, `otp_login` y `dispositivo_confiable`
 * ya contemplan ese actor. Un bug en el login no puede leer documentos de nadie.
 */

const OTP_TTL_MIN = 10;
const OTP_MAX_INTENTOS = 5;
const VENTANA_ANTIABUSO_MS = 60 * 60 * 1000;
const OTP_MAX_POR_VENTANA = 8;
const CONFIANZA_DIAS = 90;

// Retardo del login fallido. Sin esto, el tiempo de respuesta delata si el
// correo existe: verificar una contraseña contra un hash tarda, no encontrar
// nada es instantáneo.
const DEMORA_FALLIDO_MS = 300;

export interface SesionLogin {
  tipo: 'sesion';
  token: string;
  cuenta_id: string;
  identidad_id: string;
  cuenta_nombre: string;
  email: string;
}
export interface DesafioOtp {
  tipo: 'otp';
  challenge: string;
  canal: 'email' | 'sms' | 'whatsapp';
  destino_masked: string;
}
export interface EleccionCanal {
  tipo: 'otp_elegir';
  challenge: string;
  email_masked: string;
  tel_masked: string;
  canal_tel: 'sms' | 'whatsapp';
}
export interface EleccionCuenta {
  tipo: 'elegir_cuenta';
  desafio: string;
  opciones: { cuenta_id: string; cuenta_nombre: string }[];
}
export type ResultadoLogin = SesionLogin | DesafioOtp | EleccionCanal | EleccionCuenta;

/**
 * Un solo mensaje para credenciales inválidas, cuenta inexistente y cuenta
 * bloqueada. Distinguirlos es cómodo para el usuario y es un regalo para quien
 * quiera enumerar correos del sistema.
 */
const INVALIDO = () => new HttpError(401, 'Correo o contraseña incorrectos.');

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

function enmascararEmail(email: string): string {
  const i = email.indexOf('@');
  if (i <= 0) return '***';
  const local = email.slice(0, i);
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(2, local.length - 1))}@${email.slice(i + 1)}`;
}

function enmascararTel(tel: string): string {
  const d = tel.replace(/[^0-9]/g, '');
  return d.length <= 3 ? '••••' : '•••• ' + d.slice(-3);
}

function canalTelefono(
  tel: string,
  c: { from_sms: string | null; from_whatsapp: string | null } | null,
): 'sms' | 'whatsapp' | null {
  if (!tel || !c) return null;
  if (c.from_sms) return 'sms';
  if (c.from_whatsapp) return 'whatsapp';
  return null;
}

/**
 * Modo sistema sin cuenta: el login ocurre antes de saber a qué cuenta se entra.
 *
 * `withTenant` exige cuentaId, que acá todavía no existe. Esto fija sólo el
 * actor, y las políticas de identidad, credencial y OTP lo admiten.
 */
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
// Dispositivos de confianza
// ---------------------------------------------------------------------------

interface PruebaDeDispositivo {
  anclajeId: string | null;
  nivel: NivelGarantia;
}

async function dispositivoConfiable(
  identidadId: string,
  deviceId: string,
): Promise<PruebaDeDispositivo | null> {
  if (!deviceId) return null;
  return enSistema(async (trx) => {
    const row = await trx
      .selectFrom('dispositivo_confiable_vigente')
      .select(['id', 'anclaje_probado_id', 'nivel_garantia'])
      .where('identidad_id', '=', identidadId)
      .where('device_id', '=', deviceId)
      .executeTakeFirst();
    if (!row) return null;

    // Confianza deslizante: cada uso renueva la vigencia.
    await trx
      .updateTable('dispositivo_confiable')
      .set({
        ultimo_uso_en: new Date(),
        expira_en: new Date(Date.now() + CONFIANZA_DIAS * 86400000),
      })
      .where('id', '=', row.id)
      .execute();

    return {
      anclajeId: row.anclaje_probado_id ?? null,
      nivel: (row.nivel_garantia as NivelGarantia) ?? 'bajo',
    };
  });
}

export async function confiarDispositivo(
  identidadId: string,
  deviceId: string,
  prueba: PruebaDeDispositivo,
  userAgent?: string,
  ip?: string | null,
): Promise<void> {
  if (!deviceId) return;
  const ahora = new Date();
  const expira = new Date(Date.now() + CONFIANZA_DIAS * 86400000);
  await enSistema((trx) =>
    trx
      .insertInto('dispositivo_confiable')
      .values({
        identidad_id: identidadId,
        device_id: deviceId,
        etiqueta: userAgent?.slice(0, 200) ?? null,
        user_agent: userAgent?.slice(0, 500) ?? null,
        ip_alta: ip ?? null,
        anclaje_probado_id: prueba.anclajeId,
        nivel_garantia: prueba.nivel,
        confiado_en: ahora,
        ultimo_uso_en: ahora,
        expira_en: expira,
      })
      .onConflict((oc) =>
        oc.columns(['identidad_id', 'device_id']).doUpdateSet({
          ultimo_uso_en: ahora,
          expira_en: expira,
          revocado_en: null,
          anclaje_probado_id: prueba.anclajeId,
          nivel_garantia: prueba.nivel,
        }),
      )
      .execute(),
  );
}

// ---------------------------------------------------------------------------
// OTP
// ---------------------------------------------------------------------------

interface DestinoOtp {
  email: string;
  anclajeEmailId: string | null;
  telefono: string | null;
  anclajeTelId: string | null;
}

async function enviarOtpPorCorreo(destino: string, codigo: string) {
  await enviarCorreo({
    para: destino,
    asunto: 'Tu código de acceso · MiFirma',
    html:
      `<p>Tu código de acceso es:</p>` +
      `<p style="font-size:28px;font-weight:bold;letter-spacing:4px">${codigo}</p>` +
      `<p>Vence en ${OTP_TTL_MIN} minutos. Si no intentaste iniciar sesión, ignorá este correo.</p>`,
    texto: `Tu código de acceso es ${codigo}. Vence en ${OTP_TTL_MIN} minutos.`,
  });
}

async function crearYEnviarOtp(
  identidadId: string,
  deviceId: string,
  destino: DestinoOtp,
  canalPedido: 'email' | 'sms' | 'whatsapp' | undefined,
  ip?: string | null,
  userAgent?: string | null,
): Promise<{ canal: 'email' | 'sms' | 'whatsapp'; destinoMasked: string }> {
  const tel = (destino.telefono || '').trim();

  let canal: 'email' | 'sms' | 'whatsapp' = 'email';
  if (canalPedido === 'sms' || canalPedido === 'whatsapp') {
    const c = tel ? await twilioActivo() : null;
    canal = canalTelefono(tel, c) ?? 'email';
  }

  const codigo = String(randomInt(0, 1000000)).padStart(6, '0');

  await enSistema(async (trx) => {
    // Anti-abuso: tope de códigos por identidad y ventana.
    const recientes = await trx
      .selectFrom('otp_login')
      .select('id')
      .where('identidad_id', '=', identidadId)
      .where('creado_en', '>', new Date(Date.now() - VENTANA_ANTIABUSO_MS))
      .execute();
    if (recientes.length >= OTP_MAX_POR_VENTANA) {
      throw new HttpError(429, 'Pediste demasiados códigos. Esperá un rato antes de volver a intentar.');
    }

    // Un código vigente por dispositivo: el nuevo invalida el anterior.
    await trx
      .updateTable('otp_login')
      .set({ usado: true })
      .where('identidad_id', '=', identidadId)
      .where('device_id', '=', deviceId)
      .where('usado', '=', false)
      .execute();

    await trx
      .insertInto('otp_login')
      .values({
        identidad_id: identidadId,
        device_id: deviceId,
        codigo_hash: hashPassword(codigo),
        canal,
        anclaje_destino_id: canal === 'email' ? destino.anclajeEmailId : destino.anclajeTelId,
        expira_en: new Date(Date.now() + OTP_TTL_MIN * 60000),
        ip: ip ?? null,
      })
      .execute();
  });

  // El destino, enmascarado, para poder anotarlo. Se calcula acá arriba porque
  // el `canal` puede cambiar más abajo si hay que caer al respaldo por correo, y
  // entonces ya no se sabría a qué teléfono se intentó.
  const intentado = canal === 'email' ? enmascararEmail(destino.email) : enmascararTel(tel);

  try {
    if (canal === 'sms' || canal === 'whatsapp') {
      await enviarOtpPorTwilio(canal, tel, codigo, OTP_TTL_MIN);
    } else {
      await enviarOtpPorCorreo(destino.email, codigo);
    }
    // ⚠ El código NO se anota, obviamente. Se anota que salió, por dónde y
    // hacia dónde enmascarado: alcanza para responder "no me llegó" sin que la
    // bitácora se convierta en una forma de entrar a las cuentas de nadie.
    await registrarPlataforma(identidadId, {
      accion: 'otp.enviado',
      recursoTipo: 'otp',
      despues: { canal, destino: intentado, device_id: deviceId },
      ip,
      userAgent,
    });
  } catch (err) {
    await registrarPlataforma(identidadId, {
      accion: 'otp.fallido',
      recursoTipo: 'otp',
      despues: {
        canal,
        destino: intentado,
        motivo: err instanceof Error ? err.message.slice(0, 300) : 'desconocido',
      },
      ip,
      userAgent,
    });
    // Respaldo por correo antes de rendirse: dejar a alguien afuera por una
    // caída de Twilio es peor que mandarlo por otro canal.
    if (canal !== 'email') {
      try {
        await enviarOtpPorCorreo(destino.email, codigo);
        canal = 'email';
        await registrarPlataforma(identidadId, {
          accion: 'otp.enviado',
          recursoTipo: 'otp',
          despues: { canal: 'email', destino: enmascararEmail(destino.email), respaldo_de: intentado },
          ip,
          userAgent,
        });
        await enSistema((trx) =>
          trx
            .updateTable('otp_login')
            .set({ canal: 'email', anclaje_destino_id: destino.anclajeEmailId })
            .where('identidad_id', '=', identidadId)
            .where('device_id', '=', deviceId)
            .where('usado', '=', false)
            .execute(),
        );
      } catch {
        throw new HttpError(
          503,
          'No pudimos enviarte el código, ni por teléfono ni por correo. Avisale al administrador de la plataforma.',
        );
      }
    } else {
      throw new HttpError(
        503,
        'No pudimos enviarte el código por correo. Avisale al administrador de la plataforma (falta configurar el correo).',
      );
    }
  }

  const destinoMasked = canal === 'email' ? enmascararEmail(destino.email) : enmascararTel(tel);
  return { canal, destinoMasked };
}

// ---------------------------------------------------------------------------
// Paso 1: contraseña
// ---------------------------------------------------------------------------

interface IdentidadLogin {
  id: string;
  email: string;
  hashPassword: string | null;
  bloqueadaHasta: Date | null;
  telefono: string | null;
  idioma: string | null;
}

export async function loginConPassword(
  email: string,
  password: string,
  deviceId: string,
  userAgent?: string,
  ip?: string,
): Promise<ResultadoLogin> {
  const emailN = email.trim().toLowerCase();

  const ident = await enSistema(async (trx) =>
    trx
      .selectFrom('identidad as i')
      .innerJoin('credencial as c', 'c.identidad_id', 'i.id')
      .select([
        'i.id as id',
        'i.email_mostrado as email',
        'i.idioma_preferido as idioma',
        'i.estado as estado',
        'c.hash_password as hashPassword',
        'c.bloqueada_hasta as bloqueadaHasta',
        'c.telefono_e164 as telefono',
      ])
      .where('i.email_normalizado', '=', emailN)
      .executeTakeFirst(),
  );

  if (!ident || ident.estado !== 'activa' || !ident.hashPassword) {
    await dormir(DEMORA_FALLIDO_MS);
    throw INVALIDO();
  }
  if (ident.bloqueadaHasta && new Date(ident.bloqueadaHasta).getTime() > Date.now()) {
    await dormir(DEMORA_FALLIDO_MS);
    throw INVALIDO();
  }
  if (!verifyPassword(password, ident.hashPassword)) {
    await registrarFallo(ident.id);
    await dormir(DEMORA_FALLIDO_MS);
    throw INVALIDO();
  }

  await enSistema((trx) =>
    trx
      .updateTable('credencial')
      .set({ intentos_fallidos: 0, ultimo_acceso_en: new Date() })
      .where('identidad_id', '=', ident.id)
      .execute(),
  );

  const yo: IdentidadLogin = {
    id: ident.id,
    email: ident.email,
    hashPassword: ident.hashPassword,
    bloqueadaHasta: ident.bloqueadaHasta as Date | null,
    telefono: ident.telefono,
    idioma: ident.idioma,
  };

  // Dispositivo conocido: la prueba de identidad se hereda de cuando se lo confió.
  const confianza = await dispositivoConfiable(yo.id, deviceId);
  if (confianza) {
    return elegirCuenta(yo, {
      anclajesProbados: confianza.anclajeId ? [confianza.anclajeId] : [],
      nivelGarantia: confianza.nivel,
      idioma: yo.idioma ?? undefined,
    }, ip, userAgent);
  }

  // Dispositivo nuevo: segundo factor.
  const challenge = await firmarDesafioOtp(yo.id, deviceId);
  const anclajes = await anclajesDe(yo.id);
  const tel = (yo.telefono || '').trim();
  const canalTel = tel ? canalTelefono(tel, await twilioActivo()) : null;

  if (canalTel) {
    return {
      tipo: 'otp_elegir',
      challenge,
      email_masked: enmascararEmail(yo.email),
      tel_masked: enmascararTel(tel),
      canal_tel: canalTel,
    };
  }

  const { canal, destinoMasked } = await crearYEnviarOtp(
    yo.id,
    deviceId,
    { email: yo.email, anclajeEmailId: anclajes.email, telefono: tel, anclajeTelId: anclajes.telefono },
    'email',
    ip,
    userAgent,
  );
  return { tipo: 'otp', challenge, canal, destino_masked: destinoMasked };
}

/**
 * Cuenta el intento y bloquea temporalmente al llegar al tope.
 *
 * El bloqueo es por tiempo y no permanente a propósito: un bloqueo permanente
 * por intentos fallidos convierte el formulario de login en una herramienta
 * para dejar a cualquiera afuera con sólo conocerle el correo.
 */
async function registrarFallo(identidadId: string): Promise<void> {
  await enSistema(async (trx) => {
    const r = await trx
      .updateTable('credencial')
      .set((eb) => ({ intentos_fallidos: eb('intentos_fallidos', '+', 1) }))
      .where('identidad_id', '=', identidadId)
      .returning('intentos_fallidos')
      .executeTakeFirst();
    if ((r?.intentos_fallidos ?? 0) >= 10) {
      await trx
        .updateTable('credencial')
        .set({ bloqueada_hasta: new Date(Date.now() + 15 * 60000), intentos_fallidos: 0 })
        .where('identidad_id', '=', identidadId)
        .execute();
    }
  });
}

async function anclajesDe(identidadId: string): Promise<{ email: string | null; telefono: string | null }> {
  return enSistema(async (trx) => {
    const filas = await trx
      .selectFrom('anclaje_identidad')
      .select(['id', 'tipo'])
      .where('identidad_id', '=', identidadId)
      .where('revocado_en', 'is', null)
      .where('tipo', 'in', ['email', 'telefono'])
      .execute();
    return {
      email: filas.find((f) => f.tipo === 'email')?.id ?? null,
      telefono: filas.find((f) => f.tipo === 'telefono')?.id ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Paso 2: OTP
// ---------------------------------------------------------------------------

export async function enviarOtpElegido(
  challenge: string,
  canalPedido: 'email' | 'sms' | 'whatsapp',
  ip?: string | null,
  userAgent?: string | null,
): Promise<{ canal: string; destino_masked: string }> {
  const { identidadId, deviceId } = await verificarDesafioOtp(challenge);
  const destino = await destinoDe(identidadId);
  const { canal, destinoMasked } = await crearYEnviarOtp(
    identidadId,
    deviceId,
    destino,
    canalPedido,
    ip,
    userAgent,
  );
  return { canal, destino_masked: destinoMasked };
}

export async function reenviarOtp(
  challenge: string,
  ip?: string | null,
  userAgent?: string | null,
): Promise<{ canal: string; destino_masked: string }> {
  const { identidadId, deviceId } = await verificarDesafioOtp(challenge);
  const destino = await destinoDe(identidadId);
  const { canal, destinoMasked } = await crearYEnviarOtp(identidadId, deviceId, destino, 'email', ip, userAgent);
  return { canal, destino_masked: destinoMasked };
}

async function destinoDe(identidadId: string): Promise<DestinoOtp> {
  const [datos, anclajes] = await Promise.all([
    enSistema((trx) =>
      trx
        .selectFrom('identidad as i')
        .leftJoin('credencial as c', 'c.identidad_id', 'i.id')
        .select(['i.email_mostrado as email', 'c.telefono_e164 as telefono'])
        .where('i.id', '=', identidadId)
        .executeTakeFirst(),
    ),
    anclajesDe(identidadId),
  ]);
  if (!datos) throw new HttpError(401, 'Sesión inválida.');
  return {
    email: datos.email,
    anclajeEmailId: anclajes.email,
    telefono: datos.telefono,
    anclajeTelId: anclajes.telefono,
  };
}

export async function verificarOtp(
  challenge: string,
  codigo: string,
  userAgent?: string,
  ip?: string,
): Promise<ResultadoLogin> {
  const { identidadId, deviceId } = await verificarDesafioOtp(challenge);

  const otp = await enSistema((trx) =>
    trx
      .selectFrom('otp_login')
      .select(['id', 'codigo_hash', 'expira_en', 'intentos', 'anclaje_destino_id'])
      .where('identidad_id', '=', identidadId)
      .where('device_id', '=', deviceId)
      .where('usado', '=', false)
      .orderBy('creado_en', 'desc')
      .executeTakeFirst(),
  );

  if (!otp) throw new HttpError(401, 'No hay un código pendiente. Pedí uno nuevo.');

  const quemar = () =>
    enSistema((trx) => trx.updateTable('otp_login').set({ usado: true }).where('id', '=', otp.id).execute());

  if (new Date(otp.expira_en).getTime() < Date.now()) {
    await quemar();
    throw new HttpError(401, 'El código venció. Pedí uno nuevo.');
  }
  if (otp.intentos >= OTP_MAX_INTENTOS) {
    await quemar();
    throw new HttpError(429, 'Demasiados intentos. Pedí un código nuevo.');
  }
  if (!verifyPassword(codigo, otp.codigo_hash)) {
    const intentos = otp.intentos + 1;
    await enSistema((trx) =>
      trx
        .updateTable('otp_login')
        .set({ intentos, usado: intentos >= OTP_MAX_INTENTOS })
        .where('id', '=', otp.id)
        .execute(),
    );
    throw new HttpError(401, 'Código incorrecto.');
  }

  await enSistema((trx) =>
    trx.updateTable('otp_login').set({ usado: true, intentos: otp.intentos + 1 }).where('id', '=', otp.id).execute(),
  );

  // El nivel del anclaje probado es el de la sesión. No se sube por haber
  // pasado un OTP: un código por mail prueba control del mail, nada más.
  const nivel = otp.anclaje_destino_id ? await nivelDeAnclaje(otp.anclaje_destino_id) : 'bajo';
  const prueba: PruebaDeDispositivo = { anclajeId: otp.anclaje_destino_id ?? null, nivel };

  await confiarDispositivo(identidadId, deviceId, prueba, userAgent, ip);

  const yo = await enSistema((trx) =>
    trx
      .selectFrom('identidad')
      .select(['id', 'email_mostrado as email', 'idioma_preferido as idioma'])
      .where('id', '=', identidadId)
      .executeTakeFirst(),
  );
  if (!yo) throw new HttpError(401, 'Sesión inválida.');

  return elegirCuenta(
    { id: yo.id, email: yo.email, hashPassword: null, bloqueadaHasta: null, telefono: null, idioma: yo.idioma },
    {
      anclajesProbados: prueba.anclajeId ? [prueba.anclajeId] : [],
      nivelGarantia: nivel,
      idioma: yo.idioma ?? undefined,
    },
    ip,
    userAgent,
  );
}

async function nivelDeAnclaje(anclajeId: string): Promise<NivelGarantia> {
  const r = await enSistema((trx) =>
    trx
      .selectFrom('anclaje_identidad')
      .select('nivel_garantia')
      .where('id', '=', anclajeId)
      .executeTakeFirst(),
  );
  return (r?.nivel_garantia as NivelGarantia) ?? 'bajo';
}

// ---------------------------------------------------------------------------
// Paso 3: a qué cuenta entra
// ---------------------------------------------------------------------------

async function cuentasDe(identidadId: string) {
  return enSistema((trx) =>
    trx
      .selectFrom('membresia as m')
      .innerJoin('cuenta as c', 'c.id', 'm.cuenta_id')
      .select(['c.id as cuentaId', 'c.nombre_mostrado as nombre'])
      .where('m.identidad_id', '=', identidadId)
      .where('m.estado', '=', 'activa')
      .where('c.estado', '=', 'activa')
      .orderBy('c.nombre_mostrado')
      .execute(),
  );
}

async function elegirCuenta(
  yo: IdentidadLogin,
  datos: DatosDeSesion,
  ip?: string | null,
  userAgent?: string | null,
): Promise<ResultadoLogin> {
  const cuentas = await cuentasDe(yo.id);

  // Sin cuenta no es un error: es un FIRMANTE. Alguien a quien invitaron a
  // firmar y se registró. Entra por su enlace o por su repositorio personal,
  // no por una consola de empresa.
  if (cuentas.length === 0) {
    throw new HttpError(
      403,
      'Tu usuario todavía no está habilitado en ninguna empresa. Si te invitaron a firmar un documento, entrá por el enlace que recibiste.',
    );
  }

  if (cuentas.length === 1) {
    return abrirSesion(cuentas[0].cuentaId, cuentas[0].nombre, yo, datos, ip, userAgent);
  }

  return {
    tipo: 'elegir_cuenta',
    desafio: await firmarDesafioCuenta(yo.id, cuentas.map((c) => c.cuentaId), datos),
    opciones: cuentas.map((c) => ({ cuenta_id: c.cuentaId, cuenta_nombre: c.nombre })),
  };
}

export async function elegirCuentaLogin(
  desafio: string,
  cuentaId: string,
  ip?: string,
  userAgent?: string,
): Promise<SesionLogin> {
  const { identidadId, cuentas, datos } = await verificarDesafioCuenta(desafio);

  // La lista de cuentas elegibles va firmada en el desafío, así que el cliente
  // no puede pedir entrar a una que no le corresponde.
  if (!cuentas.includes(cuentaId)) throw new HttpError(401, 'Selección inválida.');

  // Y se revalida contra la base: entre que se emitió el desafío y ahora, la
  // membresía pudo terminarse.
  const vigentes = await cuentasDe(identidadId);
  const elegida = vigentes.find((c) => c.cuentaId === cuentaId);
  if (!elegida) throw new HttpError(401, 'Esa cuenta ya no está disponible.');

  const yo = await enSistema((trx) =>
    trx
      .selectFrom('identidad')
      .select(['id', 'email_mostrado as email', 'idioma_preferido as idioma'])
      .where('id', '=', identidadId)
      .executeTakeFirst(),
  );
  if (!yo) throw new HttpError(401, 'Sesión inválida.');

  return abrirSesion(
    cuentaId,
    elegida.nombre,
    { id: yo.id, email: yo.email, hashPassword: null, bloqueadaHasta: null, telefono: null, idioma: yo.idioma },
    datos,
    ip,
    userAgent,
  );
}

async function abrirSesion(
  cuentaId: string,
  cuentaNombre: string,
  yo: IdentidadLogin,
  datos: DatosDeSesion,
  ip?: string | null,
  userAgent?: string | null,
): Promise<SesionLogin> {
  const token = await emitirSesion(cuentaId, yo.id, datos);
  await registrarSistema(cuentaId, yo.id, {
    accion: 'login.ok',
    recursoTipo: 'sesion',
    despues: { nivel: datos.nivelGarantia, anclajes: datos.anclajesProbados?.length ?? 0 },
    ip,
    userAgent,
  });
  return {
    tipo: 'sesion',
    token,
    cuenta_id: cuentaId,
    identidad_id: yo.id,
    cuenta_nombre: cuentaNombre,
    email: yo.email,
  };
}
