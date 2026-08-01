-- =============================================================================
-- MiFirma — 018_alta_de_cuenta.sql
-- El huevo y la gallina del primer administrador.
--
-- ═══ EL PROBLEMA ═══
--
-- Las políticas de inserción de `rol`, `rol_capacidad`, `usuario_rol`,
-- `persona`, `carpeta` y `carpeta_permiso` exigen la capacidad
-- `usuario.administrar`. Eso está bien para todo lo que pasa DESPUÉS del alta,
-- pero al crear una cuenta nueva no existe ningún rol, así que nadie tiene esa
-- capacidad — y el alta no puede crear el rol que la otorgaría.
--
-- No apareció antes porque el único camino que lo ejerce es dar de alta la
-- primera cuenta, y hasta hoy no había ninguna.
--
-- ═══ LA SALIDA, Y POR QUÉ ES SEGURA ═══
--
-- Se agrega una rama `app.actor() = 'sistema'` a esas políticas.
--
-- 'sistema' NO es un rol de base ni algo que un usuario pueda pedir: es un GUC
-- que fija nuestro propio código con `SET LOCAL` dentro de la transacción, y
-- sólo lo hacen los procesos internos (alta de cuentas, login, jobs de la cola).
-- Una request de usuario entra siempre por `withUsuario`, que fija actor
-- 'cuenta'; una del firmante externo por `withExterno`, que fija 'externo'.
-- No hay ningún camino por el que un cliente pueda hacerse pasar por 'sistema'.
--
-- La alternativa —dar el alta con un rol que evade RLS— es peor: crea una
-- conexión privilegiada permanente, disponible para cualquier otra cosa, y ese
-- es el camino por el que la autorización se escapa de la base.
--
-- ⚠ Esta rama es para CREAR. No se agrega a ninguna política de SELECT sobre
--   contenido: 'sistema' no habilita a leer documentos de nadie.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- Roles y capacidades
-- -----------------------------------------------------------------------------
drop policy rol_insert on rol;
create policy rol_insert on rol for insert with check (
  cuenta_id = app.cuenta_actual()
  and (app.actor() = 'sistema' or app.tiene_capacidad('usuario','administrar'))
);

drop policy rol_capacidad_all on rol_capacidad;
create policy rol_capacidad_select on rol_capacidad for select using (
  exists (select 1 from rol r where r.id = rol_capacidad.rol_id
            and (r.cuenta_id = app.cuenta_actual() or r.cuenta_id is null))
);
-- Escribir capacidades de un rol es repartir permisos: exige administrar
-- usuarios, o ser el alta. Antes esto era un `for all` con la misma condición
-- que la lectura, así que cualquiera que viera un rol podía editarle las
-- capacidades. Eso era un agujero, no sólo un hueco del alta.
create policy rol_capacidad_insert on rol_capacidad for insert with check (
  exists (select 1 from rol r where r.id = rol_capacidad.rol_id
            and r.cuenta_id = app.cuenta_actual())
  and (app.actor() = 'sistema' or app.tiene_capacidad('usuario','administrar'))
);
create policy rol_capacidad_delete on rol_capacidad for delete using (
  exists (select 1 from rol r where r.id = rol_capacidad.rol_id
            and r.cuenta_id = app.cuenta_actual() and not r.sistema)
  and app.tiene_capacidad('usuario','administrar')
);

drop policy usuario_rol_insert on usuario_rol;
create policy usuario_rol_insert on usuario_rol for insert with check (
  cuenta_id = app.cuenta_actual()
  and (app.actor() = 'sistema' or app.tiene_capacidad('usuario','administrar'))
);

-- -----------------------------------------------------------------------------
-- Personas
-- -----------------------------------------------------------------------------
drop policy persona_insert on persona;
create policy persona_insert on persona for insert with check (
  cuenta_id = app.cuenta_actual()
  and (app.actor() = 'sistema' or app.tiene_capacidad('usuario','administrar'))
);

-- -----------------------------------------------------------------------------
-- Carpetas
--
-- La 009 ya contemplaba el alta para la carpeta RAÍZ (`padre_id is null and
-- actor = 'sistema'`), pero no para las de sistema que cuelgan de ella
-- —Recibidos, Borradores, Papelera—, que sí tienen padre y todavía no tienen
-- permisos porque los permisos se crean después.
-- -----------------------------------------------------------------------------
drop policy carpeta_insert on carpeta;
create policy carpeta_insert on carpeta for insert with check (
  cuenta_id = app.cuenta_actual()
  and (app.actor() = 'sistema' or app.puede_en_carpeta(padre_id, 'organizar'))
);

-- ⚠ `INSERT ... RETURNING` APLICA TAMBIÉN LA POLÍTICA DE SELECT.
--
-- Es la trampa menos obvia de todo el modelo. `carpeta_select` exige
-- `puede_en_carpeta(id,'ver')`, y durante el alta los permisos todavía no
-- existen: la fila entra, pero leer su id de vuelta la política lo niega, y
-- PostgreSQL reporta "new row violates row-level security policy" — un mensaje
-- que apunta al INSERT y manda a buscar el problema donde no está.
--
-- Cualquier código que haga `.returning('id')` sobre una tabla con SELECT
-- restrictivo se topa con esto. Y la aplicación lo hace todo el tiempo.
drop policy carpeta_select on carpeta;
create policy carpeta_select on carpeta for select using (
  cuenta_id = app.cuenta_actual()
  and (app.actor() = 'sistema' or app.puede_en_carpeta(id, 'ver'))
);

drop policy carpeta_permiso_write on carpeta_permiso;
create policy carpeta_permiso_insert on carpeta_permiso for insert with check (
  cuenta_id = app.cuenta_actual()
  and (app.actor() = 'sistema' or app.puede_en_carpeta(carpeta_id, 'permisos'))
);

commit;
