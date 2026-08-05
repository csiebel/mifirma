import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { withUsuario, exigir } from '../auth/authz';
import { db } from '../db/pool';
import { fijarContexto } from '../db/contexto';
import { anotar } from './evidencia';
import { registrar, registrarSistema } from './auditoria';
import { emitirEnlaceFirma, urlDeFirma } from '../auth/enlace_firma';
import { enviarCorreo } from './correo';
import { avisar } from './mensajes';
import { almacen } from '../almacenamiento/almacen';
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
      instancias: string; instancia_id: string | null;
    }>`
      select c.id, c.titulo, c.estado, c.modo, c.nivel_firma, c.pais_marco, c.idioma,
             c.dias_vigencia, c.vence_en, c.enviado_en, c.politica_rechazo,
             (select count(*) from instancia i where i.circuito_id = c.id)::text as instancias,
             -- ⚠ La primera instancia, para poder ABRIR EL PDF desde la pantalla de
             -- preparación: el archivo se pide por instancia y el editor de cajas
             -- necesita mostrar la hoja.
             --
             -- Antes esto salía de participaciones[0].instancia_id, que funciona
             -- hasta que el documento todavía no tiene ningún firmante — que es
             -- justo cuando uno abre la preparación por primera vez. Un dato que
             -- existe desde que se sube el documento no puede depender de que ya
             -- haya alguien a quien mandárselo.
             --
             -- En modo copias hay una instancia por destinatario; se toma la
             -- primera porque todas comparten el mismo archivo base, que es lo
             -- único que este uso necesita.
             (select i.id from instancia i where i.circuito_id = c.id
               order by i.numero limit 1) as instancia_id
        from circuito c where c.id = ${circuitoId}::uuid
    `.execute(trx);
    if (!c.rows.length) throw new HttpError(404, 'Ese documento no existe o no lo podés ver.');

    const p = await sql<{
      id: string; instancia_id: string; identidad_id: string; email: string;
      nombre: string | null; papel: string; orden: number; estado: string;
      nivel_garantia_minimo: string; firmada_en: Date | null; motivo_rechazo: string | null;
      aviso_en: Date | null; aviso_error: string | null; abierto_en: Date | null;
      caracter: string | null; cuenta_representada_id: string | null;
      representada: string | null;
    }>`
      select p.id, p.instancia_id, p.identidad_id,
             i.email_mostrado as email, i.nombre_mostrado as nombre,
             p.papel, p.orden, p.estado, p.nivel_garantia_minimo,
             p.firmada_en, p.motivo_rechazo,
             p.caracter, p.cuenta_representada_id,
             -- ⚠ LEFT JOIN, no subconsulta con INNER: si la política no
             -- alcanzara esa cuenta se pierde el NOMBRE, no el firmante.
             -- Es la lección §19 del 3 de agosto, aplicada de entrada.
             (select cr.nombre_mostrado from cuenta cr
               where cr.id = p.cuenta_representada_id) as representada,

             -- EL AVISO: cuándo salió, o por qué no.
             --
             -- No se puede deducir del estado. 'pendiente' significa dos cosas
             -- muy distintas —«todavía no le toca» y «le tocaba y el correo
             -- falló»— y la diferencia es lo único que le dice al emisor si
             -- tiene que esperar o levantar el teléfono.
             --
             -- Sale del EXPEDIENTE, que es donde ya se anotaba: notificar()
             -- escribe notificacion.enviada o notificacion.fallida por
             -- participación desde el principio. No hacía falta guardar nada
             -- nuevo, hacía falta mostrarlo.
             --
             -- ⚠ Subconsultas escalares y no join: si una política no alcanzara
             -- a la evidencia, se pierde el dato del aviso, no el firmante.
             -- Lección del 1 de agosto.
             (select max(ev.ocurrido_en) from evidencia ev
               where ev.participacion_id = p.id
                 and ev.tipo = 'notificacion.enviada') as aviso_en,

             -- El último fallo, sólo si NO hubo un envío bueno después. Un
             -- reintento que funcionó no deja al firmante en rojo para siempre.
             (select ev.datos->>'error' from evidencia ev
               where ev.participacion_id = p.id
                 and ev.tipo = 'notificacion.fallida'
                 and ev.ocurrido_en > coalesce(
                       (select max(e2.ocurrido_en) from evidencia e2
                         where e2.participacion_id = p.id
                           and e2.tipo = 'notificacion.enviada'),
                       '-infinity'::timestamptz)
               order by ev.ocurrido_en desc limit 1) as aviso_error,

             -- Cuándo lo abrió. 'vista' dice que lo abrió; no dice cuándo, y
             -- «lo abrió hace diez días y no firmó» es otra conversación que
             -- «lo abrió recién».
             (select min(ev.ocurrido_en) from evidencia ev
               where ev.participacion_id = p.id
                 and ev.tipo = 'documento.abierto') as abierto_en
        from participacion p
        join identidad i on i.id = p.identidad_id
       where p.circuito_id = ${circuitoId}::uuid
       order by p.orden, i.email_mostrado
    `.execute(trx);

    // Las empresas que se pueden nombrar como representadas. La pantalla no las
    // puede inventar: son la cuenta emisora y aquellas donde algún firmante
    // tenga membresía activa. Van con el id del firmante para que el selector de
    // cada fila muestre sólo lo que vale para esa persona.
    const rep = await sql<{ identidad_id: string; cuenta_id: string; nombre: string }>`
      select p.identidad_id, cu.id as cuenta_id, cu.nombre_mostrado as nombre
        from participacion p
        join cuenta cu on cu.tipo = 'empresa' and cu.estado <> 'cerrada'
       where p.circuito_id = ${circuitoId}::uuid
         and p.papel = 'firmante'
         and app.puede_representar(p.identidad_id, cu.id)
       group by p.identidad_id, cu.id, cu.nombre_mostrado
       order by cu.nombre_mostrado
    `.execute(trx);

    return {
      circuito: { ...c.rows[0]!, instancias: Number(c.rows[0]!.instancias) },
      participaciones: p.rows,
      representables: rep.rows,
    };
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
  /**
   * Con qué carácter firma. `null` = todavía sin decidir, y así se queda hasta
   * que alguien lo elija: el trigger de la 045 no deja despachar sin esto.
   * No hay default porque no hay default seguro — ver `propiedad-y-otorgamientos.md` §7.2.
   */
  caracter?: 'personal' | 'representacion' | null;
  cuentaRepresentadaId?: string | null;
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

    // ⚠ Una copia informativa no firma, así que no tiene carácter que elegir:
    // se marca 'personal' para que no frene el despacho. A un firmante NO se le
    // pone nada: queda en null hasta que alguien decida, y ésa es la decisión.
    const caracter = papel === 'firmante' ? (input.caracter ?? null) : 'personal';

    if (caracter === 'representacion') {
      if (!input.cuentaRepresentadaId) {
        throw new HttpError(400, 'Decime a qué empresa representa.');
      }
      const ok = await sql<{ puede: boolean }>`
        select app.puede_representar(${destino}::uuid, ${input.cuentaRepresentadaId}::uuid) as puede
      `.execute(trx);
      if (!ok.rows[0]?.puede) {
        throw new HttpError(
          403,
          'No podés declarar que esa persona firma en representación de esa empresa. ' +
            'Sólo vale tu propia cuenta, o una donde esa persona sea miembro activo.',
        );
      }
    }

    const creadas: string[] = [];

    for (const inst of instancias.rows) {
      const id = randomUUID();
      try {
        await sql`
          insert into participacion (id, instancia_id, circuito_id, cuenta_propietaria_id,
                                     identidad_id, papel, orden, nivel_garantia_minimo,
                                     caracter, cuenta_representada_id)
          values (${id}::uuid, ${inst.id}::uuid, ${circuitoId}::uuid, ${cuentaId}::uuid,
                  ${destino}::uuid, ${papel}, ${orden}, ${input.nivelGarantiaMinimo ?? 'bajo'},
                  ${caracter}, ${caracter === 'representacion' ? input.cuentaRepresentadaId ?? null : null})
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

/**
 * Cambia el orden en que firman, y compacta la numeración.
 *
 * ═══ POR QUÉ RECIBE LA LISTA ENTERA Y NO «SUBIR ÉSTE» ═══
 *
 * Porque «subí al de la posición 3» depende de qué había cuando la pantalla se
 * dibujó, y entre eso y el clic pudo entrar otro. La lista completa es el
 * estado que el emisor está mirando: si lo que manda ya no coincide con lo que
 * hay, se rechaza entero en vez de aplicar la mitad.
 *
 * ⚠ Sólo en borrador, y no lo comprueba este servicio: lo impide el trigger
 * `participacion_orden_congelado` de la 042. Después del despacho a cada
 * firmante ya se le dijo cuándo le toca, y moverlo es cambiarle el turno a
 * alguien que recibió un correo. Lo que corresponde ahí es cancelar y rehacer.
 *
 * ⚠ Sólo firmantes. Las copias informativas no tienen turno —se notifican
 * todas al despachar— y meterlas en la fila haría que el documento «espere» a
 * alguien que no tiene nada que hacer.
 */
export async function reordenarFirmantes(
  cuentaId: string,
  identidadId: string,
  circuitoId: string,
  ordenIds: string[],
) {
  return withUsuario(cuentaId, identidadId, async (trx, autz) => {
    exigir(autz, 'circuito', 'crear', 'No tenés permiso para preparar circuitos de firma.');
    await exigirBorrador(trx, circuitoId, cuentaId);

    // Las participaciones de firmante de la PRIMERA instancia son las que el
    // emisor ve en la pantalla: en modo copias hay una tanda por instancia, con
    // las mismas personas y el mismo orden, y se replica al final.
    const actuales = await sql<{ id: string; identidad_id: string }>`
      select p.id, p.identidad_id
        from participacion p
        join instancia i on i.id = p.instancia_id
       where p.circuito_id = ${circuitoId}::uuid and p.papel = 'firmante'
         and i.numero = (select min(i2.numero) from instancia i2
                          where i2.circuito_id = ${circuitoId}::uuid)
       order by p.orden
    `.execute(trx);

    if (!actuales.rows.length) throw new HttpError(404, 'Este documento todavía no tiene firmantes.');

    const hay = new Set(actuales.rows.map((r) => r.id));
    const pedidos = new Set(ordenIds);
    if (pedidos.size !== ordenIds.length) {
      throw new HttpError(400, 'La lista trae un firmante repetido.');
    }
    // ⚠ Tiene que venir la lista COMPLETA. Con una parcial, los que faltan
    // quedarían con su número viejo y podrían empatar con uno nuevo — y dos
    // firmantes con el mismo orden en serie es que los dos reciben el correo a
    // la vez, que es exactamente lo que el modo serie promete que no pasa.
    if (pedidos.size !== hay.size || ordenIds.some((id) => !hay.has(id))) {
      throw new HttpError(
        409,
        'La lista de firmantes cambió mientras la estabas ordenando. Recargá y probá de nuevo.',
      );
    }

    // Se numera de 1 en adelante, sin huecos. Los huecos no rompen el despacho
    // —la regla es el orden MÍNIMO abierto, no el número 1— pero dejan una
    // pantalla que dice «1. 3. 4.» y hace dudar de si falta alguien.
    for (let i = 0; i < ordenIds.length; i++) {
      const idn = actuales.rows.find((r) => r.id === ordenIds[i])!.identidad_id;
      // Se actualiza por IDENTIDAD y no por id de fila: en modo copias la misma
      // persona tiene una participación por instancia y todas tienen que quedar
      // en la misma posición. Por eso la pantalla muestra personas, no filas.
      await sql`
        update participacion
           set orden = ${i + 1}
         where circuito_id = ${circuitoId}::uuid
           and identidad_id = ${idn}::uuid
           and papel = 'firmante'
      `.execute(trx);
    }

    await registrar(trx, cuentaId, identidadId, {
      accion: 'circuito.orden_cambiado',
      recursoTipo: 'circuito',
      recursoId: circuitoId,
      despues: { orden: ordenIds.length },
    });

    return { ok: true, firmantes: ordenIds.length };
  });
}

/**
 * Con qué carácter firma ESTA PERSONA. La declara ella, no el emisor.
 *
 * ⚠ Quién puede llamarla lo decide la base, no este servicio: el trigger
 * `participacion_caracter_congelado` (046) exige que el actor sea el sujeto de
 * la participación y que todavía no haya firmado. Acá se traduce ese rechazo
 * en una frase que se entiende.
 *
 * Se usa desde la pantalla de firma. Existe también el camino con sesión de
 * cuenta —alguien que tiene usuario y recibe un documento— y es el mismo:
 * la persona es la misma y la pregunta también.
 */
export async function definirCaracter(
  cuentaId: string,
  identidadId: string,
  circuitoId: string,
  participacionId: string,
  caracter: 'personal' | 'representacion',
  cuentaRepresentadaId: string | null,
) {
  return withUsuario(cuentaId, identidadId, async (trx) => {
    const q = await sql<{ identidad_id: string }>`
      select identidad_id from participacion
       where id = ${participacionId}::uuid and circuito_id = ${circuitoId}::uuid
         and papel = 'firmante'
    `.execute(trx);
    const f = q.rows[0];
    if (!f) throw new HttpError(404, 'Ese firmante no existe en este circuito.');

    if (caracter === 'representacion') {
      if (!cuentaRepresentadaId) throw new HttpError(400, 'Decime a qué empresa representa.');
      const ok = await sql<{ puede: boolean }>`
        select app.puede_representar(${f.identidad_id}::uuid, ${cuentaRepresentadaId}::uuid) as puede
      `.execute(trx);
      if (!ok.rows[0]?.puede) {
        throw new HttpError(
          403,
          'No podés declarar que esa persona firma en representación de esa empresa. ' +
            'Sólo vale tu propia cuenta, o una donde esa persona sea miembro activo.',
        );
      }
    }

    // Se actualiza por IDENTIDAD: en modo copias la misma persona tiene una
    // participación por instancia y todas firman con el mismo carácter.
    await sql`
      update participacion
         set caracter = ${caracter},
             cuenta_representada_id = ${caracter === 'representacion' ? cuentaRepresentadaId : null}
       where circuito_id = ${circuitoId}::uuid
         and identidad_id = ${f.identidad_id}::uuid
         and papel = 'firmante'
    `.execute(trx);

    await registrar(trx, cuentaId, identidadId, {
      accion: 'circuito.caracter_definido',
      recursoTipo: 'participacion',
      recursoId: participacionId,
      despues: { caracter, cuenta_representada_id: cuentaRepresentadaId },
    });

    return { ok: true, caracter };
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
      caracter: string | null; cuenta_representada_id: string | null;
    }>`
      select p.id, p.instancia_id, p.identidad_id, p.papel, p.orden,
             i.email_mostrado as email, i.nombre_mostrado as nombre,
             p.caracter, p.cuenta_representada_id
        from participacion p
        join identidad i on i.id = p.identidad_id
       where p.circuito_id = ${circuitoId}::uuid
       order by p.orden
    `.execute(trx);

    const firmantes = parts.rows.filter((p) => p.papel === 'firmante');
    if (!firmantes.length) {
      throw new HttpError(400, 'Agregá al menos un firmante antes de enviarlo.');
    }

    // ⚠ NO se exige el carácter acá, y es a propósito.
    //
    // La 045 lo pedía en el despacho. Estaba mal: con qué carácter firma cada
    // persona lo declara ella al firmar —no lo puede saber quien manda el
    // documento— así que en este momento la respuesta todavía no existe. Ver
    // la migración 046 y `consolidarOtorgamiento`, que es donde el carácter se
    // vuelve otorgamientos.

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
      cuentaRepresentadaId: string | null;
    }[] = [];

    for (const p of parts.rows) {
      const alcances =
        p.papel === 'firmante'
          ? ['metadatos', 'leer', 'firmar', 'evidencia']
          : ['metadatos', 'leer'];
      const oid = randomUUID();

      // Un solo otorgamiento, el de poder abrir y firmar. Los definitivos —el
      // perpetuo de quien firmó a título personal, o el de la empresa cuando
      // firmó representándola— se emiten al firmar, cuando ya se sabe con qué
      // carácter lo hizo. `consolidarOtorgamiento`.
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
        cuentaRepresentadaId:
          p.caracter === 'representacion' ? p.cuenta_representada_id : null,
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
      // Todos, no sólo los que se notifican ahora: el documento aparece en la
      // bandeja del segundo firmante aunque todavía no sea su turno. Ver ahí lo
      // que le va a tocar no es lo mismo que poder firmarlo — eso lo sigue
      // decidiendo la RLS.
      todos: enlaces,
      total: enlaces.length,
    };
  });

  // La bandeja de entrada de cada destinatario que tenga cuenta. Va antes de
  // los correos: si el correo se demora, el documento ya está donde tiene que
  // estar. Y si esto falla, el despacho no se cae — el otorgamiento ya da
  // acceso y el alta reubica lo pendiente.
  try {
    await ubicarEnBandeja(
      preparado.todos.map((e) => ({
        identidadId: e.identidadId,
        instanciaId: e.instanciaId,
        cuentaRepresentadaId: e.cuentaRepresentadaId,
      })),
    );
  } catch (e) {
    // No tumba el despacho —el acceso lo da el otorgamiento, no la ubicación—
    // pero deja rastro. El `catch` vacío que había acá es la razón por la que
    // un fallo de política se pudo esconder durante días.
    console.error('[bandeja] falló al ubicar en el despacho:', e);
  }

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
 * Reenviar el aviso a quien todavía no firmó.
 *
 * ═══ POR QUÉ ESTO NO ES UN LUJO ═══
 *
 * Sin esto, un correo que falla —el SMTP caído, la casilla llena, el aviso en
 * spam— deja el documento trabado para siempre: figura "esperando firmas" y la
 * persona nunca se enteró de que tiene que firmar. El emisor espera a alguien
 * que no sabe nada, y no hay ninguna acción que lo destrabe.
 *
 * ⚠ NO se emite un otorgamiento nuevo: se reusa el que ya existe. Emitir otro
 * dejaría dos enlaces vivos para el mismo acto, y revocar uno no revocaría el
 * otro. El enlace es un puntero a una fila; si la fila es la misma, el enlace
 * viejo del primer correo —si alguna vez llegó— sigue siendo válido, que es
 * exactamente lo que uno espera al pedir "reenviámelo".
 */
export async function reenviarAvisos(
  cuentaId: string,
  identidadId: string,
  circuitoId: string,
) {
  const preparado = await withUsuario(cuentaId, identidadId, async (trx, autz) => {
    exigir(autz, 'circuito', 'enviar', 'No tenés permiso para enviar documentos a firmar.');

    const r = await sql<{
      titulo: string; estado: string; idioma: string; cuenta_nombre: string;
    }>`
      select c.titulo, c.estado, c.idioma, cu.nombre_mostrado as cuenta_nombre
        from circuito c
        join cuenta cu on cu.id = c.cuenta_propietaria_id
       where c.id = ${circuitoId}::uuid and c.cuenta_propietaria_id = ${cuentaId}::uuid
    `.execute(trx);
    const c = r.rows[0];
    if (!c) throw new HttpError(404, 'Ese documento no existe o no lo podés ver.');
    if (c.estado !== 'enviado') {
      throw new HttpError(409, 'Sólo se puede reenviar el aviso de un documento que está esperando firmas.');
    }

    // A quién le toca AHORA: los pendientes del orden más bajo. El mismo
    // criterio que el despacho, para que reenviar no adelante a nadie.
    const p = await sql<{
      id: string; instancia_id: string; identidad_id: string; email: string;
      nombre: string | null; orden: number; otorgamiento_id: string | null;
    }>`
      select p.id, p.instancia_id, p.identidad_id,
             i.email_mostrado as email, i.nombre_mostrado as nombre, p.orden,
             (select o.id from otorgamiento o
               where o.instancia_id = p.instancia_id
                 and o.identidad_id = p.identidad_id
                 and o.revocado_en is null
               order by o.creado_en desc limit 1) as otorgamiento_id
        from participacion p
        join identidad i on i.id = p.identidad_id
       where p.circuito_id = ${circuitoId}::uuid
         and p.estado in ('pendiente','notificada','vista')
         and p.orden = (
           select min(p2.orden) from participacion p2
            where p2.circuito_id = ${circuitoId}::uuid
              and p2.estado in ('pendiente','notificada','vista'))
    `.execute(trx);

    if (!p.rows.length) {
      throw new HttpError(409, 'No queda nadie a quien avisarle: ya firmaron todos los que tenían que firmar.');
    }
    const sinOtorgamiento = p.rows.filter((x) => !x.otorgamiento_id);
    if (sinOtorgamiento.length) {
      throw new HttpError(500, 'Hay participaciones sin otorgamiento vigente. No se puede reenviar.');
    }

    return { titulo: c.titulo, cuentaNombre: c.cuenta_nombre, idioma: c.idioma, destinos: p.rows };
  });

  const resultados = await Promise.all(
    preparado.destinos.map((d) =>
      notificar(cuentaId, circuitoId, preparado, {
        participacionId: d.id,
        otorgamientoId: d.otorgamiento_id!,
        identidadId: d.identidad_id,
        instanciaId: d.instancia_id,
        email: d.email,
        nombre: d.nombre,
      }),
    ),
  );

  return {
    ok: true,
    notificados: resultados.filter((r) => r.ok).length,
    fallidos: resultados.filter((r) => !r.ok),
  };
}

/**
 * El enlace de firma de un participante, para que el emisor lo entregue él.
 *
 * ═══ POR QUÉ EXISTE ═══
 *
 * El correo no siempre llega, y a veces ni siquiera es el canal: el emisor
 * quiere mandarlo por WhatsApp, pegarlo en un chat, o tener a la persona
 * enfrente. Depender de que el SMTP funcione para que un documento se pueda
 * firmar convierte un problema de infraestructura en un producto que no
 * funciona.
 *
 * ═══ ⚠ EL COSTO, QUE HAY QUE DECIR EN VOZ ALTA ═══
 *
 * Este enlace ES la autorización para firmar. Quien lo tenga puede firmar en
 * nombre de esa persona. Al copiarlo, el emisor pasa a tener esa capacidad —y
 * el expediente sólo va a poder decir que la firma vino de ese enlace, con esa
 * IP y ese dispositivo.
 *
 * Por eso el acto se anota en el expediente. No lo impide, lo REGISTRA: si
 * mañana alguien discute la firma, el expediente muestra que el emisor obtuvo
 * el enlace y en qué momento, que es exactamente lo que un perito necesita para
 * evaluar el caso. Un producto que oculta ese hecho es peor que uno que no
 * ofrece la función.
 */
export async function enlaceDeFirma(
  cuentaId: string,
  identidadId: string,
  circuitoId: string,
  participacionId: string,
  ctx: { ip?: string | null; userAgent?: string | null } = {},
) {
  return withUsuario(cuentaId, identidadId, async (trx, autz) => {
    exigir(autz, 'circuito', 'enviar', 'No tenés permiso para enviar documentos a firmar.');

    const r = await sql<{
      id: string; instancia_id: string; identidad_id: string; estado: string;
      email: string; nombre: string | null; circuito_estado: string;
      cuenta_propietaria_id: string; otorgamiento_id: string | null;
    }>`
      select p.id, p.instancia_id, p.identidad_id, p.estado,
             i.email_mostrado as email, i.nombre_mostrado as nombre,
             c.estado as circuito_estado, p.cuenta_propietaria_id,
             (select o.id from otorgamiento o
               where o.instancia_id = p.instancia_id
                 and o.identidad_id = p.identidad_id
                 and o.revocado_en is null
               order by o.creado_en desc limit 1) as otorgamiento_id
        from participacion p
        join identidad i on i.id = p.identidad_id
        join circuito c on c.id = p.circuito_id
       where p.id = ${participacionId}::uuid
         and p.circuito_id = ${circuitoId}::uuid
         and p.cuenta_propietaria_id = ${cuentaId}::uuid
    `.execute(trx);

    const p = r.rows[0];
    if (!p) throw new HttpError(404, 'Esa participación no existe en este documento.');
    if (p.circuito_estado !== 'enviado') {
      throw new HttpError(409, 'El documento todavía no se despachó: no hay enlace que dar.');
    }
    if (!p.otorgamiento_id) {
      throw new HttpError(409, 'Esa persona no tiene un otorgamiento vigente sobre el documento.');
    }
    if (p.estado === 'firmada') throw new HttpError(409, 'Esa persona ya firmó.');
    if (p.estado === 'rechazada') throw new HttpError(409, 'Esa persona rechazó firmar.');

    await anotar(trx, {
      instanciaId: p.instancia_id,
      circuitoId,
      cuentaPropietariaId: p.cuenta_propietaria_id,
      tipo: 'notificacion.enviada',
      actorTipo: 'emisor',
      identidadId,
      participacionId: p.id,
      datos: {
        canal: 'manual',
        metodo: 'enlace_entregado_por_el_emisor',
        destino: enmascarar(p.email),
        // Se deja explícito para quien lea el expediente: a partir de acá el
        // enlace estuvo en manos del emisor, no sólo en la casilla del firmante.
        advertencia: 'el emisor obtuvo el enlace personal de firma',
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      canal: 'web',
    });

    await sql`
      update participacion set estado = 'notificada'
       where id = ${p.id}::uuid and estado = 'pendiente'
    `.execute(trx);

    const token = await emitirEnlaceFirma({
      otorgamientoId: p.otorgamiento_id,
      identidadId: p.identidad_id,
      participacionId: p.id,
    });

    return { url: urlDeFirma(token), email: p.email, nombre: p.nombre };
  });
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

  // Y además en la BITÁCORA de plataforma.
  //
  // No es duplicación por descuido: son dos registros distintos para dos
  // preguntas distintas.
  //
  //   · El expediente responde "¿a este firmante se le avisó?" y vale en un
  //     juicio. Es contenido del cliente y el operador NO puede leerlo — lo
  //     verifica el test C4 y esa frontera no se mueve.
  //   · La bitácora responde "¿el correo de la plataforma está funcionando?".
  //     Es metadato operativo: sin esto, el operador no tiene forma de saber
  //     que el SMTP viene fallando hasta que un cliente se queja.
  //
  // Va sin el destino completo: la bitácora la lee gente que no es parte de ese
  // documento.
  await registrarSistema(cuentaId, null, {
    accion: error ? 'correo.fallido' : 'correo.enviado',
    recursoTipo: 'participacion',
    recursoId: e.participacionId,
    despues: {
      motivo: 'invitacion_a_firmar',
      destino: enmascarar(e.email),
      circuito_id: circuitoId,
      error,
    },
  });

  return error ? { ok: false, email: e.email, error } : { ok: true, email: e.email };
}



/**
 * Deja el documento en la bandeja de entrada de quien lo recibe.
 *
 * ⚠ VA A LA CUENTA PERSONA, NUNCA A LA EMPRESA DONDE TRABAJA.
 *
 * Si a María, que es empleada de Acme, le mandan a firmar algo personal, ese
 * documento NO puede aparecer en el repositorio de Acme: `Recibidos` hereda los
 * permisos de la raíz, y el administrador de Acme los tiene. Sería filtrarle a
 * su empleador un documento que no le corresponde.
 *
 * Está en `claude/repositorio-campos-y-envio-masivo.md` §3: la ubicación va a
 * `raiz.entrada` de la **cuenta persona** del firmante. Si no tiene cuenta, no
 * hay ubicación y el otorgamiento le da acceso igual; el día que se registra,
 * el alta le ubica todo lo que ya tenía.
 *
 * Corre como `sistema` porque escribe en el repositorio de OTRA cuenta: el
 * contexto del emisor no puede —ni debe— insertar ahí.
 *
 * Idempotente: el índice único (cuenta, instancia) lo garantiza, y esto se
 * puede reintentar sin duplicar nada.
 */
export interface DestinoBandeja {
  identidadId: string;
  instanciaId: string;
  /** Si firma representando a una empresa, el documento es de la empresa. */
  cuentaRepresentadaId?: string | null;
}

/**
 * Pone el documento en el repositorio al que pertenece.
 *
 * ⚠ NO siempre es el de la persona. Quien firma en representación de una
 * empresa firma un documento que es de la empresa: va a la bandeja de esa
 * cuenta y no a la suya. Es la consecuencia práctica del carácter de la firma
 * (`propiedad-y-otorgamientos.md` §7.2) y la razón por la que hay que elegirlo
 * antes de despachar: acá ya no se puede deducir.
 */
export async function ubicarEnBandeja(destinos: DestinoBandeja[]) {
  if (!destinos.length) return 0;
  return enSistema(async (trx) => {
    let n = 0;
    for (const d of destinos) {
      // Representación → la bandeja de la empresa representada. Personal → la
      // cuenta persona de esa identidad, si la tiene.
      const r = d.cuentaRepresentadaId
        ? await sql<{ id: string }>`
            insert into ubicacion (cuenta_id, carpeta_id, instancia_id)
            select cu.id, ca.id, ${d.instanciaId}::uuid
              from cuenta cu
              join carpeta ca on ca.cuenta_id = cu.id and ca.sistema = 'entrada'
             where cu.id = ${d.cuentaRepresentadaId}::uuid and cu.estado <> 'cerrada'
            on conflict do nothing
            returning id
          `.execute(trx)
        : await sql<{ id: string }>`
            insert into ubicacion (cuenta_id, carpeta_id, instancia_id)
            select cu.id, ca.id, ${d.instanciaId}::uuid
              from cuenta cu
              join carpeta ca on ca.cuenta_id = cu.id and ca.sistema = 'entrada'
             where cu.tipo = 'persona' and cu.identidad_titular_id = ${d.identidadId}::uuid
            on conflict do nothing
            returning id
          `.execute(trx);
      n += r.rows.length;

      // ⚠ Cero filas NO es un error de SQL y por eso este aviso existe.
      //
      // El insert es un `select` con joins: si esa persona no tiene cuenta
      // persona, o la cuenta no tiene carpeta de entrada, o una política le
      // esconde la carpeta a este contexto, no encuentra destino y no escribe
      // nada. Sin excepción, sin log, sin nada. Fue exactamente así como un
      // documento firmado no apareció en la bandeja de su firmante durante
      // días: la política `carpeta_select` no dejaba ver la carpeta al contexto
      // de sistema (migración 044) y el llamador tiene un `catch` vacío.
      //
      // La ausencia de destino es normal —mucha gente firma sin tener cuenta—
      // así que no se lanza. Pero queda escrito, porque un cero que se repite
      // para TODOS los destinatarios ya no es normal y hay que poder verlo.
      if (!r.rows.length) {
        console.warn('[bandeja] sin ubicar: identidad', d.identidadId, 'instancia', d.instanciaId,
                     '— no encontró bandeja (¿sin cuenta persona, o sin carpeta de entrada?)');
      }
    }
    return n;
  });
}

/**
 * Cierra el otorgamiento de firma y abre el de conservación.
 *
 * Se llama DESPUÉS de firmar y fuera de la transacción de la firma. Lo que hace
 * está explicado donde se lo llama (`firma.ts`); en dos líneas: el derecho a
 * firmar se agotó, y nace el de conservar lo que se firmó, que dura distinto
 * según el carácter.
 *
 * Idempotente: si el de firma ya no está vigente, no hace nada.
 */
export async function consolidarOtorgamiento(participacionId: string) {
  return enSistema(async (trx) => {
    const q = await sql<{
      identidad_id: string; instancia_id: string; caracter: string | null;
      cuenta_representada_id: string | null; cuenta_propietaria_id: string;
    }>`
      select identidad_id, instancia_id, caracter, cuenta_representada_id, cuenta_propietaria_id
        from participacion where id = ${participacionId}::uuid
    `.execute(trx);
    const p = q.rows[0];
    if (!p) return { ok: false };

    const viejos = await sql<{ id: string }>`
      update otorgamiento
         set revocado_en = now(),
             motivo_revocacion = 'firmó: el derecho a firmar se agota con el acto'
       where instancia_id = ${p.instancia_id}::uuid
         and identidad_id = ${p.identidad_id}::uuid
         and revocado_en is null
         and not irrevocable
         and 'firmar' = any (alcances)
      returning id
    `.execute(trx);
    if (!viejos.rows.length) return { ok: true, sinCambios: true };

    const representa = p.caracter === 'representacion' && p.cuenta_representada_id;

    // ⚠ Sin 'firmar'. Y las dos ramas se excluyen por el CHECK de la 008: un
    // otorgamiento condicionado no puede ser irrevocable, así que no hay forma
    // de emitir por error uno perpetuo para quien firmó representando.
    await sql`
      insert into otorgamiento
        (identidad_id, instancia_id, alcances, origen, cuenta_otorgante_id,
         irrevocable, condicionado_a_cuenta_id)
      values (${p.identidad_id}::uuid, ${p.instancia_id}::uuid,
              array['metadatos','leer','evidencia']::text[], 'legal',
              ${p.cuenta_propietaria_id}::uuid,
              ${!representa},
              ${representa ? p.cuenta_representada_id : null})
    `.execute(trx);

    // Y el de la empresa representada pasa a perpetuo: el documento es suyo.
    if (representa) {
      const c = await sql<{ id: string }>`
        update otorgamiento
           set revocado_en = now(), motivo_revocacion = 'reemplazado por el perpetuo al firmarse'
         where instancia_id = ${p.instancia_id}::uuid
           and cuenta_id = ${p.cuenta_representada_id}::uuid
           and revocado_en is null and not irrevocable
        returning id
      `.execute(trx);
      if (c.rows.length) {
        await sql`
          insert into otorgamiento
            (cuenta_id, instancia_id, alcances, origen, cuenta_otorgante_id, irrevocable)
          values (${p.cuenta_representada_id}::uuid, ${p.instancia_id}::uuid,
                  array['metadatos','leer','evidencia']::text[], 'representacion',
                  ${p.cuenta_propietaria_id}::uuid, true)
        `.execute(trx);
      }
    }

    return { ok: true, perpetuo: !representa };
  });
}

// ---------------------------------------------------------------------------
// El documento terminado
// ---------------------------------------------------------------------------

/**
 * Tope de lo que se manda adjunto. Gmail rechaza por encima de 25 MB y el
 * codificado en base64 agrega ~33%, así que 15 MB de PDF es el techo real.
 * Arriba de eso se avisa igual, sin adjunto y diciéndolo.
 */
const MAX_ADJUNTO = 15 * 1024 * 1024;

/**
 * Avisa que el documento quedó firmado, con el PDF adjunto.
 *
 * ⚠ POR QUÉ ADJUNTO Y NO UN ENLACE. Quien firmó algo tiene que quedarse con su
 * copia sin depender de que MiFirma siga existiendo, ni de que un enlace siga
 * vivo, ni de tener cuenta. El firmante externo sobre todo: firmó, y hasta hoy
 * no le quedaba nada en la mano.
 *
 * ⚠ Esto NO existía. Al firmar el último se anotaba `circuito.completo` en el
 * expediente y no se le avisaba a nadie: el emisor se enteraba entrando a la
 * consola y el firmante no se enteraba nunca. Se detectó el 2/8/2026 —«no lo
 * mandó firmado por correo, lo vi en la consola»— y no era un fallo del envío:
 * el aviso no estaba escrito.
 *
 * Va FUERA de la transacción de la firma y sin bloquearla: la firma ya está
 * registrada y un SMTP lento no es problema de quien acaba de firmar.
 */
export async function avisarCompletado(circuitoId: string, instanciaId: string) {
  const datos = await enSistema(async (trx) => {
    const c = await sql<{
      titulo: string; cuenta_nombre: string; cuenta_id: string;
      clave: string | null; bytes: string | null;
      emisor_id: string | null; emisor_email: string | null; emisor_nombre: string | null;
    }>`
      select c.titulo, cu.nombre_mostrado as cuenta_nombre, c.cuenta_propietaria_id as cuenta_id,
             a.clave_almacenamiento as clave, a.bytes::text as bytes,
             ie.id as emisor_id, ie.email_mostrado as emisor_email, ie.nombre_mostrado as emisor_nombre
        from circuito c
        join cuenta cu on cu.id = c.cuenta_propietaria_id
        join instancia i on i.id = ${instanciaId}::uuid
        left join archivo a on a.id = i.archivo_firmado_id
        left join identidad ie on ie.id = c.creado_por_identidad_id
       where c.id = ${circuitoId}::uuid
    `.execute(trx);
    if (!c.rows.length) return null;

    // Los firmantes que efectivamente firmaron. Un veedor no recibe el
    // documento: mirar no es firmar, y el alcance de la decisión del 2/8 fue
    // «emisor y firmantes».
    const p = await sql<{ id: string; identidad_id: string; email: string; nombre: string | null }>`
      select p.id, p.identidad_id, i.email_mostrado as email, i.nombre_mostrado as nombre
        from participacion p
        join identidad i on i.id = p.identidad_id
       where p.instancia_id = ${instanciaId}::uuid
         and p.papel = 'firmante' and p.estado = 'firmada'
       order by p.orden
    `.execute(trx);

    // El certificado de finalización, si ya se emitió. Va adjunto junto con el
    // documento: es lo que se presenta en un juicio, y hacerlo buscar en una
    // consola es la forma de que nadie lo tenga cuando lo necesita.
    const cert = await sql<{ clave: string }>`
      select a.clave_almacenamiento as clave
        from certificado_finalizacion cf
        join archivo a on a.id = cf.archivo_id
       where cf.instancia_id = ${instanciaId}::uuid
    `.execute(trx);

    return { ...c.rows[0]!, firmantes: p.rows, claveCert: cert.rows[0]?.clave ?? null };
  });

  if (!datos) return { avisados: 0 };

  // ⚠ Se lee UNA vez, no una por destinatario. Un PDF de 10 MB leído seis veces
  // del almacenamiento son 60 MB de I/O para mandar el mismo archivo.
  let pdf: Buffer | null = null;
  let motivoSinAdjunto: string | null = null;
  if (!datos.clave) {
    motivoSinAdjunto = 'el documento firmado todavía no está disponible';
  } else if (Number(datos.bytes ?? 0) > MAX_ADJUNTO) {
    motivoSinAdjunto = 'el documento pesa más de lo que admite el correo';
  } else {
    try {
      pdf = await almacen().leer(datos.clave);
    } catch (e) {
      motivoSinAdjunto = 'no se pudo leer el documento firmado';
    }
  }

  // Emisor y firmantes, sin repetir: el emisor suele firmar también, y recibir
  // dos veces el mismo correo se lee como un error del sistema.
  const destinos = new Map<string, { email: string; nombre: string | null; participacionId: string | null; identidadId: string | null }>();
  if (datos.emisor_email) {
    destinos.set(datos.emisor_email.toLowerCase(), {
      email: datos.emisor_email, nombre: datos.emisor_nombre,
      participacionId: null, identidadId: datos.emisor_id,
    });
  }
  for (const f of datos.firmantes) {
    const k = f.email.toLowerCase();
    // Si ya está como emisor, se le agrega su participación para que el
    // expediente lo ate a su fila y no a nadie.
    const previo = destinos.get(k);
    destinos.set(k, {
      email: f.email, nombre: f.nombre ?? previo?.nombre ?? null,
      participacionId: f.id, identidadId: f.identidad_id,
    });
  }
  if (!destinos.size) return { avisados: 0 };

  let certificado: Buffer | null = null;
  if (datos.claveCert) {
    try { certificado = await almacen().leer(datos.claveCert); } catch { /* va sin él */ }
  }

  const limpio = (datos.titulo || 'documento').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 80) || 'documento';
  const archivo = `${limpio}.pdf`;
  const firmaron = datos.firmantes
    .map((f) => escapar(f.nombre || f.email))
    .join(', ');

  let avisados = 0;
  for (const d of destinos.values()) {
    let error: string | null = null;
    try {
      await enviarCorreo({
        para: d.email,
        asunto: `Firmado: ${datos.titulo}`,
        html:
          `<p>${d.nombre ? `Hola ${escapar(d.nombre)},` : 'Hola,'}</p>` +
          `<p>El documento <b>${escapar(datos.titulo)}</b> quedó firmado por todas las partes.</p>` +
          (firmaron ? `<p style="color:#5a6878">Firmaron: ${firmaron}.</p>` : '') +
          (pdf
            ? '<p>Va adjunto el documento firmado. Guardalo: vale por sí mismo, ' +
              'sin depender de MiFirma.</p>' +
              (certificado
                ? '<p>Y con él, el <b>certificado de finalización</b>: quién firmó, cómo se ' +
                  'identificó cada uno, cuándo, con qué sello de tiempo, y cómo comprobarlo ' +
                  'sin nosotros. Es lo que se presenta si alguna vez hay que probar algo.</p>'
                : '')
            : `<p style="color:#b42318">No pudimos adjuntarlo porque ${motivoSinAdjunto}. ` +
              `Pedíselo a ${escapar(datos.cuenta_nombre)}.</p>`) +
          '<p style="color:#5a6878;font-size:13px">La firma electrónica está dentro del PDF: ' +
          'cualquier lector que valide firmas puede comprobarla sin pedirnos nada.</p>',
        texto:
          `El documento "${datos.titulo}" quedó firmado por todas las partes.` +
          (firmaron ? `\nFirmaron: ${datos.firmantes.map((f) => f.nombre || f.email).join(', ')}.` : '') +
          (pdf ? '\n\nVa adjunto el documento firmado.' : `\n\nNo pudimos adjuntarlo porque ${motivoSinAdjunto}.`),
        adjuntos: [
          ...(pdf ? [{ filename: archivo, content: pdf, contentType: 'application/pdf' }] : []),
          ...(certificado
            ? [{ filename: `Certificado - ${limpio}.pdf`, content: certificado,
                 contentType: 'application/pdf' }]
            : []),
        ],
      });
      avisados += 1;
    } catch (err) {
      error = err instanceof Error ? err.message : 'error desconocido';
    }

    // Al expediente, salga o no. Que a alguien no le haya llegado su copia es
    // parte de la historia del documento.
    await enSistema(async (trx) => {
      await anotar(trx, {
        instanciaId,
        circuitoId,
        cuentaPropietariaId: datos.cuenta_id,
        tipo: error ? 'notificacion.fallida' : 'notificacion.enviada',
        actorTipo: 'sistema',
        identidadId: d.identidadId ?? undefined,
        participacionId: d.participacionId ?? undefined,
        datos: {
          canal: 'email',
          motivo: 'documento_completo',
          destino: enmascarar(d.email),
          adjunto: !!pdf,
          certificado_adjunto: !!certificado,
          sin_adjunto_porque: pdf ? null : motivoSinAdjunto,
          error,
        },
        canal: 'email',
      });
    });

    await registrarSistema(datos.cuenta_id, null, {
      accion: error ? 'correo.fallido' : 'correo.enviado',
      recursoTipo: 'circuito',
      recursoId: circuitoId,
      despues: {
        motivo: 'documento_completo',
        destino: enmascarar(d.email),
        circuito_id: circuitoId,
        error,
      },
    });
  }

  return { avisados };
}

/**
 * Cancelar un documento en curso.
 *
 * Implementa `claude/motor-de-flujo.md` §4.2. Lo que hay que tener claro:
 *
 * **Una firma aplicada no se deshace.** Si de tres firmantes ya firmaron dos,
 * esas dos firmas existieron, quedan en el repositorio de esas personas, y el
 * documento queda con dos firmas para siempre. Cancelar no borra: cierra.
 *
 * ⚠ **Lo que impide firmar después no está acá.** El trigger
 * `instancia_transicion_valida` (migración 006) declara que un estado terminal
 * es inmutable, así que una firma que llegue tarde se estrella contra la base.
 * Poner además un `if` en el servicio sería dar dos respuestas a la misma
 * pregunta, y la carrera entre «cancelar» y «firmar» la tiene que resolver la
 * transacción — no el orden en que llegaron los dos clics.
 *
 * El aviso sale por `avisar()`, no por `enviarCorreo()`: mañana esto también va
 * por push y por WhatsApp, y no queremos volver a escribir el texto.
 */
export async function cancelar(
  cuentaId: string,
  identidadId: string,
  circuitoId: string,
  motivo: string,
  ctx: { ip?: string | null; userAgent?: string | null } = {},
) {
  if (!motivo?.trim()) throw new HttpError(400, 'Contá por qué lo cancelás. Queda en el expediente.');

  const preparado = await withUsuario(cuentaId, identidadId, async (trx, autz) => {
    exigir(autz, 'circuito', 'cancelar', 'No tenés permiso para cancelar documentos.');

    // ⚠ `app.cancelar_circuito` es SECURITY DEFINER: adentro no corre la RLS.
    // La pertenencia se comprueba ACÁ, con el contexto del usuario, y por eso
    // esta consulta no es decorativa: es la autorización.
    const c = await sql<{ titulo: string; idioma: string; cuenta_nombre: string }>`
      select c.titulo, c.idioma, cu.nombre_mostrado as cuenta_nombre
        from circuito c
        join cuenta cu on cu.id = c.cuenta_propietaria_id
       where c.id = ${circuitoId}::uuid and c.cuenta_propietaria_id = ${cuentaId}::uuid
    `.execute(trx);
    if (!c.rows.length) throw new HttpError(404, 'Ese documento no existe o no lo podés ver.');

    // A quién avisarle: los que NO firmaron. Al que ya firmó no se le cambia
    // nada de lo suyo, pero se entera igual — abajo.
    const gente = await sql<{
      identidad_id: string; email: string; nombre: string | null;
      instancia_id: string; participacion_id: string; estado: string; idioma: string | null;
    }>`
      select p.identidad_id, i.email_mostrado as email, i.nombre_mostrado as nombre,
             p.instancia_id, p.id as participacion_id, p.estado, p.idioma_efectivo as idioma
        from participacion p
        join identidad i on i.id = p.identidad_id
       where p.circuito_id = ${circuitoId}::uuid
    `.execute(trx);

    const r = await sql<{ instancias_canceladas: number; participaciones_cerradas: number }>`
      select * from app.cancelar_circuito(${circuitoId}::uuid, ${motivo.trim()})
    `.execute(trx);

    // Una entrada de expediente POR INSTANCIA: el expediente es del documento,
    // no del circuito, y en modo copias son 3.000 expedientes distintos.
    for (const inst of [...new Set(gente.rows.map((g) => g.instancia_id))]) {
      await anotar(trx, {
        instanciaId: inst,
        circuitoId,
        cuentaPropietariaId: cuentaId,
        tipo: 'circuito.cancelado',
        actorTipo: 'emisor',
        identidadId,
        datos: { motivo: motivo.trim() },
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
      });
    }

    return {
      titulo: c.rows[0]!.titulo,
      idioma: c.rows[0]!.idioma,
      emisor: c.rows[0]!.cuenta_nombre,
      gente: gente.rows,
      ...r.rows[0]!,
    };
  });

  // Fuera de la transacción: si el aviso falla, la cancelación ya ocurrió. Al
  // revés —un SMTP caído impidiendo cancelar— sería mucho peor.
  const aviso = await avisar(
    'cancelado',
    preparado.gente.map((g) => ({
      identidadId: g.identidad_id,
      email: g.email,
      nombre: g.nombre,
      idioma: g.idioma ?? preparado.idioma,
    })),
    { titulo: preparado.titulo, emisor: preparado.emisor, motivo: motivo.trim() },
    { cuentaId, circuitoId },
  );

  await registrarSistema(cuentaId, identidadId, {
    accion: 'circuito.cancelado',
    recursoTipo: 'circuito',
    recursoId: circuitoId,
    despues: {
      instancias: preparado.instancias_canceladas,
      participaciones: preparado.participaciones_cerradas,
      avisos: aviso.enviados,
      avisos_fallidos: aviso.fallidos,
    },
  });

  return {
    ok: true,
    instancias_canceladas: preparado.instancias_canceladas,
    participaciones_cerradas: preparado.participaciones_cerradas,
    avisados: aviso.enviados,
  };
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

/**
 * Le avisa a quien le toca ahora. Lo llama el motor, no una persona.
 *
 * ═══ ES LO QUE HACE AVANZAR LA SERIE ═══
 *
 * Sin esto, una firma en serie se traba en el primero: el segundo queda
 * esperando un correo que nunca sale, y el emisor ve "1 de 2" sin entender por
 * qué no avanza. El acto de firmar tiene una consecuencia —le toca al
 * siguiente— y esa consecuencia la ejecuta el sistema, no el firmante.
 *
 * Corre como `sistema` y DESPUÉS de que la firma quedó registrada: si el correo
 * falla, la firma ya está y el aviso se reintenta con "Reenviar aviso". Al
 * revés, un SMTP caído impediría firmar.
 *
 * No emite otorgamientos: los emitió el despacho, para todos los participantes
 * a la vez. Lo único que faltaba era avisar.
 */
export async function avisarAlQueSigue(circuitoId: string) {
  const preparado = await enSistema(async (trx) => {
    const c = await sql<{ titulo: string; idioma: string; cuenta_nombre: string; cuenta_id: string }>`
      select c.titulo, c.idioma, cu.nombre_mostrado as cuenta_nombre, c.cuenta_propietaria_id as cuenta_id
        from circuito c
        join cuenta cu on cu.id = c.cuenta_propietaria_id
       where c.id = ${circuitoId}::uuid and c.estado = 'enviado'
    `.execute(trx);
    if (!c.rows.length) return null;

    // A quién le toca AHORA: los pendientes del orden más bajo que todavía no
    // fueron notificados. Mismo criterio que el despacho.
    const p = await sql<{
      id: string; instancia_id: string; identidad_id: string; email: string;
      nombre: string | null; otorgamiento_id: string | null;
    }>`
      select p.id, p.instancia_id, p.identidad_id,
             i.email_mostrado as email, i.nombre_mostrado as nombre,
             (select o.id from otorgamiento o
               where o.instancia_id = p.instancia_id and o.identidad_id = p.identidad_id
                 and o.revocado_en is null
               order by o.creado_en desc limit 1) as otorgamiento_id
        from participacion p
        join identidad i on i.id = p.identidad_id
       where p.circuito_id = ${circuitoId}::uuid
         and p.estado = 'pendiente'
         and p.orden = (
           select min(p2.orden) from participacion p2
            where p2.circuito_id = ${circuitoId}::uuid
              and p2.estado not in ('firmada','no_requerida','delegada','rechazada'))
    `.execute(trx);

    if (!p.rows.length) return null;
    return {
      titulo: c.rows[0]!.titulo,
      cuentaNombre: c.rows[0]!.cuenta_nombre,
      idioma: c.rows[0]!.idioma,
      cuentaId: c.rows[0]!.cuenta_id,
      destinos: p.rows.filter((x) => x.otorgamiento_id),
    };
  });

  if (!preparado || !preparado.destinos.length) return { notificados: 0 };

  const r = await Promise.all(
    preparado.destinos.map((d) =>
      notificar(preparado.cuentaId, circuitoId, preparado, {
        participacionId: d.id,
        otorgamientoId: d.otorgamiento_id!,
        identidadId: d.identidad_id,
        instanciaId: d.instancia_id,
        email: d.email,
        nombre: d.nombre,
      }),
    ),
  );
  return { notificados: r.filter((x) => x.ok).length };
}

/**
 * Mi propio enlace para firmar un documento que me llegó.
 *
 * ═══ POR QUÉ HACE FALTA ═══
 *
 * Porque firmar existía en un solo lugar: el enlace del correo. Quien tiene
 * cuenta en MiFirma ve el documento en Recibidos, lo puede abrir, ver el
 * expediente y descargarlo — y para firmarlo tiene que ir a buscar el mail.
 * Es un producto de firma en el que estar registrado no te deja firmar.
 *
 * ⚠ Esto NO otorga nada. El acceso ya lo tiene: es el otorgamiento que se le
 * emitió al despachar, el mismo que viaja en el correo. Acá sólo se le entrega
 * el puntero a esa fila, y sólo a la persona que ES el sujeto de esa fila —el
 * `where` filtra por `identidad_id` y la RLS lo vuelve a comprobar—. No es un
 * camino nuevo hacia el documento: es la misma puerta, sin tener que buscar la
 * llave en el correo.
 *
 * ⚠ Distinto de `enlaceDeFirma`, que es el EMISOR copiando el enlace de otro y
 * exige la capacidad de enviar. Éste es uno pidiendo el suyo y no exige
 * ninguna: firmar lo que a uno le mandaron no es una capacidad de la cuenta.
 */
export async function miEnlaceDeFirma(
  cuentaId: string,
  identidadId: string,
  instanciaId: string,
) {
  return withUsuario(cuentaId, identidadId, async (trx) => {
    const r = await sql<{
      id: string; instancia_id: string; estado: string; papel: string;
      circuito_estado: string; titulo: string; me_toca: boolean;
      otorgamiento_id: string | null;
    }>`
      select p.id, p.instancia_id, p.estado, p.papel,
             c.estado as circuito_estado, c.titulo,
             not exists (
               select 1 from participacion p2
                where p2.instancia_id = p.instancia_id and p2.papel = 'firmante'
                  and p2.orden < p.orden
                  and p2.estado not in ('firmada','no_requerida','delegada')
             ) as me_toca,
             (select o.id from otorgamiento o
               where o.instancia_id = p.instancia_id
                 and o.identidad_id = p.identidad_id
                 and o.revocado_en is null
                 and 'firmar' = any (o.alcances)
               order by o.creado_en desc limit 1) as otorgamiento_id
        from participacion p
        join circuito c on c.id = p.circuito_id
       where p.instancia_id = ${instanciaId}::uuid
         and p.identidad_id = ${identidadId}::uuid
         and p.papel = 'firmante'
    `.execute(trx);

    const p = r.rows[0];
    if (!p) throw new HttpError(404, 'Este documento no te pide una firma.');
    if (p.circuito_estado !== 'enviado') {
      throw new HttpError(409, 'Este documento no está esperando firmas.');
    }
    if (p.estado === 'firmada') throw new HttpError(409, 'Ya firmaste este documento.');
    if (p.estado === 'rechazada') throw new HttpError(409, 'Ya rechazaste este documento.');
    if (!p.me_toca) {
      throw new HttpError(409, 'Todavía no es tu turno: falta que firme alguien antes que vos.');
    }
    if (!p.otorgamiento_id) {
      throw new HttpError(409, 'Tu acceso para firmar este documento ya no está vigente.');
    }

    const token = await emitirEnlaceFirma({
      otorgamientoId: p.otorgamiento_id,
      identidadId,
      participacionId: p.id,
    });

    return { url: urlDeFirma(token), titulo: p.titulo };
  });
}
