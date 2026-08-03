import { sql } from 'kysely';
import { withOperador, sinCuenta } from '../db/pool';
import { HttpError } from '../http/errors';

/**
 * El catálogo de países: moneda de cobro, idioma y marco legal.
 *
 * ═══ LA REGLA ═══
 *
 *   La moneda de cobro es el DÓLAR, salvo que el catálogo diga otra cosa.
 *
 * Uruguay, Paraguay y Brasil dicen otra cosa. Un país sin fila cobra en USD y
 * funciona sin que nadie configure nada — que es lo que hace posible «diseñar
 * global, lanzar angosto» sin una migración por país.
 *
 * ⚠ Esto vivía escrito a mano en cuatro lugares, y dos de ellos eran archivos
 * del navegador. Ver la migración 032.
 *
 * ═══ QUÉ NO DECIDE ESTA TABLA ═══
 *
 * En qué países se ofrece el producto. Eso ya lo decide tener precios cargados
 * (`precio_metrica`): un plan sin precio para un país no aparece ahí. Dos
 * mecanismos para la misma pregunta terminan siempre en un país que aparece en
 * un lado y no en el otro.
 */

export interface Pais {
  codigo: string;
  nombre_i18n: Record<string, string>;
  bandera: string | null;
  idioma: string;
  orden: number;
  moneda: string;
  admite_usd: boolean;
  tc_fuente: string | null;
  marco_legal: string | null;
  certificador: string | null;
  fuente: string;
  verificado_por: string | null;
  verificado_en: string | null;
}

const SELECCION = sql`
  codigo, nombre_i18n, bandera, idioma, orden, moneda, admite_usd, tc_fuente,
  marco_legal, certificador, fuente, verificado_por, verificado_en::text as verificado_en
`;

/** Todos los países configurados. Lo lee la consola del operador. */
export async function listarPaises(): Promise<{ paises: Pais[] }> {
  const r = await sinCuenta((trx) =>
    sql<Pais>`select ${SELECCION} from pais order by orden, codigo`.execute(trx),
  );
  return { paises: r.rows };
}

/**
 * Un país, o el default global si no está configurado.
 *
 * ⚠ Devuelve una fila SIEMPRE. Un país desconocido no es un error: es un país
 * que cobra en dólares. Que esta función tire 404 obligaría a cada llamador a
 * repetir el default, y el default repetido es el default que se desincroniza.
 */
export async function verPais(codigo: string): Promise<Pais> {
  const cod = (codigo || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(cod)) throw new HttpError(400, 'El país va en dos letras (ISO 3166).');

  const r = await sinCuenta((trx) =>
    sql<Pais>`select ${SELECCION} from pais where codigo = ${cod}`.execute(trx),
  );
  return (
    r.rows[0] ?? {
      codigo: cod,
      nombre_i18n: {},
      bandera: null,
      idioma: 'es',
      orden: 100,
      moneda: 'USD',
      admite_usd: false,
      tc_fuente: null,
      marco_legal: null,
      certificador: null,
      fuente: 'default de la plataforma: sin configurar, se cobra en dólares',
      verificado_por: null,
      verificado_en: null,
    }
  );
}

/**
 * La moneda de cobro y el idioma de un país, resueltos por la base.
 *
 * Se pregunta con `app.moneda_de_cobro()` y no con un `select ... from pais`
 * suelto para que sea LA MISMA función que usa el trigger. Dos implementaciones
 * de la misma regla se separan sin que nadie lo note, y la que se separa es
 * siempre la de la aplicación.
 */
export async function monedaDeCobro(pais: string): Promise<string> {
  const cod = (pais || '').toUpperCase();
  const r = await sinCuenta((trx) =>
    sql<{ moneda: string }>`select app.moneda_de_cobro(${cod}) as moneda`.execute(trx),
  );
  return r.rows[0]?.moneda ?? 'USD';
}

/** El idioma por defecto de un país. Sin fila, español. */
export async function idiomaDePais(pais: string): Promise<string> {
  const cod = (pais || '').toUpperCase();
  const r = await sinCuenta((trx) =>
    sql<{ idioma: string }>`select idioma from pais where codigo = ${cod}`.execute(trx),
  );
  return r.rows[0]?.idioma ?? 'es';
}

/** Alta o edición. La clave es el código, así que es un upsert. */
export async function guardarPais(
  operadorId: string,
  d: {
    codigo: string;
    nombre_i18n?: Record<string, string>;
    bandera?: string | null;
    idioma?: string;
    orden?: number;
    moneda?: string;
    admite_usd?: boolean;
    tc_fuente?: string | null;
    marco_legal?: string | null;
    certificador?: string | null;
    fuente?: string;
    verificado_por?: string | null;
    verificado_en?: string | null;
  },
) {
  const codigo = (d.codigo || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(codigo)) throw new HttpError(400, 'El país va en dos letras (ISO 3166-1 alfa-2).');

  const moneda = (d.moneda || 'USD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(moneda)) throw new HttpError(400, 'La moneda va en tres letras (ISO 4217).');

  const admiteUsd = d.admite_usd ?? false;
  if (admiteUsd && moneda === 'USD') {
    throw new HttpError(
      400,
      'Ese país ya cobra en dólares: marcar «admite USD» ahí no dice nada. La casilla es para ' +
        'países con moneda local donde además se puede facturar en dólares.',
    );
  }

  const nombre = d.nombre_i18n && Object.keys(d.nombre_i18n).length ? d.nombre_i18n : { es: codigo };

  return withOperador(operadorId, async (trx) => {
    // ⚠ Cambiar la moneda de un país con precios cargados en la vieja los
    // dejaría en una moneda que el país ya no cobra —y el trigger de la 032 los
    // rechazaría en la próxima edición, que es el peor momento para enterarse.
    const enUso = await sql<{ n: string; moneda: string }>`
      select count(*)::text as n, moneda
        from precio_metrica
       where pais = ${codigo} and vigente_hasta is null and moneda <> 'USD' and moneda <> ${moneda}
       group by moneda
    `.execute(trx);

    if (enUso.rows.length) {
      const f = enUso.rows[0]!;
      throw new HttpError(
        409,
        `Hay ${f.n} precio(s) vigente(s) de ${codigo} cargados en ${f.moneda}. ` +
          `Dalos de baja antes de pasar el país a ${moneda}: un precio en una moneda que el país ` +
          'ya no cobra no se puede facturar.',
      );
    }

    await sql`
      insert into pais (codigo, nombre_i18n, bandera, idioma, orden, moneda, admite_usd,
                        tc_fuente, marco_legal, certificador, fuente, verificado_por, verificado_en)
      values (${codigo}, ${JSON.stringify(nombre)}::jsonb, ${d.bandera ?? null},
              ${d.idioma || 'es'}, ${d.orden ?? 100}, ${moneda}, ${admiteUsd},
              ${d.tc_fuente ?? null}, ${d.marco_legal ?? null}, ${d.certificador ?? null},
              ${d.fuente || 'SIN VERIFICAR'}, ${d.verificado_por ?? null},
              ${d.verificado_en ?? null}::date)
      on conflict (codigo) do update set
        nombre_i18n    = excluded.nombre_i18n,
        bandera        = excluded.bandera,
        idioma         = excluded.idioma,
        orden          = excluded.orden,
        moneda         = excluded.moneda,
        admite_usd     = excluded.admite_usd,
        tc_fuente      = excluded.tc_fuente,
        marco_legal    = excluded.marco_legal,
        certificador   = excluded.certificador,
        fuente         = excluded.fuente,
        verificado_por = excluded.verificado_por,
        verificado_en  = excluded.verificado_en,
        actualizado_en = now()
    `.execute(trx);

    return { ok: true, codigo };
  });
}

/**
 * Sacar un país del catálogo.
 *
 * No lo cierra ni lo desactiva: lo borra, y el país vuelve al default —cobrar
 * en dólares—. Por eso no se puede si hay cuentas o precios que dependen de su
 * moneda local: quedarían en una moneda que ya nadie declara.
 */
export async function borrarPais(operadorId: string, codigo: string) {
  const cod = (codigo || '').toUpperCase();

  return withOperador(operadorId, async (trx) => {
    const uso = await sql<{ cuentas: string; precios: string }>`
      select (select count(*) from cuenta where pais = ${cod} and moneda <> 'USD')::text as cuentas,
             (select count(*) from precio_metrica
               where pais = ${cod} and vigente_hasta is null and moneda <> 'USD')::text as precios
    `.execute(trx);

    const u = uso.rows[0]!;
    if (Number(u.cuentas) || Number(u.precios)) {
      throw new HttpError(
        409,
        `No se puede sacar ${cod} del catálogo: hay ${u.cuentas} cuenta(s) y ${u.precios} precio(s) ` +
          'en su moneda local. Sin el país, la plataforma pasaría a cobrarles en dólares.',
      );
    }

    await sql`delete from pais where codigo = ${cod}`.execute(trx);
    return { ok: true };
  });
}
