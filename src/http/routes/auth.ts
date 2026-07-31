import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { emitirTokenDev } from '../../auth/identity';
import { loginConPassword, elegirEmpresaLogin, verificarOtp, reenviarOtp, enviarOtpElegido, confiarDispositivo } from '../../services/auth_login';
import { solicitarReset, confirmarReset } from '../../services/auth_reset';
import { registrarSistema } from '../../services/auditoria';
import { validarPassword } from '../../auth/password';
import { ownerDb } from '../../db/owner';
import { provisionarEmpresa } from '../../admin/provisioning';
import { clearCookieSesion } from '../cookies_sesion';
import { HttpError } from '../errors';

// Login amigable de desarrollo: se entra con el NOMBRE de la empresa y el EMAIL
// del usuario; acá se resuelven a los ids internos. Como todavía no hay contexto
// de tenant, la búsqueda usa la conexión privilegiada (ownerDb). SOLO DEV:
// requiere AUTH_DEV_SECRET (firma) y DATABASE_OWNER_URL (búsqueda).
const cuerpo = z.object({ empresa: z.string().min(1), email: z.string().min(1) });

// Alta self-service de empresa (mecanismo base; a futuro lo dispara el webhook
// de pago, con tier gratuito como regla de plan). SOLO DEV, sin contraseña aún:
// crea empresa + admin y devuelve un token para entrar directo.
const cuerpoRegistro = z.object({
  empresa: z.string().min(1),
  pais: z.enum(['UY', 'PY']),
  razon_social: z.string().optional(),
  id_fiscal: z.string().optional(),
  num_seguridad_social: z.string().optional(),
  domicilio: z.string().optional(),
  industria_id: z.string().uuid('Elegí el rubro de la empresa.'),
  device_id: z.string().optional(),
  admin: z.object({
    nombre: z.string().min(1),
    email: z.string().min(1),
    documento: z.string().min(1),
    password: z.string().min(1),
  }),
});

export function registrarRutasAuth(app: FastifyInstance) {
  // Login real con contraseña (paso 1). Reemplaza al login de desarrollo.
  app.post('/auth/login', async (req) => {
    const b = z
      .object({
        email: z.string().min(1),
        password: z.string().min(1),
        device_id: z.string().optional(),
      })
      .parse(req.body);
    const r = await loginConPassword(b.email, b.password, b.device_id ?? '', req.headers['user-agent'], req.ip);
    if (r.tipo === 'sesion') {
      await registrarSistema(r.cuenta_id, r.usuario_id, { accion: 'login.ok', detalle: { via: 'password' }, ip: req.ip, userAgent: req.headers['user-agent'] });
    }
    return r;
  });

  // Paso 1.5: cuando el email tiene la misma contraseña en varias empresas, el usuario
  // elige a cuál entrar. El desafío firmado prueba que la contraseña ya se validó.
  app.post('/auth/login/elegir-empresa', async (req) => {
    const b = z
      .object({ desafio: z.string().min(1), cuenta_id: z.string().uuid(), device_id: z.string().optional() })
      .parse(req.body);
    const r = await elegirEmpresaLogin(b.desafio, b.cuenta_id, b.device_id ?? '', req.headers['user-agent'], req.ip);
    if (r.tipo === 'sesion') {
      await registrarSistema(r.cuenta_id, r.usuario_id, { accion: 'login.ok', detalle: { via: 'password' }, ip: req.ip, userAgent: req.headers['user-agent'] });
    }
    return r;
  });

  // Paso 2: validar el código OTP del equipo nuevo. Devuelve la sesión si es correcto.
  app.post('/auth/otp', async (req) => {
    const b = z.object({ challenge: z.string().min(1), code: z.string().min(1) }).parse(req.body);
    const r = await verificarOtp(b.challenge, b.code, req.headers['user-agent']);
    await registrarSistema(r.cuenta_id, r.usuario_id, { accion: 'login.ok', detalle: { via: 'otp' }, ip: req.ip, userAgent: req.headers['user-agent'] });
    return r;
  });

  // Reenviar un código nuevo para el mismo desafío.
  app.post('/auth/otp/reenviar', async (req) => {
    const b = z.object({ challenge: z.string().min(1) }).parse(req.body);
    return reenviarOtp(b.challenge, req.ip, req.headers['user-agent']);
  });

  // Elegir canal (mail/teléfono) y enviar el código. Se usa cuando el usuario
  // tiene los dos disponibles y el login devolvió 'otp_elegir'.
  app.post('/auth/otp/elegir', async (req) => {
    const b = z
      .object({ challenge: z.string().min(1), canal: z.enum(['email', 'sms', 'whatsapp']) })
      .parse(req.body);
    return enviarOtpElegido(b.challenge, b.canal, req.ip, req.headers['user-agent']);
  });

  // Cerrar sesión: borra la cookie httpOnly de empresa (Fase A). Público: debe andar
  // aunque el token ya haya vencido. El token del header/JSON lo descarta el frontend.
  app.post('/auth/logout', async (_req, reply) => {
    clearCookieSesion(reply, 'emp');
    return { ok: true };
  });

  // Recupero de contraseña: pedir el enlace por correo. Siempre responde ok.
  app.post('/auth/reset/solicitar', async (req) => {
    const b = z.object({ email: z.string().min(1) }).parse(req.body);
    return solicitarReset(b.email);
  });

  // Recupero de contraseña: fijar la nueva con el token del enlace (reset o invitación).
  app.post('/auth/reset/confirmar', async (req) => {
    const b = z.object({ token: z.string().min(1), password: z.string().min(1) }).parse(req.body);
    return confirmarReset(b.token, b.password);
  });

  app.post('/auth/login-dev', async (req) => {
    // Backdoor sin contraseña: apagado salvo que se ponga AUTH_DEV_LOGIN=1.
    if (process.env.AUTH_DEV_LOGIN !== '1') {
      throw new HttpError(403, 'El login sin contraseña está deshabilitado. Iniciá sesión con tu contraseña.');
    }
    const { empresa, email } = cuerpo.parse(req.body);
    const db = ownerDb();

    const emp = await db
      .selectFrom('empresa')
      .select(['id', 'nombre'])
      .where('nombre', '=', empresa)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    if (!emp) throw new HttpError(404, `No existe una empresa llamada "${empresa}".`);

    const usr = await db
      .selectFrom('usuario')
      .select(['id', 'email'])
      .where('cuenta_id', '=', emp.id)
      .where('email', '=', email)
      .executeTakeFirst();
    if (!usr) throw new HttpError(404, `No existe el usuario "${email}" en ${empresa}.`);

    const token = await emitirTokenDev(emp.id, usr.id);
    return {
      token,
      cuenta_id: emp.id,
      usuario_id: usr.id,
      empresa_nombre: emp.nombre,
      usuario_email: usr.email,
    };
  });

  // Alta de empresa: freno anti-abuso propio (más estricto que el de auth general),
  // para que no se puedan crear empresas en masa desde una misma IP. El control de fondo
  // (verificación de email / gate hasta el onboarding con pago) queda pendiente de definir.
  app.post('/auth/registro-dev', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (req) => {
    const b = cuerpoRegistro.parse(req.body);
    const errPwd = validarPassword(b.admin.password);
    if (errPwd) throw new HttpError(400, errPwd);
    const moneda = b.pais === 'UY' ? 'UYU' : 'PYG';

    const existe = await ownerDb()
      .selectFrom('empresa')
      .select('id')
      .where('nombre', '=', b.empresa)
      .executeTakeFirst();
    if (existe) throw new HttpError(409, `Ya existe una empresa llamada "${b.empresa}". Probá entrar en lugar de crearla.`);

    const r = await provisionarEmpresa({
      nombre: b.empresa,
      pais: b.pais,
      moneda,
      razonSocial: b.razon_social,
      idFiscal: b.id_fiscal,
      numSeguridadSocial: b.num_seguridad_social,
      domicilio: b.domicilio,
      industriaId: b.industria_id,
      admin: b.admin,
    });
    if (b.device_id) await confiarDispositivo(r.cuentaId, r.adminUsuarioId, b.device_id, req.headers['user-agent']);
    const token = await emitirTokenDev(r.cuentaId, r.adminUsuarioId);
    return {
      token,
      cuenta_id: r.cuentaId,
      usuario_id: r.adminUsuarioId,
      empresa_nombre: b.empresa,
      usuario_email: b.admin.email,
    };
  });
}
