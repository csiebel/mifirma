-- =============================================================================
-- MiFirma — 041_marca_agregada_y_quitada.sql
--
-- Los dos eventos que faltaban en el catálogo para que la 040 sirva de algo.
--
-- `evidencia.tipo` tiene clave foránea a `tipo_evento`: un hecho que no está
-- declarado no se puede anotar, y por lo tanto no puede ocurrir. Es a propósito
-- —el expediente no admite tipos inventados en caliente— pero significa que
-- toda función nueva que anote algo trae su fila de catálogo.
--
-- Van con `peso = 'normal'`, igual que `firma.marca_movida`: colocar la rúbrica
-- es parte de firmar, no un hecho excepcional. Y quedan justo antes de ella en
-- el orden, porque en la línea de tiempo de una firma primero se coloca y
-- después, si acaso, se mueve.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

insert into tipo_evento (codigo, categoria, peso, descripcion_i18n, orden) values
  ('firma.marca_agregada', 'firma', 'normal',
   '{"es": "El firmante colocó dónde se estampa su firma",
     "en": "The signer placed where their signature is stamped",
     "pt": "O signatário posicionou onde sua assinatura é aplicada"}'::jsonb, 66),
  ('firma.marca_quitada', 'firma', 'normal',
   '{"es": "El firmante quitó una marca que había colocado",
     "en": "The signer removed a mark they had placed",
     "pt": "O signatário removeu uma marca que havia posicionado"}'::jsonb, 67)
on conflict (codigo) do nothing;

commit;

do $control$
declare v_n int;
begin
  select count(*) into v_n from tipo_evento
   where codigo in ('firma.marca_agregada','firma.marca_quitada');
  if v_n <> 2 then
    raise exception 'faltan tipos de evento: sólo quedaron % de 2', v_n;
  end if;
end $control$;
