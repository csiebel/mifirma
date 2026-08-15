-- =============================================================================
-- MiFirma — test/migraciones/ejerce/061_telefono_confirmado_y_canal.sql
--
-- La prueba de COMPORTAMIENTO de la 061. Que la columna exista no prueba nada:
-- lo que importa es que **un número propuesto por el administrador no alcance
-- para recibir el código de acceso**. Ésa es la única razón por la que esta
-- migración existe.
--
-- Las preguntas, en una tabla:
--
--                                    │ ¿lo ve el login? │ ¿lo permite la base?
--   admin propone un número          │       NO         │ sí (es un dato)
--   admin lo escribe como confirmado │  (sería SÍ) ⚠    │ NO — el trigger
--     en el mismo movimiento         │                  │
--   la persona confirma el propuesto │       SÍ         │ sí, y la propuesta
--                                    │                  │ se consume
--   canal fuera de los tres          │        —         │ NO — el check
--
-- ⚠ «¿Lo ve el login?» se ejerce con LA MISMA consulta que hace `auth_login.ts`
-- (`select c.telefono_e164 ... from credencial c`), no con una parecida: lo que
-- se prueba es el camino real por donde sale el SMS.
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

insert into identidad (id, email_mostrado, nombre_mostrado) values
  ('ffff0000-0000-0000-0000-0000000610a1', 'ana.061@ejemplo.com',  'Ana 061'),
  ('ffff0000-0000-0000-0000-0000000610b2', 'beto.061@ejemplo.com', 'Beto 061');

-- Ana: el administrador le propuso un número. Nadie lo confirmó todavía.
insert into credencial (identidad_id, hash_password, telefono_propuesto_e164) values
  ('ffff0000-0000-0000-0000-0000000610a1', 'x', '+59899000001');

-- Beto: confirmó el suyo, y eligió WhatsApp.
insert into credencial (identidad_id, hash_password, telefono_e164, otp_canal) values
  ('ffff0000-0000-0000-0000-0000000610b2', 'x', '+59899000002', 'whatsapp');

do $ejerce$
declare
  v_mal    text := '';
  v_ana    uuid := 'ffff0000-0000-0000-0000-0000000610a1';
  v_beto   uuid := 'ffff0000-0000-0000-0000-0000000610b2';
  v_tel    text;
  v_paso   boolean;
begin
  -- ═══ LO QUE VE EL LOGIN ═══ Misma consulta que `auth_login.ts`.

  select c.telefono_e164 into v_tel from credencial c where c.identidad_id = v_ana;
  if v_tel is not null then
    v_mal := v_mal || E'\n  ⚠⚠ el login VE el número que propuso el administrador — eso es regalarle la cuenta ajena';
  end if;

  select c.telefono_e164 into v_tel from credencial c where c.identidad_id = v_beto;
  if v_tel is null then
    v_mal := v_mal || E'\n  ⚠ el login NO ve el número que Beto confirmó — el segundo factor no funcionaría para nadie';
  end if;

  -- ═══ EL ATAQUE ═══ El administrador escribe su número derecho en la columna
  -- confirmada, en el mismo movimiento en que propone. La base tiene que
  -- rechazarlo: es lo único que separa «proponer» de «entrar como otro».
  v_paso := false;
  begin
    update credencial
       set telefono_e164 = '+59899666666'
     where identidad_id = v_ana;   -- Ana tiene una propuesta viva
    v_paso := true;
  exception when others then
    null;  -- rechazado: es lo que se espera
  end;
  if v_paso then
    v_mal := v_mal || E'\n  ⚠⚠ SE PUDO confirmar un teléfono con una propuesta viva — el trigger no protege nada';
  end if;

  -- Y nacer confirmado+propuesto a la vez, tampoco.
  v_paso := false;
  begin
    insert into credencial (identidad_id, hash_password, telefono_e164, telefono_propuesto_e164)
    values ('ffff0000-0000-0000-0000-0000000610c3', 'x', '+59899000003', '+59899000004');
    v_paso := true;
  exception when others then
    null;
  end;
  if v_paso then
    v_mal := v_mal || E'\n  ⚠⚠ una credencial pudo NACER con teléfono propuesto y confirmado a la vez';
  end if;

  -- ═══ EL CAMINO BUENO ═══ La persona confirma: el número pasa, y la propuesta
  -- se consume en el mismo movimiento.
  update credencial
     set telefono_e164 = telefono_propuesto_e164,
         telefono_propuesto_e164 = null
   where identidad_id = v_ana;

  select c.telefono_e164 into v_tel from credencial c where c.identidad_id = v_ana;
  if v_tel is distinct from '+59899000001' then
    v_mal := v_mal || E'\n  ⚠ Ana confirmó su teléfono y el login sigue sin verlo';
  end if;
  if exists (select 1 from credencial
              where identidad_id = v_ana and telefono_propuesto_e164 is not null) then
    v_mal := v_mal || E'\n  ⚠ la propuesta sobrevivió a la confirmación: quedaría un número fantasma';
  end if;

  -- ═══ EL CANAL ═══ Sólo los tres, y por omisión el que nunca deja a nadie
  -- afuera.
  v_paso := false;
  begin
    update credencial set otp_canal = 'paloma' where identidad_id = v_beto;
    v_paso := true;
  exception when others then
    null;
  end;
  if v_paso then
    v_mal := v_mal || E'\n  ⚠ se aceptó un canal que el login no sabe mandar';
  end if;

  if (select otp_canal from credencial where identidad_id = v_ana) <> 'email' then
    v_mal := v_mal || E'\n  ⚠ el canal por omisión no es el correo — el respaldo tiene que ser el que siempre existe';
  end if;

  -- ═══ LA COLUMNA MUERTA ═══
  if exists (select 1 from information_schema.columns
              where table_name = 'credencial' and column_name = 'otp_habilitado') then
    v_mal := v_mal || E'\n  ⚠ `otp_habilitado` sigue ahí: una columna que nadie escribe y todos leen como si dijera algo';
  end if;

  -- ═══ EL CÓDIGO DE CONFIRMACIÓN ═══ Tiene que poder existir en su propio
  -- carril, lejos de `otp_login`: un código para confirmar un teléfono no
  -- puede servir para entrar.
  v_paso := false;
  begin
    insert into token_acceso (identidad_id, tipo, token_hash, expira_en)
    values (v_ana, 'confirmar_telefono', 'hash-de-prueba-061', now() + interval '10 minutes');
    v_paso := true;
  exception when others then
    null;
  end;
  if not v_paso then
    v_mal := v_mal || E'\n  ⚠ no se puede emitir un token de «confirmar_telefono»: la confirmación no tendría cómo viajar';
  end if;

  if v_mal <> '' then
    raise exception E'La 061 no hace lo que dice:%', v_mal;
  end if;

  raise notice '✓ ejercido: lo propuesto no abre puertas, lo confirmado sí, y el correo es el respaldo.';
end
$ejerce$;

rollback;
