import { sql, type Transaction } from 'kysely';
import type { DB } from '../db/schema';

/**
 * Anotar en el expediente de evidencias.
 *
 * ═══ SIEMPRE DENTRO DE LA MISMA TRANSACCIÓN QUE EL ACTO ═══
 *
 * A diferencia de la bitácora administrativa —que tiene variantes best-effort
 * para que un fallo de log no deje a nadie afuera del sistema— acá NO hay
 * versión tolerante a fallos, y es deliberado: un acto que ocurre sin quedar
 * registrado es un acto que después no se puede probar. Si la evidencia no se
 * puede escribir, el acto no debe ocurrir. O quedan las dos cosas o no queda
 * ninguna.
 *
 * ═══ NUNCA TEXTO RENDERIZADO ═══
 *
 * `tipo` es un código del catálogo y `datos` es estructurado. Jamás "María abrió
 * el documento": el expediente se emite en el idioma del foro donde se
 * presenta, y si se guarda la oración armada queda casado con el idioma que
 * tenía la interfaz el día de la firma. Ese error no se puede deshacer, porque
 * el dato original ya se perdió.
 *
 * El número de orden y los hashes NO se calculan acá: los pone el trigger
 * `evidencia_encadenar` (migración 020). Si los eligiera la aplicación, un bug
 * podría insertar un evento en el medio de la cadena.
 */

export type ActorEvidencia = 'firmante' | 'emisor' | 'sistema' | 'proveedor' | 'operador';
export type CanalEvidencia = 'web' | 'email' | 'sms' | 'whatsapp' | 'api' | 'webhook' | 'sistema';

export interface EventoEvidencia {
  instanciaId: string;
  circuitoId: string;
  cuentaPropietariaId: string;
  /** Código del catálogo `tipo_evento`. La FK rechaza cualquier invento. */
  tipo: string;
  actorTipo: ActorEvidencia;
  identidadId?: string | null;
  participacionId?: string | null;
  datos?: Record<string, unknown>;
  /** Cuándo pasó. Por defecto ahora; se pasa explícito cuando llega por webhook. */
  ocurridoEn?: Date;
  ip?: string | null;
  userAgent?: string | null;
  huellaDispositivo?: string | null;
  canal?: CanalEvidencia;
  /** Estado del documento en ese momento. Es lo que ata el evento al contenido. */
  sha256Documento?: Buffer | null;
  zonaHorariaMostrada?: string | null;
}

export async function anotar(trx: Transaction<DB>, ev: EventoEvidencia): Promise<void> {
  // SQL crudo y no el query builder: `evidencia` llegó en la migración 020,
  // posterior a la generación de `db/schema.ts`.
  await sql`
    insert into evidencia (
      instancia_id, circuito_id, cuenta_propietaria_id,
      identidad_id, participacion_id, actor_tipo,
      tipo, datos, ocurrido_en,
      ip, user_agent, huella_dispositivo, canal,
      sha256_documento, zona_horaria_mostrada,
      -- El trigger los pisa; van con valores de relleno porque son NOT NULL y
      -- el BEFORE INSERT corre después de la validación de nulos.
      numero_orden, hash_contenido, hash_propio
    ) values (
      ${ev.instanciaId}::uuid, ${ev.circuitoId}::uuid, ${ev.cuentaPropietariaId}::uuid,
      ${ev.identidadId ?? null}, ${ev.participacionId ?? null}, ${ev.actorTipo},
      ${ev.tipo}, ${JSON.stringify(ev.datos ?? {})}::jsonb, ${ev.ocurridoEn ?? new Date()},
      ${ev.ip ?? null}::inet, ${ev.userAgent ?? null}, ${ev.huellaDispositivo ?? null},
      ${ev.canal ?? 'web'},
      ${ev.sha256Documento ?? null}, ${ev.zonaHorariaMostrada ?? null},
      0, ''::bytea, ''::bytea
    )
  `.execute(trx);
}

/**
 * El expediente de una instancia, en orden.
 *
 * Devuelve los datos crudos y el código del evento; la oración la arma quien
 * muestra, en el idioma que corresponda. La RLS decide si esta persona puede
 * verlo: la cuenta dueña, quien tenga otorgamiento de alcance `evidencia`, o el
 * propio firmante con identidad probada.
 */
export async function expediente(trx: Transaction<DB>, instanciaId: string) {
  const r = await sql<{
    numero_orden: string; tipo: string; categoria: string; peso: string;
    descripcion_i18n: unknown; datos: unknown; actor_tipo: string;
    identidad_id: string | null; nombre: string | null; email: string | null;
    ocurrido_en: Date; registrado_en: Date; ip: string | null; user_agent: string | null;
    canal: string | null; sha256_documento: string | null;
    hash_propio: string; hash_anterior: string | null; sellado: boolean;
  }>`
    select e.numero_orden, e.tipo, t.categoria, t.peso, t.descripcion_i18n,
           e.datos, e.actor_tipo, e.identidad_id,
           i.nombre_mostrado as nombre, i.email_mostrado as email,
           e.ocurrido_en, e.registrado_en, host(e.ip) as ip, e.user_agent, e.canal,
           encode(e.sha256_documento,'hex') as sha256_documento,
           encode(e.hash_propio,'hex') as hash_propio,
           encode(e.hash_anterior,'hex') as hash_anterior,
           (e.sello_tiempo_id is not null) as sellado
      from evidencia e
      join tipo_evento t on t.codigo = e.tipo
      left join identidad i on i.id = e.identidad_id
     where e.instancia_id = ${instanciaId}::uuid
     order by e.numero_orden
  `.execute(trx);
  return r.rows;
}

/**
 * Verifica que la cadena cierre.
 *
 * Recalcula `hash_propio` a partir de `hash_anterior` y `hash_contenido` y
 * comprueba que la secuencia no tenga huecos. No recalcula `hash_contenido`
 * —eso exige los campos originales, que pueden haberse purgado— y ese es
 * justamente el punto del diseño en dos pasos: la cadena sigue verificando
 * después de suprimir datos personales.
 *
 * Se corre antes de emitir un certificado de finalización. Un expediente que no
 * cierra no se entrega: se investiga.
 */
export async function verificarCadena(trx: Transaction<DB>, instanciaId: string) {
  const r = await sql<{ eventos: string; huecos: string; rotos: string }>`
    with c as (
      select numero_orden, hash_anterior, hash_contenido, hash_propio,
             lag(hash_propio) over (order by numero_orden) as previo_real,
             lag(numero_orden) over (order by numero_orden) as previo_num
        from evidencia
       where instancia_id = ${instanciaId}::uuid
    )
    select count(*)::text as eventos,
           count(*) filter (
             where previo_num is not null and numero_orden <> previo_num + 1
           )::text as huecos,
           count(*) filter (
             where hash_propio is distinct from digest(
               coalesce(encode(hash_anterior,'hex'),'') ||'|'|| encode(hash_contenido,'hex'), 'sha256')
                or hash_anterior is distinct from previo_real
           )::text as rotos
      from c
  `.execute(trx);

  const f = r.rows[0]!;
  return {
    eventos: Number(f.eventos),
    huecos: Number(f.huecos),
    rotos: Number(f.rotos),
    integra: Number(f.huecos) === 0 && Number(f.rotos) === 0,
  };
}
