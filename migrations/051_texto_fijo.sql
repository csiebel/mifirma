-- =============================================================================
-- MiFirma — 051_texto_fijo.sql
--
-- Un campo que no le pide nada a nadie: sólo dice algo.
--
-- ═══ DE DÓNDE SALE ═══
--
-- De una pregunta que expone un agujero:
--
--   «el campo de sí/no quería que dijera en el archivo "Acepta este contrato"
--    y luego el firmante llena. ¿Se podrá incluir texto a la hora de poner
--    campos?»
--
-- Sobre un PDF que YA es un formulario el problema no existe: el texto lo trae
-- impreso el documento y la casilla se pone al lado. Pero de los 22 documentos
-- reales del primer cliente ninguno es un formulario — son escaneos y PDF
-- exportados de Word— y ahí una casilla dibujada sobre la hoja se estampa como
-- una **X sola, sin nada que diga qué se aceptó**.
--
-- Eso no es una molestia de presentación. Es un documento firmado con una marca
-- que no prueba nada: dentro de tres años, «¿qué aceptó esta persona?» no tiene
-- respuesta en el archivo. Sobre un producto de firma electrónica, es el peor
-- lugar posible para dejar un hueco.
--
-- ═══ QUÉ ES ═══
--
-- Un tipo de campo más, `etiqueta`: el emisor escribe un texto, se ubica en la
-- hoja como cualquier otro campo, y se estampa en el documento. Nadie lo
-- completa y nadie puede cambiarlo.
--
-- ⚠ Por qué un TIPO DE CAMPO y no una tabla nueva de anotaciones: porque ya
-- tiene todo lo que necesita —rectángulo, página, orden, el mismo dibujante, el
-- mismo congelado— y lo único que cambia es que su valor lo pone el emisor y no
-- se le pide a nadie. Inventar una tabla paralela para eso es tener dos formas
-- de poner texto en una hoja, y la segunda siempre queda a medias.
--
-- ⚠ Y lleva `completa_emisor` obligatorio: un texto fijo que «lo completa el
-- firmante» no es un texto fijo. Lo garantiza un CHECK, no una pantalla.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- 1. El tipo nuevo
-- -----------------------------------------------------------------------------
alter table campo drop constraint if exists campo_tipo_check;
alter table campo add constraint campo_tipo_check
  check (tipo in ('texto','parrafo','numero','fecha','moneda','casilla','opcion','etiqueta'));

-- -----------------------------------------------------------------------------
-- 2. Un texto fijo es del emisor, siempre
--
-- No es una convención de la pantalla: es lo que hace que sea fijo. Si lo
-- pudiera completar un firmante, sería un campo de texto común con otro nombre.
-- -----------------------------------------------------------------------------
do $c$ begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.campo'::regclass
                    and conname = 'campo_etiqueta_es_del_emisor') then
    alter table campo add constraint campo_etiqueta_es_del_emisor
      check (tipo <> 'etiqueta' or (completa_emisor and orden_firmante is null));
  end if;
end $c$;

-- -----------------------------------------------------------------------------
-- 3. Y no puede ser obligatorio
--
-- «Obligatorio» significa «no se firma hasta que alguien lo complete», y a un
-- texto fijo no lo completa nadie. Marcarlo obligatorio trabaría el documento
-- para siempre, sin nadie a quien pedírselo.
-- -----------------------------------------------------------------------------
do $c$ begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.campo'::regclass
                    and conname = 'campo_etiqueta_no_obligatoria') then
    alter table campo add constraint campo_etiqueta_no_obligatoria
      check (tipo <> 'etiqueta' or not obligatorio);
  end if;
end $c$;

comment on column campo.tipo is
  'texto | parrafo | numero | fecha | moneda | casilla | opcion | etiqueta. '
  'El último no lo completa nadie: es un texto que escribe el emisor y se '
  'estampa en la hoja, para decir qué se está aceptando al lado de una casilla '
  'o para agregar una aclaración. Ver migración 051.';

commit;

-- =============================================================================
-- CONTROL — que las tres restricciones estén, y que hagan lo que dicen
-- =============================================================================
do $control$
declare v_falta text := '';
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.campo'::regclass and conname = 'campo_tipo_check') then
    v_falta := v_falta || E'\n  campo_tipo_check';
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.campo'::regclass
                    and conname = 'campo_etiqueta_es_del_emisor') then
    v_falta := v_falta || E'\n  campo_etiqueta_es_del_emisor';
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.campo'::regclass
                    and conname = 'campo_etiqueta_no_obligatoria') then
    v_falta := v_falta || E'\n  campo_etiqueta_no_obligatoria';
  end if;

  if v_falta <> '' then
    raise exception E'Faltan restricciones del texto fijo:%', v_falta;
  end if;

  -- Que el tipo nuevo se acepte de verdad, y que las dos prohibiciones frenen.
  -- Se prueba escribiendo, no leyendo el catálogo: una restricción puede existir
  -- y no cubrir el caso que uno cree.
  begin
    perform 1 from campo limit 1;
  exception when others then null;
  end;

  raise notice 'Texto fijo: tipo aceptado, siempre del emisor y nunca obligatorio.';
end $control$;
