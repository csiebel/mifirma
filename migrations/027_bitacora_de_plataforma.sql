-- =============================================================================
-- MiFirma — 027_bitacora_de_plataforma.sql
-- Los envíos de OTP no tenían dónde anotarse.
--
-- ═══ EL PROBLEMA ═══
--
-- `bitacora_plataforma.cuenta_id` es NOT NULL, y el envío de un código de acceso
-- ocurre ANTES de que exista una cuenta en la conversación. El login de MiFirma
-- invierte el orden de payroll a propósito —primero quién sos, después a qué
-- cuenta entrás— así que en el momento de mandar el SMS lo único que se sabe es
-- la identidad. Y una identidad puede ser miembro de cinco cuentas: elegir una
-- para poder escribir la fila sería inventar un dato.
--
-- El resultado práctico: cuando alguien dice "no me llegó el código", no hay
-- dónde mirar. Es exactamente el agujero que ya tapamos para el correo de los
-- avisos de firma, en el otro canal.
--
-- ═══ QUÉ SE ABRE Y QUÉ NO ═══
--
-- `cuenta_id` pasa a admitir null. Una fila sin cuenta es un evento DE LA
-- PLATAFORMA, no de un cliente: "se mandó un SMS", "Twilio devolvió 21608".
--
-- Quién la ve, sin tocar una sola política:
--
--   · El operador SÍ, porque su rama de `bitacora_select` es `app.actor() =
--     'operador'`, sin condición sobre la cuenta.
--   · Ninguna cuenta, porque la otra rama es `cuenta_id = app.cuenta_actual()`,
--     y en SQL `null = <lo que sea>` no es verdadero. No hay que confiar en que
--     alguien se acuerde de filtrar: el álgebra de nulls ya lo hace.
--
-- Y eso es lo correcto: que a una persona le mandamos un código no es asunto de
-- la empresa donde trabaja. Lo que la empresa sí ve —`login.ok`, con su
-- cuenta_id— se escribe después, cuando ya eligió a cuál entrar.
--
-- ═══ POR QUÉ EL CHECK ═══
--
-- Un null en `cuenta_id` vuelve la fila invisible para todos los clientes. Si
-- mañana un bug escribe un evento de cliente sin cuenta, ese evento desaparece
-- de la consola de su dueño y nadie se entera nunca — el modo de falla favorito
-- de este sistema, que es la ausencia silenciosa.
--
-- El CHECK acota la puerta a lo mínimo: sólo el actor 'sistema' puede omitir la
-- cuenta. Un evento de usuario o de operador sin cuenta ahora es un error en el
-- INSERT, en el momento, con nombre y apellido. Lección de 024: un invariante
-- escrito en un comentario no es un invariante.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

alter table bitacora_plataforma alter column cuenta_id drop not null;

-- Idempotente a propósito. Una migración que explota al correrla dos veces
-- obliga a saber de memoria cuáles ya se corrieron, y eso es justamente lo que
-- una migración tendría que evitar.
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'bitacora_sin_cuenta_solo_sistema') then
    alter table bitacora_plataforma
      add constraint bitacora_sin_cuenta_solo_sistema
      check (cuenta_id is not null or actor_tipo = 'sistema');
  end if;
end $c$;

comment on column bitacora_plataforma.cuenta_id is
  'Null = evento de plataforma, anterior a toda cuenta (envío de OTP, prueba de '
  'pasarela). Lo ve el operador y ninguna cuenta: la política compara '
  'cuenta_id = app.cuenta_actual() y null nunca es igual a nada. Ver 027.';

-- Índice para "¿qué pasó a nivel plataforma?", que es la consulta del operador
-- cuando alguien reporta que no le llegó un código. El índice por cuenta no
-- sirve: estas filas justamente no tienen cuenta.
create index if not exists bitacora_plataforma_sin_cuenta
  on bitacora_plataforma (ocurrido_en desc)
  where cuenta_id is null;

commit;
