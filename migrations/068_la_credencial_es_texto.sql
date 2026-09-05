-- =============================================================================
-- MiFirma — 068_la_credencial_es_texto.sql
-- La credencial cifrada del proveedor pasa de `bytea` a `text`.
--
-- ═══ POR QUÉ ═══
--
-- La 067 declaró `proveedor_firma.credenciales_cif` como `bytea`. Fue una
-- decisión tomada sin mirar: `src/operador/cripto.ts` ya resuelve el cifrado del
-- producto y trabaja con TEXTO —
--
--   cifrar(texto: string): string
--   descifrar(blob: string | null | undefined): string
--   enmascarar(blob: string | null | undefined): string
--
-- — el mismo helper que usan las pasarelas de pago. Guardar su salida en un
-- `bytea` obliga a un `encode`/`decode` en cada lectura y cada escritura, y esa
-- conversión de ida y vuelta es donde un día alguien pone `hex` de un lado y
-- `base64` del otro y el secreto queda ilegible. Un secreto ilegible no falla al
-- guardarlo: falla al firmar, meses después.
--
-- Se corrige ahora, con la tabla VACÍA en producción, y no cuando haya
-- credenciales de tres proveedores adentro.
--
-- ⚠ La 067 no se edita. Está aplicada y anotada (b693592, 5/9). Una migración
-- aplicada es historia; lo que se corrige, se corrige con la siguiente.
--
-- ═══ LO QUE NO CAMBIA ═══
--
-- El grano fino de permisos de la 067 se mantiene tal cual: NADIE tiene GRANT de
-- select sobre esta columna, ni app_rw ni app_operador. `select *` sobre
-- proveedor_firma sigue fallando a propósito, y el único camino al secreto sigue
-- siendo `app.credencial_de_proveedor()`.
--
-- El centinela del final verifica que siga así después del cambio de tipo.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- La conversión asume que si hubiera algo cargado, es texto cifrado en base64
-- —que es lo que devuelve `cifrar()`—. Hoy la tabla está vacía, así que no
-- convierte nada; la cláusula está para que la migración sea correcta también en
-- una base donde alguien haya alcanzado a cargar una fila.
--
-- ⚠ Envuelto en una guarda porque `alter column ... type` NO es idempotente: en
-- la segunda pasada la columna ya es `text` y `encode(text, …)` no existe. Lo
-- cazó el banco al correrla dos veces, que es exactamente para lo que sirve.
do $tipo$ begin
  if exists (
    select 1 from pg_attribute a
     where a.attrelid = 'public.proveedor_firma'::regclass
       and a.attname  = 'credenciales_cif'
       and a.atttypid = 'bytea'::regtype
  ) then
    alter table proveedor_firma
      alter column credenciales_cif type text
      using case when credenciales_cif is null then null
                 else encode(credenciales_cif, 'escape') end;
  end if;
end $tipo$;

comment on column proveedor_firma.credenciales_cif is
  'Secreto cifrado con cripto.cifrar() (GATEWAY_ENC_KEY). Texto, no bytea: es el '
  'formato que devuelve el helper del producto. Sin GRANT de select para nadie: '
  'se lee sólo por app.credencial_de_proveedor(). Se carga y no vuelve a mostrarse.';

-- La función devuelve texto. `create or replace` no puede cambiar el tipo de
-- retorno, así que se reemplaza.
drop function if exists app.credencial_de_proveedor(uuid);

create function app.credencial_de_proveedor(p_proveedor uuid)
returns text
language sql stable security definer set search_path = pg_catalog, public
as $$
  select pf.credenciales_cif
    from public.proveedor_firma pf
   where pf.id = p_proveedor and pf.activo_global;
$$;
revoke all on function app.credencial_de_proveedor(uuid) from public;
grant execute on function app.credencial_de_proveedor(uuid) to app_rw;

-- ⚠ Los GRANT por columna se vuelven a otorgar por precaución, no por necesidad.
-- Escribí primero que `alter column ... type` los borraba; lo medí y es FALSO:
-- los permisos por columna SOBREVIVEN al cambio de tipo (Postgres 16). Los dos
-- `grant` de abajo son idempotentes y no hacen daño, pero que quede escrito para
-- que nadie herede la creencia equivocada — y para que el centinela del final se
-- lea por lo que es: una verificación del estado, no la reparación de un daño.
grant insert (credenciales_cif) on proveedor_firma to app_operador;
grant update (credenciales_cif) on proveedor_firma to app_operador;

commit;

-- =============================================================================
-- Que el secreto siga sin poder leerse. Es la afirmación central de la 067 y la
-- que este cambio de tipo podría haber roto sin ruido.
-- =============================================================================
do $sigue_cerrado$
declare v_mal text := '';
begin
  if has_column_privilege('app_rw', 'proveedor_firma', 'credenciales_cif', 'select') then
    v_mal := v_mal || ' app_rw puede leer el secreto;';
  end if;
  if has_column_privilege('app_operador', 'proveedor_firma', 'credenciales_cif', 'select') then
    v_mal := v_mal || ' app_operador puede leer el secreto;';
  end if;
  if not has_column_privilege('app_operador', 'proveedor_firma', 'credenciales_cif', 'update') then
    v_mal := v_mal || ' app_operador NO puede cargar el secreto;';
  end if;
  if v_mal <> '' then
    raise exception 'Permisos del secreto incorrectos tras el cambio de tipo:%', v_mal;
  end if;
end $sigue_cerrado$;
