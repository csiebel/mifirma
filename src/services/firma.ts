import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { withExterno, db } from '../db/pool';
import { fijarContexto } from '../db/contexto';
import { verificarEnlaceFirma } from '../auth/enlace_firma';
import { almacen, nuevaClave } from '../almacenamiento/almacen';
import { normalizar, sellar, verificar } from '../firma/pades';
import { selloDePlataforma } from '../firma/adaptadores/sello_plataforma';
import { anotar } from './evidencia';
import { avisarAlQueSigue } from './circuito';
import { HttpError } from '../http/errors';

/**
 * La firma del participante externo.
 *
 * ═══ LAS DOS REGLAS DE ORO, ACÁ ES DONDE SE APLICAN ═══
 *
 * 1. La criptografía firma; lo autógrafo comunica. Lo que la persona escribe o
 *    dibuja es representación visual. El valor legal lo va a dar el PAdES.
 *
 * 2. La autorización vive en la capa de datos. Este archivo no decide quién
 *    puede firmar: fija el contexto del otorgamiento y la RLS resuelve. Si el
 *    enlace apunta a un otorgamiento revocado o vencido, las consultas no
 *    devuelven filas — no hay un `if` acá que se pueda olvidar.
 *
 * ═══ EL ORDEN DE LOS PASOS NO ES CASUAL ═══
 *
 *   1. ¿Puede firmar? Lo decide la RLS. No escribe nada.
 *   2. Sellar el PDF y verificar el resultado.
 *   3. Recién entonces, anotar en el expediente.
 *
 * Si se anotara primero y fallara el sellado, el expediente afirmaría una firma
 * que no existe — y el expediente es inmutable, así que esa mentira quedaría
 * para siempre. Al revés, un sellado que falla deja al firmante viendo un error
 * y pudiendo reintentar.
 *
 * ═══ ⚠ LO QUE FALTA PARA PRODUCCIÓN ═══
 *
 * El sello usa el certificado de la PLATAFORMA, no uno del firmante: eso prueba
 * integridad y fecha, no que la clave la haya controlado quien firma. Es firma
 * simple y el producto no debe decir otra cosa.
 *
 * Y falta el SELLO DE TIEMPO (RFC 3161). Sin ancla externa, la fecha es una
 * afirmación nuestra. Es el riesgo R1 de `auditoria-y-evidencias.md` y lo único
 * que no se puede agregar con efecto retroactivo.
 */

// ---------------------------------------------------------------------------
// Abrir el enlace
// ---------------------------------------------------------------------------

export async function abrirParaFirmar(
  token: string,
  ctx: { ip?: string | null; userAgent?: string | null; zonaHoraria?: string | null } = {},
) {
  const e = await verificarEnlaceFirma(token);

  return withExterno(e.otorgamientoId, e.identidadId, async (trx) => {
    const r = await sql<{
      participacion_id: string; instancia_id: string; circuito_id: string;
      cuenta_propietaria_id: string; papel: string; orden: number; estado: string;
      titulo: string; circuito_estado: string; modo: string; nivel_firma: string;
      vence_en: Date | null; emisor: string; firmante_email: string; firmante_nombre: string | null;
      sha256: Buffer; me_toca: boolean;
    }>`
      select p.id as participacion_id, p.instancia_id, p.circuito_id,
             p.cuenta_propietaria_id, p.papel, p.orden, p.estado,
             c.titulo, c.estado as circuito_estado, c.modo, c.nivel_firma, c.vence_en,
             cu.nombre_mostrado as emisor,
             i.email_mostrado as firmante_email, i.nombre_mostrado as firmante_nombre,
             a.sha256,
             -- Le toca si no queda nadie pendiente con un orden menor. Misma
             -- regla que el despacho: el turno es el orden más bajo abierto.
             not exists (
               select 1 from participacion p2
                where p2.instancia_id = p.instancia_id
                  and p2.papel = 'firmante'
                  and p2.orden < p.orden
                  and p2.estado not in ('firmada','no_requerida','delegada')
             ) as me_toca
        from participacion p
        join circuito c on c.id = p.circuito_id
        -- LEFT JOIN a propósito, no por descuido: con INNER, que una política
        -- no alcance a la cuenta o al archivo hace desaparecer la fila entera y
        -- el firmante ve "este enlace ya no está disponible" con el enlace
        -- perfectamente vivo. Con LEFT, la falta se ve como un campo vacío y se
        -- puede decir exactamente qué falta.
        left join cuenta cu on cu.id = c.cuenta_propietaria_id
        left join identidad i on i.id = p.identidad_id
        left join archivo a on a.id = c.archivo_base_id
       where p.id = ${e.participacionId}::uuid
    `.execute(trx);

    const f = r.rows[0];
    if (!f) {
      // Acá sí es lo esperable: la RLS no dejó ver ni la participación ni el
      // circuito. Otorgamiento revocado, vencido, o un enlace que apunta a otra
      // cosa. No se distingue el motivo a propósito.
      throw new HttpError(403, 'Este enlace ya no está disponible. Pedile al emisor que te lo reenvíe.');
    }
    if (!f.sha256) {
      // El documento existe pero la política no lo alcanza. Es un problema
      // nuestro, no del firmante, y decirlo así evita mandarlo a pedir un
      // reenvío que no va a arreglar nada.
      throw new HttpError(500, 'No podemos mostrarte el documento. Ya estamos avisados de este problema.');
    }

    // Abrir el enlace es la primera prueba de que esa persona controla ese
    // correo: le llegó ahí y sólo ahí. Es `verificacion_email`, nivel bajo — no
    // convierte a nadie en identificado, pero es un hecho, y los hechos van al
    // expediente. Se crea una sola vez.
    await sql`
      insert into anclaje_identidad (identidad_id, tipo, valor_normalizado,
                                     metodo_prueba, nivel_garantia)
      select ${e.identidadId}::uuid, 'email', lower(btrim(${f.firmante_email})),
             'verificacion_email', 'bajo'
       where not exists (
         select 1 from anclaje_identidad a
          where a.identidad_id = ${e.identidadId}::uuid and a.tipo = 'email'
            and a.valor_normalizado = lower(btrim(${f.firmante_email}))
            and a.revocado_en is null)
    `.execute(trx);

    if (f.estado === 'pendiente' || f.estado === 'notificada') {
      await sql`
        update participacion set estado = 'vista'
         where id = ${f.participacion_id}::uuid and estado in ('pendiente','notificada')
      `.execute(trx);
    }

    await anotar(trx, {
      instanciaId: f.instancia_id,
      circuitoId: f.circuito_id,
      cuentaPropietariaId: f.cuenta_propietaria_id,
      tipo: 'documento.abierto',
      actorTipo: 'firmante',
      identidadId: e.identidadId,
      participacionId: f.participacion_id,
      datos: { papel: f.papel },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      zonaHorariaMostrada: ctx.zonaHoraria,
      sha256Documento: f.sha256,
      canal: 'web',
    });

    return {
      titulo: f.titulo,
      emisor: f.emisor ?? '',
      firmante: { email: f.firmante_email, nombre: f.firmante_nombre },
      papel: f.papel,
      estado: f.estado === 'pendiente' || f.estado === 'notificada' ? 'vista' : f.estado,
      circuito_estado: f.circuito_estado,
      nivel_firma: f.nivel_firma,
      vence_en: f.vence_en,
      me_toca: f.me_toca,
      sha256: Buffer.from(f.sha256).toString('hex'),
    };
  });
}

/** Los bytes del documento, para el visor del firmante. */
export async function documentoParaFirmar(token: string) {
  const e = await verificarEnlaceFirma(token);

  const datos = await withExterno(e.otorgamientoId, e.identidadId, async (trx) => {
    const r = await sql<{ mime: string; clave: string; sha256: Buffer; titulo: string }>`
      select a.mime, a.clave_almacenamiento as clave, a.sha256, c.titulo
        from participacion p
        join circuito c on c.id = p.circuito_id
        join archivo a on a.id = c.archivo_base_id
       where p.id = ${e.participacionId}::uuid
    `.execute(trx);
    const f = r.rows[0];
    if (!f) throw new HttpError(403, 'Este enlace ya no está disponible.');
    return f;
  });

  const contenido = await almacen().leer(datos.clave);
  const real = createHash('sha256').update(contenido).digest();
  if (!real.equals(datos.sha256)) {
    throw new HttpError(500, 'El archivo almacenado no coincide con su huella registrada.');
  }
  return { contenido, mime: datos.mime, nombre: `${datos.titulo}.pdf` };
}

// ---------------------------------------------------------------------------
// Firmar
// ---------------------------------------------------------------------------

export interface FirmaInput {
  /** Marca explícita e inequívoca. Sin esto no hay firma. */
  consentimiento: boolean;
  /** Lo que la persona escribe como representación visual. NO es la firma. */
  nombreEscrito?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  zonaHoraria?: string | null;
  huellaDispositivo?: string | null;
}

export async function firmar(token: string, input: FirmaInput) {
  const e = await verificarEnlaceFirma(token);

  if (!input.consentimiento) {
    // El consentimiento no es una casilla de términos: es un requisito de fondo
    // de la firma electrónica. Sin él no se firma, y el motivo se le dice.
    throw new HttpError(400, 'Hay que aceptar firmar electrónicamente para poder firmar.');
  }

  // ── PASO 1: ¿puede firmar? Lo decide la RLS, con el contexto del otorgamiento.
  //
  // Este paso no escribe nada. Si el enlace apunta a un otorgamiento revocado o
  // vencido, la consulta no devuelve filas y acá se termina.
  const ctx = await withExterno(e.otorgamientoId, e.identidadId, async (trx) => {
    const r = await sql<{
      participacion_id: string; instancia_id: string; circuito_id: string;
      cuenta_propietaria_id: string; estado: string; papel: string; orden: number;
      sha256: Buffer; titulo: string; nivel_firma: string; me_toca: boolean;
      anclaje_email: string | null; clave: string; mime: string;
      archivo_vigente_id: string | null; firmante: string | null; emisor: string | null;
    }>`
      select p.id as participacion_id, p.instancia_id, p.circuito_id,
             p.cuenta_propietaria_id, p.estado, p.papel, p.orden,
             a.sha256, c.titulo, c.nivel_firma,
             not exists (
               select 1 from participacion p2
                where p2.instancia_id = p.instancia_id and p2.papel = 'firmante'
                  and p2.orden < p.orden
                  and p2.estado not in ('firmada','no_requerida','delegada')
             ) as me_toca,
             (select an.id from anclaje_identidad an
               where an.identidad_id = p.identidad_id and an.tipo = 'email'
                 and an.revocado_en is null order by an.probado_en limit 1) as anclaje_email,
             -- El PDF tal como está AHORA, con las firmas anteriores aplicadas.
             -- La firma se agrega SOBRE éste; hacerlo sobre el original borraría
             -- las anteriores.
             a.clave_almacenamiento as clave, a.mime,
             i2.archivo_vigente_id,
             ident.nombre_mostrado as firmante, cu.nombre_mostrado as emisor
        from participacion p
        join circuito c on c.id = p.circuito_id
        join instancia i2 on i2.id = p.instancia_id
        join archivo a on a.id = coalesce(i2.archivo_vigente_id, c.archivo_base_id)
        left join identidad ident on ident.id = p.identidad_id
        left join cuenta cu on cu.id = c.cuenta_propietaria_id
       where p.id = ${e.participacionId}::uuid
    `.execute(trx);

    const f = r.rows[0];
    if (!f) throw new HttpError(403, 'Este enlace ya no está disponible.');
    if (f.papel !== 'firmante') throw new HttpError(403, 'Tu papel en este documento es sólo de lectura.');
    if (f.estado === 'firmada') throw new HttpError(409, 'Ya firmaste este documento.');
    if (f.estado === 'rechazada') throw new HttpError(409, 'Ya rechazaste este documento.');
    if (!f.me_toca) throw new HttpError(409, 'Todavía no es tu turno: falta que firme alguien antes que vos.');
    return f;
  });

  // ── PASO 2: sellar. ANTES de anotar nada.
  //
  // El orden importa. Si primero se anotara "firma aplicada" y después fallara
  // el sellado, el expediente afirmaría una firma que no existe — y el
  // expediente es inmutable, así que esa mentira quedaría para siempre. Al
  // revés, un sellado que falla deja al firmante viendo un error y pudiendo
  // reintentar, que es exactamente lo que corresponde.
  const nombreFirmante = ctx.firmante || 'el firmante';
  const original = await almacen().leer(ctx.clave);

  // La normalización sólo hace falta la primera vez: deja el PDF con tabla xref
  // clásica, que es lo que el placeholder sabe leer. Si ya hay una firma, el
  // archivo NO se vuelve a serializar — hacerlo rompería esa firma.
  const base = ctx.archivo_vigente_id ? original : await normalizar(original);

  let firmado: Buffer;
  try {
    firmado = await sellar(
      base,
      {
        // El motivo dice a nombre de quién se selló. Es lo que ve cualquiera en
        // el panel de firmas de un lector de PDF, sin abrir el expediente.
        razon: `Firmado electrónicamente por ${nombreFirmante} · ${ctx.titulo}`,
        nombre: nombreFirmante,
        lugar: ctx.emisor ?? '',
        contacto: process.env.SOPORTE_EMAIL ?? '',
      },
      selloDePlataforma(),
    );
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, 'No se pudo aplicar la firma al documento. Probá de nuevo en un momento.');
  }

  // Verificar lo que acabamos de producir, antes de guardarlo. Entregar un
  // documento cuya firma no cierra es peor que no firmarlo.
  const comprobacion = verificar(firmado);
  const firmas = comprobacion.firmas;
  // `integro` y no "todas verifican": exige además que no queden bytes al final
  // que ninguna firma cubra. Sobre un archivo que acabamos de producir nosotros
  // mismos, cualquier byte suelto es un error nuestro.
  if (!firmas.length || !comprobacion.integro) {
    throw new HttpError(500, 'La firma generada no verifica. No se guardó nada.');
  }

  const sha256Firmado = createHash('sha256').update(firmado).digest();
  const claveNueva = nuevaClave();
  await almacen().guardar(claveNueva, firmado);

  // ── PASO 3: registrar. Todo junto, en una transacción.
  const resultado = await enSistema(async (trx) => {
    const archivoId = randomUUID();
    await sql`
      insert into archivo (id, sha256, bytes, mime, clase, cuenta_custodia_id,
                           region, clave_almacenamiento)
      values (${archivoId}::uuid, ${sha256Firmado}, ${firmado.length}, ${ctx.mime},
              'firmado', ${ctx.cuenta_propietaria_id}::uuid, ${almacen().region}, ${claveNueva})
    `.execute(trx);

    const ahora = new Date();
    const comun = {
      instanciaId: ctx.instancia_id,
      circuitoId: ctx.circuito_id,
      cuentaPropietariaId: ctx.cuenta_propietaria_id,
      identidadId: e.identidadId,
      participacionId: ctx.participacion_id,
      actorTipo: 'firmante' as const,
      ocurridoEn: ahora,
      ip: input.ip,
      userAgent: input.userAgent,
      huellaDispositivo: input.huellaDispositivo,
      canal: 'web' as const,
      zonaHorariaMostrada: input.zonaHoraria,
    };

    // Orden: identidad, consentimiento, firma. No es cosmético — es la
    // secuencia que un perito espera encontrar, y la cadena la congela.
    await anotar(trx, {
      ...comun,
      tipo: 'identidad.probada',
      datos: { metodo: 'verificacion_email', nivel_garantia: 'bajo' },
      sha256Documento: ctx.sha256,
    });

    await anotar(trx, {
      ...comun,
      tipo: 'consentimiento.dado',
      datos: {
        texto_aceptado:
          'Acepto firmar este documento electrónicamente y que mi firma electrónica ' +
          'tenga el mismo valor que una firma manuscrita.',
        version: 1,
      },
      sha256Documento: ctx.sha256,
    });

    await anotar(trx, {
      ...comun,
      tipo: 'firma.aplicada',
      datos: {
        nivel_firma: ctx.nivel_firma,
        // La representación visual, guardada como lo que es: un texto que la
        // persona escribió. No es la firma, y el expediente no la llama así.
        representacion_visual: input.nombreEscrito ?? null,
        sellado_pades: true,
        subfiltro: 'ETSI.CAdES.detached',
        sello: selloDePlataforma().codigo,
        titular_certificado: selloDePlataforma().titular,
        firmas_en_el_documento: firmas.length,
        // La huella del documento ANTES y DESPUÉS de esta firma. Es lo que ata
        // el evento al archivo concreto, sin depender de ninguna otra tabla.
        sha256_previo: Buffer.from(ctx.sha256).toString('hex'),
        sha256_resultante: sha256Firmado.toString('hex'),
        archivo_id: archivoId,
      },
      // El evento apunta al documento QUE SE FIRMÓ, no al resultado: es el
      // contenido sobre el que esta persona prestó su consentimiento.
      sha256Documento: ctx.sha256,
    });

    await sql`
      update participacion
         set estado = 'firmada', firmada_en = ${ahora},
             anclaje_usado_id = ${ctx.anclaje_email},
             nivel_garantia_obtenido = 'bajo'
       where id = ${ctx.participacion_id}::uuid
    `.execute(trx);

    const pend = await sql<{ n: string }>`
      select count(*)::text as n from participacion
       where instancia_id = ${ctx.instancia_id}::uuid and papel = 'firmante'
         and estado not in ('firmada','no_requerida','delegada','rechazada')
    `.execute(trx);
    const quedan = Number(pend.rows[0]?.n ?? 0);

    if (quedan > 0) {
      // Quedan firmas: el documento sigue en curso y el próximo firma sobre
      // ESTE archivo.
      await sql`
        update instancia
           set archivo_vigente_id = ${archivoId}::uuid, sha256_vigente = ${sha256Firmado}
         where id = ${ctx.instancia_id}::uuid
      `.execute(trx);
    } else {
      // Firmó el último: recién ahora el archivo pasa a ser el definitivo, y
      // `archivo_firmado_id` no se puede volver a tocar — lo impide un trigger.
      await sql`
        update instancia
           set archivo_vigente_id = ${archivoId}::uuid,
               archivo_firmado_id = ${archivoId}::uuid,
               sha256_vigente = ${sha256Firmado},
               estado = 'firmada', cerrada_en = now()
         where id = ${ctx.instancia_id}::uuid
      `.execute(trx);

      const abiertas = await sql<{ n: string }>`
        select count(*)::text as n from instancia
         where circuito_id = ${ctx.circuito_id}::uuid and estado in ('pendiente','en_curso')
      `.execute(trx);

      if (Number(abiertas.rows[0]?.n ?? 0) === 0) {
        await sql`
          update circuito set estado = 'completo', cerrado_en = now()
           where id = ${ctx.circuito_id}::uuid and estado = 'enviado'
        `.execute(trx);
        await anotar(trx, {
          instanciaId: ctx.instancia_id,
          circuitoId: ctx.circuito_id,
          cuentaPropietariaId: ctx.cuenta_propietaria_id,
          tipo: 'circuito.completo',
          actorTipo: 'sistema',
          datos: { titulo: ctx.titulo, firmas: firmas.length },
          canal: 'sistema',
          sha256Documento: sha256Firmado,
        });
      }
    }

    return { quedan };
  });

  // Firmó uno y quedan otros: le toca al siguiente, y hay que avisarle. Va
  // FUERA de la transacción y sin bloquear la respuesta al que acaba de firmar:
  // su firma ya está registrada y un correo lento no es su problema.
  if (resultado.quedan > 0) {
    try {
      await avisarAlQueSigue(ctx.circuito_id);
    } catch {
      // Si el aviso falla, la lista lo va a mostrar como "no le llegó el aviso"
      // y el emisor lo reintenta. Perder la firma por un SMTP caído sería peor.
    }
  }

  return {
    ok: true,
    completo: resultado.quedan === 0,
    faltan: resultado.quedan,
    sellado_pades: true,
    firmas_en_el_documento: firmas.length,
  };
}

export async function rechazar(token: string, motivo: string, ctx: { ip?: string | null; userAgent?: string | null } = {}) {
  const e = await verificarEnlaceFirma(token);
  const m = (motivo || '').trim().slice(0, 500);
  if (!m) throw new HttpError(400, 'Contá por qué no lo firmás: queda en el expediente.');

  return withExterno(e.otorgamientoId, e.identidadId, async (trx) => {
    const r = await sql<{
      participacion_id: string; instancia_id: string; circuito_id: string;
      cuenta_propietaria_id: string; estado: string; sha256: Buffer;
    }>`
      select p.id as participacion_id, p.instancia_id, p.circuito_id,
             p.cuenta_propietaria_id, p.estado, a.sha256
        from participacion p
        join circuito c on c.id = p.circuito_id
        join archivo a on a.id = c.archivo_base_id
       where p.id = ${e.participacionId}::uuid
    `.execute(trx);
    const f = r.rows[0];
    if (!f) throw new HttpError(403, 'Este enlace ya no está disponible.');
    if (f.estado === 'firmada') throw new HttpError(409, 'Ya firmaste este documento.');

    await anotar(trx, {
      instanciaId: f.instancia_id, circuitoId: f.circuito_id,
      cuentaPropietariaId: f.cuenta_propietaria_id,
      tipo: 'firma.rechazada', actorTipo: 'firmante',
      identidadId: e.identidadId, participacionId: f.participacion_id,
      datos: { motivo: m },
      ip: ctx.ip, userAgent: ctx.userAgent, canal: 'web',
      sha256Documento: f.sha256,
    });

    await sql`
      update participacion set estado = 'rechazada', motivo_rechazo = ${m}
       where id = ${f.participacion_id}::uuid
    `.execute(trx);

    return { ok: true };
  });
}

async function enSistema<T>(fn: (trx: any) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await fijarContexto(trx, { actor: 'sistema' });
    return fn(trx);
  });
}
