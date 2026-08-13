import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { sql } from 'kysely';
import { db, withExterno } from '../db/pool';
import { fijarContexto } from '../db/contexto';
import { withUsuario, exigir } from '../auth/authz';
import { verificarEnlaceFirma } from '../auth/enlace_firma';
import { fueraDeWinAnsi, type Marca, type WidgetPredeclarado } from '../firma/apariencia';
import { almacen } from '../almacenamiento/almacen';
import { anotar } from './evidencia';
import { HttpError } from '../http/errors';

/**
 * Campos rellenables sobre el PDF.
 *
 * ═══ EL ORDEN, QUE ES TODO ═══
 *
 * Un PDF con campos de formulario **sigue siendo editable después de firmado**.
 * Si se firma sin resolver los campos, lo que se ve puede cambiar mientras la
 * firma sigue diciendo «válida»: un documento que se ve distinto y verifica
 * bien, que es el peor resultado que puede dar este producto.
 *
 * Por eso: se lee el valor → se valida → se dibuja dentro del MISMO incremental
 * update que la firma → y **en la misma transacción que registra la firma** se
 * congela. Nunca al revés.
 *
 * ⚠ El congelado NO va antes de firmar, y es deliberado. Si se congelara primero
 * y después fallara el sellado, esa persona quedaría con sus valores inmutables
 * y sin firma: no podría corregir un error de tipeo ni reintentar. Es el mismo
 * razonamiento que ya está escrito en `firma.ts` sobre por qué no se anota la
 * evidencia antes de sellar.
 *
 * ═══ CÓMO ENTRA EL VALOR AL PDF ═══
 *
 * Como **campo de formulario de sólo lectura**, en el incremento de la firma de
 * quien lo completó. Decidido y medido en `claude/campos-sobre-el-pdf.md`:
 * estamparlo en el contenido de la hoja sería, byte por byte, indistinguible de
 * una adulteración, y el analizador de cambios gritaría sobre un documento
 * legítimo. Una alarma que salta cuando todo está bien deja de mirarse.
 */

export interface CampoParaMostrar {
  id: string;
  codigo: string;
  etiqueta: string;
  tipo: string;
  opciones: unknown;
  obligatorio: boolean;
  validacion: unknown;
  pagina: number;
  x: number; y: number; ancho: number; alto: number;
  orden: number;
  /** El LUGAR del firmante a quien se le pide (participacion.posicion). Null = no es de un firmante nombrado. */
  posicion_firmante: number | null;
  /** Cuerpo de la letra en puntos. Null = se ajusta al recuadro. Ver migración 056. */
  cuerpo: number | null;
  /** Color del valor, «#rrggbb». Null = la tinta de siempre. */
  color: string | null;
  valor: string | null;
  congelado: boolean;
  /** Si el que mira es quien tiene que completarlo. */
  mio: boolean;
}

/**
 * «#rrggbb» → [r, g, b] de 0 a 1, que es como lo quiere el PDF.
 *
 * ⚠ Un solo lugar que convierte. La base guarda hexa porque es lo que entiende
 * el selector del navegador y lo que una persona puede leer; el PDF quiere
 * decimales. Con la conversión repetida en dos archivos, un día dicen cosas
 * distintas — es la lección de `CASILLA_MARCADA`, que vive duplicado y hay que
 * acordarse de tocar los dos.
 */
export function colorARgb(hex: string | null | undefined): [number, number, number] | undefined {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return undefined;
  return [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

const texto = (i18n: any, idioma = 'es'): string =>
  (i18n && (i18n[idioma] ?? i18n.es ?? Object.values(i18n)[0])) as string ?? '';

async function enSistema<T>(fn: (trx: any) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await fijarContexto(trx, { actor: 'sistema' });
    return fn(trx);
  });
}

/** Los campos de una instancia con su valor actual. La RLS decide qué se ve. */
async function leerCampos(
  trx: any, instanciaId: string, idioma: string, mioSi: number | null, quienSoy?: string,
) {
  const r = await sql<any>`
    select c.id, c.codigo, c.etiqueta_i18n, c.tipo, c.opciones, c.obligatorio,
           c.validacion, c.pagina, c.x, c.y, c.ancho, c.alto, c.orden,
           c.posicion_firmante, c.completa_emisor, c.quien_completa, c.cuerpo, c.color,
           v.valor, v.completado_por, (v.congelado_en is not null) as congelado
      from campo c
      join instancia i on i.id = ${instanciaId}::uuid and i.circuito_id = c.circuito_id
      left join valor_campo v on v.campo_id = c.id and v.instancia_id = i.id
     order by c.pagina, c.orden, c.codigo
  `.execute(trx);

  return r.rows.map((f: any): CampoParaMostrar => ({
    id: f.id,
    codigo: f.codigo,
    etiqueta: texto(f.etiqueta_i18n, idioma),
    tipo: f.tipo,
    opciones: f.opciones,
    obligatorio: f.obligatorio,
    validacion: f.validacion,
    pagina: f.pagina,
    x: Number(f.x), y: Number(f.y), ancho: Number(f.ancho), alto: Number(f.alto),
    orden: f.orden,
    posicion_firmante: f.posicion_firmante,
    cuerpo: f.cuerpo == null ? null : Number(f.cuerpo),
    color: f.color ?? null,
    valor: f.valor ?? null,
    congelado: !!f.congelado,
    // ⚠ «Mío» tiene tres formas, no una.
    //
    //  · el campo que se le pidió a esta persona por su LUGAR;
    //  · un campo de CUALQUIERA que nadie completó todavía;
    //  · uno de cualquiera que completó ella misma y todavía puede corregir.
    //
    // Lo que NO es mío: uno de cualquiera que ya escribió otro. Se ve con su
    // valor, apagado — es el documento como va a quedar, y reescribirlo sería
    // cambiar lo que el otro ya leyó.
    mio: f.quien_completa === 'cualquiera'
      ? (mioSi !== null && !f.congelado &&
         (f.completado_por == null || f.completado_por === quienSoy))
      : (mioSi !== null && f.posicion_firmante === mioSi),
  }));
}

// ---------------------------------------------------------------------------
// El firmante, desde la pantalla de firma
// ---------------------------------------------------------------------------

export async function camposParaFirmar(token: string) {
  const e = await verificarEnlaceFirma(token);
  return withExterno(e.otorgamientoId, e.identidadId, async (trx) => {
    // ⚠ Se lee `posicion`, NO `orden`.
    //
    // El orden dice cuándo le toca; el lugar dice quién es. En paralelo todos
    // están en el orden 1, así que con el orden esta pantalla le pintaba a cada
    // firmante TODOS los campos como propios: doce renglones en amarillo y
    // ninguna forma de saber cuál era el suyo. Ver la migración 055.
    const p = await sql<{ instancia_id: string; posicion: number | null; idioma: string | null }>`
      select p.instancia_id, p.posicion, p.idioma_efectivo as idioma
        from participacion p
       where p.instancia_id in (select instancia_id from otorgamiento where id = ${e.otorgamientoId}::uuid)
         and p.identidad_id = ${e.identidadId}::uuid
         and p.papel = 'firmante'
       limit 1
    `.execute(trx);
    const yo = p.rows[0];
    if (!yo) return { campos: [] as CampoParaMostrar[] };
    return {
      campos: await leerCampos(trx, yo.instancia_id, yo.idioma ?? 'es', yo.posicion, e.identidadId),
    };
  });
}

/**
 * Guarda lo que el firmante escribió. Un campo por llamada: así el error de uno
 * no se lleva puestos los otros cuatro que estaban bien.
 *
 * ⚠ La autorización no está acá: está en la política `valor_insert` /
 * `valor_update`, que llama a `app.puede_completar_campo`. Si esta función se
 * equivocara de campo, la base la frena igual.
 */
export async function guardarValor(token: string, campoId: string, valor: string | null) {
  const e = await verificarEnlaceFirma(token);

  // ⚠ Se valida ACÁ, cuando la persona todavía puede corregirlo y en su idioma.
  // Que el dibujante corte al firmar es la segunda red, no la primera: ahí el
  // mensaje llega tarde y sin contexto.
  if (valor) {
    const malos = fueraDeWinAnsi(valor);
    if (malos.length) {
      throw new HttpError(
        400,
        `Estos caracteres no se pueden escribir en el documento: ${malos.join(' ')}. ` +
        'Cambialos y volvé a guardar.',
      );
    }
  }

  return withExterno(e.otorgamientoId, e.identidadId, async (trx) => {
    const ctx = await sql<{ instancia_id: string; cuenta_propietaria_id: string }>`
      select i.id as instancia_id, i.cuenta_propietaria_id
        from instancia i
       where i.id in (select instancia_id from otorgamiento where id = ${e.otorgamientoId}::uuid)
    `.execute(trx);
    const inst = ctx.rows[0];
    if (!inst) throw new HttpError(404, 'No encontramos el documento.');

    const r = await sql<{ id: string }>`
      insert into valor_campo (campo_id, instancia_id, cuenta_propietaria_id,
                               valor, completado_por, completado_en, origen)
      values (${campoId}::uuid, ${inst.instancia_id}::uuid, ${inst.cuenta_propietaria_id}::uuid,
              ${valor}, ${e.identidadId}::uuid, now(), 'manual')
      on conflict (campo_id, instancia_id) do update
         set valor = excluded.valor,
             completado_por = excluded.completado_por,
             completado_en = excluded.completado_en
      returning id
    `.execute(trx).catch((err: any) => {
      // La RLS devuelve «new row violates row-level security policy». Traducido:
      // o no es tu campo, o ya se congeló.
      if (/row-level security/.test(String(err?.message))) {
        throw new HttpError(403, 'Ese campo no lo completás vos, o el documento ya se firmó.');
      }
      throw err;
    });

    if (!r.rows.length) {
      // `do update` con la fila invisible por RLS no actualiza ni devuelve nada.
      throw new HttpError(403, 'Ese campo ya no se puede cambiar.');
    }
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// El emisor, desde la consola
// ---------------------------------------------------------------------------

/**
 * Un ESPEJO: otro lugar del documento donde el formulario repite el mismo dato.
 *
 * El lugar principal del campo va en sus columnas de siempre; los espejos son
 * los recuadros ADICIONALES que trae el AcroForm del cliente —el nombre del
 * paciente arriba de cada hoja, el número de expediente en cada página—. El
 * valor se dibuja una vez por espejo, con la misma letra. Quedan fijos donde
 * el formulario los puso: no se editan. Migración 059, deuda 26.
 */
export interface Espejo {
  pagina: number;
  x: number; y: number; ancho: number; alto: number;
}

/**
 * ⚠ El mismo tope que el check `campo_espejos_con_forma` de la base (059). Si
 * los dos números divergieran, la pantalla ofrecería algo que la base rechaza
 * con un 500 de Postgres en vez de una frase.
 */
export const MAX_ESPEJOS = 30;

export interface DefinicionCampo {
  codigo: string;
  etiqueta: string;
  tipo: 'texto' | 'parrafo' | 'numero' | 'fecha' | 'moneda' | 'casilla' | 'opcion' | 'etiqueta';
  opciones?: string[] | null;
  completa_emisor?: boolean;
  /** 'emisor' | 'firmante' | 'cualquiera'. Ver migración 052. */
  quien_completa?: 'emisor' | 'firmante' | 'cualquiera';
  /** El LUGAR del firmante (participacion.posicion), no su turno. Ver migración 055. */
  posicion_firmante?: number | null;
  /** Cuerpo en puntos, o null/ausente para que se ajuste solo. Ver migración 056. */
  cuerpo?: number | null;
  /** Color «#rrggbb», o null/ausente para la tinta de siempre. */
  color?: string | null;
  obligatorio?: boolean;
  pagina: number;
  x: number; y: number; ancho: number; alto: number;
  orden?: number;
  /** Los demás lugares donde se repite el dato. Sólo texto/párrafo. Migración 059. */
  espejos?: Espejo[] | null;
}

export async function listarCampos(cuentaId: string, identidadId: string, circuitoId: string) {
  return withUsuario(cuentaId, identidadId, async (trx: any) => {
    const r = await sql<any>`
      select c.*,
             (select count(*) from valor_campo v where v.campo_id = c.id) as usos,
             -- ⚠ El valor que YA escribió el emisor, para poder mostrarlo y
             -- corregirlo. Sale por LEFT JOIN sobre la primera instancia: en
             -- serie y paralelo hay una sola, y en copias todas comparten lo que
             -- pone el emisor porque es lo mismo para todos.
             (select v.valor from valor_campo v
                join instancia i on i.id = v.instancia_id
               where v.campo_id = c.id and i.circuito_id = c.circuito_id
               order by i.numero limit 1) as valor_emisor
        from campo c
       where c.circuito_id = ${circuitoId}::uuid
       order by c.pagina, c.orden, c.codigo
    `.execute(trx);
    return {
      campos: r.rows.map((f: any) => ({
        ...f,
        etiqueta: texto(f.etiqueta_i18n),
        x: Number(f.x), y: Number(f.y), ancho: Number(f.ancho), alto: Number(f.alto),
      })),
    };
  });
}

/**
 * Lo que el emisor escribe en SUS campos, antes de mandar el documento.
 *
 * ═══ POR QUÉ ESTO FALTABA Y SE NOTABA ═══
 *
 * Se podía marcar un campo como «Lo escribo yo» desde el primer día del módulo,
 * y no existía ningún lugar donde escribirlo. La opción estaba y no llevaba a
 * ninguna parte: el campo quedaba definido, vacío, y el documento salía así.
 * Peor todavía si era obligatorio — el firmante veía un recuadro gris que no
 * podía completar y no había forma de terminar de firmar.
 *
 * ═══ QUIÉN PUEDE, Y HASTA CUÁNDO ═══
 *
 * No lo decide esta función: lo decide `app.puede_completar_campo`, rama (a),
 * que exige que el campo sea del emisor, que la cuenta sea la propietaria, que
 * el actor sea una cuenta y que **el circuito esté en borrador**. Después del
 * despacho no se toca: los firmantes ya vieron el documento con estos valores y
 * cambiarlos sería cambiarles lo que aceptaron.
 *
 * ⚠ En modo copias se escribe en TODAS las instancias. Lo que pone el emisor es
 * lo mismo para las mil copias —es parte del documento, no del destinatario—;
 * lo que cambia por persona va a venir de la planilla y es otra cosa.
 */
export async function guardarValorDelEmisor(
  cuentaId: string,
  identidadId: string,
  circuitoId: string,
  campoId: string,
  valor: string | null,
) {
  // ⚠ Se valida ACÁ, mientras el emisor todavía puede corregirlo. Que el
  // dibujante corte al firmar es la segunda red, no la primera.
  if (valor) {
    const malos = fueraDeWinAnsi(valor);
    if (malos.length) {
      throw new HttpError(
        400,
        `Estos caracteres no se pueden escribir en el documento: ${malos.join(' ')}. ` +
        'Cambialos y volvé a guardar.',
      );
    }
  }

  return withUsuario(cuentaId, identidadId, async (trx: any, autz: any) => {
    exigir(autz, 'circuito', 'crear', 'No tenés permiso para preparar documentos.');

    const inst = await sql<{ id: string }>`
      select i.id
        from instancia i
        join campo c on c.circuito_id = i.circuito_id and c.id = ${campoId}::uuid
       where i.circuito_id = ${circuitoId}::uuid
       order by i.numero
    `.execute(trx);

    if (!inst.rows.length) {
      throw new HttpError(404, 'Ese campo no es de este documento.');
    }

    for (const fila of inst.rows) {
      const r = await sql<{ id: string }>`
        insert into valor_campo (campo_id, instancia_id, cuenta_propietaria_id,
                                 valor, completado_por, completado_en, origen)
        values (${campoId}::uuid, ${fila.id}::uuid, ${cuentaId}::uuid,
                ${valor}, ${identidadId}::uuid, now(), 'manual')
        on conflict (campo_id, instancia_id) do update
           set valor = excluded.valor,
               completado_por = excluded.completado_por,
               completado_en = excluded.completado_en
        returning id
      `.execute(trx).catch((err: any) => {
        if (/row-level security/.test(String(err?.message))) {
          throw new HttpError(
            403,
            'Ese campo no lo completás vos, o el documento ya salió a firmar y no se puede cambiar.',
          );
        }
        throw err;
      });

      if (!r.rows.length) {
        throw new HttpError(403, 'Ese campo ya no se puede cambiar: el documento ya salió a firmar.');
      }
    }

    return { ok: true, instancias: inst.rows.length };
  });
}

export async function definirCampos(
  cuentaId: string,
  identidadId: string,
  circuitoId: string,
  campos: DefinicionCampo[],
) {
  if (campos.length > 200) {
    throw new HttpError(400, 'Son demasiados campos para un documento (máximo 200).');
  }
  for (const c of campos) {
    if (!c.codigo?.trim()) throw new HttpError(400, 'Cada campo necesita un código.');
    if (!c.etiqueta?.trim()) throw new HttpError(400, `El campo «${c.codigo}» necesita una etiqueta.`);
    // ⚠ Un texto fijo es del emisor por definición, no por elección: si lo
    // pudiera completar un firmante sería un campo de texto común. Se corrige en
    // vez de rechazarse — la pantalla no ofrece elegir, así que un valor
    // distinto acá es ruido de un cliente viejo, no una decisión de nadie.
    if (c.tipo === 'etiqueta') {
      c.quien_completa = 'emisor';
      c.completa_emisor = true;
      c.posicion_firmante = null;
      c.obligatorio = false;
    }

    // ⚠ El modo manda, y las columnas se derivan de él. Al revés —deducir el
    // modo de las columnas— «posicion_firmante null y no del emisor» sería
    // ambiguo entre «cualquiera» y «falta decidirlo».
    const modo = c.quien_completa
      ?? (c.completa_emisor ? 'emisor' : (c.posicion_firmante != null ? 'firmante' : 'cualquiera'));
    if (!['emisor', 'firmante', 'cualquiera'].includes(modo)) {
      throw new HttpError(400, `No entiendo quién completa «${c.codigo}».`);
    }
    c.quien_completa = modo as any;
    c.completa_emisor = modo === 'emisor';
    if (modo !== 'firmante') c.posicion_firmante = null;
    else if (c.posicion_firmante == null) {
      throw new HttpError(400, `Decidí a qué firmante se le pide «${c.codigo}».`);
    }

    // ⚠ Espejos SÓLO para texto y párrafo, y se corrige en vez de rechazarse:
    // en un campo de opciones cada widget del PDF es una opción distinta, no el
    // mismo dato repetido — espejar ahí estamparía el valor elegido arriba de
    // todas las opciones. `detectarCampos` no los ofrece para esos tipos; si
    // llegan igual (el tipo se cambió en el editor después de adoptar), se
    // descartan acá en silencio, que es lo que el emisor esperaría al cambiar
    // el tipo.
    if (c.tipo !== 'texto' && c.tipo !== 'parrafo') c.espejos = [];
    if ((c.espejos?.length ?? 0) > MAX_ESPEJOS) {
      throw new HttpError(400, `«${c.codigo}» repite el dato en demasiados lugares (máximo ${MAX_ESPEJOS}).`);
    }
  }

  return withUsuario(cuentaId, identidadId, async (trx: any, autz: any) => {
    exigir(autz, 'circuito', 'crear', 'No tenés permiso para preparar documentos.');

    // ⚠ Lo que el emisor ya escribió, ANTES de borrar los campos.
    //
    // Reemplazar el juego entero es lo correcto para la definición —reconciliar
    // altas, bajas y movimientos fila por fila desde el navegador es la clase de
    // sincronización que se desincroniza— pero `valor_campo.campo_id` borra en
    // cascada. O sea que sin esto, cada vez que el emisor toca «Guardar campos»
    // pierde en silencio todo lo que había escrito en los suyos, y lo descubre
    // cuando el documento sale en blanco.
    //
    // Se conservan por CÓDIGO y no por id, porque los ids son nuevos después del
    // insert. El código es lo que identifica al campo entre una versión y otra —
    // es lo mismo que permite reconocerlo si se reemplaza el PDF base.
    const previos = await sql<{ codigo: string; instancia_id: string; valor: string | null }>`
      select c.codigo, v.instancia_id, v.valor
        from valor_campo v
        join campo c on c.id = v.campo_id
       where c.circuito_id = ${circuitoId}::uuid
         and v.congelado_en is null
         and v.valor is not null
    `.execute(trx);

    // Se reemplaza el juego entero: la pantalla manda lo que quedó después de
    // arrastrar.
    //
    // ⚠ El trigger `campo_congelado` frena esto si el circuito ya salió, así que
    // no hay forma de perder los valores de un documento en curso.
    await sql`delete from campo where circuito_id = ${circuitoId}::uuid`.execute(trx);

    for (const [i, c] of campos.entries()) {
      await sql`
        insert into campo (circuito_id, cuenta_propietaria_id, codigo, etiqueta_i18n,
                           tipo, opciones, completa_emisor, quien_completa, posicion_firmante,
                           cuerpo, color, obligatorio, pagina, x, y, ancho, alto, orden, espejos)
        values (${circuitoId}::uuid, ${cuentaId}::uuid, ${c.codigo.trim()},
                ${JSON.stringify({ es: c.etiqueta.trim() })}::jsonb,
                ${c.tipo}, ${c.opciones ? JSON.stringify(c.opciones) : null}::jsonb,
                ${!!c.completa_emisor}, ${c.quien_completa ?? 'firmante'},
                ${c.posicion_firmante ?? null},
                ${c.cuerpo ?? null},
                -- En minúsculas, que es lo único que acepta la restricción: si
                -- cada pantalla manda su forma, la base rebota una y no la otra.
                ${c.color ? String(c.color).toLowerCase() : null},
                ${!!c.obligatorio},
                ${c.pagina}, ${c.x}, ${c.y}, ${c.ancho}, ${c.alto}, ${c.orden ?? i},
                ${JSON.stringify(c.espejos ?? [])}::jsonb)
      `.execute(trx);
    }

    // Se reponen los valores que sobrevivieron: los de un código que sigue
    // existiendo. Si el emisor quitó un campo, su valor se va con él, que es lo
    // que quiso decir al quitarlo.
    let repuestos = 0;
    for (const p of previos.rows) {
      if (!campos.some((c) => c.codigo.trim() === p.codigo)) continue;
      const r = await sql<{ id: string }>`
        insert into valor_campo (campo_id, instancia_id, cuenta_propietaria_id,
                                 valor, completado_por, completado_en, origen)
        select c.id, ${p.instancia_id}::uuid, ${cuentaId}::uuid,
               ${p.valor}, ${identidadId}::uuid, now(), 'manual'
          from campo c
         where c.circuito_id = ${circuitoId}::uuid and c.codigo = ${p.codigo}
        on conflict (campo_id, instancia_id) do nothing
        returning id
      `.execute(trx);
      repuestos += r.rows.length;
    }

    return { ok: true, campos: campos.length, valores_conservados: repuestos };
  });
}

// ---------------------------------------------------------------------------
// Lo que usa `firmar()`
// ---------------------------------------------------------------------------

export interface CamposListos {
  /** Lo que hay que dibujar, en el mismo incremento que la firma. */
  marcas: Marca[];
  /** Lo que hay que congelar, con el valor exacto que se dibujó. */
  congelar: { id: string; codigo: string; valor: string; sha256: Buffer }[];
}

/**
 * Valida y prepara los campos de este firmante. **No escribe nada.**
 *
 * Corre con el contexto que le pase quien llama —el del otorgamiento— para que
 * la RLS siga decidiendo qué ve.
 */
/** Las formas de «marcada» que pueden llegar de verdad. Ver `prepararCampos`. */
const CASILLA_MARCADA = new Set(['sí', 'si', 'true', '1', 'x', 'yes', 'on', 'sim']);

/** Y las de «sin marcar», para que una planilla pueda decir que no. */
const CASILLA_VACIA = new Set(['no', 'false', '0', 'nao', 'não', 'off', '-']);

/** Lo que hay que saber de un campo para juzgar un valor de planilla. */
export interface CampoValidable {
  codigo: string;
  etiqueta: string;
  tipo: string;
  opciones: string[] | null;
  obligatorio: boolean;
}

export type ValorJuzgado = { ok: true; valor: string } | { ok: false; motivo: string };

/**
 * ¿Este valor de la planilla puede ir a este campo? — envío con datos por persona.
 *
 * ═══ POR QUÉ VALIDA MÁS QUE LA PANTALLA ═══
 *
 * En la pantalla el emisor escribe UN valor, lo tiene adelante y lo corrige al
 * toque. Una planilla son cuarenta valores que nadie va a mirar uno por uno:
 * un «13/8» donde iba un monto termina dibujado en el contrato de alguien y se
 * descubre cuando ya está firmado. Acá el criterio es el del lote del diseño
 * (§5 de repositorio-campos-y-envio-masivo): **se valida todo ANTES de escribir
 * nada**, y un valor que no se entiende rechaza el lote diciendo qué y dónde.
 *
 * ⚠ NO normaliza números ni fechas: guarda lo que la celda decía, que es lo
 * que se va a dibujar. Validar es constatar que se entiende, no reescribirlo.
 * La única excepción es `opcion`, que guarda la opción CANÓNICA del campo:
 * «juridica» y «Jurídica» son la misma opción y el documento tiene que decirla
 * como el emisor la definió.
 *
 * Devuelve el motivo SIN fila ni columna: ésos los agrega el llamador, que es
 * quien los conoce.
 */
export function juzgarValorDePlanilla(campo: CampoValidable, crudo: string): ValorJuzgado {
  const valor = String(crudo ?? '').trim();

  if (!valor) {
    return campo.obligatorio
      ? { ok: false, motivo: 'es obligatorio y la celda está vacía' }
      : { ok: true, valor: '' };
  }

  const malos = fueraDeWinAnsi(valor);
  if (malos.length) {
    return { ok: false, motivo: `trae caracteres que no se pueden dibujar: ${malos.join(' ')}` };
  }

  switch (campo.tipo) {
    case 'numero':
    case 'moneda': {
      // Se acepta como lo escribe una persona: 1234 · 1.234,56 · 1,234.56 ·
      // $ 1234. Lo que no se acepta es algo que no sea un número.
      const pelado = valor.replace(/[\s$]/g, '').replace(/^(U\$S|USD|UYU|R\$|Gs\.?)/i, '');
      if (!/^-?\d{1,3}(([.,]\d{3})*|\d*)([.,]\d+)?$/.test(pelado)) {
        return { ok: false, motivo: `tiene que ser un número y dice «${valor}»` };
      }
      return { ok: true, valor };
    }
    case 'fecha': {
      // dd/mm/aaaa (como escribe la celda y como formatea `celdaATexto`) o
      // aaaa-mm-dd. Se constata que el día exista: 31/02 no es una fecha.
      const m =
        /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(valor) ??
        (/^(\d{4})-(\d{2})-(\d{2})$/.test(valor)
          ? (() => {
              const [a, mm, d] = valor.split('-');
              return [valor, d, mm, a] as unknown as RegExpExecArray;
            })()
          : null);
      if (!m) return { ok: false, motivo: `tiene que ser una fecha como 05/03/2026 y dice «${valor}»` };
      const [d, mes, anio] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const f = new Date(anio, mes - 1, d);
      if (f.getFullYear() !== anio || f.getMonth() !== mes - 1 || f.getDate() !== d) {
        return { ok: false, motivo: `«${valor}» no es una fecha del calendario` };
      }
      return { ok: true, valor };
    }
    case 'casilla': {
      const bajo = valor.toLowerCase();
      if (CASILLA_MARCADA.has(bajo)) return { ok: true, valor };
      if (CASILLA_VACIA.has(bajo)) return { ok: true, valor: '' };
      return {
        ok: false,
        motivo: `una casilla se marca con «sí», «x» o «1» (o «no» para dejarla vacía) y dice «${valor}»`,
      };
    }
    case 'opcion': {
      const opciones = campo.opciones ?? [];
      const aplanar = (s: string) =>
        s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
      const elegida = opciones.find((o) => aplanar(o) === aplanar(valor));
      if (!elegida) {
        return { ok: false, motivo: `tiene que ser una de: ${opciones.join(', ')} — y dice «${valor}»` };
      }
      return { ok: true, valor: elegida };
    }
    case 'texto':
    case 'parrafo':
      return { ok: true, valor };
    default:
      // `etiqueta` y lo que venga después: no reciben valores por persona.
      return { ok: false, motivo: `un campo de tipo «${campo.tipo}» no se completa desde una planilla` };
  }
}

/** Una columna de la planilla que SÍ es un campo del documento. */
export interface ColumnaMapeada {
  titulo: string;
  codigo: string;
  etiqueta: string;
  /**
   * De quién es el campo. Importa para dos cosas: la pantalla avisa cuáles
   * columnas quedan como SUGERENCIA que el firmante puede corregir, y el lote
   * sólo exige los obligatorios que son del emisor.
   */
  quien: 'emisor' | 'firmante' | 'cualquiera';
}
/** Una que no, con el porqué — se muestra, no se descarta en silencio. */
export interface ColumnaIgnorada { titulo: string; motivo: string; }

/**
 * ¿Qué columna de la planilla es qué campo del documento?
 *
 * Por NOMBRE y nada más: el título de la columna contra el código del campo y
 * contra su etiqueta en cualquiera de los idiomas, sin mayúsculas ni tildes.
 * «Sueldo», «sueldo» y «SUELDO» son la misma columna; adivinar por posición o
 * por parecido es poner el monto en el renglón del teléfono.
 *
 * ⚠ Entran TODOS los campos, también los del firmante — opción B, decidida por
 * Claudio el 13/8 (reemplaza al «sólo del emisor» de esa misma tarde). El dato
 * del firmante queda PRELLENADO en su copia y él puede corregirlo hasta
 * firmar: la migración 060 abre esa escritura sólo en borrador, y el
 * expediente dice quién escribió qué (`origen='planilla'`). Cada columna sale
 * con su `quien` para que la pantalla avise cuáles son sugerencias.
 */
export function mapearColumnasACampos(
  titulos: string[],
  campos: {
    codigo: string;
    etiqueta_i18n?: unknown;
    etiqueta?: string;
    tipo: string;
    quien_completa?: string | null;
  }[],
): { columnas: ColumnaMapeada[]; ignoradas: ColumnaIgnorada[] } {
  const aplanar = (s: string) =>
    String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

  // Cada campo, con todos los nombres por los que responde.
  const porNombre = new Map<string, (typeof campos)[number]>();
  for (const c of campos) {
    const nombres = new Set<string>([aplanar(c.codigo)]);
    if (c.etiqueta) nombres.add(aplanar(c.etiqueta));
    if (c.etiqueta_i18n && typeof c.etiqueta_i18n === 'object') {
      for (const v of Object.values(c.etiqueta_i18n as Record<string, unknown>)) {
        if (typeof v === 'string') nombres.add(aplanar(v));
      }
    }
    // Si dos campos responden al mismo nombre, gana el primero: el orden es el
    // de la consulta (página y orden), que es el del documento.
    for (const n of nombres) if (n && !porNombre.has(n)) porNombre.set(n, c);
  }

  const RELLENABLES = new Set(['texto', 'parrafo', 'numero', 'fecha', 'moneda', 'casilla', 'opcion']);
  const columnas: ColumnaMapeada[] = [];
  const ignoradas: ColumnaIgnorada[] = [];
  const usados = new Set<string>();

  for (const titulo of titulos) {
    const campo = porNombre.get(aplanar(titulo));
    if (!campo) {
      ignoradas.push({ titulo, motivo: 'no coincide con ningún campo del documento' });
      continue;
    }
    if (!RELLENABLES.has(campo.tipo)) {
      ignoradas.push({ titulo, motivo: `un campo de tipo «${campo.tipo}» no se completa desde una planilla` });
      continue;
    }
    if (usados.has(campo.codigo)) {
      ignoradas.push({ titulo, motivo: `repite una columna que ya apunta a «${campo.codigo}»` });
      continue;
    }
    usados.add(campo.codigo);
    const quien = (campo.quien_completa ?? 'firmante') as ColumnaMapeada['quien'];
    columnas.push({
      titulo,
      codigo: campo.codigo,
      etiqueta: campo.etiqueta ?? campo.codigo,
      quien: quien === 'emisor' || quien === 'cualquiera' ? quien : 'firmante',
    });
  }
  return { columnas, ignoradas };
}

/** Lo mínimo que hace falta saber de un campo para nombrarlo. */
type CampoNombrable = {
  codigo: string;
  quien_completa?: string | null;
  completa_emisor?: boolean | null;
  posicion_firmante?: number | null;
};

/**
 * El `/T` del widget que MiFirma escribe en el PDF para este campo.
 *
 * ═══ POR QUÉ ESTÁ EN UNA SOLA FUNCIÓN ═══
 *
 * ⚠ Este nombre se calcula DOS veces sobre el mismo campo: una antes de la
 * primera firma, cuando `predeclarar()` deja el widget creado y vacío, y otra
 * en cada firma, cuando `prepararCampos` lo completa. Si las dos formas
 * difieren en un carácter, la firma no encuentra el widget pre-declarado, lo
 * AGREGA, y Acrobat vuelve a decir «el documento se ha modificado o dañado
 * desde que fue firmado» — sin un solo error a la vista de nadie.
 *
 * Un valor calculado en dos lugares se desincroniza; es exactamente lo que pasó
 * con `orden` y `posicion` en la 055. Así que se calcula acá y en ningún otro
 * lado.
 *
 * ═══ POR QUÉ EL SUFIJO NO ES SIEMPRE EL LUGAR ═══
 *
 * ⚠ Antes era siempre el lugar del que estaba firmando, y para un campo DEL
 * FIRMANTE está bien: el lugar es suyo, no cambia, y es lo que evita que dos
 * personas que completan el mismo código choquen entre sí (055).
 *
 * Pero un campo del EMISOR y uno de `cualquiera` los dibuja **el primero que
 * firme**, y en modo paralelo eso no se sabe de antemano: el mismo campo salía
 * `razon_social__mf1` o `razon_social__mf2` según quién llegara primero. Un
 * nombre que no se puede predecir no se puede pre-declarar — y la mitad del
 * arreglo se caía justo ahí, en silencio.
 *
 * Los dos se congelan en la primera vuelta y no se vuelven a dibujar (ver el
 * `congelado_en` de `prepararCampos`), así que un sufijo fijo no puede chocar
 * con nada: hay uno solo por documento.
 *
 * ⚠ Y el nombre NO puede ser el código pelado: cuando el campo se adoptó del
 * AcroForm del cliente, el código ES el nombre del campo original, y el
 * documento firmado terminaría con dos campos llamados igual. Ver el comentario
 * largo en `prepararCampos`.
 */
export function nombreDelWidget(campo: CampoNombrable): string {
  // El modo manda; las columnas se derivan de él. Es la misma regla que aplica
  // `definirCampos`, y se repite el `??` para que una fila vieja sin
  // `quien_completa` no produzca un nombre distinto del que produciría hoy.
  const modo = campo.quien_completa
    ?? (campo.completa_emisor ? 'emisor'
      : campo.posicion_firmante != null ? 'firmante' : 'cualquiera');
  const sufijo = modo === 'emisor' ? 'E'
    : modo === 'cualquiera' ? 'C'
    : String(campo.posicion_firmante ?? 1);
  return `${campo.codigo}__mf${sufijo}`;
}

/**
 * El `/T` del widget de un ESPEJO: el lugar i-ésimo (base 0) donde el
 * formulario repite el dato. Migración 059.
 *
 * ⚠ MISMA REGLA QUE `nombreDelWidget`, Y POR EL MISMO MOTIVO: este nombre se
 * calcula dos veces —al pre-declarar y al completar—, y si las dos formas
 * difieren en un carácter la firma no encuentra el widget, lo AGREGA, y
 * Acrobat vuelve a decir «modificado o dañado». Por eso vive acá al lado y en
 * ningún otro lado.
 *
 * El sufijo cuelga del nombre del widget principal: si el principal es único
 * en el documento (lo garantizan `unique (circuito_id, codigo)` más el sufijo
 * de modo), sus espejos también lo son.
 */
export function nombreDelEspejo(campo: CampoNombrable, indice: number): string {
  return `${nombreDelWidget(campo)}_e${indice + 1}`;
}

export async function prepararCampos(
  trx: any,
  instanciaId: string,
  /** El LUGAR del que está firmando (participacion.posicion), no su turno. */
  posicion: number,
): Promise<CamposListos> {
  const r = await sql<any>`
    select c.id, c.codigo, c.etiqueta_i18n, c.obligatorio, c.tipo, c.completa_emisor,
           c.quien_completa, c.posicion_firmante, c.cuerpo, c.color,
           c.pagina, c.x, c.y, c.ancho, c.alto, c.espejos,
           v.valor, v.congelado_en
      from campo c
      join instancia i on i.id = ${instanciaId}::uuid and i.circuito_id = c.circuito_id
      left join valor_campo v on v.campo_id = c.id and v.instancia_id = i.id
     -- ⚠ Los del firmante que firma Y LOS DEL EMISOR.
     --
     -- Faltaban los del emisor y el efecto era silencioso: se podía escribir el
     -- valor, se guardaba bien, y no aparecía en el documento. La consulta sólo
     -- miraba el campo del firmante N, y uno del emisor lo tiene en null.
     --
     -- No hace falta saber quién firma primero: los del emisor se dibujan y se
     -- congelan con la primera firma que ocurra, y a partir de ahí el
     -- congelado_en de abajo los saltea. El segundo firmante no los redibuja.
     -- Los del firmante que firma, los del emisor, y los de cualquiera que
     -- alguien haya completado. Estos últimos los dibuja el primero que firme
     -- después de que se escribieron, y el congelado de abajo evita repetirlos.
     where c.posicion_firmante = ${posicion} or c.completa_emisor
        or c.quien_completa = 'cualquiera'
     order by c.pagina, c.orden
  `.execute(trx);

  const marcas: Marca[] = [];
  const congelar: CamposListos['congelar'] = [];
  const faltan: string[] = [];

  for (const f of r.rows) {
    const valor = (f.valor ?? '').trim();
    if (!valor) {
      // ⚠ Un campo DEL EMISOR vacío no traba al firmante.
      //
      // Se le pediría completar algo que no es suyo y que no puede tocar: la
      // pantalla diría «falta completar X», el botón quedaría apagado, y no
      // habría nada que hacer del otro lado. Un mensaje que culpa a quien no
      // puede arreglarlo es peor que no decir nada.
      //
      // Que el emisor no se olvide de los suyos es cosa del despacho, que es
      // donde todavía se pueden completar.
      // Ni un campo del emisor ni uno de cualquiera trabado por otro: en los
      // dos casos se le pediría a esta persona algo que no puede hacer.
      if (f.obligatorio && !f.completa_emisor && f.quien_completa !== 'cualquiera') {
        faltan.push(texto(f.etiqueta_i18n));
      }
      continue;                       // un campo opcional vacío no se dibuja
    }
    if (f.congelado_en) continue;     // ya firmado en una vuelta anterior

    // Una casilla no se dibuja como texto: se dibuja como una marca.
    //
    // ⚠ Acá comparaba contra `'true'`, y NADIE guarda `'true'`. La pantalla del
    // firmante guarda `'sí'` —siempre lo hizo— y `detectarCampos` lee `'sí'` del
    // AcroForm. O sea que la rama estaba muerta desde el primer día: toda
    // casilla marcada caía en el `continue` de abajo.
    //
    // Y no era sólo que no se dibujara. Al no entrar en `congelar`, el valor
    // quedaba SIN congelar sobre un documento ya firmado — editable. Es
    // exactamente lo que la regla dura prohíbe: «un campo editable sobre un
    // documento firmado es un documento que dice cosas distintas según cuándo se
    // lo mire». Una casilla que dice «Acepto las condiciones» es el peor lugar
    // posible para que eso pase.
    //
    // Se aceptan las formas que pueden llegar de verdad —la nuestra, la del
    // AcroForm y la de una planilla de envío masivo— en vez de una sola cadena
    // exacta que ya falló una vez.
    const dibujo = f.tipo === 'casilla'
      ? (CASILLA_MARCADA.has(valor.toLowerCase()) ? 'X' : '')
      : valor;
    if (!dibujo) continue;

    marcas.push({
      pagina: f.pagina,
      rect: [Number(f.x), Number(f.y), Number(f.x) + Number(f.ancho), Number(f.y) + Number(f.alto)],
      texto: dibujo,
      modo: 'campo',
      // Cómo se ve el valor. Los dos pueden faltar, y faltar significa lo de
      // siempre: cuerpo ajustado al recuadro y la tinta general. Ver 056.
      cuerpo: f.cuerpo == null ? undefined : Number(f.cuerpo),
      color: colorARgb(f.color),
      // ⚠ El nombre del widget NO puede ser el código del campo.
      //
      // Cuando el campo se adoptó del propio AcroForm del PDF —que es el caso
      // normal, para eso existe `detectarCampos`— el código ES el nombre del
      // campo original: `razon_social`. Al escribir el nuestro con ese mismo
      // `/T`, el documento firmado termina con dos campos llamados igual, y un
      // nombre de campo tiene que ser único en un AcroForm.
      //
      // Medido sobre un documento firmado de verdad: el AcroForm quedó con
      // `razon_social` dos veces —el original vacío y el nuestro con el valor— y
      // el lector mostraba el original. La persona completaba, firmaba, y el
      // documento salía en blanco.
      //
      // El sufijo por LUGAR del firmante además evita que dos firmantes que
      // completan el mismo código en vueltas distintas choquen entre sí.
      //
      // ⚠ El sufijo salía del TURNO, y eso reponía este mismo defecto en modo
      // paralelo: ahí los tres firmantes están en el turno 1, así que los tres
      // widgets se llamaban `codigo__mf1` y el AcroForm volvía a tener nombres
      // repetidos — con el lector mostrando el primero y el documento saliendo
      // en blanco. El lugar es distinto para cada persona, así que el nombre
      // también. Ver migración 055.
      //
      // ⚠ Y sale del CAMPO, no del `posicion` que recibió esta llamada. Para un
      // campo del firmante da lo mismo —son el mismo número— pero para uno del
      // emisor daba el lugar del que firmara primero, que no se puede predecir
      // y por lo tanto no se puede pre-declarar. Ver `nombreDelWidget`.
      etiqueta: nombreDelWidget(f),
    });

    // Los ESPEJOS: el mismo valor, una marca por cada lugar donde el formulario
    // lo repite. La misma letra y la misma tinta que el principal; si `cuerpo`
    // no está fijado, cada marca se ajusta a SU recuadro — un espejo más chico
    // dibuja más chico, igual que haría el formulario original.
    //
    // ⚠ Van adentro del mismo `if` de valor y congelado que el principal: un
    // campo sin valor no dibuja nada en ningún lado, y uno congelado no se
    // redibuja — los espejos heredan las dos reglas sin código propio.
    //
    // Se CONGELA UNA sola vez (abajo): el valor es uno; los espejos son
    // geometría, no valores.
    const espejos: Espejo[] = Array.isArray(f.espejos) ? f.espejos : [];
    for (const [iEspejo, e] of espejos.entries()) {
      marcas.push({
        pagina: Number(e.pagina),
        rect: [Number(e.x), Number(e.y), Number(e.x) + Number(e.ancho), Number(e.y) + Number(e.alto)],
        texto: dibujo,
        modo: 'campo',
        cuerpo: f.cuerpo == null ? undefined : Number(f.cuerpo),
        color: colorARgb(f.color),
        // ⚠ El nombre sale de `nombreDelEspejo`, el MISMO que usa
        // `widgetsAPredeclarar`. Si difieren en un carácter, la firma agrega el
        // widget en vez de completarlo y Acrobat castiga. Ver `nombreDelWidget`.
        etiqueta: nombreDelEspejo(f, iEspejo),
      });
    }

    congelar.push({
      id: f.id,
      codigo: f.codigo,
      valor,
      sha256: createHash('sha256').update(valor, 'utf8').digest(),
    });
  }

  if (faltan.length) {
    // ⚠ Se nombran. «Faltan campos obligatorios» obliga a buscarlos a ojo en un
    // documento de treinta hojas.
    throw new HttpError(
      400,
      faltan.length === 1
        ? `Falta completar «${faltan[0]}» antes de firmar.`
        : `Faltan completar estos campos antes de firmar: ${faltan.join(', ')}.`,
    );
  }

  return { marcas, congelar };
}

/**
 * Todos los widgets que este documento va a necesitar, para dejarlos creados
 * antes de la primera firma.
 *
 * ═══ POR QUÉ NO FILTRA NADA ═══
 *
 * `prepararCampos` filtra por lugar, por valor y por congelado, porque le
 * interesa lo que hay que DIBUJAR ahora. Acá interesa lo que va a hacer falta
 * ALGUNA VEZ, y eso incluye los campos de los que todavía no firmaron, los
 * opcionales que quizá nadie complete, y los que en esta vuelta están vacíos.
 * Pre-declarar de menos es no arreglar nada; pre-declarar de más deja un widget
 * vacío que no dibuja nada.
 *
 * ⚠ Un widget pre-declarado que nadie complete se queda en el AcroForm sin
 * valor, y con «Resaltar campos existentes» Acrobat le va a pintar el recuadro
 * —el R10 de `campos-sobre-el-pdf.md`, ahora multiplicado—. Es un costo
 * conocido y aceptado: la alternativa es la banda roja en todos los documentos
 * de más de un firmante.
 *
 * ═══ QUÉ VE ESTA CONSULTA ═══
 *
 * ⚠ Corre con el contexto del firmante, y trae campos que NO son suyos. Eso no
 * es un descuido de la RLS: la política `campo_select` de la 038 lo dice con
 * todas las letras — «un firmante tiene que poder ver TODOS los campos, no sólo
 * los suyos, porque necesita leer lo que completó el anterior». Ver el valor es
 * otra cosa y lo decide `valor_select`; acá no se leen valores.
 *
 * ⚠ El `join` contra `instancia` es contra una tabla con RLS. Es el mismo que
 * ya hace `prepararCampos` desde el mismo contexto. Ver `rls-trampas.md` §19.
 */
export async function widgetsAPredeclarar(
  trx: any,
  instanciaId: string,
): Promise<WidgetPredeclarado[]> {
  const r = await sql<any>`
    select c.codigo, c.quien_completa, c.completa_emisor, c.posicion_firmante,
           c.pagina, c.x, c.y, c.ancho, c.alto, c.espejos
      from campo c
      join instancia i on i.id = ${instanciaId}::uuid and i.circuito_id = c.circuito_id
     order by c.pagina, c.orden
  `.execute(trx);

  const vistos = new Set<string>();
  const salida: WidgetPredeclarado[] = [];

  const agregar = (nombre: string, pagina: number, rect: [number, number, number, number]) => {
    // `unique (circuito_id, codigo)` de la 038 hace que esto no pueda pasar. Se
    // comprueba igual porque el costo es una línea y la consecuencia sería dos
    // widgets con el mismo `/T` adentro de un documento firmado — el defecto
    // nº 2 del 4/8, con el lector mostrando el vacío.
    if (vistos.has(nombre)) {
      console.warn(`[predeclarar] dos campos quieren llamarse «${nombre}»; se pre-declara uno solo`);
      return;
    }
    vistos.add(nombre);
    salida.push({ nombre, pagina, rect });
  };

  for (const f of r.rows) {
    const x = Number(f.x), y = Number(f.y);
    // El rectángulo propuesto. Si después el valor se dibuja en otro lado
    // —o el firmante mueve algo— el widget se reescribe con el rectángulo
    // nuevo, que es un cambio permitido. Variante C del laboratorio.
    agregar(nombreDelWidget(f), f.pagina, [x, y, x + Number(f.ancho), y + Number(f.alto)]);

    // Un widget por ESPEJO, con el nombre que después va a buscar
    // `prepararCampos`. Pre-declarar de más deja un widget vacío que no dibuja
    // nada — costo conocido del pre-declarado, ver el encabezado.
    const espejos: Espejo[] = Array.isArray(f.espejos) ? f.espejos : [];
    for (const [iEspejo, e] of espejos.entries()) {
      const ex = Number(e.x), ey = Number(e.y);
      agregar(nombreDelEspejo(f, iEspejo), Number(e.pagina),
              [ex, ey, ex + Number(e.ancho), ey + Number(e.alto)]);
    }
  }

  return salida;
}

/**
 * Congela lo que se dibujó. Va en la MISMA transacción que registra la firma.
 *
 * ⚠ El `where valor is not distinct from` no es defensivo por costumbre: si
 * entre que se leyó el valor y se llegó acá alguien lo cambió —dos pestañas
 * abiertas, dos clics— habríamos dibujado una cosa y congelado otra. Si no
 * coincide, se levanta y la transacción entera se deshace: no se guarda la
 * firma, y la persona reintenta viendo lo que realmente hay.
 */
export async function congelarCampos(
  trx: any,
  instanciaId: string,
  circuitoId: string,
  cuentaId: string,
  identidadId: string,
  participacionId: string,
  lista: CamposListos['congelar'],
) {
  for (const c of lista) {
    const r = await sql<{ id: string }>`
      update valor_campo
         set congelado_en = now(), sha256_valor = ${c.sha256}
       where campo_id = ${c.id}::uuid
         and instancia_id = ${instanciaId}::uuid
         and congelado_en is null
         and valor is not distinct from ${c.valor}
      returning id
    `.execute(trx);

    if (!r.rows.length) {
      throw new HttpError(
        409,
        'El valor de un campo cambió mientras firmabas. Volvé a abrir el documento y revisalo.',
      );
    }

    await anotar(trx, {
      instanciaId,
      circuitoId,
      cuentaPropietariaId: cuentaId,
      tipo: 'documento.campo_completado',
      actorTipo: 'firmante',
      identidadId,
      participacionId,
      // ⚠ El valor NO va al expediente en claro: puede ser un sueldo o un
      // diagnóstico, y el expediente lo leen todos los participantes. Va su
      // huella, que es lo que prueba qué se firmó sin contarlo.
      datos: { campo: c.codigo, sha256_valor: c.sha256.toString('hex') },
    });
  }

  if (lista.length) {
    await anotar(trx, {
      instanciaId,
      circuitoId,
      cuentaPropietariaId: cuentaId,
      tipo: 'documento.campos_congelados',
      actorTipo: 'firmante',
      identidadId,
      participacionId,
      datos: { campos: lista.length },
    });
  }
}

// ---------------------------------------------------------------------------
// Los campos que el PDF YA TRAE
// ---------------------------------------------------------------------------

/**
 * Lee el AcroForm del documento y devuelve sus campos, listos para adoptar.
 *
 * ═══ POR QUÉ ESTO ANTES QUE UN EDITOR DE CAJAS ═══
 *
 * Porque los documentos que la gente manda a firmar **ya son formularios**: un
 * certificado médico, un formulario de visa, una declaración de la DGI. Todos
 * traen sus campos declarados, con su nombre y su rectángulo exacto. Hacer que
 * el emisor dibuje cajas encima de eso es trabajo repetido y encima queda peor
 * alineado que el original.
 *
 * ⚠ Esto NO escribe nada. Es una lectura del archivo que propone; adoptar o no
 * cada campo lo decide el emisor y se guarda con `definirCampos`, que es el
 * único camino de escritura. Un formulario con cuarenta campos internos no se
 * convierte en cuarenta obligaciones para el firmante sin que alguien lo mire.
 *
 * ⚠ Se saltean los campos de FIRMA. Un `/FT /Sig` del PDF original no es un
 * dato que alguien completa: es un hueco para una firma, y las firmas de este
 * producto las coloca `apariencia.ts` con su propia lógica. Adoptarlo como
 * campo de texto sería pisar el lugar donde después va la firma.
 */
/**
 * Qué letra usa un campo del formulario del cliente, leída de su `/DA`.
 *
 * `/DA` («default appearance») es una cadena del PDF con la pinta de
 * `/Helv 10 Tf 0 g`: la fuente, el cuerpo y el color con que el lector dibuja
 * ese campo. Es EXACTAMENTE la pregunta «¿qué usa este documento?», ya
 * contestada por quien armó el formulario — no hay que adivinar nada.
 *
 * ⚠ Y está ahí porque la migración 038 lo salvó: antes, al firmar, se reescribía
 * el AcroForm del cliente perdiendo `/DR`, `/DA`, `/Q` y `/XFA`. Si eso no se
 * hubiera arreglado, esta función no tendría de dónde leer.
 *
 * De la fuente NO se hace nada: ver la 056 sobre por qué el tipo de letra es
 * caro y el tamaño y el color son gratis.
 */
function letraDelDA(da: string | undefined | null, alto: number): { cuerpo: number | null; color: string | null } {
  const vacio = { cuerpo: null, color: null };
  if (!da) return vacio;

  let cuerpo: number | null = null;
  const tf = /\/[^\s/]+\s+([\d.]+)\s+Tf/.exec(da);
  if (tf) {
    const v = Number(tf[1]);
    // ⚠ `0 Tf` NO es un cuerpo cero: es «auto», y significa lo mismo que
    // nuestro null. Tomarlo como número dejaría el valor invisible.
    if (Number.isFinite(v) && v >= 4 && v <= 72) cuerpo = Math.round(v * 100) / 100;
  }

  // ⚠ Lo que el formulario declara es una PROPUESTA, no un dato. Hay que
  // contrastarla contra el recuadro donde va a caer.
  //
  // Medido el 8/8 sobre un documento YA FIRMADO: el formulario declaraba
  // `/Helvetica 65 Tf` para «Observaciones», un recuadro de 77 puntos de alto.
  // Sesenta y cinco «entra» —un renglón de 65 cabe en 77, y el texto tampoco se
  // pasaba de ancho—, así que ninguna comprobación saltó, y el valor salió del
  // tamaño de un titular adentro de un documento que ya no se puede arreglar.
  //
  // El tope no es el alto pelado sino el alto CON su interlínea: una letra de
  // cuerpo N necesita del orden de N × 1,25 para no comerse el recuadro. Si no
  // entra, la propuesta se descarta y queda «auto» — que es el ajuste que SÍ
  // mira el recuadro. Un formulario cuyo propio `/DA` no entra en su propia
  // caja está mal armado, y lo seguro es no copiarlo.
  if (cuerpo !== null && alto > 0 && cuerpo * 1.25 > alto) cuerpo = null;

  const hex = (r: number, g: number, b: number) =>
    '#' + [r, g, b].map((v) =>
      Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');

  let color: string | null = null;
  const rg = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg\b/.exec(da);
  const k = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+k\b/.exec(da);
  const g1 = /(?:^|\s)([\d.]+)\s+g\b/.exec(da);
  if (rg) color = hex(+rg[1]!, +rg[2]!, +rg[3]!);
  else if (k) {
    const [c, m, y, kk] = [+k[1]!, +k[2]!, +k[3]!, +k[4]!];
    color = hex((1 - c) * (1 - kk), (1 - m) * (1 - kk), (1 - y) * (1 - kk));
  } else if (g1) color = hex(+g1[1]!, +g1[1]!, +g1[1]!);

  // ⚠ El negro NO se propone. Es el color por omisión de casi todo formulario,
  // y proponerlo llenaría de color propio a campos que no lo necesitan —
  // perdiendo la propiedad de que «null = como siempre», que es la que hace que
  // un cambio futuro en la tinta general los alcance a todos.
  if (color === '#000000') color = null;

  return { cuerpo, color };
}

export interface CampoDetectado {
  codigo: string;
  etiqueta: string;
  tipo: DefinicionCampo['tipo'];
  opciones: string[] | null;
  pagina: number;
  x: number; y: number; ancho: number; alto: number;
  /** Lo que el PDF ya trae escrito ahí, si trae algo. */
  valor_actual: string | null;
  /** El cuerpo que ese campo usa en el PDF, si lo declara. Null = «auto». */
  cuerpo: number | null;
  /** El color que ese campo usa en el PDF, si no es negro. Null = el de siempre. */
  color: string | null;
  /** Si ese código ya está adoptado como campo del circuito. */
  ya_adoptado: boolean;
  /**
   * Los demás lugares donde el formulario repite este dato (el primero va en
   * pagina/x/y/ancho/alto). Sólo texto/párrafo; vacío para el resto. 059.
   */
  espejos: Espejo[];
}

export async function detectarCampos(
  cuentaId: string,
  identidadId: string,
  circuitoId: string,
): Promise<{ campos: CampoDetectado[]; sin_formulario: boolean }> {
  const datos = await withUsuario(cuentaId, identidadId, async (trx: any) => {
    const r = await sql<{ clave: string }>`
      select a.clave_almacenamiento as clave
        from circuito c
        join archivo a on a.id = c.archivo_base_id
       where c.id = ${circuitoId}::uuid
    `.execute(trx);
    if (!r.rows.length) throw new HttpError(404, 'Ese documento no existe o no lo podés ver.');

    const ya = await sql<{ codigo: string }>`
      select codigo from campo where circuito_id = ${circuitoId}::uuid
    `.execute(trx);

    return { clave: r.rows[0]!.clave, adoptados: new Set(ya.rows.map((x) => x.codigo)) };
  });

  const bytes = await almacen().leer(datos.clave);

  let doc;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    throw new HttpError(400, 'No pudimos abrir el documento para buscarle campos.');
  }

  let campos: any[] = [];
  try {
    campos = doc.getForm().getFields();
  } catch {
    // Un PDF sin AcroForm no es un error: es la mitad de los casos.
    return { campos: [], sin_formulario: true };
  }
  if (!campos.length) return { campos: [], sin_formulario: true };

  const paginas = doc.getPages();
  const salida: CampoDetectado[] = [];

  for (const f of campos) {
    const clase = f.constructor?.name ?? '';
    // ⚠ Las firmas y los botones no son datos que alguien completa.
    if (clase.includes('Signature') || clase.includes('Button')) continue;

    const nombre = f.getName();
    if (!nombre) continue;

    let tipo: DefinicionCampo['tipo'] = 'texto';
    let opciones: string[] | null = null;
    let valor: string | null = null;

    try {
      if (clase.includes('CheckBox')) {
        tipo = 'casilla';
        valor = f.isChecked?.() ? 'sí' : null;
      } else if (clase.includes('Dropdown') || clase.includes('OptionList')) {
        tipo = 'opcion';
        opciones = f.getOptions?.() ?? null;
        valor = (f.getSelected?.() ?? [])[0] ?? null;
      } else if (clase.includes('RadioGroup')) {
        tipo = 'opcion';
        opciones = f.getOptions?.() ?? null;
        valor = f.getSelected?.() ?? null;
      } else {
        // Texto. `isMultiline` distingue un renglón de un párrafo, y eso
        // cambia cómo se dibuja al estampar.
        tipo = f.isMultiline?.() ? 'parrafo' : 'texto';
        valor = f.getText?.() ?? null;
      }
    } catch {
      // Un campo que no se deja interrogar se ofrece igual, como texto: el
      // emisor decide, y perder el campo sería peor que perder su tipo.
    }

    // ⚠ El rectángulo sale del WIDGET, no del campo: un mismo campo puede tener
    // varios widgets —el mismo dato repetido en tres hojas— y cada uno tiene su
    // lugar. El PRIMERO es el lugar principal; los demás, para texto y párrafo,
    // son ESPEJOS: el valor se va a dibujar en todos (migración 059, deuda 26).
    //
    // ⚠ Para casilla y opción NO se ofrecen espejos: en un grupo de opciones
    // cada widget es UNA OPCIÓN DISTINTA —los círculos de elegir una—, no el
    // mismo dato repetido. Espejar ahí estamparía lo elegido arriba de todas.
    let pagina = 0, x = 0, y = 0, ancho = 0, alto = 0;
    const espejos: Espejo[] = [];
    try {
      const ws = f.acroField.getWidgets();
      const paginaDe = (w: any): number => {
        const ref = w.P?.();
        if (ref) {
          const idx = paginas.findIndex((pg: any) => pg.ref === ref);
          if (idx >= 0) return idx;
        }
        return 0;
      };
      const w = ws[0];
      if (w) {
        const r = w.getRectangle();
        x = r.x; y = r.y; ancho = r.width; alto = r.height;
        pagina = paginaDe(w);
      }
      if ((tipo === 'texto' || tipo === 'parrafo') && ws.length > 1) {
        // ⚠ El mismo tope que el check de la base y que `definirCampos`. Un PDF
        // hostil con quinientos widgets del mismo campo no se vuelve quinientas
        // marcas por firma; se corta y se dice cuánto quedó afuera.
        for (const we of ws.slice(1, 1 + MAX_ESPEJOS)) {
          const re = we.getRectangle();
          espejos.push({
            pagina: paginaDe(we),
            x: Math.round(re.x * 100) / 100,
            y: Math.round(re.y * 100) / 100,
            ancho: Math.round(Math.max(20, re.width) * 100) / 100,
            alto: Math.round(Math.max(10, re.height) * 100) / 100,
          });
        }
        if (ws.length - 1 > MAX_ESPEJOS) {
          console.warn(`[detectar] «${nombre.slice(0, 60)}» repite el dato en ${ws.length - 1} lugares; se ofrecen ${MAX_ESPEJOS}`);
        }
      }
    } catch { /* sin rectángulo: queda en 0 y el editor lo acomoda */ }

    // Qué letra usa ESTE campo en el documento. Si el campo no lo dice, lo dice
    // el formulario entero: `/DA` se hereda del AcroForm, que es donde suele
    // estar en un formulario armado con una sola tipografía.
    let da: string | null | undefined;
    try { da = f.acroField?.getDefaultAppearance?.(); } catch { da = null; }
    if (!da) {
      try { da = (doc.getForm() as any)?.acroForm?.getDefaultAppearance?.(); } catch { da = null; }
    }
    const letra = letraDelDA(da, alto);

    salida.push({
      // El código es el nombre del campo en el PDF: es lo que después permite
      // reconocerlo si el archivo se reemplaza por una versión nueva.
      // ⚠ 60, que es el tope de `codigo` en la ruta y en la tabla. Un nombre de
      // campo más largo que eso existe —los formularios generados por
      // herramientas de oficina los hacen— y cortarlo acá evita que el PUT lo
      // rechace después con un error que no dice qué campo fue.
      codigo: nombre.slice(0, 60),
      etiqueta: nombre.slice(0, 120),
      tipo,
      opciones,
      pagina,
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      ancho: Math.round(Math.max(20, ancho) * 100) / 100,
      alto: Math.round(Math.max(10, alto) * 100) / 100,
      valor_actual: valor && valor.trim() ? valor.trim().slice(0, 500) : null,
      ya_adoptado: datos.adoptados.has(nombre.slice(0, 60)),
      cuerpo: letra.cuerpo,
      color: letra.color,
      espejos,
    });
  }

  return { campos: salida, sin_formulario: salida.length === 0 };
}
