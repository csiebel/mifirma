-- =============================================================================
-- MiFirma — 036_registro_verificado.sql
--
-- Tres cosas que salieron de mirar el alta self-service el 3/8/2026:
--
--   1. El registro pasa a dos pasos: nada se crea hasta que se prueba el correo.
--   2. Una identidad tiene UNA cuenta persona, y ahora lo dice la base.
--   3. Qué plan recibe una cuenta nueva lo decide el operador, no el código.
--
-- ═══ POR QUÉ EL REGISTRO EN DOS PASOS, Y POR QUÉ AHORA ═══
--
-- `/auth/registro` es público y no probaba el correo. Con eso, cualquiera podía
-- registrarse **con el correo de otro**, y eso disparaba tres cosas:
--
--   · una cuenta de tipo persona con la víctima como `identidad_titular_id`;
--   · el relleno de la bandeja, que le inserta una `ubicacion` por CADA
--     otorgamiento que esa persona tenga —o sea, por cada documento que firmó
--     en su vida—;
--   · una sesión emitida a nombre de esa identidad, y si la víctima era una
--     identidad latente (invitada a firmar, sin contraseña), le quedaba fijada
--     la contraseña de quien se registró.
--
-- ⚠ NO había filtración de documentos, y conviene entender por qué: la sesión
-- del alta nace **sin anclaje probado**, y `app.tiene_otorgamiento` exige
-- `app.identidad_probada()` contra el anclaje con el que se emitió. Sin acceso a
-- esa casilla no se prueba nada y no se ve nada. Las ubicaciones quedaban como
-- filas apuntando a documentos que esa sesión no podía leer.
--
-- O sea: la aplicación entregó una sesión que no debía y la capa de datos no se
-- enteró porque no le importa. Es la regla de oro nº2 haciendo exactamente lo
-- que se diseñó que hiciera. No es excusa para dejarlo así.
--
-- El TODO ya estaba escrito en `auth.ts` desde el principio —«verificación del
-- correo antes de crear la cuenta»—. Lo que cambió es que el relleno de la
-- bandeja lo volvió urgente: antes se creaba una cuenta vacía, ahora se toca
-- el repositorio de otra persona.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- 1. El alta que todavía no ocurrió
--
-- Guarda lo que se pidió, no lo que se creó. Mientras esta fila existe no hay
-- cuenta, ni membresía, ni roles, ni carpetas, ni sesión: sólo una identidad
-- latente —la misma que ya crea cualquier invitación a firmar— y un token que
-- viajó por correo.
--
-- ⚠ NO guarda la contraseña, ni siquiera con hash. La elige quien abre el
-- enlace, o sea quien demostró leer esa casilla. Que la preseleccione quien
-- llenó el formulario sería dejar que un tercero elija la contraseña de la
-- cuenta de otro.
-- -----------------------------------------------------------------------------
create table registro_pendiente (
  id                uuid primary key default gen_random_uuid(),

  -- El token es el que manda: si vence o se usa, este alta ya no se puede
  -- confirmar. Con `on delete cascade` la limpieza de tokens se lleva esto.
  token_acceso_id   uuid not null unique references token_acceso(id) on delete cascade,
  identidad_id      uuid not null references identidad(id),

  -- Lo que se completó en el formulario: nombre, tipo, país, razón social,
  -- identificación fiscal, domicilio, industria. Va como jsonb porque es la
  -- entrada de `provisionarCuenta` y no una entidad del dominio: si mañana el
  -- formulario pide un campo más, no hay migración.
  datos             jsonb not null,

  creado_en         timestamptz not null default now(),
  ip_solicitud      inet
);

create index registro_pendiente_por_identidad on registro_pendiente (identidad_id);

comment on table registro_pendiente is
  'Un alta pedida y todavía no confirmada. Sin cuenta, sin sesión y sin '
  'contraseña hasta que se prueba el correo. Ver migración 036.';

-- ⚠ Contiene datos personales de alguien que quizá nunca confirme: nombre,
-- país, a veces razón social y domicilio. Vive lo que vive su token y se va con
-- él. La limpieza de `token_acceso` vencidos tiene que existir; hasta que exista,
-- esto crece.
alter table registro_pendiente enable row level security;

-- Sólo el sistema. Ningún actor de cliente ni el operador tienen nada que hacer
-- acá: es un dato de tránsito del alta, no contenido de nadie todavía.
create policy registro_pendiente_sistema on registro_pendiente
  using (app.actor() = 'sistema') with check (app.actor() = 'sistema');

grant select, insert, delete on registro_pendiente to app_rw;
-- Sin GRANT a app_operador. Mismo criterio que el resto: el operador no lee
-- contenido de clientes, y un alta a medio hacer ya trae nombre y domicilio.

-- -----------------------------------------------------------------------------
-- 2. Una identidad, UNA cuenta persona
--
-- `ubicarEnBandeja()` dice «la cuenta persona del firmante», en singular, y su
-- consulta no lleva LIMIT: con dos cuentas persona para la misma identidad, el
-- mismo documento aparecería en dos repositorios, los dos suyos, sin forma de
-- decir cuál es el bueno.
--
-- Era un supuesto escrito en un comentario y en ningún otro lado. Lección 10:
-- lo que el diseño da por sentado y el código no obliga deja de ser cierto en
-- algún momento, y nadie se entera hasta que duele.
--
-- Se excluyen las cerradas: alguien puede cerrar su cuenta personal y abrir
-- otra, y eso es legítimo.
-- -----------------------------------------------------------------------------

-- ⚠ Primero se comprueba que los datos EXISTENTES cumplan la regla, y se aborta
-- con el detalle si no. Un índice creado sobre datos que lo violan simplemente
-- falla con un mensaje que no dice quién; y si no fallara, protegería de lo que
-- venga dejando adentro lo que ya estaba mal. Mismo patrón que la 032.
do $control$
declare v_mal text;
begin
  select string_agg(format(E'\n  identidad %s → %s cuentas persona', identidad_titular_id, n), '')
    into v_mal
    from (select identidad_titular_id, count(*) as n
            from public.cuenta
           where tipo = 'persona' and estado <> 'cerrada'
           group by identidad_titular_id
          having count(*) > 1) t;

  if v_mal is not null then
    raise exception E'Hay identidades con más de una cuenta persona activa. Resolvelas antes de correr esto:%s', v_mal;
  end if;
end $control$;

create unique index cuenta_persona_unica
  on cuenta (identidad_titular_id)
  where tipo = 'persona' and estado <> 'cerrada';

-- -----------------------------------------------------------------------------
-- 3. Qué plan recibe una cuenta nueva
--
-- Decidido con Claudio el 3/8: **lo define el operador por país y plan**, no el
-- producto. Así que el plan lleva para quién es y cuál se asigna solo; el precio
-- por país ya vive en `precio_metrica` y no se toca.
--
-- Sin plan por defecto configurado, una cuenta nueva nace con `plan_id` nulo,
-- que es lo que pasa hoy y es correcto para una cuenta que sólo recibe: no
-- despacha nada, así que no dispara ninguna métrica de cobro.
-- -----------------------------------------------------------------------------
alter table plan
  add column para_tipo   text not null default 'empresa'
                           check (para_tipo in ('empresa','persona')),
  add column por_defecto boolean not null default false;

-- Uno solo por tipo. Si el operador marca otro, tiene que desmarcar el anterior:
-- que el sistema elija en silencio entre dos «por defecto» es peor que negarse.
create unique index plan_por_defecto_uq on plan (para_tipo) where por_defecto;

comment on column plan.para_tipo is
  'A qué clase de cuenta se le ofrece este plan. Un plan de empresa no aparece '
  'en la página de una persona y viceversa.';
comment on column plan.por_defecto is
  'El plan que recibe una cuenta nueva de ese tipo, si el operador definió uno.';

/**
 * El plan que le toca a una cuenta nueva, o NULL si el operador no definió
 * ninguno para ese tipo.
 *
 * Es una función y no una consulta suelta en la aplicación para que la regla
 * viva en un lugar solo: la va a necesitar el alta, el operador al mostrar el
 * catálogo, y la página pública de precios.
 */
create or replace function app.plan_por_defecto(p_tipo text) returns uuid
language sql stable security definer set search_path = pg_catalog, public as $$
  select p.id from public.plan p
   where p.para_tipo = p_tipo and p.por_defecto and p.activo
   limit 1;
$$;

revoke all on function app.plan_por_defecto(text) from public;
grant execute on function app.plan_por_defecto(text) to app_rw;

commit;

-- Centinela de la 026: se agregó una tabla con política nueva. Que no nombre
-- tablas del dominio en una política que el operador pueda leer.
do $centinela$
declare v_expr text; v_tabla text; v_pol text; v_mal text := '';
begin
  for v_tabla, v_pol, v_expr in
    select c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid)
      from pg_policy p join pg_class c on c.oid = p.polrelid
     where p.polcmd in ('r','*')
       and has_table_privilege('app_operador', c.oid, 'select')
  loop
    if v_expr ~ '(^|[^a-z_])(circuito|instancia|ubicacion|archivo|participacion|otorgamiento|marca_firma|certificado_finalizacion|registro_pendiente)([^a-z_]|$)' then
      v_mal := v_mal || format(E'\n  %s.%s', v_tabla, v_pol);
    end if;
  end loop;
  if v_mal <> '' then
    raise exception E'Políticas que nombran tablas del dominio y le cobran el GRANT a app_operador:%s', v_mal;
  end if;
end $centinela$;
