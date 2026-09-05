import { sql } from 'kysely';
import { operadorDb } from '../db/pool';
import { HttpError } from '../http/errors';
import { cifrar, huellaClave } from '../operador/cripto';

/**
 * El catálogo de proveedores, desde la consola del operador.
 *
 * ═══ POR QUÉ NO SE PARECE A `pasarelas.ts` ═══
 *
 * Es el mismo problema —configuración con credenciales cifradas— y sin embargo
 * hay dos diferencias que no son de estilo:
 *
 * 1. NO SE USA `enmascarar()`. En `pasarela_pago` el operador puede leer el
 *    secreto cifrado y la consola muestra un enmascarado de ese valor. Acá no:
 *    la migración 067 no le da GRANT de select sobre `credenciales_cif` a nadie,
 *    ni siquiera a `app_operador`. Un `select *` sobre `proveedor_firma` FALLA.
 *    Así que la pantalla no muestra un enmascarado del secreto sino CUÁNDO y
 *    QUIÉN lo cargó, que es la única información honesta que tenemos: el sistema
 *    no puede mostrar el secreto aunque alguien lo programe por error.
 *
 * 2. Se usa SQL directo y no el constructor de consultas. `db/schema.ts` se
 *    mantiene a mano y todavía no conoce las tablas de la 067. Cuando alguien lo
 *    actualice, esto se puede pasar a Kysely; mientras tanto, inventar los tipos
 *    sería peor que escribir el SQL.
 *
 * ⚠ Todo lo de acá corre por `operadorDb()`, que es un pool SEPARADO con el rol
 * `mifirma_operador`. No es prolijidad: el límite del operador —no ver el
 * contenido de los clientes— es la AUSENCIA de GRANT, y sólo existe si la
 * conexión es otra. Ver el encabezado de `db/pool.ts`.
 */

export const CAPACIDADES = ['identidad', 'firma', 'sellado_tiempo'] as const;
export type Capacidad = (typeof CAPACIDADES)[number];

// ═══════════════════════════════════════════════════════════════════════════
// Listar
// ═══════════════════════════════════════════════════════════════════════════

export async function listarProveedores() {
  const r = await sql<{
    id: string; codigo: string; nombre_mostrado: string; activo_global: boolean;
    entorno: string; endpoints: unknown; parametros: unknown;
    credencial_puesta_en: Date | null; credencial_puesta_por: string | null;
    orden_preferencia: number;
    capacidades: unknown; paises: unknown; salud: string | null;
  }>`
    select pf.id, pf.codigo, pf.nombre_mostrado, pf.activo_global, pf.entorno,
           pf.endpoints, pf.parametros, pf.credencial_puesta_en,
           pf.credencial_puesta_por, pf.orden_preferencia,
           to_jsonb(pc.*) - 'proveedor_id' as capacidades,
           coalesce((select jsonb_agg(jsonb_build_object(
                       'pais', pp.pais, 'capacidades', pp.capacidades,
                       'activo', pp.activo, 'preferido', pp.preferido,
                       'acreditado_por', pp.acreditado_por,
                       'costo_por_firma', pp.costo_por_firma,
                       'moneda_costo', pp.moneda_costo) order by pp.pais)
                       from proveedor_pais pp where pp.proveedor_id = pf.id), '[]'::jsonb) as paises,
           ps.estado as salud
      from proveedor_firma pf
      left join proveedor_capacidad pc on pc.proveedor_id = pf.id
      left join proveedor_salud ps on ps.proveedor_id = pf.id
     order by pf.orden_preferencia, pf.nombre_mostrado
  `.execute(operadorDb());

  return {
    // ⚠ La huella de la clave viaja con la lista, y es a propósito: si mañana el
    // descifrado falla, lo primero que hay que comparar es esta huella contra la
    // de la aplicación. Sin eso, «no descifra» es indistinguible de «el dato
    // está corrupto». La huella identifica la clave, no la revela.
    clave_en_uso: huellaClave(),
    proveedores: r.rows.map((p) => ({
      ...p,
      // Nunca el secreto. Sólo el hecho de que existe y cuándo se cargó.
      tiene_credencial: p.credencial_puesta_en !== null,
      credencial_puesta_en: p.credencial_puesta_en,
      credencial_puesta_por: p.credencial_puesta_por,
      // Los ambientes CARGADOS, para que la pantalla avise si el activo no tiene URLs.
      ambientes_cargados: Object.keys((p.endpoints ?? {}) as Record<string, unknown>),
    })),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Crear y editar
// ═══════════════════════════════════════════════════════════════════════════

export interface DatosProveedor {
  codigo: string;
  nombreMostrado: string;
  entorno: string;
  endpoints: Record<string, Record<string, string>>;
  parametros: Record<string, unknown>;
  ordenPreferencia?: number;
  /** ⚠ Si viene vacío en edición, NO se toca. Igual que en pasarelas. */
  credencial?: string;
  /** Quién lo está haciendo, para la trazabilidad. */
  porQuien: string;
}

export async function guardarProveedor(d: DatosProveedor) {
  if (!/^[a-z0-9_]+$/.test(d.codigo)) {
    throw new HttpError(400, 'El código sólo puede tener minúsculas, números y guiones bajos.');
  }
  if (!d.entorno) throw new HttpError(400, 'Falta el ambiente.');

  // ⚠ El ambiente activo TIENE que tener URLs cargadas. Sin este chequeo, el
  // operador cambia a 'produccion', se olvida de cargar las URLs, y el firmante
  // se lleva un error de red que no explica nada. Es el error más probable de
  // toda la cadena y por eso se impide acá, no allá.
  const delAmbiente = d.endpoints?.[d.entorno];
  if (!delAmbiente || Object.keys(delAmbiente).length === 0) {
    throw new HttpError(400, `No hay URLs cargadas para el ambiente «${d.entorno}».`);
  }
  for (const [nombre, url] of Object.entries(delAmbiente)) {
    if (!/^https:\/\//.test(url)) {
      // Sólo https. Un endpoint de identidad por http es una credencial viajando
      // en claro, y aceptarlo «para probar» es cómo termina en producción.
      throw new HttpError(400, `La URL «${nombre}» tiene que empezar con https://`);
    }
  }

  const cif = d.credencial ? cifrar(d.credencial) : null;

  const r = await sql<{ id: string }>`
    insert into proveedor_firma
      (codigo, nombre_mostrado, entorno, endpoints, parametros, orden_preferencia,
       credenciales_cif, credencial_puesta_en, credencial_puesta_por)
    values
      (${d.codigo}, ${d.nombreMostrado}, ${d.entorno},
       ${JSON.stringify(d.endpoints)}::jsonb, ${JSON.stringify(d.parametros)}::jsonb,
       ${d.ordenPreferencia ?? 100},
       ${cif}, ${cif ? new Date() : null}, ${cif ? `${d.porQuien} (${huellaClave()})` : null})
    on conflict (codigo) do update set
       nombre_mostrado = excluded.nombre_mostrado,
       entorno         = excluded.entorno,
       endpoints       = excluded.endpoints,
       parametros      = excluded.parametros,
       orden_preferencia = excluded.orden_preferencia,
       -- ⚠ El secreto sólo se pisa si vino uno nuevo. Un formulario que se envía
       -- con el campo vacío NO borra la credencial cargada: eso apagaría el
       -- proveedor sin que nadie se dé cuenta hasta el próximo intento de firma.
       credenciales_cif      = coalesce(excluded.credenciales_cif, proveedor_firma.credenciales_cif),
       credencial_puesta_en  = coalesce(excluded.credencial_puesta_en, proveedor_firma.credencial_puesta_en),
       credencial_puesta_por = coalesce(excluded.credencial_puesta_por, proveedor_firma.credencial_puesta_por),
       actualizado_en = now()
    returning id
  `.execute(operadorDb());

  return { ok: true, id: r.rows[0]?.id };
}

/** Qué sabe hacer un proveedor. Lo declara quien escribió el adaptador. */
export async function guardarCapacidades(
  proveedorId: string,
  c: {
    firma_hash?: boolean; identifica_titular?: boolean; sellado_tiempo?: boolean;
    devuelve_documento_id?: boolean; alcance_por_firma?: boolean;
    requiere_presencia?: boolean; soporta_lote?: boolean; formatos_devueltos?: string[];
  },
) {
  await sql`
    insert into proveedor_capacidad
      (proveedor_id, firma_hash, identifica_titular, sellado_tiempo,
       devuelve_documento_id, alcance_por_firma, requiere_presencia, soporta_lote,
       formatos_devueltos)
    values
      (${proveedorId}::uuid, ${c.firma_hash ?? false}, ${c.identifica_titular ?? false},
       ${c.sellado_tiempo ?? false}, ${c.devuelve_documento_id ?? false},
       ${c.alcance_por_firma ?? false}, ${c.requiere_presencia ?? true},
       ${c.soporta_lote ?? false}, ${c.formatos_devueltos ?? []})
    on conflict (proveedor_id) do update set
       firma_hash = excluded.firma_hash,
       identifica_titular = excluded.identifica_titular,
       sellado_tiempo = excluded.sellado_tiempo,
       devuelve_documento_id = excluded.devuelve_documento_id,
       alcance_por_firma = excluded.alcance_por_firma,
       requiere_presencia = excluded.requiere_presencia,
       soporta_lote = excluded.soporta_lote,
       formatos_devueltos = excluded.formatos_devueltos,
       actualizado_en = now()
  `.execute(operadorDb());
  return { ok: true };
}

/** Habilitar un proveedor en un país, para capacidades concretas. */
export async function habilitarEnPais(
  proveedorId: string,
  pais: string,
  d: {
    capacidades: string[]; activo?: boolean; preferido?: boolean;
    acreditadoPor?: string | null; costoPorFirma?: string | null; monedaCosto?: string | null;
  },
) {
  for (const c of d.capacidades) {
    if (!(CAPACIDADES as readonly string[]).includes(c)) {
      throw new HttpError(400, `Capacidad desconocida: ${c}`);
    }
  }
  // ⚠ El trigger `proveedor_pais_coherente` (067) rechaza habilitar una
  // capacidad que el proveedor no declara. No lo duplicamos acá: la base es la
  // que manda, y una segunda copia de la regla es una copia que se desincroniza.
  await sql`
    insert into proveedor_pais
      (proveedor_id, pais, capacidades, activo, preferido, acreditado_por,
       costo_por_firma, moneda_costo)
    values
      (${proveedorId}::uuid, ${pais.toUpperCase()}, ${d.capacidades},
       ${d.activo ?? true}, ${d.preferido ?? false}, ${d.acreditadoPor ?? null},
       ${d.costoPorFirma ?? null}, ${d.monedaCosto ?? null})
    on conflict (proveedor_id, pais) do update set
       capacidades = excluded.capacidades,
       activo = excluded.activo,
       preferido = excluded.preferido,
       acreditado_por = excluded.acreditado_por,
       costo_por_firma = excluded.costo_por_firma,
       moneda_costo = excluded.moneda_costo
  `.execute(operadorDb());
  return { ok: true };
}

/**
 * Encender o apagar un proveedor.
 *
 * ⚠ Para ENCENDER se exige credencial cargada y URLs del ambiente activo. Es el
 * mismo criterio que `setPasarelaActiva`: un proveedor encendido sin credencial
 * aparece en la lista del firmante y falla cuando lo elige, que es el peor
 * momento posible.
 *
 * Apagar no exige nada: si algo anda mal, apagarlo tiene que ser inmediato.
 */
export async function setProveedorActivo(codigo: string, activo: boolean) {
  if (activo) {
    const r = await sql<{ tiene_cred: boolean; entorno: string; tiene_urls: boolean }>`
      select credencial_puesta_en is not null as tiene_cred,
             entorno,
             (endpoints -> entorno) is not null
               and (endpoints -> entorno) <> '{}'::jsonb as tiene_urls
        from proveedor_firma where codigo = ${codigo}
    `.execute(operadorDb());
    const p = r.rows[0];
    if (!p) throw new HttpError(404, `No existe el proveedor «${codigo}».`);
    if (!p.tiene_cred) throw new HttpError(400, 'No se puede encender: falta cargar la credencial.');
    if (!p.tiene_urls) throw new HttpError(400, `No se puede encender: faltan las URLs del ambiente «${p.entorno}».`);
  }
  const u = await sql`
    update proveedor_firma set activo_global = ${activo}, actualizado_en = now()
     where codigo = ${codigo}
  `.execute(operadorDb());
  if (Number(u.numAffectedRows ?? 0) === 0) throw new HttpError(404, `No existe el proveedor «${codigo}».`);
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// Acuerdos de exclusividad
// ═══════════════════════════════════════════════════════════════════════════

export async function listarAcuerdos() {
  const r = await sql<Record<string, unknown>>`
    select a.*, pf.codigo as proveedor_codigo, pf.nombre_mostrado as proveedor_nombre,
           (a.vigente_desde <= current_date
            and (a.vigente_hasta is null or a.vigente_hasta >= current_date)) as vigente_hoy
      from acuerdo_exclusividad a
      join proveedor_firma pf on pf.id = a.proveedor_id
     order by a.pais, a.vigente_desde desc
  `.execute(operadorDb());
  return { acuerdos: r.rows };
}

export interface DatosAcuerdo {
  pais: string;
  proveedorId: string;
  socioNombre: string;
  vigenteDesde: string;
  vigenteHasta?: string | null;
  capacidades?: string[];
  logoProductoUrl?: string | null;
  logoSocioUrl?: string | null;
  autorizacionMarca?: boolean;
  nota?: string | null;
  porQuien: string;
}

export async function crearAcuerdo(d: DatosAcuerdo) {
  // ⚠ Los logos son URL y tienen que ser https y públicas: los clientes de
  // correo las cargan desde afuera, y una imagen por http en un correo dispara
  // avisos de contenido inseguro en la mitad de los lectores.
  for (const u of [d.logoProductoUrl, d.logoSocioUrl]) {
    if (u && !/^https:\/\//.test(u)) throw new HttpError(400, 'Los logos tienen que ser URLs https.');
  }
  if (d.autorizacionMarca && !d.logoProductoUrl && !d.logoSocioUrl) {
    throw new HttpError(400, 'Marcaste la autorización de marca pero no cargaste ningún logo.');
  }

  try {
    const r = await sql<{ id: string }>`
      insert into acuerdo_exclusividad
        (pais, proveedor_id, socio_nombre, vigente_desde, vigente_hasta, capacidades,
         logo_producto_url, logo_socio_url, autorizacion_marca, nota, creado_por)
      values
        (${d.pais.toUpperCase()}, ${d.proveedorId}::uuid, ${d.socioNombre},
         ${d.vigenteDesde}::date, ${d.vigenteHasta ?? null}::date,
         ${d.capacidades ?? ['firma']},
         ${d.logoProductoUrl ?? null}, ${d.logoSocioUrl ?? null},
         ${d.autorizacionMarca ?? false}, ${d.nota ?? null}, ${d.porQuien})
      returning id
    `.execute(operadorDb());
    return { ok: true, id: r.rows[0]?.id };
  } catch (e) {
    // La restricción `acuerdo_sin_solapar` (067) impide dos acuerdos que se pisen
    // en el mismo país. El error crudo de Postgres no le dice nada a nadie; esto
    // sí, y es el error que más va a pasar: renovar un acuerdo sin cerrar el
    // anterior.
    const msg = e instanceof Error ? e.message : '';
    if (msg.includes('acuerdo_sin_solapar')) {
      throw new HttpError(
        409,
        'Ya hay un acuerdo de exclusividad para ese país en esas fechas. Cerrá el anterior antes de crear el nuevo.',
      );
    }
    throw e;
  }
}

/**
 * Cerrar un acuerdo antes de tiempo.
 *
 * ⚠ No se borra: se le pone fecha de fin. El acuerdo estuvo vigente y eso es un
 * hecho — hubo documentos firmados bajo él y hubo un logo en la portada. Borrar
 * la fila haría que el sistema no pudiera contestar «qué acuerdo regía en marzo».
 */
export async function cerrarAcuerdo(id: string, hasta: string) {
  const u = await sql`
    update acuerdo_exclusividad set vigente_hasta = ${hasta}::date
     where id = ${id}::uuid
  `.execute(operadorDb());
  if (Number(u.numAffectedRows ?? 0) === 0) throw new HttpError(404, 'No existe ese acuerdo.');
  return { ok: true };
}
