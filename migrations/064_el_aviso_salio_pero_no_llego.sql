-- =============================================================================
-- MiFirma — 064_el_aviso_salio_pero_no_llego.sql
-- «No salió» y «salió y no llegó» son dos hechos distintos, y el expediente
-- tenía un solo evento para los dos.
-- =============================================================================
--
-- ═══ EL HECHO QUE FALTABA ═══
--
-- Desde la 063 el expediente sabe decir que un aviso LLEGÓ. Lo que no sabía
-- decir es lo contrario: que salió del sistema, que el relay lo aceptó, y que
-- después NO pudo entregarlo — dirección inexistente, destinatario bloqueado,
-- dirección inválida.
--
-- No es un detalle de monitoreo: **es el circuito trabado esperando a alguien
-- que nunca va a recibir nada**, y hoy el emisor se entera recién cuando
-- pregunta. Estaba previsto desde `correo-saliente.md` §5.1 (9/8).
--
-- ═══ ⚠⚠ POR QUÉ UN EVENTO NUEVO Y NO `notificacion.fallida` ═══
--
-- Porque significan cosas distintas, y en un juicio la diferencia entre ellas
-- es exactamente lo que se discute:
--
--   · `notificacion.fallida`      → el aviso NO SALIÓ. Falló nuestro despacho.
--   · `notificacion.no_entregada` → el aviso SALIÓ, el relay lo aceptó, y el
--                                    destinatario NO lo recibió.
--
-- Meterlos en el mismo código sería reproducir adentro del expediente la deuda
-- 39 —un evento cubriendo hechos distintos— el mismo día que se anotó.
--
-- ═══ ⚠⚠ Y DE PASO, EL TEXTO DE `notificacion.fallida` ESTABA MAL ═══
--
-- El catálogo decía «La notificación no se pudo entregar», que es EXACTAMENTE
-- lo que significa el evento nuevo. Y el certificado que se le imprime al
-- cliente decía, para ese mismo código, «El aviso NO salió» — el texto
-- correcto. **Dos fuentes, dos frases distintas, para el mismo hecho.**
--
-- Se corrige la DESCRIPCIÓN, no el código: mismo criterio que la 058. Renombrar
-- el código obligaría a migrar filas históricas sin arreglar nada que esté roto.
--
-- ⚠ El rótulo vive en DOS lugares y los dos se cambian juntos: acá y en
-- `ETIQUETA` de `src/services/certificado_pdf.ts`. Que el certificado no lea de
-- este catálogo sigue siendo deuda anotada — es lo que hoy impide que salga en
-- portugués o en inglés.
--
-- ═══ ⚠⚠ QUÉ EVENTOS DEL RELAY LO ESCRIBEN, Y CUÁLES NO ═══
--
-- **Sólo los DEFINITIVOS**: rebote duro, bloqueado, dirección inválida, error.
--
-- Los TEMPORALES —rebote blando, aplazado— NO escriben nada. Un mensaje
-- aplazado todavía puede terminar entregado, y anotar «no llegó» sobre algo que
-- puede llegar es sobreafirmar: el mismo pecado que la 058 vino a corregir. El
-- expediente dice lo que se COMPROBÓ.
--
-- Y `unsubscribed` tampoco: que alguien se dé de baja no es un fracaso de
-- entrega de ESE mensaje. Es otro hecho —y grave, porque deja de recibir los
-- siguientes, incluido el PDF firmado— y merece su propio evento el día que se
-- resuelva el asunto del List-Unsubscribe con Brevo.
--
-- ═══ EL ÍNDICE ═══
--
-- El de la 063 filtraba dos tipos. Ahora son tres: el webhook pregunta «¿ya hay
-- un veredicto final para este mensaje?» y ese veredicto puede ser entregada o
-- no_entregada. Sin sumarlo al índice, esa consulta deja de usarlo.
--
-- ⚠ Todo idempotente: el banco corre cada migración DOS VECES a propósito.
-- =============================================================================

-- ── 1. El hecho nuevo ───────────────────────────────────────────────────────
--
-- `peso alto` a propósito: un firmante al que no se le pudo entregar el aviso
-- cambia la historia del documento, igual que un rechazo o una cancelación. Es
-- de las cosas que hay que ver de un vistazo en el expediente, no buscando.
insert into tipo_evento (codigo, categoria, peso, orden, descripcion_i18n) values
  ('notificacion.no_entregada', 'entrega', 'alto', 33,
   '{"es":"La notificación salió pero el proveedor no pudo entregarla",
     "pt":"A notificação saiu mas o provedor não conseguiu entregá-la",
     "en":"The notification was sent but the provider could not deliver it"}')
on conflict (codigo) do update
  set categoria        = excluded.categoria,
      peso             = excluded.peso,
      orden            = excluded.orden,
      descripcion_i18n = excluded.descripcion_i18n;

-- ── 2. Y el texto que estaba mal ────────────────────────────────────────────
update tipo_evento
   set descripcion_i18n = jsonb_build_object(
         'es', 'La notificación no salió del sistema',
         'pt', 'A notificação não saiu do sistema',
         'en', 'The notification never left the system')
 where codigo = 'notificacion.fallida';

-- ── 3. El índice, ahora con los tres tipos ──────────────────────────────────
drop index if exists evidencia_por_message_id;

create index evidencia_por_message_id
    on evidencia ((datos->>'message_id'))
 where tipo in ('notificacion.enviada',
                'notificacion.entregada',
                'notificacion.no_entregada');

comment on index evidencia_por_message_id is
  'Ata los avisos del relay al aviso que salió. Cubre las dos preguntas del '
  'webhook: de qué aviso es este Message-ID, y si ya tiene un veredicto final '
  '(entregada o no_entregada). ⚠ NO puede ser UNIQUE: evidencia está '
  'particionada por registrado_en. La repetición se cierra con '
  'pg_advisory_xact_lock. Ver migraciones 063 y 064.';

comment on table tipo_evento is
  'Catálogo de tipos de evento del expediente. ⚠ La descripción tiene que decir '
  'lo que el sistema COMPROBÓ, no lo que se supone que pasó. Los cuatro del '
  'correo son cuatro hechos distintos y sus textos tienen que poder '
  'distinguirse a simple vista: enviada = el relay lo aceptó; entregada = llegó; '
  'fallida = no salió del sistema; no_entregada = salió y el relay no pudo '
  'entregarlo. Ver migraciones 058, 063 y 064.';
