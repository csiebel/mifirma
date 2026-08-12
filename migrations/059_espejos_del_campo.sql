-- =============================================================================
-- MiFirma — 059_espejos_del_campo.sql
--
-- Los ESPEJOS de un campo: los demás lugares donde el formulario repite el
-- mismo dato.
--
-- ═══ EL PROBLEMA (deuda 26) ═══
--
-- Un formulario armado en serio repite el mismo dato en varias hojas: el nombre
-- del paciente arriba de cada página de un consentimiento, el número de
-- expediente en cada hoja de un contrato. En el PDF eso es UN campo con VARIOS
-- widgets. Hasta hoy la base guardaba un solo lugar por campo (pagina, x, y,
-- ancho, alto), así que el valor completado se dibujaba sólo en el primero;
-- los demás recuadros quedaban vacíos y congelados. El documento válido —el
-- certificado siempre llevó el valor— pero a la vista parecía incompleto.
--
-- Decidido con Claudio el 11/8/2026: se espeja. El valor se dibuja en TODOS
-- los lugares donde el formulario lo repite.
--
-- ═══ QUÉ GUARDA ESTA COLUMNA, Y QUÉ NO ═══
--
-- `espejos` es un arreglo JSON de lugares: [{pagina, x, y, ancho, alto}, …].
-- El lugar PRINCIPAL sigue en las columnas de siempre — el editor lo muestra,
-- se puede mover, y nada de lo existente cambia de significado. Los espejos
-- son los lugares ADICIONALES, y quedan fijos donde el formulario los puso:
-- no se mueven en el editor, porque no los decidió el emisor sino quien
-- diseñó el formulario.
--
-- ⚠ SÓLO PARA TEXTO Y PÁRRAFO. Un campo de opciones también tiene varios
-- widgets en el PDF, pero ahí cada widget es UNA OPCIÓN DISTINTA (los círculos
-- de elegir una), no el mismo dato repetido: espejar ahí estamparía el valor
-- elegido arriba de todas las opciones. `detectarCampos` no ofrece espejos
-- para esos tipos; esta restricción documenta el borde pero no lo vigila por
-- tipo, porque el tipo puede cambiar después en el editor y el arreglo vacío
-- es válido para todos.
--
-- ═══ POR QUÉ UNA COLUMNA JSONB Y NO UNA TABLA HIJA ═══
--
-- Un espejo no tiene vida propia: no se completa, no se congela, no se
-- autoriza por separado. Es geometría del MISMO campo, y viaja con él — se
-- crea al adoptar, se borra con el campo, la RLS de `campo` lo cubre sin una
-- política nueva. Una tabla hija habría agregado políticas, grants y pruebas
-- para un dato que nunca se consulta solo.
--
-- ═══ QUIÉN LA CONSUME ═══
--
--  · `detectarCampos` la llena al leer el AcroForm del cliente (todos los
--    widgets; el primero es el lugar principal, el resto espejos).
--  · `widgetsAPredeclarar` declara un widget por espejo antes de la primera
--    firma, con nombre propio (ver `nombreDelEspejo` en campos.ts).
--  · `prepararCampos` dibuja el valor una vez por espejo, con la misma letra.
--  · El editor de cajas los muestra como recuadros fijos, para que el emisor
--    sepa dónde va a aparecer el valor.
--
-- ⚠ El tramo sellado (src/firma/) NO cambia: `predeclarar()` y el dibujo
-- reciben una lista y escriben lo que les den. Los espejos entran por esa
-- misma puerta, como datos.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

alter table campo
  add column if not exists espejos jsonb not null default '[]'::jsonb;

-- ⚠ `drop` antes de `add`: `probar.sh` corre cada migración DOS veces, y
-- `add constraint` no tiene `if not exists`.
alter table campo drop constraint if exists campo_espejos_con_forma;

-- El tope de 30 es el mismo criterio que los demás topes del módulo (200
-- campos, 50 opciones): holgado para cualquier formulario real, y suficiente
-- para que un PDF hostil con quinientos widgets del mismo campo no se vuelva
-- quinientas marcas por firma. `detectarCampos` corta en el mismo número y
-- avisa por log; si los dos números divergieran, la pantalla ofrecería algo
-- que la base rechaza con un 500 de Postgres en vez de una frase.
alter table campo add constraint campo_espejos_con_forma check (
  jsonb_typeof(espejos) = 'array' and jsonb_array_length(espejos) <= 30
);

comment on column campo.espejos is
  'Los demás lugares donde el formulario repite este dato: [{pagina,x,y,ancho,alto},…]. '
  'El lugar principal va en las columnas de siempre. Fijos, no editables. '
  'Sólo texto/párrafo. Migración 059.';

commit;
