-- =============================================================================
-- MiFirma — 054_la_firma_se_acomoda.sql
--
-- El firmante también puede cambiar el TAMAÑO de su firma, no sólo moverla.
--
-- ═══ DE DÓNDE SALE ═══
--
--   «que la firma sea sizeable»
--
-- Hasta hoy la firma autógrafa entraba a un tamaño fijo —170 × 55 puntos, unos
-- 6 × 2 cm— y sólo se podía arrastrar. En un documento cuyo renglón de firma
-- mide la mitad, eso es una firma que pisa dos líneas de texto; en uno con un
-- recuadro grande, una firma perdida en una esquina.
--
-- ═══ POR QUÉ ESTABA PROHIBIDO, Y POR QUÉ SE ABRE ═══
--
-- `moverMarca` decía, con todas las letras: «no cambia de página ni de tamaño:
-- eso sería rehacer la marca, no moverla, y es decisión del emisor».
--
-- El argumento valía cuando el emisor reservaba el renglón: el tamaño era parte
-- de su diseño. Pero **mover ya cambia lo que muestra el documento tanto como
-- redimensionar**, y mover está permitido desde el primer día. Una firma
-- corrida diez centímetros tapa lo mismo que una firma agrandada al doble. La
-- línea estaba puesta en el lugar equivocado.
--
-- Lo que protege al emisor no es prohibir: es que **quede escrito**. Igual que
-- el movimiento, el cambio de tamaño va al expediente con el antes y el
-- después. Si mañana alguien discute por qué la firma quedó de ese tamaño, la
-- respuesta está en el expediente y no en la memoria de nadie.
--
-- ⚠ Lo que sigue prohibido es cambiar de PÁGINA. Eso no es acomodar: es firmar
-- en otro lado del contrato, y ahí sí el emisor tiene algo que decir.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- Un evento propio y no un `firma.marca_movida` con el tamaño adentro: el
-- expediente lo lee gente que no escribió el código, y un evento que se llama
-- «movida» y además cuenta otra cosa es un evento en el que no se puede
-- confiar. Mismo peso y misma categoría que el movimiento, y el orden
-- inmediatamente después para que queden juntos.
insert into tipo_evento (codigo, categoria, peso, orden, descripcion_i18n) values
  ('firma.marca_redimensionada', 'firma', 'normal', 69,
   '{"es":"El firmante cambió el tamaño de su firma",
     "pt":"O signatário alterou o tamanho da sua assinatura",
     "en":"The signer changed the size of their signature"}')
on conflict (codigo) do nothing;

commit;

-- =============================================================================
-- CONTROL
-- =============================================================================
do $control$
declare v_mal text := ''; v_n int;
begin
  if not exists (select 1 from tipo_evento where codigo = 'firma.marca_redimensionada') then
    v_mal := v_mal || E'\n  falta el tipo de evento firma.marca_redimensionada';
  end if;

  -- ⚠ CENTINELA: ninguna marca con tamaño imposible.
  --
  -- Ahora el tamaño llega desde el navegador, así que puede llegar cualquier
  -- cosa. La ruta valida, pero la ruta es código de aplicación y esto es lo que
  -- queda cuando el código falla: una marca de ancho o alto cero no se dibuja y
  -- el documento sale sin firma visible — con la firma criptográfica puesta,
  -- que es lo que lo vuelve difícil de notar.
  select count(*) into v_n from marca_firma
   where ancho <= 0 or alto <= 0 or ancho > 2000 or alto > 2000;
  if v_n > 0 then
    v_mal := v_mal || format(E'\n  %s marca(s) con tamaño imposible: no se van a dibujar', v_n);
  end if;

  if v_mal <> '' then
    raise exception E'El redimensionado quedó incompleto:%', v_mal;
  end if;

  raise notice 'La firma se acomoda: el firmante puede cambiarle el tamaño y queda en el expediente.';
end $control$;
