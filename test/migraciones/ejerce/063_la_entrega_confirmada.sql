-- =============================================================================
-- ejerce/063 — El amarre entre el aviso que salió y la entrega que confirmó el relay.
-- =============================================================================
--
-- Correr la migración dos veces prueba que ENTRA y que se puede repetir. No
-- prueba que HAGA LO QUE DICE. Esto sí, y prueba cuatro cosas distintas:
--
--   1. Que buscar por Message-ID encuentra el aviso correcto — Y QUE EL FILTRO
--      POR TIPO NO ES DECORATIVO: sin él se ata la entrega al evento equivocado.
--   2. Que los avisos SIN Message-ID —todos los anteriores a la 063, o sea los
--      que están hoy en producción— no rompen nada y no aparecen por error.
--   3. Que anotar la entrega respeta la cadena: el trigger le da el número
--      siguiente y engancha el hash del evento anterior.
--   4. ⚠⚠ Que un índice ÚNICO sobre este Message-ID **NO SE PUEDE CREAR**. Es
--      el límite que obligó a resolver la repetición con `pg_advisory_xact_lock`
--      en vez de con la base, y queda acá como prueba viva en lugar de como
--      comentario: si algún día alguien lo intenta de nuevo, esto lo frena.
-- =============================================================================

do $$
declare
  v_con_filtro   int;
  v_sin_filtro   int;
  v_instancia    uuid;
  v_orden_antes  bigint;
  v_orden_nuevo  bigint;
  v_hash_prev    bytea;
  v_hash_engan   bytea;
  v_ya           int;
  v_error        text;
begin
  -- ── 1. Buscar por Message-ID, con y sin el filtro por tipo ────────────────
  -- ⚠ Dos consultas y no un `min(instancia_id)`: no existe `min(uuid)` en
  -- Postgres, y el error sale recién al ejecutar el bloque.
  select count(*) into v_con_filtro
    from evidencia
   where tipo = 'notificacion.enviada'
     and datos->>'message_id' = 'con-id@mi-firma.digital';

  select instancia_id into v_instancia
    from evidencia
   where tipo = 'notificacion.enviada'
     and datos->>'message_id' = 'con-id@mi-firma.digital'
   limit 1;

  if v_con_filtro <> 1 then
    raise exception 'FALLA 1a: buscando el aviso por Message-ID salieron % filas, se esperaba 1', v_con_filtro;
  end if;

  -- El sabotaje: sin filtrar por tipo, el `documento.subido` que trae el mismo
  -- Message-ID en sus datos también aparece. Si esto diera 1, el filtro sería
  -- decorativo y la prueba no probaría nada.
  select count(*) into v_sin_filtro
    from evidencia
   where datos->>'message_id' = 'con-id@mi-firma.digital';

  if v_sin_filtro < 2 then
    raise exception 'FALLA 1b: el sabotaje no saboteó — sin el filtro por tipo salieron % filas. '
                    'O faltan los datos incómodos del banco, o el filtro no hace falta y esta prueba miente',
                    v_sin_filtro;
  end if;

  -- ── 2. Los avisos SIN Message-ID no molestan ──────────────────────────────
  if not exists (
    select 1 from evidencia
     where tipo = 'notificacion.enviada' and datos->>'message_id' is null
  ) then
    raise exception 'FALLA 2: el banco perdió el aviso SIN Message-ID. Es el caso de todo lo '
                    'que ya está en producción y es el que tiene que tolerar el índice parcial';
  end if;

  -- ── 3. Anotar la entrega respeta la cadena ────────────────────────────────
  select numero_orden, hash_propio into v_orden_antes, v_hash_prev
    from evidencia where instancia_id = v_instancia
   order by numero_orden desc limit 1;

  insert into evidencia (
    instancia_id, circuito_id, cuenta_propietaria_id,
    actor_tipo, tipo, datos, ocurrido_en, canal,
    numero_orden, hash_contenido, hash_propio
  )
  select instancia_id, circuito_id, cuenta_propietaria_id,
         'proveedor', 'notificacion.entregada',
         '{"canal":"email","proveedor":"brevo","message_id":"con-id@mi-firma.digital"}'::jsonb,
         '2026-08-10 10:00:30+00', 'webhook',
         0, ''::bytea, ''::bytea
    from evidencia
   where tipo = 'notificacion.enviada'
     and datos->>'message_id' = 'con-id@mi-firma.digital';

  select numero_orden, hash_anterior into v_orden_nuevo, v_hash_engan
    from evidencia
   where instancia_id = v_instancia and tipo = 'notificacion.entregada';

  if v_orden_nuevo <> v_orden_antes + 1 then
    raise exception 'FALLA 3a: la entrega quedó con número % y el anterior era % — la cadena no siguió',
                    v_orden_nuevo, v_orden_antes;
  end if;
  if v_hash_engan is distinct from v_hash_prev then
    raise exception 'FALLA 3b: la entrega no enganchó el hash del evento anterior. Cadena rota';
  end if;

  -- ── 4. Y ahora «¿ya está?» la encuentra ───────────────────────────────────
  -- Es lo que impide que un segundo aviso del relay la duplique.
  select count(*) into v_ya
    from evidencia
   where tipo = 'notificacion.entregada'
     and datos->>'message_id' = 'con-id@mi-firma.digital';
  if v_ya <> 1 then
    raise exception 'FALLA 4: tras anotarla, la pregunta «¿ya está?» devolvió % filas', v_ya;
  end if;

  -- ── 5. ⚠⚠ El índice ÚNICO no se puede crear, y tiene que seguir sin poder ──
  begin
    execute 'create unique index ejerce_063_no_deberia
               on evidencia ((datos->>''message_id''))
              where tipo = ''notificacion.entregada''';
    -- Si llegó acá, Postgres lo aceptó. No es una buena noticia: significa que
    -- el supuesto sobre el que se construyó `services/entregas.ts` cambió.
    execute 'drop index ejerce_063_no_deberia';
    raise exception 'FALLA 5: el índice ÚNICO AHORA SE PUEDE CREAR. Cambió el supuesto de la 063: '
                    'revisar si conviene volver al índice único y sacar el pg_advisory_xact_lock de entregas.ts';
  exception when others then
    get stacked diagnostics v_error = message_text;
    if v_error like 'FALLA 5:%' then
      raise exception '%', v_error;
    end if;
    -- Rechazado, como corresponde. Ése es el resultado bueno.
    raise notice '  · el índice único sigue siendo imposible: %', v_error;
  end;

  raise notice '✓ 063: el aviso se encuentra por su Message-ID, el filtro por tipo hace falta, '
               'los avisos viejos sin Message-ID no molestan, la entrega respeta la cadena, '
               'y el índice único sigue sin poder existir.';
end $$;
