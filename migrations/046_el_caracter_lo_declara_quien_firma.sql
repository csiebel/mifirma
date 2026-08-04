-- =============================================================================
-- MiFirma — 046_el_caracter_lo_declara_quien_firma.sql
--
-- Corrige la 045, que puso la decisión en el lugar equivocado.
--
-- ═══ QUÉ ESTABA MAL ═══
--
-- La 045 dejaba que el EMISOR eligiera con qué carácter firma cada persona, y
-- `app.puede_representar` admitía «la cuenta emisora» para cualquier firmante.
-- O sea que Interfase podía declarar que alguien que no tiene nada que ver con
-- Interfase firmaba en su representación.
--
-- La propia migración decía, textual: «nadie puede declarar en nombre de quién
-- actúa otro». Y a continuación abría exactamente esa puerta, con el argumento
-- de que el documento caía en el repositorio del propio emisor y por lo tanto
-- no había daño a terceros. El argumento es sobre el DAÑO y la regla es sobre
-- la VERDAD: firmar en representación de una empresa es una afirmación sobre
-- quién es esa persona, y esa afirmación no es del que manda el documento.
--
-- ═══ CÓMO QUEDA ═══
--
-- **1. Representar exige membresía, sin excepciones.** Se cae la rama de la
-- cuenta emisora. Si el gerente de Interfase firma por Interfase, es miembro de
-- Interfase y la opción le aparece; si no es miembro, no hay nada que declarar.
--
-- **2. Lo elige el firmante, no el emisor, y en el acto de firmar.** Es la
-- misma regla que ya gobierna la rúbrica: la representación visual y el
-- carácter son las dos cosas que sólo la persona que firma puede aportar. El
-- emisor arma el circuito; quién firma y en nombre de quién lo dice quien pone
-- la firma.
--
-- **3. Y para casi todo el mundo la pregunta no existe.** Sólo aparece si esa
-- persona tiene alguna membresía activa. Quien no pertenece a ninguna empresa
-- del sistema firma a título personal y no se le pregunta nada — que es la
-- verdad de su situación, no un default cómodo.
--
-- Eso último es lo que hace que esta versión no agregue fricción y la anterior
-- sí: la 045 le pedía una decisión al emisor en todos los envíos; ésta le pide
-- una decisión al firmante sólo cuando hay algo real que decidir.
--
-- ⚠ Y por eso se cae el trigger que impedía despachar sin carácter: al
-- despachar todavía NO se sabe, y no se puede saber. Lo que sí queda es que se
-- fije con la firma —después de firmar no se toca— y que los otorgamientos
-- definitivos se emitan recién ahí. Ver `consolidarOtorgamiento` en el código:
-- el derecho a firmar se agota con el acto y en su lugar nace el de conservar,
-- que es el que dura distinto según el carácter.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- 1. Representar exige membresía activa. Punto.
-- -----------------------------------------------------------------------------
create or replace function app.puede_representar(p_identidad uuid, p_cuenta uuid)
returns boolean
language sql stable security definer set search_path = pg_catalog, public
as $$
  select p_cuenta is not null
     and exists (select 1 from public.cuenta c
                  where c.id = p_cuenta and c.tipo = 'empresa' and c.estado <> 'cerrada')
     and exists (select 1 from public.membresia m
                  where m.identidad_id = p_identidad
                    and m.cuenta_id = p_cuenta
                    and m.estado = 'activa'
                    and m.hasta is null)
$$;

comment on function app.puede_representar(uuid, uuid) is
  'Si esa persona puede firmar en representación de esa cuenta: sólo con '
  'membresía activa. Nadie declara en nombre de quién actúa otro, tampoco el '
  'emisor sobre su propia empresa. Ver migración 046.';

-- -----------------------------------------------------------------------------
-- 2. Al despachar todavía no se sabe: se cae la exigencia
--
-- El trigger de la 045 impedía pasar de borrador a enviado sin el carácter
-- elegido. Con la decisión movida al firmante, eso es pedir una respuesta antes
-- de que exista quien pueda darla.
-- -----------------------------------------------------------------------------
drop trigger if exists circuito_caracter_trg on circuito;
drop function if exists circuito_caracter_elegido();

-- -----------------------------------------------------------------------------
-- 3. Lo declara la persona, mientras no haya firmado
--
-- Reemplaza al congelamiento de la 045, que sólo miraba el estado del circuito.
-- Ahora hay dos preguntas y las dos importan:
--
--   · QUIÉN lo cambia — sólo el sujeto de esa participación, o el sistema.
--     El emisor puede tocar otras columnas de la fila (es su circuito) pero no
--     ésta: no es un dato del envío, es una declaración de la persona.
--
--   · HASTA CUÁNDO — hasta que firme. Con la firma se emiten los otorgamientos
--     que dependen del carácter; cambiarlo después sería decir que el documento
--     es de otro sin mover el acceso que ya se dio.
-- -----------------------------------------------------------------------------
create or replace function participacion_caracter_congelado() returns trigger
language plpgsql security definer set search_path = pg_catalog, public
as $$
begin
  if new.caracter is distinct from old.caracter
     or new.cuenta_representada_id is distinct from old.cuenta_representada_id then

    if app.actor() <> 'sistema' then
      -- El sujeto de la participación, y nadie más. Para el firmante externo
      -- `app.identidad_actual()` sale del enlace; para quien tiene cuenta, de
      -- su sesión. En los dos casos es la misma pregunta.
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
