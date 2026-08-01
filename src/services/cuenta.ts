import { withUsuario } from '../auth/authz';
import { hashPassword, verifyPassword, validarPassword } from '../auth/password';
import { registrarSistema } from './auditoria';
import { HttpError } from '../http/errors';

/**
 * Perfil propio: contraseña y teléfono.
 *
 * Es self-scoped — sólo toca la identidad del token — así que no exige permiso
 * de administrador. Pide la contraseña actual para que una sesión robada no
 * pueda cambiarla: sin reautenticación, robar la sesión equivale a robar la
 * cuenta para siempre.
 *
 * ⚠ Esto NO lo puede hacer el administrador de la empresa por vos. La
 * credencial y el teléfono son de la identidad, que es global: el admin de la
 * empresa A estaría tocando el acceso que usás en la empresa B. Ver el
 * encabezado de `usuarios.ts`.
 */

export async function cambiarMiPassword(
  cuentaId: string,
  identidadId: string,
  actual: unknown,
  nueva: unknown,
) {
  if (typeof actual !== 'string' || typeof nueva !== 'string') {
    throw new HttpError(400, 'Faltan datos.');
  }
  const err = validarPassword(nueva);
  if (err) throw new HttpError(400, err);

  await withUsuario(cuentaId, identidadId, async (trx) => {
    const c = await trx
      .selectFrom('credencial')
      .select(['identidad_id', 'hash_password'])
      .where('identidad_id', '=', identidadId)
      .executeTakeFirst();
    if (!c) throw new HttpError(404, 'No encontramos tu credencial.');
    if (!c.hash_password) {
      throw new HttpError(
        400,
        'Tu cuenta todavía no tiene contraseña. Usá "¿Olvidaste tu contraseña?" para crear una.',
      );
    }
    if (!verifyPassword(actual, c.hash_password)) {
      throw new HttpError(400, 'La contraseña actual no es correcta.');
    }
    if (verifyPassword(nueva, c.hash_password)) {
      throw new HttpError(400, 'La nueva contraseña tiene que ser distinta de la actual.');
    }

    await trx
      .updateTable('credencial')
      .set({
        hash_password: hashPassword(nueva),
        password_cambiada_en: new Date(),
        intentos_fallidos: 0,
        bloqueada_hasta: null,
      })
      .where('identidad_id', '=', identidadId)
      .execute();

    // Mismo criterio que el reset: cambiar la contraseña revoca los dispositivos
    // de confianza. Si cambiás la clave es porque sospechás de alguien, y ese
    // alguien puede estar sentado en un equipo que ya no pide segundo factor.
    await trx
      .updateTable('dispositivo_confiable')
      .set({ revocado_en: new Date() })
      .where('identidad_id', '=', identidadId)
      .where('revocado_en', 'is', null)
      .execute();
  });

  await registrarSistema(cuentaId, identidadId, {
    accion: 'password.cambiada',
    recursoTipo: 'credencial',
    recursoId: identidadId,
  }, 'usuario');

  return { ok: true };
}

/**
 * Teléfono propio, para el segundo factor.
 *
 * Cambiar el teléfono es cambiar dónde llegan los códigos de acceso, así que
 * también exige la contraseña actual. Sin eso, una sesión robada se redirige el
 * segundo factor y el dueño legítimo queda afuera.
 */
export async function cambiarMiTelefono(
  cuentaId: string,
  identidadId: string,
  password: unknown,
  telefono: string | null,
) {
  if (typeof password !== 'string') throw new HttpError(400, 'Falta tu contraseña actual.');

  const tel = telefono?.trim() || null;
  if (tel && !/^\+[1-9][0-9]{7,14}$/.test(tel.replace(/[\s-]/g, ''))) {
    throw new HttpError(400, 'El teléfono va en formato internacional, por ejemplo +59899123456.');
  }

  await withUsuario(cuentaId, identidadId, async (trx) => {
    const c = await trx
      .selectFrom('credencial')
      .select(['hash_password'])
      .where('identidad_id', '=', identidadId)
      .executeTakeFirst();
    if (!c?.hash_password || !verifyPassword(password, c.hash_password)) {
      throw new HttpError(400, 'La contraseña no es correcta.');
    }
    await trx
      .updateTable('credencial')
      .set({ telefono_e164: tel })
      .where('identidad_id', '=', identidadId)
      .execute();
  });

  await registrarSistema(cuentaId, identidadId, {
    accion: 'perfil.telefono',
    recursoTipo: 'credencial',
    recursoId: identidadId,
    despues: { tiene_telefono: !!tel },
  }, 'usuario');

  return { ok: true, telefono: tel };
}


/**
 * Quién soy y dónde estoy parado.
 *
 * La consola lo necesita para dos cosas: mostrar en qué cuenta estás —quien
 * trabaja para tres empresas necesita verlo, no adivinarlo— y saber qué botones
 * tiene sentido dibujar.
 *
 * ⚠ `capacidades` es para la PANTALLA, no para autorizar. Cada llamada la vuelve
 * a decidir la política RLS con el contexto de la sesión. Un cliente que mienta
 * acá no gana nada.
 */
export async function quienSoy(cuentaId: string, identidadId: string) {
  return withUsuario(cuentaId, identidadId, async (trx, autz) => {
    const i = await trx
      .selectFrom('identidad')
      .select(['email_mostrado', 'nombre_mostrado'])
      .where('id', '=', identidadId)
      .executeTakeFirst();
    const c = await trx
      .selectFrom('cuenta')
      .select(['nombre_mostrado', 'pais', 'moneda', 'idioma', 'tipo'])
      .where('id', '=', cuentaId)
      .executeTakeFirst();

    return {
      identidad_id: identidadId,
      email: i?.email_mostrado ?? null,
      nombre: i?.nombre_mostrado ?? null,
      cuenta_id: cuentaId,
      cuenta_nombre: c?.nombre_mostrado ?? null,
      tipo: c?.tipo ?? null,
      pais: c?.pais ?? null,
      moneda: c?.moneda ?? null,
      idioma: c?.idioma ?? null,
      capacidades: [...autz.capacidades].sort(),
    };
  });
}
