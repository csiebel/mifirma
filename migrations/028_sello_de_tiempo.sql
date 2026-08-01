-- =============================================================================
-- MiFirma — 028_sello_de_tiempo.sql
-- El ancla externa: sello RFC 3161 sobre cada firma.
--
-- ═══ POR QUÉ ESTO Y POR QUÉ AHORA ═══
--
-- Es el riesgo R1 de `auditoria-y-evidencias.md`. El encadenamiento por hash
-- prueba consistencia interna, no anterioridad: quien tenga escritura sobre la
-- base puede rehacer la cadena entera y fabricar un expediente coherente con
-- fecha de hace dos años. Y ese "quien" incluye a la empresa emisora, que es
-- exactamente la parte con interés en el juicio. Sin un tercero que afirme la
-- hora, todo lo demás es teatro.
--
-- ═══ LOS DOS SELLOS NO SON EL MISMO, Y SÓLO UNO ES IRRECUPERABLE ═══
--
-- · SELLO DE LA FIRMA (esta migración). Va como atributo NO firmado dentro del
--   PKCS#7, OID 1.2.840.113549.1.9.16.2.14. Prueba QUÉ HORA ERA CUANDO SE
--   FIRMÓ. En teoría un atributo no firmado se puede agregar después… salvo que
--   modificarlo cambia bytes que las firmas POSTERIORES sí cubren: el
--   `/Contents` de la firma 1 cae dentro del ByteRange de la firma 2. O sea que
--   en la práctica sólo se le podría agregar a la última firma y sólo si nadie
--   firmó después. Para todo lo demás: se obtiene en el momento o no se obtiene
--   nunca. Verificado sobre un PDF de tres firmas, no deducido.
--
-- · SELLO DEL DOCUMENTO (`/Type /DocTimeStamp`). Un incremental update entero,
--   que se puede agregar cuando sea y las veces que sea. NO prueba cuándo se
--   firmó: prueba que el documento ya existía en tal fecha. Es más débil, y es
--   verdad. Por eso sirve como recuperación cuando lo primero falló, y por eso
--   se guarda en un campo distinto y no se lo presenta como si fuera lo mismo.
--
-- ═══ QUÉ PASA SI LA TSA ESTÁ CAÍDA ═══
--
-- Se degrada y se anota, salvo que el país lo prohíba.
--
-- Rechazar siempre la firma sería regalarle a un tercero la capacidad de parar
-- el producto, con el firmante mirando la pantalla. Firmar y sellar después,
-- siempre, sería renunciar para siempre a probar cuándo se firmó. El medio es:
-- se intenta con las TSA configuradas en orden, y si ninguna responde se firma
-- igual, se marca la instancia como `sin_sello` y **el expediente registra el
-- fallo con el error textual de la autoridad**. El documento no miente sobre lo
-- que tiene.
--
-- Y la excepción vive en `pais_firma`, no en el código: donde la ley exija
-- sello para el nivel de firma que estamos vendiendo, se rechaza. El marco
-- legal de cada país es dato verificado por un abogado local, versionado por
-- fecha de vigencia — nunca conocimiento de la aplicación ni de la IA.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- El catálogo de autoridades, que administra el operador
--
-- Varias y ordenadas, no una: probar una segunda autoridad cuesta menos de un
-- segundo y evita perder el sello por una caída ajena. `ultima_ok` y
-- `ultimo_error` existen para que la consola pueda mostrar salud sin que haya
-- que entrar a los logs — la pregunta "¿está andando el sellado?" tiene que
-- responderse mirando, no averiguando.
--
-- Medido el 1/8/2026 contra siete autoridades públicas: digicert 628 ms y token
-- de 5997 B; globalsign 5,9 s y 7651 B. La latencia está en el camino crítico
-- de la firma, así que el orden importa.
-- -----------------------------------------------------------------------------
create table tsa (
  id                uuid primary key default gen_random_uuid(),
  nombre            text not null unique,
  url               text not null,

  -- Si la acreditación del país exige una política concreta, va acá y se manda
  -- en el pedido. Null = se acepta la que la autoridad use por defecto.
  politica_oid      text,

  -- Algunas autoridades comerciales exigen HTTP Basic. La contraseña se guarda
  -- cifrada y no vuelve nunca a la pantalla — ver lecciones-1-agosto §4.
  usuario           text,
  password_cifrado  text,

  pais              char(2),                        -- null = sirve para cualquiera
  timeout_ms        int not null default 8000 check (timeout_ms between 1000 and 30000),
  orden             int not null default 100,       -- menor primero
  activa            boolean not null default true,

  ultima_ok         timestamptz,
  ultimo_error      text,
  ultimo_error_en   timestamptz,

  creada_en         timestamptz not null default now(),
  actualizada_en    timestamptz not null default now()
);

create index tsa_orden on tsa (orden) where activa;

-- -----------------------------------------------------------------------------
-- El paquete de país, primera pieza
--
-- No es una tabla de configuración: es DERECHO, y por eso cada fila lleva de
-- dónde salió, quién la verificó y desde cuándo rige. Una fila sin
-- `verificado_en` es una suposición, y el sistema tiene que poder decirlo en voz
-- alta en vez de operar como si fuera un hecho.
-- -----------------------------------------------------------------------------
create table pais_firma (
  id                    uuid primary key default gen_random_uuid(),
  pais                  char(2) not null,
  nivel_firma           text not null check (nivel_firma in ('simple','avanzada','cualificada')),

  -- Si es true y no hay sello, NO SE FIRMA. Es la única puerta que puede
  -- detener una firma por falta de sello.
  sello_obligatorio     boolean not null default false,
  -- Política de TSA exigida por la acreditación local, si la hay.
  tsa_politica_exigida  text,

  vigente_desde         date not null,
  vigente_hasta         date,

  -- La procedencia. Sin esto la tabla es una opinión con formato de dato.
  fuente                text not null,
  verificado_por        text,
  verificado_en         date,

  creado_en             timestamptz not null default now(),
  unique (pais, nivel_firma, vigente_desde)
);

-- ⚠ SEMILLA PROVISORIA. Estas filas NO son derecho verificado: son el valor
-- permisivo para que el desarrollo funcione, marcadas como no verificadas a
-- propósito. `verificado_en` en null es la señal, y la consola del operador
-- tiene que mostrarla en rojo. Reemplazarlas por dictamen de abogado local es
-- requisito de lanzamiento, no mejora.
insert into pais_firma (pais, nivel_firma, sello_obligatorio, vigente_desde, fuente) values
  ('UY','simple',     false, date '2000-01-01', 'SIN VERIFICAR — pendiente de abogado local (ley 18.600)'),
  ('UY','avanzada',   false, date '2000-01-01', 'SIN VERIFICAR — pendiente de abogado local (ley 18.600)'),
  ('UY','cualificada',false, date '2000-01-01', 'SIN VERIFICAR — pendiente de abogado local (ley 18.600)'),
  ('PY','simple',     false, date '2000-01-01', 'SIN VERIFICAR — pendiente de abogado local (ley 4017)'),
  ('PY','avanzada',   false, date '2000-01-01', 'SIN VERIFICAR — pendiente de abogado local (ley 4017)'),
  ('PY','cualificada',false, date '2000-01-01', 'SIN VERIFICAR — pendiente de abogado local (ley 4017)'),
  ('BR','simple',     false, date '2000-01-01', 'SIN VERIFICAR — pendiente de abogado local (MP 2.200-2 / ICP-Brasil)'),
  ('BR','avanzada',   false, date '2000-01-01', 'SIN VERIFICAR — pendiente de abogado local (MP 2.200-2 / ICP-Brasil)'),
  ('BR','cualificada',false, date '2000-01-01', 'SIN VERIFICAR — pendiente de abogado local (MP 2.200-2 / ICP-Brasil)');

-- La regla vigente hoy para un país y un nivel. `security definer` porque la va
-- a llamar el firmante externo, que no tiene por qué poder leer la tabla.
create or replace function app.sello_obligatorio(p_pais char(2), p_nivel text)
returns boolean
language sql stable security definer set search_path = pg_catalog, public
as $$
  select coalesce((
    select f.sello_obligatorio
      from public.pais_firma f
     where f.pais = p_pais
       and f.nivel_firma = p_nivel
       and f.vigente_desde <= current_date
       and (f.vigente_hasta is null or f.vigente_hasta > current_date)
     order by f.vigente_desde desc
     limit 1), false);
$$;
revoke all on function app.sello_obligatorio(char(2), text) from public;
grant execute on function app.sello_obligatorio(char(2), text) to app_rw, app_operador;

-- -----------------------------------------------------------------------------
-- El sello propiamente dicho
--
-- La tabla ya existía (020) pensada para el anclaje por lote. Se le agrega el
-- alcance 'firma' y de qué instancia y autoridad es, que es lo que permite
-- responder "¿este documento tiene sello y de quién?" sin abrir el PDF.
-- -----------------------------------------------------------------------------
alter table sello_tiempo drop constraint if exists sello_tiempo_alcance_check;
alter table sello_tiempo add constraint sello_tiempo_alcance_check
  check (alcance in ('lote','evento','documento','firma'));

alter table sello_tiempo add column if not exists instancia_id uuid references instancia(id);
alter table sello_tiempo add column if not exists tsa_id uuid references tsa(id);
create index if not exists sello_por_instancia on sello_tiempo (instancia_id)
  where instancia_id is not null;

-- -----------------------------------------------------------------------------
-- Qué nivel de sello alcanzó cada instancia
--
-- Va en la instancia y no se deriva al leer, por la misma razón que
-- `fuerza_identificacion`: el expediente tiene que decir lo que valía ENTONCES.
-- Si mañana agregamos un sello de documento, el campo cambia de 'sin_sello' a
-- 'documento' y el evento correspondiente queda en la cadena — el paso está
-- registrado, no reescrito.
-- -----------------------------------------------------------------------------
alter table instancia add column if not exists nivel_sello text not null default 'sin_sello'
  check (nivel_sello in ('sin_sello','documento','firma'));

comment on column instancia.nivel_sello is
  'sin_sello = nadie externo afirma la fecha. documento = una TSA afirma que el '
  'archivo existía en tal momento (agregable después). firma = una TSA afirma la '
  'hora de la firma misma (sólo se obtiene al firmar). Ver migración 028.';

-- -----------------------------------------------------------------------------
-- Los dos eventos nuevos del expediente
--
-- `sello.fallido` es de peso ALTO a propósito, aunque sea un fallo. Es lo que
-- explica, tres años después, por qué ese documento no tiene sello — y sin esa
-- explicación la ausencia parece negligencia o, peor, manipulación.
-- -----------------------------------------------------------------------------
insert into tipo_evento (codigo, categoria, peso, orden, descripcion_i18n) values
  ('firma.sellada', 'firma', 'alto', 71,
   '{"es":"Se selló la firma con hora de una autoridad externa","pt":"A assinatura foi carimbada com hora de uma autoridade externa","en":"Signature timestamped by an external authority"}'),
  ('sello.fallido', 'firma', 'alto', 72,
   '{"es":"No se pudo obtener el sello de tiempo","pt":"Não foi possível obter o carimbo de tempo","en":"Could not obtain the timestamp"}')
on conflict (codigo) do nothing;

-- -----------------------------------------------------------------------------
-- RLS y permisos
-- -----------------------------------------------------------------------------
alter table tsa enable row level security;
-- Catálogo de la plataforma, no de un cliente: lo administra el operador y lo
-- lee el sistema para poder sellar. Ninguna cuenta lo ve — y menos las
-- credenciales.
create policy tsa_select on tsa for select using (app.actor() in ('operador','sistema'));
create policy tsa_insert on tsa for insert with check (app.actor() = 'operador');
create policy tsa_update on tsa for update using (app.actor() = 'operador');
create policy tsa_delete on tsa for delete using (false);

alter table pais_firma enable row level security;
-- El derecho aplicable no es secreto: lo lee cualquiera que necesite saber si
-- su firma exige sello. Escribirlo, sólo el operador.
create policy pais_firma_select on pais_firma for select using (true);
create policy pais_firma_insert on pais_firma for insert with check (app.actor() = 'operador');
create policy pais_firma_update on pais_firma for update using (app.actor() = 'operador');
create policy pais_firma_delete on pais_firma for delete using (false);

grant select, update on tsa to app_rw;               -- leer y anotar salud, no crear
grant select, insert, update on tsa to app_operador;
grant select on pais_firma to app_rw;
grant select, insert, update on pais_firma to app_operador;

commit;

-- -----------------------------------------------------------------------------
-- Centinela de la 026: ninguna política nueva debe nombrar tablas que el
-- operador no pueda leer. Se repite acá porque acabamos de agregar dos.
-- -----------------------------------------------------------------------------
do $centinela$
declare v_expr text; v_tabla text; v_pol text; v_mal text := '';
begin
  for v_tabla, v_pol, v_expr in
    select c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid)
      from pg_policy p join pg_class c on c.oid = p.polrelid
     where p.polcmd in ('r','*')
       and has_table_privilege('app_operador', c.oid, 'select')
  loop
    if v_expr ~ '(^|[^a-z_])(circuito|instancia|ubicacion|archivo|participacion|otorgamiento)([^a-z_]|$)' then
      v_mal := v_mal || format(E'\n  %s.%s', v_tabla, v_pol);
    end if;
  end loop;
  if v_mal <> '' then
    raise exception E'Políticas que nombran tablas del dominio de firmas y le cobran el GRANT a app_operador:%s', v_mal;
  end if;
end $centinela$;
