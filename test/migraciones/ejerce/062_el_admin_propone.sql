-- =============================================================================
-- MiFirma — test/migraciones/ejerce/062_el_admin_propone.sql
--
-- La prueba de COMPORTAMIENTO de la 062. Que la función exista no prueba nada.
-- Lo que se ejerce es lo que la 061 prometió y el código no cumplía:
--
--                                          │ ¿queda escrito? │ ¿lo ve el login?
--   admin carga un celular a alguien suyo  │  sí, PROPUESTO  │       NO
--   admin se lo carga a alguien de otra    │       NO        │        —
--     empresa                              │                 │
--   alguien sin permiso de accesos         │       NO        │        —
--   la persona YA confirmó un número       │  no se pisa     │  el suyo, no
--                                          │                 │  el del admin
--   celular mal escrito                    │       NO        │        —
--
-- ⚠ «¿Lo ve el login?» se pregunta con LA MISMA consulta que hace
-- `auth_login.ts` (`select telefono_e164 from credencial`), no con una
-- parecida: lo que importa es el camino real por donde sale el SMS.
--
-- ⚠⚠ Y la pregunta que ordena todo esto: la función es `security definer`, o
-- sea que **se saltea la RLS**. Si algún día alguien le afloja una condición,
-- este archivo tiene que ponerse rojo.
-- =============================================================================

\set ON_ERROR_STOP on
\pset pager off

-- ⚠ EL CINTURÓN. Este archivo ESCRIBE. Se exige la marca del banco.
do $guard$ begin
  if not exists (select 1 from information_schema.tables
                  where table_schema = 'public' and table_name = 'banco_de_pruebas') then
    raise exception 'ABORTADO: esto escribe datos de prueba y no encuentro la marca del banco. Si esto es la base real, MENOS MAL.';
  end if;
end $guard$;

begin;

-- ── El reparto ──────────────────────────────────────────────────────────────
insert into cuenta (id, nombre_mostrado) values
  ('cccc0000-0000-0000-0000-000000062002', 'Otra Empresa S.A.');

insert into identidad (id, email_mostrado, nombre_mostrado) values
  ('ffff0000-0000-0000-0000-0000000620ad', 'admin.062@ejemplo.com', 'Admin 062'),
  ('ffff0000-0000-0000-0000-0000000620a1', 'ana.062@ejemplo.com',   null),
  ('ffff0000-0000-0000-0000-0000000620b2', 'beto.062@ejemplo.com',  'Beto 062'),
  ('ffff0000-0000-0000-0000-0000000620c3', 'carla.062@ejemplo.com', null),
  ('ffff0000-0000-0000-0000-0000000620d4', 'pedro.062@ejemplo.com', null);

-- Ana, Beto y Pedro son de la empresa del admin. Carla es de la otra.
insert into membresia (identidad_id, cuenta_id) values
  ('ffff0000-0000-0000-0000-0000000620ad', '22222222-2222-2222-2222-222222222222'),
  ('ffff0000-0000-0000-0000-0000000620a1', '22222222-2222-2222-2222-222222222222'),
  ('ffff0000-0000-0000-0000-0000000620b2', '22222222-2222-2222-2222-222222222222'),
  ('ffff0000-0000-0000-0000-0000000620d4', '22222222-2222-2222-2222-222222222222'),
  ('ffff0000-0000-0000-0000-0000000620c3', 'cccc0000-0000-0000-0000-000000062002');

-- El permiso de gestionar accesos, sólo para el admin. Pedro entra igual a la
-- consola; lo que no tiene es esta capacidad.
insert into capacidad (id, recurso, accion) values
  ('caca0000-0000-0000-0000-000000062001', 'usuario', 'administrar');
insert into rol (id, cuenta_id, nombre) values
  ('0000d000-0000-0000-0000-000000062001', '22222222-2222-2222-2222-222222222222', 'Administrador 062'),
  ('0000d000-0000-0000-0000-000000062002', '22222222-2222-2222-2222-222222222222', 'Mirón 062');
insert into rol_capacidad (rol_id, capacidad_id) values
  ('0000d000-0000-0000-0000-000000062001', 'caca0000-0000-0000-0000-000000062001');
insert into usuario_rol (identidad_id, cuenta_id, rol_id) values
  ('ffff0000-0000-0000-0000-0000000620ad', '22222222-2222-2222-2222-222222222222', '0000d000-0000-0000-0000-000000062001'),
  ('ffff0000-0000-0000-0000-0000000620d4', '22222222-2222-2222-2222-222222222222', '0000d000-0000-0000-0000-000000062002');

-- Beto ya confirmó el suyo. Es el caso que NO se puede pisar.
insert into credencial (identidad_id, hash_password, telefono_e164) values
  ('ffff0000-0000-0000-0000-0000000620b2', 'x', '+59899000062');

do $ejerce$
declare
  v_cuenta   uuid := '22222222-2222-2222-2222-222222222222';
  v_admin    uuid := 'ffff0000-0000-0000-0000-0000000620ad';
  v_ana      uuid := 'ffff0000-0000-0000-0000-0000000620a1';
  v_beto     uuid := 'ffff0000-0000-0000-0000-0000000620b2';
  v_carla    uuid := 'ffff0000-0000-0000-0000-0000000620c3';
  v_pedro    uuid := 'ffff0000-0000-0000-0000-0000000620d4';
  v_mal      text := '';
  v_paso     boolean;
  v_login    text;
begin
  -- Nos paramos en los zapatos del admin.
  perform set_config('app.actor',     'cuenta',        true);
  perform set_config('app.cuenta',    v_cuenta::text,  true);
  perform set_config('app.identidad', v_admin::text,   true);

  -- ═══ 1. LO QUE CLAUDIO PIDIÓ: cargarle el celular a su gente ═══
  perform app.proponer_datos_de_acceso(v_ana, 'Ana 062', '+59899000001');

  if (select telefono_propuesto_e164 from credencial where identidad_id = v_ana)
     is distinct from '+59899000001' then
    v_mal := v_mal || E'\n  ⚠ el celular que cargó el admin no quedó guardado — es el defecto que esta migración existe para tapar';
  end if;

  if (select nombre_mostrado from identidad where id = v_ana) is distinct from 'Ana 062' then
    v_mal := v_mal || E'\n  ⚠ el nombre que cargó el admin no quedó guardado';
  end if;

  -- ⚠⚠ LA PREGUNTA QUE DECIDE. La misma consulta que hace auth_login.ts.
  select telefono_e164 into v_login from credencial where identidad_id = v_ana;
  if v_login is not null then
    v_mal := v_mal || E'\n  ⚠⚠ EL LOGIN VE EL NÚMERO QUE PUSO EL ADMIN: eso es regalarle la cuenta de esa persona';
  end if;

  -- ═══ 2. EL NOMBRE PROPIO NO SE PISA ═══
  perform app.proponer_datos_de_acceso(v_ana, 'Otro Nombre', null);
  if (select nombre_mostrado from identidad where id = v_ana) <> 'Ana 062' then
    v_mal := v_mal || E'\n  ⚠ el admin le renombró la identidad a alguien que ya tenía nombre';
  end if;

  -- ═══ 3. A QUIEN YA CONFIRMÓ, NO SE LE PISA NADA ═══
  perform app.proponer_datos_de_acceso(v_beto, null, '+59899999999');
  if (select telefono_e164 from credencial where identidad_id = v_beto) <> '+59899000062' then
    v_mal := v_mal || E'\n  ⚠⚠ SE PISÓ EL TELÉFONO CONFIRMADO DE BETO: el admin acaba de quedarse con su segundo factor';
  end if;
  if (select telefono_propuesto_e164 from credencial where identidad_id = v_beto) is not null then
    v_mal := v_mal || E'\n  ⚠ se le dejó una propuesta viva a alguien que ya tiene número confirmado: el suyo manda y la propuesta no pinta nada';
  end if;

  -- ═══ 4. ALGUIEN DE OTRA EMPRESA: NO ═══
  v_paso := false;
  begin
    perform app.proponer_datos_de_acceso(v_carla, null, '+59899000003');
    v_paso := true;
  exception when others then null;
  end;
  if v_paso then
    v_mal := v_mal || E'\n  ⚠⚠ un admin le escribió en la credencial a alguien de OTRA empresa';
  end if;

  -- ═══ 5. SIN EL PERMISO DE ACCESOS: NO ═══
  perform set_config('app.identidad', v_pedro::text, true);
  v_paso := false;
  begin
    perform app.proponer_datos_de_acceso(v_ana, null, '+59899000004');
    v_paso := true;
  exception when others then null;
  end;
  if v_paso then
    v_mal := v_mal || E'\n  ⚠⚠ alguien sin permiso de gestionar accesos pudo proponer un celular';
  end if;
  perform set_config('app.identidad', v_admin::text, true);

  -- ═══ 6. UN CELULAR MAL ESCRITO NO ENTRA ═══
  v_paso := false;
  begin
    perform app.proponer_datos_de_acceso(v_ana, null, '099662634');
    v_paso := true;
  exception when others then null;
  end;
  if v_paso then
    v_mal := v_mal || E'\n  ⚠ se aceptó un celular sin el país adelante: el SMS no saldría y nadie se enteraría hasta que haga falta';
  end if;

  -- ═══ 7. Y SIN CONTEXTO DE CUENTA, NADA ═══
  perform set_config('app.cuenta', '', true);
  v_paso := false;
  begin
    perform app.proponer_datos_de_acceso(v_ana, null, '+59899000005');
    v_paso := true;
  exception when others then null;
  end;
  if v_paso then
    v_mal := v_mal || E'\n  ⚠⚠ la función corrió sin contexto de cuenta: se saltea la RLS, así que sin contexto no puede hacer NADA';
  end if;

  if v_mal <> '' then
    raise exception E'La 062 no hace lo que dice:%', v_mal;
  end if;

  raise notice '✓ ejercido: el admin propone y no habilita; lo confirmado no se pisa; el de afuera y el sin permiso, rebotan.';
end
$ejerce$;

rollback;
