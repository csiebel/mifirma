-- =============================================================================
-- MiFirma — migración 057: la base lleva registro de qué migración se corrió
--
-- ═══ QUÉ PROBLEMA RESUELVE ═══
--
-- Hasta hoy **nadie sabía qué migraciones se habían aplicado**. El comando de
-- migrar corre todos los archivos de `migrations/` de punta a punta y confía en
-- que las viejas sean idempotentes; si alguna no lo es, o si una se escribió y
-- se commiteó sin correrla, no hay forma de enterarse hasta que algo revienta.
--
-- Pasó el 5 de agosto de 2026: **la 051, la 052 y la 053 estaban escritas y
-- commiteadas, y ninguna aplicada.** Costó una tarde entera, y el síntoma no
-- decía nada útil — pantallas con 500 y errores de Postgres sobre columnas que
-- «tenían que existir».
--
-- ═══ QUÉ HACE ═══
--
-- Una tabla con una fila por migración aplicada. A partir de acá, `npm run
-- migrate` aplica **sólo lo que falta**, en orden, y anota cada una con su
-- huella. Correrlo dos veces no hace nada la segunda vez.
--
-- ⚠ Y guarda el `hash_sha256` del archivo tal como se aplicó. No es adorno: una
-- migración que se EDITA después de haber corrido es un archivo que dice una
-- cosa y una base que tiene otra, y hoy eso es invisible. Con la huella, el que
-- migra se entera.
--
-- ═══ EL RELLENO, Y POR QUÉ ES UNA LISTA A MANO ═══
--
-- Las 56 migraciones anteriores YA ESTÁN APLICADAS en la base real, corridas a
-- mano una por una. Esta migración las da por aplicadas, con la lista escrita
-- explícitamente abajo.
--
-- ⚠ Van **sin huella** (`hash_sha256` en null), y eso es a propósito: no
-- sabemos con qué contenido se corrieron. Poner la huella del archivo de hoy
-- sería **inventar una prueba** — afirmar que lo que está en el repo es lo que
-- se aplicó, que es justamente lo que la columna existe para detectar. Es la
-- misma decisión que la 030 con los dispositivos recordados sin anclaje: un
-- hecho probado no se rellena con un valor por defecto.
--
-- El que migra tiene que tratar el null como «no sé», no como «coincide».
--
-- ═══ POR QUÉ NACE CON RLS Y SIN NINGÚN GRANT ═══
--
-- `009_rls.sql` tiene un centinela que **falla si queda una tabla sin RLS**, con
-- una lista corta de excepciones para los catálogos públicos. Ésta no es un
-- catálogo público: es infraestructura, y la aplicación no tiene por qué verla.
--
-- Se resuelve del lado seguro: **RLS habilitada y ninguna política**. Sin
-- políticas nadie ve nada, y sin `grant` la aplicación ni siquiera puede
-- pedirlo. El que migra es el superusuario, que es el dueño de la tabla y no
-- pasa por RLS.
--
-- Agregarla a la lista de excepciones del centinela habría sido más corto y
-- peor: esa lista dice «tablas que no tienen datos de cliente Y son públicas»,
-- y ampliarla por comodidad es cómo esa lista deja de significar algo.
-- =============================================================================

begin;

create table if not exists migracion_aplicada (
  -- El nombre del archivo, tal cual: `057_migracion_aplicada.sql`.
  nombre        text primary key,

  -- SHA-256 del archivo en el momento de aplicarlo. NULL = no se sabe, y no se
  -- inventa. Ver el bloque del relleno, arriba.
  hash_sha256   text,

  aplicada_en   timestamptz not null default now(),

  -- Quién la corrió, para el expediente de ISO 27001. `session_user` y no
  -- `current_user`: interesa quién se conectó, no en qué rol terminó.
  aplicada_por  text not null default session_user
);

comment on table migracion_aplicada is
  'Qué migraciones se aplicaron a esta base. La escribe el que migra, no la aplicación.';
comment on column migracion_aplicada.hash_sha256 is
  'NULL significa «no se sabe» (relleno de las 56 previas a la 057), no «coincide».';

-- ⚠ Cerrada. Ver el bloque de arriba: RLS sin políticas y sin grants.
alter table migracion_aplicada enable row level security;

-- =============================================================================
-- EL RELLENO: lo que ya estaba aplicado antes de que existiera esta tabla
--
-- ⚠ `on conflict do nothing` en las dos, para que la migración se pueda correr
-- dos veces — que es lo que comprueba el banco.
-- =============================================================================
insert into migracion_aplicada (nombre, hash_sha256, aplicada_por) values
  ('001_base.sql', null, 'relleno de la 057'),
  ('002_cuenta.sql', null, 'relleno de la 057'),
  ('003_identidad.sql', null, 'relleno de la 057'),
  ('004_roles.sql', null, 'relleno de la 057'),
  ('005_carpetas.sql', null, 'relleno de la 057'),
  ('006_dominio.sql', null, 'relleno de la 057'),
  ('007_ubicacion.sql', null, 'relleno de la 057'),
  ('008_otorgamientos.sql', null, 'relleno de la 057'),
  ('009_rls.sql', null, 'relleno de la 057'),
  ('010_operador.sql', null, 'relleno de la 057'),
  ('011_sesiones.sql', null, 'relleno de la 057'),
  ('012_pagos.sql', null, 'relleno de la 057'),
  ('013_billing_chasis.sql', null, 'relleno de la 057'),
  ('014_mensajeria_y_textos.sql', null, 'relleno de la 057'),
  ('015_bitacora.sql', null, 'relleno de la 057'),
  ('016_anclaje_de_sesion.sql', null, 'relleno de la 057'),
  ('017_marca.sql', null, 'relleno de la 057'),
  ('018_alta_de_cuenta.sql', null, 'relleno de la 057'),
  ('019_precios.sql', null, 'relleno de la 057'),
  ('020_evidencia.sql', null, 'relleno de la 057'),
  ('021_cadena_evidencia.sql', null, 'relleno de la 057'),
  ('022_acceso_del_firmante.sql', null, 'relleno de la 057'),
  ('023_quien_te_lo_manda.sql', null, 'relleno de la 057'),
  ('024_config_unica.sql', null, 'relleno de la 057'),
  ('025_archivo_vigente.sql', null, 'relleno de la 057'),
  ('026_politica_sin_tablas.sql', null, 'relleno de la 057'),
  ('027_bitacora_de_plataforma.sql', null, 'relleno de la 057'),
  ('028_sello_de_tiempo.sql', null, 'relleno de la 057'),
  ('029_firma_visual.sql', null, 'relleno de la 057'),
  ('030_dispositivos_sin_prueba.sql', null, 'relleno de la 057'),
  ('031_marcas_de_firma.sql', null, 'relleno de la 057'),
  ('032_catalogo_de_paises.sql', null, 'relleno de la 057'),
  ('033_sin_carpeta_borradores.sql', null, 'relleno de la 057'),
  ('034_borrar_borrador.sql', null, 'relleno de la 057'),
  ('035_certificado_finalizacion.sql', null, 'relleno de la 057'),
  ('036_registro_verificado.sql', null, 'relleno de la 057'),
  ('037_cancelar_circuito.sql', null, 'relleno de la 057'),
  ('038_campos_del_documento.sql', null, 'relleno de la 057'),
  ('039_archivo_vigente_visible.sql', null, 'relleno de la 057'),
  ('040_firmante_pone_su_rubrica.sql', null, 'relleno de la 057'),
  ('041_marca_agregada_y_quitada.sql', null, 'relleno de la 057'),
  ('042_preparar_el_circuito.sql', null, 'relleno de la 057'),
  ('043_certificado_visible.sql', null, 'relleno de la 057'),
  ('044_el_sistema_ve_las_carpetas.sql', null, 'relleno de la 057'),
  ('045_caracter_de_la_firma.sql', null, 'relleno de la 057'),
  ('046_el_caracter_lo_declara_quien_firma.sql', null, 'relleno de la 057'),
  ('047_evento_caracter.sql', null, 'relleno de la 057'),
  ('048_poder_representar.sql', null, 'relleno de la 057'),
  ('049_completar_caracter.sql', null, 'relleno de la 057'),
  ('050_congelar_el_valor.sql', null, 'relleno de la 057'),
  ('051_texto_fijo.sql', null, 'relleno de la 057'),
  ('052_quien_completa.sql', null, 'relleno de la 057'),
  ('053_envio_a_varios.sql', null, 'relleno de la 057'),
  ('054_la_firma_se_acomoda.sql', null, 'relleno de la 057'),
  ('055_el_lugar_del_firmante.sql', null, 'relleno de la 057'),
  ('056_letra_del_campo.sql', null, 'relleno de la 057')
on conflict (nombre) do nothing;

-- Y ésta, que se está corriendo a mano igual que las 56 de arriba. De la 058 en
-- adelante lo anota el que migra, con su huella.
insert into migracion_aplicada (nombre, hash_sha256, aplicada_por)
values ('057_migracion_aplicada.sql', null, 'se anota sola')
on conflict (nombre) do nothing;

-- =============================================================================
-- ⚠ EL CONTROL: QUE LA LISTA DE ARRIBA NO TENGA AGUJEROS
--
-- Son 56 renglones escritos a mano. **Saltarse uno es trivial y no se nota**: la
-- tabla quedaría diciendo que la 037 está pendiente, y el que migra la volvería
-- a correr sobre una base viva.
--
-- Así que se comprueba lo único que se puede comprobar desde SQL sin leer el
-- directorio: que para **cada número del 001 al 056** haya una fila. No importa
-- el nombre completo — importa que no falte ninguno.
--
-- ⚠ Lo que este control NO hace, dicho para que nadie se confíe: **no sabe qué
-- hay en `migrations/`**. Si alguien agregó una 058 entre que esto se escribió
-- y se corrió, acá no se entera. Eso lo ve el que migra, comparando el
-- directorio contra esta tabla — que es justamente para lo que existe.
--
-- ⚠ Y se cuenta por número y no por total, para que la 057 **se pueda volver a
-- correr siempre**. Un `count(*) = 57` fallaría el día que exista la 058
-- anotada, sobre una base perfectamente sana, y el que se lo encuentre no va a
-- saber si el problema es la base o el control.
-- =============================================================================
do $completo$
declare v_faltan text;
begin
  select string_agg(lpad(g::text, 3, '0'), ', ' order by g) into v_faltan
    from generate_series(1, 56) g
   where not exists (
     select 1 from migracion_aplicada m
      where m.nombre like lpad(g::text, 3, '0') || '\_%'
   );
  if v_faltan is not null then
    raise exception
      'El relleno tiene agujeros: falta la migración %. Revisá la lista de arriba.', v_faltan;
  end if;
end $completo$;

commit;
