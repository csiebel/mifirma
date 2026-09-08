import { sql } from 'kysely';
import { withExterno, sinCuenta } from '../db/pool';
import { verificarEnlaceFirma } from '../auth/enlace_firma';
import { configDeProveedor, credencialDeProveedor, endpoint } from '../proveedores/catalogo';
import {
  urlDeAutorizacion, emitirState, verificarState, canjearCodigo, leerIdentidad,
  listarIdentidadesDeFirma, firmarHash, mismoDocumento, type ConfigTuid,
} from '../proveedores/tuid/oauth';
import { firmanteTuid, type FirmanteTuid } from '../firma/adaptadores/tuid';
import { HttpError } from '../http/errors';

/**
 * FIRMAR con la clave del titular custodiada en tuID — la orquestación.
 *
 * ═══ AUTORIZAR ANTES, FIRMAR DESPUÉS ═══
 *
 * tuID exige que el titular se autentique y consienta el uso de su clave, y eso
 * pasa en el navegador. Si ocurriera EN MEDIO de la firma, habría que guardar
 * el PDF preparado a la espera de la vuelta: estado intermedio que el motor no
 * tiene y no conviene inventar. En cambio:
 *
 *   1. El firmante aprieta «Firmar con tuID» → viaje OAuth con el scope de
 *      firma (mismo `oauth.ts`, otro propósito en el sobre: 'tuid_firma').
 *   2. La vuelta canjea el código, lee quién es, lista sus identidades de
 *      firma, elige una, y deja una AUTORIZACIÓN EFÍMERA atada al otorgamiento.
 *   3. La pantalla dispara el `POST /firmar/firmar` de siempre. El motor
 *      pregunta si hay autorización vigente y, si la hay, firma con el
 *      adaptador de tuID en vez del sello. Síncrono, todo reusado.
 *
 * ═══ ES UN FLUJO HERMANO DE LA VERIFICACIÓN, NO EL MISMO ═══
 *
 * `tuid_identidad.ts` escribe un ANCLAJE: una prueba fechada de identidad que
 * el motor consulta (T8). Esto no escribe ningún anclaje: deja un permiso de
 * diez minutos para firmar UNA vez, y lo consume. Que además de firmar quede
 * una prueba de identidad de nivel alto es «el regalo» de la 069, y se decide
 * aparte —tiene una pregunta para el abogado antes.
 *
 * ═══ ⚠ LA AUTORIZACIÓN VIVE EN MEMORIA ═══
 *
 * Un `Map` con vencimiento, en el proceso. Deliberado y anotado como deuda:
 * la ventana real entre «volví de tuID» y «apreté Firmar» son segundos, y el
 * token de tuID que se guarda ahí permite firmar CUALQUIER hash con la clave
 * del titular —no es un dato para dejar en una tabla más tiempo del necesario.
 * Lo que se pierde: un reinicio del servidor en esos segundos, y más de una
 * instancia. Railway corre una.
 */

const CODIGO_PROVEEDOR = 'tuid';
const VIGENCIA_MS = 10 * 60 * 1000;

interface Autorizacion {
  otorgamientoId: string;
  participacionId: string;
  baseRecursos: string;
  accessToken: string;
  signIdentityId: string;
  certificadoDer: Buffer;
  etiquetas: string[];
  /** Quién se autenticó en tuID, para el expediente. */
  documento: { pais: string; tipo: string; numero: string } | null;
  nombre?: string;
  nivelDeclarado?: string;
  expira: number;
}

const autorizaciones = new Map<string, Autorizacion>();

function limpiarVencidas() {
  const ahora = Date.now();
  for (const [k, a] of autorizaciones) if (a.expira <= ahora) autorizaciones.delete(k);
}

async function configConSecreto(trx: Parameters<typeof configDeProveedor>[0]): Promise<ConfigTuid & { proveedorId: string }> {
  const cfg = await configDeProveedor(trx, CODIGO_PROVEEDOR);
  const clientId = cfg.parametros.client_id;
  if (typeof clientId !== 'string' || !clientId) {
    throw new HttpError(503, 'Falta el client_id de tuID. Cargalo desde la consola del operador.');
  }
  const base = cfg.endpoints.auth ? endpoint(cfg, 'auth') : endpoint(cfg, 'host');
  const acr = cfg.parametros.acr_values;
  return {
    proveedorId: cfg.id,
    baseAuth: base,
    baseRecursos: cfg.endpoints.api ? endpoint(cfg, 'api') : base,
    clientId,
    clientSecret: await credencialDeProveedor(trx, cfg.id),
    redirectUri: redirectUri(),
    acrValues: typeof acr === 'string' && acr.trim() ? acr.trim() : undefined,
  };
}

/** ⚠ Idéntica a la de `tuid_identidad.ts` y `auth_idp.ts` a propósito (deuda 95). */
function redirectUri(): string {
  const base = (process.env.APP_BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  return `${base}/identidad/tuid/vuelta`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Ida
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `sesion` es la sesión de Mi Firma que venga en la misma request (la cookie
 * `sess_emp` tiene Path=/ y llega también a /firmar), o `null` si no hay.
 *
 * Regla de Claudio (8/9): tuID tiene que volver a identificar a la persona
 * SALVO que haya entrado a Mi Firma con tuID. Un firmante externo sin cuenta,
 * uno que entró con contraseña, o una sesión de OTRA persona que la del
 * enlace → `prompt=login`. Sólo cuando la sesión es de la misma identidad del
 * enlace y se abrió con este proveedor se deja que tuID reuse su SSO.
 */
export async function iniciarAutorizacionFirma(
  tokenEnlace: string,
  volverA?: string,
  sesion: { identidadId: string; via?: string } | null = null,
): Promise<{ url: string }> {
  const enlace = await verificarEnlaceFirma(tokenEnlace);
  const cfg = await withExterno(enlace.otorgamientoId, enlace.identidadId, (trx) => configConSecreto(trx));
  const state = await emitirState(
    { otorgamientoId: enlace.otorgamientoId, participacionId: enlace.participacionId, volverA },
    'tuid_firma',
  );
  const entroConTuid =
    sesion !== null && sesion.identidadId === enlace.identidadId && sesion.via === `idp:${CODIGO_PROVEEDOR}`;
  return { url: urlDeAutorizacion(cfg, state, 'firma', { reautenticar: !entroConTuid }) };
}

// ═══════════════════════════════════════════════════════════════════════════
// Vuelta
// ═══════════════════════════════════════════════════════════════════════════

export interface ResultadoAutorizacion {
  ok: true;
  volverA?: string;
  titular: string;
}

export async function completarAutorizacionFirma(codigo: string, state: string): Promise<ResultadoAutorizacion> {
  const viaje = await verificarState(state, 'tuid_firma');
  const identidadId = await identidadDelOtorgamiento(viaje.otorgamientoId);

  return withExterno(viaje.otorgamientoId, identidadId, async (trx) => {
    const cfg = await configConSecreto(trx);
    const token = await canjearCodigo(cfg, codigo);
    const id = await leerIdentidad(cfg, token);

    // ── T6, aplicada a la firma: si el emisor exigió una cédula, es ésa ──
    const p = await sql<{
      documento_exigido_num: string | null;
      documento_exigido_pais: string | null;
      documento_exigido_tipo: string | null;
    }>`
      select documento_exigido_num, documento_exigido_pais, documento_exigido_tipo
        from participacion where id = ${viaje.participacionId}::uuid
    `.execute(trx);
    const part = p.rows[0];
    if (!part) throw new HttpError(404, 'No encontramos esa participación.');
    if (part.documento_exigido_num) {
      const coincide =
        !!id.documento &&
        mismoDocumento(part.documento_exigido_num, id.documento.numero) &&
        (!part.documento_exigido_pais || part.documento_exigido_pais.toUpperCase() === id.documento.pais.toUpperCase()) &&
        (!part.documento_exigido_tipo || part.documento_exigido_tipo.toUpperCase() === id.documento.tipo.toUpperCase());
      if (!coincide) {
        throw new HttpError(
          403,
          'El certificado con el que intentás firmar no es del destinatario de este documento. ' +
            'Si creés que es un error, pedile al emisor que revise a quién se lo envió.',
        );
      }
    }

    // ── La identidad de firma: la primera habilitada para servidor ──
    const identidades = await listarIdentidadesDeFirma(cfg, token);
    const usable = identidades.find((i) => i.estado === 'enabled' && i.etiquetas.includes('server'))
      ?? identidades.find((i) => i.estado === 'enabled');
    if (!usable) {
      // El error más probable de toda la cadena, documentado por tuID como
      // «usuario sin certificado intenta firmar». Se dice en castellano.
      throw new HttpError(
        409,
        identidades.length
          ? 'Tu cuenta de tuID tiene certificados pero ninguno habilitado para firmar desde el servidor.'
          : 'Tu cuenta de tuID no tiene un certificado para firmar. Podés firmar igual con firma simple.',
      );
    }

    limpiarVencidas();
    autorizaciones.set(viaje.otorgamientoId, {
      otorgamientoId: viaje.otorgamientoId,
      participacionId: viaje.participacionId,
      baseRecursos: cfg.baseRecursos,
      accessToken: token.accessToken,
      signIdentityId: usable.id,
      certificadoDer: usable.certificadoDer,
      etiquetas: usable.etiquetas,
      documento: id.documento,
      nombre: id.nombre,
      nivelDeclarado: id.nivelDeclarado,
      expira: Date.now() + VIGENCIA_MS,
    });

    const f = firmanteTuid({ certificadoDer: usable.certificadoDer, firmarHash: async () => Buffer.alloc(0) });
    return { ok: true as const, volverA: viaje.volverA, titular: f.titular };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Lo que consume el motor
// ═══════════════════════════════════════════════════════════════════════════

export interface FirmanteAutorizado {
  firmante: FirmanteTuid;
  /** Para el expediente. Nada de acá es secreto. */
  detalle: {
    identidad_firma_id: string;
    etiquetas: string[];
    documento: Autorizacion['documento'];
    nivel_declarado?: string;
  };
}

/** ¿Hay autorización de tuID vigente para este otorgamiento? Sin consumirla. */
export function hayAutorizacionVigente(otorgamientoId: string): boolean {
  limpiarVencidas();
  return autorizaciones.has(otorgamientoId);
}

/**
 * El firmante de tuID para este otorgamiento, o `null` si no hay autorización
 * vigente. La autorización se CONSUME: sirve para una firma.
 *
 * ⚠ La clausura `firmarHash` es lo único que sabe del token. El adaptador no
 * lo ve, no lo guarda y no lo puede registrar.
 */
export function tomarFirmanteAutorizado(otorgamientoId: string): FirmanteAutorizado | null {
  limpiarVencidas();
  const a = autorizaciones.get(otorgamientoId);
  if (!a) return null;
  autorizaciones.delete(otorgamientoId);

  const cfgFirma = { baseRecursos: a.baseRecursos } as ConfigTuid;
  const token = { accessToken: a.accessToken, expiraEn: 0 };
  const firmante = firmanteTuid({
    certificadoDer: a.certificadoDer,
    firmarHash: (digest) => firmarHash(cfgFirma, token, a.signIdentityId, digest),
  });
  return {
    firmante,
    detalle: {
      identidad_firma_id: a.signIdentityId,
      etiquetas: a.etiquetas,
      documento: a.documento,
      nivel_declarado: a.nivelDeclarado,
    },
  };
}

async function identidadDelOtorgamiento(otorgamientoId: string): Promise<string> {
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
