import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { db, withExterno } from '../db/pool';
import { fijarContexto } from '../db/contexto';
import { withUsuario, exigir } from '../auth/authz';
import { verificarEnlaceFirma } from '../auth/enlace_firma';
import { fueraDeWinAnsi, type Marca } from '../firma/apariencia';
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
async function leerCampos(trx: any, instanciaId: string, idioma: string, mioSi: number | null) {
  const r = await sql<any>`
    select c.id, c.codigo, c.etiqueta_i18n, c.tipo, c.opciones, c.obligatorio,
           c.validacion, c.pagina, c.x, c.y, c.ancho, c.alto, c.orden,
           c.orden_firmante, c.completa_emisor,
           v.valor, (v.congelado_en is not null) as congelado
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
    mio: mioSi !== null && f.orden_firmante === mioSi,
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
    return { campos: await leerCampos(trx, yo.instancia_id, yo.idioma ?? 'es', yo.orden) };
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
  tipo: 'texto' | 'parrafo' | 'numero' | 'fecha' | 'moneda' | 'casilla' | 'opcion';
  opciones?: string[] | null;
  completa_emisor?: boolean;
  orden_firmante?: number | null;
  obligatorio?: boolean;
  pagina: number;
  x: number; y: number; ancho: number; alto: number;
  orden?: number;
}

export async function listarCampos(cuentaId: string, identidadId: string, circuitoId: string) {
  return withUsuario(cuentaId, identidadId, async (trx: any) => {
    const r = await sql<any>`
      select c.*, (select count(*) from valor_campo v where v.campo_id = c.id) as usos
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
    const emisor = !!c.completa_emisor;
    if (emisor === (c.orden_firmante != null)) {
      throw new HttpError(400, `Decidí quién completa «${c.codigo}»: el emisor o un firmante.`);
    }
  }

  return withUsuario(cuentaId, identidadId, async (trx: any, autz: any) => {
    exigir(autz, 'circuito', 'crear', 'No tenés permiso para preparar documentos.');

    // Se reemplaza el juego entero: la pantalla manda lo que quedó después de
    // arrastrar, y reconciliar altas, bajas y movimientos fila por fila desde el
    // navegador es la clase de sincronización que se desincroniza.
    //
    // ⚠ El trigger `campo_congelado` frena esto si el circuito ya salió, así que
    // no hay forma de perder los valores de un documento en curso.
    await sql`delete from campo where circuito_id = ${circuitoId}::uuid`.execute(trx);

    for (const [i, c] of campos.entries()) {
      await sql`
        insert into campo (circuito_id, cuenta_propietaria_id, codigo, etiqueta_i18n,
                           tipo, opciones, completa_emisor, orden_firmante, obligatorio,
                           pagina, x, y, ancho, alto, orden)
        values (${circuitoId}::uuid, ${cuentaId}::uuid, ${c.codigo.trim()},
                ${JSON.stringify({ es: c.etiqueta.trim() })}::jsonb,
                ${c.tipo}, ${c.opciones ? JSON.stringify(c.opciones) : null}::jsonb,
                ${!!c.completa_emisor}, ${c.orden_firmante ?? null}, ${!!c.obligatorio},
                ${c.pagina}, ${c.x}, ${c.y}, ${c.ancho}, ${c.alto}, ${c.orden ?? i})
      `.execute(trx);
    }
    return { ok: true, campos: campos.length };
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
export async function prepararCampos(
  trx: any,
  instanciaId: string,
  orden: number,
): Promise<CamposListos> {
  const r = await sql<any>`
    select c.id, c.codigo, c.etiqueta_i18n, c.obligatorio, c.tipo,
           c.pagina, c.x, c.y, c.ancho, c.alto,
           v.valor, v.congelado_en
      from campo c
      join instancia i on i.id = ${instanciaId}::uuid and i.circuito_id = c.circuito_id
      left join valor_campo v on v.campo_id = c.id and v.instancia_id = i.id
     where c.orden_firmante = ${orden}
     order by c.pagina, c.orden
  `.execute(trx);

  const marcas: Marca[] = [];
  const congelar: CamposListos['congelar'] = [];
  const faltan: string[] = [];

  for (const f of r.rows) {
    const valor = (f.valor ?? '').trim();
    if (!valor) {
      if (f.obligatorio) faltan.push(texto(f.etiqueta_i18n));
      continue;                       // un campo opcional vacío no se dibuja
    }
    if (f.congelado_en) continue;     // ya firmado en una vuelta anterior

    // Una casilla no se dibuja como texto: se dibuja como una marca.
    const dibujo = f.tipo === 'casilla' ? (valor === 'true' ? 'X' : '') : valor;
    if (!dibujo) continue;

    marcas.push({
      pagina: f.pagina,
      rect: [Number(f.x), Number(f.y), Number(f.x) + Number(f.ancho), Number(f.y) + Number(f.alto)],
      texto: dibujo,
      modo: 'campo',
      etiqueta: f.codigo,
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
