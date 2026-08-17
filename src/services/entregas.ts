import { sql } from 'kysely';
import { db } from '../db/pool';
import { fijarContexto } from '../db/contexto';
import { anotar } from './evidencia';

// =============================================================================
// «Llegó» — la mitad del expediente que hasta hoy no escribía nadie.
// =============================================================================
//
// `notificacion.enviada` significa, literalmente, que el servidor de correo
// ACEPTÓ el mensaje. No que llegó: un relay acepta y después no entrega
// —destinatario bloqueado, baja previa, rebote duro— y no hay excepción que
// avise. La migración 058 corrigió la descripción para que no sobreafirmara y
// dejó dicho que la otra mitad la escribe el webhook del relay. Esto es la otra
// mitad.
//
// ═══ POR QUÉ EL ACTOR ES `proveedor` Y NO `sistema` ═══
//
// ⚠⚠ Quien afirma que el correo llegó es Brevo, no nosotros. Nosotros lo único
// que sabemos es que Brevo lo dijo. El expediente tiene que poder distinguir
// entre lo que comprobó el sistema y lo que le contó un tercero, porque son
// afirmaciones de peso distinto ante un perito. El catálogo ya tenía el actor
// `proveedor` previsto para esto.
//
// ═══ POR QUÉ LA FECHA ES LA DEL EVENTO Y NO LA DE AHORA ═══
//
// Un webhook puede llegar tarde, reintentarse, o quedar encolado. Lo que importa
// para el expediente es CUÁNDO se entregó el correo, no cuándo nos enteramos.
// `anotar()` ya tenía el campo previsto — su comentario dice, textual, «se pasa
// explícito cuando llega por webhook».
//
// ⚠ El ORDEN dentro de la cadena sí es el de registro, y está bien así: la
// cadena de hashes prueba que nada se agregó ni se sacó después, y el hecho
// tiene su propia fecha. Los dos datos son distintos y los dos hacen falta.
//
// ═══ ⚠⚠ POR QUÉ UN CANDADO Y NO UN ÍNDICE ÚNICO ═══
//
// Un relay puede repetir un evento, y un endpoint público puede recibir el
// mismo aviso más de una vez. Lo obvio sería un índice ÚNICO sobre el
// Message-ID: que la base rechace el segundo, porque un insert que se estrella
// GRITA mientras que preguntar «¿ya está?» y después insertar deja una carrera
// abierta entre dos avisos simultáneos.
//
// **No se puede, y está medido** (17/8/2026):
//
//   ERROR:  unique constraint on partitioned table must include all
//           partitioning columns
//
// `evidencia` está particionada por mes, y agregarle `registrado_en` al índice
// lo volvería inútil — dos filas con distinta marca temporal no chocarían
// nunca, que es justo lo que había que impedir.
//
// La salida es la que este proyecto ya eligió para el MISMO problema: el
// trigger `evidencia_encadenar` (020) toma `pg_advisory_xact_lock` por
// instancia para que dos eventos concurrentes no bifurquen la cadena. Acá el
// candado es por Message-ID. Con él, el «¿ya está?» deja de tener carrera: los
// dos avisos del mismo mensaje se serializan y el segundo ve lo del primero.
//
// ═══ LOS DOS VEREDICTOS, Y POR QUÉ SON EXCLUYENTES (064) ═══
//
// Un mensaje termina de UNA sola manera: entregado, o no entregado. Los dos
// eventos son terminales y se excluyen, así que el «¿ya está?» pregunta por los
// DOS: si el mensaje ya tiene veredicto, no se anota otro encima.
//
//   · `notificacion.entregada`    → llegó.
//   · `notificacion.no_entregada` → salió, el relay lo aceptó, y no llegó.
//
// ⚠ Los avisos TEMPORALES del relay —rebote blando, aplazado— no llaman acá.
// Un mensaje aplazado todavía puede terminar entregado, y anotar «no llegó»
// sobre algo que puede llegar es sobreafirmar. Ver `correo_webhook.ts`.
// =============================================================================

/** Contexto de sistema: sin cuenta ni identidad. Para lo que ocurre después de
 *  la request, cuando ya no hay usuario mirando. */
async function enSistema<T>(fn: (trx: any) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await fijarContexto(trx, { actor: 'sistema' });
    return fn(trx);
  });
}

/**
 * Sin los signos `<` y `>`.
 *
 * ⚠ Se guarda y se busca normalizado. Hoy Brevo devuelve el Message-ID tal como
 * salió, con los signos; si algún día deja de ponerlos, el amarre no se rompe
 * por dos caracteres. Normalizar en los DOS extremos es lo que lo garantiza:
 * hacerlo sólo al buscar dejaría afuera todo lo ya guardado.
 */
export function normalizarMessageId(id: string | null | undefined): string {
  return (id ?? '').trim().replace(/^</, '').replace(/>$/, '');
}

export type ResultadoEntrega =
  /** Se anotó el veredicto en el expediente. */
  | 'anotada'
  /** Ese Message-ID no corresponde a ningún aviso nuestro. */
  | 'sin_correspondencia'
  /** El mensaje ya tenía veredicto. El relay repitió el evento. */
  | 'repetida';

/** Los dos veredictos posibles. Un mensaje tiene UNO, y excluye al otro. */
const VEREDICTOS = ['notificacion.entregada', 'notificacion.no_entregada'] as const;
type Veredicto = (typeof VEREDICTOS)[number];

interface AvisoDelRelay {
  /** Ya normalizado o no: se normaliza igual. */
  messageId: string;
  /** Quién lo afirma. Va al expediente. */
  proveedor: string;
  /** Cuándo pasó, según el proveedor. */
  ocurridoEn: Date;
  /** Enmascarado. ⚠ NUNCA la dirección completa ni el asunto. */
  destino?: string | null;
}

/**
 * Anota el veredicto de un mensaje en el expediente del documento al que
 * pertenece.
 *
 * Devuelve qué pasó en vez de lanzar: al webhook le sirve para el log, y ninguno
 * de los tres casos es un error del que haya que defenderse. Un Message-ID
 * desconocido es lo NORMAL mientras la cuenta de Brevo sea compartida con
 * payroll: sus avisos también llegan acá.
 */
async function anotarVeredicto(
  tipo: Veredicto,
  e: AvisoDelRelay,
  datosExtra: Record<string, unknown> = {},
): Promise<ResultadoEntrega> {
  const messageId = normalizarMessageId(e.messageId);
  if (!messageId) return 'sin_correspondencia';

  return enSistema(async (trx) => {
    // ⚠⚠ EL CANDADO VA PRIMERO, ANTES DE MIRAR NADA.
    //
    // Dura lo que la transacción y es por mensaje, así que dos avisos de
    // documentos distintos siguen escribiendo en paralelo. Sin él, dos avisos
    // simultáneos del MISMO mensaje leen los dos «no está» y anotan los dos —
    // y el expediente no admite borrar, así que la duplicación sería para
    // siempre. Ver la nota de arriba sobre por qué no alcanza un índice único.
    await sql`select pg_advisory_xact_lock(hashtextextended(${messageId}::text, 0))`.execute(trx);

    // ¿Este mensaje ya tiene veredicto? Se pregunta por los DOS, no sólo por el
    // que se quiere anotar: son excluyentes.
    const yaEsta = await sql`
      select 1
        from evidencia
       where tipo in ('notificacion.entregada', 'notificacion.no_entregada')
         and datos->>'message_id' = ${messageId}
       limit 1
    `.execute(trx);
    if (yaEsta.rows.length > 0) return 'repetida' as ResultadoEntrega;

    // De qué aviso es. El índice de la 063/064 hace que esto no recorra la
    // tabla entera de evidencia por cada aviso del relay.
    const r = await sql<{
      instancia_id: string;
      circuito_id: string;
      cuenta_propietaria_id: string;
      identidad_id: string | null;
      participacion_id: string | null;
    }>`
      select instancia_id, circuito_id, cuenta_propietaria_id,
             identidad_id, participacion_id
        from evidencia
       where tipo = 'notificacion.enviada'
         and datos->>'message_id' = ${messageId}
       order by numero_orden desc
       limit 1
    `.execute(trx);

    const aviso = r.rows[0];
    if (!aviso) return 'sin_correspondencia' as ResultadoEntrega;

    await anotar(trx, {
      instanciaId: aviso.instancia_id,
      circuitoId: aviso.circuito_id,
      cuentaPropietariaId: aviso.cuenta_propietaria_id,
      tipo,
      // ⚠ Lo afirma el proveedor, no nosotros. Ver la nota de arriba.
      actorTipo: 'proveedor',
      identidadId: aviso.identidad_id,
      participacionId: aviso.participacion_id,
      // ⚠ Sin el asunto: dice la empresa emisora y el título del documento, y
      // no aporta nada a ninguno de los dos veredictos.
      datos: {
        canal: 'email',
        proveedor: e.proveedor,
        message_id: messageId,
        destino: e.destino ?? null,
        ...datosExtra,
      },
      ocurridoEn: e.ocurridoEn,
      canal: 'webhook',
    });

    return 'anotada' as ResultadoEntrega;
  });
}

/** El aviso llegó a destino. */
export async function registrarEntrega(e: AvisoDelRelay): Promise<ResultadoEntrega> {
  return anotarVeredicto('notificacion.entregada', e);
}

/**
 * El aviso salió, el relay lo aceptó, y no se pudo entregar.
 *
 * ⚠ SÓLO para fracasos DEFINITIVOS (rebote duro, bloqueado, dirección
 * inválida). Un rebote blando o un aplazamiento todavía pueden terminar
 * entregados, y anotar «no llegó» sobre eso sería sobreafirmar. El filtro está
 * en `correo_webhook.ts`, que es quien conoce el vocabulario del proveedor.
 */
export async function registrarNoEntrega(
  e: AvisoDelRelay & {
    /** El nombre del evento tal como lo manda el proveedor: `hard_bounce`, `blocked`… */
    motivoProveedor: string;
    /** La explicación que dio el proveedor, si dio alguna. */
    detalle?: string | null;
  },
): Promise<ResultadoEntrega> {
  return anotarVeredicto('notificacion.no_entregada', e, {
    motivo_proveedor: e.motivoProveedor,
    detalle: e.detalle ?? null,
  });
}
