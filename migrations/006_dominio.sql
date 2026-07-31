-- =============================================================================
-- MiFirma — 006_dominio.sql
-- Archivo, circuito, instancia y participación.
--
-- Las políticas RLS de estas tablas van en 009, porque dependen de
-- app.tiene_otorgamiento() que recién existe en 008.
--
-- Cada tabla lleva cuenta_propietaria_id aunque sea derivable por join:
-- es la única forma de que las políticas no degeneren en subconsultas
-- encadenadas evaluadas por fila.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- Archivo: blob inmutable
-- -----------------------------------------------------------------------------
create table archivo (
  id                    uuid primary key default gen_random_uuid(),
  sha256                bytea not null,
  bytes                 bigint not null,
  mime                  text not null,
  clase                 text not null check (clase in ('base','firmado','evidencia','sello','planilla','adjunto')),

  cuenta_custodia_id    uuid not null references cuenta(id),
  region                text not null,
  -- Clave opaca, sin estructura semántica. Un path adivinable anula toda la RLS:
  -- se llega al documento sin pasar por la base. Ver propiedad-y-otorgamientos.md R3.
  clave_almacenamiento  text not null unique,

  paginas               int,
  creado_en             timestamptz not null default now(),

  unique (sha256, cuenta_custodia_id)
);

create index archivo_por_cuenta on archivo (cuenta_custodia_id);

-- -----------------------------------------------------------------------------
-- Circuito: documento base + configuración de firmas
-- -----------------------------------------------------------------------------
create table circuito (
  id                      uuid primary key default gen_random_uuid(),

  cuenta_propietaria_id   uuid not null references cuenta(id),
  creado_por_identidad_id uuid not null references identidad(id),

  archivo_base_id         uuid not null references archivo(id),
  titulo                  text not null,
  modo                    text not null check (modo in ('serie','paralelo','copias')),

  estado                  text not null default 'borrador'
                            check (estado in ('borrador','enviado','completo','cancelado','vencido')),

  pais_marco              char(2) not null,
  nivel_firma             text not null check (nivel_firma in ('simple','avanzada','cualificada')),

  -- Idioma del circuito y política de idioma de las notificaciones.
  idioma                  text not null default 'es',
  politica_idioma         text not null default 'destinatario'
                            check (politica_idioma in ('destinatario','emisor')),

  -- Quién sella los documentos de este circuito; null = hereda de la cuenta.
  modo_sello              text check (modo_sello in ('plataforma','cuenta','firmante')),

  politica_rechazo        text not null default 'bloqueante'
                            check (politica_rechazo in ('bloqueante','continua')),
  permite_delegar         boolean not null default false,

  dias_vigencia           int,
  vence_en                timestamptz,
  prorrogable             boolean not null default true,
  prorrogas_usadas        int not null default 0,

  enviado_en              timestamptz,
  cerrado_en              timestamptz,
  motivo_cancelacion      text,
  creado_en               timestamptz not null default now()
);

create index circuito_por_cuenta on circuito (cuenta_propietaria_id, estado);
create index circuito_vencimientos on circuito (vence_en) where estado = 'enviado';

-- Una vez despachado, solo cambia el estado y unas pocas columnas.
-- Implementa la regla "el orden es reordenable solo en borrador" a nivel de base.
create or replace function circuito_congelado() returns trigger
language plpgsql as $$
begin
  if old.estado <> 'borrador' then
    if (to_jsonb(new) - 'estado' - 'cerrado_en' - 'vence_en' - 'prorrogas_usadas' - 'motivo_cancelacion')
       is distinct from
       (to_jsonb(old) - 'estado' - 'cerrado_en' - 'vence_en' - 'prorrogas_usadas' - 'motivo_cancelacion') then
      raise exception 'circuito ya despachado: solo se puede cambiar estado, vencimiento y motivo';
    end if;
  end if;
  return new;
end $$;

create trigger circuito_congelado_trg before update on circuito
  for each row execute function circuito_congelado();

-- -----------------------------------------------------------------------------
-- Instancia: un PDF que termina firmado, con su propio expediente
-- Serie y paralelo → 1. Copias → N.
-- -----------------------------------------------------------------------------
create table instancia (
  id                      uuid primary key default gen_random_uuid(),
  circuito_id             uuid not null references circuito(id),
  cuenta_propietaria_id   uuid not null references cuenta(id),

  numero                  int not null,
  estado                  text not null default 'pendiente'
                            check (estado in ('pendiente','en_curso','firmada','rechazada','cancelada','vencida')),

  archivo_firmado_id      uuid references archivo(id),
  sha256_vigente          bytea,              -- estado actual del documento

  cerrada_en              timestamptz,
  creada_en               timestamptz not null default now(),

  unique (circuito_id, numero)
);

create index instancia_por_circuito on instancia (circuito_id, estado);
create index instancia_abiertas on instancia (estado) where estado in ('pendiente','en_curso');

create or replace function instancia_transicion_valida() returns trigger
language plpgsql as $$
declare v_ok boolean;
begin
  if old.estado is distinct from new.estado then
    v_ok := case old.estado
      when 'pendiente' then new.estado in ('en_curso','cancelada','vencida')
      when 'en_curso'  then new.estado in ('firmada','rechazada','cancelada','vencida')
      else false                                  -- los terminales no salen nunca
    end;
    if not v_ok then
      raise exception 'transición inválida de instancia: % → %', old.estado, new.estado;
    end if;
  end if;

  if old.estado in ('firmada','rechazada','cancelada','vencida')
     and (to_jsonb(new) - 'estado') is distinct from (to_jsonb(old) - 'estado') then
    raise exception 'instancia en estado terminal (%): inmutable', old.estado;
  end if;

  if old.archivo_firmado_id is not null
     and new.archivo_firmado_id is distinct from old.archivo_firmado_id then
    raise exception 'el archivo firmado no se reemplaza';
  end if;

  return new;
end $$;

create trigger instancia_inmutable before update on instancia
  for each row execute function instancia_transicion_valida();

-- -----------------------------------------------------------------------------
-- Participación: quién firma qué, en qué orden y con qué carácter
-- -----------------------------------------------------------------------------
create table participacion (
  id                      uuid primary key default gen_random_uuid(),
  instancia_id            uuid not null references instancia(id),
  circuito_id             uuid not null references circuito(id),
  cuenta_propietaria_id   uuid not null references cuenta(id),

  identidad_id            uuid not null references identidad(id),

  -- Decide si el documento queda en el repositorio personal para siempre
  -- o solo mientras dure el vínculo. Ver propiedad-y-otorgamientos.md §7.2.
  caracter                text not null default 'personal'
                            check (caracter in ('personal','representacion')),
  cuenta_representada_id  uuid references cuenta(id),

  papel                   text not null check (papel in ('firmante','veedor','copia')),
  orden                   int not null default 1,      -- 1,2,3=serie; 1,1,1=paralelo
  minimo_requerido        int,                         -- quórum del paso

  -- Control de identidad exigido
  nivel_garantia_minimo   text not null default 'bajo'
                            check (nivel_garantia_minimo in ('bajo','sustancial','alto')),
  documento_exigido_pais  char(2),
  documento_exigido_tipo  text,
  documento_exigido_num   text,

  -- Qué se usó realmente (se llena al firmar)
  anclaje_usado_id        uuid references anclaje_identidad(id),
  proveedor_elegido_id    uuid,                        -- FK en 016
  proveedor_sugerido_id   uuid,
  nivel_garantia_obtenido text,

  -- Idioma
  idioma_declarado        text,
  idioma_efectivo         text,                        -- congelado al notificar

  -- Delegación
  delegada_a_id           uuid references participacion(id),
  delegada_por_id         uuid references identidad(id),
  motivo_delegacion       text,

  estado                  text not null default 'pendiente'
                            check (estado in ('pendiente','notificada','vista','firmada',
                                              'rechazada','delegada','no_requerida','vencida')),
  motivo_rechazo          text,
  firmada_en              timestamptz,
  creada_en               timestamptz not null default now(),

  constraint representacion_coherente check (
    (caracter = 'representacion') = (cuenta_representada_id is not null)),
  unique (instancia_id, identidad_id, papel)
);

create index participacion_por_identidad on participacion (identidad_id, estado);
create index participacion_por_instancia on participacion (instancia_id, orden);
create index participacion_pendientes on participacion (estado)
  where estado in ('pendiente','notificada','vista');

commit;
