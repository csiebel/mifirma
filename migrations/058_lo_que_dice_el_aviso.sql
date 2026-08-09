-- =============================================================================
-- 058 — El expediente decía que el aviso se envió. Lo que sabemos es otra cosa.
-- =============================================================================
--
-- ═══ QUÉ AFIRMABA, Y POR QUÉ ERA FALSO ═══
--
-- `notificacion.enviada` se escribe cuando `enviarCorreo()` no lanza excepción,
-- y `enviarCorreo()` lanza SÓLO si el servidor SMTP rechaza el mensaje. Un
-- relay —Brevo, en producción— ACEPTA y después no entrega: destinatario
-- bloqueado, baja previa, rebote duro. No hay excepción, y el expediente
-- anotaba «Se envió la notificación» para un correo que nunca llegó.
--
-- En un producto de firma eso no es un problema de monitoreo. Es **el
-- expediente afirmando como hecho algo que no ocurrió**, sobre el punto exacto
-- que se discute cuando alguien dice «a mí nunca me avisaron».
--
-- ═══ POR QUÉ NO SE RENOMBRA EL EVENTO ═══
--
-- El código `notificacion.enviada` está bien y su categoría es `envio`. Sí se
-- envió: al servidor de correo. Lo que sobreafirmaba era la DESCRIPCIÓN, que es
-- lo que lee una persona. Renombrar el código obligaría a migrar filas
-- históricas y a tocar las consultas, sin arreglar nada que esté roto.
--
-- ═══ Y LO QUE YA ESTABA PREVISTO ═══
--
-- ⚠ `notificacion.entregada` existe en este mismo catálogo desde la 020,
-- categoría `entrega`, traducida a tres idiomas — y **no la escribe nadie**. La
-- separación entre «lo despaché» y «llegó» estaba diseñada desde el principio;
-- el código nunca usó la segunda mitad. Cuando exista el webhook de eventos de
-- Brevo (`delivered`, `blocked`, `hard_bounce`), ese es su lugar, y no hay que
-- inventar nada.
--
-- ⚠ El rótulo vive en DOS lugares: acá y en `ETIQUETA` de
-- `src/services/certificado_pdf.ts`, que tiene su propia copia y es la que sale
-- impresa en el certificado. Los dos se cambian juntos. Que el certificado no
-- lea de este catálogo es deuda anotada: además de duplicar la afirmación, es
-- lo que hoy impide que el certificado salga en portugués o en inglés.
-- =============================================================================

update tipo_evento
   set descripcion_i18n = jsonb_build_object(
         'es', 'El servidor de correo aceptó la notificación',
         'pt', 'O servidor de e-mail aceitou a notificação',
         'en', 'The mail server accepted the notification')
 where codigo = 'notificacion.enviada';

comment on table tipo_evento is
  'Catálogo de tipos de evento del expediente. ⚠ La descripción tiene que decir '
  'lo que el sistema COMPROBÓ, no lo que se supone que pasó: notificacion.enviada '
  'es la aceptación del relay, y notificacion.entregada —que todavía no escribe '
  'nadie— es la entrega confirmada por el proveedor. Ver migración 058.';
