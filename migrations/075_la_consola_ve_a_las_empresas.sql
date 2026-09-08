-- =============================================================================
-- MiFirma — 075_la_consola_ve_a_las_empresas.sql
-- Lo que le falta al operador para administrar una empresa desde la consola.
--
-- ═══ QUÉ SE ROMPIÓ, Y POR QUÉ ═══
--
-- La pantalla de empresas (7/9) devolvía 500 en cada carga. No era un bug del
-- código: `app_operador` no tiene —ni tenía por qué tener— `select` sobre
-- `usuario_rol` ni sobre `archivo`, y la consulta las tocaba directo. La misma
-- piedra de la 073 con `participacion`.
--
-- ═══ LA DECISIÓN: AGREGADOS POR FUNCIÓN, NO TABLAS ABIERTAS ═══
--
-- La forma fácil sería `grant select on archivo, usuario_rol to app_operador`.
-- No se hace. El operador necesita saber CUÁNTOS documentos guarda una empresa
-- —para cobrarle la custodia y para atender un reclamo—, no CUÁLES. Abrir la
-- tabla le daría los títulos, los tamaños y las fechas de los documentos de
-- todos los clientes, que es exactamente lo que un producto de firma no puede
-- ofrecerle a su propio personal.
--
-- Así que el conteo sale por función `security definer`, igual que
-- `app.custodia_usada` (072), que ya cuenta documentos y bytes y por eso acá
-- no se duplica: se usa.
--
-- ═══ Y LO OTRO: NADA CREABA SUSCRIPCIONES ═══
--
-- Hasta hoy la política de escritura de `suscripcion` (013) sólo dejaba pasar a
-- 'sistema', pensando en un flujo de contratación que nunca se construyó. Las
-- dos suscripciones que existen se cargaron a mano por `psql`. Una cuenta que
-- se registra sola quedaba sin plan para siempre — y sin plan no hay
-- prestaciones ni precios, o sea que no se le puede cobrar.
--
-- El operador entra a esa policy. La cuenta sigue sin poder cambiarse el plan
-- sola, que era el punto original de la restricción.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- Cuántos usuarios tiene una empresa
--
-- Una identidad con tres roles es UN usuario: `distinct`. Sin eso, la consola
-- mostraría empresas con más usuarios que personas, que es de los errores que
-- nadie reporta y todos ven.
-- -----------------------------------------------------------------------------
create or replace function app.usuarios_de_cuenta(p_cuenta uuid)
returns bigint
language sql stable security definer set search_path = pg_catalog, public
as $$
  select count(distinct ur.identidad_id)::bigint
    from public.usuario_rol ur
   where ur.cuenta_id = p_cuenta;
$$;
comment on function app.usuarios_de_cuenta(uuid) is
  'Cuántas personas distintas tienen algún rol en la cuenta. security definer: el '
  'operador cuenta usuarios sin poder listar `usuario_rol`. Migración 075.';
revoke all on function app.usuarios_de_cuenta(uuid) from public;
grant execute on function app.usuarios_de_cuenta(uuid) to app_rw, app_operador;

-- -----------------------------------------------------------------------------
-- El operador puede contratarle un plan a una empresa
-- -----------------------------------------------------------------------------
drop policy if exists suscripcion_escritura on suscripcion;
create policy suscripcion_escritura on suscripcion for all
  using      (app.actor() in ('sistema','operador'))
  with check (app.actor() in ('sistema','operador'));

-- ⚠ Sin `delete`: una suscripción no se borra, se cancela. Es lo que permite
-- contestar «en qué plan estaba esta empresa en marzo», que es la pregunta de
-- cualquier reclamo de facturación.
grant insert, update on suscripcion to app_operador;

-- -----------------------------------------------------------------------------
-- Centinelas
--
-- Lo que esta migración NO debe haber hecho. Si alguien mañana resuelve un 500
-- con un `grant select on archivo`, estas líneas lo frenan acá y no en la
-- auditoría.
-- -----------------------------------------------------------------------------
do $centinela$
declare v_t text;
begin
  foreach v_t in array array['archivo', 'usuario_rol'] loop
    if exists (select 1 from information_schema.role_table_grants
                where table_name = v_t and grantee = 'app_operador') then
      raise exception 'El operador no mira % de los clientes: los agregados van por función', v_t;
    end if;
  end loop;

  if exists (select 1 from information_schema.role_table_grants
              where table_name = 'suscripcion' and grantee = 'app_operador'
                and privilege_type = 'DELETE') then
    raise exception 'Una suscripción no se borra: se cancela';
  end if;
end $centinela$;

commit;
