-- =============================================================================
-- MiFirma — 070_entrar_con_identidad.sql
-- Que una persona pueda ENTRAR al producto con su identidad digital.
--
-- ═══ POR QUÉ UNA TABLA NUEVA Y NO LAS COLUMNAS QUE YA ESTÁN ═══
--
-- `credencial` (003) tiene `idp_externo` e `idp_sujeto` con un unique sobre el
-- par, esperando desde hace sesenta y siete migraciones. Nadie las escribió
-- nunca. Alcanzarían para UN proveedor por persona — y no alcanzan:
--
--   · El día que en Uruguay convivan tuID y Abitab (la UCE acredita a los dos),
--     una misma persona puede tener las dos identidades y querer entrar con
--     cualquiera.
--   · Alguien que opera en Uruguay y Brasil tiene tuID y gov.br.
--   · `credencial` es UNA fila por identidad: dos proveedores no entran.
--
-- Medido el 6/9 al diseñar esto, y anotado como deuda 88 antes de construir.
-- Se decide ANTES porque migrar una vinculación existente a otra tabla es caro,
-- y no tener ninguna todavía hace que hoy sea gratis.
--
-- Las columnas viejas NO se borran: se marcan como muertas con un comentario.
-- Están vacías en producción (verificado), pero borrar columnas de la tabla de
-- credenciales en la misma migración que estrena el mecanismo nuevo es apostar
-- dos cosas a una sola vuelta.
--
-- ═══ LAS DOS REGLAS QUE VIVEN EN LA BASE ═══
--
--   1. Un SUJETO de un proveedor pertenece a UNA sola identidad. Es la hermana
--      de `anclaje_documento_uq` (003), que dice lo mismo de las cédulas, y por
--      el mismo motivo: si el sujeto de tuID de una persona pudiera estar
--      vinculado a dos cuentas, entrar con esa identidad sería ambiguo — y el
--      producto tendría que ADIVINAR a cuál entrar. La base no lo permite.
--
--   2. Una persona tiene a lo sumo UNA vinculación vigente por proveedor. No
--      es una limitación: es que dos filas «yo con tuID» no significan nada
--      distinto de una, y dos hacen que revocar una deje la otra viva.
--
-- Las dos son índices únicos PARCIALES, `where revocada_en is null`: una
-- vinculación revocada no estorba a la nueva. Desvincular y volver a vincular
-- tiene que poder hacerse las veces que haga falta, y la historia queda.
--
-- ═══ POR QUÉ SE REVOCA Y NO SE BORRA ═══
--
-- Mismo criterio que el acuerdo de exclusividad (067) y que los anclajes: la
-- vinculación estuvo vigente y con ella alguien entró al sistema. Borrar la fila
-- haría que el sistema no pudiera contestar «con qué identidad entraba esta
-- persona en marzo», que es exactamente la pregunta de una auditoría.
--
-- ⚠ Y una distinción que NO hay que perder: esta tabla es para ENTRAR. La
-- prueba de identidad que el motor de firma consulta vive en
-- `anclaje_identidad` y la escribe la verificación del firmante (069). Son dos
-- hechos distintos: «esta persona usa tuID para entrar» no es «esta persona
-- probó su cédula ante tuID el día que firmó». Mezclarlas haría que una
-- vinculación de hace un año pareciera una prueba de hoy — que es la decisión
-- T8 del 5/9, escrita en `tuid_identidad.ts`, y sigue en pie.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- 1. La vinculación
-- -----------------------------------------------------------------------------
create table if not exists credencial_idp (
  id                uuid primary key default gen_random_uuid(),
  identidad_id      uuid not null references identidad(id),
  proveedor_id      uuid not null references proveedor_firma(id),

  -- El identificador estable del titular EN el proveedor (`sub` de OIDC). No es
  -- el correo ni la cédula: es lo único que el proveedor promete no reciclar.
  idp_sujeto        text not null,

  -- Para mostrarle a la persona con qué cuenta quedó vinculada, sin guardar la
  -- cédula acá: eso vive en `anclaje_identidad` y no se duplica.
  mostrado          text,

  vinculada_en      timestamptz not null default now(),
  -- Quién estaba en sesión al vincular. Es siempre la propia persona (se vincula
  -- desde adentro, decisión del 6/9), pero se guarda porque el día que exista
  -- vinculación asistida por un administrador, la diferencia importa.
  vinculada_por     uuid references identidad(id),

  revocada_en       timestamptz,
  revocada_por      uuid references identidad(id),

  ultimo_acceso_en  timestamptz
);

comment on table credencial_idp is
  'Con qué identidades digitales externas puede ENTRAR una persona. No es prueba de identidad para firmar: eso es anclaje_identidad (069).';

-- Regla 1: un sujeto del proveedor = una identidad.
create unique index if not exists credencial_idp_sujeto_uq
  on credencial_idp (proveedor_id, idp_sujeto)
  where revocada_en is null;

-- Regla 2: una vinculación vigente por persona y proveedor.
create unique index if not exists credencial_idp_persona_uq
  on credencial_idp (identidad_id, proveedor_id)
  where revocada_en is null;

create index if not exists credencial_idp_identidad_ix
  on credencial_idp (identidad_id) where revocada_en is null;

-- Las columnas de la 003 quedan, marcadas.
comment on column credencial.idp_externo is
  'MUERTA desde la 070: la vinculación federada vive en credencial_idp, que admite varios proveedores por persona. Nunca se escribió.';
comment on column credencial.idp_sujeto is
  'MUERTA desde la 070: ver credencial_idp. Nunca se escribió.';

-- -----------------------------------------------------------------------------
-- 2. A quién le pertenece un sujeto — la consulta del login
--
-- ⚠ SECURITY DEFINER, y es la decisión delicada de esta migración.
--
-- El login ocurre SIN sesión: no hay `app.identidad_id` en el contexto, así que
-- ninguna política basada en la identidad del actor puede dejar ver la fila que
-- hace falta para saber quién está entrando. Es el mismo problema que resuelve
-- `app.proveedores_habilitados` (067) y por eso se resuelve igual.
--
-- Lo que la hace segura no es quién la llama sino QUÉ CONTESTA: recibe un
-- sujeto y devuelve una identidad, nada más. No enumera, no lista, no acepta
-- comodines. Para usarla hay que saber ya el `sub` que el proveedor acaba de
-- confirmar en una vuelta OAuth firmada — es decir, hay que haber probado ser
-- esa persona ante el proveedor. Sin eso no devuelve nada.
-- -----------------------------------------------------------------------------
create or replace function app.identidad_por_idp(p_proveedor uuid, p_sujeto text)
returns uuid
language sql stable security definer set search_path = pg_catalog, public
as $$
  select c.identidad_id
    from public.credencial_idp c
    join public.identidad i on i.id = c.identidad_id
   where c.proveedor_id = p_proveedor
     and c.idp_sujeto = p_sujeto
     and c.revocada_en is null
     and i.estado = 'activa'
   limit 1
$$;

revoke all on function app.identidad_por_idp(uuid, text) from public;
grant execute on function app.identidad_por_idp(uuid, text) to app_rw;

-- -----------------------------------------------------------------------------
-- 3. RLS
--
-- Cada persona ve y administra SUS vinculaciones, y sólo las suyas.
-- `app.identidades_del_actor()` en vez de `app.identidad_actual()` a propósito:
-- contempla las identidades fusionadas (003), igual que el resto del sistema.
--
-- ⚠ El operador NO aparece. No es un olvido: con qué identidad digital entra
-- una persona es dato de esa persona, no del proveedor del SaaS. El operador
-- administra el catálogo de proveedores (067), no las vinculaciones de la gente.
-- Si algún día hace falta soporte («no puedo entrar»), se resuelve con una
-- función acotada que revoque, no dándole lectura sobre todas las filas.
-- -----------------------------------------------------------------------------
alter table credencial_idp enable row level security;

drop policy if exists credencial_idp_select on credencial_idp;
create policy credencial_idp_select on credencial_idp for select using (
     app.actor() = 'sistema'
  or identidad_id = any(app.identidades_del_actor())
);

drop policy if exists credencial_idp_insert on credencial_idp;
create policy credencial_idp_insert on credencial_idp for insert with check (
     app.actor() = 'sistema'
  or identidad_id = any(app.identidades_del_actor())
);

-- Revocar es un update, y sólo sobre lo propio. No hay delete: ver la cabecera.
--
-- ⚠⚠ EL `with check` NO ES DECORATIVO, y por poco no está.
--
-- `using` decide qué filas se pueden tocar; `with check`, cómo pueden quedar.
-- Sin el segundo, alguien puede tomar SU PROPIA vinculación —que `using` le
-- permite tocar— y en el mismo update cambiarle `identidad_id` al de otra
-- persona. La fila entra siendo propia y sale siendo ajena: se regala una
-- identidad digital a otra cuenta, o se le roba a alguien la suya.
--
-- Apareció saboteando la política de update a `using (true)` y viendo que el
-- banco NO lo delataba: la política de SELECT lo tapaba, porque el `where` de un
-- update sólo alcanza filas visibles. Es decir, esta política estaba protegida
-- POR ACCIDENTE por otra — y el día que alguien afloje la de select para dar
-- soporte, ésta queda abierta sin que nadie se entere.
drop policy if exists credencial_idp_update on credencial_idp;
create policy credencial_idp_update on credencial_idp for update
  using (
       app.actor() = 'sistema'
    or identidad_id = any(app.identidades_del_actor())
  )
  with check (
       app.actor() = 'sistema'
    or identidad_id = any(app.identidades_del_actor())
  );

grant select, insert, update on credencial_idp to app_rw;

-- -----------------------------------------------------------------------------
-- 4. Centinela: que el operador no se cuele
--
-- Mismo espíritu que el centinela de la 067. Si alguien le da GRANT a
-- app_operador sobre esta tabla, la migración lo dice acá y no dentro de dos
-- meses en una auditoría.
-- -----------------------------------------------------------------------------
do $centinela$
declare v_mal text;
begin
  select string_agg(privilege_type, ', ')
    into v_mal
    from information_schema.role_table_grants
   where table_name = 'credencial_idp' and grantee = 'app_operador';
  if v_mal is not null then
    raise exception 'El operador no puede tener permisos sobre credencial_idp (tiene: %)', v_mal;
  end if;
end $centinela$;

commit;
