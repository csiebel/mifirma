import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { db } from '../db/pool';
import { fijarContexto } from '../db/contexto';
import { withUsuario } from '../auth/authz';
import { almacen, nuevaClave } from '../almacenamiento/almacen';
import { anotar, verificarCadena } from './evidencia';
import { verificar } from '../firma/pades';
import { contarCambio } from '../firma/cambios';
import { HttpError } from '../http/errors';
import { dibujar, type DatosCertificado } from './certificado_pdf';

/**
 * El certificado de finalización.
 *
 * ═══ ES EL ENTREGABLE ═══
 *
 * El expediente de una instancia tiene ciento veinte eventos encadenados por
 * hash. Nadie lee eso. **El certificado es la única parte del sistema de
 * auditoría que un abogado va a mirar**, y en la práctica es lo que decide si
 * nos compran: cuenta en una carilla quién firmó, cómo se identificó, cuándo,
 * con qué sello, y cómo comprobarlo sin nosotros.
 *
 * Implementa `claude/auditoria-y-evidencias.md` §4.
 *
 * ═══ SE EMITE UNA VEZ Y NO SE REGENERA ═══
 *
 * Un certificado que se rearma al pedirlo puede salir distinto: cambia la
 * plantilla, se mejora un texto, se agrega un campo. El que un cliente presentó
 * en marzo y el que se baja en agosto no coincidirían, y el que tendría que
 * explicar la diferencia sería él, en una audiencia.
 *
 * Por eso se guarda el PDF **y** los datos estructurados que lo produjeron. Si
 * en tres años hay que reimprimirlo en otro idioma, la fuente está.
 *
 * ═══ ⚠ QUÉ AFIRMA Y QUÉ NO ═══
 *
 * Todo lo que dice sale del expediente y del PDF firmado, no de nuestra
 * opinión. Y lo que no se puede afirmar se dice que no se puede: si la cadena
 * no cierra, el certificado lo lleva escrito arriba de todo. Un certificado que
 * sólo se emite cuando todo está bien no sirve para probar nada — sirve para
 * vender.
 */

const VERSION_PLANTILLA = 1;

// ---------------------------------------------------------------------------
// Los datos
// ---------------------------------------------------------------------------

async function enSistema<T>(fn: (trx: any) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await fijarContexto(trx, { actor: 'sistema' });
    return fn(trx);
  });
}

async function reunir(trx: any, instanciaId: string): Promise<DatosCertificado> {
  const c = await sql<{
    circuito_id: string; numero: number; instancias: string; titulo: string;
    modo: string; nivel_firma: string; pais: string | null; emisor: string;
    creado_en: Date; enviado_en: Date | null; cerrado_en: Date | null; estado: string;
    sha256_base: Buffer; sha256_firmado: Buffer | null; paginas: number | null;
    bytes: string | null; clave_firmado: string | null;
    cuenta_propietaria_id: string;
  }>`
    select c.id as circuito_id, i.numero,
           (select count(*) from instancia x where x.circuito_id = c.id)::text as instancias,
           c.titulo, c.modo, c.nivel_firma, c.pais_marco as pais,
           cu.nombre_mostrado as emisor, c.creado_en, c.enviado_en, c.cerrado_en, c.estado,
           ab.sha256 as sha256_base, af.sha256 as sha256_firmado,
           coalesce(af.paginas, ab.paginas) as paginas,
           af.bytes::text as bytes, af.clave_almacenamiento as clave_firmado,
           c.cuenta_propietaria_id
      from instancia i
      join circuito c on c.id = i.circuito_id
      join archivo ab on ab.id = c.archivo_base_id
      left join archivo af on af.id = i.archivo_firmado_id
      left join cuenta cu on cu.id = c.cuenta_propietaria_id
     where i.id = ${instanciaId}::uuid
  `.execute(trx);

  const f = c.rows[0];
  if (!f) throw new HttpError(404, 'Esa instancia no existe.');

  // Los firmantes, con cómo se identificó cada uno.
  //
  // ⚠ `anclaje_identidad` es la lista de lo que la persona PROBÓ, con la fecha
  // en que lo probó. Es la respuesta a «¿cómo saben que era él?», y es la
  // pregunta que se hace en un juicio. No se deduce del correo al que se mandó.
  const p = await sql<{
    id: string; nombre: string | null; email: string; papel: string; orden: number;
    estado: string; firmada_en: Date | null; nivel: string | null;
    motivo_rechazo: string | null; identidad_id: string;
  }>`
    select p.id, i.nombre_mostrado as nombre, i.email_mostrado as email,
           p.papel, p.orden, p.estado, p.firmada_en,
           p.nivel_garantia_obtenido as nivel, p.motivo_rechazo, p.identidad_id
      from participacion p
      join identidad i on i.id = p.identidad_id
     where p.instancia_id = ${instanciaId}::uuid
     order by p.orden, i.email_mostrado
  `.execute(trx);

  const anclajes = await sql<{ identidad_id: string; tipo: string; probado_en: Date }>`
    select identidad_id, tipo, probado_en
      from anclaje_identidad
     where identidad_id = any(${p.rows.map((x) => x.identidad_id)}::uuid[])
       and revocado_en is null and probado_en is not null
     order by probado_en
  `.execute(trx);

  const eventos = await sql<{
    participacion_id: string | null; tipo: string; ocurrido_en: Date;
    ip: string | null; datos: any;
  }>`
    select participacion_id, tipo, ocurrido_en, host(ip) as ip, datos
      from evidencia
     where instancia_id = ${instanciaId}::uuid
     order by numero_orden
  `.execute(trx);

  const sellos = await sql<{ autoridad: string; sellado_en: Date; token: Buffer }>`
    select autoridad, sellado_en, token from sello_tiempo
     where instancia_id = ${instanciaId}::uuid and alcance = 'firma'
     order by sellado_en
  `.execute(trx);

  const cadena = await verificarCadena(trx, instanciaId);
  const ultimo = await sql<{ hash_propio: string }>`
    select encode(hash_propio,'hex') as hash_propio from evidencia
     where instancia_id = ${instanciaId}::uuid
     order by numero_orden desc limit 1
  `.execute(trx);

  // ── El PDF firmado, verificado de nuevo AL EMITIR.
  //
  // No se copia lo que dijimos cuando firmamos: se vuelve a mirar el archivo.
  // Si entre medio pasó algo, el certificado tiene que decirlo.
  let doc = {
    firmas_en_el_pdf: 0,
    integro: null as boolean | null,
    contenido_alterado_entre_firmas: null as boolean | null,
    cambios: [] as string[],
  };
  if (f.clave_firmado) {
    try {
      const v = verificar(await almacen().leer(f.clave_firmado));
      doc = {
        firmas_en_el_pdf: v.firmas.length,
        integro: v.integro,
        contenido_alterado_entre_firmas: v.contenido_alterado_entre_firmas,
        cambios: v.cambios.map((x) => `Después de la firma ${x.despuesDeFirma}: ${contarCambio(x)}`),
      };
    } catch { /* se emite igual, diciendo que no se pudo */ }
  }

  const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

  return {
    version_plantilla: VERSION_PLANTILLA,
    emitido_en: new Date().toISOString(),
    circuito: {
      id: f.circuito_id, instancia_id: instanciaId, numero: f.numero,
      instancias: Number(f.instancias), titulo: f.titulo, modo: f.modo,
      nivel_firma: f.nivel_firma, pais: f.pais, emisor: f.emisor ?? '—',
      creado_en: iso(f.creado_en)!, enviado_en: iso(f.enviado_en),
      cerrado_en: iso(f.cerrado_en), estado: f.estado,
    },
    documento: {
      sha256_base: Buffer.from(f.sha256_base).toString('hex'),
      sha256_firmado: f.sha256_firmado ? Buffer.from(f.sha256_firmado).toString('hex') : null,
      paginas: f.paginas, bytes: f.bytes ? Number(f.bytes) : null,
      ...doc,
    },
    firmantes: p.rows.map((x, n) => ({
      nombre: x.nombre, email: x.email, papel: x.papel, orden: x.orden,
      estado: x.estado, firmada_en: iso(x.firmada_en), nivel_garantia: x.nivel,
      identificacion: anclajes.rows
        .filter((a) => a.identidad_id === x.identidad_id)
        .map((a) => ({ tipo: a.tipo, probado_en: iso(a.probado_en)! })),
      certificado: null,
      sello: sellos.rows[n]
        ? {
            autoridad: sellos.rows[n]!.autoridad,
            sellado_en: iso(sellos.rows[n]!.sellado_en)!,
            serie: createHash('sha256').update(sellos.rows[n]!.token).digest('hex').slice(0, 16),
          }
        : null,
      cronologia: eventos.rows
        .filter((e) => e.participacion_id === x.id)
        .map((e) => ({ tipo: e.tipo, cuando: iso(e.ocurrido_en)!, ip: e.ip })),
      motivo_rechazo: x.motivo_rechazo,
    })),
    evidencia: {
      eventos: cadena.eventos, huecos: cadena.huecos, rotos: cadena.rotos,
      cadena_ok: cadena.huecos === 0 && cadena.rotos === 0,
      hash_raiz: ultimo.rows[0]?.hash_propio ?? '',
    },
  };
}

// ---------------------------------------------------------------------------
// Emitir
// ---------------------------------------------------------------------------

/**
 * Emite el certificado de una instancia cerrada. Idempotente: si ya existe, lo
 * devuelve.
 *
 * ⚠ Se llama al cerrarse el circuito, FUERA de la transacción de la firma. Si
 * falla, la firma ya está hecha y el certificado se puede emitir después —lo
 * que no se puede es perder la firma por un problema al dibujar un PDF.
 */
export async function emitirCertificado(instanciaId: string): Promise<{ archivoId: string; nuevo: boolean }> {
  const previo = await enSistema(async (trx) =>
    (await sql<{ archivo_id: string }>`
      select archivo_id from certificado_finalizacion where instancia_id = ${instanciaId}::uuid
    `.execute(trx)).rows[0] ?? null,
  );
  if (previo) return { archivoId: previo.archivo_id, nuevo: false };

  const datos = await enSistema((trx) => reunir(trx, instanciaId));
  const pdf = await dibujar(datos);

  const clave = nuevaClave();
  await almacen().guardar(clave, pdf);
  const sha = createHash('sha256').update(pdf).digest();

  return enSistema(async (trx) => {
    const archivoId = randomUUID();
    await sql`
      insert into archivo (id, sha256, bytes, mime, clase, cuenta_custodia_id,
                           region, clave_almacenamiento, paginas)
      values (${archivoId}::uuid, ${sha}, ${pdf.length}, 'application/pdf', 'evidencia',
              (select cuenta_propietaria_id from instancia where id = ${instanciaId}::uuid),
              ${almacen().region}, ${clave}, null)
    `.execute(trx);

    await sql`
      insert into certificado_finalizacion
        (instancia_id, circuito_id, cuenta_propietaria_id, archivo_id, datos,
         idioma_emitido, version_plantilla, hash_raiz_evidencia, eventos_incluidos, cadena_ok)
      values (${instanciaId}::uuid, ${datos.circuito.id}::uuid,
              (select cuenta_propietaria_id from instancia where id = ${instanciaId}::uuid),
              ${archivoId}::uuid, ${JSON.stringify(datos)}::jsonb, ${datos.circuito.pais === 'BR' ? 'pt' : 'es'},
              ${VERSION_PLANTILLA}, decode(${datos.evidencia.hash_raiz || '00'}, 'hex'),
              ${datos.evidencia.eventos}, ${datos.evidencia.cadena_ok})
      on conflict (instancia_id) do nothing
    `.execute(trx);

    await anotar(trx, {
      instanciaId,
      circuitoId: datos.circuito.id,
      cuentaPropietariaId: (await sql<{ c: string }>`
        select cuenta_propietaria_id as c from instancia where id = ${instanciaId}::uuid
      `.execute(trx)).rows[0]!.c,
      tipo: 'certificado.emitido',
      actorTipo: 'sistema',
      canal: 'sistema',
      datos: {
        sha256: sha.toString('hex'),
        version_plantilla: VERSION_PLANTILLA,
        eventos_incluidos: datos.evidencia.eventos,
        cadena_ok: datos.evidencia.cadena_ok,
      },
      sha256Documento: sha,
    });

    return { archivoId, nuevo: true };
  });
}

/** El PDF del certificado, para descargarlo. */
export async function bajarCertificado(cuentaId: string, identidadId: string, instanciaId: string) {
  const datos = await withUsuario(cuentaId, identidadId, async (trx) => {
    const r = await sql<{ clave: string; titulo: string }>`
      select a.clave_almacenamiento as clave, c.titulo
        from certificado_finalizacion cf
        join archivo a on a.id = cf.archivo_id
        join circuito c on c.id = cf.circuito_id
       where cf.instancia_id = ${instanciaId}::uuid
    `.execute(trx);
    return r.rows[0] ?? null;
  });

  if (!datos) {
    throw new HttpError(
      404,
      'Este documento todavía no tiene certificado de finalización. Se emite cuando ' +
        'termina de firmarlo la última persona.',
    );
  }
  return { contenido: await almacen().leer(datos.clave), nombre: `Certificado — ${datos.titulo}.pdf` };
}
