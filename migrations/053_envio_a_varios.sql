-- =============================================================================
-- MiFirma — 053_envio_a_varios.sql
--
-- El mismo documento, a diez personas distintas, preparado una sola vez.
--
-- ═══ DE DÓNDE SALE ═══
--
-- De una pregunta que mide el producto entero:
--
--   «si quiero mandar a 10 usuarios distintos el documento con los mismos
--    campos a llenar, ¿tengo que hacer el proceso 10 veces poniendo cada vez
--    los campos en el formulario?»
--
-- La respuesta tenía que ser que no, y hasta hoy era que sí: el modo `copias`
-- existía en el esquema desde la 006 y estaba prohibido en el servicio —
-- «el envío masivo se prepara desde una planilla»— sin que hubiera ninguna
-- planilla. Un modo declarado y no construido.
--
-- ═══ POR QUÉ ESTA MIGRACIÓN ES TAN CHICA ═══
--
-- Porque el modelo ya estaba bien. No hace falta ninguna tabla nueva:
--
--   · `instancia` ya tiene unique (circuito_id, numero) — N copias por circuito
--   · `campo` cuelga del CIRCUITO, así que se define una vez y vale para todas
--   · `valor_campo` cuelga de la INSTANCIA, así que cada uno llena el suyo
--   · `circuito.modo` ya acepta 'copias' desde la 006
--   · `firma.ts` ya cierra el circuito contando instancias abiertas, no firmas
--
-- Lo único que faltaba es lo que va acá: **una copia es un hecho y el
-- expediente tiene que poder decirlo**.
--
-- ═══ POR QUÉ UN EVENTO NUEVO Y NO REPETIR `documento.subido` ═══
--
-- El expediente de cada instancia es una cadena de hashes que arranca en su
-- primer evento. La copia nº 7 necesita un primer eslabón, y repetirle
-- `documento.subido` con la hora de ahora diría que el documento se subió siete
-- veces — que es falso, y en un expediente lo falso es peor que lo incompleto.
--
-- `documento.copiado` dice exactamente lo que pasó: de este documento se sacó
-- una copia, en tal momento, para tal persona. Un perito que lo lea entiende
-- por qué hay diez expedientes con el mismo sha256 de origen.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- 1. El evento
--
-- Categoría 'ciclo' y peso normal, como `documento.subido`: es un hito de la
-- vida del documento, no un acto que se discuta en un juicio. Orden 11 para que
-- caiga justo después de la subida cuando el expediente se ordena por tipo.
-- -----------------------------------------------------------------------------
insert into tipo_evento (codigo, categoria, peso, orden, descripcion_i18n) values
  ('documento.copiado', 'ciclo', 'normal', 11,
   '{"es":"Se creó una copia para un destinatario",
     "pt":"Foi criada uma cópia para um destinatário",
     "en":"A copy was created for a recipient"}')
on conflict (codigo) do nothing;

commit;

-- =============================================================================
-- CONTROL — el estado, comprobado
--
-- Dos preguntas distintas: si la migración entró, y si lo que ya había en la
-- base es coherente con lo que el modo copias promete.
-- =============================================================================
do $control$
declare v_mal text := ''; v_n int;
begin
  if not exists (select 1 from tipo_evento where codigo = 'documento.copiado') then
    v_mal := v_mal || E'\n  falta el tipo de evento documento.copiado';
  end if;

  -- ⚠ CENTINELA: en modo copias, cada instancia viva tiene UN firmante.
  --
  -- No es una restricción declarativa porque durante la preparación una
  -- instancia recién creada pasa un instante sin firmante, y un CHECK no
  -- distingue «todavía no» de «quedó mal». Pero si esto crece, algo se rompió:
  -- dos firmantes en la misma copia es que dos personas reciben el MISMO
  -- documento creyendo cada una que es el suyo, y el segundo va a encontrar los
  -- campos ya llenos por el primero.
  select count(*) into v_n
    from instancia i
    join circuito c on c.id = i.circuito_id
   where c.modo = 'copias'
     and c.estado <> 'borrador'
     and i.estado not in ('cancelada','vencida')
     and (select count(*) from participacion p
           where p.instancia_id = i.id and p.papel = 'firmante') > 1;
  if v_n > 0 then
    v_mal := v_mal || format(E'\n  %s copia(s) despachadas con más de un firmante', v_n);
  end if;

  -- Y el revés: una copia despachada sin nadie a quien pedirle la firma queda
  -- abierta para siempre y traba el cierre del circuito, porque `firma.ts`
  -- cuenta instancias abiertas para decidir si terminó.
  select count(*) into v_n
    from instancia i
    join circuito c on c.id = i.circuito_id
   where c.modo = 'copias'
     and c.estado = 'enviado'
     and i.estado in ('pendiente','en_curso')
     and not exists (select 1 from participacion p
                      where p.instancia_id = i.id and p.papel = 'firmante');
  if v_n > 0 then
    v_mal := v_mal || format(E'\n  %s copia(s) en curso sin ningún firmante: el circuito no va a cerrar nunca', v_n);
  end if;

  if v_mal <> '' then
    raise exception E'El envío a varios quedó incompleto:%', v_mal;
  end if;

  raise notice 'Envío a varios: el evento de copia está, y las copias existentes son coherentes.';
end $control$;
