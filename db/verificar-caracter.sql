-- =============================================================================
-- Qué quedó emitido según el carácter de cada firma.
--
--   psql "$MIFIRMA_DB" -f db/verificar-caracter.sql
--
-- Sólo lee. Muestra lo que la pantalla no puede mostrar: que un otorgamiento
-- personal es perpetuo y uno de representación se apaga con la membresía.
-- =============================================================================
\pset pager off
\pset format aligned

\echo ''
\echo '════ CADA FIRMANTE, CON QUÉ CARÁCTER Y QUÉ LE QUEDÓ ════'
select
  c.titulo,
  coalesce(i.nombre_mostrado, i.email_mostrado)         as firmante,
  coalesce(p.caracter, '⚠ SIN ELEGIR')                  as caracter,
  cr.nombre_mostrado                                    as representa_a,
  p.estado
from participacion p
join circuito c   on c.id = p.circuito_id
join identidad i  on i.id = p.identidad_id
left join cuenta cr on cr.id = p.cuenta_representada_id
where p.papel = 'firmante'
order by c.creado_en desc, p.orden;

\echo ''
\echo '════ LOS OTORGAMIENTOS VIVOS, Y CUÁNTO DURAN ════'
\echo '  perpetuo      = irrevocable: se lo lleva aunque cambie de trabajo'
\echo '  hasta membresía = se apaga solo el día que termine el vínculo laboral'
\echo '  revocable     = todavía en curso, o el derecho a firmar sin usar'
select
  c.titulo,
  coalesce(i.nombre_mostrado, i.email_mostrado, 'EMPRESA: ' || cu.nombre_mostrado) as sujeto,
  array_to_string(o.alcances, ', ')                     as alcances,
  case
    when o.irrevocable                       then 'perpetuo'
    when o.condicionado_a_cuenta_id is not null
      then 'hasta membresía en ' || (select nombre_mostrado from cuenta
                                      where id = o.condicionado_a_cuenta_id)
    else 'revocable'
  end                                                    as dura,
  o.origen
from otorgamiento o
join instancia ins on ins.id = o.instancia_id
join circuito c    on c.id = ins.circuito_id
left join identidad i on i.id = o.identidad_id
left join cuenta cu   on cu.id = o.cuenta_id
where o.revocado_en is null
order by c.creado_en desc, sujeto;

\echo ''
\echo '════ EN QUÉ REPOSITORIO QUEDÓ CADA DOCUMENTO ════'
\echo '  Personal → el de la persona. Representación → el de la empresa.'
select c.titulo, cu.tipo, cu.nombre_mostrado as repositorio,
       (select ca.sistema from carpeta ca where ca.id = u.carpeta_id) as carpeta
  from ubicacion u
  join cuenta cu on cu.id = u.cuenta_id
  left join instancia ins on ins.id = u.instancia_id
  join circuito c on c.id = coalesce(u.circuito_id, ins.circuito_id)
 where u.instancia_id is not null
 order by c.creado_en desc, cu.nombre_mostrado;
