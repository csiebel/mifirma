-- =============================================================================
-- MiFirma — 033_sin_carpeta_borradores.sql
-- Saca la carpeta de sistema «Borradores».
--
-- ═══ POR QUÉ ═══
--
-- Un documento terminado seguía apareciendo en «Borradores». No era un error
-- del sistema: la carpeta nunca tuvo nada que ver con el estado. Se llamaba
-- igual que un estado del circuito y no hacía nada — nadie escribía en ella y
-- nada movía documentos al avanzar el proceso. El nombre prometía un
-- comportamiento que no existía.
--
-- Y no se podía arreglar desde la aplicación: `carpeta_delete` exige
-- `sistema is null`, así que una carpeta de sistema no se borra ni se puede
-- borrar. Quedaba ahí para siempre, con documentos adentro y un nombre que
-- miente. Por eso esto es una migración y no un botón.
--
-- ═══ QUÉ REEMPLAZA ═══
--
-- El estado del documento —borrador, esperando firmas, terminado— se muestra
-- como VISTA sobre la lista (`listarDocumentos`, parámetro `vista`), no como
-- lugar. Decidido con Claudio el 2/8/2026, y por tres razones:
--
--   · Los permisos viven POR CARPETA (`app.puede_en_carpeta`). Si el estado
--     fuera carpeta, quién puede ver un documento cambiaría al avanzar el
--     proceso. Es un agujero de autorización con forma de organización.
--   · Una `ubicacion` es única por (cuenta, documento). Moverlo solo a
--     «Terminados» borraría el archivado de quien lo guardó en «Clientes/Acme».
--   · Una carpeta es una decisión de la persona; un estado es un hecho del
--     sistema. Dos mecanismos para la misma pregunta terminan siempre en un
--     documento que aparece en un lado y no en el otro.
--
-- `entrada` (Recibidos) y `papelera` SÍ se quedan: no son estados, son lugares
-- —de dónde vino, y qué se tiró—.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- 1) Lo que había adentro se sube a la raíz de su cuenta.
--
-- No se borra nada y no se pierde ninguna ubicación: la raíz es el padre de
-- esta carpeta, así que los permisos de quien la veía siguen alcanzando.
update ubicacion u
   set carpeta_id = r.id
  from carpeta b
  join carpeta r on r.cuenta_id = b.cuenta_id and r.sistema = 'raiz'
 where u.carpeta_id = b.id and b.sistema = 'borradores';

-- 2) Las subcarpetas que alguien haya creado colgando de ella, también.
--    El trigger `carpeta_mover` recalcula la rama entera sola.
update carpeta c
   set padre_id = r.id
  from carpeta b
  join carpeta r on r.cuenta_id = b.cuenta_id and r.sistema = 'raiz'
 where c.padre_id = b.id and b.sistema = 'borradores';

-- 3) Sus permisos propios, si alguien los puso.
delete from carpeta_permiso p
 using carpeta b
 where p.carpeta_id = b.id and b.sistema = 'borradores';

-- 4) Y la carpeta.
delete from carpeta where sistema = 'borradores';

-- 5) Que no se pueda volver a crear.
--
-- ⚠ Esto es lo que convierte la decisión en un invariante. Sin esto, la próxima
-- persona que lea `provisioning.ts` puede agregarla de nuevo sin enterarse de
-- por qué se sacó — que es exactamente cómo vuelven los errores corregidos.
-- El nombre se busca, no se adivina: un CHECK escrito en la definición de la
-- columna recibe un nombre automático, y suponer cuál es sale mal la vez que
-- alguien renombró algo.
do $quitar$
declare v_nombre text;
begin
  select con.conname into v_nombre
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
   where c.relname = 'carpeta' and con.contype = 'c'
     and pg_get_constraintdef(con.oid) like '%sistema%';
  if v_nombre is null then
    raise exception 'no encuentro el CHECK de carpeta.sistema';
  end if;
  execute format('alter table carpeta drop constraint %I', v_nombre);
end $quitar$;

alter table carpeta add constraint carpeta_sistema_check
  check (sistema in ('raiz','entrada','papelera'));

comment on column carpeta.sistema is
  'Carpetas que crea el alta y no se borran. NO incluye estados del documento: '
  'borrador / esperando firmas / terminado son VISTAS sobre la lista, no lugares. '
  'Ver migración 033.';

commit;

-- Control: no puede quedar ninguna, ni ninguna ubicación huérfana.
do $control$
declare v_n int;
begin
  select count(*) into v_n from carpeta where sistema = 'borradores';
  if v_n > 0 then raise exception 'quedaron % carpetas «borradores»', v_n; end if;

  select count(*) into v_n
    from ubicacion u left join carpeta c on c.id = u.carpeta_id
   where c.id is null;
  if v_n > 0 then raise exception 'quedaron % ubicaciones sin carpeta', v_n; end if;
end $control$;
