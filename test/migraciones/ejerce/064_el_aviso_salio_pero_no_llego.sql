-- =============================================================================
-- ejerce/064 — «No salió» y «salió y no llegó» tienen que poder distinguirse.
-- =============================================================================
--
-- La migración entra y se repite; eso ya lo prueba correrla dos veces. Lo que
-- prueba esto es lo otro:
--
--   1. ⚠⚠ Que los CUATRO textos del correo sean DISTINTOS ENTRE SÍ. Es la
--      aserción central y la que ninguna lectura garantiza: dos eventos con la
--      misma frase no se pueden distinguir cuando importa, que es exactamente
--      la deuda 39 y exactamente el defecto que esta migración vino a corregir.
--   2. Que el hecho nuevo exista con la categoría y el peso que se le pensaron.
--   3. Que el índice cubra los TRES tipos: si se quedó en dos, la consulta de
--      «¿ya tiene veredicto?» deja de usarlo y nadie se entera.
--   4. Que anotar una no-entrega respete la cadena de hashes.
--   5. Que la pregunta por el veredicto encuentre CUALQUIERA de los dos: son
--      excluyentes, y el webhook se apoya en eso para no anotar dos veces.
-- =============================================================================

do $$
declare
  v_textos     int;
  v_categoria  text;
  v_peso       text;
  v_def        text;
  v_instancia  uuid;
  v_antes      bigint;
  v_nuevo      bigint;
  v_hash_prev  bytea;
  v_hash_eng   bytea;
  v_veredictos int;
begin
  -- ── 1. ⚠⚠ Los cuatro textos, distintos entre sí ───────────────────────────
  select count(distinct descripcion_i18n->>'es') into v_textos
    from tipo_evento
   where codigo in ('notificacion.enviada','notificacion.entregada',
                    'notificacion.fallida','notificacion.no_entregada');

  if v_textos <> 4 then
    raise exception 'FALLA 1: los cuatro eventos del correo tienen % textos distintos, no 4. '
                    'Dos de ellos dicen lo mismo y no se van a poder distinguir en el expediente '
                    'justo cuando importe — que es el defecto que esta migración vino a corregir',
                    v_textos;
  end if;

  -- ── 2. El hecho nuevo, como se lo pensó ───────────────────────────────────
  select categoria, peso into v_categoria, v_peso
    from tipo_evento where codigo = 'notificacion.no_entregada';

  if v_categoria is null then
    raise exception 'FALLA 2a: no existe el tipo de evento notificacion.no_entregada';
  end if;
  if v_categoria <> 'entrega' then
    raise exception 'FALLA 2b: notificacion.no_entregada quedó en la categoría %, se esperaba entrega', v_categoria;
  end if;
  if v_peso <> 'alto' then
    raise exception 'FALLA 2c: notificacion.no_entregada quedó con peso %, se esperaba alto — '
                    'un firmante que no recibió el aviso cambia la historia del documento', v_peso;
  end if;

  -- ── 3. El índice cubre los TRES tipos ─────────────────────────────────────
  select indexdef into v_def
    from pg_indexes where indexname = 'evidencia_por_message_id';

  if v_def is null then
    raise exception 'FALLA 3a: desapareció el índice evidencia_por_message_id';
  end if;
  if v_def not like '%no_entregada%' then
    raise exception 'FALLA 3b: el índice no incluye notificacion.no_entregada. La consulta de '
                    '«¿ya tiene veredicto?» deja de usarlo y nadie se entera hasta que la tabla crece';
  end if;

  -- ── 4. Anotar la no-entrega respeta la cadena ─────────────────────────────
  select instancia_id into v_instancia
    from evidencia
   where tipo = 'notificacion.enviada'
     and datos->>'message_id' = 'con-id@mi-firma.digital'
   limit 1;

  select numero_orden, hash_propio into v_antes, v_hash_prev
    from evidencia where instancia_id = v_instancia
   order by numero_orden desc limit 1;

  insert into evidencia (
    instancia_id, circuito_id, cuenta_propietaria_id,
    actor_tipo, tipo, datos, ocurrido_en, canal,
    numero_orden, hash_contenido, hash_propio
  )
  select instancia_id, circuito_id, cuenta_propietaria_id,
         'proveedor', 'notificacion.no_entregada',
         '{"canal":"email","proveedor":"brevo","message_id":"con-id@mi-firma.digital",
           "motivo_proveedor":"hard_bounce","detalle":"buzon inexistente"}'::jsonb,
         '2026-08-10 10:00:45+00', 'webhook',
         0, ''::bytea, ''::bytea
    from evidencia
   where tipo = 'notificacion.enviada'
     and datos->>'message_id' = 'con-id@mi-firma.digital';

  select numero_orden, hash_anterior into v_nuevo, v_hash_eng
    from evidencia
   where instancia_id = v_instancia and tipo = 'notificacion.no_entregada';

  if v_nuevo <> v_antes + 1 then
    raise exception 'FALLA 4a: la no-entrega quedó con número % y el anterior era % — la cadena no siguió',
                    v_nuevo, v_antes;
  end if;
  if v_hash_eng is distinct from v_hash_prev then
    raise exception 'FALLA 4b: la no-entrega no enganchó el hash del evento anterior. Cadena rota';
  end if;

  -- ── 5. La pregunta por el veredicto encuentra cualquiera de los dos ───────
  select count(*) into v_veredictos
    from evidencia
   where tipo in ('notificacion.entregada','notificacion.no_entregada')
     and datos->>'message_id' = 'con-id@mi-firma.digital';

  if v_veredictos <> 1 then
    raise exception 'FALLA 5: la consulta de veredicto devolvió % filas, se esperaba 1. '
                    'El webhook se apoya en esto para no anotar dos veredictos sobre el mismo mensaje',
                    v_veredictos;
  end if;

  raise notice '✓ 064: los cuatro textos del correo son distintos entre sí, el hecho nuevo tiene '
               'categoría entrega y peso alto, el índice cubre los tres tipos, la no-entrega '
               'respeta la cadena, y la pregunta por el veredicto la encuentra.';
end $$;
