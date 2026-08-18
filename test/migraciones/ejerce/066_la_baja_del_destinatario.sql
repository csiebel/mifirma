-- =============================================================================
-- ejerce/066 — La baja del destinatario convive con la entrega, y los SEIS
-- textos del canal se distinguen a simple vista.
-- =============================================================================
--
-- Cuatro cosas:
--
--   1. Que el hecho nuevo exista con la categoría y el peso que se le pensaron.
--   2. Que los SEIS textos del canal sean distintos — y no sólo en castellano:
--      el certificado sale en tres idiomas, y dos textos iguales en portugués
--      son el mismo hecho perdido que dos iguales en castellano.
--   3. ⚠ Que el texto afirme lo que se decidió — que el DESTINATARIO CANCELÓ —
--      y NO suene a fracaso de entrega. La baja no es un correo que no llegó:
--      es una persona que cortó el canal, casi siempre DESPUÉS de recibirlo.
--   4. ⚠⚠ Que la baja CONVIVA con «entregada» sobre el MISMO mensaje, en la
--      misma cadena. Es la prueba de que no es un veredicto: si algún día
--      alguien la mete en la lista de veredictos excluyentes, esto se rompe.
-- =============================================================================

do $$
declare
  v_categoria  text;
  v_peso       text;
  v_texto      text;
  v_es int; v_pt int; v_en int;
  v_instancia  uuid;
  v_mid        text := 'mid-ejerce-066@mi-firma.digital';
  v_n_aviso    bigint;
  v_n_entrega  bigint;
  v_n_baja     bigint;
  v_hash_entrega bytea;
  v_hash_eng   bytea;
begin
  -- ── 1. El hecho nuevo ─────────────────────────────────────────────────────
  select categoria, peso, descripcion_i18n->>'es'
    into v_categoria, v_peso, v_texto
    from tipo_evento where codigo = 'correo.baja_del_destinatario';

  if v_categoria is null then
    raise exception 'FALLA 1a: no existe el tipo de evento correo.baja_del_destinatario';
  end if;
  if v_categoria <> 'envio' then
    raise exception 'FALLA 1b: quedó en la categoría %, se esperaba envio', v_categoria;
  end if;
  if v_peso <> 'alto' then
    raise exception 'FALLA 1c: quedó con peso %, se esperaba alto — es el momento en que el '
                    'canal con esa persona se cortó, y un perito lo busca', v_peso;
  end if;

  -- ── 2. Los SEIS textos, distintos entre sí — en los TRES idiomas ──────────
  select count(distinct descripcion_i18n->>'es'),
         count(distinct descripcion_i18n->>'pt'),
         count(distinct descripcion_i18n->>'en')
    into v_es, v_pt, v_en
    from tipo_evento
   where codigo in ('notificacion.enviada','notificacion.entregada',
                    'notificacion.fallida','notificacion.no_entregada',
                    'enlace.obtenido_por_el_emisor','correo.baja_del_destinatario');

  if v_es <> 6 or v_pt <> 6 or v_en <> 6 then
    raise exception 'FALLA 2: los seis hechos del canal tienen %/%/% textos distintos '
                    '(es/pt/en), no 6/6/6. Dos de ellos dicen lo mismo en algún idioma y no '
                    'se van a poder distinguir en el expediente ni en el certificado',
                    v_es, v_pt, v_en;
  end if;

  -- ── 3. ⚠ El texto afirma la decisión, y no un fracaso ─────────────────────
  if v_texto !~* 'destinatario' or v_texto !~* 'cancel' then
    raise exception 'FALLA 3a: el texto dice «%». La decisión del 17/8 fue que afirme que el '
                    'DESTINATARIO CANCELÓ; si no lo dice, el rótulo dejó de ser el elegido',
                    v_texto;
  end if;
  if v_texto ~* '(no salió|no se pudo|no pudo|fall)' then
    raise exception 'FALLA 3b: el texto dice «%» y suena a fracaso de entrega. La baja NO es '
                    'un correo que no llegó: es una persona que cortó el canal — casi siempre '
                    'DESPUÉS de recibir el correo', v_texto;
  end if;

  -- ── 4. ⚠⚠ La baja convive con «entregada» sobre el MISMO mensaje ──────────
  --
  -- Se arma la historia completa de un mensaje en una instancia real del banco:
  -- salió (enviada) → llegó (entregada) → el destinatario se dio de baja.
  -- Si la baja fuera un veredicto, el tercer insert no tendría sentido junto al
  -- segundo; la cadena tiene que aceptar los tres, encadenados y en orden.
  select instancia_id into v_instancia
    from evidencia where tipo = 'notificacion.enviada' limit 1;
  if v_instancia is null then
    raise exception 'FALLA 4a: el banco no tiene ningún aviso enviado sobre el que probar '
                    '(¿base-minima.sql perdió sus filas de evidencia?)';
  end if;

  insert into evidencia (
    instancia_id, circuito_id, cuenta_propietaria_id,
    actor_tipo, tipo, datos, ocurrido_en, canal,
    numero_orden, hash_contenido, hash_propio
  )
  select instancia_id, circuito_id, cuenta_propietaria_id,
         'sistema', 'notificacion.enviada',
         jsonb_build_object('canal','email','message_id', v_mid),
         '2026-08-17 21:04:00+00', 'sistema',
         0, ''::bytea, ''::bytea
    from evidencia where instancia_id = v_instancia limit 1;

  insert into evidencia (
    instancia_id, circuito_id, cuenta_propietaria_id,
    actor_tipo, tipo, datos, ocurrido_en, canal,
    numero_orden, hash_contenido, hash_propio
  )
  select instancia_id, circuito_id, cuenta_propietaria_id,
         'proveedor', 'notificacion.entregada',
         jsonb_build_object('canal','email','proveedor','brevo','message_id', v_mid),
         '2026-08-17 21:04:26+00', 'webhook',
         0, ''::bytea, ''::bytea
    from evidencia where instancia_id = v_instancia limit 1;

  insert into evidencia (
    instancia_id, circuito_id, cuenta_propietaria_id,
    actor_tipo, tipo, datos, ocurrido_en, canal,
    numero_orden, hash_contenido, hash_propio
  )
  select instancia_id, circuito_id, cuenta_propietaria_id,
         'proveedor', 'correo.baja_del_destinatario',
         jsonb_build_object('canal','email','proveedor','brevo','message_id', v_mid,
                            'motivo_proveedor','unsubscribed'),
         '2026-08-17 21:06:13+00', 'webhook',
         0, ''::bytea, ''::bytea
    from evidencia where instancia_id = v_instancia limit 1;

  select numero_orden into v_n_aviso from evidencia
   where instancia_id = v_instancia and tipo = 'notificacion.enviada'
     and datos->>'message_id' = v_mid;
  select numero_orden, hash_propio into v_n_entrega, v_hash_entrega from evidencia
   where instancia_id = v_instancia and tipo = 'notificacion.entregada'
     and datos->>'message_id' = v_mid;
  select numero_orden, hash_anterior into v_n_baja, v_hash_eng from evidencia
   where instancia_id = v_instancia and tipo = 'correo.baja_del_destinatario'
     and datos->>'message_id' = v_mid;

  if v_n_baja is null then
    raise exception 'FALLA 4b: la cadena no aceptó la baja junto a la entrega del mismo '
                    'mensaje. La baja NO es un veredicto y tiene que poder convivir';
  end if;
  if v_n_entrega <> v_n_aviso + 1 or v_n_baja <> v_n_entrega + 1 then
    raise exception 'FALLA 4c: la historia quedó desordenada (aviso %, entrega %, baja %) — '
                    'la cadena no siguió', v_n_aviso, v_n_entrega, v_n_baja;
  end if;
  if v_hash_eng is distinct from v_hash_entrega then
    raise exception 'FALLA 4d: la baja no enganchó el hash de la entrega anterior. Cadena rota';
  end if;

  raise notice '✓ 066: la baja tiene hecho propio (envio/alto), los seis textos del canal son '
               'distintos en los tres idiomas, el texto afirma lo decidido sin sonar a fracaso, '
               'y sobre un mismo mensaje conviven «entregada» y la baja, encadenadas y en orden.';
end $$;
