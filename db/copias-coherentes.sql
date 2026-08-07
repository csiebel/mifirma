-- =============================================================================
-- MiFirma — db/copias-coherentes.sql
--
-- «Mandé el mismo documento a diez personas. ¿Salió bien?»
--
-- Mira el último envío de copias y responde las cuatro cosas que pueden fallar
-- en silencio. Ninguna de las cuatro da error al despachar: el envío sale
-- igual, y el problema aparece del otro lado, con la persona ya mirando su
-- documento.
--
--   1. ¿Cuántas copias hay, y cuántas tienen dueño?
--   2. ¿Alguna copia tiene DOS firmantes?
--   3. ⚠ ¿Los datos que escribió el emisor están en TODAS las copias?
--   4. ¿Los campos se definieron una sola vez, sobre el circuito?
--
-- ⚠ La 3 es la importante y es la que motivó este archivo. Los valores del
-- emisor se escriben en las instancias QUE EXISTEN en ese momento. Quien llena
-- los campos primero y agrega la gente después manda nueve copias en blanco,
-- sin ningún error en ninguna pantalla. `copiaParaUno` lo resuelve copiando los
-- valores al crear cada copia; esto comprueba que efectivamente lo hizo.
--
-- Se corre como superusuario, sin contexto de RLS: es diagnóstico, no producto.
--
--   psql "$MIFIRMA_DB" -f db/copias-coherentes.sql
--
-- ⚠ `$MIFIRMA_DB`, no `$DATABASE_URL`. El segundo es `mifirma_app` y no puede
-- leer sin contexto.
-- =============================================================================
-- Sin paginador: el veredicto está al final y no se llega si esto se corta en
-- un `(END)`.
\pset pager off
\pset border 2
\pset linestyle unicode

\echo ''
\echo '════ EL ÚLTIMO ENVÍO DE COPIAS ════'

\set circ '(select c.id from circuito c where c.modo = ''copias'' order by c.creado_en desc limit 1)'

select c.id                                 as circuito,
       c.titulo,
       c.estado,
       to_char(c.creado_en, 'DD/MM HH24:MI') as creado,
       cu.nombre_mostrado                   as emisor
  from circuito c
  join cuenta cu on cu.id = c.cuenta_propietaria_id
 where c.id = :circ ;

\echo ''
\echo '════ 1. LAS COPIAS, UNA POR FILA ════'
\echo '   Una copia sin firmante en un circuito ENVIADO no la va a firmar nadie:'
\echo '   el circuito cuenta instancias abiertas para saber si terminó, así que'
\echo '   se quedaría esperando para siempre. En borrador es normal —es el hueco'
\echo '   libre para el próximo que se agregue— y el despacho las cancela.'

select i.numero                              as copia,
       i.estado,
       coalesce(id2.email_mostrado, '— sin dueño —') as destinatario,
       p.estado                              as firma,
       (select count(*) from valor_campo v where v.instancia_id = i.id
         and v.valor is not null)::text      as datos_cargados
  from instancia i
  left join participacion p
         on p.instancia_id = i.id and p.papel = 'firmante'
  left join identidad id2 on id2.id = p.identidad_id
 where i.circuito_id = :circ
 order by i.numero;

\echo ''
\echo '════ 2. ¿ALGUNA COPIA CON DOS FIRMANTES? ════'
\echo '   0 filas = bien. Con dos, la segunda persona abre el documento y'
\echo '   encuentra los campos ya llenos por la primera.'

select i.numero as copia, count(*) as firmantes
  from instancia i
  join participacion p on p.instancia_id = i.id and p.papel = 'firmante'
 where i.circuito_id = :circ
 group by i.numero
having count(*) > 1
 order by i.numero;

\echo ''
\echo '════ 3. ⚠ LOS DATOS DEL EMISOR, ¿ESTÁN EN TODAS? ════'
\echo '   Una fila por campo del emisor. `copias_con_dato` tiene que ser igual a'
\echo '   `copias_vivas`. Si es menor, hay gente que va a recibir el documento'
\echo '   con ese renglón en blanco — y el emisor cree que lo llenó.'

with vivas as (
  select i.id, i.numero
    from instancia i
   where i.circuito_id = :circ
     and i.estado not in ('cancelada','vencida')
     and exists (select 1 from participacion p
                  where p.instancia_id = i.id and p.papel = 'firmante')
)
select c.codigo                                     as campo,
       c.tipo,
       (select count(*) from vivas)::text           as copias_vivas,
       count(v.id) filter (where v.valor is not null)::text as copias_con_dato,
       case when count(v.id) filter (where v.valor is not null) = (select count(*) from vivas)
            then 'ok'
            else '⚠ FALTA EN ' ||
                 ((select count(*) from vivas) - count(v.id) filter (where v.valor is not null))::text
       end                                          as veredicto
  from campo c
  left join vivas vi on true
  left join valor_campo v on v.campo_id = c.id and v.instancia_id = vi.id
 where c.circuito_id = :circ
   and c.quien_completa = 'emisor'
 group by c.id, c.codigo, c.tipo
 order by c.codigo;

\echo ''
\echo '════ 4. LOS CAMPOS, DEFINIDOS UNA SOLA VEZ ════'
\echo '   Los campos cuelgan del CIRCUITO, no de cada copia: por eso se definen'
\echo '   una vez y valen para las diez. Si esta lista tiene el mismo código'
\echo '   repetido, algo los duplicó.'

select c.codigo,
       c.tipo,
       c.quien_completa,
       c.orden_firmante,
       c.pagina,
       count(*) over (partition by c.codigo) as veces
  from campo c
 where c.circuito_id = :circ
 order by c.codigo;

\echo ''
\echo '════ VEREDICTO ════'

do $v$
declare
  v_circ uuid;
  v_mal text := '';
  v_n int;
  v_vivas int;
begin
  select c.id into v_circ from circuito c
   where c.modo = 'copias' order by c.creado_en desc limit 1;

  if v_circ is null then
    raise notice 'Todavía no hay ningún envío de copias. Nada que revisar.';
    return;
  end if;

  select count(*) into v_vivas from instancia i
   where i.circuito_id = v_circ
     and i.estado not in ('cancelada','vencida')
     and exists (select 1 from participacion p
                  where p.instancia_id = i.id and p.papel = 'firmante');

  -- Copias abiertas sin dueño, en un circuito ya despachado.
  select count(*) into v_n from instancia i
    join circuito c on c.id = i.circuito_id
   where i.circuito_id = v_circ
     and c.estado = 'enviado'
     and i.estado in ('pendiente','en_curso')
     and not exists (select 1 from participacion p
                      where p.instancia_id = i.id and p.papel = 'firmante');
  if v_n > 0 then
    v_mal := v_mal || format(E'\n  %s copia(s) en curso sin firmante: el circuito no va a cerrar nunca', v_n);
  end if;

  -- Dos firmantes en la misma copia.
  select count(*) into v_n from (
    select i.id from instancia i
      join participacion p on p.instancia_id = i.id and p.papel = 'firmante'
     where i.circuito_id = v_circ
     group by i.id having count(*) > 1) x;
  if v_n > 0 then
    v_mal := v_mal || format(E'\n  %s copia(s) con más de un firmante', v_n);
  end if;

  -- ⚠ El dato del emisor que no llegó a todas.
  select count(*) into v_n from campo c
   where c.circuito_id = v_circ
     and c.quien_completa = 'emisor'
     and (select count(*) from valor_campo v
           join instancia i on i.id = v.instancia_id
          where v.campo_id = c.id
            and i.circuito_id = v_circ
            and i.estado not in ('cancelada','vencida')
            and v.valor is not null
            and exists (select 1 from participacion p
                         where p.instancia_id = i.id and p.papel = 'firmante')) < v_vivas;
  if v_n > 0 then
    v_mal := v_mal || format(
      E'\n  %s campo(s) del emisor no están en todas las copias: hay gente que lo va a recibir en blanco', v_n);
  end if;

  if v_mal <> '' then
    raise warning E'Este envío tiene problemas:%', v_mal;
  else
    raise notice 'Las % copias están sanas: cada una con su dueño y con los datos del emisor completos.', v_vivas;
  end if;
end $v$;

\echo ''
