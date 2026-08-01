-- =============================================================================
-- MiFirma — 016_anclaje_de_sesion.sql
-- Qué anclaje se probó al confiar en un dispositivo.
--
-- El problema que resuelve: el nivel de garantía es de la SESIÓN, no de la
-- identidad, y los otorgamientos que exigen nivel se verifican contra los
-- anclajes probados EN ESTA sesión (test T6: registrarse no alcanza, hay que
-- probar el anclaje).
--
-- Con dispositivo de confianza no hay OTP: se entra sólo con contraseña. Sin
-- este dato habría dos salidas, las dos malas — o la sesión queda sin ningún
-- anclaje probado y el firmante no puede abrir su propio documento hasta pedir
-- un código, o se asume que probó algo que en esta sesión no probó.
--
-- La tercera salida es esta: el dispositivo recuerda QUÉ anclaje se probó el
-- día que se lo marcó como confiable, y la sesión hereda exactamente ese, ni
-- más ni menos. Confiar en el dispositivo extiende en el tiempo una prueba que
-- efectivamente ocurrió; no inventa una nueva.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

alter table dispositivo_confiable
  add column anclaje_probado_id uuid references anclaje_identidad(id),
  -- Nivel de garantía con el que se ganó la confianza. Se guarda además del
  -- anclaje porque el anclaje puede revocarse: si eso pasa, la confianza del
  -- dispositivo tiene que caer con él, y para saberlo hay que poder comparar.
  add column nivel_garantia text
    check (nivel_garantia in ('bajo','sustancial','alto'));

-- Un dispositivo cuyo anclaje fue revocado deja de valer como prueba.
--
-- ⚠ `security_invoker = true` NO es opcional. Por defecto una vista de
-- PostgreSQL se ejecuta con los permisos de SU DUEÑO, y el dueño acá es el rol
-- que corrió las migraciones. Eso significa que las políticas RLS de
-- `dispositivo_confiable` se evaluarían como ese dueño —que las saltea— y
-- cualquiera con acceso a la vista vería los dispositivos de TODAS las
-- identidades. Una vista es la forma más silenciosa de perforar la RLS.
create or replace view dispositivo_confiable_vigente
  with (security_invoker = true) as
  select d.*
    from dispositivo_confiable d
    left join anclaje_identidad a on a.id = d.anclaje_probado_id
   where d.revocado_en is null
     and d.expira_en > now()
     and (d.anclaje_probado_id is null or a.revocado_en is null);

grant select on dispositivo_confiable_vigente to app_rw;

-- El OTP también deja anotado a qué anclaje se lo mandó, para poder decir
-- después "probó el mail" o "probó el teléfono" y no sólo "puso un código".
alter table otp_login
  add column anclaje_destino_id uuid references anclaje_identidad(id);

commit;
