-- =============================================================================
-- MiFirma — 038_campos_del_documento.sql
--
-- Campos rellenables sobre el PDF. Implementa `repositorio-campos-y-envio-
-- masivo.md` §4.2, con dos apartamientos deliberados que se explican abajo, y
-- con el mecanismo de dibujo ya decidido y medido en `campos-sobre-el-pdf.md`.
--
-- ═══ QUÉ RESUELVE ═══
--
-- Que alguien complete un dato en el documento ANTES de firmarlo: una cédula,
-- un teléfono, un monto, una fecha. Y —es la misma función vista de costado—
-- que el emisor mande el mismo contrato a 3.000 personas cambiando sólo los
-- datos de cada una.
--
-- ═══ ⚠ POR QUÉ EL VALOR CUELGA DE LA INSTANCIA Y NO DEL CIRCUITO ═══
--
-- Porque en modo copias hay 3.000 instancias del mismo circuito y cada una
-- lleva los datos de SU destinatario. `valor_campo` tiene la clave
-- `(campo_id, instancia_id)`: la definición es del circuito, el valor es de la
-- instancia. Es lo que hace que el envío masivo personalizado no sea un módulo
-- aparte sino el mismo mecanismo con el emisor completando desde una planilla.
--
-- ⚠ Y de ahí sale la regla de privacidad más fácil de violar acá: **cada
-- instancia contiene ÚNICAMENTE los datos de su destinatario**. La planilla
-- entera nunca se propaga a las copias.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- La definición: qué campo hay, dónde, y quién lo completa
-- -----------------------------------------------------------------------------
create table campo (
  id                    uuid primary key default gen_random_uuid(),
  circuito_id           uuid not null references circuito(id) on delete cascade,
  cuenta_propietaria_id uuid not null references cuenta(id),

  codigo                text not null,          -- 'telefono_contacto'
  etiqueta_i18n         jsonb not null,         -- {"es":"Teléfono","pt":"Telefone"}

  tipo                  text not null check (tipo in
                          ('texto','parrafo','numero','fecha','moneda','casilla','opcion')),
  opciones              jsonb,                  -- para 'opcion'

  -- ═══ APARTAMIENTO 1: QUIÉN lo completa va por POSICIÓN, no por participación
  --
  -- El diseño decía `participacion_id`. Funciona en serie y en paralelo, donde
  -- las participaciones existen desde el borrador. **No funciona en modo
  -- copias**: ahí se crea una participación por fila AL DESPACHAR, así que un
  -- campo definido antes no puede apuntar a ninguna — y modo copias es
  -- justamente el caso del envío masivo personalizado.
  --
  -- Con la posición, los tres modos usan la misma regla, y encima es como lo
  -- piensa una persona: «esto lo completa el emisor», «esto lo completa el
  -- segundo que firma».
  completa_emisor       boolean not null default false,
  orden_firmante        int,                    -- `participacion.orden` que lo completa

  obligatorio           boolean not null default false,
  valor_por_defecto     text,
  validacion            jsonb,                  -- regex, min, max, formato

  -- ── DÓNDE se dibuja ─────────────────────────────────────────────────────
  -- Puntos PDF, origen abajo-izquierda, igual que `marca_firma`. La conversión
  -- desde la pantalla se hace una vez, en la interfaz.
  pagina                int not null check (pagina >= 0),
  x                     numeric(10,3) not null,
  y                     numeric(10,3) not null,
  ancho                 numeric(10,3) not null check (ancho > 0),
  alto                  numeric(10,3) not null check (alto > 0),

  orden                 int not null default 0,   -- orden de tabulación
  creado_en             timestamptz not null default now(),

  unique (circuito_id, codigo),

  -- Un campo tiene UN dueño: o lo completa el emisor, o un firmante.
  constraint campo_tiene_dueno check (
    (completa_emisor and orden_firmante is null)
    or (not completa_emisor and orden_firmante is not null)),
  constraint campo_opciones_si_corresponde check (
    (tipo = 'opcion') = (opciones is not null))
);

create index campo_por_circuito on campo (circuito_id, orden);

comment on table campo is
  'Qué se puede completar sobre el PDF, dónde, y quién lo completa. La '
  'definición es del circuito; el valor, de la instancia. Ver migración 038.';

-- ⚠ Una vez despachado el circuito, los campos no se tocan. Las coordenadas son
-- absolutas y el documento ya salió: mover un campo ahora es cambiarle el
-- formulario a alguien que ya lo tiene abierto. Es el mismo criterio que
-- `circuito_congelado`.
create or replace function campo_solo_en_borrador() returns trigger
language plpgsql as $$
declare v_estado text;
begin
  select estado into v_estado from public.circuito
   where id = coalesce(new.circuito_id, old.circuito_id);
  if v_estado is distinct from 'borrador' then
    raise exception 'el documento ya se envió: los campos no se pueden cambiar'
      using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;

create trigger campo_congelado
  before insert or update or delete on campo
  for each row execute function campo_solo_en_borrador();

-- -----------------------------------------------------------------------------
-- El valor: uno por campo y por instancia
-- -----------------------------------------------------------------------------
create table valor_campo (
  id                    uuid primary key default gen_random_uuid(),
  campo_id              uuid not null references campo(id) on delete cascade,
  instancia_id          uuid not null references instancia(id),
  cuenta_propietaria_id uuid not null references cuenta(id),

  valor                 text,
  valor_normalizado     text,           -- fecha/número parseados, para búsqueda

  completado_por        uuid references identidad(id),
  completado_en         timestamptz,
  origen                text not null default 'manual'
                          check (origen in ('manual','prellenado','planilla','api')),

  -- ⚠ CONGELADO. Después de esto el valor no cambia más: es lo que se dibujó en
  -- el PDF y lo que la firma cubre. El hash es del valor, no del documento —
  -- sirve para probar que este texto es el que se firmó aunque el PDF se
  -- pierda.
  congelado_en          timestamptz,
  sha256_valor          bytea,

  unique (campo_id, instancia_id),
  constraint valor_congelado_con_hash
    check ((congelado_en is null) = (sha256_valor is null))
);

create index valor_campo_por_instancia on valor_campo (instancia_id);

comment on table valor_campo is
  'Lo que alguien escribió en un campo, por instancia. Se congela al firmar y '
  'a partir de ahí es inmutable. Ver migración 038.';

-- -----------------------------------------------------------------------------
-- ⚠ Quién puede completar qué — en una FUNCIÓN, no en la política
--
-- Lección 8 y migración 026: PostgreSQL comprueba los privilegios de TODAS las
-- tablas del plan al arrancar el ejecutor, y el `or` NO hace cortocircuito. Una
-- política que nombre `campo`, `participacion` o `circuito` le exige el GRANT
-- sobre esas tablas a cualquier rol que lea `valor_campo` — incluido el
-- operador, que no debe tener ninguno. Por eso el predicado vive acá adentro.
-- -----------------------------------------------------------------------------
create or replace function app.puede_completar_campo(p_campo uuid, p_instancia uuid)
returns boolean
language sql stable security definer set search_path = pg_catalog, public
as $$
  select exists (
    select 1
      from public.campo c
      join public.instancia i on i.id = p_instancia
     where c.id = p_campo
       and c.circuito_id = i.circuito_id
       -- La instancia tiene que estar abierta. Un documento cerrado no admite
       -- que nadie escriba nada, y esto lo dice la base, no la pantalla.
       and i.estado in ('pendiente','en_curso')
       and (
         -- (a) El emisor, y sólo mientras el documento no salió.
         (c.completa_emisor
          and i.cuenta_propietaria_id = app.cuenta_actual()
          and app.actor() = 'cuenta'
          and exists (select 1 from public.circuito ci
                       where ci.id = c.circuito_id and ci.estado = 'borrador'))
         or
         -- (b) El firmante al que le toca ese campo, con su turno habilitado y
         --     con derecho a firmar esa instancia. El `orden` es lo que ata el
         --     campo a la persona; el otorgamiento es lo que la autoriza.
         (c.orden_firmante is not null
          and app.tiene_otorgamiento(null, p_instancia, 'firmar')
          and exists (
            select 1 from public.participacion p
             where p.instancia_id = p_instancia
               and p.orden = c.orden_firmante
               and p.identidad_id = any (app.identidades_del_actor())
               and p.estado in ('pendiente','notificada','vista')))
       )
  )
$$;

revoke all on function app.puede_completar_campo(uuid, uuid) from public;
grant execute on function app.puede_completar_campo(uuid, uuid) to app_rw;

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table campo enable row level security;

-- ⚠ El otorgamiento de un firmante es sobre SU INSTANCIA, no sobre el circuito.
--
-- La primera versión de esta política preguntaba `app.tiene_otorgamiento(
-- circuito_id, null, 'metadatos')` y daba cero filas para cualquier firmante:
-- habría abierto el documento con el formulario VACÍO, sin un solo error. Lo
-- encontró la prueba 10, que era la única que miraba desde los ojos del
-- firmante y no desde los del emisor.
--
-- El puente circuito↔instancia va adentro de una función porque una política no
-- puede nombrar `instancia` sin exigirle el GRANT a todo el que lea `campo`
-- —incluido el operador—. Migración 026, lección 8.
create or replace function app.ve_campos_del_circuito(p_circuito uuid)
returns boolean
language sql stable security definer set search_path = pg_catalog, public
as $$
  select app.tiene_otorgamiento(p_circuito, null, 'metadatos')
      or exists (
        select 1 from public.instancia i
         where i.circuito_id = p_circuito
           and app.tiene_otorgamiento(null, i.id, 'metadatos'))
$$;

revoke all on function app.ve_campos_del_circuito(uuid) from public;
grant execute on function app.ve_campos_del_circuito(uuid) to app_rw;

-- Se ve si se ve el documento. Un firmante tiene que poder ver TODOS los campos
-- —no sólo los suyos— porque necesita leer lo que completó el anterior: es
-- parte del documento que está por firmar.
create policy campo_select on campo for select using (
     app.actor() = 'sistema'
  or (cuenta_propietaria_id = app.cuenta_actual() and app.es_miembro(cuenta_propietaria_id))
  or app.ve_campos_del_circuito(circuito_id)
);

-- Definirlos es del dueño. El trigger `campo_congelado` agrega el «sólo en
-- borrador», que es una regla de estado y no de identidad.
create policy campo_escribir on campo for all using (
     app.actor() = 'sistema'
  or (cuenta_propietaria_id = app.cuenta_actual() and app.es_miembro(cuenta_propietaria_id))
) with check (
     app.actor() = 'sistema'
  or (cuenta_propietaria_id = app.cuenta_actual() and app.es_miembro(cuenta_propietaria_id))
);

alter table valor_campo enable row level security;

-- ⚠ Un valor es CONTENIDO del documento y puede ser sensible: un sueldo, un
-- diagnóstico, un número de cuenta. Por eso lleva su propia RLS y no vive en un
-- jsonb colgado de la instancia — ahí heredaría los permisos del documento y no
-- se podría distinguir «ver que el documento existe» de «ver lo que dice».
create policy valor_select on valor_campo for select using (
     app.actor() = 'sistema'
  or (cuenta_propietaria_id = app.cuenta_actual() and app.es_miembro(cuenta_propietaria_id))
  or app.tiene_otorgamiento(null, instancia_id, 'leer')
);

create policy valor_insert on valor_campo for insert with check (
     app.actor() = 'sistema'
  or app.puede_completar_campo(campo_id, instancia_id)
);

-- ⚠ `congelado_en is null` está en el USING: una vez congelado, la fila deja de
-- ser visible para el UPDATE y no hay forma de tocarla desde la aplicación.
-- Es lo que hace que «el valor que se firmó» sea un hecho y no una convención.
create policy valor_update on valor_campo for update using (
  congelado_en is null
  and (app.actor() = 'sistema' or app.puede_completar_campo(campo_id, instancia_id))
);

-- Un valor no se borra: se vacía. Borrarlo dejaría la instancia sin registro de
-- que ese campo existió y alguien lo dejó vacío, que es un hecho distinto.
create policy valor_delete on valor_campo for delete using (false);

grant select, insert, update on campo to app_rw;
grant select, insert, update on valor_campo to app_rw;
-- Sin GRANT a app_operador en ninguna de las dos: son contenido del cliente.
-- Mismo criterio que el resto del dominio. Test C4.

-- -----------------------------------------------------------------------------
-- Eventos
-- -----------------------------------------------------------------------------
insert into tipo_evento (codigo, categoria, peso, orden, descripcion_i18n) values
  ('documento.campo_completado', 'ciclo', 'normal', 46,
   '{"es":"Se completó un campo del documento","pt":"Um campo do documento foi preenchido","en":"A document field was filled"}'),
  ('documento.campos_congelados', 'firma', 'alto', 47,
   '{"es":"Se congelaron los campos antes de firmar","pt":"Os campos foram congelados antes de assinar","en":"Fields were frozen before signing"}')
on conflict (codigo) do nothing;

commit;

-- Centinela de la 026: dos tablas nuevas con políticas nuevas.
do $centinela$
declare v_expr text; v_tabla text; v_pol text; v_mal text := '';
begin
  for v_tabla, v_pol, v_expr in
    select c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid)
      from pg_policy p join pg_class c on c.oid = p.polrelid
     where p.polcmd in ('r','*')
       and has_table_privilege('app_operador', c.oid, 'select')
  loop
    if v_expr ~ '(^|[^a-z_])(circuito|instancia|ubicacion|archivo|participacion|otorgamiento|marca_firma|certificado_finalizacion|registro_pendiente|campo|valor_campo)([^a-z_]|$)' then
      v_mal := v_mal || format(E'\n  %s.%s', v_tabla, v_pol);
    end if;
  end loop;
  if v_mal <> '' then
    raise exception E'Políticas que nombran tablas del dominio y le cobran el GRANT a app_operador:%s', v_mal;
  end if;
end $centinela$;
