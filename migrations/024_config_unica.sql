-- =============================================================================
-- MiFirma — 024_config_unica.sql
-- La conexión de correo es una sola. Ahora la base lo impone.
--
-- ═══ EL SÍNTOMA ═══
--
-- "La conexión de correo no tiene contraseña cargada" — a veces. El correo de
-- prueba salía bien y el aviso de firma fallaba, con la misma configuración, en
-- el mismo proceso, con la misma clave de cifrado.
--
-- ═══ LA CAUSA ═══
--
-- `correo.ts` y `twilio.ts` tratan su tabla como un singleton:
--
--     selectAll().executeTakeFirst()
--
-- sin `order by` y sin ninguna garantía de que haya una sola fila. La 014 dice
-- en un comentario "un solo remitente activo a la vez: si hay dos, el que sale
-- depende del orden de la consulta" — lo escribió, lo explicó, y no lo impuso.
--
-- Con dos filas —una cargada desde el script de línea de comandos y otra desde
-- la consola del operador, por ejemplo— PostgreSQL devuelve la que le queda más
-- a mano, y eso cambia con cualquier UPDATE que mueva una fila de página. De ahí
-- el "a veces": la prueba tomaba la fila con contraseña y el envío la otra.
--
-- ═══ LA LECCIÓN ═══
--
-- Un invariante escrito en un comentario no es un invariante: es una intención.
-- Si el código asume "hay exactamente una fila", eso es una restricción de la
-- base o no existe. Y el modo en que falla es el peor posible — intermitente,
-- sin error, dependiente del orden físico de las filas.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- Limpieza antes de restringir
--
-- Se conserva la fila con credencial cargada —y entre varias, la más reciente—
-- porque es la única que sirve para algo. Las demás son configuraciones a medio
-- hacer que quedaron dando vueltas.
-- -----------------------------------------------------------------------------
delete from correo_config c
 where c.id <> (
   select id from correo_config
    order by (password_cifrado is not null) desc, actualizada_en desc, creada_en desc
    limit 1);

delete from twilio_config t
 where t.id <> (
   select id from twilio_config
    order by (auth_token_cifrado is not null) desc, actualizada_en desc, creada_en desc
    limit 1);

-- -----------------------------------------------------------------------------
-- Una fila y nada más
--
-- Índice único sobre una constante: es la forma de decir "esta tabla tiene como
-- máximo una fila". Un segundo INSERT falla con violación de unicidad en vez de
-- crear el problema silencioso de arriba.
-- -----------------------------------------------------------------------------
create unique index correo_config_unica on correo_config ((true));
create unique index twilio_config_unica on twilio_config ((true));

commit;
