-- =============================================================================
-- MiFirma — 066_la_baja_del_destinatario.sql
-- «Cancelar suscripción» dejaba de ser invisible: el destinatario que se da de
-- baja corta el canal, y el expediente no lo sabía.
-- =============================================================================
--
-- ═══ EL HECHO, Y POR QUÉ IMPORTA ═══
--
-- Brevo agrega solo la cabecera List-Unsubscribe a todo correo transaccional, y
-- el cliente de correo la muestra como «Cancelar suscripción» arriba del
-- mensaje. Un firmante que la toca queda SUPRIMIDO en Brevo: no le llega más
-- ningún correo nuestro — ni los recordatorios, ni el correo con su propio PDF
-- firmado.
--
-- Hasta hoy ese hecho caía en la frase genérica del log («evento que no cambia
-- el veredicto del mensaje») y el expediente no lo anotaba. El circuito quedaba
-- esperando a alguien que cortó el canal, y los envíos futuros a esa dirección
-- iban a aparecer como `blocked` → `notificacion.no_entregada`, que parecen
-- fallas de infraestructura. Este evento es la CAUSA; aquéllos, los efectos.
--
-- ═══ ⚠⚠ POR QUÉ NO ES UN VEREDICTO ═══
--
-- Los dos veredictos de la 063/064 son terminales y excluyentes: un mensaje
-- llegó o no llegó. La baja es otra cosa: para tocar «cancelar suscripción»
-- normalmente hubo que RECIBIR el correo, así que este hecho CONVIVE con
-- `notificacion.entregada` sobre el mismo mensaje. El ejerce lo prueba.
--
-- ═══ MEDIDO EL 17/8/2026, 21:06 — NO SUPUESTO ═══
--
-- La documentación de Brevo no describe lo que llega por SMTP relay (lección de
-- la 063), así que ANTES de escribir esto se provocó una baja real con un alias
-- de prueba. Lo medido:
--
--   · El evento `unsubscribed` vuelve CON nuestro Message-ID → se amarra al
--     aviso igual que los veredictos.
--   · El cartel del cliente de correo (List-Unsubscribe) DISPARA el webhook.
--   · Campos reales: date, device_used, email, event, id, link, message-id,
--     sender_email, sending_ip, subject, ts, ts_epoch, ts_event, user_agent,
--     uuid. (Trae `link`, `user_agent` y `device_used`, que `delivered` no
--     trae; no trae `reason` ni `tag`.)
--
-- ═══ EL RÓTULO — decidido por Claudio el 17/8, con la alternativa a la vista ═══
--
-- «El destinatario canceló la recepción de correos». Se consideró la variante
-- que no afirma quién tocó el botón (un correo reenviado lo puede tocar un
-- tercero; Brevo no comprueba quién) y se eligió la lectura natural a
-- sabiendas. En un sistema con evidencia inmutable el rótulo es permanente:
-- que conste acá que la elección fue informada, no un descuido.
--
-- Categoría `envio` y peso `alto` como los demás hechos del canal: es el
-- momento en que el canal con esa persona se cortó, y un perito lo busca.
--
-- ⚠ Todo idempotente: el banco corre cada migración DOS VECES.
-- =============================================================================

insert into tipo_evento (codigo, categoria, peso, orden, descripcion_i18n) values
  ('correo.baja_del_destinatario', 'envio', 'alto', 35,
   '{"es":"El destinatario canceló la recepción de correos",
     "pt":"O destinatário cancelou o recebimento de e-mails",
     "en":"The recipient unsubscribed from emails"}')
on conflict (codigo) do update
  set categoria        = excluded.categoria,
      peso             = excluded.peso,
      orden            = excluded.orden,
      descripcion_i18n = excluded.descripcion_i18n;
