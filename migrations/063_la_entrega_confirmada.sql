-- =============================================================================
-- MiFirma — 063_la_entrega_confirmada.sql
-- Para que el expediente pueda decir «llegó», y no sólo «el correo lo aceptó».
-- =============================================================================
--
-- ═══ QUÉ FALTABA ═══
--
-- `notificacion.entregada` existe en el catálogo desde la 020, categoría
-- `entrega`, traducida a tres idiomas — y NO LA ESCRIBE NADIE. La 058 ya había
-- corregido la descripción de `notificacion.enviada` para que no sobreafirmara
-- («el servidor de correo aceptó la notificación») y dejó dicho dónde iba la
-- otra mitad: el webhook de eventos del relay.
--
-- Esta migración NO crea tablas y NO cambia permisos —por eso no lleva
-- `ejerce/` de permisos, aunque sí trae uno de comportamiento—. Pone el índice
-- que ese amarre necesita.
--
-- ═══ CON QUÉ SE ATA, Y POR QUÉ ÉSE ═══
--
-- Medido en producción el 17/8/2026 con un correo real, no deducido de la
-- documentación: Brevo CONSERVA el Message-ID que genera nuestro servidor, y
-- además devuelve la etiqueta propia `X-Mailin-custom`. Los dos servían.
--
-- Se eligió el Message-ID porque ya existe sin tocar nada: `enviarCorreo()` lo
-- devuelve, y alcanza con capturarlo en los DOS lugares que mandan correo de
-- circuito, en vez de agregarle una cabecera a los OCHO que llaman a esa
-- función. La etiqueta queda escrita igual, como red y como instrumento para
-- volver a medir esto el día que haga falta.
--
-- ⚠ Se guarda NORMALIZADO, sin los signos `<` y `>`. Hoy Brevo los conserva; si
-- algún día deja de hacerlo, el amarre no se rompe por dos caracteres.
--
-- ═══ EL ÍNDICE ═══
--
-- Cubre las DOS preguntas que hace el webhook por cada entrega confirmada:
-- «¿de qué aviso es este Message-ID?» y «¿ya lo anoté?». Sin él, las dos son un
-- recorrido de la tabla entera de evidencia.
--
-- ═══ ⚠⚠ POR QUÉ NO HAY UN ÍNDICE ÚNICO, QUE ERA LO OBVIO ═══
--
-- El primer intento de esta migración traía un índice ÚNICO sobre el Message-ID
-- de las entregas, para que la repetición de un evento se estrellara contra la
-- base en vez de resolverse en la aplicación. **No se puede**, y conviene que
-- quede escrito para que nadie lo intente de nuevo:
--
--   ERROR:  unique constraint on partitioned table must include all
--           partitioning columns
--   DETAIL: ...lacks column "registrado_en" which is part of the partition key.
--
-- `evidencia` está PARTICIONADA POR MES (020). Un índice único sobre una tabla
-- particionada tiene que incluir la columna de partición, y agregar
-- `registrado_en` lo vuelve inútil: dos filas con distinta marca temporal no
-- chocarían jamás, que es exactamente el caso que había que impedir.
--
-- **La salida es la que el proyecto ya eligió para este mismo problema.** El
-- trigger `evidencia_encadenar` (020) toma `pg_advisory_xact_lock` por
-- instancia para que dos eventos concurrentes no BIFURQUEN la cadena. El
-- webhook hace lo mismo, con candado por Message-ID: los dos avisos simultáneos
-- del mismo mensaje se serializan, el segundo ve lo que escribió el primero, y
-- no inserta. Ver `services/entregas.ts`.
--
-- ⚠ `evidencia` no admite update ni delete PARA NADIE (020). Así que este
-- evento sólo puede AGREGARSE, nunca pisar lo que ya está — que es exactamente
-- lo que se le pide a un expediente.
--
-- ⚠ `if not exists`: el banco (`test/migraciones/probar.sh`) corre cada
-- migración DOS VECES a propósito, y un `create index` pelado moriría en la
-- segunda.
-- =============================================================================

create index if not exists evidencia_por_message_id
    on evidencia ((datos->>'message_id'))
 where tipo in ('notificacion.enviada', 'notificacion.entregada');

comment on index evidencia_por_message_id is
  'Ata el aviso de entrega del relay al aviso que salió. Cubre las dos preguntas '
  'del webhook: de qué aviso es este Message-ID, y si ya se anotó. ⚠ NO puede ser '
  'UNIQUE: evidencia está particionada por registrado_en y Postgres exige que un '
  'índice único incluya la columna de partición, lo que lo volvería inútil. La '
  'repetición se cierra con pg_advisory_xact_lock. Ver migración 063.';
