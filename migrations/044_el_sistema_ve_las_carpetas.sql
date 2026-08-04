-- =============================================================================
-- MiFirma — 044_el_sistema_ve_las_carpetas.sql
--
-- Por qué un documento firmado no aparecía en la bandeja de su firmante.
--
-- ═══ EL DEFECTO ═══
--
-- `ubicarEnBandeja()` corre en contexto de SISTEMA —no pertenece a ninguna
-- cuenta, porque tiene que poner un documento en el repositorio de un tercero—
-- y hace esto:
--
--   insert into ubicacion (cuenta_id, carpeta_id, instancia_id)
--   select cu.id, ca.id, ...
--     from cuenta cu
--     join carpeta ca on ca.cuenta_id = cu.id and ca.sistema = 'entrada'
--    where cu.tipo = 'persona' and cu.identidad_titular_id = ...
--
-- Y `carpeta_select` decía:
--
--   (cuenta_id = app.cuenta_actual()) AND (app.actor() = 'sistema' OR puede_en_carpeta(...))
--
-- La salida para `sistema` estaba ADENTRO del segundo paréntesis: le perdonaba
-- el permiso de carpeta, pero no la comprobación de cuenta. Y el contexto de
-- sistema no tiene cuenta —`app.cuenta_actual()` es null—, así que la condición
-- da null, el join no encuentra nada, y **el insert no inserta ninguna fila**.
--
-- Sin error. Sin excepción. Cero filas.
--
-- ⚠ Es la única política del esquema con esa forma. Las otras cuarenta ponen
-- `app.actor() = 'sistema'` como primera rama de un OR. Ésta lo puso como
-- excepción anidada, y la diferencia no se ve leyendo — se ve cuando un
-- documento no aparece en la bandeja de nadie.
--
-- ═══ POR QUÉ TARDÓ EN APARECER ═══
--
-- Porque el alta de cuenta SÍ funcionaba: `provisionarCuenta` crea las carpetas
-- en la misma transacción y se queda con el id en la mano, así que nunca
-- necesita hacerles SELECT. El relleno hacia atrás ubicaba todo lo viejo y el
-- despacho no ubicaba nada nuevo. En la pantalla eso se ve como «algunos
-- documentos aparecen y otros no», que es la forma más cara de un bug.
--
-- ⚠ Y encima el llamador lo envuelve en `try { } catch { }` vacío —a propósito:
-- el despacho no se cae por esto— así que ni siquiera había un error en el log.
-- Se arregla también eso, en el código: el catch pasa a dejar rastro.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- 1. La carpeta, con `sistema` como rama propia
--
-- Mismo alcance que antes para todos los demás: la cuenta actual, y sólo las
-- carpetas donde el rol tiene 'ver'. Lo único que cambia es que el sistema deja
-- de necesitar una cuenta que por definición no tiene.
-- -----------------------------------------------------------------------------
drop policy carpeta_select on carpeta;

create policy carpeta_select on carpeta for select using (
  app.actor() = 'sistema'
  or (cuenta_id = app.cuenta_actual() and app.puede_en_carpeta(id, 'ver'))
);

-- -----------------------------------------------------------------------------
-- 2. La ubicación, por el mismo motivo
--
-- `ubicacion_select` no nombraba a `sistema` en absoluto, mientras que su INSERT
-- y su UPDATE sí. Un rol que puede escribir una fila y no puede leerla es una
-- trampa esperando: cualquier trabajo de sistema que quiera comprobar «¿ya está
-- ubicado?» antes de escribir va a ver que no, siempre, y va a reintentar
-- eternamente contra un `on conflict do nothing`.
--
-- Todavía no había ninguno, y por eso no se notó. Se cierra ahora que ya
-- sabemos qué se siente.
-- -----------------------------------------------------------------------------
drop policy ubicacion_select on ubicacion;

create policy ubicacion_select on ubicacion for select using (
  app.actor() = 'sistema'
  or (cuenta_id = app.cuenta_actual() and app.puede_en_carpeta(carpeta_id, 'ver'))
);

commit;

-- -----------------------------------------------------------------------------
-- CENTINELA: el sistema tiene que ver TODAS las filas de las tablas que mantiene
--
-- No es una comprobación de texto sobre la política —eso ya se probó y se
-- escapa—: se pone el contexto de sistema de verdad, con el rol de la
-- aplicación, y se cuenta. Si el sistema ve menos filas que las que hay, hay
-- una política que lo está filtrando y algún trabajo de fondo va a fallar en
-- silencio, como falló éste.
-- -----------------------------------------------------------------------------
do $centinela_sistema$
declare
  t        text;
  v_real   bigint;
  v_visto  bigint;
  v_mal    text := '';
begin
  foreach t in array array['carpeta','ubicacion','cuenta','identidad','instancia',
                           'circuito','participacion','otorgamiento','archivo',
                           'anclaje_identidad','firma_visual','marca_firma']
  loop
    execute format('select count(*) from public.%I', t) into v_real;

    -- Con el rol de la aplicación —que sí tiene RLS— y el contexto de sistema.
    execute 'set local role app_rw';
    perform set_config('app.actor','sistema',true),
            set_config('app.cuenta_id','',true),
            set_config('app.identidad_id','',true),
            set_config('app.anclajes_probados','',true),
            set_config('app.nivel_garantia','ninguno',true),
            set_config('app.otorgamiento_id','',true);
    execute format('select count(*) from public.%I', t) into v_visto;
    execute 'reset role';

    if v_visto < v_real then
      v_mal := v_mal || format(E'\n  %s: el sistema ve %s de %s filas', t, v_visto, v_real);
    end if;
  end loop;

  if v_mal <> '' then
    raise exception
      E'Tablas que el contexto de SISTEMA no puede leer entero:%s\n'
      'El contexto de sistema no pertenece a ninguna cuenta —tiene que poder '
      'escribir en el repositorio de un tercero— así que toda política que le '
      'exija app.cuenta_actual() lo deja sin ver nada. El síntoma no es un '
      'error: es un insert que inserta cero filas y un documento que no aparece '
      'en la bandeja de nadie.',
      v_mal;
  end if;
end $centinela_sistema$;
