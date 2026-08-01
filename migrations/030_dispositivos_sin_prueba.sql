-- =============================================================================
-- MiFirma — 030_dispositivos_sin_prueba.sql
-- Revocar los dispositivos de confianza que no prueban nada.
--
-- ═══ QUÉ SE ROMPIÓ ═══
--
-- `anclaje_identidad` se creaba en UN solo lugar de todo el sistema: cuando un
-- firmante externo abría su enlace. Una persona que se registraba y entraba con
-- su contraseña no tenía ningún anclaje nunca.
--
-- Encadenado: el OTP se guardaba con `anclaje_destino_id` en null → al acertar
-- el código, el dispositivo se recordaba con `anclaje_probado_id` en null → cada
-- login posterior salteaba el segundo factor y emitía la sesión con el conjunto
-- de anclajes VACÍO. Para siempre, porque la confianza es deslizante y se
-- renueva sola con cada uso.
--
-- Resultado: `app.identidad_probada()` era falso para todos los usuarios con
-- cuenta, y cualquier política que dependiera de eso no servía. Nunca dio un
-- error: simplemente nunca fue verdad. Se descubrió el 1/8/2026 al escribir la
-- primera política que dependía SÓLO de esa rama (`firma_visual`).
--
-- ═══ POR QUÉ SE REVOCA Y NO SE RELLENA ═══
--
-- La tentación es poner el anclaje de email a cada dispositivo recordado y
-- seguir. Sería inventar una prueba: ese dispositivo se confió sin que quedara
-- registro de qué se acreditó. Un anclaje es un HECHO PROBADO, no un valor por
-- defecto — y esto es un producto de firma electrónica, donde la diferencia
-- entre "lo probó" y "lo damos por bueno" es exactamente el producto.
--
-- El costo es un segundo factor de más, una vez, para quien tenga un
-- dispositivo recordado. A partir de ahí el anclaje se crea al validar el
-- código y todo queda bien encadenado.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

update dispositivo_confiable
   set revocado_en = now()
 where revocado_en is null
   and anclaje_probado_id is null;

commit;

select count(*) as dispositivos_revocados_sin_prueba
  from dispositivo_confiable
 where revocado_en is not null and anclaje_probado_id is null;
