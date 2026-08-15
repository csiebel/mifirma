import { createHash, randomInt } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { db } from '../db/pool';
import type { DB } from '../db/schema';
import { withUsuario } from '../auth/authz';
import { hashPassword, verifyPassword, validarPassword } from '../auth/password';
import { registrarSistema } from './auditoria';
import { HttpError } from '../http/errors';
import { enviarOtpPorTwilio, twilioActivo } from './twilio';

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

/* ===========================================================================
   EL TELÉFONO: PROPUESTO vs. CONFIRMADO  (migración 061)

   ⚠⚠ Por qué hay dos columnas y no una. `auth_login.ts` lee
   `credencial.telefono_e164` DERECHO para mandar el código de acceso — tres
   lugares, sin condición ninguna. O sea que **cualquier número que quede ahí
   es una llave de esa cuenta**.

   Claudio pidió que el administrador pueda cargarle el celular a su gente.
   Escrito en `telefono_e164`, eso sería regalarle el acceso: pone su propio
   número, pide el código y entra como cualquiera de ellos — incluida gente que
   firma documentos con valor legal.

   Por eso lo que carga el admin va a `telefono_propuesto_e164`, que **no
   habilita nada**: es un dato para que la persona no tenga que tipearlo. Pasa a
   ser un teléfono de verdad cuando su dueño lo confirma con su contraseña y un
   código, y en ese mismo movimiento la propuesta se consume.

   La base lo hace cumplir con un trigger, no con buena voluntad de este
   archivo: ver la 061.
   =========================================================================== */

/**
 * Modo sistema, sólo para `token_acceso`.
 *
 * ⚠⚠ POR QUÉ HACE FALTA. La política de esa tabla (011) es
 * `with check (app.actor() = 'sistema')`: **los códigos y enlaces los emite el
 * sistema, nunca un usuario**. Es a propósito — ahí viven las invitaciones, el
 * recupero de contraseña y los códigos de entrada.
 *
 * La 061 agregó el tipo `confirmar_telefono` a esa tabla y nadie miró esa
 * política. Resultado: **«Tu acceso» nunca pudo confirmar un teléfono**. Pedir
 * el código reventaba con 500 (un `insert` que viola la política SÍ grita), y
 * el paso siguiente hubiera fallado callado: el `select` no viola nada, sólo
 * devuelve cero filas, así que el código correcto habría dado *«el código no es
 * correcto o ya venció»* para siempre. Encontrado el 15/8/2026, probando con la
 * contraseña — el único tramo que no se había probado.
 *
 * ⚠ Lo que NO cambia: la contraseña se verifica ANTES, con `withUsuario`, y ahí
 * la RLS garantiza que sólo se puede leer la credencial propia. El modo sistema
 * empieza después de esa verificación y toca **una sola tabla**.
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

const TTL_CONFIRMACION_MIN = 10;

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

/** Seis dígitos, del generador criptográfico y no de `Math.random`. */
const codigoDe6 = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

const E164 = /^\+[1-9][0-9]{7,14}$/;

function normalizarTelefono(valor: unknown): string {
  if (typeof valor !== 'string') throw new HttpError(400, 'Falta el teléfono.');
  const tel = valor.trim().replace(/[\s-]/g, '');
  if (!E164.test(tel)) {
    throw new HttpError(400, 'El teléfono va en formato internacional, por ejemplo +59899123456.');
  }
  return tel;
}

/**
 * Qué mostrarle a la persona en «Tu acceso».
 *
 * ⚠ Devuelve qué canales son POSIBLES, no cuáles existen en teoría: SMS y
 * WhatsApp piden un teléfono confirmado **y** que el operador tenga ese canal
 * conectado. Ofrecer en la pantalla algo que después no va a salir es la forma
 * más rápida de que alguien se quede esperando un código que nunca se mandó.
 */
export async function miAcceso(cuentaId: string, identidadId: string) {
  const c = await withUsuario(cuentaId, identidadId, async (trx) =>
    trx
      .selectFrom('credencial')
      .select([
        'telefono_e164',
        'telefono_propuesto_e164',
        'otp_canal',
        'hash_password',
        'password_cambiada_en',
      ])
      .where('identidad_id', '=', identidadId)
      .executeTakeFirst(),
  );

  const tw = await twilioActivo().catch(() => null);
  const canales: Array<'email' | 'sms' | 'whatsapp'> = ['email']; // el respaldo, siempre
  if (c?.telefono_e164) {
    if (tw?.from_sms) canales.push('sms');
    if (tw?.from_whatsapp) canales.push('whatsapp');
  }

  return {
    tiene_password: !!c?.hash_password,
    password_cambiada_en: c?.password_cambiada_en ?? null,
    telefono: c?.telefono_e164 ?? null,
    telefono_propuesto: c?.telefono_propuesto_e164 ?? null,
    // Tres estados, y cada uno pide algo distinto de la persona.
    estado_telefono: c?.telefono_e164
      ? ('confirmado' as const)
      : c?.telefono_propuesto_e164
        ? ('propuesto' as const)
        : ('sin_telefono' as const),
    otp_canal: c?.otp_canal ?? 'email',
    canales_posibles: canales,
  };
}

/**
 * Paso 1 de la confirmación: manda el código al número que se quiere confirmar.
 *
 * Exige la contraseña actual por lo mismo que `cambiarMiTelefono`: cambiar el
 * teléfono es cambiar dónde llegan los códigos de acceso, y sin reautenticar,
 * una sesión robada se redirige el segundo factor y deja al dueño afuera.
 *
 * ⚠ El código viaja en `token_acceso` con tipo `confirmar_telefono`, **no en
 * `otp_login`**: un código para confirmar un teléfono no puede servir para
 * entrar. Ver el §3 de la 061.
 */
export async function pedirCodigoDeTelefono(
  cuentaId: string,
  identidadId: string,
  password: unknown,
  telefono: unknown,
) {
  if (typeof password !== 'string') throw new HttpError(400, 'Falta tu contraseña actual.');
  const tel = normalizarTelefono(telefono);
  const codigo = codigoDe6();

  await withUsuario(cuentaId, identidadId, async (trx) => {
    const c = await trx
      .selectFrom('credencial')
      .select(['hash_password'])
      .where('identidad_id', '=', identidadId)
      .executeTakeFirst();
    if (!c?.hash_password || !verifyPassword(password, c.hash_password)) {
      throw new HttpError(400, 'La contraseña no es correcta.');
    }
  });

  // ⚠ La contraseña ya quedó verificada arriba, leyendo la credencial CON RLS
  // (sólo se puede leer la propia). Recién ahora el sistema emite el código.
  await enSistema(async (trx) => {
    // Uno vigente por vez: pedir otro invalida el anterior.
    await trx
      .updateTable('token_acceso')
      .set({ usado_en: new Date() })
      .where('identidad_id', '=', identidadId)
      .where('tipo', '=', 'confirmar_telefono')
      .where('usado_en', 'is', null)
      .execute();

    await trx
      .insertInto('token_acceso')
      .values({
        identidad_id: identidadId,
        cuenta_id: cuentaId,
        tipo: 'confirmar_telefono',
        // ⚠ El hash lleva el NÚMERO adentro: así un código pedido para un
        // teléfono no sirve para confirmar otro. Sin esto, alguien podría
        // pedir el código a su propio celular y confirmar el ajeno.
        token_hash: hashToken(codigo + '|' + tel),
        expira_en: new Date(Date.now() + TTL_CONFIRMACION_MIN * 60000),
      })
      .execute();

  });

  const tw = await twilioActivo().catch(() => null);
  const porDonde: 'sms' | 'whatsapp' | null = tw?.from_sms
    ? 'sms'
    : tw?.from_whatsapp
      ? 'whatsapp'
      : null;

  // ⚠ El código va al TELÉFONO que se quiere confirmar, nunca al correo: lo que
  // se está probando es que ese aparato es de esta persona. Mandarlo por correo
  // probaría el correo, que ya estaba probado.
  if (!porDonde) {
    throw new HttpError(
      503,
      'Todavía no podemos mandar mensajes al celular. Escribinos y lo activamos.',
    );
  }
  await enviarOtpPorTwilio(porDonde, tel, codigo, TTL_CONFIRMACION_MIN, 'confirmar_telefono');

  await registrarSistema(cuentaId, identidadId, {
    accion: 'perfil.telefono_codigo',
    recursoTipo: 'credencial',
    recursoId: identidadId,
    despues: { canal: porDonde, minutos: TTL_CONFIRMACION_MIN },
  }, 'usuario');

  return { ok: true, canal: porDonde, vence_en_minutos: TTL_CONFIRMACION_MIN };
}

/**
 * Paso 2: el código acertado mueve el número de propuesto a confirmado.
 *
 * ⚠ La propuesta se consume en el MISMO update. El trigger de la 061 lo exige,
 * y la razón es que un número propuesto que sobreviva a la confirmación es un
 * fantasma: nadie sabría si ya se usó o está esperando.
 */
export async function confirmarMiTelefono(
  cuentaId: string,
  identidadId: string,
  telefono: unknown,
  codigo: unknown,
) {
  const tel = normalizarTelefono(telefono);
  if (typeof codigo !== 'string' || !/^[0-9]{6}$/.test(codigo.trim())) {
    throw new HttpError(400, 'El código son seis números.');
  }
  const hash = hashToken(codigo.trim() + '|' + tel);

  // ⚠ Buscar y consumir el código va en modo sistema por la misma política que
  // impide emitirlo. Y acá el fallo sería MUDO: la RLS no rompe un `select`,
  // sólo lo deja sin filas — el código bueno diría «no es correcto» para
  // siempre. El identidad_id del `where` sale de la sesión, no del pedido.
  await enSistema(async (trx) => {
    const t = await trx
      .selectFrom('token_acceso')
      .select(['id', 'expira_en'])
      .where('identidad_id', '=', identidadId)
      .where('tipo', '=', 'confirmar_telefono')
      .where('token_hash', '=', hash)
      .where('usado_en', 'is', null)
      .executeTakeFirst();

    // El mismo mensaje para «no existe» y «venció»: distinguirlos le diría a
    // quien prueba códigos cuáles estuvieron cerca.
    if (!t || new Date(t.expira_en) < new Date()) {
      throw new HttpError(400, 'El código no es correcto o ya venció. Pedí uno nuevo.');
    }

    await trx
      .updateTable('token_acceso')
      .set({ usado_en: new Date() })
      .where('id', '=', t.id)
      .execute();
  });

  // ⚠ El teléfono se escribe CON RLS, no en modo sistema: `credencial_update`
  // (009) exige que sea la propia identidad, y eso es justo la promesa de la
  // 061. El modo sistema se usa para la tabla de códigos y para nada más.
  await withUsuario(cuentaId, identidadId, async (trx) => {
    await trx
      .updateTable('credencial')
      .set({ telefono_e164: tel, telefono_propuesto_e164: null })
      .where('identidad_id', '=', identidadId)
      .execute();
  });

  await registrarSistema(cuentaId, identidadId, {
    accion: 'perfil.telefono_confirmado',
    recursoTipo: 'credencial',
    recursoId: identidadId,
    despues: { tiene_telefono: true },
  }, 'usuario');

  return { ok: true, telefono: tel };
}

/**
 * Por dónde quiere recibir el código de acceso.
 *
 * ⚠ El correo no se puede apagar y por eso no hace falta protegerlo: es el
 * respaldo. Lo que sí se comprueba es lo contrario — que no elija un canal que
 * hoy no puede funcionar, porque entonces se quedaría esperando un código que
 * nunca sale.
 */
export async function elegirMiCanal(
  cuentaId: string,
  identidadId: string,
  canal: unknown,
) {
  if (canal !== 'email' && canal !== 'sms' && canal !== 'whatsapp') {
    throw new HttpError(400, 'Ese canal no existe.');
  }

  if (canal !== 'email') {
    const estado = await miAcceso(cuentaId, identidadId);
    if (!estado.canales_posibles.includes(canal)) {
      throw new HttpError(
        400,
        estado.estado_telefono === 'confirmado'
          ? 'Ese canal todavía no está conectado. Elegí otro.'
          : 'Antes de recibir el código por ahí, confirmá tu celular.',
      );
    }
  }

  await withUsuario(cuentaId, identidadId, async (trx) => {
    await trx
      .updateTable('credencial')
      .set({ otp_canal: canal })
      .where('identidad_id', '=', identidadId)
      .execute();
  });

  await registrarSistema(cuentaId, identidadId, {
    accion: 'perfil.canal_otp',
    recursoTipo: 'credencial',
    recursoId: identidadId,
    despues: { canal },
  }, 'usuario');

  return { ok: true, otp_canal: canal };
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
