-- =============================================================================
-- MiFirma — 050_congelar_el_valor.sql
--
-- La política que protege el valor congelado estaba impidiendo congelarlo.
--
-- ═══ EL ERROR, TAL COMO SALIÓ ═══
--
--   new row violates row-level security policy for table "valor_campo"
--     at congelarCampos (src/services/campos.ts:360)
--     at firmar (src/services/firma.ts:487)
--
-- Firmar un documento con campos era imposible. Cualquier documento, cualquier
-- campo: la primera firma con un valor completado moría siempre, y en pantalla
-- salía «Ocurrió un error en el servidor».
--
-- ═══ POR QUÉ ═══
--
-- La política de la 038 dice, y el comentario lo explicaba con todas las letras:
--
--   create policy valor_update on valor_campo for update using (
--     congelado_en is null
--     and (app.actor() = 'sistema' or app.puede_completar_campo(...))
--   );
--
--   -- ⚠ `congelado_en is null` está en el USING: una vez congelado, la fila
--   -- deja de ser visible para el UPDATE y no hay forma de tocarla desde la
--   -- aplicación.
--
-- El razonamiento es correcto y la intención es la que hay que tener. Lo que
-- falla es un detalle de PostgreSQL que no perdona:
--
--   ⚠ **Una política FOR UPDATE sin WITH CHECK usa su USING también como WITH
--   CHECK.** O sea que la condición se evalúa DOS veces: sobre la fila vieja
--   —para decidir si se puede tocar— y sobre la fila NUEVA, para decidir si el
--   resultado es admisible.
--
-- Y la fila nueva del congelado tiene `congelado_en = now()`, que no es null.
-- La única operación que la política tenía que permitir es exactamente la que
-- produce una fila que ella rechaza.
--
-- Ni siquiera el sistema podía: `congelado_en is null` está FUERA del paréntesis
-- del actor, así que se le aplica a todos por igual. `congelarCampos` corre
-- dentro de `enSistema`, y fallaba lo mismo.
--
-- Reproducido en un PostgreSQL local con la política textual de la 038 y el
-- mismo mensaje de error, antes de escribir una línea de arreglo.
--
-- ═══ CÓMO QUEDA ═══
--
-- Las dos preguntas se separan, que es lo que había que hacer desde el principio
-- porque son dos preguntas distintas:
--
--   · **USING** — qué filas se pueden tocar: sólo las NO congeladas. Acá vive la
--     inmutabilidad, y queda igual de firme que antes: una fila congelada es
--     invisible para cualquier UPDATE que venga de la aplicación.
--
--   · **WITH CHECK** — cómo puede quedar la fila: congelada sólo si quien la
--     escribe es el sistema. Un firmante puede corregir su valor cuantas veces
--     quiera mientras no esté congelado, pero **no puede congelarlo él**.
--
-- Eso último no es un detalle: congelar no es una edición más, es el acto que
-- ata el valor a la firma, y ocurre dentro de la transacción que guarda la
-- firma. Que sólo el sistema pueda hacerlo dice en la base lo que hasta ahora
-- sólo decía el código.
--
-- ⚠ La lección, que es de las que se repiten: **en una política de UPDATE hay
-- que escribir WITH CHECK aunque parezca redundante.** Si no se escribe,
-- PostgreSQL copia el USING, y toda condición sobre una columna que la propia
-- operación modifica se convierte en una prohibición de hacer esa operación.
-- El centinela del final busca ese patrón en todo el esquema.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- 1. El UPDATE: qué se puede tocar, y cómo puede quedar
-- -----------------------------------------------------------------------------
drop policy if exists valor_update on valor_campo;

create policy valor_update on valor_campo for update
  using (
    -- Una vez congelado, la fila deja de existir para el UPDATE. Es lo que hace
    -- que «el valor que se firmó» sea un hecho y no una convención.
    congelado_en is null
    and (app.actor() = 'sistema' or app.puede_completar_campo(campo_id, instancia_id))
  )
  with check (
    -- Congelar es del sistema, adentro de la transacción de la firma.
    app.actor() = 'sistema'
    -- El firmante corrige lo suyo todas las veces que quiera, sin congelar.
    or (congelado_en is null and app.puede_completar_campo(campo_id, instancia_id))
  );

-- -----------------------------------------------------------------------------
-- 2. El INSERT, por el mismo motivo
--
-- No falló porque nadie inserta una fila ya congelada, pero la puerta estaba
-- abierta: `guardarValor` hace `insert ... on conflict do update`, y sin esto un
-- valor podía nacer congelado desde la aplicación. Un valor congelado sin firma
-- que lo respalde es un campo que nadie puede corregir y que no prueba nada.
-- -----------------------------------------------------------------------------
drop policy if exists valor_insert on valor_campo;

create policy valor_insert on valor_campo for insert
  with check (
    app.actor() = 'sistema'
    or (congelado_en is null and app.puede_completar_campo(campo_id, instancia_id))
  );

comment on column valor_campo.congelado_en is
  'Cuándo se ató este valor a una firma. Sólo lo escribe el sistema, dentro de '
  'la transacción que guarda la firma: la política valor_update lo exige. '
  'Después de esto la fila es invisible para cualquier UPDATE. Ver migración 050.';

commit;

-- =============================================================================
-- CENTINELA 1 — la política quedó con las dos mitades
-- =============================================================================
do $forma$
declare v_using text; v_check text;
begin
  select pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid)
    into v_using, v_check
    from pg_policy where polname = 'valor_update'
     and polrelid = 'public.valor_campo'::regclass;

  if v_check is null then
    raise exception 'valor_update quedó sin WITH CHECK: PostgreSQL le va a copiar el USING y el congelado vuelve a fallar';
  end if;
  if position('congelado_en' in v_using) = 0 then
    raise exception 'valor_update perdió la condición de inmutabilidad en el USING';
  end if;
  if position('sistema' in v_check) = 0 then
    raise exception 'el WITH CHECK de valor_update no distingue al sistema';
  end if;

  raise notice 'valor_update: USING protege la fila congelada, WITH CHECK deja congelarla.';
end $forma$;

-- =============================================================================
-- CENTINELA 2 — el mismo defecto en cualquier otra tabla
--
-- Busca políticas de UPDATE sin WITH CHECK cuyo USING pregunte por un `is null`.
-- Ése es el patrón exacto que rompe: la operación llena esa columna, la fila
-- nueva deja de cumplir la condición copiada, y la base rechaza justamente la
-- escritura que la política existía para permitir.
--
-- Hoy da cero. Está acá para que la próxima política escrita así no llegue a
-- producción — el defecto no se ve leyendo el SQL, sólo se ve fallando.
-- =============================================================================
do $centinela$
declare v_t text; v_p text; v_u text; v_mal text := '';
begin
  for v_t, v_p, v_u in
    select c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid)
      from pg_policy p join pg_class c on c.oid = p.polrelid
     where p.polcmd = 'w'                      -- UPDATE
       and p.polwithcheck is null               -- sin WITH CHECK: se copia el USING
       and pg_get_expr(p.polqual, p.polrelid) ~ 'IS NULL'
  loop
    v_mal := v_mal || format(E'\n  %s.%s  →  %s', v_t, v_p, left(v_u, 90));
  end loop;

  if v_mal <> '' then
    -- ⚠ El marcador de RAISE es `%`, NO `%s`. Con `%s` el `%` se sustituye y la
    -- `s` queda pegada al valor: «…(cerrado_en IS NULL)s». `format()` sí usa
    -- `%s`, y esa diferencia entre las dos ya ensució los mensajes de las
    -- migraciones 043 a 049.
    raise exception E'Políticas de UPDATE sin WITH CHECK que preguntan por un IS NULL. PostgreSQL les copia el USING como WITH CHECK, así que la operación que llena esa columna se rechaza a sí misma — es el error que rompió el congelado de campos, ver migración 050:%', v_mal;
  end if;

  raise notice 'Ninguna otra política de UPDATE tiene el patrón que rompió el congelado.';
end $centinela$;
