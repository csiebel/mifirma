-- =============================================================================
-- ejerce/065 — El enlace en mano no es una notificación, y lo ya escrito no se
-- puede arreglar.
-- =============================================================================
--
-- Cinco cosas, y la última es la que explica por qué este arreglo llegó tarde:
--
--   1. Que el hecho nuevo exista con la categoría y el peso que se le pensaron.
--   2. Que los CINCO textos —los cuatro del correo más éste— sean distintos.
--   3. ⚠ Que el texto del hecho nuevo NO hable de correo. Es la aserción
--      semántica: si vuelve a sonar a notificación, volvimos al problema.
--   4. Que anotarlo respete la cadena de hashes.
--   5. ⚠⚠ Que CAMBIARLE EL TIPO a un evento ya escrito le cambia el hash. Es la
--      prueba de por qué los expedientes viejos no se pueden corregir: no es
--      que no queramos, es que un expediente «corregido» dejaría de verificar.
-- =============================================================================

do $$
declare
  v_categoria  text;
  v_peso       text;
  v_texto      text;
  v_textos     int;
  v_instancia  uuid;
  v_antes      bigint;
  v_nuevo      bigint;
  v_hash_prev  bytea;
  v_hash_eng   bytea;
  v_ev         record;
  v_recalc     bytea;
begin
  -- ── 1. El hecho nuevo ─────────────────────────────────────────────────────
  select categoria, peso, descripcion_i18n->>'es'
    into v_categoria, v_peso, v_texto
    from tipo_evento where codigo = 'enlace.obtenido_por_el_emisor';

  if v_categoria is null then
    raise exception 'FALLA 1a: no existe el tipo de evento enlace.obtenido_por_el_emisor';
  end if;
  if v_categoria <> 'envio' then
    raise exception 'FALLA 1b: quedó en la categoría %, se esperaba envio', v_categoria;
  end if;
  if v_peso <> 'alto' then
    raise exception 'FALLA 1c: quedó con peso %, se esperaba alto — es un hecho sobre la '
                    'cadena de custodia del enlace personal de firma', v_peso;
  end if;

  -- ── 2. Los CINCO textos, distintos entre sí ───────────────────────────────
  select count(distinct descripcion_i18n->>'es') into v_textos
    from tipo_evento
   where codigo in ('notificacion.enviada','notificacion.entregada',
                    'notificacion.fallida','notificacion.no_entregada',
                    'enlace.obtenido_por_el_emisor');

  if v_textos <> 5 then
    raise exception 'FALLA 2: los cinco hechos tienen % textos distintos, no 5. Dos de ellos '
                    'dicen lo mismo y no se van a poder distinguir en el expediente', v_textos;
  end if;

  -- ── 3. ⚠ Y el nuevo NO habla de correo ────────────────────────────────────
  if v_texto ~* '(correo|e-?mail|notificaci)' then
    raise exception 'FALLA 3: el texto del hecho nuevo dice «%». Habla de correo o de '
                    'notificación, y acá NO HUBO NINGUNO: el emisor se llevó un enlace. '
                    'Es exactamente el problema que esta migración vino a corregir', v_texto;
  end if;

  -- ── 4. Anotarlo respeta la cadena ─────────────────────────────────────────
  select instancia_id into v_instancia
    from evidencia where tipo = 'notificacion.enviada' limit 1;

  select numero_orden, hash_propio into v_antes, v_hash_prev
    from evidencia where instancia_id = v_instancia
   order by numero_orden desc limit 1;

  insert into evidencia (
    instancia_id, circuito_id, cuenta_propietaria_id,
    actor_tipo, tipo, datos, ocurrido_en, canal,
    numero_orden, hash_contenido, hash_propio
  )
  select instancia_id, circuito_id, cuenta_propietaria_id,
         'emisor', 'enlace.obtenido_por_el_emisor',
         '{"canal":"manual","metodo":"enlace_entregado_por_el_emisor",
           "advertencia":"el emisor obtuvo el enlace personal de firma"}'::jsonb,
         '2026-08-10 11:00:00+00', 'web',
         0, ''::bytea, ''::bytea
    from evidencia where instancia_id = v_instancia limit 1;

  select numero_orden, hash_anterior into v_nuevo, v_hash_eng
    from evidencia
   where instancia_id = v_instancia and tipo = 'enlace.obtenido_por_el_emisor';

  if v_nuevo <> v_antes + 1 then
    raise exception 'FALLA 4a: quedó con número % y el anterior era % — la cadena no siguió',
                    v_nuevo, v_antes;
  end if;
  if v_hash_eng is distinct from v_hash_prev then
    raise exception 'FALLA 4b: no enganchó el hash del evento anterior. Cadena rota';
  end if;

  -- ── 5. ⚠⚠ POR QUÉ LO VIEJO NO SE PUEDE ARREGLAR ───────────────────────────
  --
  -- Se recalcula el hash de contenido de un evento existente cambiándole SÓLO
  -- el tipo, con la misma fórmula del trigger (020). Si diera igual, se podrían
  -- corregir las filas históricas y este comentario sobraría.
  select * into v_ev
    from evidencia
   where tipo = 'notificacion.enviada'
   order by numero_orden limit 1;

  v_recalc := digest(
      v_ev.instancia_id::text ||'|'|| v_ev.numero_orden::text ||'|'||
      'enlace.obtenido_por_el_emisor' ||'|'|| v_ev.datos::text ||'|'||
      to_char(v_ev.ocurrido_en at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.USOF') ||'|'||
      coalesce(v_ev.identidad_id::text,'') ||'|'||
      coalesce(host(v_ev.ip),'') ||'|'||
      coalesce(v_ev.user_agent,'') ||'|'||
      coalesce(encode(v_ev.sha256_documento,'hex'),'')
    , 'sha256');

  if v_recalc = v_ev.hash_contenido then
    raise exception 'FALLA 5: cambiarle el tipo a un evento NO le cambia el hash. Entonces la '
                    'fórmula de la cadena no incluye el tipo, y un expediente podría reescribirse '
                    'sin que la verificación lo note. Eso sería mucho peor que el problema que '
                    'esta migración vino a arreglar';
  end if;

  -- ⚠ NO se verifica acá la política que impide MODIFICAR evidencia
  -- (`evidencia_update using (false)`, migración 020). **`base-minima.sql` no
  -- tiene RLS ni políticas de ninguna tabla**, así que el banco no puede
  -- probarlas: la aserción se saltearía sola siempre, y una aserción que nunca
  -- falla es peor que ninguna. Queda anotado como deuda del banco. La
  -- autorización se prueba por otro lado, en `db/rls_test.sql`.

  raise notice '✓ 065: el enlace en mano tiene hecho propio (envio/alto), su texto no habla de '
               'correo, los cinco textos son distintos, la cadena lo acepta — y cambiarle el tipo '
               'a un evento viejo le cambiaría el hash, que es por qué lo ya escrito no se toca.';
end $$;
