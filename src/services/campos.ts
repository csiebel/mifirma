import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { sql } from 'kysely';
import { db, withExterno } from '../db/pool';
import { fijarContexto } from '../db/contexto';
import { withUsuario, exigir } from '../auth/authz';
import { verificarEnlaceFirma } from '../auth/enlace_firma';
import { fueraDeWinAnsi, type Marca } from '../firma/apariencia';
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
  /** Null = lo completa el emisor. */
  orden_firmante: number | null;
  valor: string | null;
  congelado: boolean;
  /** Si el que mira es quien tiene que completarlo. */
  mio: boolean;
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
           c.orden_firmante, c.completa_emisor, c.quien_completa,
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
    orden_firmante: f.orden_firmante,
    valor: f.valor ?? null,
    congelado: !!f.congelado,
    // ⚠ «Mío» tiene tres formas, no una.
    //
    //  · el campo que se le pidió a esta persona por su orden;
    //  · un campo de CUALQUIERA que nadie completó todavía;
    //  · uno de cualquiera que completó ella misma y todavía puede corregir.
    //
    // Lo que NO es mío: uno de cualquiera que ya escribió otro. Se ve con su
    // valor, apagado — es el documento como va a quedar, y reescribirlo sería
    // cambiar lo que el otro ya leyó.
    mio: f.quien_completa === 'cualquiera'
      ? (mioSi !== null && !f.congelado &&
         (f.completado_por == null || f.completado_por === quienSoy))
      : (mioSi !== null && f.orden_firmante === mioSi),
  }));
}

// ---------------------------------------------------------------------------
// El firmante, desde la pantalla de firma
// ---------------------------------------------------------------------------

export async function camposParaFirmar(token: string) {
  const e = await verificarEnlaceFirma(token);
  return withExterno(e.otorgamientoId, e.identidadId, async (trx) => {
    const p = await sql<{ instancia_id: string; orden: number; idioma: string | null }>`
      select p.instancia_id, p.orden, p.idioma_efectivo as idioma
        from participacion p
       where p.instancia_id in (select instancia_id from otorgamiento where id = ${e.otorgamientoId}::uuid)
         and p.identidad_id = ${e.identidadId}::uuid
       limit 1
    `.execute(trx);
    const yo = p.rows[0];
    if (!yo) return { campos: [] as CampoParaMostrar[] };
    return { campos: await leerCampos(trx, yo.instancia_id, yo.idioma ?? 'es', yo.orden, e.identidadId) };
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

export interface DefinicionCampo {
  codigo: string;
  etiqueta: string;
  tipo: 'texto' | 'parrafo' | 'numero' | 'fecha' | 'moneda' | 'casilla' | 'opcion' | 'etiqueta';
  opciones?: string[] | null;
  completa_emisor?: boolean;
  /** 'emisor' | 'firmante' | 'cualquiera'. Ver migración 052. */
  quien_completa?: 'emisor' | 'firmante' | 'cualquiera';
  orden_firmante?: number | null;
  obligatorio?: boolean;
  pagina: number;
  x: number; y: number; ancho: number; alto: number;
  orden?: number;
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
      c.orden_firmante = null;
      c.obligatorio = false;
    }

    // ⚠ El modo manda, y las dos columnas viejas se derivan de él. Al revés
    // —deducir el modo de las columnas— «orden_firmante null y no del emisor»
    // sería ambiguo entre «cualquiera» y «falta decidirlo».
    const modo = c.quien_completa
      ?? (c.completa_emisor ? 'emisor' : (c.orden_firmante != null ? 'firmante' : 'cualquiera'));
    if (!['emisor', 'firmante', 'cualquiera'].includes(modo)) {
      throw new HttpError(400, `No entiendo quién completa «${c.codigo}».`);
    }
    c.quien_completa = modo as any;
    c.completa_emisor = modo === 'emisor';
    if (modo !== 'firmante') c.orden_firmante = null;
    else if (c.orden_firmante == null) {
      throw new HttpError(400, `Decidí a qué firmante se le pide «${c.codigo}».`);
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
                           tipo, opciones, completa_emisor, quien_completa, orden_firmante,
                           obligatorio, pagina, x, y, ancho, alto, orden)
        values (${circuitoId}::uuid, ${cuentaId}::uuid, ${c.codigo.trim()},
                ${JSON.stringify({ es: c.etiqueta.trim() })}::jsonb,
                ${c.tipo}, ${c.opciones ? JSON.stringify(c.opciones) : null}::jsonb,
                ${!!c.completa_emisor}, ${c.quien_completa ?? 'firmante'},
                ${c.orden_firmante ?? null}, ${!!c.obligatorio},
                ${c.pagina}, ${c.x}, ${c.y}, ${c.ancho}, ${c.alto}, ${c.orden ?? i})
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

export async function prepararCampos(
  trx: any,
  instanciaId: string,
  orden: number,
): Promise<CamposListos> {
  const r = await sql<any>`
    select c.id, c.codigo, c.etiqueta_i18n, c.obligatorio, c.tipo, c.completa_emisor,
           c.quien_completa,
           c.pagina, c.x, c.y, c.ancho, c.alto,
           v.valor, v.congelado_en
      from campo c
      join instancia i on i.id = ${instanciaId}::uuid and i.circuito_id = c.circuito_id
      left join valor_campo v on v.campo_id = c.id and v.instancia_id = i.id
     -- ⚠ Los del firmante que firma Y LOS DEL EMISOR.
     --
     -- Faltaban los del emisor y el efecto era silencioso: se podía escribir el
     -- valor, se guardaba bien, y no aparecía en el documento. La consulta sólo
     -- miraba orden_firmante = N, y un campo del emisor lo tiene en null.
     --
     -- No hace falta saber quién firma primero: los del emisor se dibujan y se
     -- congelan con la primera firma que ocurra, y a partir de ahí el
     -- congelado_en de abajo los saltea. El segundo firmante no los redibuja.
     -- Los del firmante que firma, los del emisor, y los de cualquiera que
     -- alguien haya completado. Estos últimos los dibuja el primero que firme
     -- después de que se escribieron, y el congelado de abajo evita repetirlos.
     where c.orden_firmante = ${orden} or c.completa_emisor
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
      // El sufijo por orden de firmante además evita que dos firmantes que
      // completan el mismo código en vueltas distintas choquen entre sí.
      etiqueta: `${f.codigo}__mf${orden}`,
    });
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
export interface CampoDetectado {
  codigo: string;
  etiqueta: string;
  tipo: DefinicionCampo['tipo'];
  opciones: string[] | null;
  pagina: number;
  x: number; y: number; ancho: number; alto: number;
  /** Lo que el PDF ya trae escrito ahí, si trae algo. */
  valor_actual: string | null;
  /** Si ese código ya está adoptado como campo del circuito. */
  ya_adoptado: boolean;
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
    // lugar. Se toma el primero; los demás se ven cuando el editor de cajas
    // exista y se puedan mover de a uno.
    let pagina = 0, x = 0, y = 0, ancho = 0, alto = 0;
    try {
      const w = f.acroField.getWidgets()[0];
      if (w) {
        const r = w.getRectangle();
        x = r.x; y = r.y; ancho = r.width; alto = r.height;
        const ref = w.P?.();
        if (ref) {
          const idx = paginas.findIndex((pg: any) => pg.ref === ref);
          if (idx >= 0) pagina = idx;
        }
      }
    } catch { /* sin rectángulo: queda en 0 y el editor lo acomoda */ }

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
    });
  }

  return { campos: salida, sin_formulario: salida.length === 0 };
}
