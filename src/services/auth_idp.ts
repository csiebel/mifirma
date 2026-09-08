import { SignJWT, jwtVerify } from 'jose';
import { sql, type Transaction } from 'kysely';
import type { DB } from '../db/schema';
import { sinCuenta } from '../db/pool';
import { withUsuario } from '../auth/authz';
import { emitirSesion, firmarDesafioCuenta } from '../auth/identity';
import { configDeProveedor, credencialDeProveedor, endpoint } from '../proveedores/catalogo';
import {
  urlDeAutorizacion, canjearCodigo, leerIdentidad, type ConfigTuid,
} from '../proveedores/tuid/oauth';
import { cuentasDe } from './auth_login';
import { registrarSistema, registrarSesion, registrarPlataforma } from './auditoria';
import { HttpError } from '../http/errors';

/**
 * ENTRAR al producto con una identidad digital, y vincularla desde adentro.
 *
 * ═══ ESTO NO ES LA VERIFICACIÓN DEL FIRMANTE ═══
 *
 * Son dos flujos hermanos que usan el mismo proveedor y terminan en cosas
 * distintas, y confundirlos sería el peor error posible de este archivo:
 *
 *   · `services/tuid_identidad.ts` (5-6/9) escribe un ANCLAJE. Es una prueba
 *     fechada de que esta persona mostró su cédula, y el motor de firma la
 *     consulta en la misma transacción en que firma. Es la decisión T8.
 *   · Esto escribe una VINCULACIÓN (`credencial_idp`, migración 070) y emite
 *     una SESIÓN. Es «con qué puerta entrás», no «qué probaste».
 *
 * «Esta persona usa tuID para entrar» NO es «esta persona probó su cédula el
 * día que firmó». La primera afirmación vale mientras la vinculación esté
 * vigente; la segunda es un hecho con fecha que no se puede volver a afirmar
 * después. Por eso son dos tablas y dos archivos.
 *
 * ⚠⚠ CONSECUENCIA DIRECTA, Y ESTÁ SIN HACER A PROPÓSITO: entrar con tuID HOY
 * NO SUBE EL NIVEL DE GARANTÍA DE LA SESIÓN. Sale 'bajo', igual que con
 * contraseña. Que el login escriba también un anclaje —«el regalo» de la 069,
 * que haría que los usuarios internos firmen con nivel alto sin hacer nada
 * más— es periferia de firma y se decide y se hace aparte, con fable.
 *
 * ═══ POR QUÉ VUELVE POR LA PUERTA DEL FIRMANTE ═══
 *
 * tuID compara la `redirect_uri` CARÁCTER POR CARÁCTER contra una lista corta
 * que administran ellos, y hoy no tiene registrada ninguna dirección del login.
 * Una dirección propia (`/auth/idp/vuelta`) sería más prolija de leer y de
 * auditar, y no se puede probar hasta que tuID la registre — que es un trámite
 * abierto desde el 6/9. Decisión de Claudio (6/9): se reusa la registrada,
 * `/identidad/tuid/vuelta`, y adentro se reparte por el PROPÓSITO del `state`,
 * que va firmado.
 *
 * ⚠ El reparto es seguro porque los dos sobres llevan propósitos distintos y
 * cada verificador exige el suyo: `verificarState` de `oauth.ts` sólo acepta
 * `proposito: 'tuid'` y esto sólo acepta `proposito: 'idp'`. Un sobre de firma
 * no sirve para entrar, y uno de login no sirve para anclar. No alcanza con que
 * los caminos sean distintos: lo que los separa es que cada uno RECHAZA el
 * sobre del otro.
 */

// ═══════════════════════════════════════════════════════════════════════════
// El sobre firmado del viaje
// ═══════════════════════════════════════════════════════════════════════════

const TTL_STATE = '10m';

export interface ViajeIdp {
  /** 'login' = vengo a entrar. 'vincular' = ya estoy adentro y conecto mi identidad. */
  modo: 'login' | 'vincular';
  /** Código del proveedor en el catálogo (`proveedor_firma.codigo`). */
  proveedor: string;
  /** Sólo en 'vincular': quién está vinculando. Sale de la sesión, nunca del cliente. */
  identidadId?: string;
  cuentaId?: string;
}

function secretoState(): Uint8Array {
  const s = process.env.AUTH_DEV_SECRET || process.env.OPERADOR_JWT_SECRET;
  if (!s) throw new HttpError(503, 'Falta AUTH_DEV_SECRET para firmar el estado del login federado.');
  return new TextEncoder().encode(s);
}

async function emitirState(v: ViajeIdp): Promise<string> {
  return new SignJWT({
    proposito: 'idp',
    modo: v.modo,
    prov: v.proveedor,
    iid: v.identidadId ?? null,
    cid: v.cuentaId ?? null,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(TTL_STATE)
    .sign(secretoState());
}

/**
 * ¿Este `state` es de un viaje del login federado?
 *
 * Devuelve el viaje si la firma es nuestra Y el propósito es 'idp'; `null` si
 * no es nuestro o es de otro propósito —el de firma, por ejemplo—. Es lo que
 * usa la vuelta compartida para saber a qué camino mandar el pedido.
 *
 * ⚠ Devuelve `null` y no una excepción para el caso «no es mío»: un sobre de
 * firma que llega acá no es un error, es el otro flujo. Los errores de verdad
 * —vencido, alterado— también caen en `null` y el otro camino los va a rechazar
 * con su propio mensaje, que es el correcto para ese contexto.
 */
export async function viajeDelState(state: string): Promise<ViajeIdp | null> {
  let payload;
  try {
    ({ payload } = await jwtVerify(state, secretoState()));
  } catch {
    return null;
  }
  if (payload.proposito !== 'idp') return null;
  const modo = payload.modo === 'vincular' ? 'vincular' : payload.modo === 'login' ? 'login' : null;
  const prov = typeof payload.prov === 'string' ? payload.prov : null;
  if (!modo || !prov) return null;
  return {
    modo,
    proveedor: prov,
    identidadId: typeof payload.iid === 'string' ? payload.iid : undefined,
    cuentaId: typeof payload.cid === 'string' ? payload.cid : undefined,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// El catálogo, del lado del login
// ═══════════════════════════════════════════════════════════════════════════

export interface ProveedorDeIdentidad {
  codigo: string;
  nombre: string;
  logoUrl: string | null;
}

/**
 * Los proveedores de identidad que se pueden ofrecer en la pantalla de entrar.
 *
 * ⚠⚠ ACÁ NO HAY PAÍS, Y ES UNA DECISIÓN, NO UN OLVIDO.
 *
 * `app.proveedores_habilitados(pais, capacidad)` resuelve la pregunta del
 * FIRMANTE: con quién puede firmar o verificarse alguien de tal país, con la
 * exclusividad comercial incluida (T2). Esa pregunta tiene país porque la
 * respuesta cambia con el país del firmante.
 *
 * La pregunta del LOGIN es otra: quién puede entrar. Y ahí el país no decide
 * nada, por dos motivos:
 *
 *   · En `/entrar` no hay sesión, así que no hay cuenta de la cual sacar el
 *     país (T3 dice que adentro manda la cuenta). Quedaría la IP, que es
 *     justamente lo que T3 no quiere para decidir nada que importe.
 *   · No hace falta: la persona entra con la identidad que YA vinculó. Si no
 *     vinculó ninguna, el botón no le sirve igual, y si vinculó tuID viviendo
 *     en Brasil, negárselo por la IP sería dejarla afuera de su propia cuenta.
 *
 * Por eso esto pregunta otra cosa: qué proveedores de identidad están
 * encendidos en ALGÚN país. El resto de los filtros —activo global, vigencia,
 * salud— se copian de `proveedores_habilitados` para no contradecirla.
 *
 * La exclusividad NO se aplica: es un acuerdo sobre a quién se le ofrece firmar
 * en un país, no sobre quién puede abrir su propia cuenta.
 */
export async function proveedoresDeIdentidad(): Promise<ProveedorDeIdentidad[]> {
  const r = await sinCuenta((trx) =>
    sql<{ codigo: string; nombre_mostrado: string; logo_url: string | null }>`
      select distinct pf.codigo, pf.nombre_mostrado, pf.logo_url, pf.orden_preferencia
        from proveedor_firma pf
        join proveedor_pais  pp on pp.proveedor_id = pf.id
        left join proveedor_salud ps on ps.proveedor_id = pf.id
       where pf.activo_global
         and pp.activo
         and 'identidad' = any(pp.capacidades)
         and (pp.vigente_desde is null or pp.vigente_desde <= current_date)
         and (pp.vigente_hasta is null or pp.vigente_hasta >= current_date)
         and coalesce(ps.estado, 'desconocido') <> 'caido'
       order by pf.orden_preferencia, pf.nombre_mostrado
    `.execute(trx),
  );
  return r.rows.map((p) => ({ codigo: p.codigo, nombre: p.nombre_mostrado, logoUrl: p.logo_url }));
}

/**
 * La dirección de vuelta que se le declara al proveedor.
 *
 * ⚠ Tiene que coincidir CARÁCTER POR CARÁCTER con lo registrado, y es la MISMA
 * que usa la verificación del firmante — ver la cabecera. Está duplicada de
 * `services/tuid_identidad.ts` a propósito: unificarla es tocar un archivo del
 * dominio de firma, que se trabaja con fable. Queda como deuda menor, con el
 * dato de que si algún día cambia una hay que cambiar las dos.
 */
function redirectUri(): string {
  const base = (process.env.APP_BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  return `${base}/identidad/tuid/vuelta`;
}

/**
 * La configuración del proveedor, con su credencial descifrada.
 *
 * ⚠ Sólo sabe hablar tuID. No es un descuido: hoy hay un solo adaptador, y
 * fingir que hay muchos —un mapa de uno— esconde justo la pregunta que hay que
 * hacerse cuando aparezca el segundo (¿todos son OIDC igual? ¿el `sub` de
 * Abitab es igual de estable?). Cuando llegue, esto se parte en un registro de
 * adaptadores y este `if` se convierte en la tabla.
 */
async function configConSecreto(
  trx: Transaction<DB>,
  codigo: string,
): Promise<ConfigTuid & { proveedorId: string; nombre: string }> {
  const cfg = await configDeProveedor(trx, codigo);
  if (cfg.codigo !== 'tuid') {
    throw new HttpError(503, `Todavía no sabemos entrar con «${cfg.nombreMostrado}».`);
  }
  const clientId = cfg.parametros.client_id;
  if (typeof clientId !== 'string' || !clientId) {
    throw new HttpError(503, `Falta el client_id de «${cfg.nombreMostrado}». Cargalo desde la consola del operador.`);
  }
  const base = cfg.endpoints.auth ? endpoint(cfg, 'auth') : endpoint(cfg, 'host');
  const acr = cfg.parametros.acr_values;
  return {
    proveedorId: cfg.id,
    nombre: cfg.nombreMostrado,
    baseAuth: base,
    baseRecursos: cfg.endpoints.api ? endpoint(cfg, 'api') : base,
    clientId,
    clientSecret: await credencialDeProveedor(trx, cfg.id),
    redirectUri: redirectUri(),
    acrValues: typeof acr === 'string' && acr.trim() ? acr.trim() : undefined,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Ida
// ═══════════════════════════════════════════════════════════════════════════

/** Arranca «entrar con mi identidad». No hay sesión todavía. */
export async function iniciarLogin(codigo: string): Promise<{ url: string }> {
  const cfg = await sinCuenta((trx) => configConSecreto(trx, codigo));
  const state = await emitirState({ modo: 'login', proveedor: codigo });
  return { url: urlDeAutorizacion(cfg, state) };
}

/**
 * Arranca «conectar mi identidad», estando ya adentro.
 *
 * ⚠ La identidad y la cuenta salen de la SESIÓN y viajan firmadas en el sobre.
 * Nunca del cuerpo del pedido: dejar que el cliente diga a qué identidad
 * vincular sería regalarle a cualquiera la identidad digital de otro.
 */
export async function iniciarVinculacion(
  cuentaId: string,
  identidadId: string,
  codigo: string,
): Promise<{ url: string }> {
  const cfg = await withUsuario(cuentaId, identidadId, (trx) => configConSecreto(trx, codigo));
  const state = await emitirState({ modo: 'vincular', proveedor: codigo, identidadId, cuentaId });
  return { url: urlDeAutorizacion(cfg, state) };
}

// ═══════════════════════════════════════════════════════════════════════════
// Vuelta — entrar
// ═══════════════════════════════════════════════════════════════════════════

export type ResultadoLoginIdp =
  | { tipo: 'sesion'; token: string; cuentaId: string; identidadId: string }
  | { tipo: 'elegir_cuenta'; desafio: string }
  | { tipo: 'sin_vincular' }
  | { tipo: 'sin_cuenta' };

/**
 * Vuelve del proveedor con el código, en modo login.
 *
 * El orden importa y es el mismo que el de la verificación del firmante: el
 * sobre primero (es lo que ata este regreso con un viaje que empezamos
 * nosotros), después el canje, y recién ahí la base.
 */
export async function completarLogin(
  codigo: string,
  viaje: ViajeIdp,
  ip?: string | null,
  userAgent?: string | null,
): Promise<ResultadoLoginIdp> {
  const { identidadId, sujeto } = await sinCuenta(async (trx) => {
    const cfg = await configConSecreto(trx, viaje.proveedor);
    const token = await canjearCodigo(cfg, codigo);
    const id = await leerIdentidad(cfg, token);

    // ⚠ `app.identidad_por_idp` es SECURITY DEFINER (070): el login corre sin
    // sesión, así que ninguna política basada en la identidad del actor podría
    // dejar ver la fila que hace falta para saber quién está entrando. Lo que
    // la hace segura es QUÉ contesta: recibe un sujeto y devuelve una
    // identidad. No enumera. Para usarla hay que saber ya el `sub` que el
    // proveedor acaba de confirmar en una vuelta firmada.
    const r = await sql<{ id: string | null }>`
      select app.identidad_por_idp(${cfg.proveedorId}::uuid, ${id.sub}) as id
    `.execute(trx);
    return { identidadId: r.rows[0]?.id ?? null, sujeto: id.sub, proveedorId: cfg.proveedorId };
  });

  // Nadie vinculó esta identidad digital a ninguna cuenta. NO se crea una
  // cuenta sola y NO se adivina por el correo que devolvió el proveedor:
  // decisión de Claudio del 6/9, se vincula estando ya adentro. Que el correo
  // coincida no prueba que la cuenta sea de esta persona, y con esa suposición
  // alcanzaría para entrar a la cuenta de alguien que usa el mismo correo.
  if (!identidadId) return { tipo: 'sin_vincular' };

  // ═══ LO QUE SE ANOTA ACÁ ES DE LA IDENTIDAD, NO DE LA CUENTA ═══
  //
  // ⚠⚠ Las dos cosas de abajo estaban más adelante, en la rama de «tiene UNA
  // sola cuenta», y por eso NO OCURRÍAN para quien tiene varias: el que elige
  // empresa sale de este archivo y entra al del login con contraseña
  // (`elegirCuentaLogin`), que no sabe de dónde venía. Medido el 6/9: cuatro
  // `login.ok` en la bitácora y ninguno decía que se había entrado con tuID, y
  // `ultimo_acceso_en` quedó vacío después de un login que funcionó.
  //
  // El error de fondo era conceptual: entrar CON LA IDENTIDAD ya ocurrió — el
  // proveedor la confirmó y `app.identidad_por_idp` la reconoció. A qué empresa
  // se entra es un paso posterior que no cambia ese hecho, y puede incluso no
  // llegar a ocurrir. Poner el registro después de la bifurcación hacía que un
  // hecho consumado dependiera de un paso que viene después.
  //
  // ⚠ `registrarPlataforma` y no `registrarSistema`: la bitácora por cuenta
  // exige `cuenta_id`, y acá todavía no hay cuenta. Este evento es de la
  // plataforma porque la identidad es global y precede a la cuenta — el mismo
  // orden que el login con contraseña (ver el encabezado de `auth_login.ts`).
  try {
    await sinCuenta((trx) =>
      sql`update credencial_idp set ultimo_acceso_en = now()
           where proveedor_id = (select id from proveedor_firma where codigo = ${viaje.proveedor})
             and idp_sujeto = ${sujeto} and revocada_en is null`.execute(trx),
    );
  } catch (e) {
    // No se cae un login por no poder anotar cuándo fue: es un dato de
    // comodidad, no la autorización.
    console.error('idp: no se pudo anotar el último acceso:', e);
  }

  await registrarPlataforma(identidadId, {
    accion: 'idp.entrada',
    recursoTipo: 'credencial_idp',
    despues: { proveedor: viaje.proveedor },
    ip,
    userAgent,
  });

  const cuentas = await cuentasDe(identidadId);
  if (cuentas.length === 0) return { tipo: 'sin_cuenta' };

  // ⚠⚠ EL NIVEL DE LA SESIÓN SALE 'bajo', IGUAL QUE CON CONTRASEÑA.
  //
  // Es deliberado y es la mitad que falta: hoy entrar con tuID prueba que sos
  // el titular de esa identidad digital, pero el producto no convierte eso en
  // una prueba que el motor de firma pueda consultar. Hacerlo es escribir un
  // anclaje, y eso es periferia de firma: se decide y se hace con fable.
  // Mientras tanto, decir 'alto' acá sería afirmar en el expediente algo que
  // ninguna fila sostiene.
  // `via` queda en el token: la ida a firmar con tuID lo lee para decidir si
  // le pide a tuID que vuelva a identificar a la persona (8/9).
  const datos = { anclajesProbados: [] as string[], nivelGarantia: 'bajo' as const, via: `idp:${viaje.proveedor}` };

  if (cuentas.length > 1) {
    return {
      tipo: 'elegir_cuenta',
      desafio: await firmarDesafioCuenta(identidadId, cuentas.map((c) => c.cuentaId), datos),
    };
  }

  const cuentaId = cuentas[0].cuentaId;
  const token = await emitirSesion(cuentaId, identidadId, datos);

  // ⚠ Este `login.ok` es el de quien tenía UNA sola cuenta y entró derecho. El
  // que elige empresa lo escribe `elegirCuentaLogin`, sin `via` — por eso el
  // `idp.entrada` de más arriba, que es el único evento común a los dos
  // caminos y el que responde «¿con qué entró esta persona?».
  await registrarSistema(cuentaId, identidadId, {
    accion: 'login.ok',
    recursoTipo: 'sesion',
    despues: { via: 'idp', proveedor: viaje.proveedor, nivel: datos.nivelGarantia },
    ip,
    userAgent,
  });

  return { tipo: 'sesion', token, cuentaId, identidadId };
}

// ═══════════════════════════════════════════════════════════════════════════
// Vuelta — vincular
// ═══════════════════════════════════════════════════════════════════════════

export interface ResultadoVinculacion {
  ok: true;
  /** true si ya estaba vinculada la misma identidad digital: no se escribió nada. */
  yaEstaba: boolean;
  mostrado: string | null;
}

/**
 * Vuelve del proveedor con el código, en modo vincular. Escribe la fila de
 * `credencial_idp` a nombre de la identidad que arrancó el viaje.
 */
export async function completarVinculacion(
  codigo: string,
  viaje: ViajeIdp,
): Promise<ResultadoVinculacion> {
  if (!viaje.identidadId || !viaje.cuentaId) {
    throw new HttpError(401, 'El viaje de vinculación está incompleto. Volvé a intentarlo.');
  }
  const identidadId = viaje.identidadId;
  const cuentaId = viaje.cuentaId;

  const r = await withUsuario(cuentaId, identidadId, async (trx) => {
    const cfg = await configConSecreto(trx, viaje.proveedor);
    const token = await canjearCodigo(cfg, codigo);
    const id = await leerIdentidad(cfg, token);
    const mostrado = id.nombre ?? null;

    // Lo propio se ve: la RLS de la 070 deja ver las filas de esta identidad y
    // ninguna otra. Preguntar primero convierte los dos casos previsibles en
    // respuestas legibles, en vez de en un choque contra un índice.
    const mia = await sql<{ id: string; idp_sujeto: string }>`
      select id, idp_sujeto from credencial_idp
       where identidad_id = ${identidadId}::uuid
         and proveedor_id = ${cfg.proveedorId}::uuid
         and revocada_en is null
       limit 1
    `.execute(trx);

    const previa = mia.rows[0];
    if (previa) {
      // La misma identidad digital, otra vez: no es un error. No se reescribe
      // nada y se vuelve bien, igual que verificarse dos veces.
      if (previa.idp_sujeto === id.sub) return { ok: true as const, yaEstaba: true, mostrado };
      throw new HttpError(
        409,
        `Ya tenés otra identidad de ${cfg.nombre} conectada a esta cuenta. ` +
          'Desconectá la anterior y volvé a intentarlo.',
      );
    }

    try {
      await sql`
        insert into credencial_idp (identidad_id, proveedor_id, idp_sujeto, mostrado, vinculada_por)
        values (${identidadId}::uuid, ${cfg.proveedorId}::uuid, ${id.sub}, ${mostrado}, ${identidadId}::uuid)
      `.execute(trx);
    } catch (e) {
      // Regla 1 de la 070: un sujeto del proveedor pertenece a UNA sola
      // identidad. La fila de la otra persona no se ve —la RLS no la deja—, así
      // que esto no se puede preguntar antes: se choca contra el índice y se
      // traduce. El mensaje NO dice de quién es: se lo estaríamos contando a
      // alguien que no probó ser esa persona.
      if ((e as { code?: string })?.code === '23505') {
        throw new HttpError(
          409,
          `Esa identidad de ${cfg.nombre} ya está conectada a otra cuenta de MiFirma. ` +
            'Entrá con esa cuenta, o desconectala desde ahí antes de conectarla acá.',
        );
      }
      throw e;
    }
    return { ok: true as const, yaEstaba: false, mostrado };
  });

  if (!r.yaEstaba) {
    await registrarSesion(cuentaId, identidadId, {
      accion: 'idp.vinculado',
      recursoTipo: 'credencial_idp',
      despues: { proveedor: viaje.proveedor },
    });
  }
  return r;
}

// ═══════════════════════════════════════════════════════════════════════════
// Mis identidades conectadas
// ═══════════════════════════════════════════════════════════════════════════

export interface VinculacionMostrada {
  id: string;
  proveedor: string;
  proveedor_nombre: string;
  mostrado: string | null;
  vinculada_en: string;
  ultimo_acceso_en: string | null;
}

export async function misVinculaciones(
  cuentaId: string,
  identidadId: string,
): Promise<VinculacionMostrada[]> {
  const r = await withUsuario(cuentaId, identidadId, (trx) =>
    sql<VinculacionMostrada>`
      select c.id, p.codigo as proveedor, p.nombre_mostrado as proveedor_nombre,
             c.mostrado, c.vinculada_en, c.ultimo_acceso_en
        from credencial_idp c
        join proveedor_firma p on p.id = c.proveedor_id
       where c.identidad_id = ${identidadId}::uuid
         and c.revocada_en is null
       order by c.vinculada_en
    `.execute(trx),
  );
  return r.rows;
}

/**
 * Desconectar una identidad digital.
 *
 * Se REVOCA, no se borra: con esa vinculación alguien entró al sistema, y la
 * bitácora de accesos que la nombra tiene que seguir teniendo a qué apuntar. Es
 * el mismo criterio que los anclajes y que el acuerdo de exclusividad.
 *
 * ⚠ El índice único de la 070 es PARCIAL (`where revocada_en is null`), así que
 * revocar libera: desconectar y volver a conectar se puede hacer las veces que
 * haga falta, y la historia queda entera.
 */
export async function desvincular(
  cuentaId: string,
  identidadId: string,
  vinculacionId: string,
): Promise<{ ok: true }> {
  // ⚠⚠ `returning id` y no `numAffectedRows`, a propósito.
  //
  // Un update que no afecta filas se ve exactamente igual que uno que funcionó,
  // así que hay que contar — pero el contador tiene que ser uno que no pueda
  // venir vacío por otro motivo. `numAffectedRows` lo llena el driver y puede
  // llegar `undefined`; con un `?? 0` de por medio, un desvinculado EXITOSO se
  // reportaría como «no existe». La fila devuelta no depende de nadie más.
  const afectadas = await withUsuario(cuentaId, identidadId, async (trx) => {
    const r = await sql<{ id: string }>`
      update credencial_idp
         set revocada_en = now(), revocada_por = ${identidadId}::uuid
       where id = ${vinculacionId}::uuid
         and identidad_id = ${identidadId}::uuid
         and revocada_en is null
      returning id
    `.execute(trx);
    return r.rows.length;
  });

  if (afectadas === 0) {
    throw new HttpError(404, 'Esa identidad conectada no existe o ya estaba desconectada.');
  }

  await registrarSesion(cuentaId, identidadId, {
    accion: 'idp.desvinculado',
    recursoTipo: 'credencial_idp',
    recursoId: vinculacionId,
  });
  return { ok: true };
}
