import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  loginConPassword,
  elegirCuentaLogin,
  verificarOtp,
  reenviarOtp,
  enviarOtpElegido,
} from '../../services/auth_login';
import { solicitarReset, confirmarReset } from '../../services/auth_reset';
import { solicitarRegistro, verRegistro, confirmarRegistro } from '../../services/auth_registro';
import { clearCookieSesion } from '../cookies_sesion';
import { verificarCaptcha } from '../../services/captcha';
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
  // ⚠ Con cartelito de «no soy un robot», igual que el alta: es el otro formulario
  // público que manda un correo a la casilla de alguien. El tope por identidad —3
  // por hora— ya impide ensañarse con UNA persona; el cartelito es contra el que
  // recorre miles de direcciones distintas.
  app.post('/auth/reset/solicitar', async (req) => {
    const b = z.object({ email: z.string().min(1), captcha: z.string().optional() }).parse(req.body);
    await verificarCaptcha(b.captcha, req.ip);
    return solicitarReset(b.email);
  });

  app.post('/auth/reset/confirmar', async (req) => {
    const b = z.object({ token: z.string().min(1), password: z.string().min(1) }).parse(req.body);
    return confirmarReset(b.token, b.password);
  });

  // ---- Alta self-service, en DOS PASOS ----
  //
  // ⚠ El primer paso NO crea nada y NO devuelve sesión, ni siquiera para un
  // correo que no existe. Ver el encabezado de `services/auth_registro.ts`: si
  // la respuesta fuera distinta según el correo exista o no, este formulario
  // sería una herramienta pública para averiguar quién usa MiFirma.
  //
  // Tope por IP más estricto que el del resto: sin esto, pedir altas en masa es
  // gratis y cada una manda un correo a la casilla de alguien.
  const cuerpoRegistro = z.object({
    // ⚠ Opcional para Zod, obligatorio de verdad: si el cartelito está encendido,
    // `verificarCaptcha` rechaza el pedido sin token. Marcarlo requerido acá haría
    // que en desarrollo, con el cartelito apagado, el alta contestara «Datos
    // inválidos» en vez de funcionar.
    captcha: z.string().optional(),
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
    }),
  });

  app.post(
    '/auth/registro',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (req) => {
      const b = cuerpoRegistro.parse(req.body);
      // ⚠ ANTES DE TOCAR NADA. Sin esto, cada golpe crea una identidad latente y
      // manda un correo. El 10/8/2026 esta línea faltó en la primera pasada —el
      // cartelito quedó sólo en el recupero— y el defecto no lo vio la pantalla,
      // que dibujaba el cartelito igual: lo cazó un curl sin token que igual
      // contestó `{"ok":true}`.
      await verificarCaptcha(b.captcha, req.ip);
      return solicitarRegistro(
        {
          nombre: b.nombre,
          tipo: b.tipo ?? 'empresa',
          pais: b.pais,
          razonSocial: b.razon_social ?? null,
          idFiscal: b.id_fiscal ?? null,
          domicilio: b.domicilio ?? null,
          industriaId: b.industria_id ?? null,
          adminNombre: b.admin.nombre,
          email: b.admin.email,
        },
        req.ip,
      );
    },
  );

  // Qué se está por crear, para pintar la pantalla. No crea nada.
  app.post('/auth/registro/ver', async (req) => {
    const b = z.object({ token: z.string().min(1) }).parse(req.body);
    return verRegistro(b.token);
  });

  // El clic en el correo. Acá sí se crea la cuenta, y la sesión sale con el
  // anclaje de correo ya probado — porque abrir este enlace ES la prueba.
  app.post(
    '/auth/registro/confirmar',
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (req) => {
      const b = z
        .object({ token: z.string().min(1), password: z.string().min(1).optional() })
        .parse(req.body);
      return confirmarRegistro(b.token, b.password, req.ip);
    },
  );
}
