-- =============================================================================
-- MiFirma — 077_el_certificado_del_sitio.sql
-- El certificado con el que MiFirma sella la firma simple, cargado desde la
-- consola y guardado en la base, por país y con uno global de respaldo.
--
-- ═══ DE DÓNDE VIENE ═══
--
-- Hasta hoy el sello de plataforma —el P12 con el que se firma cada documento
-- de firma simple— vivía en una variable de entorno de Railway (SELLO_P12), y
-- cambiarlo era un redeploy. Claudio pidió el 10/9 que se cargue desde la
-- consola del operador.
--
-- ═══ POR QUÉ ES UN PROVEEDOR MÁS, Y NO UNA TABLA NUEVA ═══
--
-- Decidido el 30/7 y escrito en `proveedores-y-adaptadores.md` §7.bis: la
-- firma simple es un adaptador más detrás de la misma interfaz. El sello ya
-- tiene código en el catálogo ('sello_plataforma' es lo que el expediente
-- anota desde el 6/9); lo que faltaba era la FILA. Con ella, el P12 viaja por
-- el mismo camino que la credencial de tuID: `credenciales_cif`, sin lectura
-- para nadie (067), cifrada con la clave de la plataforma, con quién y cuándo
-- la cargó. Una tabla nueva sería una segunda forma de guardar un secreto.
--
-- ═══ POR PAÍS, CON UNO GLOBAL ═══
--
-- «Un certificado de persona jurídica por país» (30/7): Uruguay con una CA
-- acreditada por la UCE, Brasil con ICP-Brasil, y uno global (el AATL, cuando
-- se compre) para lo demás. Cada uno es una fila: sello_plataforma (global) y
-- sello_plataforma_uy / _py / _br. Se siembran las cuatro, VACÍAS: sin
-- credencial cargada una fila no cuenta, y `app.sello_para(pais)` cae a la
-- global y, si tampoco tiene, a null — y el adaptador cae a la variable de
-- entorno, que sigue siendo el respaldo hasta que Claudio cargue uno.
--
-- ═══ ⚠ LA CAPACIDAD ES «sello», NO «firma» ═══
--
-- Si el sello se habilitara en un país con capacidad 'firma', aparecería en
-- `app.proveedores_habilitados(pais, 'firma')` — o sea, como una opción de
-- FIRMA AVANZADA en la pantalla del firmante. No lo es: es con lo que se sella
-- la simple. La capacidad nueva lo deja fuera de esa lista sin tocarla.
--
-- ═══ LO QUE ESTO NO CAMBIA ═══
--
-- El sello sigue siendo firma SIMPLE (`nivel` fijo en el adaptador), el P12
-- sigue estando EN CASA (la clave fuera de casa —HSM de la CA, firma por hash—
-- es otro adaptador, el día que se compre el AATL con firma remota), y el
-- expediente sigue anotando `sello: 'sello_plataforma'`. ⚠ El medidor (076)
-- ya fuerza `proveedor_id = null` para la simple, así que que ahora exista la
-- fila no cambia nada en `firma_facturable`.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- 1. La capacidad «sello» en el catálogo de capacidades por país
-- -----------------------------------------------------------------------------
alter table proveedor_pais drop constraint if exists proveedor_pais_capacidades_validas;
alter table proveedor_pais add constraint proveedor_pais_capacidades_validas check (
  capacidades <@ array['identidad','firma','sellado_tiempo','sello']::text[]
);
-- El trigger `proveedor_pais_coherente` (067) sólo exige algo de
-- `proveedor_capacidad` para firma / identidad / sellado_tiempo; 'sello' pasa.
-- Lo que sí exige es que la fila de capacidades EXISTA, y se siembra abajo.

-- -----------------------------------------------------------------------------
-- 2. Las cuatro filas: global, UY, PY, BR — todas sin credencial
-- -----------------------------------------------------------------------------
insert into proveedor_firma (codigo, nombre_mostrado, nombre_i18n, activo_global, entorno,
                             orden_preferencia, endpoints, parametros)
values
  ('sello_plataforma',
   'Certificado del sitio (global)',
   '{"es":"Certificado del sitio (global)","pt":"Certificado do site (global)","en":"Site certificate (global)"}'::jsonb,
   true, 'produccion', 950, '{}'::jsonb,
   '{"rol":"sello","local":true,"pais":null,"nota":"Con esto MiFirma sella la firma SIMPLE cuando el país no tiene certificado propio. El P12 y su contraseña van en la credencial."}'::jsonb),
  ('sello_plataforma_uy',
   'Certificado del sitio · Uruguay',
   '{"es":"Certificado del sitio · Uruguay","pt":"Certificado do site · Uruguai","en":"Site certificate · Uruguay"}'::jsonb,
   true, 'produccion', 951, '{}'::jsonb,
   '{"rol":"sello","local":true,"pais":"UY"}'::jsonb),
  ('sello_plataforma_py',
   'Certificado del sitio · Paraguay',
   '{"es":"Certificado del sitio · Paraguay","pt":"Certificado do site · Paraguai","en":"Site certificate · Paraguay"}'::jsonb,
   true, 'produccion', 952, '{}'::jsonb,
   '{"rol":"sello","local":true,"pais":"PY"}'::jsonb),
  ('sello_plataforma_br',
   'Certificado del sitio · Brasil',
   '{"es":"Certificado del sitio · Brasil","pt":"Certificado do site · Brasil","en":"Site certificate · Brazil"}'::jsonb,
   true, 'produccion', 953, '{}'::jsonb,
   '{"rol":"sello","local":true,"pais":"BR"}'::jsonb)
on conflict (codigo) do nothing;

-- Qué sabe hacer: firma por hash (es un P12 en casa), PKCS#7, no identifica a
-- nadie, no hace sello de tiempo (eso lo hace la TSA, 028).
insert into proveedor_capacidad (proveedor_id, firma_hash, formatos_devueltos, identifica_titular,
                                 devuelve_documento_id, sellado_tiempo, ocsp_en_linea,
                                 alcance_por_firma, requiere_presencia, soporta_lote)
select id, true, '{pkcs7}', false, false, false, false, false, false, true
  from proveedor_firma
 where codigo in ('sello_plataforma','sello_plataforma_uy','sello_plataforma_py','sello_plataforma_br')
on conflict (proveedor_id) do nothing;

-- Los tres de país, habilitados en su país con la capacidad 'sello'. El global
-- no tiene país: es el que queda cuando ninguno aplica.
insert into proveedor_pais (proveedor_id, pais, capacidades, niveles, activo, modelo_economico)
select pf.id, (pf.parametros->>'pais')::char(2), '{sello}', '{simple}', true, 'sin_costo'
  from proveedor_firma pf
 where pf.codigo in ('sello_plataforma_uy','sello_plataforma_py','sello_plataforma_br')
on conflict (proveedor_id, pais) do nothing;

-- Y que nadie lo convierta en proveedor de firma avanzada desde la consola: un
-- sello con capacidad 'firma' o 'identidad' en un país aparecería en la lista
-- del firmante como si fuera tuID.
create or replace function app.sello_no_es_proveedor_externo()
returns trigger
language plpgsql security definer set search_path = pg_catalog, public
as $$
begin
  if exists (select 1 from public.proveedor_firma pf
              where pf.id = new.proveedor_id and pf.parametros->>'rol' = 'sello')
     and new.capacidades && array['firma','identidad','sellado_tiempo']::text[] then
    raise exception 'El certificado del sitio sella la firma simple: no se habilita como proveedor de firma, identidad ni sellado de tiempo'
      using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists sello_no_es_proveedor_externo on proveedor_pais;
create trigger sello_no_es_proveedor_externo
  before insert or update of capacidades on proveedor_pais
  for each row execute function app.sello_no_es_proveedor_externo();

-- -----------------------------------------------------------------------------
-- 3. Cuál se usa para un país
--
-- El del país si TIENE credencial cargada; si no, el global si la tiene; si no,
-- null — y el adaptador cae a la variable de entorno. «Tiene credencial» se
-- sabe por `credencial_puesta_en`, sin leer la credencial (que no se puede).
-- -----------------------------------------------------------------------------
create or replace function app.sello_para(p_pais char(2))
returns table (proveedor_id uuid, codigo text, ambito text, credencial_puesta_en timestamptz)
language sql stable security definer set search_path = pg_catalog, public
as $$
  select pf.id, pf.codigo,
         case when pf.parametros->>'pais' is null then 'global' else pf.parametros->>'pais' end,
         pf.credencial_puesta_en
    from public.proveedor_firma pf
    left join public.proveedor_pais pp
           on pp.proveedor_id = pf.id and pp.pais = upper(p_pais) and pp.activo
   where pf.parametros->>'rol' = 'sello'
     and pf.activo_global
     and pf.credencial_puesta_en is not null
     and (pf.parametros->>'pais' is null or pp.proveedor_id is not null)
   order by (pf.parametros->>'pais' is not null) desc
   limit 1;
$$;
comment on function app.sello_para(char(2)) is
  'El certificado con el que se sella la firma simple en un país: el del país si tiene '
  'credencial cargada, si no el global, si no nada (y el adaptador usa SELLO_P12 del entorno). '
  'Migración 077.';
revoke all on function app.sello_para(char(2)) from public;
grant execute on function app.sello_para(char(2)) to app_rw, app_operador;

-- -----------------------------------------------------------------------------
-- Centinelas
-- -----------------------------------------------------------------------------
do $centinela$
declare v_n int;
begin
  -- El sello no aparece como opción de firma avanzada en ningún país.
  select count(*) into v_n
    from app.proveedores_habilitados('UY', 'firma') h
    join proveedor_firma pf on pf.id = h.proveedor_id
   where pf.parametros->>'rol' = 'sello';
  if v_n > 0 then
    raise exception 'El certificado del sitio salió como opción de firma AVANZADA: la capacidad tiene que ser sello, no firma';
  end if;

  -- Recién sembradas, sin credencial, no cuentan: el entorno sigue mandando.
  if exists (select 1 from app.sello_para('UY')) then
    raise exception 'sello_para devolvió un certificado que nadie cargó';
  end if;
end $centinela$;

commit;
