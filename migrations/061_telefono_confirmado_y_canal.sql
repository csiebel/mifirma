-- 061 — El teléfono propuesto vs. el confirmado, y por dónde quiere cada uno
--       recibir su código. Diseño del 9/8 (`telefono-y-contrasena-del-usuario.md`),
--       ampliado por Claudio el 15/8: el canal lo elige la persona.
--
-- ═══ EL AGUJERO QUE ESTO TAPA ═══
--
-- `auth_login.ts` lee `credencial.telefono_e164` DERECHO para mandar el código
-- de acceso — tres lugares, sin condición ninguna. O sea: cualquier número que
-- quede en esa columna es una llave de esa cuenta.
--
-- Claudio pidió que el administrador de una empresa pueda cargarle el celular
-- a su gente. Escrito en `telefono_e164`, eso sería regalarle el acceso: el
-- admin pone SU número, pide el código, y entra como cualquiera de ellos —
-- incluida gente que firma documentos con valor legal.
--
-- Y no había red: `otp_habilitado` existe desde la 003 y **nunca se escribió
-- en ningún lado**. No protegía nada; sólo lo parecía.
--
-- ═══ LA REGLA, EN UNA FRASE ═══
--
--   Lo que está en `telefono_e164` es un número que su dueño CONFIRMÓ.
--   El login puede leerlo sin preguntar nada más.
--
--   telefono_propuesto_e164  · lo escribe el admin  · no habilita NADA
--   telefono_e164            · sólo la persona,     · habilita el segundo
--                              con su contraseña      factor por teléfono
--                              y acertando el código
--
-- ⚠ Se eligió esto y no «que el login exija un anclaje vigente» —más elegante—
-- porque así **el login no cambia una línea**, y es el camino más delicado del
-- sistema. La elegancia no vale un error ahí.
--
-- ═══ EL CANAL: LA COLUMNA MUERTA SE REEMPLAZA ═══
--
-- `otp_habilitado` (booleano, nunca escrito) se va. En su lugar `otp_canal`,
-- que responde la pregunta que la gente sí tiene: **por dónde querés que te
-- llegue el código**. Los tres canales YA existen en el login y en la pantalla
-- de entrada (`/auth/otp/elegir`, en tres idiomas): lo que faltaba era que la
-- elección se recordara en vez de preguntarse cada vez.
--
-- ⚠⚠ **El correo es siempre el respaldo, y por eso no se puede apagar.**
-- Decisión de Claudio, 15/8: «siempre mail de respaldo». Quien elige WhatsApp y
-- se queda sin el celular tiene que poder entrar a su propia cuenta. Elegir un
-- canal ahorra un paso; no puede dejar a nadie afuera.
--
-- ⚠ Elegir 'sms' o 'whatsapp' no garantiza que salga por ahí: hace falta además
-- un teléfono CONFIRMADO y que el operador tenga ese canal conectado en Twilio.
-- Si algo de eso falta, el código sale por correo. La preferencia es un deseo,
-- no una promesa — y la pantalla sólo ofrece lo que hoy es posible.

\set ON_ERROR_STOP on

begin;

-- -----------------------------------------------------------------------------
-- 1. El número que propone la empresa. No es un anclaje: es un dato para que
--    la persona no tenga que tipearlo.
-- -----------------------------------------------------------------------------
alter table credencial
  add column if not exists telefono_propuesto_e164 text;

comment on column credencial.telefono_propuesto_e164 is
  'Celular que cargó el administrador. NO habilita el segundo factor: hay que '
  'confirmarlo con la contraseña y un código para que pase a telefono_e164.';

comment on column credencial.telefono_e164 is
  'Celular CONFIRMADO por su dueño. El login lo lee sin preguntar nada más, '
  'así que acá no escribe nadie más que la propia persona.';

-- Los dos números, en el mismo formato. El de la app valida antes; esto es el
-- cinturón, y agarra a cualquiera que escriba por SQL.
do $fmt$ begin
  if not exists (select 1 from pg_constraint where conname = 'credencial_tel_propuesto_e164') then
    alter table credencial add constraint credencial_tel_propuesto_e164
      check (telefono_propuesto_e164 is null
             or telefono_propuesto_e164 ~ '^\+[1-9][0-9]{7,14}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'credencial_tel_e164') then
    alter table credencial add constraint credencial_tel_e164
      check (telefono_e164 is null or telefono_e164 ~ '^\+[1-9][0-9]{7,14}$');
  end if;
end $fmt$;

-- -----------------------------------------------------------------------------
-- 2. Por dónde quiere el código. Reemplaza a `otp_habilitado`.
-- -----------------------------------------------------------------------------
alter table credencial
  add column if not exists otp_canal text not null default 'email';

do $canal$ begin
  if not exists (select 1 from pg_constraint where conname = 'credencial_otp_canal') then
    alter table credencial add constraint credencial_otp_canal
      check (otp_canal in ('email', 'sms', 'whatsapp'));
  end if;
end $canal$;

comment on column credencial.otp_canal is
  'Por dónde prefiere recibir el código de acceso. El correo SIEMPRE queda '
  'como respaldo ofrecido: elegir un canal ahorra un paso, no encierra a nadie.';

-- ⚠ Se cae ahora y no «algún día»: mientras exista, el próximo que la lea le
-- va a creer. Es exactamente la trampa que este proyecto ya pisó con la 052.
-- Nadie la lee ni la escribe (verificado el 15/8: aparece sólo en el DDL de la
-- 003 y en el esquema generado), así que no hay dato que rescatar.
alter table credencial drop column if exists otp_habilitado;

-- -----------------------------------------------------------------------------
-- 3. El código con el que la persona confirma su teléfono.
--
-- ⚠⚠ **NO se reusa `otp_login`, y ése es el punto.** Un código pedido para
-- «confirmá que este teléfono es tuyo» NO puede servir para ENTRAR: si viviera
-- en la misma tabla, `verificarOtp` lo aceptaría como código de acceso y
-- cualquiera que interceptara un SMS de confirmación tendría una sesión.
--
-- `token_acceso` ya resuelve lo que hace falta —hash, vencimiento, un solo uso,
-- índice de vigentes— y vive en otro carril. Sólo hay que dejarlo nombrar este
-- caso: la lista de tipos es cerrada, y así queda.
-- -----------------------------------------------------------------------------
alter table token_acceso drop constraint if exists token_acceso_tipo_check;
alter table token_acceso add constraint token_acceso_tipo_check
  check (tipo in ('reset', 'invitacion', 'verificacion_email', 'confirmar_telefono'));

-- -----------------------------------------------------------------------------
-- 4. ⚠⚠ La tranca de verdad, en la capa de datos.
--
--    La app promete que el admin escribe la propuesta y la persona confirma.
--    Una promesa de la app es una promesa que se rompe con un `update` de más.
--    Este trigger la hace cumplir a la base: para que un número LLEGUE a
--    `telefono_e164`, tiene que venir de la propuesta que la persona confirmó
--    —y ahí la propuesta se borra— o escribirse cuando no hay ninguna propuesta
--    en juego (la persona tipeó su número).
--
--    Lo que NO puede pasar nunca: que un número aparezca confirmado en el mismo
--    movimiento en que alguien lo propone. Ése es el ataque.
-- -----------------------------------------------------------------------------
create or replace function app.telefono_confirmado_no_se_regala()
returns trigger
language plpgsql
as $$
begin
  -- Nace con teléfono confirmado y propuesto a la vez: eso es la propuesta
  -- disfrazada de confirmación.
  if tg_op = 'INSERT' then
    if new.telefono_e164 is not null and new.telefono_propuesto_e164 is not null then
      raise exception 'Un teléfono no puede nacer propuesto y confirmado a la vez: %',
        'la persona lo tiene que confirmar.';
    end if;
    return new;
  end if;

  -- Cambia el confirmado en el MISMO update que deja una propuesta viva.
  if new.telefono_e164 is distinct from old.telefono_e164
     and new.telefono_e164 is not null
     and new.telefono_propuesto_e164 is not null then
    raise exception 'Al confirmar un teléfono, la propuesta se consume: %',
      'no puede quedar una propuesta viva junto a un número recién confirmado.';
  end if;

  return new;
end;
$$;

drop trigger if exists credencial_telefono_confirmado on credencial;
create trigger credencial_telefono_confirmado
  before insert or update on credencial
  for each row execute function app.telefono_confirmado_no_se_regala();

commit;
