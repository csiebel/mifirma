-- =============================================================================
-- Reubica en su bandeja los documentos que quedaron sin ubicación.
--
--   psql "$MIFIRMA_DB" -f db/reubicar-pendientes.sql
--
-- Son los que se despacharon mientras `carpeta_select` le escondía la carpeta
-- de entrada al contexto de sistema —el defecto que arregla la migración 044—.
-- Desde esa migración, el despacho y la firma los ubican solos; esto es para
-- los que quedaron atrás.
--
-- ⚠ QUÉ HACE Y QUÉ NO
--
-- Sólo AGREGA filas en `ubicacion`. No borra, no mueve, no toca ningún
-- documento ni ningún otorgamiento. Es idempotente: correrlo dos veces no
-- duplica nada, porque salta lo que ya está ubicado.
--
-- ⚠ NO le da acceso a nadie que no lo tuviera. El acceso lo da el
-- otorgamiento, que ya existía; esto sólo pone el documento en una carpeta para
-- que se pueda encontrar. Es la misma consulta que corre el alta de cuenta.
--
-- Se ejecuta con el superusuario (MIFIRMA_DB), así que no depende de las
-- políticas — que es justamente lo que estaba fallando.
-- =============================================================================
\set ON_ERROR_STOP on
\pset pager off

begin;

\echo '── Antes ──'
select count(*) as sin_ubicar
  from otorgamiento o
  join cuenta cu on cu.identidad_titular_id = o.identidad_id
                and cu.tipo = 'persona' and cu.estado <> 'cerrada'
 where o.revocado_en is null
   and o.instancia_id is not null
   and not exists (select 1 from ubicacion u
                    where u.instancia_id = o.instancia_id and u.cuenta_id = cu.id);

insert into ubicacion (cuenta_id, carpeta_id, instancia_id)
select cu.id, ca.id, o.instancia_id
  from otorgamiento o
  join cuenta cu   on cu.identidad_titular_id = o.identidad_id
                  and cu.tipo = 'persona' and cu.estado <> 'cerrada'
  join carpeta ca  on ca.cuenta_id = cu.id and ca.sistema = 'entrada'
 where o.revocado_en is null
   and o.instancia_id is not null
   and not exists (select 1 from ubicacion u
                    where u.instancia_id = o.instancia_id and u.cuenta_id = cu.id)
 group by cu.id, ca.id, o.instancia_id;

\echo '── Después: qué quedó ubicado, y para quién ──'
select i.email_normalizado as persona, c.titulo, c.estado
  from ubicacion u
  join cuenta cu on cu.id = u.cuenta_id and cu.tipo = 'persona'
  join identidad i on i.id = cu.identidad_titular_id
  join instancia ins on ins.id = u.instancia_id
  join circuito c on c.id = ins.circuito_id
 order by i.email_normalizado, c.titulo;

commit;
