-- =============================================================================
-- MiFirma — 023_quien_te_lo_manda.sql
-- El firmante externo no podía ver de qué empresa venía el documento.
--
-- ═══ EL HUECO ═══
--
-- `cuenta_select` (009) tiene tres ramas: sos esa cuenta, sos operador o
-- sistema, o sos miembro. El firmante externo no es ninguna de las tres — no
-- pertenece a ninguna cuenta, que es justamente su definición. Resultado: la
-- consulta que arma la pantalla de firma une `participacion → circuito →
-- cuenta`, y esa unión no devolvía nada. El firmante veía "Este enlace ya no
-- está disponible" con el enlace perfectamente vivo.
--
-- ═══ POR QUÉ NO SE ESQUIVA SACANDO EL JOIN ═══
--
-- Se podría no mostrar el nombre del emisor y listo. Sería peor producto y peor
-- seguridad: alguien recibe un correo inesperado con un enlace y un PDF, y lo
-- primero que necesita saber es QUIÉN se lo manda. Un pedido de firma anónimo
-- es indistinguible de un phishing, y enseñarle a la gente a firmar documentos
-- de remitente desconocido es exactamente lo contrario de lo que hace este
-- producto.
--
-- ═══ QUÉ SE ABRE, EXACTAMENTE ═══
--
-- Sólo la fila de la cuenta que le está pidiendo firmar algo a esta persona, y
-- sólo mientras ese otorgamiento esté vivo. No abre el resto de las cuentas del
-- sistema ni nada de su contenido: `cuenta` guarda nombre, país, moneda y
-- estado — la identidad comercial que la empresa está exhibiendo a propósito al
-- mandar el documento. Es la misma postura que ya toma `marca` (017), donde el
-- logo es legible por el externo porque es la prueba visual de que el correo no
-- es una estafa.
--
-- ═══ LA CUARTA VEZ ═══
--
-- 021 (`sistema` en evidencia), 022 (otorgamiento por instancia en circuito y
-- archivo) y ahora 023. Las tres son el mismo error de origen: políticas que
-- enumeran quién llega, escritas cuando todavía no existían todos los que
-- llegan. La conclusión práctica no es "escribir mejores políticas": es que
-- cada camino de acceso nuevo necesita su prueba de punta a punta ANTES de
-- darlo por hecho, porque el síntoma nunca es un error — es una pantalla vacía.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

drop policy cuenta_select on cuenta;
create policy cuenta_select on cuenta for select using (
     id = app.cuenta_actual()
  or app.actor() in ('operador','sistema')   -- el operador ve cuentas, no contenido
  or app.es_miembro(id)                      -- para el selector de acceso
  -- Nuevo: quien tiene un otorgamiento vivo sobre un documento de esta cuenta
  -- puede saber de quién es. Es el emisor mostrándose, no una filtración.
  or exists (
       select 1
         from circuito c
         left join instancia i on i.circuito_id = c.id
        where c.cuenta_propietaria_id = cuenta.id
          and (app.tiene_otorgamiento(c.id, i.id, 'metadatos')
            or app.tiene_otorgamiento(c.id, null, 'metadatos'))
     )
);

commit;
