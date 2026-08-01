import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { withUsuario, exigir } from '../auth/authz';
import { db } from '../db/pool';
import { fijarContexto } from '../db/contexto';
import { anotar } from './evidencia';
import { emitirEnlaceFirma, urlDeFirma } from '../auth/enlace_firma';
import { enviarCorreo } from './correo';
import { HttpError } from '../http/errors';

/**
 * El circuito: quién firma, en qué orden, y el acto de despacharlo.
 *
 * ═══ UN SOLO MECANISMO PARA LOS TRES MODOS ═══
 *
 * Serie, paralelo y copias no son tres caminos de código: son el mismo circuito
 * con distinto contenido en `participacion.orden`.
 *
 *   · serie    → órdenes distintas (1, 2, 3): se notifica al 1, y al firmar, al 2
 *   · paralelo → todas con orden 1: se notifica a todas juntas
 *   · copias   → N instancias, cada una con su firmante
 *
 * La regla de despacho es UNA: se notifica a las participaciones cuyo `orden`
 * es el menor entre las pendientes. Eso cubre serie y paralelo sin un `if`.
 * Escribir "si es serie… si es paralelo…" es lo que después obliga a tocar dos
 * lugares cada vez que aparece una variante.
 *
 * ═══ EL FIRMANTE NO TIENE CUENTA, Y ESO ES EL CASO NORMAL ═══
 *
 * Agregar un firmante no crea un usuario: resuelve una IDENTIDAD GLOBAL por
 * correo —que puede existir desde hace años porque otra empresa lo invitó a
 * firmar— y le crea una participación. El acceso se lo da un OTORGAMIENTO
 * emitido al despachar, no una membresía.
 */

const MAX_FIRMANTES = 50;

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

export async function verCircuito(cuentaId: string, identidadId: string, circuitoId: string) {
  return withUsuario(cuentaId, identidadId, async (trx) => {
    const c = await sql<{
      id: string; titulo: string; estado: string; modo: string; nivel_firma: string;
      pais_marco: string; idioma: string; dias_vigencia: number | null;
      vence_en: Date | null; enviado_en: Date | null; politica_rechazo: string;
      instancias: string;
    }>`
      select c.id, c.titulo, c.estado, c.modo, c.nivel_firma, c.pais_marco, c.idioma,
             c.dias_vigencia, c.vence_en, c.enviado_en, c.politica_rechazo,
             (select count(*) from instancia i where i.circuito_id = c.id)::text as instancias
        from circuito c where c.id = ${circuitoId}::uuid
    `.execute(trx);
    if (!c.rows.length) throw new HttpError(404, 'Ese documento no existe o no lo podés ver.');

    const p = await sql<{
      id: string; instancia_id: string; identidad_id: string; email: string;
      nombre: string | null; papel: string; orden: number; estado: string;
      nivel_garantia_minimo: string; firmada_en: Date | null; motivo_rechazo: string | null;
    }>`
      select p.id, p.instancia_id, p.identidad_id,
             i.email_mostrado as email, i.nombre_mostrado as nombre,
             p.papel, p.orden, p.estado, p.nivel_garantia_minimo,
             p.firmada_en, p.motivo_rechazo
        from participacion p
        join identidad i on i.id = p.identidad_id
       where p.circuito_id = ${circuitoId}::uuid
       order by p.orden, i.email_mostrado
    `.execute(trx);

    return { circuito: { ...c.rows[0]!, instancias: Number(c.rows[0]!.instancias) }, participaciones: p.rows };
  });
}

// ---------------------------------------------------------------------------
// Preparación (sólo en borrador)
// ---------------------------------------------------------------------------

export interface FirmanteInput {
  email: string;
  nombre?: string | null;
  papel?: 'firmante' | 'veedor' | 'copia';
  orden?: number;
  nivelGarantiaMinimo?: 'bajo' | 'sustancial' | 'alto';
}

export async function agregarFirmante(
  cuentaId: string,
  identidadId: string,
  circuitoId: string,
  input: FirmanteInput,
) {
  const email = (input.email || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Ese correo no es válido.');

  return withUsuario(cuentaId, identidadId, async (trx, autz) => {
    exigir(autz, 'circuito', 'crear', 'No tenés permiso para preparar circuitos de firma.');
    const c = await exigirBorrador(trx, circuitoId, cuentaId);

    if (c.modo === 'copias') {
      throw new HttpError(
        400,
        'El envío masivo se prepara desde una planilla, no agregando firmantes de a uno.',
      );
    }

    const cuantos = await sql<{ n: string }>`
      select count(*)::text as n from participacion where circuito_id = ${circuitoId}::uuid
    `.execute(trx);
    if (Number(cuantos.rows[0]?.n ?? 0) >= MAX_FIRMANTES) {
      throw new HttpError(400, `Un circuito no puede tener más de ${MAX_FIRMANTES} participantes.`);
    }

    // Identidad GLOBAL. Puede existir desde antes: alguien a quien otra empresa
    // invitó a firmar hace un año ya tiene la suya, en estado 'latente'. No se
    // duplica ni se migra nada.
    const res = await sql<{ id: string }>`select app.resolver_identidad(${email}) as id`.execute(trx);
    const destino = res.rows[0]?.id;
    if (!destino) throw new HttpError(500, 'No se pudo resolver la identidad del firmante.');

    if (input.nombre) {
      // Sólo si todavía no tiene nombre: el emisor sugiere cómo se llama quien
      // firma, pero no puede renombrar a una persona que ya existe en el
      // sistema y que quizá se registró con otro nombre.
      await sql`
        update identidad set nombre_mostrado = ${input.nombre}
         where id = ${destino}::uuid and nombre_mostrado is null
      `.execute(trx);
    }

    const instancias = await sql<{ id: string }>`
      select id from instancia where circuito_id = ${circuitoId}::uuid order by numero
    `.execute(trx);

    const papel = input.papel ?? 'firmante';
    const orden = input.orden ?? 1;
    const creadas: string[] = [];

    for (const inst of instancias.rows) {
      const id = randomUUID();
      try {
        await sql`
          insert into participacion (id, instancia_id, circuito_id, cuenta_propietaria_id,
                                     identidad_id, papel, orden, nivel_garantia_minimo)
          values (${id}::uuid, ${inst.id}::uuid, ${circuitoId}::uuid, ${cuentaId}::uuid,
                  ${destino}::uuid, ${papel}, ${orden}, ${input.nivelGarantiaMinimo ?? 'bajo'})
        `.execute(trx);
        creadas.push(id);
      } catch (e: any) {
        if (e?.code === '23505') {
          throw new HttpError(409, 'Esa persona ya está en este circuito con ese papel.');
        }
        throw e;
      }
    }

    return { participacion_id: creadas[0], identidad_id: destino, email, papel, orden };
  });
}

export async function quitarFirmante(
  cuentaId: string,
  identidadId: string,
  circuitoId: string,
  participacionId: string,
) {
  return withUsuario(cuentaId, identidadId, async (trx, autz) => {
    exigir(autz, 'circuito', 'crear', 'No tenés permiso para preparar circuitos de firma.');
    await exigirBorrador(trx, circuitoId, cuentaId);

    const r = await sql<{ identidad_id: string }>`
      delete from participacion
       where id = ${participacionId}::uuid and circuito_id = ${circuitoId}::uuid
      returning identidad_id
    `.execute(trx);
    if (!r.rows.length) throw new HttpError(404, 'Esa participación no existe en este circuito.');

    // Se borran también las del resto de las instancias (mismo identidad+papel),
    // porque en la pantalla el emisor agregó "una persona", no "una fila".
    await sql`
      delete from participacion
       where circuito_id = ${circuitoId}::uuid and identidad_id = ${r.rows[0]!.identidad_id}::uuid
    `.execute(trx);
    return { ok: true };
  });
}

export interface ConfigCircuito {
  titulo?: string;
  modo?: 'serie' | 'paralelo';
  nivelFirma?: 'simple' | 'avanzada';
  diasVigencia?: number | null;
  politicaRechazo?: 'bloqueante' | 'continua';
}

export async function configurarCircuito(
  cuentaId: string,
  identidadId: string,
  circuitoId: string,
  cfg: ConfigCircuito,
) {
  return withUsuario(cuentaId, identidadId, async (trx, autz) => {
    exigir(autz, 'circuito', 'crear', 'No tenés permiso para preparar circuitos de firma.');
    const c = await exigirBorrador(trx, circuitoId, cuentaId);

    await sql`
      update circuito set
        titulo           = coalesce(${cfg.titulo ?? null}, titulo),
        modo             = coalesce(${cfg.modo ?? null}, modo),
        nivel_firma      = coalesce(${cfg.nivelFirma ?? null}, nivel_firma),
        dias_vigencia    = ${cfg.diasVigencia === undefined ? sql`dias_vigencia` : cfg.diasVigencia},
        politica_rechazo = coalesce(${cfg.politicaRechazo ?? null}, politica_rechazo)
       where id = ${circuitoId}::uuid
    `.execute(trx);

    // Pasar a paralelo aplana los órdenes: si quedaran los de serie, el despacho
    // notificaría sólo al primero y el emisor creería que salió para todos.
    if (cfg.modo === 'paralelo' && c.modo !== 'paralelo') {
      await sql`update participacion set orden = 1 where circuito_id = ${circuitoId}::uuid`.execute(trx);
    }
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Despacho
// ---------------------------------------------------------------------------

/**
 * Despachar: el momento en que el documento sale del borrador y se le pide a
 * alguien que firme.
 *
 * Todo lo que decide derechos ocurre en UNA transacción —estado, otorgamientos,
 * evidencia—. Los correos salen después: mandar mail dentro de la transacción
 * la deja abierta a merced de un servidor SMTP lento, y si el envío falla no se
 * puede deshacer el mail ya entregado. Cada notificación se anota en el
 * expediente cuando efectivamente salió, con su propio evento.
 */
export async function despachar(
  cuentaId: string,
  identidadId: string,
  circuitoId: string,
  ctx: { ip?: string | null; userAgent?: string | null } = {},
) {
  const preparado = await withUsuario(cuentaId, identidadId, async (trx, autz) => {
    exigir(autz, 'circuito', 'enviar', 'No tenés permiso para enviar documentos a firmar.');
    const c = await exigirBorrador(trx, circuitoId, cuentaId);

    const parts = await sql<{
      id: string; instancia_id: string; identidad_id: string; papel: string; orden: number;
      email: string; nombre: string | null;
    }>`
      select p.id, p.instancia_id, p.identidad_id, p.papel, p.orden,
             i.email_mostrado as email, i.nombre_mostrado as nombre
        from participacion p
        join identidad i on i.id = p.identidad_id
       where p.circuito_id = ${circuitoId}::uuid
       order by p.orden
    `.execute(trx);

    const firmantes = parts.rows.filter((p) => p.papel === 'firmante');
    if (!firmantes.length) {
      throw new HttpError(400, 'Agregá al menos un firmante antes de enviarlo.');
    }

    const vence = c.dias_vigencia
      ? sql`now() + (${c.dias_vigencia} || ' days')::interval`
      : sql`null`;

    await sql`
      update circuito
         set estado = 'enviado', enviado_en = now(), vence_en = ${vence}
       where id = ${circuitoId}::uuid
    `.execute(trx);

    await sql`
      update instancia set estado = 'en_curso'
       where circuito_id = ${circuitoId}::uuid and estado = 'pendiente'
    `.execute(trx);

    // Un otorgamiento por participación, sobre la INSTANCIA que le toca.
    //
    // `anclaje_destino_id` queda en null a propósito: emitirlo contra un anclaje
    // de correo exigiría que ese anclaje exista, y todavía no existe porque
    // nadie probó nada. Un anclaje es una prueba, no un dato que escribimos
    // nosotros al mandar un mail. Se crea cuando la persona abre el enlace, que
    // es el momento en que el control del correo queda demostrado.
    const enlaces: {
      participacionId: string; otorgamientoId: string; identidadId: string;
      instanciaId: string; email: string; nombre: string | null; orden: number;
    }[] = [];

    for (const p of parts.rows) {
      const alcances =
        p.papel === 'firmante'
          ? ['metadatos', 'leer', 'firmar', 'evidencia']
          : ['metadatos', 'leer'];
      const oid = randomUUID();
      await sql`
        insert into otorgamiento (id, instancia_id, identidad_id, alcances,
                                  origen, otorgado_por, cuenta_otorgante_id)
        values (${oid}::uuid, ${p.instancia_id}::uuid, ${p.identidad_id}::uuid,
                ${alcances}::text[], 'participacion', ${identidadId}::uuid, ${cuentaId}::uuid)
      `.execute(trx);

      enlaces.push({
        participacionId: p.id,
        otorgamientoId: oid,
        identidadId: p.identidad_id,
        instanciaId: p.instancia_id,
        email: p.email,
        nombre: p.nombre,
        orden: p.orden,
      });
    }

    const instancias = [...new Set(parts.rows.map((p) => p.instancia_id))];
    for (const instanciaId of instancias) {
      await anotar(trx, {
        instanciaId,
        circuitoId,
        cuentaPropietariaId: cuentaId,
        tipo: 'circuito.despachado',
        actorTipo: 'emisor',
        identidadId,
        datos: {
          modo: c.modo,
          nivel_firma: c.nivel_firma,
          firmantes: firmantes.length,
          dias_vigencia: c.dias_vigencia,
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        canal: 'web',
      });
    }

    // LA REGLA ÚNICA: se notifica al orden más bajo. En paralelo son todos.
    const minOrden = Math.min(...enlaces.map((e) => e.orden));
    return {
      titulo: c.titulo,
      cuentaNombre: c.cuenta_nombre,
      idioma: c.idioma,
      aNotificar: enlaces.filter((e) => e.orden === minOrden),
      total: enlaces.length,
    };
  });

  const resultados = await Promise.all(
    preparado.aNotificar.map((e) => notificar(cuentaId, circuitoId, preparado, e)),
  );

  return {
    ok: true,
    notificados: resultados.filter((r) => r.ok).length,
    fallidos: resultados.filter((r) => !r.ok),
  };
}

/**
 * Manda el correo y lo anota. Fuera de la transacción del despacho: que un
 * servidor SMTP caído impida despachar sería peor que un documento enviado con
 * una notificación que hay que reintentar.
 */
async function notificar(
  cuentaId: string,
  circuitoId: string,
  info: { titulo: string; cuentaNombre: string; idioma: string },
  e: { participacionId: string; otorgamientoId: string; identidadId: string; instanciaId: string; email: string; nombre: string | null },
): Promise<{ ok: boolean; email: string; error?: string }> {
  let error: string | null = null;
  try {
    const token = await emitirEnlaceFirma({
      otorgamientoId: e.otorgamientoId,
      identidadId: e.identidadId,
      participacionId: e.participacionId,
    });
    const url = urlDeFirma(token);
    const quien = e.nombre ? `Hola ${escapar(e.nombre)},` : 'Hola,';

    await enviarCorreo({
      para: e.email,
      asunto: `${info.cuentaNombre} te pide que firmes: ${info.titulo}`,
      html:
        `<p>${quien}</p>` +
        `<p><b>${escapar(info.cuentaNombre)}</b> te envió un documento para firmar: ` +
        `<b>${escapar(info.titulo)}</b>.</p>` +
        `<p><a href="${url}" style="display:inline-block;background:#0B2B4A;color:#fff;` +
        `padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:600">Ver y firmar</a></p>` +
        `<p style="color:#5a6878;font-size:13px">No hace falta que crees una cuenta. ` +
        `Este enlace es personal: no se lo reenvíes a nadie.</p>`,
      texto:
        `${info.cuentaNombre} te envió un documento para firmar: ${info.titulo}\n\n${url}\n\n` +
        `No hace falta crear una cuenta. Este enlace es personal.`,
    });
  } catch (err) {
    error = err instanceof Error ? err.message : 'error desconocido';
  }

  // El resultado va al expediente en los dos casos. Que una notificación no
  // haya salido es parte de la historia del documento: si el firmante dice que
  // nunca le llegó, el expediente tiene que poder decir si salió o no.
  await enSistema(async (trx) => {
    await anotar(trx, {
      instanciaId: e.instanciaId,
      circuitoId,
      cuentaPropietariaId: cuentaId,
      tipo: error ? 'notificacion.fallida' : 'notificacion.enviada',
      actorTipo: 'sistema',
      identidadId: e.identidadId,
      participacionId: e.participacionId,
      datos: { canal: 'email', destino: enmascarar(e.email), error },
      canal: 'email',
    });
    if (!error) {
      await sql`
        update participacion set estado = 'notificada'
         where id = ${e.participacionId}::uuid and estado = 'pendiente'
      `.execute(trx);
    }
  });

  return error ? { ok: false, email: e.email, error } : { ok: true, email: e.email };
}

// ---------------------------------------------------------------------------
// Internos
// ---------------------------------------------------------------------------

/** Contexto de sistema: sin cuenta ni identidad. Para lo que ocurre después de
 *  la request, cuando ya no hay usuario mirando. */
async function enSistema<T>(fn: (trx: any) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await fijarContexto(trx, { actor: 'sistema' });
    return fn(trx);
  });
}

async function exigirBorrador(trx: any, circuitoId: string, cuentaId: string) {
  const r = await sql<{
    id: string; estado: string; modo: string; titulo: string; idioma: string;
    nivel_firma: string; dias_vigencia: number | null; cuenta_nombre: string;
  }>`
    select c.id, c.estado, c.modo, c.titulo, c.idioma, c.nivel_firma, c.dias_vigencia,
           cu.nombre_mostrado as cuenta_nombre
      from circuito c
      join cuenta cu on cu.id = c.cuenta_propietaria_id
     where c.id = ${circuitoId}::uuid and c.cuenta_propietaria_id = ${cuentaId}::uuid
  `.execute(trx);

  const c = r.rows[0];
  if (!c) throw new HttpError(404, 'Ese documento no existe o no lo podés ver.');
  if (c.estado !== 'borrador') {
    // Es una regla del negocio y también del esquema: el trigger
    // `circuito_congelado` rechaza cualquier cambio después del despacho. Acá se
    // corta antes para dar un mensaje que se entienda.
    throw new HttpError(409, 'Este documento ya se envió: el camino de firmas no se puede cambiar.');
  }
  return c;
}

function escapar(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

/** En el expediente el destino va enmascarado: el expediente lo pueden leer
 *  varias personas y el correo completo de un firmante es dato de él, no del
 *  resto de los participantes. */
function enmascarar(email: string): string {
  const [u, d] = email.split('@');
  if (!d) return '***';
  return `${(u ?? '').slice(0, 2)}***@${d}`;
}
