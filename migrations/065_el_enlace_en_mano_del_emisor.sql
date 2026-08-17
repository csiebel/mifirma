-- =============================================================================
-- MiFirma — 065_el_enlace_en_mano_del_emisor.sql
-- El expediente decía «el servidor de correo aceptó la notificación» sobre algo
-- donde no hubo ningún servidor de correo.
-- =============================================================================
--
-- ═══ QUÉ AFIRMABA, Y POR QUÉ ERA FALSO ═══
--
-- Cuando el emisor pide el enlace personal de firma para entregarlo él mismo
-- —por teléfono, por mano, por donde sea—, `circuito.ts` anotaba
-- `notificacion.enviada`. Y el rótulo de ese código, en el expediente y en el
-- certificado, dice:
--
--     «El servidor de correo aceptó la notificación»
--
-- **No hubo servidor de correo. No hubo envío. No hubo notificación.** El
-- emisor apretó un botón y se llevó un enlace.
--
-- Es el mismo pecado que la 058 vino a corregir —el expediente afirmando como
-- hecho algo que no ocurrió— sólo que en otro lugar y sin que nadie lo hubiera
-- mirado. Y es la deuda 39: un código cubriendo tres hechos distintos.
--
-- ═══ ⚠⚠ Y ES EL HECHO QUE MÁS IMPORTA DE LOS TRES ═══
--
-- Los otros dos usos de `notificacion.enviada` son correos de verdad. Éste es
-- otra cosa, y de las que un perito busca: **a partir de acá el enlace personal
-- de firma estuvo en manos del emisor**, no sólo en la casilla del firmante. Es
-- una afirmación sobre la CADENA DE CUSTODIA del enlace, y estaba escondida
-- dentro de un evento que dice que salió un correo.
--
-- El código ya lo sabía: los `datos` traían `canal: manual`,
-- `metodo: enlace_entregado_por_el_emisor` y hasta una `advertencia`. Lo que
-- faltaba era que el RÓTULO —lo único que lee una persona— lo dijera.
--
-- ═══ ⚠⚠⚠ LO QUE YA SE ESCRIBIÓ NO SE PUEDE ARREGLAR ═══
--
-- Y esto hay que decirlo, porque es la parte incómoda:
--
--   · `evidencia` NO admite update ni delete PARA NADIE (020, `using (false)`).
--   · Aunque se forzara con el rol dueño, cambiar el `tipo` cambiaría el
--     `hash_contenido`, y con él `hash_propio` y toda la cadena hacia adelante.
--     Un expediente «corregido» dejaría de verificar, que es peor que uno que
--     dice algo impreciso.
--
-- **Los expedientes ya emitidos siguen diciendo lo que decían.** Esta migración
-- cuenta cuántos son y lo deja anotado en la salida, para que el número exista
-- y nadie se sorprenda después.
--
-- > ⚠⚠ LA LECCIÓN, QUE VALE MÁS QUE EL ARREGLO: en un sistema con evidencia
-- > inmutable, **un rótulo mal elegido es permanente**. No hay refactor que lo
-- > alcance. Por eso el nombre y el texto de un evento se piensan ANTES de que
-- > el primero se escriba, y no cuando ya hay expedientes emitidos.
--
-- ⚠ Todo idempotente: el banco corre cada migración DOS VECES.
-- =============================================================================

-- ── El hecho, con su propio nombre ──────────────────────────────────────────
--
-- Categoría `envio`: es cómo salió el enlace, aunque no haya salido por correo.
-- Peso `alto`: afecta la cadena de custodia del enlace personal de firma, que
-- es exactamente lo que se discute cuando alguien niega haber firmado.
insert into tipo_evento (codigo, categoria, peso, orden, descripcion_i18n) values
  ('enlace.obtenido_por_el_emisor', 'envio', 'alto', 34,
   '{"es":"El emisor obtuvo el enlace personal de firma para entregarlo él mismo",
     "pt":"O emissor obteve o link pessoal de assinatura para entregá-lo ele mesmo",
     "en":"The sender obtained the personal signing link to deliver it themselves"}')
on conflict (codigo) do update
  set categoria        = excluded.categoria,
      peso             = excluded.peso,
      orden            = excluded.orden,
      descripcion_i18n = excluded.descripcion_i18n;

-- ── Cuántos expedientes quedaron con la afirmación vieja ────────────────────
--
-- No se corrige ninguno —no se puede— pero el número tiene que existir.
do $$
declare v_viejos int;
begin
  select count(*) into v_viejos
    from evidencia
   where tipo = 'notificacion.enviada'
     and datos->>'metodo' = 'enlace_entregado_por_el_emisor';

  if v_viejos = 0 then
    raise notice '✓ 065: ningún expediente tenía la afirmación vieja. Se llegó a tiempo.';
  else
    raise notice '⚠⚠ 065: % evento(s) YA ESCRITO(S) siguen diciendo «El servidor de correo '
                 'aceptó la notificación» sobre un enlace entregado en mano. NO se pueden '
                 'corregir: la evidencia es inmutable y cambiar el tipo rompería la cadena de '
                 'hashes. Quedan así para siempre. De acá en adelante se anota '
                 'enlace.obtenido_por_el_emisor.', v_viejos;
  end if;
end $$;
