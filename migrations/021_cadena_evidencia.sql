-- =============================================================================
-- MiFirma — 021_cadena_evidencia.sql
-- La cadena de evidencia se bifurcaba cuando el que anotaba no podía leer.
--
-- ═══ QUÉ PASÓ ═══
--
-- Al despachar el primer circuito real, el expediente quedó así:
--
--   1  documento.subido
--   1  notificacion.fallida      ← el mismo número
--   2  documento.descargado
--   ...
--   5  circuito.despachado
--
-- Dos eventos con `numero_orden` = 1: la cadena BIFURCADA. No un hueco, no un
-- desorden — dos ramas que arrancan del mismo punto. Un expediente así no
-- prueba nada, y la verificación lo marca roto para siempre.
--
-- ═══ POR QUÉ ═══
--
-- `evidencia_encadenar()` calcula el número y el hash anterior con
--
--     select numero_orden, hash_propio from evidencia
--      where instancia_id = new.instancia_id order by numero_orden desc limit 1;
--
-- y ese SELECT pasa por RLS como cualquier otro. La notificación por correo se
-- anota DESPUÉS de la transacción del despacho, con actor `sistema` — no hay
-- usuario mirando, el mail salió cuando el emisor ya cerró la pantalla. Y
-- `evidencia_select` (020) no tenía rama para `sistema`: el trigger vio cero
-- eventos previos y volvió a numerar desde 1.
--
-- ═══ LA LECCIÓN, QUE VALE MÁS QUE EL ARREGLO ═══
--
-- Un trigger que sostiene un invariante estructural NO puede depender de lo que
-- el actor de turno tenga permiso de VER. Son dos preguntas distintas: "quién
-- puede leer este expediente" es autorización; "cuál es el número siguiente de
-- esta cadena" es integridad. Mezclarlas produce exactamente esto — una
-- corrupción silenciosa que no falla, no avisa, y aparece meses después cuando
-- alguien intenta usar el expediente en un juicio.
--
-- Por eso el arreglo es doble y el segundo es el que importa:
--   1. `evidencia_select` gana la rama `sistema`, igual que circuito, instancia
--      y archivo, que la tenían desde la 009. La evidencia era la excepción.
--   2. El trigger pasa a SECURITY DEFINER: la cadena se calcula sobre la tabla
--      completa, sin filtro de fila, sin importar quién inserte. Aunque mañana
--      aparezca un actor nuevo que pueda insertar y no leer, la cadena sigue
--      siendo una.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- 1. El motor de flujo puede leer el expediente
--
-- La cola, los vencimientos, el certificado de finalización y el sellado de
-- tiempo corren como `sistema` y necesitan leer la evidencia para procesarla.
-- `sistema` no es un rol de base ni algo que un cliente pueda pedir: es un GUC
-- que fija nuestro propio código dentro de la transacción.
-- -----------------------------------------------------------------------------
drop policy evidencia_select on evidencia;
create policy evidencia_select on evidencia for select using (
     app.actor() = 'sistema'
  or (app.actor() = 'cuenta' and cuenta_propietaria_id = app.cuenta_actual())
  or app.tiene_otorgamiento(circuito_id, instancia_id, 'evidencia')
  or (identidad_id = any (app.identidades_del_actor()) and app.identidad_probada())
);

-- -----------------------------------------------------------------------------
-- 2. La cadena se calcula sobre la tabla, no sobre lo que el actor ve
--
-- Mismo cuerpo que la 020 —la fórmula NO cambia, los expedientes ya emitidos
-- tienen que seguir verificando— más `security definer`. El `search_path` fijo
-- es obligatorio en una función definer: sin él, alguien que pueda crear
-- objetos en un esquema anterior del path podría suplantar `digest`.
-- -----------------------------------------------------------------------------
create or replace function evidencia_encadenar() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_ant record;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.instancia_id::text, 0));

  select numero_orden, hash_propio into v_ant
    from public.evidencia
   where instancia_id = new.instancia_id
   order by numero_orden desc
   limit 1;

  new.numero_orden   := coalesce(v_ant.numero_orden, 0) + 1;
  new.hash_anterior  := v_ant.hash_propio;
  new.registrado_en  := now();

  new.hash_contenido := digest(
      new.instancia_id::text ||'|'|| new.numero_orden::text ||'|'||
      new.tipo ||'|'|| new.datos::text ||'|'||
      to_char(new.ocurrido_en at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.USOF') ||'|'||
      coalesce(new.identidad_id::text,'') ||'|'||
      coalesce(host(new.ip),'') ||'|'||
      coalesce(new.user_agent,'') ||'|'||
      coalesce(encode(new.sha256_documento,'hex'),'')
    , 'sha256');

  new.hash_propio := digest(
      coalesce(encode(new.hash_anterior,'hex'),'') ||'|'||
      encode(new.hash_contenido,'hex')
    , 'sha256');

  return new;
end $$;

comment on function evidencia_encadenar() is
  'Cadena de evidencia v1. NO MODIFICAR la fórmula: los expedientes emitidos se verifican con ella. SECURITY DEFINER desde la 021: la numeración es un invariante de integridad y no puede depender de lo que el actor tenga permiso de ver.';

-- -----------------------------------------------------------------------------
-- 3. Un detector, porque una cadena rota no se nota sola
--
-- Devuelve las instancias cuya cadena tiene números repetidos o huecos. Se corre
-- desde el monitoreo: descubrir esto al emitir un certificado es tarde, y
-- descubrirlo en un juicio es peor.
-- -----------------------------------------------------------------------------
create or replace function app.cadenas_rotas()
returns table (instancia_id uuid, eventos bigint, motivo text)
language sql stable security definer set search_path = pg_catalog, public
as $$
  select e.instancia_id,
         count(*) as eventos,
         case
           when count(*) <> count(distinct e.numero_orden) then 'numeros repetidos (cadena bifurcada)'
           when max(e.numero_orden) <> count(*)            then 'huecos en la secuencia'
         end as motivo
    from public.evidencia e
   group by e.instancia_id
  having count(*) <> count(distinct e.numero_orden)
      or max(e.numero_orden) <> count(*)
$$;

revoke all on function app.cadenas_rotas() from public;
grant execute on function app.cadenas_rotas() to app_operador;

commit;
