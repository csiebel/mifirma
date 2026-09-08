import { SignJWT, jwtVerify } from 'jose';
import { HttpError } from '../../http/errors';

/**
 * Adaptador de protocolo de TuID (TrustedX de Safelayer).
 *
 * ═══ QUÉ ES ESTE ARCHIVO Y QUÉ NO ═══
 *
 * Acá vive el PROTOCOLO: qué camino va después del host, qué cabeceras, en qué
 * orden. Eso es código y se versiona con el repositorio.
 *
 * Acá NO vive ningún dato de configuración. Ni el host, ni el client_id, ni el
 * ambiente. Todo eso lo administra el operador en `proveedor_firma` (migración
 * 067) y llega por parámetro. Si algún día aparece una URL escrita en este
 * archivo, el principio se rompió: «el operador enciende, apaga, ordena y da
 * credenciales; no programa».
 *
 * Por eso este módulo no importa nada de `db/`: no puede leer el catálogo por su
 * cuenta ni aunque quisiera. Quien lo llama le pasa la configuración ya resuelta.
 *
 * ═══ DE DÓNDE SALE ESTO ═══
 *
 * De la colección de Postman «APIs de Autenticación y Firma - PREP», no del PDF.
 * Los tres caminos están verificados contra los pedidos reales:
 *
 *   GET  /trustedx-authserver/oauth/as-principal          → el usuario se autentica
 *   POST /trustedx-authserver/oauth/as-principal/token    → código → access token
 *   GET  /trustedx-resources/openid/v1/users/me           → quién es
 *
 * ⚠ La colección usa UN SOLO {{host}} para todo. El PDF sugería hosts distintos
 * por servicio (`eidas.`, `tsa.`, `api.`). Mientras no se confirme contra el
 * ambiente real, esto acepta las dos formas: `endpoints.auth` para el servidor de
 * autorización y, si no está, cae a `endpoints.host`.
 */

/** Lo que el operador cargó en `proveedor_firma`, ya resuelto para el ambiente activo. */
export interface ConfigTuid {
  /** Base del servidor de autorización, sin barra final. Del catálogo. */
  baseAuth: string;
  /** Base de los recursos OpenID. Suele ser la misma. Del catálogo. */
  baseRecursos: string;
  clientId: string;
  /** Descifrado por quien llama, con GATEWAY_ENC_KEY. Nunca se registra. */
  clientSecret: string;
  /** Registrado en TuID: tiene que coincidir exactamente, carácter por carácter. */
  redirectUri: string;
  /**
   * Nivel de autenticación que se le EXIGE a TuID (`acr_values`), como URN
   * completa de TrustedX — o undefined para no exigir ninguno y que TuID ofrezca
   * todos sus métodos (usuario y contraseña incluidos). Lo decide el operador
   * en `proveedor_firma.parametros.acr_values` (6/9): es configuración, no código.
   */
  acrValues?: string;
}

/**
 * ⚠ EL NIVEL EXIGIDO LO CONFIGURA EL OPERADOR; EL ESCRITO ES EL QUE TUID DECLARA (6/9)
 *
 * TrustedX define cuatro niveles de autenticación (low, medium, high, very_high).
 * Hasta el 6/9 la ida pedía `high` fijo en este archivo; Claudio pidió que ese
 * parámetro lo pueda cambiar el operador — y que sin él TuID ofrezca todos sus
 * métodos, usuario y contraseña incluidos. Va en `parametros.acr_values` del
 * catálogo y llega en `ConfigTuid.acrValues`.
 *
 * Lo que NO cambia es la regla de fondo: el nivel que se escribe en el
 * expediente es el que tuID DECLARA en la respuesta (`acr`), traducido con
 * `nivelDesdeAcr()` — nunca uno que decidamos nosotros.
 */
export const NIVEL_ALTO = 'urn:safelayer:tws:policies:authentication:level:high';

/**
 * De lo que TuID declara a lo que admite `anclaje_identidad.nivel_garantia`
 * ('bajo' | 'sustancial' | 'alto'). Sin `acr` declarado devuelve null: quien
 * llama decide qué hacer con la ausencia — no este módulo.
 */
export function nivelDesdeAcr(acr: string | undefined): 'bajo' | 'sustancial' | 'alto' | null {
  if (!acr) return null;
  const nivel = acr.split(':').pop();
  if (nivel === 'high' || nivel === 'very_high') return 'alto';
  if (nivel === 'medium' || nivel === 'substantial') return 'sustancial';
  if (nivel === 'low') return 'bajo';
  return null;
}

/** Alcances de la colección. `full_profile` es el que trae el documento de identidad. */
const SCOPES_IDENTIDAD = 'profile identity_profile full_profile';

/**
 * Alcances para FIRMAR con la clave del titular, de la colección de Postman
 * («GetCode Signing») y del propio recurso: cada identidad de firma declara en
 * `links["Signatures.create.server.raw"].auth.oauth2.scopes` qué scope exige,
 * y el ejemplo del PDF (§5.3.1.4.6) dice `urn:eidas:sign:identity:use:server`.
 *
 * ⚠ El texto del PDF (§5.2.1.4) dice `urn:safelayer:eidas:sign:identity:use:server`
 * «por defecto». Son dos URN distintas. Se usa la que declara el recurso y la
 * que usa la colección, que son las medidas; si tuID rechazara el scope, el
 * primer sospechoso es esta línea.
 *
 * `urn:safelayer:eidas:sign:identity:profile` es para LISTAR las identidades
 * de firma (§5.3.3.3.2); `profile` para saber quién es el usuario.
 */
// ⚠ Lleva TAMBIÉN los de identidad (`identity_profile full_profile`): para
// firmar hace falta saber de quién es la clave, porque si el emisor exigió
// una cédula, la firma tiene que ser de ESA cédula (T6 aplicada a la firma).
// ⚠ SIN `openid` (8/9): se probó agregarlo para que tuID respetara `prompt=login`
// y contestó `invalid_scope` — no está habilitado para esta aplicación en el
// servidor de autorización de firma. `prompt=login` llega y tuID lo ignora igual:
// pregunta pendiente para Antel.
const SCOPES_FIRMA = 'profile identity_profile full_profile urn:eidas:sign:identity:use:server urn:safelayer:eidas:sign:identity:profile';

// ═══════════════════════════════════════════════════════════════════════════
// El `state`, que la colección de Postman no trae
//
// ⚠ Postman puede darse el lujo de no mandar `state` porque el que aprieta el
// botón es el que mira la respuesta. Un servidor no: sin `state`, cualquiera
// puede hacer que el navegador de un firmante vuelva a nuestro callback con un
// código ajeno, y terminamos anclando a la víctima la identidad del atacante.
//
// El `state` es un JWT corto y firmado que ata el viaje de ida con el de vuelta:
// lleva a QUÉ otorgamiento pertenece este viaje y cuándo vence. Cinco minutos,
// porque es el tiempo de autenticarse, no de trabajar.
// ═══════════════════════════════════════════════════════════════════════════

const TTL_STATE = '5m';

export interface ViajeTuid {
  /** El otorgamiento del firmante que arrancó el viaje. */
  otorgamientoId: string;
  participacionId: string;
  /** A dónde volver dentro del producto una vez anclado. */
  volverA?: string;
}

function secretoState(): Uint8Array {
  const s = process.env.AUTH_DEV_SECRET || process.env.OPERADOR_JWT_SECRET;
  if (!s) throw new HttpError(503, 'Falta AUTH_DEV_SECRET para firmar el estado de TuID.');
  return new TextEncoder().encode(s);
}

/**
 * Los dos propósitos de un viaje a tuID que arranca desde el enlace de firma.
 *
 *   · 'tuid'       → VERIFICAR la identidad: la vuelta escribe un anclaje (T8).
 *   · 'tuid_firma' → AUTORIZAR LA FIRMA con la clave del titular: la vuelta
 *                    deja una autorización efímera que el motor consume al firmar.
 *
 * Son sobres distintos y cada vuelta exige el suyo: uno de verificación no
 * sirve para firmar, ni al revés. (El del login federado es otro más, 'idp',
 * y vive en services/auth_idp.ts.)
 */
export type PropositoTuid = 'tuid' | 'tuid_firma';

export async function emitirState(v: ViajeTuid, proposito: PropositoTuid = 'tuid'): Promise<string> {
  return new SignJWT({ oid: v.otorgamientoId, pid: v.participacionId, volver: v.volverA ?? null, proposito })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(TTL_STATE)
    .sign(secretoState());
}

export async function verificarState(state: string, proposito: PropositoTuid = 'tuid'): Promise<ViajeTuid> {
  let payload;
  try {
    ({ payload } = await jwtVerify(state, secretoState()));
  } catch {
    // Mensaje amable: el caso corriente no es un ataque, es alguien que dejó la
    // pantalla abierta y volvió veinte minutos después.
    throw new HttpError(401, 'La verificación de identidad expiró. Volvé a intentarla.');
  }
  // El propósito va adentro y se verifica: sin esto, un enlace de firma serviría
  // como `state`, que es la misma trampa que evita `enlace_firma.ts`. Y un sobre
  // de verificación no sirve para autorizar una firma, ni al revés.
  if (payload.proposito !== proposito) throw new HttpError(401, 'Estado inválido.');
  const oid = payload.oid, pid = payload.pid;
  if (typeof oid !== 'string' || typeof pid !== 'string') throw new HttpError(401, 'Estado incompleto.');
  return {
    otorgamientoId: oid,
    participacionId: pid,
    volverA: typeof payload.volver === 'string' ? payload.volver : undefined,
  };
}

/**
 * Qué propósito trae un `state`, o `null` si no es nuestro.
 *
 * Es lo que usa la vuelta compartida (`routes/tuid.ts`) para repartir entre la
 * verificación y la autorización de firma sin probar un verificador tras otro.
 * Verifica la firma del sobre: un `state` ajeno o alterado devuelve `null`, no
 * un propósito.
 */
export async function propositoDelState(state: string): Promise<PropositoTuid | null> {
  try {
    const { payload } = await jwtVerify(state, secretoState());
    return payload.proposito === 'tuid' || payload.proposito === 'tuid_firma' ? payload.proposito : null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Paso 1 — a dónde mandamos al firmante
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `para` decide qué se le pide a tuID: 'identidad' (verificar quién es) o
 * 'firma' (además, permiso para usar su clave). Pedir el de firma para
 * verificar sería pedir de más; pedir sólo identidad para firmar no alcanza.
 */
export function urlDeAutorizacion(
  cfg: ConfigTuid,
  state: string,
  para: 'identidad' | 'firma' = 'identidad',
  opciones: { reautenticar?: boolean } = {},
): string {
  const u = new URL(`${cfg.baseAuth.replace(/\/+$/, '')}/trustedx-authserver/oauth/as-principal`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('scope', para === 'firma' ? SCOPES_FIRMA : SCOPES_IDENTIDAD);
  u.searchParams.set('redirect_uri', cfg.redirectUri);
  u.searchParams.set('state', state);
  // El nivel exigido lo pone el operador; sin él, TuID ofrece todos sus métodos.
  if (cfg.acrValues) u.searchParams.set('acr_values', cfg.acrValues);
  // `prompt=login` desactiva el SSO de tuID (manual v1.14, parámetro `prompt`):
  // aunque el navegador tenga sesión abierta en tuID, vuelve a pedir que la
  // persona se identifique. Sin él, tuID reusa su sesión y va derecho al PIN.
  if (opciones.reautenticar) u.searchParams.set('prompt', 'login');
  if (!opciones.reautenticar) return u.toString();
  // ⚠ 8/9: tuID (preproducción) IGNORA `prompt=login` y reusa su sesión (probado
  // dos veces en producción, con y sin `openid` — este último da invalid_scope).
  // Hasta que Antel lo corrija, se pasa por su cierre de sesión (manual v1.14
  // §11.2.4): TuID cierra la sesión de ese navegador y redirige a `redirect_uri`,
  // que acá es la propia autorización. Queda `prompt=login` igual, para el día
  // que lo respeten.
  const salida = new URL(`${cfg.baseAuth.replace(/\/+$/, '')}/trustedx-authserver/TuID-idp/logout`);
  salida.searchParams.set('redirect_uri', u.toString());
  return salida.toString();
}

// ═══════════════════════════════════════════════════════════════════════════
// Paso 2 — el código se cambia por un token
// ═══════════════════════════════════════════════════════════════════════════

export interface TokenTuid {
  accessToken: string;
  expiraEn: number;
}

export async function canjearCodigo(cfg: ConfigTuid, codigo: string): Promise<TokenTuid> {
  const cuerpo = new URLSearchParams({
    grant_type: 'authorization_code',
    code: codigo,
    redirect_uri: cfg.redirectUri,
  });

  // Autenticación del cliente por HTTP Basic, como en la colección.
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');

  const r = await fetch(`${cfg.baseAuth.replace(/\/+$/, '')}/trustedx-authserver/oauth/as-principal/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body: cuerpo,
    signal: AbortSignal.timeout(15_000),
  });

  if (!r.ok) {
    // ⚠ El cuerpo del error de TrustedX puede repetir el pedido, y el pedido
    // lleva el código. No se registra entero: sólo los dos campos estándar de
    // OAuth (`error`, `error_description`), que dicen la causa —invalid_client,
    // invalid_grant— y no llevan el código. (6/9: un 401 mudo costó una hora.)
    let motivo = '';
    try {
      const e = (await r.json()) as { error?: unknown; error_description?: unknown };
      const partes = [e.error, e.error_description].filter((x): x is string => typeof x === 'string' && x.length < 200);
      motivo = partes.length ? ` — ${partes.join(': ')}` : '';
    } catch { /* cuerpo no JSON: se calla */ }
    throw new HttpError(502, `TuID rechazó el canje del código (HTTP ${r.status})${motivo}.`);
  }

  const j = (await r.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new HttpError(502, 'TuID no devolvió un token de acceso.');
  return { accessToken: j.access_token, expiraEn: j.expires_in ?? 0 };
}

// ═══════════════════════════════════════════════════════════════════════════
// Paso 3 — quién es
// ═══════════════════════════════════════════════════════════════════════════

export interface IdentidadTuid {
  /** Identificador del usuario en TuID. Estable: es la llave para reconocerlo. */
  sub: string;
  /** Tipo y número del documento, ya separados. `null` si TuID no lo devolvió. */
  documento: { pais: string; tipo: string; numero: string } | null;
  nombre?: string;
  email?: string;
  telefono?: string;
  /** Nivel con el que efectivamente se autenticó, según TuID. */
  nivelDeclarado?: string;
  /** Todo lo que vino, para el expediente de evidencias. */
  crudo: Record<string, unknown>;
}

export async function leerIdentidad(cfg: ConfigTuid, token: TokenTuid): Promise<IdentidadTuid> {
  const r = await fetch(`${cfg.baseRecursos.replace(/\/+$/, '')}/trustedx-resources/openid/v1/users/me`, {
    headers: { Authorization: `Bearer ${token.accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new HttpError(502, `TuID no devolvió la identidad (HTTP ${r.status}).`);

  const j = (await r.json()) as Record<string, unknown>;
  const sub = typeof j.sub === 'string' ? j.sub : typeof j.uuid === 'string' ? j.uuid : null;
  if (!sub) throw new HttpError(502, 'TuID no devolvió un identificador de usuario.');

  return {
    sub,
    documento: extraerDocumento(j),
    nombre: str(j.name) ?? str(j.given_name),
    email: str(j.email),
    telefono: str(j.phone_number),
    nivelDeclarado: str(j.acr),
    crudo: j,
  };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * El documento, que es lo único que de verdad vinimos a buscar.
 *
 * ⚠ TrustedX lo devuelve como una cadena tipo `UY_CI_11111111`: país, tipo y
 * número pegados con guiones bajos. Eso hay que partirlo, y hay que hacerlo con
 * cuidado porque el número es lo que después se compara contra el documento que
 * el emisor exigió — y esa comparación, si falla, RECHAZA la firma (decisión T6
 * del 5/9). Un error de parseo acá no da un dato feo: le impide firmar a la
 * persona correcta, o peor, se lo permite a la incorrecta.
 *
 * Se busca en varias llaves porque el nombre del campo depende de los scopes
 * concedidos, y todavía no está verificado contra una respuesta real.
 *
 * ⚠ PENDIENTE DE VERIFICAR contra el ambiente. Mientras `documento` vuelva null,
 * quien llama TIENE que rechazar el anclaje en vez de seguir sin documento: sin
 * documento no hay nada que comparar, y el nivel alto sería una afirmación vacía.
 */
export function extraerDocumento(j: Record<string, unknown>): IdentidadTuid['documento'] {
  const candidatos = [j.uuid, j.document_id, j.national_id, j.identity_document, j.sub];
  for (const c of candidatos) {
    if (typeof c !== 'string') continue;
    const m = /^([A-Z]{2})_([A-Z]+)_([A-Za-z0-9-]+)$/.exec(c.trim());
    if (m) return { pais: m[1], tipo: m[2], numero: m[3] };
  }
  return null;
}

/**
 * Los dos números de documento son el mismo.
 *
 * Compara sin puntos, guiones ni espacios, y sin distinguir mayúsculas: el
 * emisor escribe «1.234.567-8» a mano y TuID devuelve «12345678». Comparar las
 * cadenas crudas rechazaría a la persona correcta, que es el peor resultado
 * posible de esta función.
 *
 * ⚠ No valida el dígito verificador ni normaliza ceros a la izquierda: «01234567»
 * y «1234567» se consideran DISTINTOS. Es deliberado — asumir que un cero de
 * más es un error de tipeo es exactamente el tipo de suposición que no se puede
 * hacer cuando el resultado decide si alguien firma.
 */
export function mismoDocumento(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const limpiar = (s: string) => s.replace(/[.\s-]/g, '').toUpperCase();
  return limpiar(a) === limpiar(b);
}

// ═══════════════════════════════════════════════════════════════════════════
// Paso 4 — la identidad de FIRMA del titular
//
// De la colección («Obtain User Signing Identities») y del PDF §5.3. Una
// identidad de firma es «una clave custodiada por tuID más su certificado»:
// es lo que firma en nombre del titular. Con `labels=server` se piden sólo las
// que tuID puede usar desde el servidor, que es lo único que sirve acá.
// ═══════════════════════════════════════════════════════════════════════════

export interface IdentidadDeFirma {
  id: string;
  /** El certificado del titular, DER. Es lo que va dentro del CMS. */
  certificadoDer: Buffer;
  /** Lo que tuID dice de esta identidad: 'enabled' es la única que sirve. */
  estado: string;
  /** Las etiquetas de tuID («server», «cualificado», «x509:keyUsage:…»). Van al expediente tal cual. */
  etiquetas: string[];
}

export async function listarIdentidadesDeFirma(cfg: ConfigTuid, token: TokenTuid): Promise<IdentidadDeFirma[]> {
  const base = cfg.baseRecursos.replace(/\/+$/, '');
  const cab = { headers: { Authorization: `Bearer ${token.accessToken}` }, signal: AbortSignal.timeout(15_000) };

  // ⚠ Dos puertas, porque el 7/9 la primera dijo «no tenés certificado» a una
  // cuenta que sí lo tiene. La que documenta el PDF v1.14 (§5.3.1) es la de
  // GRUPOS, con las identidades adentro de cada grupo; la de `esigp/v1/
  // sign_identities` salió de la colección de Postman y no trae ejemplo de
  // respuesta. Se prueba la documentada primero y la otra después, y se
  // aceptan las tres formas razonables: grupos con identidades, lista
  // envuelta y arreglo pelado.
  const puertas = [
    `${base}/trustedx-resources/rap/v2/sign_identities_groups?expand=sign_identities_groups.sign_identities&labels=server`,
    `${base}/trustedx-resources/esigp/v1/sign_identities?labels=server`,
  ];
  const vistas: string[] = [];
  for (const url of puertas) {
    const r = await fetch(url, cab);
    if (!r.ok) {
      vistas.push(`${url.split('/trustedx-resources/')[1]?.split('?')[0]} → HTTP ${r.status}`);
      continue;
    }
    const j = (await r.json()) as unknown;
    const lista = aplanarIdentidades(j);
    const salida = normalizarIdentidades(lista);
    if (salida.length) return salida;
    // Vacío: se anota QUÉ vino, para no volver a adivinar. Nada de esto es
    // secreto —son claves de un JSON y cantidades—; el certificado, si viniera,
    // es público por definición.
    vistas.push(`${url.split('/trustedx-resources/')[1]?.split('?')[0]} → ${formaDe(j, lista)}`);
  }
  console.warn(`[tuid] identidades de firma: ninguna usable. ${vistas.join(' · ')}`);
  return [];
}

/** Saca las identidades de cualquiera de las envolturas conocidas. */
function aplanarIdentidades(j: unknown): unknown[] {
  if (Array.isArray(j)) return j;
  if (!j || typeof j !== 'object') return [];
  const o = j as Record<string, unknown>;
  if (Array.isArray(o.sign_identities)) return o.sign_identities;
  if (Array.isArray(o.sign_identities_groups)) {
    const out: unknown[] = [];
    for (const g of o.sign_identities_groups) {
      const gi = (g ?? {}) as Record<string, unknown>;
      if (Array.isArray(gi.sign_identities)) out.push(...gi.sign_identities);
    }
    return out;
  }
  return [];
}

function normalizarIdentidades(lista: unknown[]): IdentidadDeFirma[] {
  const salida: IdentidadDeFirma[] = [];
  for (const x of lista) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const id = str(o.id);
    const det = (o.details ?? {}) as Record<string, unknown>;
    const cert = str(det.certificate) || str(o.certificate);
    if (!id || !cert) continue;
    const st = o.status;
    const estado = typeof st === 'string' ? st : ((st ?? {}) as Record<string, unknown>).value;
    salida.push({
      id,
      // Puede venir con saltos de línea (así lo imprime el PDF): se limpian.
      certificadoDer: Buffer.from(cert.replace(/\s+/g, ''), 'base64'),
      estado: typeof estado === 'string' ? estado : 'desconocido',
      etiquetas: Array.isArray(o.labels) ? (o.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [],
    });
  }
  return salida;
}

/** Una descripción corta de la forma de una respuesta, para el log. */
function formaDe(j: unknown, lista: unknown[]): string {
  if (Array.isArray(j)) return `arreglo de ${j.length}`;
  if (!j || typeof j !== 'object') return `un ${typeof j}`;
  const claves = Object.keys(j as object).join(',');
  const primero = lista[0];
  const clavesPrimero = primero && typeof primero === 'object' ? Object.keys(primero as object).join(',') : '—';
  return `objeto {${claves}} con ${lista.length} identidad(es); la primera tiene {${clavesPrimero}}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Paso 5 — la firma, sobre un hash
//
// PDF §5.2.1: `POST /esigp/v1/signatures/server/raw` con `digest_value` (el
// hash en base64), `signature_algorithm` y `sign_identity_id`. Devuelve «el
// valor binario de la firma»: la firma CRUDA (PKCS#1 v1.5), no un CMS. El CMS
// —los atributos firmados, el certificado, el envoltorio— lo arma el adaptador
// (`firma/adaptadores/tuid.ts`). Esto es lo que hace que EL DOCUMENTO NUNCA
// SALGA DEL SERVIDOR: lo único que viaja a tuID son 32 bytes.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Firma un hash SHA-256 con la identidad de firma del titular.
 *
 * ⚠ `digest` son los 32 BYTES del hash, no su hexadecimal. El ejemplo de la
 * colección de Postman manda base64 de una cadena hexadecimal —y sirve de
 * ilustración, no de referencia—; el del PDF (§5.2.2, lote) manda 32 bytes.
 * Con el hexadecimal tuID firmaría OTRO valor y la firma verificaría mal sin
 * ningún error de por medio.
 */
export async function firmarHash(
  cfg: ConfigTuid,
  token: TokenTuid,
  signIdentityId: string,
  digestSha256: Buffer,
): Promise<Buffer> {
  if (digestSha256.length !== 32) {
    throw new HttpError(500, `firmarHash espera los 32 bytes de un SHA-256 y recibió ${digestSha256.length}.`);
  }
  const r = await fetch(`${cfg.baseRecursos.replace(/\/+$/, '')}/trustedx-resources/esigp/v1/signatures/server/raw`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token.accessToken}`,
    },
    body: JSON.stringify({
      digest_value: digestSha256.toString('base64'),
      signature_algorithm: 'rsa-sha256',
      sign_identity_id: signIdentityId,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) {
    // Igual que en el canje: los dos campos estándar del error y nada más.
    let motivo = '';
    try {
      const e = (await r.json()) as { error?: unknown; error_description?: unknown };
      const partes = [e.error, e.error_description].filter((x): x is string => typeof x === 'string' && x.length < 200);
      motivo = partes.length ? ` — ${partes.join(': ')}` : '';
    } catch { /* cuerpo no JSON */ }
    throw new HttpError(502, `TuID no pudo firmar (HTTP ${r.status})${motivo}.`);
  }
  const firma = Buffer.from(await r.arrayBuffer());
  if (firma.length < 64) throw new HttpError(502, `TuID devolvió una firma de ${firma.length} bytes, que no puede ser válida.`);
  return firma;
}
