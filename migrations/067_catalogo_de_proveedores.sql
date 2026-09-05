-- =============================================================================
-- MiFirma — 067_catalogo_de_proveedores.sql
-- El catálogo de proveedores de firma, identidad y sellado de tiempo.
--
-- ═══ POR QUÉ ═══
--
-- `claude proveedores-y-adaptadores.md` (30/7) diseñó este catálogo y la
-- arquitectura §7 lo da por existente. **Nunca se construyó.** Las migraciones
-- 013 y 019 lo nombran como algo que «llega con el dominio de firma»:
--
--   013_billing_chasis.sql:10   -- `instancia`, `participacion` y `proveedor_firma`.
--   019_precios.sql:25          -- `participacion` y `proveedor_firma`, que llegan …
--
-- Y no llegó. Hasta hoy no hay ninguna tabla `proveedor_*`. Existe el plano, no
-- el edificio. Esta migración lo construye, antes del primer adaptador real
-- (tuID), porque lo que se haga acá lo heredan SERPRO y los de Paraguay.
--
-- ═══ EL PRINCIPIO ═══
--
--   El operador enciende, apaga, ordena y da credenciales. No programa.
--
-- Todo elemento de configuración de un proveedor —URLs por ambiente, client_id,
-- scopes, tiempos, costos— es DATO administrable por el operador, por país y por
-- proveedor, sin tocar código. Lo que es código es el PROTOCOLO: cómo se habla
-- OAuth con cada proveedor. Arquitectura §7: activar y configurar un proveedor
-- es configuración; sumar uno nuevo es un adaptador.
--
-- ═══ LOS DOS INVARIANTES ═══
--
--   1. Deshabilitar un proveedor JAMÁS toca un documento ya firmado. Espejo de
--      la regla de billing: la deuda nunca afecta lo firmado.
--   2. Un circuito en curso termina con el proveedor con el que empezó. Espejo
--      de la decisión 2 de billing: los circuitos en curso no se frenan por
--      suspensión.
--
-- Ninguno de los dos se puede imponer desde el esquema —los sostiene el motor de
-- flujo—, pero `participacion.proveedor_elegido_id` es lo que los hace
-- verificables después: sin registrar con qué se firmó, no hay forma de saber
-- si se respetaron.
--
-- ═══ LO QUE ESTA MIGRACIÓN NO TRAE ═══
--
--   · La fila de tuID. Es dato, no esquema: se carga con ambiente y credenciales.
--   · `modo_sello` y `certificado_sello_cuenta` (§7.bis del 30/7). Es el sello de
--     la firma simple, otro tema, otra migración.
--   · La consola del operador. Pantalla, no esquema.
--
-- Ver `claude catalogo-de-proveedores.md` (5/9) para el diseño completo.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- Para el `exclude` de acuerdo_exclusividad: permite combinar `=` sobre char(2)
-- con `&&` sobre daterange en un mismo índice gist.
create extension if not exists btree_gist;

-- =============================================================================
-- 1. El catálogo global
--
-- Sin `clase`. El 30/7 lo previó como un solo valor —'psc' | 'idp_firmante' |
-- 'sellado_tiempo'— y tuID demuestra que no alcanza: hace las tres cosas. Qué
-- sabe hacer cada proveedor vive en `proveedor_capacidad`; qué se le habilita en
-- cada país, en `proveedor_pais.capacidades`.
-- =============================================================================
create table if not exists proveedor_firma (
  id                uuid primary key default gen_random_uuid(),
  codigo            text not null unique,     -- 'tuid' | 'serpro_neoid' | 'efirma_py'
  nombre_mostrado   text not null,
  nombre_i18n       jsonb,
  logo_url          text,

  activo_global     boolean not null default false,

  -- ⚠ `entorno` es texto libre y no un check cerrado, a propósito. El 30/7
  -- previó dos ambientes; tuID tiene TRES —integración, preproducción,
  -- producción— y el que venga tendrá los suyos con otros nombres. Cerrar el
  -- check obliga a una migración por proveedor nuevo, que es exactamente lo que
  -- el principio de arriba dice que no.
  entorno           text not null default 'integracion',

  -- Las URLs de cada servicio, por ambiente. `entorno` dice cuál está activo.
  --   {"integracion": {"auth":"https://eidas.tuid-integracion.uy",
  --                    "tsa" :"https://tsa.tuid-integracion.uy"},
  --    "produccion" : {...}}
  -- Pasar de integración a producción es cambiar `entorno`. No se toca código.
  endpoints         jsonb not null default '{}'::jsonb,

  -- Configuración no secreta del adaptador: client_id, scopes, acr_values,
  -- tiempos de espera. Cada adaptador documenta qué llaves espera.
  parametros        jsonb not null default '{}'::jsonb,

  -- ⚠ El secreto. Cifrado con GATEWAY_ENC_KEY, igual que las pasarelas de pago.
  -- NADIE tiene GRANT de SELECT sobre esta columna — ver §7. Se lee sólo a
  -- través de `app.credencial_de_proveedor()`.
  credenciales_cif  bytea,
  credencial_puesta_en   timestamptz,
  credencial_puesta_por  text,

  orden_preferencia int not null default 100,
  creado_en         timestamptz not null default now(),
  actualizado_en    timestamptz not null default now(),

  constraint proveedor_codigo_limpio check (codigo ~ '^[a-z0-9_]+$')
);

comment on table proveedor_firma is
  'Catálogo global de proveedores. El operador administra ambiente, endpoints, '
  'parámetros y credenciales sin tocar código. Ver migración 067.';
comment on column proveedor_firma.credenciales_cif is
  'Secreto cifrado con GATEWAY_ENC_KEY. Sin GRANT de select para nadie: se lee '
  'sólo por app.credencial_de_proveedor(). Se carga y no vuelve a mostrarse.';

-- =============================================================================
-- 2. Qué sabe hacer cada uno
--
-- Lo declara el adaptador; el motor de flujo lo consulta ANTES de despachar un
-- circuito, no cuando falla la firma.
-- =============================================================================
create table if not exists proveedor_capacidad (
  proveedor_id          uuid primary key references proveedor_firma(id) on delete cascade,

  firma_hash            boolean not null default true,   -- firma un digest, no el PDF
  formatos_devueltos    text[]  not null default '{}',   -- {'pkcs1','pkcs7'}
  identifica_titular    boolean not null default false,  -- sirve además como IdP
  devuelve_documento_id boolean not null default false,  -- expone CI/CPF del titular
  sellado_tiempo        boolean not null default false,
  ocsp_en_linea         boolean not null default false,
  alcance_por_firma     boolean not null default false,  -- token de un solo uso
  requiere_presencia    boolean not null default true,   -- el titular autoriza cada firma

  latencia_tipica_ms    int,
  limite_por_minuto     int,
  soporta_lote          boolean not null default false,

  actualizado_en        timestamptz not null default now()
);

comment on column proveedor_capacidad.firma_hash is
  'Si es false, el proveedor pide el documento entero: el contenido de nuestros '
  'clientes saldría del sistema. Checklist del 30/7 punto 1: motivo suficiente '
  'para descartarlo.';
comment on column proveedor_capacidad.soporta_lote is
  'Mirar esto ANTES de vender un envío masivo con firma avanzada. Sin lote, una '
  'misma persona firmando 3.000 documentos es inviable; 3.000 firmantes con uno '
  'cada uno está bien. La palabra «masivo» confunde los dos casos.';

-- =============================================================================
-- 3. Habilitación por (proveedor, capacidad, país)
--
-- ⚠ El refinamiento del 5/9. El 30/7 habilitaba el proveedor entero por país.
-- tuID hace tres cosas y el operador puede querer una y no otra: usarlo para
-- sellar tiempo sin habilitarlo para firmar, por ejemplo mientras se negocia.
-- =============================================================================
create table if not exists proveedor_pais (
  id                uuid primary key default gen_random_uuid(),
  proveedor_id      uuid not null references proveedor_firma(id) on delete cascade,
  pais              char(2) not null references pais(codigo),

  -- Subconjunto de {'identidad','firma','sellado_tiempo'}. No se puede habilitar
  -- una capacidad que `proveedor_capacidad` no declare: lo controla el trigger
  -- de más abajo.
  capacidades       text[] not null default '{}',

  niveles           text[] not null default '{}',   -- {'avanzada'} | {'avanzada','cualificada'}
  activo            boolean not null default true,
  preferido         boolean not null default false,

  -- Trazabilidad de la acreditación local. Dato del paquete de país.
  acreditado_por    text,                -- 'UCE Uruguay' | 'ITI/ICP-Brasil' | 'MIC/DGCE Paraguay'
  referencia_acreditacion text,
  vigente_desde     date,
  vigente_hasta     date,

  costo_por_firma   numeric(12,4),       -- insumo del medidor de billing
  moneda_costo      char(3),

  creado_en         timestamptz not null default now(),

  unique (proveedor_id, pais),
  constraint proveedor_pais_capacidades_validas check (
    capacidades <@ array['identidad','firma','sellado_tiempo']::text[]
  ),
  constraint proveedor_pais_moneda_iso check (moneda_costo is null or moneda_costo ~ '^[A-Z]{3}$')
);

-- Un solo preferido por país entre los activos. Sin esto, dos preferidos dejan
-- el default a merced del orden de la consulta, y después se manifiesta como
-- «a veces me sugiere uno y a veces otro» sin explicación.
create unique index if not exists proveedor_preferido_uq on proveedor_pais (pais)
  where preferido and activo;

-- No se habilita en un país una capacidad que el proveedor no tiene. Un dato
-- así no falla al cargarlo: falla el día que un firmante intenta usarlo.
create or replace function app.proveedor_pais_coherente()
returns trigger
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_cap public.proveedor_capacidad%rowtype; v_falta text := '';
begin
  select * into v_cap from public.proveedor_capacidad where proveedor_id = new.proveedor_id;
  if not found then
    raise exception 'El proveedor % no declaró capacidades todavía', new.proveedor_id
      using errcode = '23514';
  end if;
  if 'firma' = any(new.capacidades) and not v_cap.firma_hash then
    v_falta := v_falta || ' firma';
  end if;
  if 'identidad' = any(new.capacidades) and not v_cap.identifica_titular then
    v_falta := v_falta || ' identidad';
  end if;
  if 'sellado_tiempo' = any(new.capacidades) and not v_cap.sellado_tiempo then
    v_falta := v_falta || ' sellado_tiempo';
  end if;
  if v_falta <> '' then
    raise exception 'El proveedor no declara la(s) capacidad(es):%', v_falta
      using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists proveedor_pais_coherente on proveedor_pais;
create trigger proveedor_pais_coherente
  before insert or update of capacidades, proveedor_id on proveedor_pais
  for each row execute function app.proveedor_pais_coherente();

-- =============================================================================
-- 4. La política de cada cuenta
--
-- Segundo nivel de la cascada del 30/7 §1: el operador habilita, la empresa
-- elige entre los habilitados, el firmante elige entre los que le quedan. Cada
-- nivel sólo puede RESTRINGIR lo que el anterior habilitó, nunca ampliarlo.
-- =============================================================================
create table if not exists proveedor_cuenta (
  id                uuid primary key default gen_random_uuid(),
  cuenta_id         uuid not null references cuenta(id) on delete cascade,
  proveedor_id      uuid not null references proveedor_firma(id) on delete cascade,

  ofrecido          boolean not null default true,
  orden             int not null default 100,

  -- La excepción del 30/7 §1: el firmante que YA tiene certificado de un
  -- proveedor habilitado en su país pero no ofrecido por esta cuenta, firma
  -- igual. Decirle que no puede usar un certificado válido es fricción sin
  -- beneficio, en el peor momento posible.
  -- ⚠ En país con acuerdo de exclusividad vigente esto NO aplica: la exclusión
  -- se resuelve antes, en `app.proveedores_habilitados()`. Decisión T2 del 5/9.
  permite_externos  boolean not null default true,

  creado_en         timestamptz not null default now(),
  unique (cuenta_id, proveedor_id)
);

-- ⚠ La capacidad que la política de `proveedor_cuenta` exige. Si no se siembra,
-- la política referencia algo que no existe y NINGÚN usuario puede administrar
-- los proveedores de su empresa — una tabla escribible por nadie, que es el modo
-- silencioso de que una funcionalidad no exista.
--
-- Se le da al `admin` y no al emisor: elegir con qué proveedor firma la empresa
-- es una decisión de política, no de operación diaria. Mismo criterio que la 048
-- con `empresa/representar`.
insert into capacidad (recurso, accion, descripcion_i18n) values
  ('proveedores', 'administrar',
   '{"es": "Elegir qué proveedores de firma ofrece la empresa",
     "en": "Choose which signature providers the company offers",
     "pt": "Escolher quais provedores de assinatura a empresa oferece"}'::jsonb)
on conflict do nothing;

insert into rol_capacidad (rol_id, capacidad_id)
select r.id, c.id
  from rol r
  join capacidad c on c.recurso = 'proveedores' and c.accion = 'administrar'
 where r.codigo = 'admin'
on conflict do nothing;

-- =============================================================================
-- 5. Salud
--
-- ⚠ Cuando un proveedor se cae NO se reintenta solo. Es la diferencia con una
-- pasarela de pago y conviene tenerla escrita acá, donde alguien va a venir a
-- copiar el patrón del cobro: un cobro fallido se reintenta sin que nadie
-- participe; una firma fallida no, porque el titular ya consumió un token de un
-- solo uso. Hay que volver a pedirle que autorice, y eso es otro mail.
--
-- Para lo que sirve esta tabla: sacar al proveedor caído de la lista ANTES de
-- que el firmante lo elija, en vez de dejarlo elegir algo que va a fallar.
-- =============================================================================
create table if not exists proveedor_salud (
  proveedor_id      uuid primary key references proveedor_firma(id) on delete cascade,
  estado            text not null default 'desconocido'
                      check (estado in ('operativo','degradado','caido','desconocido')),
  ultimo_chequeo_en timestamptz,
  ultimo_exito_en   timestamptz,
  fallos_seguidos   int not null default 0,
  latencia_p95_ms   int,
  detalle           text
);

-- =============================================================================
-- 6. El acuerdo de exclusividad
--
-- Pieza nueva del 5/9. El 30/7 previó que el operador restrinja proveedores por
-- conveniencia comercial. Esto va más lejos: la exclusividad es un ACUERDO, con
-- vigencia y con cara pública, no un interruptor.
--
-- Lo que produce un acuerdo vigente:
--   · En ese país, para las capacidades del acuerdo, sólo el socio.
--   · Co-branding: los dos logos en el sitio, la pantalla de firma y los correos
--     de las cuentas de ese país (decisión T4 del 5/9).
--   · Al vencer, se apaga solo. Nadie tiene que acordarse de sacar un logo.
--   · Queda la historia: qué acuerdo estuvo vigente cuándo.
--
-- ⚠ Los logos son URL y no FK a `archivo`: `archivo` es del dominio de firmas y
-- el centinela de la 026 se cae si el operador puede leer una política que lo
-- nombre. Además los clientes de correo cargan la imagen desde afuera, así que
-- tiene que ser pública igual.
-- =============================================================================
create table if not exists acuerdo_exclusividad (
  id                   uuid primary key default gen_random_uuid(),
  pais                 char(2) not null references pais(codigo),
  proveedor_id         uuid not null references proveedor_firma(id),
  socio_nombre         text not null,

  vigente_desde        date not null,
  vigente_hasta        date,                      -- null = sin fecha de fin

  capacidades          text[] not null default '{firma}',

  logo_producto_url    text,
  logo_socio_url       text,

  -- Usar la marca del socio en nuestro sitio requiere su autorización. Es
  -- cláusula del acuerdo comercial, no del sistema — pero el sistema no muestra
  -- ningún logo hasta que alguien marque que la tiene por escrito.
  autorizacion_marca   boolean not null default false,

  nota                 text,
  creado_por           text,
  creado_en            timestamptz not null default now(),

  constraint acuerdo_fechas_coherentes check (vigente_hasta is null or vigente_hasta >= vigente_desde),
  constraint acuerdo_capacidades_validas check (
    capacidades <@ array['identidad','firma','sellado_tiempo']::text[] and capacidades <> '{}'
  ),

  -- ⚠ Un solo acuerdo por país en cualquier momento dado. No se puede usar un
  -- índice único parcial con `current_date` —Postgres exige que el predicado sea
  -- inmutable—, y además eso sólo miraría el presente: dos acuerdos futuros
  -- solapados entrarían sin protestar y el conflicto aparecería el día que
  -- empiezan. El `exclude` prohíbe el solapamiento, hoy y en el futuro.
  constraint acuerdo_sin_solapar exclude using gist (
    pais with =,
    daterange(vigente_desde, vigente_hasta, '[]') with &&
  )
);

comment on table acuerdo_exclusividad is
  'Acuerdo comercial de exclusividad por país, con vigencia y co-branding. '
  'Mientras está vigente, sólo el socio para las capacidades del acuerdo. '
  'Ver migración 067 y claude catalogo-de-proveedores.md §3.';

-- =============================================================================
-- 7. La regla, en una función
--
-- Una función y no un join suelto, por el mismo motivo que `app.moneda_de_cobro`
-- en la 032: la usan la pantalla de firma, el motor de flujo, el correo y la
-- consola. Si cada uno escribe la regla por su cuenta, un día se contradicen y
-- nadie sabe cuál manda.
--
-- Devuelve los proveedores que un firmante de `p_pais` puede usar para
-- `p_capacidad`, aplicando: activo global, habilitado en el país, capacidad
-- declarada y habilitada, vigencia de la acreditación, salud, y el acuerdo de
-- exclusividad si lo hay.
--
-- ⚠ El país que manda es el DEL FIRMANTE, no el del emisor. Un circuito emitido
-- desde Uruguay con un firmante brasileño tiene que ofrecerle proveedores
-- brasileños. Resolver por el país del emisor es el error obvio y deja al
-- firmante sin ninguna opción usable. La función recibe el país justamente para
-- que quien la llama tenga que decidirlo a conciencia.
-- =============================================================================
create or replace function app.proveedores_habilitados(p_pais char(2), p_capacidad text)
returns table (
  proveedor_id    uuid,
  codigo          text,
  nombre_mostrado text,
  logo_url        text,
  preferido       boolean,
  orden           int
)
language sql stable security definer set search_path = pg_catalog, public
as $$
  with exclusivo as (
    select a.proveedor_id
      from public.acuerdo_exclusividad a
     where a.pais = upper(p_pais)
       and a.vigente_desde <= current_date
       and (a.vigente_hasta is null or a.vigente_hasta >= current_date)
       and p_capacidad = any(a.capacidades)
  )
  select pf.id, pf.codigo, pf.nombre_mostrado, pf.logo_url,
         pp.preferido, pf.orden_preferencia
    from public.proveedor_firma pf
    join public.proveedor_pais  pp on pp.proveedor_id = pf.id
    left join public.proveedor_salud ps on ps.proveedor_id = pf.id
   where pf.activo_global
     and pp.pais = upper(p_pais)
     and pp.activo
     and p_capacidad = any(pp.capacidades)
     and (pp.vigente_desde is null or pp.vigente_desde <= current_date)
     and (pp.vigente_hasta is null or pp.vigente_hasta >= current_date)
     and coalesce(ps.estado, 'desconocido') <> 'caido'
     and (not exists (select 1 from exclusivo)
          or pf.id in (select proveedor_id from exclusivo))
   order by pp.preferido desc, pf.orden_preferencia, pf.nombre_mostrado;
$$;
revoke all on function app.proveedores_habilitados(char(2), text) from public;
grant execute on function app.proveedores_habilitados(char(2), text) to app_rw, app_operador;

-- El acuerdo vigente de un país, para el co-branding. Devuelve fila sólo si hay
-- acuerdo vigente Y la autorización de marca está registrada.
create or replace function app.exclusividad_vigente(p_pais char(2))
returns table (
  proveedor_id      uuid,
  socio_nombre      text,
  logo_producto_url text,
  logo_socio_url    text,
  vigente_hasta     date
)
language sql stable security definer set search_path = pg_catalog, public
as $$
  select a.proveedor_id, a.socio_nombre, a.logo_producto_url, a.logo_socio_url, a.vigente_hasta
    from public.acuerdo_exclusividad a
   where a.pais = upper(p_pais)
     and a.autorizacion_marca
     and a.vigente_desde <= current_date
     and (a.vigente_hasta is null or a.vigente_hasta >= current_date);
$$;
revoke all on function app.exclusividad_vigente(char(2)) from public;
grant execute on function app.exclusividad_vigente(char(2)) to app_rw, app_operador;

-- -----------------------------------------------------------------------------
-- El secreto, por una puerta y no por la tabla
--
-- Nadie tiene GRANT de SELECT sobre `credenciales_cif` — ni app_rw ni
-- app_operador. El adaptador lo obtiene por acá, y así «se carga y no vuelve a
-- mostrarse» deja de ser una promesa de la pantalla y pasa a ser una propiedad
-- de la base: la consola NO PUEDE mostrarlo aunque alguien lo programe por error.
--
-- ⚠ Lo que esto NO hace: no protege del que ya tiene la conexión de la
-- aplicación. app_rw puede llamar a esta función y obtener el cifrado. Lo que
-- evita es el `select *` accidental, el volcado a un log y la pantalla que lo
-- muestra «para verificar». Descifrarlo sigue necesitando GATEWAY_ENC_KEY, que
-- no está en la base.
-- -----------------------------------------------------------------------------
create or replace function app.credencial_de_proveedor(p_proveedor uuid)
returns bytea
language sql stable security definer set search_path = pg_catalog, public
as $$
  select pf.credenciales_cif
    from public.proveedor_firma pf
   where pf.id = p_proveedor and pf.activo_global;
$$;
revoke all on function app.credencial_de_proveedor(uuid) from public;
grant execute on function app.credencial_de_proveedor(uuid) to app_rw;

-- =============================================================================
-- 8. Con qué firmó cada uno — la deuda de la 006
--
-- ⚠ Las columnas YA EXISTEN. `006_dominio.sql` líneas 194-195 las creó como uuid
-- sueltos, con un comentario que decía «FK en 016». La 016 nunca las ató, porque
-- la tabla a la que debían apuntar es justamente la que nunca se construyó. Así
-- que llevan sesenta migraciones aceptando cualquier uuid, incluido uno de un
-- proveedor inexistente, sin que nada proteste.
--
-- Esta migración cierra esa deuda: no agrega columnas, agrega las FK que
-- faltaban. Sin ellas los dos invariantes de la cabecera no son verificables —
-- no habría forma de saber con qué instrumento se firmó un documento de hace dos
-- años, y en un litigio sobre atribución ésa es exactamente la pregunta.
-- =============================================================================
do $fks$ begin
  if not exists (select 1 from pg_constraint where conname = 'participacion_proveedor_elegido_fk') then
    alter table participacion add constraint participacion_proveedor_elegido_fk
      foreign key (proveedor_elegido_id) references proveedor_firma(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'participacion_proveedor_sugerido_fk') then
    alter table participacion add constraint participacion_proveedor_sugerido_fk
      foreign key (proveedor_sugerido_id) references proveedor_firma(id);
  end if;
end $fks$;

comment on column participacion.proveedor_elegido_id is
  'Con qué proveedor firmó. Se conserva aunque el proveedor se deshabilite '
  'después: lo firmado no se toca. Ver migración 067.';

-- =============================================================================
-- 9. RLS
--
-- Los cuatro catálogos globales llevan RLS con el mismo patrón que
-- `precio_metrica` (019): lectura amplia, escritura sólo del realm operador.
-- Que la lectura sea amplia es correcto y deliberado: qué proveedores hay y en
-- qué países es material comercial, se publica. Lo único sensible es el secreto,
-- y ése no se protege con RLS sino con la ausencia de GRANT (§7).
--
-- `proveedor_cuenta` es la excepción: es de la cuenta, y va con tenant duro.
-- =============================================================================
alter table proveedor_firma      enable row level security;
alter table proveedor_capacidad  enable row level security;
alter table proveedor_pais       enable row level security;
alter table proveedor_salud      enable row level security;
alter table acuerdo_exclusividad enable row level security;
alter table proveedor_cuenta     enable row level security;

drop policy if exists proveedor_select on proveedor_firma;
create policy proveedor_select on proveedor_firma for select using (true);
drop policy if exists proveedor_insert on proveedor_firma;
create policy proveedor_insert on proveedor_firma for insert with check (app.actor() = 'operador');
drop policy if exists proveedor_update on proveedor_firma;
create policy proveedor_update on proveedor_firma for update using (app.actor() = 'operador');
drop policy if exists proveedor_delete on proveedor_firma;
create policy proveedor_delete on proveedor_firma for delete using (app.actor() = 'operador');

drop policy if exists proveedor_cap_select on proveedor_capacidad;
create policy proveedor_cap_select on proveedor_capacidad for select using (true);
drop policy if exists proveedor_cap_insert on proveedor_capacidad;
create policy proveedor_cap_insert on proveedor_capacidad for insert with check (app.actor() = 'operador');
drop policy if exists proveedor_cap_update on proveedor_capacidad;
create policy proveedor_cap_update on proveedor_capacidad for update using (app.actor() = 'operador');
drop policy if exists proveedor_cap_delete on proveedor_capacidad;
create policy proveedor_cap_delete on proveedor_capacidad for delete using (app.actor() = 'operador');

drop policy if exists proveedor_pais_select on proveedor_pais;
create policy proveedor_pais_select on proveedor_pais for select using (true);
drop policy if exists proveedor_pais_insert on proveedor_pais;
create policy proveedor_pais_insert on proveedor_pais for insert with check (app.actor() = 'operador');
drop policy if exists proveedor_pais_update on proveedor_pais;
create policy proveedor_pais_update on proveedor_pais for update using (app.actor() = 'operador');
drop policy if exists proveedor_pais_delete on proveedor_pais;
create policy proveedor_pais_delete on proveedor_pais for delete using (app.actor() = 'operador');

-- La salud la escribe el chequeador, que corre como sistema.
drop policy if exists proveedor_salud_select on proveedor_salud;
create policy proveedor_salud_select on proveedor_salud for select using (true);
drop policy if exists proveedor_salud_escribir on proveedor_salud;
create policy proveedor_salud_escribir on proveedor_salud for all
  using      (app.actor() in ('operador','sistema'))
  with check (app.actor() in ('operador','sistema'));

-- El acuerdo se lee (el sitio y el correo necesitan los logos) y lo escribe sólo
-- el operador: es un contrato comercial.
drop policy if exists acuerdo_select on acuerdo_exclusividad;
create policy acuerdo_select on acuerdo_exclusividad for select using (true);
drop policy if exists acuerdo_insert on acuerdo_exclusividad;
create policy acuerdo_insert on acuerdo_exclusividad for insert with check (app.actor() = 'operador');
drop policy if exists acuerdo_update on acuerdo_exclusividad;
create policy acuerdo_update on acuerdo_exclusividad for update using (app.actor() = 'operador');
drop policy if exists acuerdo_delete on acuerdo_exclusividad;
create policy acuerdo_delete on acuerdo_exclusividad for delete using (app.actor() = 'operador');

-- Tenant duro. La política de proveedores de una empresa es de esa empresa.
drop policy if exists proveedor_cuenta_select on proveedor_cuenta;
create policy proveedor_cuenta_select on proveedor_cuenta for select using (
     app.actor() in ('sistema','operador')
  or (cuenta_id = app.cuenta_actual() and app.es_miembro(cuenta_id))
);
drop policy if exists proveedor_cuenta_escribir on proveedor_cuenta;
create policy proveedor_cuenta_escribir on proveedor_cuenta for all
  using (
       app.actor() = 'sistema'
    or (cuenta_id = app.cuenta_actual() and app.es_miembro(cuenta_id)
        and app.tiene_capacidad('proveedores','administrar'))
  )
  with check (
       app.actor() = 'sistema'
    or (cuenta_id = app.cuenta_actual() and app.es_miembro(cuenta_id)
        and app.tiene_capacidad('proveedores','administrar'))
  );

-- =============================================================================
-- 10. Permisos
--
-- ⚠ Los GRANT de `proveedor_firma` van COLUMNA POR COLUMNA, y es el punto de
-- toda esta sección: `credenciales_cif` no está en ninguna lista de SELECT. Un
-- `select *` sobre la tabla falla para todos, incluido el operador. Es molesto a
-- propósito — el que necesita el secreto llama a la función y queda claro en el
-- código que lo está pidiendo.
-- =============================================================================
grant select (id, codigo, nombre_mostrado, nombre_i18n, logo_url, activo_global,
              entorno, endpoints, parametros, credencial_puesta_en,
              credencial_puesta_por, orden_preferencia, creado_en, actualizado_en)
  on proveedor_firma to app_rw, app_operador;

grant insert (id, codigo, nombre_mostrado, nombre_i18n, logo_url, activo_global,
              entorno, endpoints, parametros, credenciales_cif,
              credencial_puesta_en, credencial_puesta_por, orden_preferencia)
  on proveedor_firma to app_operador;
grant update (codigo, nombre_mostrado, nombre_i18n, logo_url, activo_global,
              entorno, endpoints, parametros, credenciales_cif,
              credencial_puesta_en, credencial_puesta_por, orden_preferencia,
              actualizado_en)
  on proveedor_firma to app_operador;
grant delete on proveedor_firma to app_operador;

grant select on proveedor_capacidad  to app_rw, app_operador;
grant select on proveedor_pais       to app_rw, app_operador;
grant select on proveedor_salud      to app_rw, app_operador;
grant select on acuerdo_exclusividad to app_rw, app_operador;

grant insert, update, delete on proveedor_capacidad  to app_operador;
grant insert, update, delete on proveedor_pais       to app_operador;
grant insert, update, delete on proveedor_salud      to app_operador, app_rw;
grant insert, update, delete on acuerdo_exclusividad to app_operador;

grant select, insert, update, delete on proveedor_cuenta to app_rw;

commit;

-- =============================================================================
-- Centinela de la 026: se agregaron tablas que el operador lee.
--
-- Comprueba que ninguna política legible por app_operador nombre tablas del
-- dominio de firmas. El operador ve agregados y configuración; nunca contenido.
-- =============================================================================
do $centinela$
declare v_expr text; v_tabla text; v_pol text; v_mal text := '';
begin
  for v_tabla, v_pol, v_expr in
    select c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid)
      from pg_policy p join pg_class c on c.oid = p.polrelid
     where p.polcmd in ('r','*')
       and has_table_privilege('app_operador', c.oid, 'select')
  loop
    if v_expr ~ '(^|[^a-z_])(circuito|instancia|ubicacion|archivo|participacion|otorgamiento|marca_firma)([^a-z_]|$)' then
      v_mal := v_mal || format(E'\n  %s.%s', v_tabla, v_pol);
    end if;
  end loop;
  if v_mal <> '' then
    raise exception E'Políticas que nombran tablas del dominio de firmas y le cobran el GRANT a app_operador:%s', v_mal;
  end if;
end $centinela$;
