import { sql } from 'kysely';
import { withExterno } from '../db/pool';
import { verificarEnlaceFirma } from '../auth/enlace_firma';
import { configDeProveedor, credencialDeProveedor, endpoint } from '../proveedores/catalogo';
import {
  urlDeAutorizacion, emitirState, verificarState, canjearCodigo, leerIdentidad,
  mismoDocumento, NIVEL_ALTO, type ConfigTuid,
} from '../proveedores/tuid/oauth';
import { HttpError } from '../http/errors';

/**
 * Verificación de identidad del firmante externo con tuID.
 *
 * ═══ QUÉ HACE Y QUÉ NO ═══
 *
 * Al volver de tuID, esto escribe UNA FILA en `anclaje_identidad` y nada más.
 * No emite sesión, no eleva el enlace, no cambia el nivel de nada.
 *
 * Es la decisión T8 del 5/9, y va contra el reflejo natural —«verifiqué, dame
 * más permisos»— por tres motivos:
 *
 *   · El enlace del firmante vive 90 días y viaja por correo. Una afirmación
 *     como «esta persona probó su cédula» metida ahí adentro sigue diciendo lo
 *     mismo tres meses después, aunque el certificado ya no exista. Una fila
 *     tiene `revocado_en` y `vigente_hasta`; un token no tiene cómo dejar de ser
 *     cierto.
 *   · El chequeo tiene que estar donde está la consecuencia. Esto no sirve para
 *     ENTRAR, sirve para FIRMAR — y el motor de firma consulta el anclaje en la
 *     misma transacción en que firma.
 *   · La prueba queda. Sirve la próxima vez, entra al expediente, y es lo que
 *     sostiene «este firmante es quien dice ser» cuando alguien lo discuta
 *     dentro de dos años.
 *
 * `pool.ts` ya lo decía antes de que existiera este archivo: «abrir el enlace no
 * prueba identidad; el nivel sube sólo si firma con certificado, y esa elevación
 * la hace el motor de firma, no el acceso».
 */

const CODIGO_PROVEEDOR = 'tuid';

async function configConSecreto(trx: Parameters<typeof configDeProveedor>[0], redirectUri: string): Promise<ConfigTuid> {
  const cfg = await configDeProveedor(trx, CODIGO_PROVEEDOR);
  const clientId = cfg.parametros.client_id;
  if (typeof clientId !== 'string' || !clientId) {
    throw new HttpError(503, 'Falta el client_id de tuID. Cargalo desde la consola del operador.');
  }
  // La colección de Postman usa un solo {{host}}; el PDF sugiere hosts por
  // servicio. Se aceptan las dos formas: si no hay `auth`, se usa `host`.
  const base = cfg.endpoints.auth ? endpoint(cfg, 'auth') : endpoint(cfg, 'host');
  return {
    baseAuth: base,
    baseRecursos: cfg.endpoints.api ? endpoint(cfg, 'api') : base,
    clientId,
    clientSecret: await credencialDeProveedor(trx, cfg.id),
    redirectUri,
  };
}

function redirectUri(): string {
  const base = (process.env.APP_BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  // ⚠ Tiene que coincidir CARÁCTER POR CARÁCTER con lo registrado en tuID. Una
  // barra de más y el canje del código falla con un error que no dice por qué.
  return `${base}/identidad/tuid/vuelta`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Ida
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Arranca la verificación. Devuelve a dónde mandar el navegador del firmante.
 *
 * ⚠ Recibe el token del enlace de firma y lo VERIFICA antes de nada. Sin esto,
 * cualquiera podría arrancar un viaje de verificación contra un otorgamiento
 * ajeno y hacer que el anclaje de su propia cédula quedara colgado de la
 * identidad de otra persona.
 */
export async function iniciarVerificacion(tokenEnlace: string, volverA?: string): Promise<{ url: string }> {
  const enlace = await verificarEnlaceFirma(tokenEnlace);

  const cfg = await withExterno(enlace.otorgamientoId, enlace.identidadId, (trx) =>
    configConSecreto(trx, redirectUri()),
  );

  const state = await emitirState({
    otorgamientoId: enlace.otorgamientoId,
    participacionId: enlace.participacionId,
    volverA,
  });

  return { url: urlDeAutorizacion(cfg, state) };
}

// ═══════════════════════════════════════════════════════════════════════════
// Vuelta
// ═══════════════════════════════════════════════════════════════════════════

export interface ResultadoVerificacion {
  ok: true;
  anclajeId: string;
  documento: { pais: string; tipo: string; numero: string };
  nombre?: string;
  volverA?: string;
}

/**
 * Vuelve de tuID con el código. Canjea, lee la identidad, compara el documento
 * contra el que el emisor exigió, y ancla.
 */
export async function completarVerificacion(codigo: string, state: string): Promise<ResultadoVerificacion> {
  // 1. El `state` primero: es lo que ata este regreso con un viaje que empezamos
  //    nosotros. Antes de gastar una llamada a tuID.
  const viaje = await verificarState(state);

  return withExterno(viaje.otorgamientoId, await identidadDelOtorgamiento(viaje.otorgamientoId), async (trx) => {
    const cfg = await configConSecreto(trx, redirectUri());

    // 2. Código → token → identidad.
    const token = await canjearCodigo(cfg, codigo);
    const id = await leerIdentidad(cfg, token);

    // 3. ⚠ El nivel se vuelve a verificar. Lo pedimos alto en la ida; si tuID
    //    autenticó con otro, anclar como «alto» sería escribir en el expediente
    //    una afirmación que no ocurrió.
    if (id.nivelDeclarado && id.nivelDeclarado !== NIVEL_ALTO) {
      throw new HttpError(
        409,
        'La verificación se completó con un nivel de seguridad menor al requerido. Volvé a intentarla.',
      );
    }

    // 4. Sin documento no hay nada que anclar. No es un detalle que se pueda
    //    dejar pasar: un anclaje de nivel alto sin documento es una afirmación
    //    vacía con apariencia de prueba.
    if (!id.documento) {
      throw new HttpError(502, 'tuID no devolvió el documento de identidad. No se puede verificar sin él.');
    }

    // 5. La participación, para saber qué documento exigió el emisor.
    //
    // ⚠ Son TRES columnas, no una: `documento_exigido_pais`, `_tipo` y `_num`.
    // El emisor puede exigir «cédula uruguaya 1.234.567-8», y comparar sólo el
    // número dejaría pasar un pasaporte con los mismos dígitos.
    const p = await sql<{
      identidad_id: string;
      documento_exigido_num: string | null;
      documento_exigido_pais: string | null;
      documento_exigido_tipo: string | null;
    }>`
      select p.identidad_id, p.documento_exigido_num,
             p.documento_exigido_pais, p.documento_exigido_tipo
        from participacion p
       where p.id = ${viaje.participacionId}::uuid
    `.execute(trx);

    const part = p.rows[0];
    if (!part) throw new HttpError(404, 'No encontramos esa participación.');

    // 6. ⚠ DECISIÓN T6 (a): si no coinciden, se RECHAZA.
    //
    //    Dejar firmar y anotar la discrepancia parecía más amable y es peor: si
    //    el emisor se tomó el trabajo de exigir un documento, permitir que firme
    //    otro vacía el requisito, y en un litigio una discrepancia registrada es
    //    más difícil de defender que un rechazo.
    //
    //    El país y el tipo se comparan sólo si el emisor los especificó: exigir
    //    «1.234.567-8» sin decir de qué país es una exigencia sobre el número, y
    //    endurecerla por nuestra cuenta rechazaría a la persona correcta.
    //
    //    El mensaje NO dice cuál era el documento esperado: se lo estaríamos
    //    contando a quien todavía no probamos que sea la persona correcta.
    if (part.documento_exigido_num) {
      const coincide =
        mismoDocumento(part.documento_exigido_num, id.documento.numero) &&
        (!part.documento_exigido_pais ||
          part.documento_exigido_pais.toUpperCase() === id.documento.pais.toUpperCase()) &&
        (!part.documento_exigido_tipo ||
          part.documento_exigido_tipo.toUpperCase() === id.documento.tipo.toUpperCase());

      if (!coincide) {
        throw new HttpError(
          403,
          'El documento de identidad verificado no coincide con el del destinatario de este documento. ' +
            'Si creés que es un error, pedile al emisor que revise a quién se lo envió.',
        );
      }
    }

    // 7. El anclaje. `idp_sujeto` es la llave estable de tuID: sirve para
    //    reconocer a la misma persona la próxima vez, aunque cambie de correo.
    const ins = await sql<{ id: string }>`
      insert into anclaje_identidad
        (identidad_id, tipo, valor_normalizado, metodo_prueba, nivel_garantia,
         idp, idp_sujeto, documento_tipo, documento_numero_norm, pais, emisor)
      values
        (${part.identidad_id}::uuid, 'documento',
         ${normalizarDoc(id.documento.numero)}, 'oidc', 'alto',
         ${CODIGO_PROVEEDOR}, ${id.sub},
         ${id.documento.tipo}, ${normalizarDoc(id.documento.numero)},
         ${id.documento.pais}, ${cfg.baseAuth})
      returning id
    `.execute(trx);

    const anclajeId = ins.rows[0]?.id;
    if (!anclajeId) throw new HttpError(500, 'No se pudo registrar la verificación.');

    return {
      ok: true as const,
      anclajeId,
      documento: id.documento,
      nombre: id.nombre,
      volverA: viaje.volverA,
    };
  });
}

/**
 * De qué identidad es este otorgamiento.
 *
 * ⚠ Se lee de la base y NO del `state`. El `state` lo firmamos nosotros, así que
 * es confiable — pero la identidad es el dato que decide a nombre de quién queda
 * el anclaje, y ése conviene leerlo de la fuente en vez de transportarlo.
 */
async function identidadDelOtorgamiento(otorgamientoId: string): Promise<string> {
  const { sinCuenta } = await import('../db/pool');
  const r = await sinCuenta((trx) =>
    sql<{ identidad_id: string }>`
      select identidad_id from otorgamiento
       where id = ${otorgamientoId}::uuid and revocado_en is null
    `.execute(trx),
  );
  const id = r.rows[0]?.identidad_id;
  if (!id) throw new HttpError(401, 'Este enlace ya no es válido.');
  return id;
}

/** Sin puntos, guiones ni espacios, en mayúsculas. Igual que `mismoDocumento`. */
function normalizarDoc(n: string): string {
  return n.replace(/[.\s-]/g, '').toUpperCase();
}
