import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { withUsuario, exigir } from '../auth/authz';
import { almacen, nuevaClave } from '../almacenamiento/almacen';
import { anotar } from './evidencia';
import { verificar } from '../firma/pades';
import { registrar } from './auditoria';
import { HttpError } from '../http/errors';

/**
 * El repositorio: documentos dentro de carpetas.
 *
 * ═══ QUÉ ES "SUBIR UN DOCUMENTO" ═══
 *
 * No hay una tabla "documento". Subir un PDF crea cuatro filas:
 *
 *   · `archivo`    — el blob inmutable y su huella
 *   · `circuito`   — el documento base más la configuración de firmas, en borrador
 *   · `instancia`  — el PDF que va a terminar firmado, con su propio expediente
 *   · `ubicacion`  — dónde queda, en la carpeta de ESTA cuenta
 *
 * Puede parecer mucho para "subí un archivo", pero es lo que evita el rediseño
 * de la semana siguiente: los tres modos de firma —serie, paralelo, copias— son
 * configuración del mismo mecanismo, no caminos de código distintos. Un
 * documento subido es un circuito de una sola instancia que todavía no se
 * despachó. Cuando se le agregan firmantes y se envía, no se convierte en otra
 * cosa: cambia de estado.
 *
 * ═══ POR QUÉ LOS UUID SE GENERAN ACÁ Y NO CON `RETURNING` ═══
 *
 * `INSERT ... RETURNING` aplica también la política de SELECT. Y las políticas
 * de `circuito` y `archivo` exigen que exista una `ubicacion` que los alcance —
 * que todavía no existe, porque se inserta al final. El insert entraría y la
 * lectura de vuelta lo negaría, con el mensaje "new row violates row-level
 * security policy" apuntando al INSERT, que es donde el problema no está.
 * Generar los id antes esquiva el problema entero. Es la misma trampa de la
 * migración 018.
 */

const MIME_ACEPTADOS = new Set(['application/pdf']);
const MAX_BYTES = 30 * 1024 * 1024;

export interface SubirInput {
  carpetaId: string;
  titulo: string;
  nombreArchivo: string;
  mime: string;
  contenido: Buffer;
  ip?: string | null;
  userAgent?: string | null;
}

export async function subirDocumento(cuentaId: string, identidadId: string, input: SubirInput) {
  if (!MIME_ACEPTADOS.has(input.mime)) {
    throw new HttpError(400, 'Por ahora sólo se aceptan PDF.');
  }
  if (!input.contenido?.length) throw new HttpError(400, 'El archivo llegó vacío.');
  if (input.contenido.length > MAX_BYTES) {
    throw new HttpError(413, 'El archivo pasa de 30 MB.');
  }
  // Un PDF empieza con %PDF-. No es una validación fuerte —no lo pretende— pero
  // ataja el caso común de un archivo renombrado, que si no revienta recién
  // cuando alguien lo intenta firmar.
  if (input.contenido.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new HttpError(400, 'Ese archivo no es un PDF, aunque se llame .pdf.');
  }

  const titulo = (input.titulo || input.nombreArchivo || '').trim().slice(0, 200);
  if (!titulo) throw new HttpError(400, 'Falta el título del documento.');

  const sha256 = createHash('sha256').update(input.contenido).digest();
  const clave = nuevaClave();
  const alm = almacen();

  // Los bytes primero, la base después.
  //
  // Al revés, una fila podría quedar apuntando a un archivo que no existe: la
  // base diría que el documento está y la descarga daría 404 para siempre. En
  // este orden, lo peor que pasa es un blob huérfano — basura recuperable, no
  // un documento roto.
  await alm.guardar(clave, input.contenido);

  try {
    return await withUsuario(cuentaId, identidadId, async (trx, autz) => {
      exigir(autz, 'documento', 'crear', 'No tenés permiso para subir documentos.');

      const carpeta = await sql<{ id: string; puede: boolean }>`
        select id, app.puede_en_carpeta(id, 'crear') as puede
          from carpeta where id = ${input.carpetaId}::uuid and cuenta_id = ${cuentaId}::uuid
      `.execute(trx);
      if (!carpeta.rows.length) throw new HttpError(404, 'Esa carpeta no existe.');
      if (!carpeta.rows[0]!.puede) {
        throw new HttpError(403, 'No tenés permiso para crear documentos en esa carpeta.');
      }

      const cuenta = await trx
        .selectFrom('cuenta')
        .select(['pais', 'idioma'])
        .where('id', '=', cuentaId)
        .executeTakeFirstOrThrow();

      // Mismo contenido subido dos veces por la misma cuenta: se reutiliza la
      // fila de `archivo`. El unique (sha256, cuenta_custodia_id) ya lo impone;
      // consultarlo antes evita el error y ahorra un blob duplicado.
      const previo = await sql<{ id: string; clave_almacenamiento: string }>`
        select id, clave_almacenamiento from archivo
         where sha256 = ${sha256} and cuenta_custodia_id = ${cuentaId}::uuid
      `.execute(trx);

      let archivoId: string;
      let claveUsada = clave;
      if (previo.rows.length) {
        archivoId = previo.rows[0]!.id;
        claveUsada = previo.rows[0]!.clave_almacenamiento;
      } else {
        archivoId = randomUUID();
        await sql`
          insert into archivo (id, sha256, bytes, mime, clase, cuenta_custodia_id,
                               region, clave_almacenamiento)
          values (${archivoId}::uuid, ${sha256}, ${input.contenido.length}, ${input.mime},
                  'base', ${cuentaId}::uuid, ${alm.region}, ${clave})
        `.execute(trx);
      }

      const circuitoId = randomUUID();
      const instanciaId = randomUUID();

      await sql`
        insert into circuito (id, cuenta_propietaria_id, creado_por_identidad_id,
                              archivo_base_id, titulo, modo, estado,
                              pais_marco, nivel_firma, idioma)
        values (${circuitoId}::uuid, ${cuentaId}::uuid, ${identidadId}::uuid,
                ${archivoId}::uuid, ${titulo}, 'serie', 'borrador',
                ${cuenta.pais}, 'simple', ${cuenta.idioma ?? 'es'})
      `.execute(trx);

      // Serie y paralelo son una sola instancia; copias son N. Un documento
      // recién subido siempre arranca con una.
      await sql`
        insert into instancia (id, circuito_id, cuenta_propietaria_id, numero,
                               estado, sha256_vigente)
        values (${instanciaId}::uuid, ${circuitoId}::uuid, ${cuentaId}::uuid, 1,
                'pendiente', ${sha256})
      `.execute(trx);

      // ⚠ LA UBICACIÓN DEL EMISOR APUNTA AL CIRCUITO, NO A LA INSTANCIA.
      //
      // Y no es indistinto. `archivo_select` (009) sólo deja ver el archivo base
      // por este camino:
      //
      //   exists (select 1 from circuito c join ubicacion u on u.circuito_id = c.id
      //            where c.archivo_base_id = archivo.id ...)
      //
      // Con la ubicación colgada de la instancia, ese join no encuentra nada y
      // el archivo se vuelve invisible: el documento se sube bien y la lista
      // aparece vacía, sin ningún error. La RLS no falla, filtra.
      //
      // La política tiene razón sobre el modelo: en el repositorio del EMISOR lo
      // que vive es el circuito —el documento con su camino de firmas—, y la
      // ubicación por instancia es para la bandeja del FIRMANTE, que recibe una
      // copia puntual. Ver el encabezado de la 007.
      await sql`
        insert into ubicacion (cuenta_id, carpeta_id, circuito_id)
        values (${cuentaId}::uuid, ${input.carpetaId}::uuid, ${circuitoId}::uuid)
      `.execute(trx);

      // El primer evento del expediente. Desde acá la instancia tiene cadena.
      await anotar(trx, {
        instanciaId,
        circuitoId,
        cuentaPropietariaId: cuentaId,
        tipo: 'documento.subido',
        actorTipo: 'emisor',
        identidadId,
        datos: {
          titulo,
          nombre_archivo: input.nombreArchivo,
          bytes: input.contenido.length,
          reutilizo_archivo: previo.rows.length > 0,
        },
        ip: input.ip,
        userAgent: input.userAgent,
        sha256Documento: sha256,
        canal: 'web',
      });

      return {
        instancia_id: instanciaId,
        circuito_id: circuitoId,
        archivo_id: archivoId,
        titulo,
        sha256: sha256.toString('hex'),
        bytes: input.contenido.length,
        duplicado: previo.rows.length > 0,
        clave_usada: claveUsada,
      };
    });
  } catch (e) {
    // La transacción no quedó: el blob que acabamos de escribir no lo referencia
    // nadie. Se borra, salvo que fuera uno preexistente reutilizado — pero en
    // ese camino nunca llegamos acá con `clave` propia.
    await alm.borrar(clave);
    throw e;
  }
}

/**
 * Los documentos de una carpeta.
 *
 * No hace falta filtrar por permiso: `ubicacion_select` exige `ver` sobre la
 * carpeta y las políticas de `circuito` e `instancia` exigen que la ubicación
 * los alcance. Si algo no aparece, es porque la base decidió que no se ve.
 */
/**
 * Los documentos de una carpeta, y opcionalmente los de toda su rama.
 *
 * ═══ POR QUÉ ES UNA OPCIÓN Y NO EL COMPORTAMIENTO ═══
 *
 * Los permisos SÍ bajan por la rama —lo que das arriba vale para todo lo que
 * cuelga— así que mostrar los documentos de las subcarpetas no abre nada que la
 * persona no pudiera ver entrando una por una. Pero "puedo verlo" y "quiero
 * verlo todo junto" no son lo mismo: con la rama incluida, la raíz muestra
 * SIEMPRE todos los documentos de la cuenta, y las carpetas dejan de servir
 * para lo que se hicieron, que es mirar menos cosas a la vez. Un envío masivo
 * de tres mil copias vuelve esa lista inútil.
 *
 * Por eso es una casilla que el usuario prende cuando busca algo y apaga cuando
 * trabaja.
 *
 * ═══ EL FILTRO SIGUE SIENDO DE LA BASE ═══
 *
 * La rama se resuelve con `ruta <@ ruta_del_padre` sobre `carpeta`, que tiene su
 * propia RLS: una subcarpeta sobre la que no tenés `ver` no entra en el
 * subconsulta, y sus documentos tampoco. No hay que acordarse de filtrar nada
 * acá — si esta función se equivocara, la política seguiría alcanzando.
 */
export async function listarDocumentos(
  cuentaId: string,
  identidadId: string,
  carpetaId: string,
  incluirSubcarpetas = false,
) {
  return withUsuario(cuentaId, identidadId, async (trx) => {
    const alcance = incluirSubcarpetas
      ? sql`u.carpeta_id in (
              select c2.id from carpeta c2
               where c2.ruta <@ (select ruta from carpeta where id = ${carpetaId}::uuid))`
      : sql`u.carpeta_id = ${carpetaId}::uuid`;

    // Se listan las ubicaciones de CIRCUITO, que son las del repositorio del
    // emisor. Cuando exista la bandeja del firmante habrá una segunda consulta
    // para las ubicaciones de instancia: son dos vistas distintas del mismo
    // documento y mezclarlas en una sola lista confunde "lo que mandé" con "lo
    // que me pidieron firmar".
    //
    // `copias` produce N instancias bajo un solo circuito. La lista muestra UNA
    // fila —el envío— con su conteo, no tres mil filas: el emisor mandó una
    // cosa. `instancia_id` es la primera, que es la que se abre al hacer clic.
    const r = await sql<{
      instancia_id: string; circuito_id: string; titulo: string; carpeta_id: string;
      circuito_estado: string; modo: string; nivel_firma: string;
      bytes: string; paginas: number | null; creado_en: Date;
      instancias: string; firmas_total: string; firmas_hechas: string;
      sin_avisar: string; cadena_rota: boolean;
    }>`
      select c.id as circuito_id, c.titulo, u.carpeta_id,
             c.estado as circuito_estado, c.modo, c.nivel_firma,
             a.bytes::text as bytes, a.paginas, c.creado_en,

             -- Despachado pero sin avisar: la notificación no salió. Sin esto,
             -- el emisor espera indefinidamente la firma de alguien que nunca
             -- se enteró — y el documento se ve idéntico a uno que sí avisó.
             --
             -- ⚠ SÓLO A QUIEN LE TOCA AHORA. En una firma en serie, el segundo
             -- está en 'pendiente' porque todavía no es su turno, no porque el
             -- aviso haya fallado. Contarlo como fallido convierte el
             -- funcionamiento normal en una alarma roja, y una alarma que
             -- aparece cuando todo está bien deja de mirarse.
             (select count(*) from participacion p
               where p.circuito_id = c.id and p.papel = 'firmante'
                 and p.estado = 'pendiente'
                 and p.orden = (
                   select min(p2.orden) from participacion p2
                    where p2.circuito_id = c.id and p2.papel = 'firmante'
                      and p2.estado not in ('firmada','no_requerida','delegada','rechazada')
                 ))::text as sin_avisar,

             -- El expediente comprometido se marca en la LISTA, no sólo adentro
             -- del expediente: si hay que abrir cada documento para descubrirlo,
             -- se descubre el día que hace falta el certificado.
             exists (
               select 1 from (
                 select e.instancia_id,
                        count(*) as n,
                        count(distinct e.numero_orden) as distintos,
                        max(e.numero_orden) as ultimo
                   from evidencia e
                   join instancia i2 on i2.id = e.instancia_id
                  where i2.circuito_id = c.id
                  group by e.instancia_id
               ) x where x.n <> x.distintos or x.ultimo <> x.n
             ) as cadena_rota,
             (select i.id from instancia i
               where i.circuito_id = c.id order by i.numero limit 1) as instancia_id,
             (select count(*) from instancia i where i.circuito_id = c.id)::text as instancias,
             (select count(*) from participacion p
               where p.circuito_id = c.id and p.papel = 'firmante')::text as firmas_total,
             (select count(*) from participacion p
               where p.circuito_id = c.id and p.papel = 'firmante'
                 and p.estado = 'firmada')::text as firmas_hechas
        from ubicacion u
        join circuito c on c.id = u.circuito_id
        join archivo a on a.id = c.archivo_base_id
       where u.cuenta_id = ${cuentaId}::uuid
         and ${alcance}
         and u.circuito_id is not null
         and not u.archivada
       order by c.creado_en desc
    `.execute(trx);

    return r.rows.map((f) => ({
      ...f,
      bytes: Number(f.bytes),
      instancias: Number(f.instancias),
      firmas_total: Number(f.firmas_total),
      firmas_hechas: Number(f.firmas_hechas),
      sin_avisar: Number(f.sin_avisar),
    }));
  });
}

/**
 * Los bytes de un documento, más su registro de descarga.
 *
 * Quién descargó qué es una de las tres preguntas que aparecen cuando algo sale
 * mal, y si no se registra desde el principio no hay forma de responderla. Por
 * eso la descarga anota en el expediente, no en la bitácora administrativa: es
 * un evento sobre el documento.
 */
export async function bajarDocumento(
  cuentaId: string,
  identidadId: string,
  instanciaId: string,
  ctx: { ip?: string | null; userAgent?: string | null } = {},
) {
  const datos = await withUsuario(cuentaId, identidadId, async (trx) => {
    const r = await sql<{
      circuito_id: string; titulo: string; mime: string; clave: string;
      region: string; sha256: Buffer; firmado: boolean;
    }>`
      select c.id as circuito_id, c.titulo, a.mime,
             a.clave_almacenamiento as clave, a.region, a.sha256,
             (i.archivo_firmado_id is not null) as firmado
        from instancia i
        join circuito c on c.id = i.circuito_id
        -- El firmado si existe; si no, el base. Quien pide "el documento"
        -- quiere el que vale, y una vez firmado el que vale es el firmado.
        join archivo a on a.id = coalesce(i.archivo_firmado_id, c.archivo_base_id)
       where i.id = ${instanciaId}::uuid
    `.execute(trx);

    const f = r.rows[0];
    if (!f) throw new HttpError(404, 'Ese documento no existe o no lo podés ver.');

    await anotar(trx, {
      instanciaId,
      circuitoId: f.circuito_id,
      cuentaPropietariaId: cuentaId,
      tipo: 'documento.descargado',
      actorTipo: 'emisor',
      identidadId,
      datos: { firmado: f.firmado },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      sha256Documento: f.sha256,
      canal: 'web',
    });

    return f;
  });

  const contenido = await almacen().leer(datos.clave);

  // Que el contenido siga siendo el que la base dice. Si no coincide, algo pasó
  // en el almacenamiento y entregarlo igual sería entregar un documento cuya
  // huella no cierra con su propia evidencia.
  const real = createHash('sha256').update(contenido).digest();
  if (!real.equals(datos.sha256)) {
    throw new HttpError(500, 'El archivo almacenado no coincide con su huella registrada.');
  }

  return {
    contenido,
    mime: datos.mime,
    nombre: `${datos.titulo.replace(/[^\w\s.-]/g, '').trim() || 'documento'}.pdf`,
  };
}

/**
 * Las firmas criptográficas que tiene el PDF, verificadas.
 *
 * Esto NO lee la base de datos para responder: abre el archivo y comprueba, por
 * cada firma, que el digest firmado coincida con los bytes que esa firma dice
 * cubrir. Es a propósito — la pregunta que responde es "¿el documento cambió
 * después de firmado?", y una respuesta que saliera de nuestras propias tablas
 * no probaría nada: cualquiera puede escribir en su base que un documento es
 * válido.
 *
 * Es la misma verificación que puede hacer un tercero con el PDF en la mano y
 * sin acceso a nada nuestro. Ese es el punto de la firma electrónica.
 */
/**
 * Cambia el documento de carpeta.
 *
 * ═══ ES UNA FILA, NO UNA COPIA ═══
 *
 * Mover no toca el archivo ni el circuito: mueve la `ubicacion`, que es
 * justamente la fila que dice "este documento está acá, en esta carpeta de esta
 * cuenta". El mismo circuito puede estar ubicado en la carpeta del emisor y en
 * la bandeja de cada firmante sin que ninguno de esos movimientos afecte a los
 * demás. Por eso el modelo tiene una tabla `ubicacion` en lugar de una columna
 * `carpeta_id` en `circuito`.
 *
 * ═══ EL PERMISO YA ESTÁ ESCRITO, Y NO ACÁ ═══
 *
 * `ubicacion_update` exige `app.puede_en_carpeta(carpeta_id, 'mover')`, y como
 * la política no declara WITH CHECK, PostgreSQL usa la misma expresión para la
 * fila vieja y para la nueva. O sea: hace falta permiso de mover en el ORIGEN y
 * en el DESTINO, sin que nadie tenga que acordarse de comprobar las dos cosas
 * en el código. Es exactamente la clase de regla que no debe vivir acá.
 *
 * ═══ POR QUÉ SE LEE ANTES DE ESCRIBIR ═══
 *
 * Si el UPDATE no toca ninguna fila hay dos causas posibles —el documento no
 * existe, o existe y no tenés permiso— y son dos mensajes distintos para el
 * usuario. La RLS no las distingue: filtra en silencio. El SELECT previo separa
 * los casos, para no volver a caer en un mensaje que tapa dos problemas.
 *
 * ⚠ Esto va a la BITÁCORA y no al expediente. Mover un documento de carpeta es
 * administración del repositorio, no un hecho sobre la firma: el expediente
 * responde qué le pasó al documento como prueba, y dónde lo guarda su dueño no
 * es parte de eso.
 */
export async function moverDocumento(
  cuentaId: string,
  identidadId: string,
  instanciaId: string,
  carpetaDestinoId: string,
) {
  return withUsuario(cuentaId, identidadId, async (trx) => {
    const actual = await sql<{ ubicacion_id: string; carpeta_id: string; titulo: string }>`
      select u.id as ubicacion_id, u.carpeta_id, c.titulo
        from instancia i
        join circuito c on c.id = i.circuito_id
        join ubicacion u on u.circuito_id = c.id and u.cuenta_id = ${cuentaId}::uuid
       where i.id = ${instanciaId}::uuid
    `.execute(trx);

    const fila = actual.rows[0];
    if (!fila) throw new HttpError(404, 'Ese documento no existe o no lo podés ver.');
    if (fila.carpeta_id === carpetaDestinoId) {
      return { ok: true, sin_cambios: true, titulo: fila.titulo };
    }

    const upd = await sql<{ id: string }>`
      update ubicacion
         set carpeta_id = ${carpetaDestinoId}::uuid,
             movida_en  = now(),
             movida_por = ${identidadId}::uuid
       where id = ${fila.ubicacion_id}::uuid
      returning id
    `.execute(trx);

    if (!upd.rows.length) {
      throw new HttpError(
        403,
        'No tenés permiso para mover en la carpeta de origen o en la de destino.',
      );
    }

    await registrar(trx, cuentaId, identidadId, {
      accion: 'documento.movido',
      recursoTipo: 'ubicacion',
      recursoId: fila.ubicacion_id,
      antes: { carpeta_id: fila.carpeta_id },
      despues: { carpeta_id: carpetaDestinoId, titulo: fila.titulo },
    });

    return { ok: true, sin_cambios: false, titulo: fila.titulo };
  });
}

export async function verificarFirmas(cuentaId: string, identidadId: string, instanciaId: string) {
  const datos = await withUsuario(cuentaId, identidadId, async (trx) => {
    const r = await sql<{ clave: string; firmado: boolean; titulo: string; origen: string }>`
      select a.clave_almacenamiento as clave, c.titulo,
             (i.archivo_firmado_id is not null) as firmado,
             -- CUÁL de los tres archivos se está abriendo. Sin esto, un PDF sin
             -- firmas produce el mismo mensaje esté el circuito completo o no, y
             -- son dos situaciones distintas: una es "todavía no se firmó" y la
             -- otra es "se firmó pero lo que guardamos es el original sin sellar".
             case when i.archivo_firmado_id is not null then 'firmado'
                  when i.archivo_vigente_id is not null then 'vigente'
                  else 'base' end as origen
        from instancia i
        join circuito c on c.id = i.circuito_id
        join archivo a on a.id = coalesce(i.archivo_firmado_id, i.archivo_vigente_id, c.archivo_base_id)
       where i.id = ${instanciaId}::uuid
    `.execute(trx);
    const f = r.rows[0];
    if (!f) throw new HttpError(404, 'Ese documento no existe o no lo podés ver.');
    return f;
  });

  const contenido = await almacen().leer(datos.clave);

  // El veredicto lo arma `verificar()` mirando el archivo entero, no este
  // servicio firma por firma: si una firma cubre hasta el final o hasta la
  // firma siguiente sólo se puede decidir conociendo a todas las demás.
  return {
    titulo: datos.titulo,
    cerrado: datos.firmado,
    origen: datos.origen,
    tamano: contenido.length,
    ...verificar(contenido),
  };
}
