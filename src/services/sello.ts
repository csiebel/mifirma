import { sql, type Transaction } from 'kysely';
import type { DB } from '../db/schema';
import { withOperador } from '../db/pool';
import { HttpError } from '../http/errors';
import { cifrar, huellaClave } from '../operador/cripto';
import { credencialDeProveedor } from '../proveedores/catalogo';
import {
  leerCertificadoP12,
  selloDePlataforma,
  selloDesdeP12,
  type DatosCertificado,
} from '../firma/adaptadores/sello_plataforma';
import type { Firmante } from '../firma/adaptadores/tipos';

/**
 * El certificado del sitio: con qué sella MiFirma la firma SIMPLE.
 *
 * ═══ QUÉ RESUELVE ═══
 *
 * Hasta el 10/9 el P12 vivía en una variable de entorno de Railway y cambiarlo
 * era un redeploy. Ahora se carga desde la consola del operador y se guarda
 * cifrado en la base, como cualquier credencial de proveedor (067): la fila
 * `sello_plataforma` para todo el sitio y `sello_plataforma_uy/_py/_br` por
 * país (077). `app.sello_para(pais)` dice cuál aplica; acá se descifra, se
 * abre y se convierte en el `Firmante` que `firmar()` le pasa a `sellar()`.
 *
 * ⚠ La variable de entorno sigue siendo el RESPALDO: si ningún certificado
 * cargado aplica, se usa `SELLO_P12`. Así producción no se rompe entre que
 * esto se despliega y Claudio carga el primero.
 *
 * ═══ ⚠ EL CACHE, Y POR QUÉ SE INVALIDA SOLO ═══
 *
 * Abrir un P12 con node-forge en cada firma sería caro. Se guarda el último
 * sello por ámbito, con clave (proveedor, fecha de carga): si el operador
 * recarga el certificado, `credencial_puesta_en` cambia, la clave cambia, y la
 * próxima firma abre el nuevo. Sin reinicio y sin «apagá y prendé».
 *
 * Con varias instancias del servidor cada una tiene su cache; todas leen la
 * misma fila, así que a lo sumo difieren una firma. No hace falta más.
 */

const AMBITOS = ['global', 'UY', 'PY', 'BR'] as const;
type Ambito = (typeof AMBITOS)[number];

function codigoDe(ambito: string): string {
  return ambito === 'global' ? 'sello_plataforma' : `sello_plataforma_${ambito.toLowerCase()}`;
}

const cache = new Map<string, { clave: string; sello: Firmante }>();

/**
 * El sello con el que se firma un documento cuyo marco legal es `pais`.
 *
 * Se llama DENTRO de la transacción de la firma (quien firma es una cuenta o
 * un externo; `app.sello_para` y `app.credencial_de_proveedor` son security
 * definer y tienen grant para app_rw).
 */
export async function selloParaPais(trx: Transaction<DB>, pais: string): Promise<Firmante> {
  // Sin país (un circuito viejo sin marco) sólo puede aplicar el global.
  if (!pais) pais = 'ZZ';
  const r = await sql<{
    proveedor_id: string; codigo: string; ambito: string; credencial_puesta_en: string;
  }>`
    select proveedor_id, codigo, ambito, credencial_puesta_en::text as credencial_puesta_en
      from app.sello_para(${pais})
  `.execute(trx);
  const fila = r.rows[0];
  if (!fila) return selloDePlataforma(); // el del entorno

  const clave = `${fila.proveedor_id}:${fila.credencial_puesta_en}`;
  const enCache = cache.get(fila.ambito);
  if (enCache && enCache.clave === clave) return enCache.sello;

  // Lo que la consola guardó: el P12 en base64 y su contraseña, como un solo
  // secreto. Se usa y se descarta (regla de `credencialDeProveedor`).
  //
  // ⚠⚠ SI ESTE SERVIDOR NO PUEDE USARLO, SE FIRMA CON EL DEL ENTORNO Y SE AVISA.
  //
  // Hay UNA base y DOS claves de cifrado (la Mac y Railway: deuda 91). Un
  // certificado cargado desde la consola de un lado no se descifra del otro.
  // Sin esto, cargar el certificado en producción rompería TODA firma simple
  // en la Mac (y al revés), con un 503 en el momento de firmar. Una firma no
  // se pierde porque el certificado cargado no sea legible acá: se usa el
  // respaldo, y queda en el log —y en la pantalla, que compara huellas— que
  // este servidor está firmando con otro certificado que el cargado.
  try {
    const secreto = await credencialDeProveedor(trx, fila.proveedor_id);
    const cred = JSON.parse(secreto) as { p12_b64?: string; password?: string };
    if (!cred.p12_b64) throw new HttpError(503, 'sin archivo P12 adentro');
    const sello = selloDesdeP12(Buffer.from(cred.p12_b64, 'base64'), cred.password ?? '', fila.codigo);
    cache.set(fila.ambito, { clave, sello });
    return sello;
  } catch (e) {
    const motivo = e instanceof Error ? e.message : String(e);
    console.warn(`[sello] el certificado cargado (${fila.codigo}) no se puede usar en este servidor: ${motivo}. Se firma con el del entorno.`);
    return selloDePlataforma();
  }
}

/** Lo que la consola muestra: los cuatro ámbitos y qué usa cada país hoy. */
export async function estadoDelCertificado(operadorId: string) {
  return withOperador(operadorId, async (trx) => {
    const filas = await sql<{
      codigo: string; activo_global: boolean; parametros: any;
      credencial_puesta_en: string | null; credencial_puesta_por: string | null;
    }>`
      select codigo, activo_global, parametros,
             credencial_puesta_en::text as credencial_puesta_en, credencial_puesta_por
        from proveedor_firma
       where parametros->>'rol' = 'sello'
       order by orden_preferencia
    `.execute(trx);

    const porAmbito = AMBITOS.map((ambito) => {
      const f = filas.rows.find((x) => x.codigo === codigoDe(ambito));
      const p = f?.parametros ?? {};
      return {
        ambito,
        codigo: codigoDe(ambito),
        existe: !!f,
        cargado: !!f?.credencial_puesta_en,
        cargado_en: f?.credencial_puesta_en ?? null,
        cargado_por: f?.credencial_puesta_por ?? null,
        // Lo que el P12 dijo de sí mismo al cargarlo. No es el secreto.
        titular: p.titular ?? null,
        emisor: p.emisor ?? null,
        vigente_desde: p.vigente_desde ?? null,
        vigente_hasta: p.vigente_hasta ?? null,
        vencido: p.vigente_hasta ? new Date(p.vigente_hasta) < new Date() : false,
        // ⚠ Con qué clave se cifró, contra la de ESTE servidor. `credencial_puesta_por`
        // guarda «quién (huella)» desde la 067; si la huella no es la de acá,
        // este servidor no lo puede descifrar y firma con el del entorno. Es la
        // deuda 91 (una base, dos claves) dicha en la pantalla en vez de en un
        // 503 durante una firma.
        usable_aca: !f?.credencial_puesta_por || f.credencial_puesta_por.includes(`(${huellaClave()})`),
      };
    });

    // Qué se usa HOY en cada país, según la misma función que consulta la firma.
    const usa: Record<string, string> = {};
    for (const pais of ['UY', 'PY', 'BR']) {
      const r = await sql<{ codigo: string }>`select codigo from app.sello_para(${pais})`.execute(trx);
      usa[pais] = r.rows[0]?.codigo ?? 'entorno';
    }

    return {
      ambitos: porAmbito,
      usa,
      // Si no hay nada cargado, esto es lo que firma. Se dice para que el
      // operador sepa que el respaldo existe y de dónde sale.
      entorno_configurado: !!(process.env.SELLO_P12 || process.env.SELLO_P12_RUTA),
      huella_clave: huellaClave(),
    };
  });
}

/**
 * Cargar el certificado de un ámbito desde la consola.
 *
 * El P12 se abre ANTES de guardarlo: una contraseña equivocada o un archivo
 * que no es un P12 fallan acá, con un 400 que lo dice, y no en la primera firma
 * de un cliente con un 503. Lo que el certificado dice de sí mismo (titular,
 * emisor, vigencia) se guarda en `parametros` para que la pantalla lo muestre
 * sin tocar el secreto.
 */
export async function cargarCertificadoDelSitio(
  operadorId: string,
  ambito: string,
  p12Base64: string,
  password: string,
): Promise<DatosCertificado & { codigo: string }> {
  if (!(AMBITOS as readonly string[]).includes(ambito)) {
    throw new HttpError(400, `Ámbito desconocido: ${ambito}. Es «global», «UY», «PY» o «BR».`);
  }
  let p12: Buffer;
  try {
    p12 = Buffer.from(p12Base64, 'base64');
  } catch {
    throw new HttpError(400, 'El archivo no llegó bien (no es base64).');
  }
  if (p12.length < 100) throw new HttpError(400, 'El archivo está vacío o es demasiado chico para ser un P12.');
  if (p12.length > 64 * 1024) throw new HttpError(400, 'El archivo es demasiado grande para ser un P12 (más de 64 KB).');

  const datos = leerCertificadoP12(p12, password);
  if (new Date(datos.vigente_hasta) < new Date()) {
    throw new HttpError(400, `Ese certificado venció el ${datos.vigente_hasta.slice(0, 10)}: no sirve para sellar.`);
  }

  const codigo = codigoDe(ambito);
  const cif = cifrar(JSON.stringify({ p12_b64: p12Base64, password }));

  return withOperador(operadorId, async (trx) => {
    // ⚠ La credencial va como PARÁMETRO y nunca como `excluded.`: la columna
    // no tiene lectura para nadie (067, y la lección del 6/9). `parametros` sí
    // la tiene, así que el `||` sobre ella está bien.
    const r = await sql<{ id: string }>`
      update proveedor_firma
         set credenciales_cif      = ${cif},
             credencial_puesta_en  = now(),
             credencial_puesta_por = ${`${operadorId} (${huellaClave()})`},
             parametros = parametros || ${JSON.stringify({
               titular: datos.titular,
               emisor: datos.emisor,
               vigente_desde: datos.vigente_desde,
               vigente_hasta: datos.vigente_hasta,
             })}::jsonb,
             actualizado_en = now()
       where codigo = ${codigo} and parametros->>'rol' = 'sello'
       returning id
    `.execute(trx);
    if (!r.rows[0]) {
      throw new HttpError(500, `No existe la fila «${codigo}» del catálogo: falta la migración 077.`);
    }
    // El cache de este proceso se invalida solo por la fecha de carga; se
    // limpia igual para que la próxima firma no dependa de un reloj.
    cache.delete(ambito);
    return { ...datos, codigo };
  });
}
