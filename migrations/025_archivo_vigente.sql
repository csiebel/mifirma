-- =============================================================================
-- MiFirma — 025_archivo_vigente.sql
-- El documento a mitad de camino: firmado por algunos, no por todos.
--
-- ═══ QUÉ FALTABA ═══
--
-- `instancia` tiene `archivo_firmado_id`, protegido por trigger: una vez puesto
-- no se reemplaza jamás. Correcto — es el documento final, el que se opone en
-- un juicio.
--
-- Pero con tres firmantes hay tres PDF intermedios: el que tiene la primera
-- firma, el que tiene dos, y recién el tercero es el final. Cada firma PAdES se
-- agrega sobre el archivo anterior, así que el segundo firmante necesita firmar
-- SOBRE el que ya firmó el primero, no sobre el original.
--
-- `sha256_vigente` ya guardaba la huella de ese estado intermedio, pero no
-- había dónde guardar de QUÉ archivo era esa huella. Sin eso, el circuito no
-- puede continuar: la huella dice que el documento cambió y no hay forma de
-- recuperar el documento cambiado.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

alter table instancia
  add column archivo_vigente_id uuid references archivo(id);

comment on column instancia.archivo_vigente_id is
  'El PDF tal como está AHORA: con las firmas aplicadas hasta el momento. Cambia con cada firma. Cuando firma el último, este archivo pasa además a archivo_firmado_id, que ya no se toca nunca.';

-- El trigger de la 006 congela la instancia en estado terminal y prohíbe
-- reemplazar `archivo_firmado_id`. `archivo_vigente_id` tiene que poder cambiar
-- mientras la instancia está en curso, así que se rehace la función incluyendo
-- la excepción explícita — y manteniendo intacta la protección del final.
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

  -- El archivo FINAL no se reemplaza. El vigente sí: es el documento en curso.
  if old.archivo_firmado_id is not null
     and new.archivo_firmado_id is distinct from old.archivo_firmado_id then
    raise exception 'el archivo firmado no se reemplaza';
  end if;

  return new;
end $$;

commit;
