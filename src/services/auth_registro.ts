import { sql, type Transaction } from 'kysely';
import { db } from '../db/pool';
import { fijarContexto } from '../db/contexto';
import type { DB } from '../db/schema';
import { generarToken, hashToken } from '../auth/token';
import { validarPassword } from '../auth/password';
import { emitirSesion } from '../auth/identity';
import { provisionarCuenta } from '../admin/provisioning';
import { enviarCorreo } from './correo';
import { HttpError } from '../http/errors';

/**
 * Alta de cuenta en dos pasos.
 *
 * ═══ POR QUÉ DOS PASOS, Y NO UNO ═══
 *
 * Porque el de un paso dejaba crear una cuenta **con el correo de otro**.
 *
 * `/auth/registro` era público y no probaba nada. Poniendo el correo de un
 * tercero se conseguían tres cosas: una cuenta de tipo persona con esa persona
 * como titular; el relleno de la bandeja, que le inserta una `ubicacion` por
 * cada documento que firmó en su vida; y una sesión emitida a su nombre. Si
 * además era una identidad latente —alguien a quien invitaron a firmar y nunca
 * se registró— le quedaba fijada la contraseña de quien completó el formulario.
 *
 * ⚠ Nunca hubo filtración de documentos, y entender por qué importa: la sesión
 * del alta nace sin anclaje probado, y `app.tiene_otorgamiento` exige
 * `app.identidad_probada()` contra el anclaje con que se emitió. Sin acceso a
 * esa casilla no se ve nada. La aplicación entregó una sesión que no debía y la
 * capa de datos no se enteró porque no le importa — regla de oro nº2 haciendo
 * exactamente lo que se diseñó que hiciera. No es excusa para dejarlo así.
 *
 * Ahora: se pide el alta, llega un correo, y **recién al abrirlo** existe la
 * cuenta. Hasta ese clic no hay cuenta, ni carpetas, ni roles, ni membresía, ni
 * sesión, ni contraseña. Sólo una identidad latente —la misma que ya crea
 * cualquier invitación a firmar— y una fila en `registro_pendiente`.
 *
 * ═══ ANTI-ENUMERACIÓN ═══
 *
 * `solicitarRegistro` responde **igual exista o no el correo**, igual que
 * `solicitarReset`. Si respondiera distinto, el formulario de alta sería una
 * herramienta pública para averiguar quién usa MiFirma — y en un producto de
 * firma, saber que alguien tiene cuenta ya es información.
 *
 * Eso obliga a que el alta NO devuelva sesión en el primer paso, ni siquiera
 * para un correo nuevo: dos respuestas distintas son dos respuestas distintas
 * aunque las dos digan «ok». Es el costo de la propiedad, y se paga entero.
 */

const TTL_HORAS = 24;
const VENTANA_ANTIABUSO_MS = 60 * 60 * 1000;
const MAX_POR_VENTANA = 3;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface DatosDeAlta {
  nombre: string;
  tipo: 'empresa' | 'persona';
  pais: string;
  razonSocial?: string | null;
  idFiscal?: string | null;
  domicilio?: string | null;
  industriaId?: string | null;
  adminNombre: string;
  email: string;
}

function baseUrl(): string {
  return (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

/**
 * ⚠ `/entrar`, NO `/app`. Ver la nota extensa en `auth_reset.ts`: `/app` es la
 * consola, y sin sesión rebota a `/entrar` perdiendo el fragmento — o sea, el
 * token. Este archivo lo copió mal de allá y falló en la primera prueba real.
 *
 * El token va en el FRAGMENTO y no en la query a propósito: el fragmento no
 * viaja al servidor, así que no queda en los logs ni se filtra por el Referer.
 */
const enlace = (token: string) => `${baseUrl()}/entrar#token=${token}&t=alta`;

function enmascararEmailLog(email: string): string {
  const i = email.indexOf('@');
  return i <= 1 ? '***' : `${email.slice(0, 1)}***${email.slice(i)}`;
}

const escHtml = (s: string) =>
  s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));

/** Contexto de sistema sin cuenta: el alta ocurre antes de que exista ninguna. */
async function enSistema<T>(fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await fijarContexto(trx, { actor: 'sistema' });
    return fn(trx);
  });
}

// ---------------------------------------------------------------------------
// Paso 1: se pide el alta
// ---------------------------------------------------------------------------

export async function solicitarRegistro(
  d: DatosDeAlta,
  ip?: string,
): Promise<{ ok: true }> {
  // ⚠ Los errores de FORMATO sí se informan, y no rompen el anti-enumeración:
  // «ese correo no es válido» no dice nada sobre quién está en el sistema. Lo
  // único que tiene que ser indistinguible es si el correo YA EXISTE.
  const email = d.email.trim();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Ese correo no es válido.');
  if (!d.nombre?.trim()) throw new HttpError(400, 'Falta el nombre.');
  if (!d.adminNombre?.trim()) throw new HttpError(400, 'Falta tu nombre.');
  if (!/^[A-Z]{2}$/.test(d.pais)) throw new HttpError(400, 'Elegí un país.');
  if (d.tipo !== 'empresa' && d.tipo !== 'persona') throw new HttpError(400, 'Tipo de cuenta inválido.');

  const { token, hash } = generarToken();

  const enviar = await enSistema(async (trx) => {
    // La identidad latente se crea igual para un correo nuevo que para uno que
    // ya existe. Es exactamente lo que hace cualquier invitación a firmar, y es
    // lo que permite que las dos ramas se vean iguales desde afuera.
    const r = await sql<{ id: string }>`
      select app.resolver_identidad(${email}) as id
    `.execute(trx);
    const identidadId = r.rows[0]!.id;

    // Tope por identidad: sin esto, el formulario es un cañón de correos
    // apuntado a la casilla de cualquiera. Se omite el envío EN SILENCIO —
    // seguimos devolviendo ok, porque decir «ya te mandamos tres» también
    // delata que ese correo está en el sistema.
    const recientes = await trx
      .selectFrom('registro_pendiente')
      .select('id')
      .where('identidad_id', '=', identidadId)
      .where('creado_en', '>', new Date(Date.now() - VENTANA_ANTIABUSO_MS))
      .execute();
    if (recientes.length >= MAX_POR_VENTANA) return null;

    const tk = await trx
      .insertInto('token_acceso')
      .values({
        identidad_id: identidadId,
        tipo: 'verificacion_email',
        token_hash: hash,
        expira_en: new Date(Date.now() + TTL_HORAS * 3600_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await trx
      .insertInto('registro_pendiente')
      .values({
        token_acceso_id: tk.id,
        identidad_id: identidadId,
        datos: JSON.stringify({
          nombre: d.nombre.trim(),
          tipo: d.tipo,
          pais: d.pais,
          razon_social: d.razonSocial ?? null,
          id_fiscal: d.idFiscal ?? null,
          domicilio: d.domicilio ?? null,
          industria_id: d.industriaId ?? null,
          admin_nombre: d.adminNombre.trim(),
          email,
        }),
        ip_solicitud: ip ?? null,
      })
      .execute();

    return true;
  });

  if (enviar) {
    const que = d.tipo === 'persona' ? 'tu cuenta personal' : `la cuenta de ${escHtml(d.nombre.trim())}`;
    try {
      await enviarCorreo({
        para: email,
        asunto: 'Confirmá tu correo para crear tu cuenta · MiFirma',
        html:
          `<p>Alguien pidió crear ${que} en MiFirma con esta dirección.</p>` +
          `<p><a href="${enlace(token)}">Confirmá que es tuya y elegí tu contraseña</a> ` +
          `(el enlace vence en ${TTL_HORAS} horas).</p>` +
          `<p>Si no fuiste vos, ignorá este correo: <b>no se creó ninguna cuenta</b> y no se ` +
          `va a crear ninguna sin este clic.</p>`,
        texto:
          `Alguien pidió crear una cuenta en MiFirma con esta dirección. ` +
          `Confirmá y elegí tu contraseña: ${enlace(token)} (vence en ${TTL_HORAS} horas). ` +
          `Si no fuiste vos, ignoralo: no se creó ninguna cuenta.`,
      });
    } catch (e) {
      // El fallo de envío queda en el log del servidor con el correo enmascarado,
      // no en la respuesta: el operador puede diagnosticar sin que la respuesta
      // delate nada.
      console.warn('[alta] no se pudo enviar el correo a', enmascararEmailLog(email),
                   '-', e instanceof Error ? e.message : e);
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Paso 2: se confirma
// ---------------------------------------------------------------------------

async function pendientePorToken(token: string) {
  const fila = await enSistema((trx) =>
    trx
      .selectFrom('registro_pendiente as r')
      .innerJoin('token_acceso as t', 't.id', 'r.token_acceso_id')
      .leftJoin('credencial as c', 'c.identidad_id', 'r.identidad_id')
      .select([
        'r.id as id', 'r.identidad_id as identidad_id', 'r.datos as datos',
        't.id as token_id', 't.expira_en as expira_en', 't.usado_en as usado_en',
        'c.hash_password as hash',
      ])
      .where('t.token_hash', '=', hashToken(token))
      .executeTakeFirst(),
  );

  if (!fila || fila.usado_en) {
    throw new HttpError(400, 'El enlace venció o ya se usó. Pedí el alta de nuevo.');
  }
  if (new Date(fila.expira_en).getTime() < Date.now()) {
    await enSistema((trx) =>
      trx.updateTable('token_acceso').set({ usado_en: new Date() })
        .where('id', '=', fila.token_id).execute(),
    );
    throw new HttpError(400, 'El enlace venció. Pedí el alta de nuevo.');
  }
  return fila;
}

/** Qué se está por crear, para pintar la pantalla. No crea nada. */
export async function verRegistro(token: string) {
  const f = await pendientePorToken(token);
  const d = typeof f.datos === 'string' ? JSON.parse(f.datos) : (f.datos as any);
  return {
    email: d.email as string,
    nombre: d.nombre as string,
    tipo: d.tipo as 'empresa' | 'persona',
    // Si ya tiene contraseña, no se le pide otra: esta persona ya entra al
    // sistema y el alta es de una cuenta más, no de su identidad.
    necesita_password: !f.hash,
  };
}

export async function confirmarRegistro(token: string, password: string | undefined, ip?: string) {
  const f = await pendientePorToken(token);
  const d = typeof f.datos === 'string' ? JSON.parse(f.datos) : (f.datos as any);

  if (!f.hash) {
    if (!password) throw new HttpError(400, 'Elegí una contraseña.');
    const err = validarPassword(password);
    if (err) throw new HttpError(400, err);
  }

  // ⚠ El token se quema ANTES de crear nada. Si el alta falla, el enlace ya no
  // sirve y hay que pedirla de nuevo — que es molesto y correcto. Al revés,
  // dos clics simultáneos crearían dos cuentas, y con `cuenta_persona_unica`
  // una de las dos fallaría a mitad de camino dejando basura.
  const quemado = await enSistema(async (trx) => {
    const r = await trx
      .updateTable('token_acceso')
      .set({ usado_en: new Date(), ip_uso: ip ?? null })
      .where('id', '=', f.token_id)
      .where('usado_en', 'is', null)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  });
  if (!quemado) throw new HttpError(400, 'Ese enlace ya se usó.');

  const r = await provisionarCuenta({
    nombre: d.nombre,
    tipo: d.tipo,
    pais: d.pais,
    razonSocial: d.razon_social ?? null,
    idFiscal: d.id_fiscal ?? null,
    domicilio: d.domicilio ?? null,
    industriaId: d.industria_id ?? null,
    admin: {
      email: d.email,
      nombre: d.admin_nombre,
      ...(f.hash ? {} : { password: password! }),
    },
  });

  // ⚠ EL ANCLAJE. Abrir este enlace es la prueba de que esta persona controla
  // ese correo: le llegó ahí y sólo ahí. Es el mismo hecho, con el mismo método
  // y el mismo nivel, que registra `firma.ts` cuando alguien abre un enlace de
  // firma. Sin esto la sesión nacería sin anclaje probado y su bandeja de
  // «Recibidos» se vería VACÍA hasta que cerrara sesión y volviera a entrar,
  // porque `app.tiene_otorgamiento` exige `app.identidad_probada()`.
  const anclajeId = await enSistema(async (trx) => {
    await sql`
      insert into anclaje_identidad (identidad_id, tipo, valor_normalizado,
                                     metodo_prueba, nivel_garantia)
      select ${r.adminIdentidadId}::uuid, 'email', lower(btrim(${d.email})),
             'verificacion_email', 'bajo'
       where not exists (
         select 1 from anclaje_identidad a
          where a.identidad_id = ${r.adminIdentidadId}::uuid and a.tipo = 'email'
            and a.valor_normalizado = lower(btrim(${d.email}))
            and a.revocado_en is null)
    `.execute(trx);

    const q = await sql<{ id: string }>`
      select id from anclaje_identidad
       where identidad_id = ${r.adminIdentidadId}::uuid and tipo = 'email'
         and valor_normalizado = lower(btrim(${d.email})) and revocado_en is null
       limit 1
    `.execute(trx);

    await trx.deleteFrom('registro_pendiente').where('id', '=', f.id).execute();
    return q.rows[0]?.id ?? null;
  });

  const jwt = await emitirSesion(r.cuentaId, r.adminIdentidadId, {
    anclajesProbados: anclajeId ? [anclajeId] : [],
    nivelGarantia: 'bajo',
  });

  return {
    token: jwt,
    cuenta_id: r.cuentaId,
    identidad_id: r.adminIdentidadId,
    cuenta_nombre: d.nombre,
    email: d.email,
  };
}
