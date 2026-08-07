-- =============================================================================
-- MiFirma — 052_quien_completa.sql
--
-- Un campo que puede completar CUALQUIERA de los firmantes.
--
-- ═══ DE DÓNDE SALE ═══
--
-- De una pregunta que encontró un hueco real:
--
--   «hoy puedo armar algo distinto para cada uno pero no hay una opción para
--    que todos lo llenen»
--
-- Hasta acá un campo tenía dueño único: o el emisor, o UN firmante nombrado por
-- su orden. Faltaba el caso del dato que hace falta una sola vez y da igual
-- quién lo aporte — un número de expediente, la fecha de una reunión, el lugar
-- donde se firma.
--
-- ═══ LOS TRES MODOS, Y POR QUÉ NO SON CUATRO ═══
--
--   · emisor      — lo escribe quien manda el documento, antes de mandarlo.
--   · firmante N  — se lo pedimos a UNA persona en particular.
--   · cualquiera  — el primero de los firmantes que lo complete.
--
-- «Uno para cada firmante» —que cada uno ponga SU cédula— parece un cuarto modo
-- y no lo es: **dos personas no pueden escribir en el mismo renglón del papel**.
-- Si son tres cédulas, hacen falta tres recuadros. Eso se resuelve en el editor,
-- creando N campos de modo `firmante` de un saque, y no acá: guardarlo como un
-- modo propio sería prometer en la base algo que la hoja no puede cumplir.
--
-- ═══ LA REGLA QUE HACE FALTA PENSAR ═══
--
-- ⚠ Un campo de `cualquiera` lo completa el primero que llegue — y a partir de
-- ahí **los demás lo ven y no lo pueden cambiar**. Sin eso, el tercer firmante
-- podría reescribir en silencio lo que el primero ya había leído y aceptado, y
-- el documento diría otra cosa que la que se aprobó.
--
-- Que se pueda escribir DOS veces no es «más flexible»: es que nadie sabe qué
-- versión firmó. Quien lo puso sí puede corregirlo mientras no haya firmado —
-- es suyo y todavía está a tiempo.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- 1. El modo, explícito
--
-- Se podría haber usado «orden_firmante is null y no es del emisor» para decir
-- «cualquiera», y sería un valor mágico: nadie que lea la tabla dentro de un año
-- va a saber que ese null significa eso. Una columna que se llama como lo que
-- es cuesta lo mismo y se explica sola.
-- -----------------------------------------------------------------------------
alter table campo add column if not exists quien_completa text;

-- ⚠ EL RELLENO TIENE QUE APAGAR UN TRIGGER, Y ESO HAY QUE EXPLICARLO.
--
-- `campo_congelado` (038) prohíbe tocar un campo de un circuito ya despachado,
-- y tiene toda la razón: mover un campo después del envío es cambiarle el
-- formulario a alguien que ya lo tiene abierto.
--
-- Pero esto NO es tocar un campo. Es rellenar una columna nueva con lo que la
-- fila ya decía por otras dos. El documento no cambia; cambia cómo lo
-- guardamos. El trigger no puede distinguir las dos cosas —ve un UPDATE y
-- nada más— así que se apaga durante el relleno y se prende enseguida.
--
-- Va DENTRO de la transacción a propósito: en PostgreSQL el DDL también hace
-- rollback, así que si algo falla el trigger vuelve prendido solo. No hay
-- forma de que quede apagado por un error.
--
-- Sin esto, la migración muere en la primera base que tenga UN documento ya
-- enviado — que es cualquier base con la que se haya trabajado un día.
alter table campo disable trigger campo_congelado;

update campo
   set quien_completa = case when completa_emisor then 'emisor' else 'firmante' end
 where quien_completa is null;

alter table campo enable trigger campo_congelado;

alter table campo alter column quien_completa set default 'firmante';
alter table campo alter column quien_completa set not null;

do $c$ begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.campo'::regclass
                    and conname = 'campo_quien_completa_check') then
    alter table campo add constraint campo_quien_completa_check
      check (quien_completa in ('emisor','firmante','cualquiera'));
  end if;
end $c$;

-- -----------------------------------------------------------------------------
-- ⚠ LA RESTRICCIÓN VIEJA HACE IMPOSIBLE EL MODO NUEVO
--
-- `campo_tiene_dueno` (038) dice:
--
--   (completa_emisor y orden_firmante is null)
--   o (no completa_emisor y orden_firmante is not null)
--
-- Es decir: **o es del emisor, o es de UN firmante nombrado**. Un campo de
-- `cualquiera` es justamente el tercer caso —de ningún firmante en particular—
-- y con esa restricción puesta no se puede guardar ni uno: el insert muere
-- contra un CHECK que se escribió cuando el tercer modo no existía.
--
-- No se «relaja»: se REEMPLAZA por `campo_quien_coherente`, que dice lo mismo
-- para los dos casos viejos y además contempla el nuevo. Dejar las dos sería
-- tener dos definiciones de la misma regla, y la vieja gana en silencio.
--
-- Esto no se detectó antes porque el modo nuevo se probó contra un servidor de
-- mentira, sin base. La lección es la de siempre acá: **una restricción que no
-- se ejerció escribiendo no está probada.**
-- -----------------------------------------------------------------------------
alter table campo drop constraint if exists campo_tiene_dueno;

-- Coherencia con las dos columnas que ya existían. No se sustituyen: se atan,
-- porque el resto del código todavía las lee y dos fuentes que se contradicen
-- son peor que una sola imperfecta.
do $c$ begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.campo'::regclass
                    and conname = 'campo_quien_coherente') then
    alter table campo add constraint campo_quien_coherente check (
         (quien_completa = 'emisor'     and completa_emisor and orden_firmante is null)
      or (quien_completa = 'firmante'   and not completa_emisor and orden_firmante is not null)
      or (quien_completa = 'cualquiera' and not completa_emisor and orden_firmante is null)
    );
  end if;
end $c$;

comment on column campo.quien_completa is
  'emisor | firmante | cualquiera. Con firmante, orden_firmante dice cuál. Con '
  'cualquiera, lo completa el primero que llegue y después nadie lo cambia. '
  'Ver migración 052.';

-- -----------------------------------------------------------------------------
-- 2. Quién puede escribir, con el modo nuevo
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
         (c.quien_completa = 'emisor'
          and i.cuenta_propietaria_id = app.cuenta_actual()
          and app.actor() = 'cuenta'
          and exists (select 1 from public.circuito ci
                       where ci.id = c.circuito_id and ci.estado = 'borrador'))
         or
         -- (b) El firmante al que le toca ese campo, con su turno habilitado y
         --     con derecho a firmar esa instancia. El orden es lo que ata el
         --     campo a la persona; el otorgamiento es lo que la autoriza.
         (c.quien_completa = 'firmante'
          and c.orden_firmante is not null
          and app.tiene_otorgamiento(null, p_instancia, 'firmar')
          and exists (
            select 1 from public.participacion p
             where p.instancia_id = p_instancia
               and p.orden = c.orden_firmante
               and p.identidad_id = any (app.identidades_del_actor())
               and p.estado in ('pendiente','notificada','vista')))
         or
         -- (c) Cualquiera de los firmantes — PERO UNA SOLA VEZ.
         --
         -- ⚠ La segunda condición es la que importa: o el campo está vacío, o lo
         -- escribió quien está escribiendo ahora. Sin eso, el tercer firmante
         -- reescribe en silencio lo que el primero ya leyó y aceptó, y nadie
         -- sabe qué versión se firmó.
         (c.quien_completa = 'cualquiera'
          and app.tiene_otorgamiento(null, p_instancia, 'firmar')
          and exists (
            select 1 from public.participacion p
             where p.instancia_id = p_instancia
               and p.papel = 'firmante'
               and p.identidad_id = any (app.identidades_del_actor())
               and p.estado in ('pendiente','notificada','vista'))
          and not exists (
            select 1 from public.valor_campo v
             where v.campo_id = c.id
               and v.instancia_id = p_instancia
               and v.valor is not null
               and v.completado_por is not null
               and not (v.completado_por = any (app.identidades_del_actor()))))
       )
  )
$$;

revoke all on function app.puede_completar_campo(uuid, uuid) from public;
grant execute on function app.puede_completar_campo(uuid, uuid) to app_rw;

comment on function app.puede_completar_campo(uuid, uuid) is
  'Si el actor puede escribir en ese campo de esa instancia. Tres modos: el '
  'emisor en borrador, el firmante nombrado, o cualquier firmante mientras nadie '
  'más lo haya completado. Ver migraciones 038 y 052.';

commit;

-- =============================================================================
-- CONTROL — el estado, comprobado
-- =============================================================================
do $control$
declare v_mal text := ''; v_n int;
begin
  select count(*) into v_n from information_schema.columns
   where table_name = 'campo' and column_name = 'quien_completa';
  if v_n = 0 then v_mal := v_mal || E'\n  falta la columna quien_completa'; end if;

  select count(*) into v_n from campo where quien_completa is null;
  if v_n > 0 then v_mal := v_mal || format(E'\n  %s campo(s) sin modo', v_n); end if;

  -- Que lo viejo haya quedado bien traducido: ningún campo del emisor marcado
  -- como de firmante, ni al revés.
  select count(*) into v_n from campo
   where (completa_emisor and quien_completa <> 'emisor')
      or (not completa_emisor and orden_firmante is not null and quien_completa <> 'firmante');
  if v_n > 0 then
    v_mal := v_mal || format(E'\n  %s campo(s) con el modo que no coincide con lo que ya tenían', v_n);
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.campo'::regclass and conname = 'campo_quien_coherente') then
    v_mal := v_mal || E'\n  falta campo_quien_coherente';
  end if;

  -- La vieja tiene que estar SACADA: mientras esté, un campo de «cualquiera»
  -- no entra, porque exige que todo campo sea del emisor o de un firmante
  -- nombrado.
  if exists (select 1 from pg_constraint
              where conrelid = 'public.campo'::regclass and conname = 'campo_tiene_dueno') then
    v_mal := v_mal || E'\n  campo_tiene_dueno sigue puesta: el modo cualquiera no se va a poder guardar';
  end if;

  -- Y el trigger tiene que haber quedado PRENDIDO. Se apagó unas líneas más
  -- arriba para poder rellenar la columna; si quedara apagado, cualquiera
  -- podría cambiarle los campos a un documento ya despachado y nadie se
  -- enteraría hasta que un firmante viera otro formulario del que le mandaron.
  if exists (select 1 from pg_trigger
              where tgrelid = 'public.campo'::regclass
                and tgname = 'campo_congelado'
                and tgenabled = 'D') then
    v_mal := v_mal || E'\n  ⚠ el trigger campo_congelado quedó APAGADO';
  end if;

  -- La política tiene que conocer el modo nuevo.
  if position('cualquiera' in (select prosrc from pg_proc
                where proname = 'puede_completar_campo' and pronamespace = 'app'::regnamespace)) = 0 then
    v_mal := v_mal || E'\n  app.puede_completar_campo no conoce el modo cualquiera';
  end if;

  -- ═══ Y AHORA LA PRUEBA DE VERDAD: SE EJERCE ESCRIBIENDO ═══
  --
  -- Todo lo de arriba lee el catálogo, y el catálogo puede estar perfecto
  -- mientras la combinación que importa igual no entra — es exactamente lo que
  -- pasaba con `campo_tiene_dueno`: las tres restricciones nuevas existían y un
  -- campo de «cualquiera» era imposible de guardar.
  --
  -- Así que se guarda uno de verdad, sobre un borrador real, y se borra. Si
  -- algo lo frena, el mensaje de la base dice qué fue.
  declare v_circ uuid; v_cuenta uuid;
  begin
    select c.id, c.cuenta_propietaria_id into v_circ, v_cuenta
      from public.circuito c where c.estado = 'borrador' limit 1;

    if v_circ is null then
      raise notice 'Sin documentos en borrador: no se pudo EJERCER el modo cualquiera. Probalo en la pantalla.';
    else
      begin
        insert into public.campo (circuito_id, cuenta_propietaria_id, codigo, etiqueta_i18n,
                                  tipo, completa_emisor, quien_completa, orden_firmante,
                                  pagina, x, y, ancho, alto)
        values (v_circ, v_cuenta, '__prueba_cualquiera__', '{"es":"prueba"}'::jsonb,
                'texto', false, 'cualquiera', null, 0, 1, 1, 10, 10);

        delete from public.campo
         where circuito_id = v_circ and codigo = '__prueba_cualquiera__';
      exception when others then
        -- El bloque tiene su propio savepoint: el insert se deshizo solo, no
        -- queda nada colgado en el documento de nadie.
        v_mal := v_mal || format(E'\n  un campo de modo «cualquiera» NO se puede guardar: %s', sqlerrm);
      end;
    end if;
  end;

  if v_mal <> '' then
    raise exception E'El modo de completar quedó incompleto:%', v_mal;
  end if;

  raise notice 'Quién completa: tres modos, el de «cualquiera» probado escribiendo, y lo que ya existía traducido.';
end $control$;
