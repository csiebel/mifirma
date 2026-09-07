import { sql } from 'kysely';
import { operadorDb, withOperador } from '../db/pool';
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
 *
 * ⚠⚠ Y las ESCRITURAS van por `withOperador()`, no por `operadorDb()` a secas
 * — corregido el 6/9. El pool del operador da el ROL, pero no el CONTEXTO: las
 * políticas de la 067 exigen `app.actor() = 'operador'` para insertar y
 * modificar, y ese valor lo fija `fijarContexto()` dentro de una transacción.
 * Sin él, `app.actor()` devuelve 'anonimo' y Postgres contesta «new row
 * violates row-level security policy». Desde que nació la pantalla (5/9)
 * NINGUNA escritura de la consola sobre el catálogo había funcionado — y la
 * fila de tuID existe porque `scripts/cargar_credencial.ts` entra como
 * superusuario, que saltea la RLS. Las lecturas sí andaban: su política es
 * `using (true)`. Es la lección del 1/9 con otro disfraz: un camino que
 * saltea la RLS da verde sobre un camino que no la pasa.
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

  return withOperador(d.porQuien, async (trx) => {
  // ⚠ DOS sentencias y no un solo upsert con `coalesce` — corregido el 6/9.
  //
  // La 067 dejó `credenciales_cif` SIN permiso de lectura para nadie, a
  // propósito: es lo que hace imposible que la consola muestre el secreto
  // aunque alguien lo programe por error. Pero un
  //   `set credenciales_cif = coalesce(excluded.credenciales_cif, proveedor_firma.credenciales_cif)`
  // LEE la columna, y Postgres exige permiso de lectura para eso:
  // «permission denied for table proveedor_firma». Editar cualquier proveedor
  // existente fallaba siempre, desde el día que nació la pantalla.
  //
  // La reparación no es dar el permiso —eso abre justo la puerta que la 067
  // cerró—: es que el `update` NO MENCIONE la columna cuando no vino credencial
  // nueva. Así «campo vacío = no la cambies» se cumple sin leer nada.
  const r = cif
    ? await sql<{ id: string }>`
        insert into proveedor_firma
          (codigo, nombre_mostrado, entorno, endpoints, parametros, orden_preferencia,
           credenciales_cif, credencial_puesta_en, credencial_puesta_por)
        values
          (${d.codigo}, ${d.nombreMostrado}, ${d.entorno},
           ${JSON.stringify(d.endpoints)}::jsonb, ${JSON.stringify(d.parametros)}::jsonb,
           ${d.ordenPreferencia ?? 100},
           ${cif}, now(), ${`${d.porQuien} (${huellaClave()})`})
        on conflict (codigo) do update set
           nombre_mostrado   = excluded.nombre_mostrado,
           entorno           = excluded.entorno,
           endpoints         = excluded.endpoints,
           parametros        = excluded.parametros,
           orden_preferencia = excluded.orden_preferencia,
           -- ATENCION: los tres van como PARAMETRO, no como excluded. Corregido
           -- el 6/9 de noche, y es la SEGUNDA mitad del mismo defecto de la
           -- manana.
           --
           -- excluded no es una constante: PostgreSQL exige permiso de SELECT
           -- sobre toda columna de la tabla destino referenciada en un
           -- ON CONFLICT DO UPDATE, y credenciales_cif no lo tiene para nadie,
           -- a proposito (067). O sea que este set fallaba con
           -- "permission denied for table proveedor_firma" -- igual que el
           -- coalesce que se saco a la manana, y por el mismo motivo.
           --
           -- A la manana se arreglo la rama SIN credencial nueva y se probo esa.
           -- Esta, la que carga una credencial, NUNCA SE EJECUTO: la de tuID se
           -- habia cargado con el script cargar_credencial.ts, que entra como
           -- superusuario y saltea la RLS y los grants. Cargar una credencial
           -- desde la consola no funciono nunca, desde el dia que nacio la
           -- pantalla, y se descubrio el 6/9 intentando recargarla en produccion.
           --
           -- Un parametro literal no lee ninguna columna, asi que no pide
           -- permiso de nada. Los otros excluded. de arriba se quedan: esas
           -- columnas si tienen lectura.
           credenciales_cif      = ${cif},
           credencial_puesta_en  = now(),
           credencial_puesta_por = ${`${d.porQuien} (${huellaClave()})`},
           actualizado_en = now()
        returning id
      `.execute(trx)
    : await sql<{ id: string }>`
        insert into proveedor_firma
          (codigo, nombre_mostrado, entorno, endpoints, parametros, orden_preferencia)
        values
          (${d.codigo}, ${d.nombreMostrado}, ${d.entorno},
           ${JSON.stringify(d.endpoints)}::jsonb, ${JSON.stringify(d.parametros)}::jsonb,
           ${d.ordenPreferencia ?? 100})
        on conflict (codigo) do update set
           nombre_mostrado   = excluded.nombre_mostrado,
           entorno           = excluded.entorno,
           endpoints         = excluded.endpoints,
           parametros        = excluded.parametros,
           orden_preferencia = excluded.orden_preferencia,
           actualizado_en = now()
        returning id
      `.execute(trx);

  return { ok: true, id: r.rows[0]?.id };
  });
}

/** Qué sabe hacer un proveedor. Lo declara quien escribió el adaptador. */
export async function guardarCapacidades(
  proveedorId: string,
  c: {
    firma_hash?: boolean; identifica_titular?: boolean; sellado_tiempo?: boolean;
    devuelve_documento_id?: boolean; alcance_por_firma?: boolean;
    requiere_presencia?: boolean; soporta_lote?: boolean; formatos_devueltos?: string[];
  },
  operadorId: string,
) {
  await withOperador(operadorId, (trx) => sql`
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
  `.execute(trx));
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
  operadorId: string,
) {
  for (const c of d.capacidades) {
    if (!(CAPACIDADES as readonly string[]).includes(c)) {
      throw new HttpError(400, `Capacidad desconocida: ${c}`);
    }
  }
  // ⚠ El trigger `proveedor_pais_coherente` (067) rechaza habilitar una
  // capacidad que el proveedor no declara. No lo duplicamos acá: la base es la
  // que manda, y una segunda copia de la regla es una copia que se desincroniza.
  await withOperador(operadorId, (trx) => sql`
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
  `.execute(trx));
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
export async function setProveedorActivo(codigo: string, activo: boolean, operadorId: string) {
  return withOperador(operadorId, async (trx) => {
  if (activo) {
    const r = await sql<{ tiene_cred: boolean; entorno: string; tiene_urls: boolean }>`
      select credencial_puesta_en is not null as tiene_cred,
             entorno,
             (endpoints -> entorno) is not null
               and (endpoints -> entorno) <> '{}'::jsonb as tiene_urls
        from proveedor_firma where codigo = ${codigo}
    `.execute(trx);
    const p = r.rows[0];
    if (!p) throw new HttpError(404, `No existe el proveedor «${codigo}».`);
    if (!p.tiene_cred) throw new HttpError(400, 'No se puede encender: falta cargar la credencial.');
    if (!p.tiene_urls) throw new HttpError(400, `No se puede encender: faltan las URLs del ambiente «${p.entorno}».`);
  }
  const u = await sql`
    update proveedor_firma set activo_global = ${activo}, actualizado_en = now()
     where codigo = ${codigo}
  `.execute(trx);
  if (Number(u.numAffectedRows ?? 0) === 0) throw new HttpError(404, `No existe el proveedor «${codigo}».`);
  return { ok: true };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Acuerdos de exclusividad
// ═══════════════════════════════════════════════════════════════════════════

export async function listarAcuerdos() {
  const r = await sql<Record<string, unknown>>`
    select a.id, a.pais, a.proveedor_id, a.socio_nombre, a.vigente_desde, a.vigente_hasta,
           a.capacidades, a.logo_producto_url, a.logo_socio_url, a.autorizacion_marca, a.nota,
           a.creado_por, a.creado_en,
           a.logo_socio_enlace, a.logo_producto_enlace, a.texto_i18n,
           a.logo_socio_img is not null as logo_socio_img_hay,
           a.logo_producto_img is not null as logo_producto_img_hay,
           a.logo_socio_mime, a.logo_producto_mime,
           pf.codigo as proveedor_codigo, pf.nombre_mostrado as proveedor_nombre,
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
    const r = await withOperador(d.porQuien, (trx) => sql<{ id: string }>`
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
    `.execute(trx));
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

// ═══════════════════════════════════════════════════════════════════════════
// La marca del país (071): logos subidos, enlaces y texto del acuerdo
// ═══════════════════════════════════════════════════════════════════════════

const MIMES_LOGO = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']);
const TOPE_LOGO = 300 * 1024;

/**
 * Un logo que llega de la consola como data URL → bytes + mime verificados.
 *
 * ⚠ El mime NO se toma del data URL: se mira el archivo. PNG, JPEG y WebP
 * tienen firma en los primeros bytes; lo que no coincide con ninguna se trata
 * como SVG sólo si es texto que empieza con `<svg` o `<?xml`. Un operador se
 * puede equivocar de archivo, y un `.exe` rotulado image/png no tiene que
 * llegar a la base aunque el check de la 071 lo dejara pasar.
 *
 * El SVG se sanea: sin <script>, sin atributos on*, sin javascript: y sin
 * <foreignObject>. Como <img> no ejecutaría nada igual, pero por la URL
 * directa sí — y `/publico/marca-imagen` le pone además un CSP con sandbox.
 * Dos cinturones.
 */
export function logoDesdeDataUrl(dataUrl: string): { img: Buffer; mime: string } {
  const m = /^data:([a-z0-9.+\/-]+);base64,([A-Za-z0-9+\/=\s]+)$/i.exec(dataUrl.trim());
  if (!m) throw new HttpError(400, 'El logo tiene que llegar como imagen en base64.');
  return logoDesdeBytes(Buffer.from(m[2].replace(/\s+/g, ''), 'base64'));
}

/** El mismo control, para bytes que llegaron por cualquier vía. */
export function logoDesdeBytes(bytes: Buffer): { img: Buffer; mime: string } {
  let img = bytes;
  if (img.length === 0) throw new HttpError(400, 'El logo está vacío.');
  if (img.length > TOPE_LOGO) throw new HttpError(400, `El logo pesa ${Math.round(img.length / 1024)} KB y el tope es 300 KB.`);

  let mime: string | null = null;
  if (img.length > 8 && img.readUInt32BE(0) === 0x89504e47) mime = 'image/png';
  else if (img.length > 3 && img[0] === 0xff && img[1] === 0xd8 && img[2] === 0xff) mime = 'image/jpeg';
  else if (img.length > 12 && img.toString('ascii', 0, 4) === 'RIFF' && img.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp';
  else {
    const txt = img.toString('utf8');
    if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(txt)) {
      const limpio = txt
        .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
        .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '')
        .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        .replace(/(href|xlink:href)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, '$1=""');
      img = Buffer.from(limpio, 'utf8');
      mime = 'image/svg+xml';
    }
  }
  if (!mime || !MIMES_LOGO.has(mime)) {
    throw new HttpError(400, 'El logo tiene que ser PNG, JPEG, WebP o SVG. El archivo no es ninguno de esos.');
  }
  return { img, mime };
}

/**
 * La imagen de un logo TAL COMO ESTÁ GUARDADA, para la vista previa de la
 * consola.
 *
 * ⚠ No pasa por `app.marca_imagen`, y es a propósito: esa función es la puerta
 * PÚBLICA y aplica la vigencia y la autorización de marca. El operador tiene
 * que poder ver qué subió ANTES de marcar la autorización — si no, tendría que
 * publicar para saber cómo queda, que es exactamente al revés.
 *
 * La lectura es directa porque `acuerdo_select` (067) es `using (true)` y el
 * operador ya puede leer la tabla entera.
 */
export async function imagenDeAcuerdo(id: string, cual: 'socio' | 'producto', porQuien: string) {
  const col = cual === 'socio' ? 'logo_socio' : 'logo_producto';
  const r = await withOperador(porQuien, (trx) => sql<{ img: Buffer | null; mime: string | null }>`
    select ${sql.ref(col + '_img')} as img, ${sql.ref(col + '_mime')} as mime
      from acuerdo_exclusividad where id = ${id}::uuid
  `.execute(trx));
  const f = r.rows[0];
  if (!f?.img || !f.mime) return null;
  return { img: f.img, mime: f.mime };
}

export interface MarcaDelAcuerdo {
  logoSocioUrl?: string | null;
  logoSocioEnlace?: string | null;
  /** data URL para subir, null para quitar, undefined para no tocar. */
  logoSocioImg?: string | null;
  /** Si es true, se guarda una copia de lo que haya en `logoSocioUrl`. */
  copiarSocio?: boolean;
  logoProductoUrl?: string | null;
  logoProductoEnlace?: string | null;
  logoProductoImg?: string | null;
  copiarProducto?: boolean;
  textoI18n?: Record<string, string> | null;
  autorizacionMarca?: boolean;
}

function urlHttps(u: string | null | undefined, que: string): string | null {
  if (u == null || u === '') return null;
  if (!/^https:\/\//.test(u)) throw new HttpError(400, `${que} tiene que ser una URL https.`);
  return u;
}

/**
 * Traer una imagen de una URL y quedarnos con una copia.
 *
 * ═══ POR QUÉ EL SERVIDOR Y NO EL NAVEGADOR ═══
 *
 * El logo de un socio vive en el sitio del socio. Enlazarlo es gratis y frágil:
 * el día que Antel reorganice su web, la página del país queda sin logo y nadie
 * se entera. Con una copia propia, la marca del acuerdo tiene la misma vida que
 * el acuerdo. El navegador del operador no puede hacer esa copia —la política
 * de contenido de la consola sólo habla con nuestro propio origen—, así que la
 * trae el servidor.
 *
 * ⚠⚠ Un servidor que descarga la URL que le dicen es un ariete: puede alcanzar
 * lo que el operador no alcanza —la red interna de Railway, un metadata service,
 * la propia base. Los cinco frenos:
 *
 *   1. Sólo `https:` (la URL final también, después de redirecciones).
 *   2. El host tiene que ser un nombre con punto — nada de `localhost` ni de
 *      nombres cortos de red interna.
 *   3. Se rechazan las IPs literales privadas, de loopback y de enlace local.
 *   4. Diez segundos de paciencia y 300 KB de tope, cortando la lectura por
 *      partes: un servidor hostil no nos llena la memoria con un chorro infinito.
 *   5. Lo que llega pasa por el MISMO control que un archivo subido a mano
 *      (firma del archivo, no lo que declare el `Content-Type`, y el SVG saneado).
 *
 * Y sobre todo: esto lo llama un operador autenticado con `gestionar_pagos`.
 * No hay forma de disparar esto desde afuera.
 */
export async function traerLogoDeUrl(url: string): Promise<{ img: Buffer; mime: string }> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new HttpError(400, 'Esa no es una dirección válida.');
  }
  const seguro = (v: URL) => {
    if (v.protocol !== 'https:') throw new HttpError(400, 'La imagen tiene que venir de una dirección https.');
    const h = v.hostname.replace(/^\[|\]$/g, '');
    if (!h.includes('.') || h === 'localhost') throw new HttpError(400, 'Ese host no se puede consultar.');
    if (/^(?:127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(h) || h === '::1' || /^f[cd]/i.test(h)) {
      throw new HttpError(400, 'Ese host no se puede consultar.');
    }
  };
  seguro(u);

  const corte = new AbortController();
  const reloj = setTimeout(() => corte.abort(), 10_000);
  let r: Response;
  try {
    r = await fetch(u, { signal: corte.signal, redirect: 'follow', headers: { Accept: 'image/*' } });
  } catch (e) {
    clearTimeout(reloj);
    throw new HttpError(502, 'No se pudo traer la imagen de esa dirección.');
  }
  clearTimeout(reloj);
  seguro(new URL(r.url));
  if (!r.ok) throw new HttpError(502, `La dirección contestó ${r.status}.`);

  // Se lee por partes para poder cortar en el tope y no tragarse un chorro sin fin.
  const partes: Buffer[] = [];
  let total = 0;
  const lector = (r.body as any)?.getReader?.();
  if (!lector) throw new HttpError(502, 'La dirección no devolvió una imagen.');
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    total += value.length;
    if (total > 300 * 1024) {
      try { await lector.cancel(); } catch { /* ya está */ }
      throw new HttpError(400, 'La imagen de esa dirección pesa más de 300 KB.');
    }
    partes.push(Buffer.from(value));
  }
  return logoDesdeBytes(Buffer.concat(partes));
}

/**
 * Cambiar la marca de un acuerdo que ya existe: logos (URL o imagen subida),
 * enlaces, texto por idioma y la autorización de marca.
 *
 * Es lo único del acuerdo que se edita: fechas, país, proveedor y capacidades
 * son el acuerdo comercial y no se retocan — se cierra y se crea otro.
 */
export async function actualizarMarca(id: string, d: MarcaDelAcuerdo, porQuien: string) {
  const socioUrl = urlHttps(d.logoSocioUrl, 'El logo del socio');
  const productoUrl = urlHttps(d.logoProductoUrl, 'El logo del producto');
  const socioEnlace = urlHttps(d.logoSocioEnlace, 'El enlace del socio');
  const productoEnlace = urlHttps(d.logoProductoEnlace, 'El enlace del producto');
  // Un archivo elegido a mano gana sobre «traer de la URL»: si el operador hizo
  // las dos cosas, lo que quiso es lo que acaba de elegir.
  let socioImg = d.logoSocioImg ? logoDesdeDataUrl(d.logoSocioImg) : d.logoSocioImg === null ? null : undefined;
  let productoImg = d.logoProductoImg ? logoDesdeDataUrl(d.logoProductoImg) : d.logoProductoImg === null ? null : undefined;
  if (!socioImg && d.copiarSocio) {
    if (!socioUrl) throw new HttpError(400, 'Marcaste guardar una copia del logo del socio pero no hay dirección.');
    socioImg = await traerLogoDeUrl(socioUrl);
  }
  if (!productoImg && d.copiarProducto) {
    if (!productoUrl) throw new HttpError(400, 'Marcaste guardar una copia del logo del producto pero no hay dirección.');
    productoImg = await traerLogoDeUrl(productoUrl);
  }

  let texto: Record<string, string> | null = null;
  if (d.textoI18n) {
    texto = {};
    for (const [k, v] of Object.entries(d.textoI18n)) {
      if (!/^[a-z]{2}$/.test(k)) continue;
      const t = String(v ?? '').trim();
      if (t.length > 400) throw new HttpError(400, `El texto en «${k}» supera los 400 caracteres.`);
      if (t) texto[k] = t;
    }
    if (Object.keys(texto).length === 0) texto = null;
  }

  const u = await withOperador(porQuien, (trx) => sql`
    update acuerdo_exclusividad set
      logo_socio_url       = ${socioUrl},
      logo_socio_enlace    = ${socioEnlace},
      logo_producto_url    = ${productoUrl},
      logo_producto_enlace = ${productoEnlace},
      texto_i18n           = ${texto ? JSON.stringify(texto) : null}::jsonb,
      autorizacion_marca   = ${d.autorizacionMarca ?? false},
      logo_socio_img       = ${socioImg === undefined ? sql`logo_socio_img` : socioImg ? socioImg.img : null},
      logo_socio_mime      = ${socioImg === undefined ? sql`logo_socio_mime` : socioImg ? socioImg.mime : null},
      logo_producto_img    = ${productoImg === undefined ? sql`logo_producto_img` : productoImg ? productoImg.img : null},
      logo_producto_mime   = ${productoImg === undefined ? sql`logo_producto_mime` : productoImg ? productoImg.mime : null}
    where id = ${id}::uuid
  `.execute(trx));
  if (Number(u.numAffectedRows ?? 0) === 0) throw new HttpError(404, 'No existe ese acuerdo.');
  return { ok: true };
}

/**
 * Cerrar un acuerdo antes de tiempo.
 *
 * ⚠ No se borra: se le pone fecha de fin. El acuerdo estuvo vigente y eso es un
 * hecho — hubo documentos firmados bajo él y hubo un logo en la portada. Borrar
 * la fila haría que el sistema no pudiera contestar «qué acuerdo regía en marzo».
 */
export async function cerrarAcuerdo(id: string, hasta: string, operadorId: string) {
  const u = await withOperador(operadorId, (trx) => sql`
    update acuerdo_exclusividad set vigente_hasta = ${hasta}::date
     where id = ${id}::uuid
  `.execute(trx));
  if (Number(u.numAffectedRows ?? 0) === 0) throw new HttpError(404, 'No existe ese acuerdo.');
  return { ok: true };
}
