-- 062 — El administrador propone: la función que la 061 le debía.
--
-- ═══ QUÉ PASÓ ═══
--
-- La 061 partió el teléfono en dos columnas: `telefono_e164` (confirmado, el
-- que abre puertas) y `telefono_propuesto_e164` (lo que carga el admin, que no
-- habilita nada). El backend quedó escribiendo la propuesta con un update
-- común desde `darAcceso`. **Ese update nunca escribió nada**, y se descubrió
-- el 15/8 probándolo por pantalla: se dio un acceso con celular cargado y en la
-- base quedó vacío.
--
-- Dos causas apiladas, y las dos silenciosas:
--
--   1. **La fila todavía no existe.** La credencial de una persona se crea
--      cuando elige su contraseña (`auth_reset.ts`). Al dar acceso no hay
--      ninguna fila que actualizar, y un update que no encuentra filas no es un
--      error: no hace nada.
--   2. **Y aunque existiera, la RLS no lo permite.** `credencial_update` (009)
--      dice `identidad_id = app.identidad_actual()`: la credencial de una
--      persona la toca esa persona y nadie más. El administrador de su empresa
--      tampoco. **La base estaba defendiendo la promesa de la 061.**
--
-- Lo mismo le pasaba al NOMBRE que el admin escribe al dar acceso:
-- `identidad_update` (009) sólo deja editar la identidad propia. Ese campo era
-- decorativo desde antes de la 061 — por eso en la lista de Accesos aparecía el
-- correo en vez del nombre cargado.
--
-- ⚠⚠ La lección, que vale más que la migración: **un update que no afecta
-- filas se ve exactamente igual que uno que funcionó.** El typecheck pasa, la
-- pantalla dice «listo», y el dato no está. Sólo lo encuentra mirar la base.
--
-- ═══ LA DECISIÓN ═══
--
-- No se toca la RLS. Aflojar `credencial_update` para que un admin escriba en
-- la credencial de otro abriría, de paso, la columna que sí abre puertas: la
-- política no distingue qué columna se está tocando. En vez de eso, una función
-- `security definer` con la autorización adentro, que es como el proyecto ya
-- resuelve `app.resolver_identidad` (003).
--
-- ⚠⚠ `security definer` significa que la función corre con los permisos de su
-- dueño y **se saltea la RLS**. Por eso acá adentro no hay nada implícito: cada
-- condición está escrita, y la función sólo puede hacer las dos cosas para las
-- que existe.
--
--   · Escribe `telefono_propuesto_e164`  → sí
--   · Escribe `nombre_mostrado`, y sólo si está vacío → sí
--   · Escribe `telefono_e164`            → NUNCA. No aparece en esta función.
--
-- ⚠ Y no pisa a quien ya confirmó un número: si esa persona tiene su teléfono
-- confirmado, la propuesta del admin se ignora en silencio. Su número manda.

\set ON_ERROR_STOP on

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: esta migración es de mifirma y la base es %', current_database();
  end if;
end $guard$;

begin;

create or replace function app.proponer_datos_de_acceso(
  p_identidad uuid,
  p_nombre    text default null,
  p_telefono  text default null
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_cuenta uuid := app.cuenta_actual();
begin
  -- ── Quién puede llamarla ────────────────────────────────────────────────
  --
  -- Las tres condiciones son la RLS que la función se saltea, escrita a mano.
  -- Si alguna se afloja, se afloja el sistema entero: acá se decide quién puede
  -- escribir en la credencial de otra persona.
  if app.actor() <> 'cuenta' then
    raise exception 'Sólo un usuario de una empresa puede proponer datos de acceso.';
  end if;

  if v_cuenta is null then
    raise exception 'Falta el contexto de cuenta.';
  end if;

  if not app.tiene_capacidad('usuario', 'administrar') then
    raise exception 'No tenés permiso para gestionar accesos.';
  end if;

  -- La persona tiene que ser de TU empresa. Sin esto, conociendo un id
  -- cualquiera se le escribiría a alguien de otra cuenta.
  if not exists (
    select 1 from public.membresia m
     where m.identidad_id = p_identidad
       and m.cuenta_id    = v_cuenta
       and m.estado       = 'activa'
       and m.hasta is null
  ) then
    raise exception 'Esa persona no tiene acceso activo a tu cuenta.';
  end if;

  -- ── El nombre ───────────────────────────────────────────────────────────
  --
  -- Sólo si la identidad no tiene uno propio: el admin de una empresa no le
  -- renombra la identidad a nadie. Es la misma condición que ya estaba en
  -- `darAcceso` y que la RLS hacía imposible de cumplir.
  if p_nombre is not null and btrim(p_nombre) <> '' then
    update public.identidad
       set nombre_mostrado = btrim(p_nombre)
     where id = p_identidad
       and nombre_mostrado is null;
  end if;

  -- ── El celular ──────────────────────────────────────────────────────────
  if p_telefono is not null and btrim(p_telefono) <> '' then
    if btrim(p_telefono) !~ '^\+[1-9][0-9]{7,14}$' then
      raise exception 'El celular va en formato internacional, por ejemplo +59899123456.';
    end if;

    -- ⚠ Crea la fila de credencial si no existe. Es el caso NORMAL al dar
    -- acceso: esa persona todavía no eligió contraseña. `auth_reset.ts` inserta
    -- con `on conflict do update` sobre las columnas de la contraseña, así que
    -- encontrarse la fila hecha no lo rompe, y la propuesta sobrevive.
    --
    -- ⚠⚠ `telefono_e164` no se nombra: una fila que nace acá nace SIN teléfono
    -- confirmado, y el trigger de la 061 la deja pasar por eso mismo.
    insert into public.credencial (identidad_id, telefono_propuesto_e164)
    values (p_identidad, btrim(p_telefono))
    on conflict (identidad_id) do update
       set telefono_propuesto_e164 = excluded.telefono_propuesto_e164
     where public.credencial.telefono_e164 is null;
  end if;
end $$;

comment on function app.proponer_datos_de_acceso(uuid, text, text) is
  'Deja que un admin cargue el nombre y PROPONGA un celular a alguien de su '
  'cuenta. Nunca escribe telefono_e164: eso lo confirma su dueño. Ver 062.';

grant execute on function app.proponer_datos_de_acceso(uuid, text, text) to app_rw;

commit;
