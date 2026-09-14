-- =============================================================================
-- MiFirma — 080_la_ventana_de_ia_devuelve_enteros.sql
-- Que la ventana de IA devuelva los tokens como enteros, igual que la tabla que
-- reemplazó.
--
-- ═══ EL DEFECTO ═══
--
-- La 079 convirtió `consumo_ia` de tabla en vista agregada. La tabla declaraba
-- `input_tokens` y `output_tokens` como `bigint`; la vista los devolvía como
-- `numeric`, porque `sum()` devuelve numeric y nadie lo casteó de vuelta.
--
-- ⚠⚠ Una ventana que devuelve otro tipo NO es la misma ventana. El sentido de
-- la vista es que el código que la lee no se entere de nada, y `db/schema.ts`
-- dice bigint. Dejarlo así es guardar una diferencia para que muerda cuando el
-- asistente exista y nadie se acuerde de esto.
--
-- ═══ CÓMO APARECIÓ, QUE ES LA PARTE QUE VALE ═══
--
-- No lo encontró una lectura ni el ejerce: lo encontró un SABOTAJE QUE NO SE
-- PUDO APLICAR. Al intentar reemplazar la vista por una versión rota para ver si
-- la prueba lo delataba, Postgres contestó:
--
--   cannot change data type of view column "input_tokens" from numeric to bigint
--
-- El sabotaje no era el hallazgo: la NEGATIVA era el hallazgo. Y estuvo a punto
-- de perderse, porque el primer intento mandaba los errores a /dev/null y el
-- resultado se leyó como "el sabotaje no se detecta".
--
-- ⚠ La lección, que vale más que la corrección: UN SABOTAJE QUE NO SE PUEDE
-- APLICAR NO ES UN SABOTAJE QUE NO SE DETECTA. Hay que mirar si entró antes de
-- anotar que la prueba no lo vio — y nunca callar la salida del sabotaje.
--
-- ═══ POR QUÉ UNA MIGRACIÓN NUEVA Y NO ARREGLAR LA 079 ═══
--
-- La 079 ya está aplicada y anotada con su hash. Una migración aplicada no se
-- modifica: quien la corriera después tendría una historia distinta de la que
-- corrió acá. Se corrige hacia adelante.
--
-- ⚠ Y `create or replace view` no alcanza, justamente por el error de arriba:
-- no puede cambiar el tipo de una columna. Hay que tirarla y rehacerla, con sus
-- permisos, que el `drop` se lleva puestos.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

drop view if exists consumo_ia;

create view consumo_ia as
  select (array_agg(e.id order by e.ocurrido_en))[1]      as id,
         e.cuenta_id,
         e.periodo,
         e.detalle ->> 'modelo'                           as modelo,
         -- ⚠ El cast de vuelta a bigint es el punto de esta migración.
         coalesce(sum((e.detalle ->> 'input_tokens')::bigint), 0)::bigint  as input_tokens,
         coalesce(sum((e.detalle ->> 'output_tokens')::bigint), 0)::bigint as output_tokens,
         coalesce(sum(e.costo_externo), 0)::numeric(14,6) as costo_base,
         min(e.moneda_costo)                              as moneda,
         max(e.ocurrido_en)                               as actualizado_en
    from evento_medible e
   where e.tipo = 'asistente_ia'
   group by e.cuenta_id, e.periodo, e.detalle ->> 'modelo';

comment on view consumo_ia is
  'Ventana agregada a evento_medible (079) con el nombre, las columnas Y LOS TIPOS que '
  'tenía la tabla de la 013. La IA se anota por llamada; esto la suma por cuenta, período '
  'y modelo. Los tokens vuelven a bigint en la 080.';

-- El `drop` se lleva los grants: hay que reponerlos o la consola deja de leer.
grant select on consumo_ia to app_rw, app_operador;

-- -----------------------------------------------------------------------------
-- Centinela
-- -----------------------------------------------------------------------------
do $centinela$
declare v_tipo text;
begin
  select data_type into v_tipo from information_schema.columns
   where table_name = 'consumo_ia' and column_name = 'input_tokens';
  if v_tipo is distinct from 'bigint' then
    raise exception 'La ventana de IA devuelve % y la tabla que reemplaza decía bigint', v_tipo;
  end if;

  if not exists (select 1 from information_schema.role_table_grants
                  where table_name = 'consumo_ia' and grantee = 'app_operador'
                    and privilege_type = 'SELECT') then
    raise exception 'El drop se llevó los permisos de la ventana y no se repusieron';
  end if;
end $centinela$;

commit;
