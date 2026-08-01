-- =============================================================================
-- MiFirma — 020_evidencia.sql
-- El expediente de evidencias. Implementa `auditoria-y-evidencias.md` §3.
--
-- ═══ POR QUÉ ESTA MIGRACIÓN VA ANTES QUE CUALQUIER OTRA DEL DOMINIO ═══
--
-- Con firma avanzada el certificado hace el trabajo pesado y el expediente es
-- respaldo. Con firma SIMPLE —que va a ser la mayoría del volumen— no hay
-- certificado que respalde nada: lo único que sostiene esa firma ante un juez
-- es lo que podamos demostrar. El expediente no acompaña a la prueba, ES la
-- prueba.
--
-- Y no tiene arreglo retroactivo. Un documento firmado con evidencia pobre en
-- el mes 3 sigue teniendo evidencia pobre en el año 5, cuando aparece el
-- litigio: no se puede reconstruir la IP de alguien que firmó hace dos años.
-- Por eso esto entra ANTES de que exista la primera firma, y no después.
--
-- ⚠ NO CONFUNDIR CON `bitacora_plataforma` (015). La bitácora es
-- administrativa —asignó un rol, cambió una plantilla— y se purga por política
-- de retención. La evidencia es del documento, es inmutable y se conserva por
-- el plazo legal. Si un evento de firma se anota en la bitácora, el expediente
-- queda incompleto y nadie se entera hasta el primer juicio.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- Catálogo de tipos de evento
--
-- El evento guarda un CÓDIGO y datos estructurados, jamás la oración armada
-- ("María abrió el documento"). El expediente tiene que poder emitirse en
-- español, portugués o inglés según el foro donde se presente, a partir de los
-- mismos datos. Guardar el texto renderizado casa el expediente con el idioma
-- que tenía la interfaz el día de la firma, y ese error no se puede deshacer
-- porque el dato original ya se perdió.
-- -----------------------------------------------------------------------------
create table tipo_evento (
  codigo        text primary key,
  categoria     text not null check (categoria in
                  ('envio','entrega','acceso','identidad','consentimiento',
                   'firma','rechazo','ciclo','sistema')),
  -- Los hitos de peso alto llevan sello de tiempo individual (§5): son los
  -- actos que se discuten en un juicio y no pueden esperar al lote diario.
  peso          text not null default 'normal' check (peso in ('normal','alto')),
  descripcion_i18n jsonb not null,
  orden         int not null default 100
);

insert into tipo_evento (codigo, categoria, peso, orden, descripcion_i18n) values
  ('documento.subido',      'ciclo',          'normal', 10,
   '{"es":"Se subió el documento","pt":"O documento foi enviado","en":"Document uploaded"}'),
  ('circuito.despachado',   'envio',          'alto',   20,
   '{"es":"Se despachó a firmar","pt":"Enviado para assinatura","en":"Sent for signature"}'),
  ('notificacion.enviada',  'envio',          'normal', 30,
   '{"es":"Se envió la notificación","pt":"Notificação enviada","en":"Notification sent"}'),
  ('notificacion.entregada','entrega',        'normal', 31,
   '{"es":"La notificación fue entregada","pt":"Notificação entregue","en":"Notification delivered"}'),
  ('notificacion.fallida',  'entrega',        'normal', 32,
   '{"es":"La notificación no se pudo entregar","pt":"A notificação não pôde ser entregue","en":"Notification could not be delivered"}'),
  ('documento.abierto',     'acceso',         'normal', 40,
   '{"es":"Se abrió el documento","pt":"O documento foi aberto","en":"Document opened"}'),
  ('documento.visto',       'acceso',         'normal', 41,
   '{"es":"Se recorrió el documento completo","pt":"O documento foi percorrido por completo","en":"Document viewed in full"}'),
  ('identidad.probada',     'identidad',      'alto',   50,
   '{"es":"Se probó la identidad del firmante","pt":"A identidade do signatário foi comprovada","en":"Signer identity proven"}'),
  ('consentimiento.dado',   'consentimiento', 'alto',   60,
   '{"es":"Se prestó consentimiento para firmar electrónicamente","pt":"Consentimento para assinar eletronicamente","en":"Consent to sign electronically"}'),
  ('firma.aplicada',        'firma',          'alto',   70,
   '{"es":"Se aplicó la firma","pt":"A assinatura foi aplicada","en":"Signature applied"}'),
  ('firma.rechazada',       'rechazo',        'alto',   71,
   '{"es":"Se rechazó la firma","pt":"A assinatura foi recusada","en":"Signature refused"}'),
  ('circuito.completo',     'ciclo',          'alto',   80,
   '{"es":"Se completó el circuito","pt":"O circuito foi concluído","en":"Circuit completed"}'),
  ('circuito.cancelado',    'ciclo',          'alto',   81,
   '{"es":"Se canceló el circuito","pt":"O circuito foi cancelado","en":"Circuit cancelled"}'),
  ('circuito.vencido',      'ciclo',          'normal', 82,
   '{"es":"Venció el plazo","pt":"O prazo expirou","en":"Deadline expired"}'),
  ('documento.descargado',  'acceso',         'normal', 90,
   '{"es":"Se descargó el documento","pt":"O documento foi baixado","en":"Document downloaded"}');

-- -----------------------------------------------------------------------------
-- Sellos de tiempo (ancla externa)
--
-- Sin ancla externa el expediente entero es autocertificado: una cadena de
-- hashes que el emisor pudo escribir cuando quiso, y la contraparte lo va a
-- decir. Es EL riesgo del módulo (`auditoria-y-evidencias.md` R1) y lo único
-- que no se puede agregar después con efecto retroactivo.
--
-- La tabla existe desde ahora aunque todavía no haya TSA contratada: así el
-- día que se contrate, los eventos viejos pueden anclarse a un sello nuevo sin
-- migrar el esquema, y los que quedaron sin sello se ven de un vistazo.
-- -----------------------------------------------------------------------------
create table sello_tiempo (
  id            uuid primary key default gen_random_uuid(),
  -- Qué se selló: la raíz Merkle de un lote, o el hash de un solo evento.
  alcance       text not null check (alcance in ('lote','evento','documento')),
  raiz          bytea not null,

  autoridad     text not null,          -- 'freetsa' | 'certisign' | ...
  pais          char(2),
  politica_oid  text,

  -- El token RFC 3161 crudo. Es lo que un verificador externo necesita: sin el
  -- token, la fecha es una afirmación nuestra.
  token         bytea,
  sellado_en    timestamptz,            -- la hora que afirma la TSA
  solicitado_en timestamptz not null default now(),

  estado        text not null default 'pendiente'
                  check (estado in ('pendiente','sellado','fallido')),
  error         text
);

create index sello_pendientes on sello_tiempo (solicitado_en) where estado = 'pendiente';

-- -----------------------------------------------------------------------------
-- La evidencia
--
-- Particionada por fecha desde el día uno: es la tabla que más crece y la que
-- nunca se borra. Particionar después, con datos, es una migración dolorosa;
-- particionar desde el principio es gratis.
-- -----------------------------------------------------------------------------
create table evidencia (
  id                      uuid not null default gen_random_uuid(),

  instancia_id            uuid not null references instancia(id),
  circuito_id             uuid not null references circuito(id),
  cuenta_propietaria_id   uuid not null references cuenta(id),

  identidad_id            uuid references identidad(id),
  participacion_id        uuid references participacion(id),
  actor_tipo              text not null check (actor_tipo in
                            ('firmante','emisor','sistema','proveedor','operador')),

  tipo                    text not null references tipo_evento(codigo),
  datos                   jsonb not null default '{}'::jsonb,

  -- Tres tiempos, y no son intercambiables. El webhook de un proveedor puede
  -- llegar tres minutos después del acto: el expediente tiene que poder decir
  -- cuándo firmó la persona Y cuándo nos enteramos, sin mezclarlos. Si un
  -- perito encuentra los dos, entiende el sistema; si encuentra uno que a
  -- veces significa una cosa y a veces otra, no le cree a ninguno.
  ocurrido_en             timestamptz not null,
  registrado_en           timestamptz not null default now(),
  zona_horaria_mostrada   text,
  sello_tiempo_id         uuid references sello_tiempo(id),

  ip                      inet,
  user_agent              text,
  huella_dispositivo      text,
  canal                   text check (canal in ('web','email','sms','whatsapp','api','webhook','sistema')),

  sha256_documento        bytea,

  -- ── Encadenamiento ──────────────────────────────────────────────────────
  -- La secuencia es POR INSTANCIA, no global. Una cadena global obligaría a
  -- serializar todas las escrituras de evidencia del sistema: un envío masivo
  -- de 3.000 copias genera ~30.000 eventos y sería un cuello de botella que
  -- mata el caso de uso central. El costo es que la cadena no prueba orden
  -- ENTRE instancias, y eso lo resuelve el Merkle diario.
  numero_orden            bigint not null,
  hash_contenido          bytea not null,
  hash_anterior           bytea,
  hash_propio             bytea not null,

  -- Purga selectiva sin romper la cadena: se vacían los campos personales
  -- conservando `hash_contenido`, y la cadena sigue verificando.
  purgado_en              timestamptz,

  primary key (id, registrado_en)
) partition by range (registrado_en);

create index evidencia_por_instancia on evidencia (instancia_id, numero_orden);
create index evidencia_por_identidad on evidencia (identidad_id) where identidad_id is not null;
create index evidencia_por_tipo on evidencia (tipo, registrado_en);
create index evidencia_sin_sello on evidencia (registrado_en) where sello_tiempo_id is null;

create table evidencia_default partition of evidencia default;

create or replace function app.asegurar_particion_evidencia(p_mes date default current_date)
returns text language plpgsql as $$
declare
  v_inicio date := date_trunc('month', p_mes)::date;
  v_fin    date := (date_trunc('month', p_mes) + interval '1 month')::date;
  v_nombre text := 'evidencia_' || to_char(v_inicio, 'YYYY_MM');
begin
  if exists (select 1 from pg_class where relname = v_nombre) then
    return v_nombre;
  end if;
  execute format(
    'create table %I partition of evidencia for values from (%L) to (%L)',
    v_nombre, v_inicio, v_fin);
  execute format('alter table %I enable row level security', v_nombre);
  return v_nombre;
end $$;

select app.asegurar_particion_evidencia(current_date);
select app.asegurar_particion_evidencia((current_date + interval '1 month')::date);

-- =============================================================================
-- La cadena
--
-- El trigger la calcula: ni siquiera la aplicación elige los hashes. Si el
-- número de orden o el hash anterior vinieran del código, un bug —o alguien
-- con acceso a la aplicación— podría insertar un evento en el medio.
-- =============================================================================
create or replace function evidencia_encadenar() returns trigger
language plpgsql as $$
declare v_ant record;
begin
  -- ⚠ SERIALIZACIÓN POR INSTANCIA.
  --
  -- Sin esto, dos eventos concurrentes de la misma instancia leen el mismo
  -- "último" y se les asigna el mismo `numero_orden` y el mismo
  -- `hash_anterior`: la cadena se BIFURCA. Y una cadena bifurcada no se nota
  -- al insertar ni al leer un evento suelto — se descubre al verificar el
  -- expediente, que es exactamente el peor momento posible.
  --
  -- El lock es por instancia y dura lo que la transacción, así que dos
  -- circuitos distintos siguen escribiendo en paralelo. Eso es justamente lo
  -- que la cadena por instancia venía a permitir.
  perform pg_advisory_xact_lock(hashtextextended(new.instancia_id::text, 0));

  select numero_orden, hash_propio into v_ant
    from evidencia
   where instancia_id = new.instancia_id
   order by numero_orden desc
   limit 1;

  new.numero_orden   := coalesce(v_ant.numero_orden, 0) + 1;
  new.hash_anterior  := v_ant.hash_propio;
  new.registrado_en  := now();

  -- Paso 1: hash del CONTENIDO de este evento, una sola vez y para siempre.
  new.hash_contenido := digest(
      new.instancia_id::text ||'|'|| new.numero_orden::text ||'|'||
      new.tipo ||'|'|| new.datos::text ||'|'||
      to_char(new.ocurrido_en at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.USOF') ||'|'||
      coalesce(new.identidad_id::text,'') ||'|'||
      coalesce(host(new.ip),'') ||'|'||
      coalesce(new.user_agent,'') ||'|'||
      coalesce(encode(new.sha256_documento,'hex'),'')
    , 'sha256');

  -- Paso 2: la cadena encadena HASHES DE CONTENIDO, no los campos.
  --
  -- La forma ingenua —encadenar los campos directamente— produce una cadena
  -- que verifica hoy y es imposible de conciliar con una obligación de
  -- supresión de datos personales mañana: para borrar una IP habría que romper
  -- la cadena, y una cadena rota no prueba nada. Separando los dos hashes se
  -- pueden vaciar `datos`, `ip` y `user_agent` conservando `hash_contenido`, y
  -- la cadena sigue cerrando y sigue probando que ese evento existió con ese
  -- contenido exacto. Una línea de diferencia hoy; un problema sin salida en
  -- tres años.
  new.hash_propio := digest(
      coalesce(encode(new.hash_anterior,'hex'),'') ||'|'||
      encode(new.hash_contenido,'hex')
    , 'sha256');

  return new;
end $$;

create trigger evidencia_cadena before insert on evidencia
  for each row execute function evidencia_encadenar();

-- La fórmula de arriba ES PARTE DEL EXPEDIENTE, no un detalle de
-- implementación: un verificador externo tiene que poder recalcularla dentro de
-- diez años. Va versionada y NO SE CAMBIA JAMÁS. Si algún día hace falta otra,
-- se agrega como versión 2 y los documentos viejos siguen verificando con la 1.
comment on function evidencia_encadenar() is
  'Cadena de evidencia v1. NO MODIFICAR: los expedientes emitidos se verifican con esta fórmula.';

-- =============================================================================
-- Inmutabilidad y visibilidad
-- =============================================================================
alter table evidencia enable row level security;
alter table evidencia_default enable row level security;
alter table tipo_evento enable row level security;
alter table sello_tiempo enable row level security;

-- Quién ve el expediente:
--   · la cuenta dueña del documento
--   · quien tenga un otorgamiento con alcance 'evidencia' (cruza empresas)
--   · el firmante sobre lo suyo, y sólo con identidad probada — el expediente
--     tiene IPs y dispositivos, no se abre con una sesión sin anclaje
create policy evidencia_select on evidencia for select using (
     (app.actor() = 'cuenta' and cuenta_propietaria_id = app.cuenta_actual())
  or app.tiene_otorgamiento(circuito_id, instancia_id, 'evidencia')
  or (identidad_id = any (app.identidades_del_actor()) and app.identidad_probada())
);
create policy evidencia_insert on evidencia for insert with check (
  app.actor() in ('sistema','cuenta','externo')
);
-- Sin update ni delete PARA NADIE. Una evidencia que la aplicación puede
-- editar no prueba nada.
create policy evidencia_update on evidencia for update using (false);
create policy evidencia_delete on evidencia for delete using (false);

-- El catálogo lo lee cualquiera: son etiquetas, y el firmante externo necesita
-- poder leer su propio expediente.
create policy tipo_evento_select on tipo_evento for select using (true);
create policy tipo_evento_escribir on tipo_evento for all using (app.actor() = 'operador');

create policy sello_select on sello_tiempo for select using (true);
create policy sello_insert on sello_tiempo for insert with check (app.actor() in ('sistema','operador'));
create policy sello_update on sello_tiempo for update using (app.actor() in ('sistema','operador'));
create policy sello_delete on sello_tiempo for delete using (false);

-- =============================================================================
-- Permisos
--
-- Dos cerraduras sobre la misma puerta: la política se puede llegar a modificar
-- por error en una migración; el REVOKE es independiente. En la tabla que
-- sostiene el valor legal del producto, dos cerraduras.
-- =============================================================================
grant select, insert on evidencia to app_rw;
revoke update, delete, truncate on evidencia from app_rw;

grant select on tipo_evento to app_rw;
grant select, insert, update, delete on tipo_evento to app_operador;

grant select, insert, update on sello_tiempo to app_rw;
revoke delete, truncate on sello_tiempo from app_rw;
grant select on sello_tiempo to app_operador;

-- El operador NO ve la evidencia: es contenido del cliente, no metadato
-- administrativo. El test C4 lo verifica. Que pueda ver la bitácora de
-- plataforma y no el expediente es exactamente la línea que separa dar soporte
-- de leer los documentos de un cliente.

commit;
