import { sql, type Transaction } from 'kysely';
import type { DB } from '../db/schema';
import { descifrar } from '../operador/cripto';
import { HttpError } from '../http/errors';

/**
 * El catálogo de proveedores, leído.
 *
 * ═══ EL ÚNICO LUGAR QUE SABE DÓNDE ESTÁ LA CONFIGURACIÓN ═══
 *
 * Los adaptadores (`proveedores/tuid/oauth.ts` y los que vengan) no importan
 * `db/`: reciben la configuración ya resuelta. Este módulo es la frontera. Si un
 * adaptador empieza a leer la base por su cuenta, el día que haya un segundo
 * proveedor uruguayo cada uno va a resolver el ambiente a su manera.
 *
 * ═══ POR QUÉ EL SECRETO SALE POR UNA FUNCIÓN ═══
 *
 * `credenciales_cif` no tiene GRANT de select para nadie (migración 067). Un
 * `select *` sobre `proveedor_firma` FALLA, a propósito: es lo que impide que el
 * secreto se vuelque a un log o aparezca en una pantalla «para verificar». El
 * único camino es `app.credencial_de_proveedor()`, y pedirla explícitamente deja
 * en el código quién la está pidiendo.
 *
 * ⚠ Eso protege del descuido, no del atacante: quien tenga la conexión de la
 * aplicación puede llamar a la función. Descifrar sigue necesitando
 * GATEWAY_ENC_KEY, que no está en la base.
 */

export interface ProveedorConfig {
  id: string;
  codigo: string;
  nombreMostrado: string;
  entorno: string;
  /** Las URLs del ambiente ACTIVO, ya resueltas. Sin el resto de los ambientes. */
  endpoints: Record<string, string>;
  /** Configuración no secreta del adaptador: client_id, scopes, tiempos. */
  parametros: Record<string, unknown>;
}

/**
 * La configuración del proveedor para el ambiente que el operador dejó activo.
 *
 * ⚠ No devuelve la credencial. Eso es aparte y a propósito: la mayoría de los
 * usos —pintar una pantalla, decidir si ofrecerlo— no necesitan el secreto, y
 * traerlo «por las dudas» es cómo termina en un log.
 */
export async function configDeProveedor(
  trx: Transaction<DB>,
  codigo: string,
): Promise<ProveedorConfig> {
  const r = await sql<{
    id: string; codigo: string; nombre_mostrado: string; entorno: string;
    endpoints: unknown; parametros: unknown; activo_global: boolean;
  }>`
    select id, codigo, nombre_mostrado, entorno, endpoints, parametros, activo_global
      from proveedor_firma
     where codigo = ${codigo}
  `.execute(trx);

  const p = r.rows[0];
  if (!p) {
    // 503 y no 404: el proveedor no está mal pedido, está sin configurar. Es un
    // problema del operador, y el mensaje tiene que decírselo a quien lo pueda
    // arreglar sin culpar al firmante.
    throw new HttpError(503, `El proveedor «${codigo}» no está configurado.`);
  }
  if (!p.activo_global) {
    throw new HttpError(503, `El proveedor «${p.nombre_mostrado}» está deshabilitado.`);
  }

  const todos = (p.endpoints ?? {}) as Record<string, Record<string, string>>;
  const delAmbiente = todos[p.entorno];
  if (!delAmbiente || Object.keys(delAmbiente).length === 0) {
    // ⚠ El error más probable de toda esta cadena, y por eso tiene mensaje
    // propio: el operador cambia `entorno` a 'produccion' y se olvida de cargar
    // las URLs de producción. Sin este chequeo, el adaptador arma una URL contra
    // `undefined` y el firmante ve un error de red que no explica nada.
    throw new HttpError(
      503,
      `El proveedor «${p.nombre_mostrado}» está en ambiente «${p.entorno}» y no tiene URLs cargadas para ese ambiente.`,
    );
  }

  return {
    id: p.id,
    codigo: p.codigo,
    nombreMostrado: p.nombre_mostrado,
    entorno: p.entorno,
    endpoints: delAmbiente,
    parametros: (p.parametros ?? {}) as Record<string, unknown>,
  };
}

/**
 * La credencial, descifrada.
 *
 * ⚠ Lo que devuelve esta función NO se registra, no se devuelve por HTTP y no se
 * guarda en ninguna variable que sobreviva a la llamada. Se usa y se descarta.
 */
export async function credencialDeProveedor(
  trx: Transaction<DB>,
  proveedorId: string,
): Promise<string> {
  const r = await sql<{ cif: string | null }>`
    select app.credencial_de_proveedor(${proveedorId}::uuid) as cif
  `.execute(trx);

  const cif = r.rows[0]?.cif;
  if (!cif) {
    throw new HttpError(503, 'El proveedor no tiene credenciales cargadas. Cargalas desde la consola del operador.');
  }
  try {
    return descifrar(cif);
  } catch {
    // ⚠ Sin detalle. Un error de descifrado sólo puede significar dos cosas —la
    // clave cambió o el dato está corrupto— y las dos se diagnostican mirando la
    // huella de la clave, no el mensaje. Decir más es contarle a un atacante si
    // el formato era válido.
    throw new HttpError(503, 'No se pudo descifrar la credencial del proveedor.');
  }
}

/** Una URL del ambiente activo, o un error que dice cuál falta. */
export function endpoint(cfg: ProveedorConfig, nombre: string): string {
  const u = cfg.endpoints[nombre];
  if (!u) {
    throw new HttpError(
      503,
      `Falta la URL «${nombre}» del proveedor «${cfg.nombreMostrado}» en el ambiente «${cfg.entorno}».`,
    );
  }
  return u.replace(/\/+$/, '');
}
