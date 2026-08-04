-- =============================================================================
-- MiFirma — 045_caracter_de_la_firma.sql
--
-- Con qué carácter firma cada persona: a título personal, o en representación
-- de una empresa. Implementa `propiedad-y-otorgamientos.md` §7.2, que estaba
-- diseñado, tenía todas sus columnas creadas desde la 006 y la 008, y **no lo
-- usaba nadie**: las cuatro participaciones que existen dicen 'personal'
-- porque ése era el default, no porque alguien lo haya elegido.
--
-- ═══ POR QUÉ NO SE PUEDE DEJAR PARA DESPUÉS ═══
--
-- Porque decide A QUÉ REPOSITORIO PERTENECE EL DOCUMENTO, y eso **no se puede
-- deducir más tarde**. Un contrato de trabajo lo firma el empleado a título
-- personal: se lo lleva cuando se va, y legalmente eso no es opcional, es su
-- prueba de qué firmó. Un contrato comercial lo firma el gerente en
-- representación: el documento es de la empresa, y el gerente que se va deja
-- de verlo.
--
-- Los otorgamientos se emiten en el despacho y no se re-emiten hacia atrás. Un
-- documento firmado con el carácter equivocado queda mal para siempre.
--
-- ═══ LAS DOS DECISIONES QUE PEDÍA EL DISEÑO, TOMADAS EL 3/8 ═══
--
-- **1. El apoderado que se va conserva el registro, no el PDF.** El contenido
-- de un contrato comercial es un activo de la empresa. Conserva su fila de
-- `participacion` —sabe que el 3 de marzo firmó tal contrato por tal empresa—
-- y la evidencia de sus propios actos. Pierde el contenido.
--
-- Eso se implementa solo, sin ningún proceso de limpieza que pueda fallar: el
-- otorgamiento a la identidad lleva `condicionado_a_cuenta_id` y
-- `app.tiene_otorgamiento` comprueba la membresía activa **en cada
-- evaluación**. El día que termina la membresía, deja de ver el documento. No
-- hay trabajo nocturno que pueda olvidarse de correr.
--
-- ⚠ Y el CHECK `otorgamiento_irrevocable_sin_vencimiento` ya impedía que un
-- otorgamiento condicionado fuera irrevocable. O sea que el esquema **ya
-- contradecía** la otra respuesta: la 008 tomó partido antes que nosotros.
--
-- **2. Se elige por firmante y es obligatorio.** El diseño dice, textual, que
-- «no hay default seguro»: con 'personal' por omisión el ex-empleado se lleva
-- copia de todo lo que firmó; con 'representacion' alguien pierde su propio
-- contrato de trabajo justo cuando renuncia. Así que se saca el default y no
-- se puede despachar hasta que esté elegido para cada firmante.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- 1. «Todavía no lo eligieron» tiene que ser representable
--
-- Con `default 'personal' not null` no hay forma de distinguir «esta persona
-- firma a título personal» de «nadie lo miró». Son dos cosas distintas y la
-- segunda tiene que poder frenar el despacho.
-- -----------------------------------------------------------------------------
alter table participacion alter column caracter drop default;
alter table participacion alter column caracter drop not null;

-- Coherencia: representar es representar A ALGUIEN.
--
-- ⚠ Y no a cualquiera: tiene que ser una cuenta del sistema, porque el punto
-- de la representación es que el documento aterrice en el repositorio de esa
-- empresa. Si la empresa no existe acá, no hay dónde aterrizar y llamarlo
-- representación sería una etiqueta sin consecuencia.
alter table participacion add constraint participacion_caracter_coherente
  check (
    caracter is null
    or (caracter = 'personal'      and cuenta_representada_id is null)
    or (caracter = 'representacion' and cuenta_representada_id is not null)
  );

comment on column participacion.caracter is
  'personal | representacion | null (todavía no se eligió). Decide a qué '
  'repositorio pertenece el documento y no se puede deducir después. Ver 045.';

-- -----------------------------------------------------------------------------
-- 2. A quién se puede decir que se representa
--
-- No es libre: si lo fuera, cualquier cuenta podría meter documentos en el
-- repositorio de un tercero con sólo nombrarlo. Se admite:
--
--   · la cuenta emisora — «nuestro gerente firma en nuestro nombre», que es el
--     caso más común y el único que el emisor puede afirmar con conocimiento;
--   · una cuenta de la que ESA PERSONA sea miembro activo — porque entonces la
--     afirmación es comprobable contra un hecho del sistema, no contra la
--     palabra de quien arma el circuito.
--
-- ⚠ Lo que queda afuera a propósito: que Interfase declare que María, de otra
-- empresa que no usa MiFirma, firma en representación de esa empresa. Nadie
-- puede declarar en nombre de quién actúa otro. Cuando esa empresa sea cliente
-- y María sea miembro, se puede; hasta entonces María firma a título personal
-- y el documento queda en su repositorio, que es la verdad de lo que hay.
-- -----------------------------------------------------------------------------
create or replace function app.puede_representar(p_identidad uuid, p_cuenta uuid)
returns boolean
language sql stable security definer set search_path = pg_catalog, public
as $$
  select p_cuenta is not null
     and exists (select 1 from public.cuenta c
                  where c.id = p_cuenta and c.tipo = 'empresa' and c.estado <> 'cerrada')
     and (
       p_cuenta = app.cuenta_actual()
       or exists (select 1 from public.membresia m
                   where m.identidad_id = p_identidad
                     and m.cuenta_id = p_cuenta
                     and m.estado = 'activa'
                     and m.hasta is null)
     )
$$;

revoke all on function app.puede_representar(uuid, uuid) from public;
grant execute on function app.puede_representar(uuid, uuid) to app_rw;

comment on function app.puede_representar(uuid, uuid) is
  'Si esa persona puede firmar en representación de esa cuenta: la emisora, o '
  'una donde tenga membresía activa. Nadie declara en nombre de quién actúa '
  'otro. Ver migración 045.';

-- -----------------------------------------------------------------------------
-- 3. El carácter se congela con el despacho, igual que el orden
--
-- Después de despachar hay otorgamientos emitidos que dependen de él. Cambiarlo
-- sería decir que el documento pertenece a otro sin mover el acceso que ya se
-- dio: la fila diría una cosa y los permisos otra.
-- -----------------------------------------------------------------------------
create or replace function participacion_caracter_congelado() returns trigger
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_estado text;
begin
  if new.caracter is distinct from old.caracter
     or new.cuenta_representada_id is distinct from old.cuenta_representada_id then
    select c.estado into v_estado from public.circuito c where c.id = new.circuito_id;
    if v_estado <> 'borrador' then
      raise exception
        'el documento ya se despachó: el carácter de la firma no se cambia, porque '
        'los otorgamientos ya se emitieron según él'
        using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

create trigger participacion_caracter_trg before update on participacion
  for each row execute function participacion_caracter_congelado();

-- -----------------------------------------------------------------------------
-- 4. No se despacha sin elegirlo
--
-- ⚠ Va acá y no en el servicio, y es la parte que importa de esta migración.
-- El servicio lo va a comprobar también —para dar un mensaje que se entienda—
-- pero la regla vive donde no se puede saltear: el día que un lote, un script
-- de soporte o la API despachen un circuito, la pregunta sigue siendo
-- obligatoria.
--
-- Sólo se exige a los FIRMANTES. Una copia informativa no firma nada, así que
-- no hay carácter que elegir.
-- -----------------------------------------------------------------------------
create or replace function circuito_caracter_elegido() returns trigger
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_faltan int;
begin
  if new.estado = 'enviado' and old.estado = 'borrador' then
    select count(*) into v_faltan
      from public.participacion p
     where p.circuito_id = new.id
       and p.papel = 'firmante'
       and p.caracter is null;

    if v_faltan > 0 then
      raise exception
        'faltan % firmante(s) sin decidir si firman a título personal o en '
        'representación de una empresa. Es lo que decide a qué repositorio '
        'pertenece el documento y no se puede corregir después.', v_faltan
        using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

create trigger circuito_caracter_trg before update on circuito
  for each row execute function circuito_caracter_elegido();

commit;

-- Centinela de la 026.
do $centinela$
declare v_expr text; v_tabla text; v_pol text; v_mal text := '';
begin
  for v_tabla, v_pol, v_expr in
    select c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid)
      from pg_policy p join pg_class c on c.oid = p.polrelid
     where p.polcmd in ('r','*')
       and has_table_privilege('app_operador', c.oid, 'select')
  loop
    if v_expr ~ '(^|[^a-z_])(circuito|instancia|ubicacion|archivo|participacion|otorgamiento|marca_firma|firma_visual|certificado_finalizacion|registro_pendiente|campo|valor_campo)([^a-z_]|$)' then
      v_mal := v_mal || format(E'\n  %s.%s', v_tabla, v_pol);
    end if;
  end loop;
  if v_mal <> '' then
    raise exception E'Políticas que nombran tablas del dominio y le cobran el GRANT a app_operador:%s', v_mal;
  end if;
end $centinela$;

-- Centinela del archivo invisible (043).
do $centinela_archivo$
declare v_texto text; v_previo text := ''; v_col text; v_tabla text; v_mal text := ''; v_vuelta int := 0;
begin
  select pg_get_expr(p.polqual, p.polrelid) into v_texto
    from pg_policy p join pg_class c on c.oid = p.polrelid
   where c.relname = 'archivo' and p.polname = 'archivo_select';
  while v_texto <> v_previo and v_vuelta < 4 loop
    v_previo := v_texto; v_vuelta := v_vuelta + 1;
    select v_texto || ' ' || coalesce(string_agg(pg_get_functiondef(pr.oid), ' '), '') into v_texto
      from pg_proc pr where pr.pronamespace = 'app'::regnamespace
       and position('app.' || pr.proname || '(' in v_previo) > 0;
  end loop;
  for v_tabla, v_col in
    select con.conrelid::regclass::text, a.attname from pg_constraint con
      join unnest(con.conkey) k on true
      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k
     where con.contype = 'f' and con.confrelid = 'public.archivo'::regclass
  loop
    if position(v_col in v_texto) = 0 then
      v_mal := v_mal || format(E'\n  %s.%s', v_tabla, v_col);
    end if;
  end loop;
  if v_mal <> '' then
    raise exception E'Columnas que apuntan a archivo y que archivo_select no alcanza:%s', v_mal;
  end if;
end $centinela_archivo$;
