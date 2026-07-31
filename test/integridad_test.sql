-- =============================================================================
-- MiFirma — tests de integridad (triggers)
-- Se corren como DUEÑO de las tablas: verifican la segunda cerradura, la que
-- actúa aunque alguien llegue por fuera de las políticas RLS.
-- =============================================================================

\set ON_ERROR_STOP on

-- ---------- TEST 8b: el trigger también lo rechaza si la política lo dejara --
-- Se corre como dueño de la tabla, que bypassa RLS: verifica la segunda cerradura.
begin;
  do $$
  declare v_err text;
  begin
    begin
      update otorgamiento set revocado_en = now() where irrevocable;
      raise exception 'FALLA T8b: el trigger permitió revocar un irrevocable';
    exception when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'FALLA T8b%' then raise; end if;
      raise notice 'OK T8b — trigger: %', v_err;
    end;
  end $$;
rollback;

-- ---------- TEST 9: no se puede modificar un otorgamiento -------------------
begin;
  do $$
  declare v_err text;
  begin
    begin
      update otorgamiento set alcances = array['administrar'] where not irrevocable;
      raise exception 'FALLA T9: se pudo modificar un otorgamiento';
    exception when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'FALLA T9%' then raise; end if;
      raise notice 'OK T9 — modificación rechazada: %', v_err;
    end;
  end $$;
rollback;

-- ---------- TEST 10: la instancia terminal es inmutable ---------------------
begin;
  set local app.actor = 'sistema';
  do $$
  declare v_err text;
  begin
    begin
      update instancia set estado = 'en_curso' where estado = 'firmada';
      raise exception 'FALLA T10: se pudo reabrir una instancia firmada';
    exception when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'FALLA T10%' then raise; end if;
      raise notice 'OK T10 — instancia terminal inmutable: %', v_err;
    end;
  end $$;
rollback;
