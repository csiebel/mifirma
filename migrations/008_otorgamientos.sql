-- =============================================================================
-- MiFirma — 008_otorgamientos.sql
-- El corazón de la autorización.
--
-- En Payroll NG la pregunta es "¿de qué empresa sos?". Acá hay que responder
-- tres: quién sos como persona, en nombre de qué cuenta actuás, y qué te
-- otorgaron explícitamente. Los documentos cruzan fronteras de cuenta y llegan
-- a firmantes sin cuenta: ahí el tenant ya no explica nada.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

create table otorgamiento (
  id                    uuid primary key default gen_random_uuid(),

  -- SOBRE QUÉ (exactamente uno).
  -- Un otorgamiento sobre el circuito alcanza a todas sus instancias: es lo que
  -- evita la explosión de filas en modo copias (1 para la cuenta emisora, N
  -- para los firmantes, en lugar de N+N).
  circuito_id           uuid references circuito(id),
  instancia_id          uuid references instancia(id),

  -- A QUIÉN (exactamente uno)
  identidad_id          uuid references identidad(id),
  cuenta_id             uuid references cuenta(id),

  -- CONTRA QUÉ ANCLAJE se emitió (solo para sujeto = identidad).
  -- "a quien pruebe ser maria@x.com" vs "a quien pruebe ser la CI 4.123.456-7".
  -- Es lo que impide que registrarse con el mail de otro dé acceso a documentos
  -- otorgados contra su documento de identidad.
  anclaje_destino_id    uuid references anclaje_identidad(id),
  nivel_garantia_minimo text not null default 'bajo'
                          check (nivel_garantia_minimo in ('bajo','sustancial','alto')),

  -- ALCANCES
  alcances              text[] not null,
  -- 'metadatos'   ver que existe, título, estado, fechas
  -- 'leer'        abrir el contenido
  -- 'firmar'      ejecutar la firma sobre su participación
  -- 'evidencia'   descargar el expediente
  -- 'administrar' cancelar, reenviar, otorgar sobre el objeto

  -- VIGENCIA
  vigente_desde         timestamptz not null default now(),
  vigente_hasta         timestamptz,
  revocado_en           timestamptz,
  revocado_por          uuid references identidad(id),
  motivo_revocacion     text,

  -- Si no es null, el otorgamiento solo vale mientras exista membresía activa
  -- de esa identidad en esa cuenta. Declarativo, no un proceso de limpieza que
  -- puede fallar. Ver propiedad-y-otorgamientos.md §7.2.
  condicionado_a_cuenta_id uuid references cuenta(id),

  -- El derecho del firmante a conservar prueba de lo que firmó. No se revoca
  -- ni vence, ni por la cuenta emisora ni por el operador.
  irrevocable           boolean not null default false,

  -- PROCEDENCIA
  origen                text not null check (origen in
                          ('emision','participacion','delegacion','manual','legal')),
  otorgado_por          uuid references identidad(id),
  cuenta_otorgante_id   uuid not null references cuenta(id),
  creado_en             timestamptz not null default now(),

  constraint otorgamiento_objeto_unico
    check (num_nonnulls(circuito_id, instancia_id) = 1),
  constraint otorgamiento_sujeto_unico
    check (num_nonnulls(identidad_id, cuenta_id) = 1),
  constraint otorgamiento_alcances_validos
    check (alcances <@ array['metadatos','leer','firmar','evidencia','administrar']::text[]
           and cardinality(alcances) > 0),
  constraint otorgamiento_irrevocable_sin_vencimiento
    check (not irrevocable or (vigente_hasta is null and condicionado_a_cuenta_id is null))
);

-- -----------------------------------------------------------------------------
-- Índices. No son opcionales: cada SELECT sobre circuito, instancia,
-- participacion, archivo y evidencia consulta esta tabla.
-- -----------------------------------------------------------------------------
create index otorg_por_identidad on otorgamiento (identidad_id)
  where revocado_en is null and identidad_id is not null;
create index otorg_por_cuenta on otorgamiento (cuenta_id)
  where revocado_en is null and cuenta_id is not null;
create index otorg_por_circuito on otorgamiento (circuito_id)
  where revocado_en is null and circuito_id is not null;
create index otorg_por_instancia on otorgamiento (instancia_id)
  where revocado_en is null and instancia_id is not null;

-- El camino caliente: el listado del repositorio personal.
create index otorg_repositorio_personal
  on otorgamiento (identidad_id, vigente_desde desc)
  include (circuito_id, instancia_id, alcances)
  where revocado_en is null and identidad_id is not null;

-- -----------------------------------------------------------------------------
-- Inmutabilidad: un otorgamiento no se modifica, se revoca y se emite otro.
-- RLS controla filas, no columnas: esto tiene que ser un trigger.
-- -----------------------------------------------------------------------------
create or replace function otorgamiento_solo_revocacion() returns trigger
language plpgsql as $$
begin
  if old.irrevocable and new.revocado_en is not null then
    raise exception 'otorgamiento irrevocable: no se puede revocar (%)', old.id;
  end if;
  if old.revocado_en is not null then
    raise exception 'otorgamiento ya revocado';
  end if;
  if (to_jsonb(new) - 'revocado_en' - 'revocado_por' - 'motivo_revocacion')
     is distinct from
     (to_jsonb(old) - 'revocado_en' - 'revocado_por' - 'motivo_revocacion') then
    raise exception 'un otorgamiento no se modifica: revocá y emití uno nuevo';
  end if;
  return new;
end $$;

create trigger otorgamiento_inmutable before update on otorgamiento
  for each row execute function otorgamiento_solo_revocacion();

-- -----------------------------------------------------------------------------
-- LA función central.
--
-- security definer para evitar recursión: lee `otorgamiento`, que tiene RLS.
-- Corre como dueño, que la bypassea.
--
-- ⚠ ESTO SE ROMPE SI ALGUIEN PONE `FORCE ROW LEVEL SECURITY` SOBRE
--   `otorgamiento`. La función quedaría sujeta a la política que intenta
--   evaluar: recursión, o peor, falso silencioso y todos pierden acceso sin
--   error visible. Ver propiedad-y-otorgamientos.md R5.
-- -----------------------------------------------------------------------------
create or replace function app.tiene_otorgamiento(
  p_circuito  uuid,
  p_instancia uuid,
  p_alcance   text
) returns boolean
language sql stable security definer set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.otorgamiento o
    where o.revocado_en is null
      and o.vigente_desde <= now()
      and (o.vigente_hasta is null or o.vigente_hasta > now())
      and p_alcance = any (o.alcances)

      -- alcanza el objeto pedido (el del circuito cubre a sus instancias)
      and (
        (o.circuito_id  is not null and o.circuito_id  = p_circuito)
        or
        (o.instancia_id is not null and o.instancia_id = p_instancia)
      )

      -- condicionamiento al vínculo laboral
      and (
        o.condicionado_a_cuenta_id is null
        or exists (
          select 1 from public.membresia m
          where m.identidad_id = o.identidad_id
            and m.cuenta_id    = o.condicionado_a_cuenta_id
            and m.estado = 'activa'
            and m.hasta is null
        )
      )

      -- el sujeto es el actor
      and (
        -- (a) externo: SOLO el otorgamiento exacto de su enlace
        (app.actor() = 'externo' and o.id = app.otorgamiento_externo())

        -- (b) identidad, habiendo probado en esta sesión el anclaje contra el
        --     que se emitió, con nivel de garantía suficiente
        or (app.actor() = 'cuenta'
            and o.identidad_id = any (app.identidades_del_actor())
            and app.identidad_probada()
            and app.nivel_alcanza(o.nivel_garantia_minimo)
            and (o.anclaje_destino_id is null
                 or o.anclaje_destino_id = any (app.anclajes_probados())))

        -- (c) la cuenta en cuyo nombre está actuando
        or (app.actor() = 'cuenta' and o.cuenta_id = app.cuenta_actual())
      )
  )
$$;

revoke all on function app.tiene_otorgamiento(uuid,uuid,text) from public;
grant execute on function app.tiene_otorgamiento(uuid,uuid,text) to app_rw;

commit;
