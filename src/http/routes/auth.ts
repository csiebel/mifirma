import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { emitirSesion } from '../../auth/identity';
import {
  loginConPassword,
  elegirCuentaLogin,
  verificarOtp,
  reenviarOtp,
  enviarOtpElegido,
} from '../../services/auth_login';
import { solicitarReset, confirmarReset } from '../../services/auth_reset';
import { validarPassword } from '../../auth/password';
import { provisionarCuenta } from '../../admin/provisioning';
import { clearCookieSesion } from '../cookies_sesion';
import { HttpError } from '../errors';

/**
 * Rutas de autenticación.
 *
 * El orden de los pasos refleja el modelo de identidad global:
 *
 *   1. /auth/login          contraseña → sesión, u OTP, o elegir cuenta
 *   2. /auth/otp            código → sesión, o elegir cuenta
 *   3. /auth/login/elegir   a qué cuenta entra, si tiene más de una
 *
 * Primero se prueba QUIÉN sos; después a DÓNDE entrás. Ver el encabezado de
 * `services/auth_login.ts`.
 *
 * ⚠ Se eliminó `/auth/login-dev`, el login sin contraseña que existía en
 * payroll detrás de una variable de entorno. Una puerta trasera apagada por
 * configuración sigue siendo una puerta trasera: alcanza con que alguien copie
 * un `.env` de desarrollo a producción. En un producto de firma electrónica en
 * proceso de certificación, eso no se discute.
 */
export function registrarRutasAuth(app: FastifyInstance) {
  // ---- Paso 1: contraseña ----
  app.post('/auth/login', async (req) => {
    const b = z
      .object({
        email: z.string().min(1),
        password: z.string().min(1),
        device_id: z.string().optional(),
      })
      .parse(req.body);
    return loginConPassword(
      b.email,
      b.password,
      b.device_id ?? '',
      req.headers['user-agent'],
      req.ip,
    );
  });

  // ---- Paso 2: segundo factor ----
  app.post('/auth/otp', async (req) => {
    const b = z.object({ challenge: z.string().min(1), code: z.string().min(1) }).parse(req.body);
    return verificarOtp(b.challenge, b.code, req.headers['user-agent'], req.ip);
  });

  app.post('/auth/otp/reenviar', async (req) => {
    const b = z.object({ challenge: z.string().min(1) }).parse(req.body);
    return reenviarOtp(b.challenge, req.ip, req.headers['user-agent']);
  });

  // Elegir por dónde llega el código, cuando hay teléfono y correo disponibles.
  app.post('/auth/otp/elegir', async (req) => {
    const b = z
      .object({ challenge: z.string().min(1), canal: z.enum(['email', 'sms', 'whatsapp']) })
      .parse(req.body);
    return enviarOtpElegido(b.challenge, b.canal, req.ip, req.headers['user-agent']);
  });

  // ---- Paso 3: a qué cuenta ----
  app.post('/auth/login/elegir-cuenta', async (req) => {
    const b = z
      .object({ desafio: z.string().min(1), cuenta_id: z.string().uuid() })
      .parse(req.body);
    return elegirCuentaLogin(b.desafio, b.cuenta_id, req.ip, req.headers['user-agent']);
  });

  // ---- Salir ----
  // Público a propósito: tiene que funcionar aunque el token ya haya vencido.
  app.post('/auth/logout', async (_req, reply) => {
    clearCookieSesion(reply, 'emp');
    return { ok: true };
  });

  // ---- Recupero ----
  app.post('/auth/reset/solicitar', async (req) => {
    const b = z.object({ email: z.string().min(1) }).parse(req.body);
    return solicitarReset(b.email);
  });

  app.post('/auth/reset/confirmar', async (req) => {
    const b = z.object({ token: z.string().min(1), password: z.string().min(1) }).parse(req.body);
    return confirmarReset(b.token, b.password);
  });

  // ---- Alta self-service ----
  //
  // Tope de altas por IP más estricto que el del resto: sin esto, crear cuentas
  // en masa es gratis y cada una arrastra su árbol de carpetas y sus roles.
  //
  // TODO antes de abrirlo al público: verificación del correo antes de crear la
  // cuenta, y captcha. Hoy alcanza para la contratación asistida.
  const cuerpoRegistro = z.object({
    nombre: z.string().min(1).max(120),
    tipo: z.enum(['empresa', 'persona']).optional(),
    pais: z.enum(['UY', 'PY', 'BR']),
    razon_social: z.string().max(200).optional(),
    id_fiscal: z.string().max(40).optional(),
    domicilio: z.string().max(300).optional(),
    industria_id: z.string().uuid().optional(),
    admin: z.object({
      nombre: z.string().min(1).max(120),
      email: z.string().email(),
      password: z.string().min(1),
    }),
  });

  const MONEDA: Record<string, string> = { UY: 'UYU', PY: 'PYG', BR: 'BRL' };

  app.post(
    '/auth/registro',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (req) => {
      const b = cuerpoRegistro.parse(req.body);
      const errPwd = validarPassword(b.admin.password);
      if (errPwd) throw new HttpError(400, errPwd);

      const r = await provisionarCuenta({
        nombre: b.nombre,
        tipo: b.tipo ?? 'empresa',
        pais: b.pais,
        moneda: MONEDA[b.pais],
        razonSocial: b.razon_social ?? null,
        idFiscal: b.id_fiscal ?? null,
        domicilio: b.domicilio ?? null,
        industriaId: b.industria_id ?? null,
        admin: b.admin,
      });

      // La sesión recién creada arranca sin anclaje probado: el correo todavía
      // no se verificó. El nivel sube cuando la persona prueba algo — un código
      // por correo, un certificado— no por haberse registrado.
      //
      // Por lo mismo NO se confía en el dispositivo acá: confiar es extender una
      // prueba que ocurrió, y en el alta no ocurrió ninguna.
      const token = await emitirSesion(r.cuentaId, r.adminIdentidadId, {
        anclajesProbados: [],
        nivelGarantia: 'bajo',
      });

      return {
        token,
        cuenta_id: r.cuentaId,
        identidad_id: r.adminIdentidadId,
        cuenta_nombre: b.nombre,
        email: b.admin.email,
      };
    },
  );
}
