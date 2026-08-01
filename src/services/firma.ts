import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { withExterno, db } from '../db/pool';
import { fijarContexto } from '../db/contexto';
import { verificarEnlaceFirma } from '../auth/enlace_firma';
import { almacen } from '../almacenamiento/almacen';
import { anotar } from './evidencia';
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
 * ═══ ⚠ LO QUE FALTA, Y NO ES UN DETALLE ═══
 *
 * Todavía NO se estampa el PDF. La firma se registra como actos en el
 * expediente —consentimiento, identidad, hash del documento firmado— pero el
 * archivo firmado con PAdES no se genera, porque el ensamblador PAdES no está
 * escrito (`pdf-lib`, que está en las dependencias, NO hace PAdES).
 *
 * Es decir: hoy esto produce un expediente completo y un documento SIN firma
 * criptográfica. Sirve para probar el flujo entero; NO sirve para producción, y
 * `instancia.archivo_firmado_id` queda en null a propósito para que esa falta
 * sea visible en la base y no una suposición.
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

  const resultado = await withExterno(e.otorgamientoId, e.identidadId, async (trx) => {
    const r = await sql<{
      participacion_id: string; instancia_id: string; circuito_id: string;
      cuenta_propietaria_id: string; estado: string; papel: string; orden: number;
      sha256: Buffer; titulo: string; nivel_firma: string; me_toca: boolean;
      anclaje_email: string | null;
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
                 and an.revocado_en is null order by an.probado_en limit 1) as anclaje_email
        from participacion p
        join circuito c on c.id = p.circuito_id
        join archivo a on a.id = c.archivo_base_id
       where p.id = ${e.participacionId}::uuid
    `.execute(trx);

    const f = r.rows[0];
    if (!f) throw new HttpError(403, 'Este enlace ya no está disponible.');
    if (f.papel !== 'firmante') throw new HttpError(403, 'Tu papel en este documento es sólo de lectura.');
    if (f.estado === 'firmada') throw new HttpError(409, 'Ya firmaste este documento.');
    if (f.estado === 'rechazada') throw new HttpError(409, 'Ya rechazaste este documento.');
    if (!f.me_toca) throw new HttpError(409, 'Todavía no es tu turno: falta que firme alguien antes que vos.');

    const ahora = new Date();

    // Orden de los eventos: identidad, consentimiento, firma. No es cosmético —
    // es la secuencia que un perito espera encontrar, y la cadena la congela.
    await anotar(trx, {
      instanciaId: f.instancia_id, circuitoId: f.circuito_id,
      cuentaPropietariaId: f.cuenta_propietaria_id,
      tipo: 'identidad.probada', actorTipo: 'firmante',
      identidadId: e.identidadId, participacionId: f.participacion_id,
      datos: { metodo: 'verificacion_email', nivel_garantia: 'bajo' },
      ocurridoEn: ahora, ip: input.ip, userAgent: input.userAgent,
      huellaDispositivo: input.huellaDispositivo, canal: 'web',
      sha256Documento: f.sha256, zonaHorariaMostrada: input.zonaHoraria,
    });

    await anotar(trx, {
      instanciaId: f.instancia_id, circuitoId: f.circuito_id,
      cuentaPropietariaId: f.cuenta_propietaria_id,
      tipo: 'consentimiento.dado', actorTipo: 'firmante',
      identidadId: e.identidadId, participacionId: f.participacion_id,
      datos: {
        texto_aceptado: 'Acepto firmar este documento electrónicamente y que mi firma ' +
                        'electrónica tenga el mismo valor que una firma manuscrita.',
        version: 1,
      },
      ocurridoEn: ahora, ip: input.ip, userAgent: input.userAgent,
      huellaDispositivo: input.huellaDispositivo, canal: 'web',
      sha256Documento: f.sha256, zonaHorariaMostrada: input.zonaHoraria,
    });

    await anotar(trx, {
      instanciaId: f.instancia_id, circuitoId: f.circuito_id,
      cuentaPropietariaId: f.cuenta_propietaria_id,
      tipo: 'firma.aplicada', actorTipo: 'firmante',
      identidadId: e.identidadId, participacionId: f.participacion_id,
      datos: {
        nivel_firma: f.nivel_firma,
        // La representación visual, guardada como lo que es: un texto que la
        // persona escribió. No es la firma y el expediente no la llama así.
        representacion_visual: input.nombreEscrito ?? null,
        // ⚠ Sin sello criptográfico todavía: falta el ensamblador PAdES.
        sellado_pades: false,
      },
      ocurridoEn: ahora, ip: input.ip, userAgent: input.userAgent,
      huellaDispositivo: input.huellaDispositivo, canal: 'web',
      sha256Documento: f.sha256, zonaHorariaMostrada: input.zonaHoraria,
    });

    await sql`
      update participacion
         set estado = 'firmada', firmada_en = ${ahora},
             anclaje_usado_id = ${f.anclaje_email},
             nivel_garantia_obtenido = 'bajo'
       where id = ${f.participacion_id}::uuid
    `.execute(trx);

    // ¿Queda alguien?
    const pend = await sql<{ n: string; siguiente: number | null }>`
      select count(*)::text as n, min(orden) as siguiente
        from participacion
       where instancia_id = ${f.instancia_id}::uuid and papel = 'firmante'
         and estado not in ('firmada','no_requerida','delegada','rechazada')
    `.execute(trx);

    const quedan = Number(pend.rows[0]?.n ?? 0);
    return {
      instanciaId: f.instancia_id,
      circuitoId: f.circuito_id,
      cuentaId: f.cuenta_propietaria_id,
      titulo: f.titulo,
      quedan,
      siguienteOrden: pend.rows[0]?.siguiente ?? null,
    };
  });

  // El cierre lo hace el sistema, no el firmante: cambiar el estado de la
  // instancia y del circuito no es un derecho del externo, es una consecuencia.
  if (resultado.quedan === 0) {
    await enSistema(async (trx) => {
      await sql`
        update instancia set estado = 'firmada', cerrada_en = now()
         where id = ${resultado.instanciaId}::uuid and estado = 'en_curso'
      `.execute(trx);

      const abiertas = await sql<{ n: string }>`
        select count(*)::text as n from instancia
         where circuito_id = ${resultado.circuitoId}::uuid
           and estado in ('pendiente','en_curso')
      `.execute(trx);

      if (Number(abiertas.rows[0]?.n ?? 0) === 0) {
        await sql`
          update circuito set estado = 'completo', cerrado_en = now()
           where id = ${resultado.circuitoId}::uuid and estado = 'enviado'
        `.execute(trx);
        await anotar(trx, {
          instanciaId: resultado.instanciaId,
          circuitoId: resultado.circuitoId,
          cuentaPropietariaId: resultado.cuentaId,
          tipo: 'circuito.completo',
          actorTipo: 'sistema',
          datos: { titulo: resultado.titulo },
          canal: 'sistema',
        });
      }
    });
  }

  return {
    ok: true,
    completo: resultado.quedan === 0,
    faltan: resultado.quedan,
    // Honestidad hacia afuera: la pantalla lo dice con todas las letras.
    sellado_pades: false,
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
