select '026 · funcion cuenta_visible_por_otorgamiento' as que,
       to_char(count(*), 'FM9') as hay
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app' and p.proname = 'cuenta_visible_por_otorgamiento'
union all
select '026 · cuenta_select SIN nombrar tablas',
       case when pg_get_expr(polqual, polrelid) !~ 'circuito|instancia' then 'si' else 'NO' end
  from pg_policy where polname = 'cuenta_select'
union all
select '027 · cuenta_id admite null',
       case when attnotnull then 'NO' else 'si' end
  from pg_attribute
 where attrelid = 'bitacora_plataforma'::regclass and attname = 'cuenta_id'
union all
select '027 · constraint', to_char(count(*), 'FM9')
  from pg_constraint where conname = 'bitacora_sin_cuenta_solo_sistema'
union all
select '027 · indice', to_char(count(*), 'FM9')
  from pg_indexes where indexname = 'bitacora_plataforma_sin_cuenta';
