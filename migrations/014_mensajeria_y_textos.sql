-- =============================================================================
-- MiFirma — 014_mensajeria_y_textos.sql
-- Cómo salen los mensajes y con qué texto: configuración de correo y Twilio,
-- suscripciones push, plantillas de notificación por idioma, el bloque libre
-- del cliente y los overrides de traducción de la interfaz.
--
-- Las columnas de idioma del núcleo (identidad.idioma_preferido, cuenta.idioma,
-- circuito.idioma + politica_idioma, participacion.idioma_declarado y
-- idioma_efectivo) ya vienen de las migraciones 002, 003 y 006. Acá va lo que
-- falta: el texto en sí.
-- Ver `claude/multiidioma-y-textos.md` §4.
--
-- ⚠ NO se trae `tipo_documento` de payroll: allá era el catálogo de documentos
--   del legajo del empleado, que es dominio de RRHH. En MiFirma la
--   clasificación del repositorio la dan las carpetas (migración 005).
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- Salida de correo. Configuración del operador, una por remitente.
-- Las credenciales solo cifradas: la clave vive en el KMS. Ver iso-27001.md §3.
-- -----------------------------------------------------------------------------
create table correo_config (
  id                uuid primary key default gen_random_uuid(),
  proveedor         text not null default 'smtp',
  host              text not null,
  puerto            int not null default 587,
  seguridad         text not null default 'starttls'
                      check (seguridad in ('ninguna','starttls','tls')),
  usuario           text not null,
  password_cifrado  text,

  remitente_nombre  text not null,
  remitente_email   text not null,
  responder_a       text,

  activa            boolean not null default true,
  creada_en         timestamptz not null default now(),
  actualizada_en    timestamptz not null default now()
);

-- Un solo remitente activo a la vez: si hay dos, el que sale depende del orden
-- de la consulta, y eso se descubre cuando un cliente pregunta por qué el mail
-- vino de otra dirección.
create unique index correo_config_activa_unica on correo_config ((true)) where activa;

-- -----------------------------------------------------------------------------
-- Twilio: SMS y WhatsApp.
-- -----------------------------------------------------------------------------
create table twilio_config (
  id                  uuid primary key default gen_random_uuid(),
  account_sid         text not null,
  auth_token_cifrado  text,
  from_sms            text,
  from_whatsapp       text,
  wa_content_sid      text,
  activa              boolean not null default true,
  creada_en           timestamptz not null default now(),
  actualizada_en      timestamptz not null default now()
);

create unique index twilio_config_activa_unica on twilio_config ((true)) where activa;

-- -----------------------------------------------------------------------------
-- Push web.
--
-- Cambia respecto de payroll: la suscripción es de la IDENTIDAD, no del par
-- (empresa, usuario). La misma persona puede estar en dos cuentas y recibir en
-- el mismo navegador; duplicar la suscripción mandaría dos notificaciones.
-- Ver apps-y-dispositivos.md: web primero, apps nativas después sobre la misma
-- tabla más un `token_nativo`.
-- -----------------------------------------------------------------------------
create table push_suscripcion (
  id                uuid primary key default gen_random_uuid(),
  identidad_id      uuid not null references identidad(id) on delete cascade,

  endpoint          text not null unique,
  p256dh            text not null,
  auth              text not null,
  user_agent        text,

  creada_en         timestamptz not null default now(),
  ultimo_envio_en   timestamptz,
  fallos            int not null default 0,
  revocada_en       timestamptz
);

create index push_vigente on push_suscripcion (identidad_id) where revocada_en is null;

-- -----------------------------------------------------------------------------
-- Plantillas de notificación. Las escribimos nosotros, una por idioma.
--
-- El encabezado, el botón de firma y el pie son del sistema y el cliente no los
-- toca: así es imposible que rompa el enlace de firma. Su aporte va en
-- `bloque_mensaje`.
-- -----------------------------------------------------------------------------
create table plantilla_mensaje (
  id            uuid primary key default gen_random_uuid(),

  codigo        text not null check (codigo in (
                  'invitacion_firma','turno_disponible','recordatorio',
                  'vencimiento_proximo','copia_informativa','completado',
                  'rechazado','cancelado','entrega_fallida',
                  'codigo_verificacion','lote_despachado')),
  canal         text not null check (canal in ('email','sms','whatsapp','push')),
  idioma        text not null,                  -- BCP 47

  asunto        text,
  cuerpo        text not null,
  -- Variables permitidas. Se validan CONTRA ESTA LISTA al guardar la plantilla,
  -- no al enviar: una variable mal escrita descubierta en el despacho son 3.000
  -- mails con un hueco.
  variables     text[] not null default '{}',
  admite_bloque boolean not null default true,

  version       int not null default 1,
  activa        boolean not null default true,
  creada_en     timestamptz not null default now(),

  unique (codigo, canal, idioma, version),
  -- El mail lleva asunto; el SMS no tiene dónde ponerlo.
  constraint asunto_solo_email check (canal <> 'email' or asunto is not null)
);

create unique index plantilla_activa_unica on plantilla_mensaje (codigo, canal, idioma)
  where activa;

-- -----------------------------------------------------------------------------
-- Bloque libre del cliente: texto plano, sin variables, con tope de largo.
--
-- Las tres restricciones importan. Sin HTML libre, o el mail se vuelve vector
-- de inyección. Sin variables, para que no haya forma de romper un enlace que
-- el cliente no puede escribir. Con tope, porque un bloque de 4.000 caracteres
-- empuja el botón de firma fuera de la primera pantalla y baja la tasa de firma
-- sin que nadie entienda por qué.
-- -----------------------------------------------------------------------------
create table bloque_mensaje (
  id            uuid primary key default gen_random_uuid(),
  cuenta_id     uuid not null references cuenta(id) on delete cascade,
  circuito_id   uuid references circuito(id) on delete cascade,  -- null = toda la cuenta

  codigo        text not null,
  idioma        text not null,
  cuerpo        text not null check (length(cuerpo) <= 1000),

  creado_por    uuid references identidad(id),
  creado_en     timestamptz not null default now(),

  -- Sin variables: el `«` de nuestra sintaxis de plantilla no entra.
  constraint bloque_sin_variables check (cuerpo !~ '[«»{}]')
);

-- Un bloque por cuenta y código/idioma, y otro por circuito que lo pisa.
-- Dos índices parciales porque `unique` trata los NULL como distintos y
-- dejaría meter cinco bloques de cuenta para el mismo código.
create unique index bloque_de_cuenta_unico on bloque_mensaje (cuenta_id, codigo, idioma)
  where circuito_id is null;
create unique index bloque_de_circuito_unico on bloque_mensaje (circuito_id, codigo, idioma)
  where circuito_id is not null;

-- -----------------------------------------------------------------------------
-- Override de traducción de la interfaz.
--
-- Los textos base viven en el código (los archivos de idioma). Esta tabla deja
-- que el operador corrija una cadena sin desplegar. No es donde vive el idioma:
-- es el parche.
-- -----------------------------------------------------------------------------
create table traduccion_override (
  idioma        text not null,
  clave         text not null,
  valor         text not null,
  nota          text,
  actualizado_en timestamptz not null default now(),
  primary key (idioma, clave)
);

-- =============================================================================
-- RLS
-- =============================================================================

-- Configuración de salida y plantillas del sistema: del operador.
-- app_rw las lee para poder enviar; jamás las escribe.
revoke all on correo_config, twilio_config, plantilla_mensaje, traduccion_override from public;
grant select, insert, update, delete
  on correo_config, twilio_config, plantilla_mensaje, traduccion_override to app_operador;
grant select on plantilla_mensaje, traduccion_override to app_rw;
-- ⚠ correo_config y twilio_config guardan secretos cifrados. app_rw lee solo
--   las columnas que necesita para armar el envío; el descifrado ocurre en el
--   worker, con la clave del KMS, no en la request del usuario.
grant select (id, proveedor, host, puerto, seguridad, usuario, remitente_nombre,
              remitente_email, responder_a, activa) on correo_config to app_rw;
grant select (id, account_sid, from_sms, from_whatsapp, wa_content_sid, activa)
  on twilio_config to app_rw;

alter table push_suscripcion enable row level security;
create policy push_select on push_suscripcion for select using (
  app.actor() = 'sistema' or identidad_id = any (app.identidades_del_actor()));
create policy push_insert on push_suscripcion for insert with check (
  app.actor() = 'sistema' or identidad_id = any (app.identidades_del_actor()));
create policy push_update on push_suscripcion for update using (
  app.actor() = 'sistema' or identidad_id = any (app.identidades_del_actor()));
create policy push_delete on push_suscripcion for delete using (
  app.actor() = 'sistema' or identidad_id = any (app.identidades_del_actor()));

alter table bloque_mensaje enable row level security;
create policy bloque_select on bloque_mensaje for select using (
     app.actor() = 'sistema'
  or (app.actor() = 'cuenta' and cuenta_id = app.cuenta_actual())
);
create policy bloque_insert on bloque_mensaje for insert with check (
     app.actor() = 'sistema'
  or (cuenta_id = app.cuenta_actual() and app.tiene_capacidad('plantilla','administrar'))
);
create policy bloque_update on bloque_mensaje for update using (
     app.actor() = 'sistema'
  or (cuenta_id = app.cuenta_actual() and app.tiene_capacidad('plantilla','administrar'))
);
create policy bloque_delete on bloque_mensaje for delete using (
     app.actor() = 'sistema'
  or (cuenta_id = app.cuenta_actual() and app.tiene_capacidad('plantilla','administrar'))
);

grant select, insert, update on push_suscripcion to app_rw;
grant delete on push_suscripcion to app_rw;
grant select, insert, update, delete on bloque_mensaje to app_rw;

commit;
