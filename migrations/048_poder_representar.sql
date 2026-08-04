-- =============================================================================
-- MiFirma — 048_poder_representar.sql
--
-- Firmar en nombre de la empresa es un PODER, no una consecuencia de trabajar
-- ahí.
--
-- ═══ EL AGUJERO QUE CIERRA ═══
--
-- La 046 dejó `app.puede_representar` en «membresía activa». Suena razonable
-- hasta que se piensa el caso real: una empresa manda un contrato a sus treinta
-- empleados. Los treinta son miembros. Con esa regla, **los treinta podrían
-- declarar que firman en nombre de la empresa** — y uno de ellos firmando así
-- un contrato que lo obliga a él es lo de menos: el problema es que la empresa
-- queda dicha por cualquiera de sus empleados.
--
-- Ser empleado no es tener poder para obligar a la empresa. Son dos hechos
-- distintos y sólo uno de los dos lo decide el administrador.
--
-- ═══ POR QUÉ UNA CAPACIDAD Y NO UNA TABLA NUEVA ═══
--
-- Porque el chasis ya tiene el mecanismo entero —`capacidad`, `rol_capacidad`,
-- `usuario_rol`, y la pantalla de Roles donde el administrador reparte las
-- otras quince— y esto es exactamente lo mismo: algo que una persona puede o no
-- puede hacer adentro de una cuenta. Inventar un sistema paralelo de permisos
-- para un solo permiso es cómo se terminan teniendo dos.
--
-- ⚠ Lo que una capacidad NO responde es «¿podía ESE DÍA?», que es la pregunta
-- que se hace tres años después cuando alguien discute el contrato. Una
-- capacidad dice qué es cierto hoy. Eso **no se resuelve en el esquema de
-- permisos**: se resuelve en el expediente, anotando en el momento de declarar
-- por qué esa persona podía —qué rol tenía y desde cuándo—. Así el documento se
-- explica solo aunque el rol se borre después. Lo hace `declararCaracter`.
--
-- El poder con fechas, límites de monto y tipo de documento es una capa
-- distinta y llega cuando el abogado diga qué tiene que contener para ser
-- oponible en cada país. Esto no lo estorba: la capacidad queda como la puerta
-- y el poder, el día que exista, como su fundamento.
--
-- ═══ A QUIÉN SE LA DAMOS AL CREAR UNA CUENTA ═══
--
-- Sólo al administrador, y con eso a nadie más: `crearRolesBase` la agrega al
-- rol `admin` y no al de `emisor`. Quien abre la cuenta es el que puede
-- representarla, y él decide a quién más. Un emisor manda documentos; que pueda
-- mandarlos no dice nada sobre si puede obligar a la empresa, y hasta hoy esas
-- dos cosas venían juntas sin que nadie lo hubiera decidido.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

insert into capacidad (recurso, accion, descripcion_i18n) values
  ('empresa', 'representar',
   '{"es": "Firmar documentos en nombre de la empresa",
     "en": "Sign documents on behalf of the company",
     "pt": "Assinar documentos em nome da empresa"}'::jsonb)
on conflict do nothing;

-- A los administradores de las cuentas que YA existen. No a los emisores: el
-- que puede mandar documentos no necesariamente puede obligar a la empresa, y
-- dárselo por parecido sería tomar por ellos una decisión que es suya.
insert into rol_capacidad (rol_id, capacidad_id)
select r.id, c.id
  from rol r
  join capacidad c on c.recurso = 'empresa' and c.accion = 'representar'
 where r.codigo = 'admin'
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- La capacidad DE OTRA PERSONA en OTRA cuenta
--
-- `app.tiene_capacidad` responde por el actor de la sesión en la cuenta actual,
-- que es lo que hace falta casi siempre. Acá la pregunta es distinta: la hace un
-- firmante externo —que no tiene sesión de cuenta ninguna— sobre sí mismo en una
-- empresa donde es miembro. Hace falta la versión con sujeto explícito.
-- -----------------------------------------------------------------------------
create or replace function app.capacidad_de(
  p_identidad uuid, p_cuenta uuid, p_recurso text, p_accion text
) returns boolean
language sql stable security definer set search_path = pg_catalog, public
as $$
  select exists (
    select 1
      from public.usuario_rol ur
      join public.rol_capacidad rc on rc.rol_id = ur.rol_id
      join public.capacidad c on c.id = rc.capacidad_id
     where ur.identidad_id = p_identidad
       and ur.cuenta_id = p_cuenta
       and c.recurso = p_recurso
       and c.accion = p_accion
  )
$$;

revoke all on function app.capacidad_de(uuid, uuid, text, text) from public;
grant execute on function app.capacidad_de(uuid, uuid, text, text) to app_rw;

comment on function app.capacidad_de(uuid, uuid, text, text) is
  'Si esa identidad tiene esa capacidad en esa cuenta. Versión con sujeto '
  'explícito de app.tiene_capacidad, para preguntar por alguien que no es el '
  'actor de la sesión. Ver migración 048.';

-- -----------------------------------------------------------------------------
-- Representar exige las DOS cosas
--
-- La membresía dice que pertenece; la capacidad, que puede hablar por ella. Se
-- necesitan las dos y ninguna implica la otra: un empleado sin poder pertenece
-- y no puede; un apoderado al que se le termina el vínculo deja de pertenecer y
-- deja de poder, aunque nadie le saque el rol.
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
     and app.capacidad_de(p_identidad, p_cuenta, 'empresa', 'representar')
$$;

comment on function app.puede_representar(uuid, uuid) is
  'Membresía activa Y capacidad empresa.representar. Ser empleado no es tener '
  'poder para obligar a la empresa. Ver migración 048.';

commit;

-- -----------------------------------------------------------------------------
-- Control: que la capacidad haya quedado y que un miembro común NO represente
-- -----------------------------------------------------------------------------
do $control$
declare v_n int;
begin
  select count(*) into v_n from capacidad where recurso = 'empresa' and accion = 'representar';
  if v_n <> 1 then raise exception 'no quedó la capacidad empresa.representar'; end if;

  select count(*) into v_n
    from rol r join rol_capacidad rc on rc.rol_id = r.id
    join capacidad c on c.id = rc.capacidad_id
   where c.recurso = 'empresa' and c.accion = 'representar' and r.codigo <> 'admin';
  if v_n > 0 then
    raise exception 'la capacidad de representar quedó en % rol(es) que no son admin', v_n;
  end if;
end $control$;
