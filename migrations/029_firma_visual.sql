-- =============================================================================
-- MiFirma — 029_firma_visual.sql
-- La firma autógrafa y la rúbrica de cada persona.
--
-- ═══ LO PRIMERO, PORQUE ES LA REGLA DE ORO Nº1 ═══
--
-- Esto NO es la firma. La firma la da la criptografía —PAdES, certificado,
-- sello de tiempo—; esto es una imagen que se estampa para que un humano
-- reconozca de un vistazo quién firmó. La tabla se llama `firma_visual` y no
-- `firma` a propósito, y ninguna consulta de este sistema debe tratarla como
-- prueba de nada. Un documento sin imagen está firmado igual; un documento con
-- imagen y sin PAdES no está firmado.
--
-- Dos tipos, y la distinción es la que se definió con Claudio el 1/8/2026:
--   · `firma`   — la firma autógrafa completa. Va donde corresponde firmar.
--   · `rubrica` — la inicial. Va en el resto de las hojas.
-- No hay "larga y corta" con bloques de datos: son estos dos archivos y nada más.
--
-- ═══ CUELGA DE LA IDENTIDAD, NO DE LA CUENTA ═══
--
-- La identidad es global y precede a la cuenta: una persona tiene UNA firma,
-- no una por empresa donde trabaja. Cuelga de `identidad` por la misma razón por
-- la que el admin de una empresa no administra el teléfono ni el segundo factor
-- de nadie (cambio de fondo nº6 respecto de payroll). Si mañana cambia de
-- trabajo, su firma se va con ella.
--
-- ═══ QUIÉN LA VE ═══
--
-- Su dueño y el sistema al estampar. NADIE MÁS. Ni el admin de la empresa donde
-- trabaja, ni el emisor del documento, ni el operador de la plataforma.
--
-- Una imagen de firma autógrafa es de lo más copiable que hay: quien la tiene
-- puede pegarla en cualquier papel. Que ya viaje dentro de los PDF firmados no
-- es excusa para regalarla suelta — ahí va acompañada de la criptografía que la
-- ata a un documento concreto; suelta es un archivo listo para usar en otro.
--
-- ═══ NO SE PISA: SE REEMPLAZA ═══
--
-- Las filas viejas quedan con `vigente = false`. Hace falta para responder
-- "¿qué imagen se estampó en este documento de hace tres años?" — si se
-- sobrescribiera, esa respuesta se pierde y el expediente queda incompleto.
-- Es el mismo criterio que los precios: no se pisan, se cierran y se abre otro.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

create table firma_visual (
  id                    uuid primary key default gen_random_uuid(),
  identidad_id          uuid not null references identidad(id),
  tipo                  text not null check (tipo in ('firma','rubrica')),

  -- El blob va al almacén, como los documentos: la base guarda dónde está y su
  -- huella, no los bytes. Y la clave es opaca —32 bytes al azar— porque una
  -- ruta adivinable esquivaría la RLS.
  clave_almacenamiento  text not null,
  mime                  text not null check (mime in ('image/png','image/jpeg')),
  bytes                 int not null check (bytes > 0 and bytes <= 2097152),
  ancho                 int not null check (ancho between 1 and 4000),
  alto                  int not null check (alto between 1 and 4000),
  sha256                bytea not null,

  -- Cómo llegó. Va al expediente cuando se estampa: no es lo mismo una imagen
  -- que la persona dibujó en la pantalla en ese momento que una que subió hace
  -- dos años y cualquiera pudo haberle mandado por mail.
  origen                text not null check (origen in ('subida','dibujada')),

  vigente               boolean not null default true,
  creada_en             timestamptz not null default now(),
  reemplazada_en        timestamptz
);

-- Una vigente por tipo y por persona. El invariante es de la base y no de un
-- comentario — lección de la 024.
create unique index firma_visual_vigente_uq
  on firma_visual (identidad_id, tipo) where vigente;
create index firma_visual_por_identidad on firma_visual (identidad_id);

comment on table firma_visual is
  'Representación VISUAL de la firma. No es la firma: el valor legal lo da el '
  'PAdES. Ver regla de oro nº1 en arquitectura-mi-firma.md §2.';

-- -----------------------------------------------------------------------------
-- RLS
--
-- La rama del dueño exige `app.identidad_probada()`: no alcanza con decir que
-- sos vos, hay que haberlo acreditado en ESTA sesión. Es lo mismo que se le pide
-- a cualquier dato atado al documento de identidad.
-- -----------------------------------------------------------------------------
alter table firma_visual enable row level security;

create policy firma_visual_select on firma_visual for select using (
     (identidad_id = any (app.identidades_del_actor()) and app.identidad_probada())
  or app.actor() = 'sistema'          -- al estampar, y sólo para eso
);

create policy firma_visual_insert on firma_visual for insert with check (
  identidad_id = any (app.identidades_del_actor()) and app.identidad_probada()
);

-- Sólo para marcar `vigente = false` al reemplazar. El contenido no se edita:
-- una imagen que se puede cambiar sin dejar rastro no sirve para explicar qué
-- se estampó en un documento viejo.
create policy firma_visual_update on firma_visual for update using (
  identidad_id = any (app.identidades_del_actor()) and app.identidad_probada()
);

create policy firma_visual_delete on firma_visual for delete using (false);

grant select, insert, update on firma_visual to app_rw;
revoke delete, truncate on firma_visual from app_rw;
-- ⚠ El operador NO recibe GRANT. Ver el encabezado: la ausencia de permiso es
-- el control, y no depende de que una política esté bien escrita.

-- -----------------------------------------------------------------------------
-- El evento del expediente
--
-- Se anota QUÉ imagen se estampó y de dónde salió, con su huella. Sin esto, el
-- documento muestra un trazo que nadie puede atar a nada.
-- -----------------------------------------------------------------------------
insert into tipo_evento (codigo, categoria, peso, orden, descripcion_i18n) values
  ('firma.representacion_visual', 'firma', 'normal', 69,
   '{"es":"Se estampó la representación visual de la firma","pt":"A representação visual da assinatura foi aplicada","en":"Visual representation of the signature was stamped"}')
on conflict (codigo) do nothing;

commit;
