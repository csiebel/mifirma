import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as cuenta from '../../services/cuenta';

/**
 * Tu acceso: la contraseña, el teléfono y por dónde te llega el código.
 *
 * ⚠ Todo acá es **self-scoped**: toca la identidad del token y nada más. Por
 * eso no exige permiso de administrador… y por eso mismo **el administrador de
 * una empresa tampoco puede usarlo sobre otro**. La credencial es de la
 * identidad, que es global: el admin de la empresa A estaría tocando el acceso
 * que esa persona usa en la empresa B.
 *
 * ⚠⚠ Estas rutas cerraban un agujero de dos frentes. `cambiarMiPassword` y
 * `cambiarMiTelefono` estaban escritas y terminadas en `services/cuenta.ts`
 * desde hacía días, **sin una sola ruta que las llamara** — y un comentario en
 * `usuarios.ts` afirmaba que existía `/mi/telefono`, que no existía. Un
 * comentario que nombra una ruta es una afirmación comprobable: se comprueba.
 */
export function registrarRutasPerfil(app: FastifyInstance) {
  /** Qué mostrar en «Tu acceso», incluidos los canales que HOY son posibles. */
  app.get('/mi/acceso', async (req) => {
    const { cuentaId, identidadId } = req.identidad;
    return cuenta.miAcceso(cuentaId, identidadId);
  });

  /** Cambiar la contraseña. Pide la actual: sin eso, una sesión robada es la
   *  cuenta para siempre. */
  app.put('/mi/password', async (req) => {
    const b = z
      .object({ actual: z.string().min(1), nueva: z.string().min(1) })
      .parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return cuenta.cambiarMiPassword(cuentaId, identidadId, b.actual, b.nueva);
  });

  /**
   * Paso 1: mandame el código a este número.
   *
   * ⚠ El número NO se guarda todavía. Sólo viaja el código, y el número entra
   * en el hash del token — así un código pedido para un teléfono no sirve para
   * confirmar otro.
   */
  app.post('/mi/telefono/codigo', async (req) => {
    const b = z
      .object({ password: z.string().min(1), telefono: z.string().min(6).max(24) })
      .parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return cuenta.pedirCodigoDeTelefono(cuentaId, identidadId, b.password, b.telefono);
  });

  /** Paso 2: el código acertado confirma el número y consume la propuesta. */
  app.post('/mi/telefono/confirmar', async (req) => {
    const b = z
      .object({ telefono: z.string().min(6).max(24), codigo: z.string().min(4).max(8) })
      .parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return cuenta.confirmarMiTelefono(cuentaId, identidadId, b.telefono, b.codigo);
  });

  /**
   * Sacar el teléfono. Pide la contraseña, igual que ponerlo: quien tenga tu
   * sesión no puede dejarte sin segundo factor.
   */
  app.delete('/mi/telefono', async (req) => {
    const b = z.object({ password: z.string().min(1) }).parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return cuenta.cambiarMiTelefono(cuentaId, identidadId, b.password, null);
  });

  /** Por dónde querés el código: correo, SMS o WhatsApp. */
  app.put('/mi/canal', async (req) => {
    const b = z.object({ canal: z.enum(['email', 'sms', 'whatsapp']) }).parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return cuenta.elegirMiCanal(cuentaId, identidadId, b.canal);
  });
}
