import { sql } from 'kysely';
import { db, operadorDb, sinCuenta } from '../db/pool';
import { cifrar, descifrar, enmascarar } from '../operador/cripto';
import { pedirSello, desvio, type ConfigTsa, type SelloObtenido } from '../firma/tsa';
import { HttpError } from '../http/errors';

/**
 * Autoridades de sellado de tiempo: catálogo, salud y obtención del sello.
 *
 * ═══ POR QUÉ VARIAS Y NO UNA ═══
 *
 * El sello de una firma se obtiene en el momento o no se obtiene nunca (ver
 * migración 028). Probar una segunda autoridad cuesta menos de un segundo y
 * evita perder para siempre la prueba de cuándo se firmó por una caída ajena.
 * Medido el 1/8/2026: digicert responde en 628 ms, globalsign en 5,9 s. El
 * orden importa y por eso es un campo.
 *
 * ═══ LA DEGRADACIÓN ES DELIBERADA Y SE ANOTA ═══
 *
 * Si ninguna responde, `obtenerSello` devuelve null en vez de tirar. Quien
 * llama decide qué hacer, y en el caso de la firma la decisión ya está tomada:
 * se firma igual, se marca la instancia como `sin_sello` y el expediente
 * registra el fallo con el error textual de cada autoridad. Rechazar la firma
 * sería regalarle a un tercero la capacidad de parar el producto; degradar en
 * silencio sería vender una firma más débil de lo que decimos. Lo que queda es
 * degradar y decirlo.
 *
 * La única excepción vive en `pais_firma`, no acá: donde la ley exija sello, se
 * rechaza. Esa regla es dato verificado por un abogado local.
 */

interface FilaTsa {
  id: string;
  nombre: string;
  url: string;
  politica_oid: string | null;
  usuario: string | null;
  password_cifrado: string | null;
  pais: string | null;
  timeout_ms: number;
  orden: number;
  activa: boolean;
  ultima_ok: Date | null;
  ultimo_error: string | null;
  ultimo_error_en: Date | null;
}

/**
 * Las autoridades a probar, en orden.
 *
 * Primero las del país del documento, después las genéricas: una TSA acreditada
 * localmente vale más que una global, y si la local no responde igual queremos
 * un sello antes que ninguno.
 */
async function autoridades(pais: string | null): Promise<ConfigTsa[]> {
  // ⚠ Va por `sinCuenta`, que fija actor 'sistema'. NO es un detalle.
  //
  // `tsa_select` sólo admite 'operador' y 'sistema', y sin contexto RLS
  // `app.actor()` devuelve 'anonimo': la consulta no falla, devuelve CERO FILAS.
  // Resultado: ninguna autoridad que probar, ningún sello, y el documento sale
  // sin sello sin que nada haya dado error. Es el modo de falla de este sistema
  // —la ausencia silenciosa— y acá el precio es perder para siempre la prueba
  // de cuándo se firmó. Ver lecciones-1-agosto.
  const r = await sinCuenta((trx) => sql<FilaTsa>`
    select * from tsa
     where activa
       and (pais is null or pais = ${pais})
     order by (pais is null), orden, nombre
  `.execute(trx));

  return r.rows.map((t) => ({
    id: t.id,
    nombre: t.nombre,
    url: t.url,
    politicaOid: t.politica_oid,
    usuario: t.usuario,
    password: t.password_cifrado ? descifrar(t.password_cifrado) : null,
    timeoutMs: t.timeout_ms,
  }));
}

export interface ResultadoSello {
  sello: SelloObtenido | null;
  /** Qué pasó con cada autoridad probada. Va al expediente cuando falla todo:
   *  sin esto, tres años después la ausencia de sello no tiene explicación. */
  intentos: { tsa: string; ok: boolean; error?: string; ms: number }[];
  /** Desvío entre la hora de la autoridad y la nuestra, en segundos. */
  desvioSegundos: number | null;
}

/**
 * Consigue un sello sobre `datos`, probando las autoridades en orden.
 *
 * Nunca tira por una caída: devuelve `sello: null` y el detalle de los
 * intentos. Que la operación siga o no es decisión de quien llama.
 */
export async function obtenerSello(datos: Buffer, pais: string | null): Promise<ResultadoSello> {
  const lista = await autoridades(pais);
  const intentos: ResultadoSello['intentos'] = [];

  // Dos situaciones distintas, dos mensajes distintos: que no haya ninguna
  // autoridad cargada es un problema de configuración que alguien tiene que
  // arreglar, y que todas fallen es una caída. Si comparten mensaje, el
  // expediente no distingue "nos olvidamos" de "se cayó internet".
  if (!lista.length) {
    return {
      sello: null,
      desvioSegundos: null,
      intentos: [{ tsa: '(ninguna)', ok: false, ms: 0,
                   error: 'no hay ninguna autoridad de sellado activa configurada' }],
    };
  }

  for (const tsa of lista) {
    const t0 = Date.now();
    try {
      const sello = await pedirSello(datos, tsa);
      intentos.push({ tsa: tsa.nombre, ok: true, ms: Date.now() - t0 });
      // La salud se anota fuera del camino de error: que falle el UPDATE no
      // puede hacer perder un sello que ya conseguimos.
      anotarSalud(tsa.id, null).catch(() => {});
      return { sello, intentos, desvioSegundos: desvio(sello) };
    } catch (e) {
      const error = e instanceof Error ? e.message : 'error desconocido';
      intentos.push({ tsa: tsa.nombre, ok: false, error, ms: Date.now() - t0 });
      anotarSalud(tsa.id, error).catch(() => {});
    }
  }
  return { sello: null, intentos, desvioSegundos: null };
}

/** Deja en la fila si la última llamada anduvo. Es lo que hace que la consola
 *  pueda responder "¿está andando el sellado?" mirando, no averiguando. */
async function anotarSalud(tsaId: string, error: string | null) {
  await sinCuenta((trx) => sql`
    update tsa set
      ultima_ok       = case when ${error}::text is null then now() else ultima_ok end,
      ultimo_error    = ${error},
      ultimo_error_en = case when ${error}::text is null then ultimo_error_en else now() end,
      actualizada_en  = now()
     where id = ${tsaId}::uuid
  `.execute(trx));
}

/**
 * ¿La ley del país exige sello para este nivel de firma?
 *
 * Se resuelve en la base, contra `pais_firma`, que lleva vigencia y procedencia.
 * Si no hay fila, es false — y esa ausencia es visible en la consola del
 * operador, que muestra en rojo los países sin verificar.
 */
export async function selloObligatorio(pais: string | null, nivelFirma: string): Promise<boolean> {
  if (!pais) return false;
  const r = await sql<{ obligatorio: boolean }>`
    select app.sello_obligatorio(${pais}::char(2), ${nivelFirma}) as obligatorio
  `.execute(db);
  return !!r.rows[0]?.obligatorio;
}

// ============================================================================
// Consola del operador
// ============================================================================

export interface DatosTsa {
  nombre: string;
  url: string;
  politicaOid?: string | null;
  usuario?: string | null;
  password?: string;          // vacío = no se toca
  pais?: string | null;
  timeoutMs?: number;
  orden?: number;
  activa?: boolean;
}

export async function listarTsa() {
  const r = await operadorDb()
    .selectFrom('tsa' as any)
    .selectAll()
    .orderBy('orden')
    .orderBy('nombre')
    .execute();

  return {
    tsas: (r as any[]).map((t) => ({
      id: t.id,
      nombre: t.nombre,
      url: t.url,
      politica_oid: t.politica_oid,
      usuario: t.usuario,
      // La contraseña no vuelve NUNCA a la pantalla: sólo su máscara y si existe.
      // Ver lecciones-1-agosto §4, que costó las claves de un proveedor.
      password_mask: enmascarar(t.password_cifrado),
      tiene_password: !!t.password_cifrado,
      pais: t.pais,
      timeout_ms: t.timeout_ms,
      orden: t.orden,
      activa: t.activa,
      ultima_ok: t.ultima_ok,
      ultimo_error: t.ultimo_error,
      ultimo_error_en: t.ultimo_error_en,
    })),
  };
}

export async function guardarTsa(id: string | null, d: DatosTsa) {
  const nombre = (d.nombre || '').trim();
  const url = (d.url || '').trim();
  if (!nombre) throw new HttpError(400, 'Poné un nombre para identificar la autoridad.');
  if (!/^https?:\/\//i.test(url)) throw new HttpError(400, 'La URL tiene que empezar con http:// o https://');
  if (d.pais && !/^[A-Z]{2}$/.test(d.pais)) throw new HttpError(400, 'El país va en dos letras (UY, PY, BR).');

  const cifrada = d.password ? cifrar(d.password) : null;

  if (id) {
    await sql`
      update tsa set
        nombre = ${nombre}, url = ${url},
        politica_oid = ${d.politicaOid || null},
        usuario = ${d.usuario || null},
        -- ⚠ La contraseña sólo se pisa si vino una nueva. Un formulario que la
        -- manda vacía "por las dudas" borra la credencial sin que nadie lo pida.
        password_cifrado = coalesce(${cifrada}::text, password_cifrado),
        pais = ${d.pais || null},
        timeout_ms = ${d.timeoutMs ?? 8000},
        orden = ${d.orden ?? 100},
        activa = ${d.activa ?? true},
        actualizada_en = now()
       where id = ${id}::uuid
    `.execute(operadorDb());
    return { ok: true, id };
  }

  const r = await sql<{ id: string }>`
    insert into tsa (nombre, url, politica_oid, usuario, password_cifrado, pais, timeout_ms, orden, activa)
    values (${nombre}, ${url}, ${d.politicaOid || null}, ${d.usuario || null}, ${cifrada},
            ${d.pais || null}, ${d.timeoutMs ?? 8000}, ${d.orden ?? 100}, ${d.activa ?? true})
    returning id
  `.execute(operadorDb());
  return { ok: true, id: r.rows[0]!.id };
}

/**
 * Prueba una autoridad guardada, sellando un dato de juguete.
 *
 * Es la misma ruta de código que usa la firma: si esto anda, sella. Un botón de
 * prueba que ejercita otro camino no prueba nada.
 */
export async function probarTsa(id: string) {
  const r = await sql<FilaTsa>`select * from tsa where id = ${id}::uuid`.execute(operadorDb());
  const t = r.rows[0];
  if (!t) throw new HttpError(404, 'Esa autoridad no existe.');

  const cfg: ConfigTsa = {
    id: t.id,
    nombre: t.nombre,
    url: t.url,
    politicaOid: t.politica_oid,
    usuario: t.usuario,
    password: t.password_cifrado ? descifrar(t.password_cifrado) : null,
    timeoutMs: t.timeout_ms,
  };

  const t0 = Date.now();
  try {
    const sello = await pedirSello(Buffer.from('MiFirma · prueba de sellado'), cfg);
    await anotarSalud(t.id, null);
    return {
      ok: true,
      ms: Date.now() - t0,
      sellado_en: sello.selladoEn.toISOString(),
      desvio_segundos: desvio(sello),
      politica: sello.politica,
      serie: sello.serie,
      token_bytes: sello.token.length,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : 'error desconocido';
    await anotarSalud(t.id, error);
    throw new HttpError(502, error);
  }
}

/** Los países cuya regla de sello todavía no verificó un abogado. La consola
 *  los muestra en rojo: una suposición operando como si fuera un hecho es
 *  exactamente lo que no queremos que pase desapercibido. */
export async function paisesSinVerificar() {
  const r = await sql<{ pais: string; nivel_firma: string; fuente: string }>`
    select pais, nivel_firma, fuente
      from pais_firma
     where verificado_en is null
       and (vigente_hasta is null or vigente_hasta > current_date)
     order by pais, nivel_firma
  `.execute(operadorDb());
  return { pendientes: r.rows };
}
