-- =============================================================================
-- MiFirma — 069_el_mejor_anclaje.sql
-- Cuál de las pruebas de identidad vale, cuando hay más de una.
--
-- ═══ POR QUÉ ═══
--
-- Hasta hoy había una sola prueba posible: abrir el enlace del correo. El motor
-- de firma la busca así, en `services/firma.ts`:
--
--   (select an.id from anclaje_identidad an
--     where an.identidad_id = p.identidad_id and an.tipo = 'email'
--       and an.revocado_en is null order by an.probado_en limit 1) as anclaje_email
--
-- y después escribe, fijo:
--
--   nivel_garantia_obtenido = 'bajo'
--
-- Con tuID esa persona puede tener DOS anclajes: el correo (bajo) y su cédula
-- verificada contra el proveedor de identidad del Estado (alto). Buscar siempre
-- el de correo haría que verificarse no sirviera para nada: el documento saldría
-- firmado con nivel bajo igual, y el firmante habría hecho un trámite que el
-- expediente ignora.
--
-- ═══ POR QUÉ UNA FUNCIÓN Y NO UN `ORDER BY` EN LA CONSULTA ═══
--
-- La misma razón que `app.moneda_de_cobro` (032) y `app.proveedores_habilitados`
-- (067): esta regla la van a necesitar el motor de firma, la pantalla que le
-- dice al firmante si tiene que verificarse, y el chequeo de si un circuito de
-- nivel alto puede avanzar. Tres lugares, una regla. Repartida, un día se
-- contradicen y nadie sabe cuál manda.
--
-- ═══ EL ORDEN, Y POR QUÉ ES ÉSTE ═══
--
--   1. Primero por NIVEL, de mayor a menor. Un anclaje de nivel alto vale más
--      que uno reciente de nivel bajo.
--   2. Después por el MÁS RECIENTE dentro del mismo nivel. Si alguien se
--      verificó dos veces, vale la última — es la que refleja el estado actual
--      de su certificado.
--
-- ⚠ El segundo criterio invierte lo que hacía la consulta vieja, que tomaba el
-- MÁS ANTIGUO (`order by an.probado_en limit 1`). Para el correo daba igual —hay
-- uno solo—; para documentos no, y quedarse con el más viejo sería elegir a
-- propósito la prueba más envejecida.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- El nivel como número, para poder ordenarlo. Los cuatro valores son los de
-- `NivelGarantia` en `src/db/contexto.ts`; cualquier otra cosa vale cero, que es
-- la respuesta segura: un nivel que no conocemos no puede ganarle a uno que sí.
create or replace function app.peso_nivel(p_nivel text)
returns int
language sql immutable
as $$
  select case p_nivel
           when 'alto'       then 3
           when 'sustancial' then 2
           when 'bajo'       then 1
           else 0
         end;
$$;

/**
 * El anclaje que vale para esta identidad, hoy.
 *
 * Devuelve cero filas si no hay ninguno vigente — y eso es una respuesta, no un
 * error: quien llama tiene que decidir qué hacer con una firma sin ninguna
 * prueba de identidad.
 */
create or replace function app.mejor_anclaje(p_identidad uuid)
returns table (id uuid, nivel_garantia text, tipo text, metodo_prueba text)
language sql stable security definer set search_path = pg_catalog, public
as $$
  select a.id, a.nivel_garantia, a.tipo, a.metodo_prueba
    from public.anclaje_identidad a
   where a.identidad_id = p_identidad
     and a.revocado_en is null
     -- ⚠ Un anclaje vencido NO vale. El certificado con el que alguien probó su
     -- identidad en marzo puede estar revocado en septiembre, y firmar en
     -- septiembre invocando aquella prueba sería afirmar algo que ya no es
     -- cierto. `vigente_hasta` nulo significa que no vence, no que venció.
     and (a.vigente_hasta is null or a.vigente_hasta > now())
   order by app.peso_nivel(a.nivel_garantia) desc, a.probado_en desc
   limit 1;
$$;

revoke all on function app.mejor_anclaje(uuid) from public;
grant execute on function app.mejor_anclaje(uuid) to app_rw;
revoke all on function app.peso_nivel(text) from public;
grant execute on function app.peso_nivel(text) to app_rw, app_operador;

commit;
