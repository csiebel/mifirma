import { createHash, randomUUID } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { sql } from 'kysely';
import { withExterno, db } from '../db/pool';
import { fijarContexto } from '../db/contexto';
import { verificarEnlaceFirma } from '../auth/enlace_firma';
import { almacen, nuevaClave } from '../almacenamiento/almacen';
import { normalizar, sellar, verificar } from '../firma/pades';
import type { Marca } from '../firma/apariencia';
import { selloDePlataforma } from '../firma/adaptadores/sello_plataforma';
import { anotar } from './evidencia';
import { obtenerSello, selloObligatorio, type ResultadoSello } from './tsa';
import { avisarAlQueSigue, avisarCompletado, ubicarEnBandeja, consolidarOtorgamiento } from './circuito';
import { emitirCertificado } from './certificado';
import { prepararCampos, congelarCampos, widgetsAPredeclarar } from './campos';
import { marcasAPredeclarar, nombreDeMarca } from './marcas';
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
        join instancia i on i.id = p.instancia_id
        -- El PDF tal como está AHORA, no el original: quien firma segundo tiene
        -- que ver lo que firmó el primero. Es el MISMO archivo sobre el que va a
        -- firmar —firmar() hace este mismo coalesce—, así que lo que mira y lo
        -- que sella son el mismo documento. Mostrarle el base sería enseñarle
        -- una versión que ya no existe.
        join archivo a on a.id = coalesce(i.archivo_vigente_id, c.archivo_base_id)
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


/**
 * Las marcas autógrafas de este firmante, listas para estamparse.
 *
 * ⚠ REGLA DE ORO Nº1. Esto NO decide nada sobre la firma: si devuelve la lista
 * vacía, se firma igual y el documento vale lo mismo. Lo único que cambia es si
 * el PDF muestra un trazo o no.
 *
 * ═══ POR QUÉ SE LEE COMO 'sistema' ═══
 *
 * La imagen de la firma autógrafa la ve su dueño y nadie más — ni el admin de su
 * empresa, ni el emisor del documento, ni el operador de la plataforma. La
 * política `firma_visual_select` tiene exactamente dos ramas: el dueño con su
 * identidad probada, o el actor `sistema`. Ésta es la rama `sistema`, y es la
 * única vez que se ejerce: al estampar.
 *
 * El derecho a firmar YA lo resolvió la RLS en el paso 1, con el contexto del
 * otorgamiento. Acá no se decide nada: se busca una imagen de alguien de quien
 * ya sabemos que está firmando.
 *
 * ⚠ TODO O NADA. Si falta la imagen de un tipo, se descartan las marcas de ese
 * tipo; si algo impide dibujarlas, no se dibuja ninguna. Estampar la mitad
 * —rúbricas sí, firma no— produce un documento que parece a medio hacer y sobre
 * el que después hay que explicar qué pasó.
 */
async function marcasDelFirmante(
  instanciaId: string,
  participacionId: string,
  identidadId: string,
  /** El LUGAR de esta persona. Es lo que nombra el widget de cada marca. */
  posicion: number,
): Promise<{ marcas: Marca[]; imagenes: { tipo: string; sha256: string; id: string }[]; motivo: string | null }> {
  const datos = await enSistema(async (trx) => {
    const m = await sql<{ tipo: string; pagina: number; x: string; y: string; ancho: string; alto: string }>`
      select tipo, pagina, x::text, y::text, ancho::text, alto::text
        from marca_firma
       where participacion_id = ${participacionId}::uuid and instancia_id = ${instanciaId}::uuid
       order by pagina, tipo
    `.execute(trx);

    const img = await sql<{ id: string; tipo: string; clave: string; mime: string; sha256: Buffer }>`
      select id, tipo, clave_almacenamiento as clave, mime, sha256
        from firma_visual
       where identidad_id = ${identidadId}::uuid and vigente
    `.execute(trx);

    return { marcas: m.rows, imagenes: img.rows };
  });

  if (!datos.marcas.length) return { marcas: [], imagenes: [], motivo: null };

  const porTipo = new Map(datos.imagenes.map((i) => [i.tipo, i]));
  const tiposPedidos = [...new Set(datos.marcas.map((m) => m.tipo))];
  const faltan = tiposPedidos.filter((t) => !porTipo.has(t));
  if (faltan.length) {
    // No es un error: es la decisión de diseño «si no cargó imagen, no se
    // estampa nada». Pero queda dicho, porque la ausencia tiene que ser un
    // hecho registrado y no un vacío que parezca un olvido nuestro.
    return {
      marcas: [], imagenes: [],
      motivo: `el firmante no tiene cargada su ${faltan.join(' ni su ')}`,
    };
  }

  const noPng = tiposPedidos.filter((t) => porTipo.get(t)!.mime !== 'image/png');
  if (noPng.length) {
    return {
      marcas: [], imagenes: [],
      motivo: `la imagen de ${noPng.join(' y ')} está en ${porTipo.get(noPng[0]!)!.mime} ` +
              'y sólo se estampa PNG con fondo transparente',
    };
  }

  const bytes = new Map<string, Buffer>();
  for (const t of tiposPedidos) bytes.set(t, await almacen().leer(porTipo.get(t)!.clave));

  // La principal —la que ES el campo de firma— es la firma completa de la
  // última hoja donde aparezca. Es la que el lector resalta al hacer clic en el
  // panel de firmas, y tiene que ser la firma y no una inicial.
  let iPrincipal = 0;
  datos.marcas.forEach((m, i) => {
    const mejor = datos.marcas[iPrincipal]!;
    const gana = m.tipo === 'firma' && (mejor.tipo !== 'firma' || m.pagina >= mejor.pagina);
    if (gana) iPrincipal = i;
  });

  const marcas: Marca[] = datos.marcas.map((m, i) => {
    const x = Number(m.x), y = Number(m.y);
    return {
      pagina: m.pagina,
      rect: [x, y, x + Number(m.ancho), y + Number(m.alto)] as [number, number, number, number],
      imagen: bytes.get(m.tipo)!,
      principal: i === iPrincipal,
      // ⚠ El nombre del lugar que esta marca viene a COMPLETAR. Tiene que salir
      // de la misma función que lo reservó antes de la primera firma, o la
      // firma no lo encuentra y lo agrega — y agregar un campo de formulario
      // después de una firma es lo que rompe todas las anteriores.
      //
      // La principal no lo usa: ésa es el campo de firma (`/FT /Sig`) y
      // agregarla está permitido. Se le pone igual porque cuál es la principal
      // depende de dónde puso cada uno sus marcas, y no vale la pena que este
      // nombre exista a veces sí y a veces no.
      etiqueta: nombreDeMarca({ posicion, tipo: m.tipo as 'firma' | 'rubrica', pagina: m.pagina }),
    };
  });

  return {
    marcas,
    imagenes: tiposPedidos.map((t) => ({
      tipo: t, id: porTipo.get(t)!.id,
      sha256: Buffer.from(porTipo.get(t)!.sha256).toString('hex'),
    })),
    motivo: null,
  };
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
      posicion: number | null;
      identidad_id: string; caracter: string | null; cuenta_representada_id: string | null;
      sha256: Buffer; titulo: string; nivel_firma: string; me_toca: boolean;
      anclaje_email: string | null; clave: string; mime: string;
      archivo_vigente_id: string | null; firmante: string | null; emisor: string | null;
      pais: string | null; paginas: number | null;
    }>`
      select p.id as participacion_id, p.instancia_id, p.circuito_id,
             p.cuenta_propietaria_id, p.estado, p.papel, p.orden, p.identidad_id,
             -- ⚠ El TURNO decide si le toca firmar; el LUGAR decide qué
             -- campos son suyos. En paralelo todos comparten el turno, así
             -- que uno solo no alcanza. Ver migración 055.
             p.posicion,
             p.caracter, p.cuenta_representada_id,
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
             -- Cuántas hojas tiene. Hace falta para reservar un lugar de marca
             -- por hoja y por firmante antes de la primera firma; puede venir
             -- en null en archivos viejos y ahí se cuentan a mano.
             a.paginas,
             i2.archivo_vigente_id,
             ident.nombre_mostrado as firmante, cu.nombre_mostrado as emisor,
             -- El país de la cuenta EMISORA, que es la que asume el documento.
             -- Es lo que decide si la ley local exige sello de tiempo.
             cu.pais
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

  // Dónde va la firma autógrafa de esta persona. Si no cargó imagen, la lista
  // vuelve vacía y se firma sin estampar nada — que es la decisión tomada, no
  // una degradación.
  const visual = await marcasDelFirmante(
    ctx.instancia_id, ctx.participacion_id, ctx.identidad_id, ctx.posicion ?? 1);

  // Los campos que le tocan a esta persona: se validan los obligatorios y se
  // arma lo que hay que dibujar. **No escribe nada todavía** — el congelado va
  // en la transacción del PASO 3, junto con la firma.
  //
  // ⚠ Si se congelara acá y después fallara el sellado, esta persona quedaría
  // con sus valores inmutables y sin firma: no podría corregir un error de
  // tipeo ni reintentar. Es el mismo motivo por el que la evidencia tampoco se
  // anota antes de sellar.
  //
  // ⚠ En la MISMA vuelta se pide, si es la primera firma, la lista de widgets a
  // pre-declarar. Van juntos a propósito: es el mismo contexto de otorgamiento y
  // la misma foto del documento. Pedirlos por separado abriría la puerta a que
  // entre una cosa y la otra cambiara la definición de los campos, y entonces se
  // pre-declararía un juego y se completaría otro.
  // Cuántas hojas tiene, para reservar un lugar de marca por hoja. Se prefiere
  // lo que dice la base y se cuenta a mano sólo si falta: abrir el PDF para
  // saber algo que ya está escrito es trabajo de más en cada primera firma.
  const hojas = async () => {
    if (ctx.paginas != null) return ctx.paginas;
    try {
      return (await PDFDocument.load(original, { ignoreEncryption: true })).getPageCount() || 1;
    } catch {
      // No se puede reservar lo que no se sabe contar, pero tampoco se va a
      // impedir la firma por eso: se reservan los campos y las marcas siguen
      // agregándose, que es como funcionaba antes.
      console.warn('[predeclarar] no se pudo contar las hojas: no se reservan lugares de marca');
      return 0;
    }
  };

  const preparado = await withExterno(e.otorgamientoId, e.identidadId, async (trx) => ({
    campos: await prepararCampos(trx, ctx.instancia_id, ctx.posicion ?? 1),
    // Sólo la primera vez. Si ya hay una firma, el documento ya quedó declarado
    // —o quedó sin declarar, si se despachó antes de que esto existiera— y no
    // hay nada que se pueda cambiar sin romper esa firma.
    //
    // ⚠ Los campos y las marcas van JUNTOS y en la misma vuelta. Si faltara
    // cualquiera de las dos familias, esa mitad volvería a agregarse al firmar
    // y el documento se abriría en rojo igual: el arreglo no admite mitades.
    widgets: ctx.archivo_vigente_id ? [] : [
      ...await widgetsAPredeclarar(trx, ctx.instancia_id),
      ...await marcasAPredeclarar(trx, ctx.instancia_id, await hojas(), ctx.posicion ?? null),
    ],
  }));
  const campos = preparado.campos;

  // La normalización sólo hace falta la primera vez: deja el PDF con tabla xref
  // clásica, que es lo que el placeholder sabe leer. Si ya hay una firma, el
  // archivo NO se vuelve a serializar — hacerlo rompería esa firma.
  //
  // ⚠ Y es el único momento en que se pueden declarar los widgets. Lo que no se
  // deje creado acá, cada firma lo va a AGREGAR, y agregar un campo de
  // formulario después de una firma es lo que hace que Acrobat diga «el
  // documento se ha modificado o dañado desde que fue firmado» en todas las
  // firmas menos la última. Medido: `claude/cambios-posteriores-a-la-firma.md`.
  // ⚠ Si el documento BASE ya traía firmas electrónicas, no se puede seguir:
  // `normalizar()` reescribe el archivo y las invalidaría. La comprobación
  // final lo rechazaría igual — pero tres pasos más tarde, con el sello de
  // tiempo ya gastado y un mensaje que no explica. La subida ya no deja entrar
  // estos documentos; esta guarda cubre los circuitos armados antes de esa red.
  // Sólo en la PRIMERA firma: después, las firmas del archivo son las nuestras.
  if (!ctx.archivo_vigente_id) {
    let previas = 0;
    try { previas = verificar(original).firmas.length; } catch { /* no firmado */ }
    if (previas > 0) {
      throw new HttpError(409,
        'Este documento ya traía ' + (previas === 1 ? 'una firma electrónica' : previas + ' firmas electrónicas') +
        ' antes de entrar a MiFirma, y firmarlo acá las invalidaría. ' +
        'El emisor tiene que subir el documento original, sin firmar, y armar el envío de nuevo.');
    }
  }

  const base = ctx.archivo_vigente_id ? original : await normalizar(original, preparado.widgets);

  // ── El sello de tiempo. Lo único de todo esto que no admite segunda vuelta.
  //
  // El hash encadenado de la evidencia prueba consistencia interna, no
  // anterioridad: quien tenga escritura sobre la base puede rehacerla entera.
  // Un tercero afirmando la hora es lo que convierte el expediente en prueba.
  //
  // Se pide DENTRO del firmado, porque el sello es sobre el valor de la firma y
  // tiene que quedar adentro del PKCS#7 antes de escribirlo en el PDF.
  let resultadoSello: ResultadoSello | null = null;

  let salida;
  try {
    salida = await sellar(
      base,
      {
        // El motivo dice a nombre de quién se selló. Es lo que ve cualquiera en
        // el panel de firmas de un lector de PDF, sin abrir el expediente.
        razon: `Firmado electrónicamente por ${nombreFirmante} · ${ctx.titulo}`,
        nombre: nombreFirmante,
        lugar: ctx.emisor ?? '',
        contacto: process.env.SOPORTE_EMAIL ?? '',
        // ⚠ Va adentro del MISMO incremental update que la firma: la marca no
        // es un cambio posterior al documento, es parte de firmarlo.
        // ⚠ Las marcas autógrafas y los valores de los campos van JUNTOS, en el
        // mismo incremental update. Son la misma operación: lo que esta persona
        // aporta al documento en el acto de firmarlo.
        marcas: visual.marcas.length || campos.marcas.length
          ? [...visual.marcas, ...campos.marcas]
          : undefined,
      },
      selloDePlataforma(),
      async (datos) => {
        resultadoSello = await obtenerSello(datos, ctx.pais ?? null);
        return resultadoSello.sello;
      },
    );
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, 'No se pudo aplicar la firma al documento. Probá de nuevo en un momento.');
  }
  const firmado: Buffer = salida.pdf;
  // ⚠ El cast es necesario y no es pereza: TypeScript no ve que `resultadoSello`
  // se asigna dentro del callback que le pasamos a `sellar`, así que lo estrecha
  // a `null` y después a `never`. El valor sí llega; el análisis de flujo no
  // atraviesa la clausura.
  const rs = resultadoSello as ResultadoSello | null;

  // ⚠ La única puerta que puede detener una firma por falta de sello, y no la
  // decide este archivo: la decide `pais_firma`, que es derecho verificado por
  // un abogado local y versionado por fecha de vigencia. Donde la ley exija
  // sello para el nivel que estamos vendiendo, no se firma sin él — vender una
  // firma más débil de lo que se dice es peor que no firmar.
  if (!salida.sello && (await selloObligatorio(ctx.pais ?? null, ctx.nivel_firma ?? 'simple'))) {
    throw new HttpError(
      503,
      'No se pudo obtener el sello de tiempo, y en este país la firma lo exige. ' +
        'Probá de nuevo en unos minutos.',
    );
  }

  // Verificar lo que acabamos de producir, antes de guardarlo. Entregar un
  // documento cuya firma no cierra es peor que no firmarlo.
  const comprobacion = verificar(firmado);
  const firmas = comprobacion.firmas;
  // `integro` y no "todas verifican": exige además que no queden bytes al final
  // que ninguna firma cubra. Sobre un archivo que acabamos de producir nosotros
  // mismos, cualquier byte suelto es un error nuestro.
  if (!firmas.length || !comprobacion.integro) {
    // ⚠ Tres causas distintas merecen tres textos. Con un solo cartel para las
    // tres, el 9/8 se gastó una noche adivinando cuál era. La desagregación es
    // para el expediente del soporte; la primera frase, para la persona.
    const rotas = firmas.filter((f) => !f.verifica).length;
    const detalle = !firmas.length
      ? 'el verificador no encontró ninguna firma en el archivo producido'
      : rotas > 0
        ? rotas + ' de ' + firmas.length + ' firmas no verifican — si el documento traía firmas de antes, el procesamiento las invalidó'
        : 'quedaron ' + comprobacion.bytes_sin_firmar + ' bytes fuera de toda firma';
    throw new HttpError(500, 'La firma generada no verifica (' + detalle + '). No se guardó nada.');
  }

  const sha256Firmado = createHash('sha256').update(firmado).digest();
  const claveNueva = nuevaClave();
  await almacen().guardar(claveNueva, firmado);

  // ── PASO 3: registrar. Todo junto, en una transacción.
  let cerroElCircuito = false;
  const resultado = await enSistema(async (trx) => {
    const archivoId = randomUUID();
    await sql`
      insert into archivo (id, sha256, bytes, mime, clase, cuenta_custodia_id,
                           region, clave_almacenamiento)
      values (${archivoId}::uuid, ${sha256Firmado}, ${firmado.length}, ${ctx.mime},
              'firmado', ${ctx.cuenta_propietaria_id}::uuid, ${almacen().region}, ${claveNueva})
    `.execute(trx);

    // ⚠ El congelado va ACÁ y no antes: en la misma transacción que guarda la
    // firma. Si algo de esto falla, no queda ni la firma ni los valores fijados.
    // Y comprueba que el valor sea EXACTAMENTE el que se dibujó — si cambió
    // mientras firmábamos, se levanta y no se guarda nada.
    await congelarCampos(
      trx, ctx.instancia_id, ctx.circuito_id, ctx.cuenta_propietaria_id,
      e.identidadId, ctx.participacion_id, campos.congelar,
    );

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

    // ── La representación visual. SIEMPRE se anota, incluso cuando no hubo.
    //
    // ⚠ Que un documento salga sin el trazo de nadie es correcto y esperable
    // —la firma vale igual—, pero tiene que quedar dicho. Sin esta anotación,
    // dentro de tres años la ausencia de la marca parece un olvido nuestro o,
    // peor, una manipulación. El expediente es inmutable: ésta es la única
    // oportunidad de explicarla.
    //
    // ⚠ Y se anota la HUELLA de cada imagen, no la imagen. El expediente lo
    // pueden leer el emisor y los demás firmantes; una firma autógrafa es de lo
    // más copiable que hay. La huella responde «¿qué trazo se estampó acá?» sin
    // repartir el trazo.
    await anotar(trx, {
      ...comun,
      tipo: 'firma.representacion_visual',
      datos: salida.marcasEstampadas
        ? {
            estampada: true,
            marcas: salida.marcasEstampadas,
            paginas: [...new Set(visual.marcas.map((m) => m.pagina + 1))],
            imagenes: visual.imagenes,
            // Lo que la persona escribió, si escribió algo. Tampoco es la firma.
            nombre_escrito: input.nombreEscrito ?? null,
          }
        : {
            estampada: false,
            motivo:
              salida.errorMarca ??
              visual.motivo ??
              'el emisor no definió dónde estampar la firma en este documento',
            // Se dice explícitamente para que nadie tenga que deducirlo.
            aclaracion:
              'La firma electrónica es válida igual: la representación visual no ' +
              'aporta valor legal, lo aporta el PAdES.',
            nombre_escrito: input.nombreEscrito ?? null,
          },
      sha256Documento: sha256Firmado,
    });

    // ── El sello de tiempo, en la cadena. Salga o no salga.
    //
    // `sello.fallido` es de peso ALTO aunque sea un fallo, y va con el error
    // textual de cada autoridad probada. Es lo que explica, tres años después,
    // por qué este documento no tiene sello: sin esa explicación la ausencia
    // parece negligencia o, peor, manipulación. El expediente es inmutable, así
    // que esta es la única oportunidad de dejar dicho lo que pasó.
    if (salida.sello) {
      const selloId = randomUUID();
      await sql`
        insert into sello_tiempo
          (id, alcance, raiz, autoridad, pais, politica_oid, token, sellado_en,
           estado, instancia_id, tsa_id)
        values (${selloId}::uuid, 'firma', ${createHash('sha256').update(salida.sello.token).digest()},
                ${salida.sello.tsaNombre}, ${ctx.pais}, ${salida.sello.politica},
                ${salida.sello.token}, ${salida.sello.selladoEn}, 'sellado',
                ${ctx.instancia_id}::uuid, ${salida.sello.tsaId}::uuid)
      `.execute(trx);

      await anotar(trx, {
        ...comun,
        tipo: 'firma.sellada',
        actorTipo: 'proveedor',
        datos: {
          autoridad: salida.sello.tsaNombre,
          politica: salida.sello.politica,
          numero_serie: salida.sello.serie,
          // ⚠ La hora que afirma la AUTORIDAD, no la nuestra. `now()` sirve para
          // ordenar; esto es lo que prueba.
          sellado_en: salida.sello.selladoEn.toISOString(),
          // Nuestro desvío contra esa hora. No invalida nada, pero un desvío
          // grande dice que nuestro reloj se fue — y de eso depende el orden de
          // todo el expediente. Ver R5 de auditoria-y-evidencias.md.
          desvio_segundos: rs?.desvioSegundos ?? null,
          // Cuánto del hueco reservado ocupó la firma. Que el tamaño lo decidan
          // los documentos reales y no una estimación: si se acerca a 1, hay que
          // agrandarlo ANTES de que un documento no se pueda firmar.
          hueco_usado: salida.huecoUsado,
        },
        sha256Documento: sha256Firmado,
      });
    } else {
      await anotar(trx, {
        ...comun,
        tipo: 'sello.fallido',
        actorTipo: 'sistema',
        datos: {
          motivo: salida.errorSello ?? 'ninguna autoridad respondió',
          intentos: rs?.intentos ?? [],
          // Se dice explícitamente qué se perdió, para que no haya que deducirlo.
          consecuencia:
            'La firma es válida pero ninguna autoridad externa afirma la hora. ' +
            'Se puede agregar después un sello de DOCUMENTO, que prueba que el ' +
            'archivo ya existía, no cuándo se firmó.',
        },
        sha256Documento: sha256Firmado,
      });
    }

    await sql`
      update instancia set nivel_sello = ${salida.sello ? 'firma' : 'sin_sello'}
       where id = ${ctx.instancia_id}::uuid
         -- Sin pisar hacia abajo: si otra firma de esta instancia ya consiguió
         -- sello, que ésta falle no borra aquel hecho.
         and nivel_sello = 'sin_sello'
    `.execute(trx);

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
        cerroElCircuito = true;
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

  // ── Lo que pasa con su acceso ahora que ya firmó ────────────────────────
  //
  // El derecho a FIRMAR se agotó: lo usó. Y en su lugar nace otro, el de
  // conservar lo que firmó, que no es el mismo y no dura lo mismo.
  //
  // ⚠ No se puede «marcar irrevocable» el que ya existe: el trigger
  // `otorgamiento_solo_revocacion` de la 008 sólo deja tocar la revocación —«un
  // otorgamiento no se modifica: revocá y emití uno nuevo»—. Así que se hace
  // exactamente eso, que además es lo correcto de contar: un otorgamiento es un
  // hecho con fecha, y acá hay dos hechos distintos.
  //
  // Personal → irrevocable y perpetuo. Es su prueba de qué firmó y se la lleva
  // aunque cambie de trabajo o cierre su cuenta. Legalmente no es opcional.
  //
  // Representación → condicionado a la membresía, como el anterior. El
  // documento es de la empresa; la persona conserva el registro de haberlo
  // firmado, no el contenido. Y el CHECK de la 008 ni siquiera deja que sea
  // irrevocable teniendo condición, así que las dos ramas no se pueden
  // confundir ni por error.
  //
  // ⚠ Va DESPUÉS de la transacción de la firma, y no adentro: revocar el
  // otorgamiento que esta misma sesión está usando —`app.otorgamiento_externo()`—
  // dejaría a la RLS sin base a mitad de camino. Y si esto falla, la firma ya
  // está hecha y el acceso sigue como estaba, que es un estado seguro.
  try {
    await consolidarOtorgamiento(ctx.participacion_id);
  } catch (e) {
    console.error('[otorgamiento] no se pudo consolidar tras firmar:', e);
  }

  // ── La bandeja del que acaba de firmar ──────────────────────────────────
  //
  // Ya se hizo al despachar, y se vuelve a hacer acá. No es duplicación: en el
  // despacho, quien no tenía cuenta persona no tenía dónde poner nada, y entre
  // aquel momento y éste pudo abrirla —el alta desde la propia pantalla de
  // firma es el camino que más la crea—. El alta también rellena hacia atrás,
  // pero sólo alcanza a lo que ya existía cuando se registró.
  //
  // El caso que quedaba afuera es el del medio: abrió su cuenta con un
  // documento ya despachado y firmó después. Ahí ni el despacho ni el alta lo
  // ubican, y el documento le da acceso pero no le aparece en Recibidos.
  //
  // Es idempotente (`on conflict do nothing`) y va fuera de la transacción: si
  // falla, la firma ya está hecha y el otorgamiento ya da acceso.
  try {
    await ubicarEnBandeja([{
      identidadId: ctx.identidad_id,
      instanciaId: ctx.instancia_id,
      cuentaRepresentadaId: ctx.cuenta_representada_id,
    }]);
  } catch (e) {
    console.error('[bandeja] falló al ubicar tras firmar:', e);
  }

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

  // Firmó el último y el circuito cerró: a todos les llega el documento
  // firmado, con el PDF adjunto. Mismo criterio que arriba — fuera de la
  // transacción, y si el correo falla la firma ya está hecha y el expediente
  // registra que ese aviso no salió.
  if (cerroElCircuito) {
    // ⚠ El certificado ANTES del aviso, para que viaje adjunto en el mismo
    // correo. Es lo que un abogado va a mirar: que llegue junto con el
    // documento y no haya que entrar a buscarlo.
    //
    // Si falla, se avisa igual: perder el correo del documento firmado porque
    // no se pudo dibujar un PDF de resumen sería el peor de los canjes. El
    // certificado se puede emitir después; el momento de avisar, no.
    try {
      await emitirCertificado(ctx.instancia_id);
    } catch {
      /* se emite a pedido cuando alguien lo descargue */
    }
    try {
      await avisarCompletado(ctx.circuito_id, ctx.instancia_id);
    } catch {
      /* queda anotado en el expediente como notificacion.fallida */
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

/**
 * Con qué carácter va a firmar, y qué empresas puede nombrar.
 *
 * ⚠ La lista NO la arma la pantalla ni la elige el emisor: sale de las
 * membresías activas de esa persona. Si está vacía, no hay pregunta que hacer
 * —firma a título personal y punto— y eso es lo que le pasa a la enorme mayoría
 * de los firmantes, que no pertenecen a ninguna empresa del sistema.
 */
export async function caracterParaFirmar(token: string) {
  const e = await verificarEnlaceFirma(token);

  return withExterno(e.otorgamientoId, e.identidadId, async (trx) => {
    const p = await sql<{ caracter: string | null; cuenta_representada_id: string | null }>`
      select caracter, cuenta_representada_id from participacion
       where id = ${e.participacionId}::uuid
    `.execute(trx);
    if (!p.rows.length) throw new HttpError(403, 'Este enlace ya no está disponible.');

    const emp = await sql<{ id: string; nombre: string }>`
      select cu.id, cu.nombre_mostrado as nombre
        from cuenta cu
       where app.puede_representar(${e.identidadId}::uuid, cu.id)
       order by cu.nombre_mostrado
    `.execute(trx);

    return {
      caracter: p.rows[0]!.caracter,
      cuenta_representada_id: p.rows[0]!.cuenta_representada_id,
      empresas: emp.rows,
    };
  });
}

/** Lo declara la persona, antes de firmar. La base comprueba las dos cosas. */
export async function declararCaracter(
  token: string,
  caracter: 'personal' | 'representacion',
  cuentaRepresentadaId: string | null,
) {
  const e = await verificarEnlaceFirma(token);

  return withExterno(e.otorgamientoId, e.identidadId, async (trx) => {
    // ⚠ Se guarda POR QUÉ podía, no sólo que podía.
    //
    // `app.puede_representar` contesta si puede HOY: membresía activa más la
    // capacidad `empresa.representar`. Dentro de tres años, cuando alguien
    // discuta el contrato, la pregunta va a ser si podía ESE DÍA — y para
    // entonces el rol puede no existir, la persona puede haberse ido, y la
    // empresa puede haber reorganizado sus permisos cinco veces.
    //
    // Una tabla de permisos dice qué es cierto ahora. El expediente tiene que
    // decir qué era cierto entonces. Por eso el fundamento se congela acá, con
    // el hecho, y no se sale a buscarlo después.
    let fundamento: unknown = null;

    if (caracter === 'representacion') {
      if (!cuentaRepresentadaId) throw new HttpError(400, 'Decime a qué empresa representás.');
      const ok = await sql<{
        puede: boolean; empresa: string | null; roles: string | null; desde: Date | null;
      }>`
        select app.puede_representar(${e.identidadId}::uuid, ${cuentaRepresentadaId}::uuid) as puede,
               (select nombre_mostrado from cuenta where id = ${cuentaRepresentadaId}::uuid) as empresa,
               (select string_agg(r.codigo, ', ' order by r.codigo)
                  from usuario_rol ur
                  join rol r on r.id = ur.rol_id
                  join rol_capacidad rc on rc.rol_id = r.id
                  join capacidad ca on ca.id = rc.capacidad_id
                 where ur.identidad_id = ${e.identidadId}::uuid
                   and ur.cuenta_id = ${cuentaRepresentadaId}::uuid
                   and ca.recurso = 'empresa' and ca.accion = 'representar') as roles,
               (select min(m.desde) from membresia m
                 where m.identidad_id = ${e.identidadId}::uuid
                   and m.cuenta_id = ${cuentaRepresentadaId}::uuid
                   and m.estado = 'activa') as desde
      `.execute(trx);
      const f = ok.rows[0];
      if (!f?.puede) {
        throw new HttpError(
          403,
          'No estás habilitado para firmar en nombre de esa empresa. Ser miembro no alcanza: ' +
            'el administrador tiene que darte el permiso de representarla.',
        );
      }
      fundamento = {
        empresa: f.empresa,
        roles_con_el_permiso: f.roles,
        miembro_desde: f.desde,
      };
    }

    const r = await sql<{ id: string }>`
      update participacion
         set caracter = ${caracter},
             cuenta_representada_id = ${caracter === 'representacion' ? cuentaRepresentadaId : null}
       where id = ${e.participacionId}::uuid
      returning id
    `.execute(trx);
    if (!r.rows.length) {
      throw new HttpError(409, 'Ya firmaste este documento: el carácter no se cambia después.');
    }

    await anotar(trx, {
      instanciaId: (await sql<{ i: string }>`
        select instancia_id as i from participacion where id = ${e.participacionId}::uuid
      `.execute(trx)).rows[0]!.i,
      circuitoId: (await sql<{ c: string }>`
        select circuito_id as c from participacion where id = ${e.participacionId}::uuid
      `.execute(trx)).rows[0]!.c,
      cuentaPropietariaId: (await sql<{ c: string }>`
        select cuenta_propietaria_id as c from participacion where id = ${e.participacionId}::uuid
      `.execute(trx)).rows[0]!.c,
      participacionId: e.participacionId,
      identidadId: e.identidadId,
      actorTipo: 'firmante',
      tipo: 'firma.caracter_declarado',
      datos: { caracter, cuenta_representada_id: cuentaRepresentadaId, fundamento },
      canal: 'web',
    });

    return { ok: true, caracter };
  });
}
