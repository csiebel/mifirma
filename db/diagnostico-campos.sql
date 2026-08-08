-- =============================================================================
-- MiFirma — db/diagnostico-campos.sql
--
-- «Subí un PDF con formulario y el firmante no ve ningún campo.»
--
-- Contesta POR QUÉ, en vez de dejarlo para adivinar. Mira el último documento
-- que se mandó a firmar y responde las cuatro preguntas que pueden fallar, en
-- orden. La primera que falla es la respuesta; las de abajo son consecuencia.
--
--   1. ¿El circuito tiene campos definidos?     — si no, nadie adoptó nada.
--   2. ¿A quién se le pidió cada campo?          — orden 1, orden 2, o el emisor.
--   3. ¿Qué firmantes hay y en qué orden?        — para cruzar con lo anterior.
--   4. ¿Hay valores cargados?
--
-- Se corre como superusuario, sin contexto de RLS: es diagnóstico, no producto.
--
--   psql "$MIFIRMA_DB" -f db/diagnostico-campos.sql
--
-- ⚠ `$MIFIRMA_DB`, no `$DATABASE_URL`. El segundo es `mifirma_app` y no puede
-- leer sin contexto.
-- =============================================================================
-- ⚠ Sin paginador. Un diagnóstico que se corta en la primera tabla y deja al
-- que lo corre en un `(END)` esperando obliga a saber salir de `less` para leer
-- el veredicto, que es justamente la parte que importa y está al final.
\pset pager off
\pset border 2
\pset linestyle unicode

\echo ''
\echo '════ EL ÚLTIMO DOCUMENTO ENVIADO ════'

select c.id                                as circuito,
       c.titulo,
       c.estado,
       to_char(c.creado_en, 'DD/MM HH24:MI') as creado,
       cu.nombre_mostrado                  as emisor
  from circuito c
  join cuenta cu on cu.id = c.cuenta_propietaria_id
 order by c.creado_en desc
 limit 1;

\echo ''
\echo '════ 1. ¿TIENE CAMPOS DEFINIDOS? ════'
\echo '   0 filas = nadie tocó «Agregar» en Campos a completar.'
\echo '   El PDF puede traer doce campos de formulario: detectar no es adoptar.'

select ca.codigo,
       ca.etiqueta_i18n ->> 'es'          as etiqueta,
       ca.tipo,
       ca.obligatorio,
       case when ca.quien_completa = 'emisor'     then 'el emisor'
            when ca.quien_completa = 'cualquiera' then 'cualquiera de los firmantes'
            else 'el firmante del LUGAR ' || coalesce(ca.posicion_firmante::text, '?')
       end                                as quien_lo_completa,
       ca.pagina + 1                      as hoja,
       ca.x, ca.y, ca.ancho, ca.alto
  from campo ca
 where ca.circuito_id = (select id from circuito order by creado_en desc limit 1)
 order by ca.pagina, ca.orden, ca.codigo;

\echo ''
\echo '════ 2. LOS FIRMANTES: SU TURNO Y SU LUGAR ════'
\echo '   Son dos cosas distintas y conviene no confundirlas:'
\echo '     · turno  = cuándo le toca. Serie 1,2,3 · paralelo 1,1,1 · copias 1.'
\echo '     · lugar  = quién es. Siempre distinto dentro del mismo documento.'
\echo '   Cruzar «lugar» con «quien_lo_completa» de arriba. Si un campo dice'
\echo '   «el firmante del LUGAR 1» y estás firmando desde el lugar 2, no es'
\echo '   tuyo y no te lo va a mostrar. Es correcto, pero puede no ser lo que'
\echo '   quisiste. (Ver migración 055.)'

select p.orden as turno,
       p.posicion as lugar,
       coalesce(i.nombre_mostrado, '(sin nombre)') as firmante,
       i.email_mostrado                    as email,
       p.papel,
       p.estado,
       p.caracter
  from participacion p
  join instancia inst on inst.id = p.instancia_id
  left join identidad i on i.id = p.identidad_id
 where inst.circuito_id = (select id from circuito order by creado_en desc limit 1)
 order by p.orden;

\echo ''
\echo '════ 3. VALORES CARGADOS ════'

select ca.codigo,
       v.valor,
       case when v.congelado_en is null then 'editable' else 'congelado' end as estado,
       coalesce(i.email_mostrado, '(?)')   as lo_completo
  from valor_campo v
  join campo ca on ca.id = v.campo_id
  left join identidad i on i.id = v.completado_por
 where ca.circuito_id = (select id from circuito order by creado_en desc limit 1)
 order by ca.orden;

\echo ''
\echo '════ VEREDICTO ════'

do $v$
declare
  v_circ uuid;
  v_titulo text;
  v_estado text;
  v_campos int;
  v_ordenes text;
  v_firmantes int;
  v_huerfanos int;
begin
  select id, titulo, estado into v_circ, v_titulo, v_estado
    from circuito order by creado_en desc limit 1;

  if v_circ is null then
    raise notice 'No hay ningún circuito en la base.';
    return;
  end if;

  select count(*) into v_campos from campo where circuito_id = v_circ;

  select count(*) into v_firmantes
    from participacion p join instancia i on i.id = p.instancia_id
   where i.circuito_id = v_circ and p.papel = 'firmante';

  if v_campos = 0 then
    raise notice '';
    raise notice '  ▸ «%» NO TIENE NINGÚN CAMPO DEFINIDO.', v_titulo;
    raise notice '';
    raise notice '    Por eso el firmante no ve ningún recuadro amarillo: no hay';
    raise notice '    nada que completar. Que el PDF traiga campos de formulario';
    raise notice '    no los adopta — hay que abrirlos en «Campos a completar» y';
    raise notice '    tocar «Agregar los N», y después Guardar.';
    raise notice '';
    if v_estado <> 'borrador' then
      raise notice '    ⚠ Y este circuito ya está en «%», así que los campos no se', v_estado;
      raise notice '    pueden agregar más. Hay que mandar el documento de nuevo.';
    end if;
    return;
  end if;

  -- Campos pedidos a un orden de firmante que no existe
  select count(*) into v_huerfanos
    from campo ca
   where ca.circuito_id = v_circ
     and ca.quien_completa = 'firmante'
     and not exists (
       select 1 from participacion p join instancia i on i.id = p.instancia_id
        where i.circuito_id = v_circ
          and p.papel = 'firmante'
          and p.posicion = ca.posicion_firmante
     );

  raise notice '';
  raise notice '  ▸ «%» tiene % campo(s) y % firmante(s).', v_titulo, v_campos, v_firmantes;

  if v_huerfanos > 0 then
    raise notice '';
    raise notice '  ⚠ % campo(s) están pedidos a un LUGAR que nadie ocupa en', v_huerfanos;
    raise notice '    este circuito. Nadie los va a poder completar. Suele ser';
    raise notice '    que se quitó a un firmante y sus campos quedaron colgados.';
  end if;

  select string_agg(distinct
           case when quien_completa = 'emisor'     then 'el emisor'
                when quien_completa = 'cualquiera' then 'cualquiera de los firmantes'
                else 'el firmante del lugar ' || posicion_firmante end, ', ')
    into v_ordenes
    from campo where circuito_id = v_circ;

  raise notice '';
  raise notice '    Los completa: %.', v_ordenes;
  raise notice '    Si estás firmando con otro de los firmantes, no vas a ver';
  raise notice '    los recuadros: son de él, y eso es correcto.';
  raise notice '';
end $v$;

\echo ''
