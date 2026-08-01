-- =============================================================================
-- MiFirma — 026_politica_sin_tablas.sql
-- La bitácora del operador moría con "permission denied for table ubicacion".
--
-- ═══ POR QUÉ UNA CONSULTA A `bitacora` TERMINA EN `ubicacion` ═══
--
-- La consulta del operador es inocente: bitácora izquierda-unida con `cuenta`
-- para poner el nombre del cliente al lado del evento. `app_operador` tiene
-- GRANT sobre las dos. Pero al tocar `cuenta` se aplica `cuenta_select`, y esa
-- política —desde 023— trae adentro un `exists` sobre `circuito` e `instancia`.
-- Esas dos tienen sus propias políticas, que a su vez miran `ubicacion`. El
-- operador no tiene GRANT sobre ninguna de las tres, y con razón: es
-- exactamente el control que describe 009 y que verifica el test C4.
--
-- ═══ LO QUE APRENDIMOS ACÁ (y es lo importante) ═══
--
-- PostgreSQL chequea los privilegios de TODAS las tablas del plan al arrancar
-- el ejecutor, antes de evaluar una sola fila. El `or` no cortocircuita a
-- efectos de permisos: que `app.actor() = 'operador'` sea verdadero en la
-- segunda rama no evita que la cuarta rama, la que nombra `circuito`, exija su
-- GRANT igual. Una política que nombra tablas le impone esas tablas a TODO el
-- que consulte la tabla protegida, aunque su rama ni se evalúe.
--
-- Corolario, y va a valer para cada política nueva:
--
--   Una política RLS no debe nombrar tablas. Debe llamar funciones.
--
-- Con la lógica adentro de una función `security definer`, el plan del que
-- consulta tiene una sola tabla, el chequeo de privilegios es sobre la función
-- —un `execute`, no un `select`— y la política deja de acoplar el permiso de
-- `cuenta` al permiso de todo el dominio de firmas.
--
-- ═══ POR QUÉ `security definer` NO AFLOJA NADA ═══
--
-- La función corre como el dueño y por lo tanto no la filtra la RLS de
-- `circuito`. Es lo correcto y no una concesión: la pregunta que responde es
-- "¿este actor tiene un otorgamiento vivo sobre algún documento de esta
-- cuenta?", y esa respuesta no debe depender de si además puede VER el
-- circuito. Antes dependía por accidente. Toda la autoridad sigue viviendo en
-- `app.tiene_otorgamiento`, que se resuelve contra el actor de la sesión y no
-- contra quien es dueño del esquema. La función devuelve un booleano: no hay
-- fila que se escape por ahí.
--
-- ═══ LA QUINTA VEZ ═══
--
-- 021, 022, 023, y ahora 026. Las tres primeras eran políticas que enumeraban
-- quién llega. Esta es la otra cara de la misma moneda: una política que
-- enumera POR DÓNDE se llega, y al hacerlo le cobra el peaje a un rol que iba
-- para otro lado. El síntoma tampoco fue una pantalla vacía esta vez sino un
-- 500 en un módulo que no tiene nada que ver con firmas — que es peor, porque
-- no se parece en nada a su causa.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- La rama de 023, ahora encapsulada
--
-- Mismo predicado, palabra por palabra. Lo único que cambia es dónde vive.
-- -----------------------------------------------------------------------------
create or replace function app.cuenta_visible_por_otorgamiento(p_cuenta uuid)
returns boolean
language sql stable security definer set search_path = pg_catalog, public
as $$
  select exists (
    select 1
      from public.circuito c
      left join public.instancia i on i.circuito_id = c.id
     where c.cuenta_propietaria_id = p_cuenta
       and (app.tiene_otorgamiento(c.id, i.id, 'metadatos')
         or app.tiene_otorgamiento(c.id, null, 'metadatos'))
  );
$$;

revoke all on function app.cuenta_visible_por_otorgamiento(uuid) from public;
grant execute on function app.cuenta_visible_por_otorgamiento(uuid) to app_rw, app_operador;

-- -----------------------------------------------------------------------------
-- `cuenta_select` sin una sola tabla adentro
--
-- Las tres primeras ramas ya eran funciones. La cuarta ahora también.
-- -----------------------------------------------------------------------------
drop policy cuenta_select on cuenta;
create policy cuenta_select on cuenta for select using (
     id = app.cuenta_actual()
  or app.actor() in ('operador','sistema')   -- el operador ve cuentas, no contenido
  or app.es_miembro(id)                      -- para el selector de acceso
  or app.cuenta_visible_por_otorgamiento(id) -- el firmante externo ve quién le manda
);

commit;

-- -----------------------------------------------------------------------------
-- Que no vuelva a pasar sin avisar
--
-- Recorre las políticas de las tablas sobre las que `app_operador` sí tiene
-- SELECT y falla si alguna nombra una tabla que ese rol no puede leer. No es
-- exhaustivo —lee el texto de la expresión, no su árbol— pero atrapa la forma
-- exacta del error que acabamos de tener, que es la que se repite.
--
-- ⚠ Va DESPUÉS del commit a propósito. Es un centinela, no parte del arreglo:
-- si encuentra otra política vieja con el mismo vicio, quiero enterarme sin que
-- eso deshaga la corrección que esta migración vino a hacer.
-- -----------------------------------------------------------------------------
do $centinela$
declare
  v_tabla   text;
  v_pol     text;
  v_expr    text;
  v_prohibida text;
  v_male    text := '';
begin
  for v_tabla, v_pol, v_expr in
    select c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid)
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
     where p.polcmd in ('r','*')
       and has_table_privilege('app_operador', c.oid, 'select')
  loop
    for v_prohibida in
      select c2.relname
        from pg_class c2
        join pg_namespace n on n.oid = c2.relnamespace
       where n.nspname = 'public'
         and c2.relkind = 'r'
         and not has_table_privilege('app_operador', c2.oid, 'select')
    loop
      if v_expr ~ ('(^|[^a-z_])' || v_prohibida || '([^a-z_]|$)') then
        v_male := v_male || format(E'\n  %s.%s nombra la tabla %s', v_tabla, v_pol, v_prohibida);
      end if;
    end loop;
  end loop;

  if v_male <> '' then
    raise exception E'Políticas que le cobran a app_operador tablas que no puede leer:%s\n\nMover el predicado a una función security definer (ver el encabezado de esta migración).', v_male;
  end if;
end $centinela$;
