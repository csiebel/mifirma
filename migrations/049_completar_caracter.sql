-- =============================================================================
-- MiFirma — 049_completar_caracter.sql
--
-- Deja el carácter de la firma en su estado final, venga de donde venga.
--
-- ═══ POR QUÉ HACE FALTA ESTO ═══
--
-- La 045 quedó aplicada a medias. Su segunda corrida murió en el
-- `add constraint` porque la restricción ya existía —o sea que la primera había
-- llegado hasta ahí— pero el trigger que crea más abajo NO existía, según dijo
-- la 046 al intentar borrarlo. Dos hechos que no encajan si todo vivía en una
-- sola transacción.
--
-- No importa cuál de las explicaciones sea la buena: importa que **el estado de
-- la base no se puede deducir del orden de las migraciones**, y ahí la única
-- salida honesta es una migración que no suponga nada del punto de partida.
--
-- ⚠ La lección, que vale para todas las que vengan: **una migración tiene que
-- poder correrse dos veces.** Las de hoy no podían —`add constraint` y `create
-- trigger` sin `if not exists` fallan la segunda vez— y eso convierte un error
-- a mitad de camino en un estado que hay que reconstruir a mano. `create or
-- replace function` sí lo permite, y por eso las funciones sobrevivieron todas.
--
-- Esta migración es idempotente de punta a punta y termina comprobando el
-- estado final en vez de suponerlo.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- 1. «Todavía no lo declararon» tiene que ser representable
--
-- Las dos son idempotentes: quitar un default que no está, o una obligación de
-- no-nulo que ya se quitó, no falla.
-- -----------------------------------------------------------------------------
alter table participacion alter column caracter drop default;
alter table participacion alter column caracter drop not null;

-- -----------------------------------------------------------------------------
-- 2. Coherencia: representar es representar A ALGUIEN
-- -----------------------------------------------------------------------------
do $c$ begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.participacion'::regclass
                    and conname = 'participacion_caracter_coherente') then
    alter table participacion add constraint participacion_caracter_coherente
      check (
        caracter is null
        or (caracter = 'personal'       and cuenta_representada_id is null)
        or (caracter = 'representacion' and cuenta_representada_id is not null)
      );
  end if;
end $c$;

comment on column participacion.caracter is
  'personal | representacion | null (todavía no lo declaró). Lo declara quien '
  'firma, antes de firmar. Decide a qué repositorio pertenece el documento. '
  'Ver migraciones 045 a 049.';

-- -----------------------------------------------------------------------------
-- 3. El trigger que sí va: lo declara la persona, hasta que firma
-- -----------------------------------------------------------------------------
create or replace function participacion_caracter_congelado() returns trigger
language plpgsql security definer set search_path = pg_catalog, public
as $$
begin
  if new.caracter is distinct from old.caracter
     or new.cuenta_representada_id is distinct from old.cuenta_representada_id then

    if app.actor() <> 'sistema' then
      if old.identidad_id is distinct from app.identidad_actual() then
        raise exception
          'con qué carácter firma cada persona lo declara ella, no quien manda el documento'
          using errcode = '42501';
      end if;
    end if;

    if old.estado in ('firmada','rechazada','delegada','no_requerida','vencida','cancelada') then
      raise exception
        'ya firmaste este documento: el carácter de la firma no se cambia después, '
        'porque los otorgamientos se emitieron según él'
        using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists participacion_caracter_trg on participacion;
create trigger participacion_caracter_trg before update on participacion
  for each row execute function participacion_caracter_congelado();

-- -----------------------------------------------------------------------------
-- 4. El que NO va: al despachar todavía no se sabe
-- -----------------------------------------------------------------------------
drop trigger if exists circuito_caracter_trg on circuito;
drop function if exists circuito_caracter_elegido();

-- -----------------------------------------------------------------------------
-- 5. El orden de firma, que la 042 dejó y conviene reafirmar por si acaso
-- -----------------------------------------------------------------------------
drop trigger if exists participacion_orden_trg on participacion;
create trigger participacion_orden_trg before update on participacion
  for each row execute function participacion_orden_congelado();

commit;

-- =============================================================================
-- EL ESTADO FINAL, COMPROBADO
--
-- No supone nada: pregunta. Si algo de las 045–048 no quedó, esto lo dice con
-- nombre y apellido en vez de dejarlo para que aparezca usando el producto.
-- =============================================================================
do $estado$
declare v_mal text := ''; v_n int; v_txt text;
begin
  -- caracter admite null y no tiene default
  select count(*) into v_n from information_schema.columns
   where table_name = 'participacion' and column_name = 'caracter'
     and (is_nullable = 'NO' or column_default is not null);
  if v_n > 0 then v_mal := v_mal || E'\n  participacion.caracter sigue not null o con default'; end if;

  -- la restricción de coherencia
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.participacion'::regclass
                    and conname = 'participacion_caracter_coherente') then
    v_mal := v_mal || E'\n  falta participacion_caracter_coherente';
  end if;

  -- el trigger que va, y el que no
  if not exists (select 1 from pg_trigger where tgname = 'participacion_caracter_trg') then
    v_mal := v_mal || E'\n  falta el trigger participacion_caracter_trg';
  end if;
  if exists (select 1 from pg_trigger where tgname = 'circuito_caracter_trg') then
    v_mal := v_mal || E'\n  sobra el trigger circuito_caracter_trg (la 046 lo saca)';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'participacion_orden_trg') then
    v_mal := v_mal || E'\n  falta el trigger participacion_orden_trg (042)';
  end if;

  -- representar exige capacidad, no sólo membresía
  select prosrc into v_txt from pg_proc
   where proname = 'puede_representar' and pronamespace = 'app'::regnamespace;
  if v_txt is null then
    v_mal := v_mal || E'\n  falta app.puede_representar';
  elsif position('capacidad_de' in v_txt) = 0 then
    v_mal := v_mal || E'\n  app.puede_representar no exige la capacidad: se quedó en la versión 046';
  elsif position('cuenta_actual' in v_txt) > 0 then
    v_mal := v_mal || E'\n  app.puede_representar todavía deja representar a la cuenta emisora (045)';
  end if;

  if not exists (select 1 from pg_proc
                  where proname = 'capacidad_de' and pronamespace = 'app'::regnamespace) then
    v_mal := v_mal || E'\n  falta app.capacidad_de (048)';
  end if;

  -- la capacidad, y sólo donde va
  if not exists (select 1 from capacidad where recurso = 'empresa' and accion = 'representar') then
    v_mal := v_mal || E'\n  falta la capacidad empresa.representar (048)';
  end if;
  select count(*) into v_n
    from rol r join rol_capacidad rc on rc.rol_id = r.id
    join capacidad c on c.id = rc.capacidad_id
   where c.recurso = 'empresa' and c.accion = 'representar' and r.codigo <> 'admin';
  if v_n > 0 then
    v_mal := v_mal || format(E'\n  la capacidad de representar quedó en %s rol(es) que no son admin', v_n);
  end if;

  -- el evento del expediente
  if not exists (select 1 from tipo_evento where codigo = 'firma.caracter_declarado') then
    v_mal := v_mal || E'\n  falta el tipo de evento firma.caracter_declarado (047)';
  end if;

  if v_mal <> '' then
    raise exception E'El carácter de la firma quedó incompleto:%s', v_mal;
  end if;

  raise notice 'Carácter de la firma: estado final correcto.';
end $estado$;
