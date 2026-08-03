-- =============================================================================
-- MiFirma — 035_certificado_finalizacion.sql
-- El certificado de finalización: el entregable.
--
-- ═══ QUÉ ES ═══
--
-- Es lo que el cliente muestra en un juicio, y **la única parte del sistema de
-- auditoría que un abogado va a mirar**. El expediente tiene ciento veinte
-- eventos encadenados por hash; el certificado los cuenta en una carilla, con
-- los datos que hacen falta para no tener que abrir nada más.
--
-- Implementa `claude/auditoria-y-evidencias.md` §4.
--
-- ═══ POR QUÉ ES UNA TABLA Y NO UN PDF QUE SE ARMA CADA VEZ ═══
--
-- Porque un certificado que se regenera puede salir distinto. El expediente es
-- inmutable, sí, pero la PLANTILLA cambia, los textos se traducen mejor, se
-- agrega un campo. Si el certificado se rearmara al pedirlo, el que un cliente
-- presentó en marzo y el que se descarga en agosto no coincidirían, y quien
-- tenga que explicar la diferencia va a ser él, en una audiencia.
--
-- Se emite UNA vez, al cerrarse el circuito. Se guarda el PDF y también los
-- `datos` estructurados que lo produjeron: si en tres años hay que reimprimirlo
-- en otro idioma o con otra plantilla, la fuente está y no hay que reconstruirla
-- del expediente.
--
-- `version_plantilla` y `version_algoritmo_hash` viajan adentro justamente para
-- eso: un verificador externo tiene que poder saber con qué reglas se armó.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

create table certificado_finalizacion (
  id                      uuid primary key default gen_random_uuid(),
  -- Uno por instancia. En modo copias son 3.000 certificados, uno por persona,
  -- y así tiene que ser: cada uno prueba SU firma.
  instancia_id            uuid not null unique references instancia(id),
  circuito_id             uuid not null references circuito(id),
  cuenta_propietaria_id   uuid not null references cuenta(id),

  -- El PDF. Va como `archivo` de clase 'evidencia', con su huella, igual que
  -- cualquier otro: se descarga, se verifica y se archiva por el mismo camino.
  archivo_id              uuid not null references archivo(id),

  -- La fuente de verdad estructurada. El PDF es una presentación de esto.
  datos                   jsonb not null,
  idioma_emitido          text not null default 'es',

  version_plantilla       int not null default 1,
  version_algoritmo_hash  int not null default 1,

  -- El estado de la cadena AL MOMENTO DE EMITIR. Que se recalcule después está
  -- bien; lo que no se puede reconstruir es qué decía cuando se certificó.
  hash_raiz_evidencia     bytea not null,
  eventos_incluidos       int not null,
  cadena_ok               boolean not null,

  sello_tiempo_id         uuid references sello_tiempo(id),
  emitido_en              timestamptz not null default now()
);

create index certificado_por_circuito on certificado_finalizacion (circuito_id);

comment on table certificado_finalizacion is
  'El entregable: lo que se presenta en un juicio. Se emite UNA vez al cerrar el '
  'circuito y no se regenera — un certificado que sale distinto cada vez no sirve '
  'para probar nada. Ver migración 035 y auditoria-y-evidencias.md §4.';

-- -----------------------------------------------------------------------------
-- RLS
--
-- ⚠ Se ve con alcance `metadatos`, NO con `evidencia`.
--
-- Es deliberado y es del diseño: el firmante tiene que poder quedarse con la
-- constancia de lo que firmó sin que eso le abra el expediente completo —donde
-- están las IP y los recorridos de los demás firmantes—. Son dos cosas
-- distintas: la constancia es suya, el expediente es del documento.
-- -----------------------------------------------------------------------------
alter table certificado_finalizacion enable row level security;

create policy cert_select on certificado_finalizacion for select using (
     app.actor() in ('operador','sistema')
  or (cuenta_propietaria_id = app.cuenta_actual() and app.es_miembro(cuenta_propietaria_id))
  or app.tiene_otorgamiento(circuito_id, instancia_id, 'metadatos')
);

create policy cert_insert on certificado_finalizacion for insert with check (
  app.actor() = 'sistema'
);

-- Inmutable, como el expediente que resume. Un certificado que se puede editar
-- después de emitido no es un certificado.
create policy cert_update on certificado_finalizacion for update using (false);
create policy cert_delete on certificado_finalizacion for delete using (false);

grant select, insert on certificado_finalizacion to app_rw;
-- El operador NO recibe GRANT: es contenido del cliente. Mismo criterio que
-- `marca_firma` y el resto del dominio. Test C4.

-- -----------------------------------------------------------------------------
-- El evento
-- -----------------------------------------------------------------------------
insert into tipo_evento (codigo, categoria, peso, orden, descripcion_i18n) values
  ('certificado.emitido', 'ciclo', 'alto', 85,
   '{"es":"Se emitió el certificado de finalización","pt":"Certificado de conclusão emitido","en":"Completion certificate issued"}')
on conflict (codigo) do nothing;

commit;

-- Centinela de la 026: se agregó una tabla con políticas nuevas.
do $centinela$
declare v_expr text; v_tabla text; v_pol text; v_mal text := '';
begin
  for v_tabla, v_pol, v_expr in
    select c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid)
      from pg_policy p join pg_class c on c.oid = p.polrelid
     where p.polcmd in ('r','*')
       and has_table_privilege('app_operador', c.oid, 'select')
  loop
    if v_expr ~ '(^|[^a-z_])(circuito|instancia|ubicacion|archivo|participacion|otorgamiento|marca_firma|certificado_finalizacion)([^a-z_]|$)' then
      v_mal := v_mal || format(E'\n  %s.%s', v_tabla, v_pol);
    end if;
  end loop;
  if v_mal <> '' then
    raise exception E'Políticas que nombran tablas del dominio y le cobran el GRANT a app_operador:%s', v_mal;
  end if;
end $centinela$;
