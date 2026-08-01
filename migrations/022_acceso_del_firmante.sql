-- =============================================================================
-- MiFirma — 022_acceso_del_firmante.sql
-- El firmante externo no podía leer el documento que le pedían firmar.
--
-- ═══ EL HUECO ═══
--
-- El despacho emite un otorgamiento sobre la INSTANCIA (que es lo correcto: en
-- modo copias cada firmante recibe la suya, y un otorgamiento sobre el circuito
-- le daría acceso a las tres mil). Pero dos políticas de la 009 sólo preguntan
-- por otorgamientos sobre el CIRCUITO:
--
--   circuito_select →  app.tiene_otorgamiento(id, null, 'metadatos')
--   archivo_select  →  ... and app.tiene_otorgamiento(c.id, null, 'leer')
--
-- `tiene_otorgamiento` exige que el objeto coincida: con `p_instancia = null`,
-- una fila con `instancia_id` no matchea nunca. Resultado: el firmante abre su
-- enlace, la RLS lo deja ver su participación y su instancia, y **no puede ver
-- ni el título ni el PDF**. Justo lo único que necesita.
--
-- ═══ POR QUÉ NO SE ARREGLA EMITIENDO EL OTORGAMIENTO SOBRE EL CIRCUITO ═══
--
-- Sería una línea de código en vez de una migración, y sería peor: en un envío
-- masivo cada firmante vería las tres mil copias de todos los demás. El
-- otorgamiento está bien donde está; lo que faltaba es que las políticas
-- entendieran que un otorgamiento sobre una instancia alcanza al documento base
-- de su circuito — que es el mismo PDF.
--
-- ═══ LA REGLA GENERAL, QUE YA FALLÓ DOS VECES HOY ═══
--
-- Una política que enumera CÓMO se puede llegar a una fila envejece mal: cada
-- camino nuevo que aparece —el actor `sistema` en la 021, el otorgamiento por
-- instancia acá— es un `or` que alguien tiene que acordarse de agregar. Y el
-- síntoma siempre es el mismo: no hay error, hay una pantalla vacía.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- El circuito, visible para quien tiene otorgamiento sobre alguna instancia
--
-- Es sólo el cabezal: título, estado, fechas. Ver el título del documento que a
-- uno le piden firmar no es opcional — un enlace que abre "Documento sin
-- nombre" es indistinguible de una estafa.
-- -----------------------------------------------------------------------------
drop policy circuito_select on circuito;
create policy circuito_select on circuito for select using (
     app.actor() = 'sistema'
  or
     (cuenta_propietaria_id = app.cuenta_actual()
      and exists (select 1 from ubicacion u
                  where u.circuito_id = circuito.id
                    and u.cuenta_id = app.cuenta_actual()
                    and app.puede_en_carpeta(u.carpeta_id, 'ver')))
  or app.tiene_otorgamiento(id, null, 'metadatos')
  or app.tiene_otorgamiento(id, null, 'leer')
  -- Nuevo: el otorgamiento sobre una instancia alcanza al cabezal de su circuito.
  or exists (select 1 from instancia i
              where i.circuito_id = circuito.id
                and (app.tiene_otorgamiento(circuito.id, i.id, 'metadatos')
                  or app.tiene_otorgamiento(circuito.id, i.id, 'leer')))
);

-- -----------------------------------------------------------------------------
-- El documento base, legible por el firmante
--
-- Sin esto no hay producto: la persona recibe un pedido de firma y no puede
-- abrir lo que le piden firmar. Y firmar sin haber podido leer es exactamente
-- lo que un juez usaría para tumbar la firma.
-- -----------------------------------------------------------------------------
drop policy archivo_select on archivo;
create policy archivo_select on archivo for select using (
     app.actor() = 'sistema'
  or
     (cuenta_custodia_id = app.cuenta_actual()
      and exists (
        select 1 from instancia i
        join ubicacion u on (u.instancia_id = i.id or u.circuito_id = i.circuito_id)
        where i.archivo_firmado_id = archivo.id
          and u.cuenta_id = app.cuenta_actual()
          and app.puede_en_carpeta(u.carpeta_id, 'leer')))
  or (cuenta_custodia_id = app.cuenta_actual()
      and exists (
        select 1 from circuito c
        join ubicacion u on u.circuito_id = c.id
        where c.archivo_base_id = archivo.id
          and u.cuenta_id = app.cuenta_actual()
          and app.puede_en_carpeta(u.carpeta_id, 'leer')))
  or exists (select 1 from instancia i
             where i.archivo_firmado_id = archivo.id
               and app.tiene_otorgamiento(i.circuito_id, i.id, 'leer'))
  or exists (select 1 from circuito c
             where c.archivo_base_id = archivo.id
               and app.tiene_otorgamiento(c.id, null, 'leer'))
  -- Nuevo: el otorgamiento sobre la instancia alcanza al PDF base del circuito.
  or exists (select 1 from circuito c
             join instancia i on i.circuito_id = c.id
             where c.archivo_base_id = archivo.id
               and app.tiene_otorgamiento(c.id, i.id, 'leer'))
);

commit;
