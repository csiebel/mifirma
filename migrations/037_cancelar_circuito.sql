-- =============================================================================
-- MiFirma — 037_cancelar_circuito.sql
--
-- Cancelar un circuito despachado. Implementa `claude/motor-de-flujo.md` §4.2:
-- «Solo el emisor, con motivo, y solo mientras el circuito no esté en estado
-- terminal. Cancela todas las instancias no cerradas; **las ya firmadas no se
-- tocan** — una firma aplicada no se deshace.»
--
-- ═══ LO QUE YA ESTABA, Y ES LA MITAD DEL TRABAJO ═══
--
-- El esquema ya admitía `circuito.estado = 'cancelado'`, `instancia.estado =
-- 'cancelada'` y la columna `motivo_cancelacion`. Y —esto es lo importante— el
-- trigger `instancia_transicion_valida` de la 006 ya declara que una instancia
-- en estado terminal es **inmutable** y que de ahí no se sale nunca.
--
-- O sea que **lo que impide firmar un documento cancelado ya existe y está en
-- la base**: cuando la firma intente llevar la instancia a `firmada`, el
-- trigger la rechaza. No hace falta —ni conviene— un `if` en el servicio: sería
-- una segunda respuesta a una pregunta que ya tiene dueño, y la carrera entre
-- «cancelar» y «firmar» la tiene que resolver la transacción, no el orden en
-- que llegaron los dos clics.
--
-- Esta migración agrega las tres piezas que faltaban.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- -----------------------------------------------------------------------------
-- 1. Una participación puede quedar CANCELADA
--
-- Faltaba el estado. Las salidas terminales eran firmada, rechazada, delegada,
-- no_requerida y vencida; ninguna dice «esto se canceló».
--
-- ⚠ No se reusa `no_requerida`, que existe para el quórum ya alcanzado. Son dos
-- hechos distintos —«ya no hace falta que firmes» y «esto se canceló»— y
-- mezclarlos deja al firmante sin saber qué pasó y al tablero sin poder
-- contarlo. Es la misma razón por la que `no_requerida` no es un error.
--
-- Y dejarla en `pendiente` no es opción: ensucia todos los tableros y le deja a
-- la persona una tarea que no se resuelve nunca.
-- -----------------------------------------------------------------------------
do $part$
declare v_nombre text;
begin
  select con.conname into v_nombre
    from pg_constraint con
   where con.conrelid = 'public.participacion'::regclass
     and con.contype = 'c'
     and pg_get_constraintdef(con.oid) like '%pendiente%notificada%';
  if v_nombre is null then
    raise exception 'no encontré el CHECK de participacion.estado';
  end if;
  execute format('alter table public.participacion drop constraint %I', v_nombre);
end $part$;

alter table participacion add constraint participacion_estado_check
  check (estado in ('pendiente','notificada','vista','firmada',
                    'rechazada','delegada','no_requerida','vencida','cancelada'));

-- -----------------------------------------------------------------------------
-- 2. El circuito tampoco sale de un estado terminal
--
-- `circuito_congelado` (006) controla QUÉ COLUMNAS se pueden tocar después del
-- despacho, pero no el orden de los estados: hoy un circuito `completo` se
-- podría marcar `cancelado`, que es deshacer una firma por la puerta de atrás.
--
-- Se cierra con el mismo patrón que ya usa `instancia_transicion_valida`, para
-- que las dos tablas se lean igual. Que la regla estuviera en una y no en la
-- otra era una asimetría sin motivo.
-- -----------------------------------------------------------------------------
create or replace function circuito_transicion_valida() returns trigger
language plpgsql as $$
declare v_ok boolean;
begin
  if old.estado is distinct from new.estado then
    v_ok := case old.estado
      when 'borrador' then new.estado in ('enviado','cancelado')
      when 'enviado'  then new.estado in ('completo','cancelado','vencido')
      else false                                  -- los terminales no salen nunca
    end;
    if not v_ok then
      raise exception 'transición inválida de circuito: % → %', old.estado, new.estado;
    end if;
  end if;
  return new;
end $$;

create trigger circuito_transicion_trg before update on circuito
  for each row execute function circuito_transicion_valida();

-- -----------------------------------------------------------------------------
-- 3. Cancelar, en una sola operación
--
-- Está en la base y no en el servicio por una razón concreta: son cuatro
-- escrituras que tienen que ocurrir juntas o no ocurrir —circuito, instancias,
-- participaciones y el vencimiento de los otorgamientos de firma—, y la carrera
-- que importa es contra alguien que está firmando en ese mismo instante. Acá el
-- `for update` la resuelve; repartida en el servicio, depende del orden.
--
-- ⚠ NO revoca ningún otorgamiento irrevocable, y no podría: el trigger
-- `otorgamiento_solo_revocacion` lo impide. Quien ya firmó conserva su copia
-- para siempre, que es exactamente el punto de que sea irrevocable.
--
-- A los que NO firmaron se les vence el otorgamiento de firma y se les emite
-- uno nuevo de sólo lectura. No es un adorno: «tiene que poder saber que en tal
-- fecha le pidieron firmar algo, aunque ya no pueda firmarlo». Borrarles el
-- acceso sería reescribirles la historia.
-- -----------------------------------------------------------------------------
create or replace function app.cancelar_circuito(
  p_circuito uuid,
  p_motivo   text
) returns table (instancias_canceladas int, participaciones_cerradas int)
language plpgsql
security definer set search_path = pg_catalog, public
as $$
declare
  v_estado text;
  v_cuenta uuid;
  v_inst   int := 0;
  v_part   int := 0;
begin
  if p_motivo is null or btrim(p_motivo) = '' then
    raise exception 'la cancelación necesita un motivo' using errcode = '22023';
  end if;

  -- ⚠ `for update` sobre el circuito: es el candado que serializa esto contra
  -- una firma en curso. Sin él, cancelar y firmar a la vez pueden entrelazarse.
  select c.estado, c.cuenta_propietaria_id into v_estado, v_cuenta
    from public.circuito c where c.id = p_circuito for update;

  if v_estado is null then
    raise exception 'ese documento no existe' using errcode = '42704';
  end if;

  -- ⚠ La AUTORIZACIÓN no está acá: la función es `security definer`, así que
  -- adentro no corre la RLS. Quien puede cancelar se decide antes, con la
  -- política de `circuito` y la capacidad del rol, en el servicio que la llama.
  -- Esto comprueba el ESTADO, que es otra cosa.
  if v_estado <> 'enviado' then
    raise exception 'sólo se puede cancelar un documento en curso (está en %)', v_estado
      using errcode = '42501';
  end if;

  update public.instancia
     set estado = 'cancelada'
   where circuito_id = p_circuito
     and estado in ('pendiente','en_curso');
  get diagnostics v_inst = row_count;

  update public.participacion
     set estado = 'cancelada'
   where circuito_id = p_circuito
     and estado in ('pendiente','notificada','vista');
  get diagnostics v_part = row_count;

  -- ⚠ Se REVOCA el otorgamiento de firma; no se le toca `vigente_hasta`.
  --
  -- La primera versión de esto hacía `set vigente_hasta = now()` y el trigger
  -- `otorgamiento_solo_revocacion` la rechazó con la frase que está escrita en
  -- el diseño: «un otorgamiento no se modifica: revocá y emití uno nuevo». Un
  -- otorgamiento es un hecho con fecha, no una fila que se ajusta — si se
  -- pudiera correr el vencimiento, el expediente no podría decir hasta cuándo
  -- estuvo vigente de verdad.
  --
  -- Los irrevocables —los de quien ya firmó— ni se intentan: el mismo trigger
  -- los protege, y ése es exactamente el punto de que sean irrevocables.
  update public.otorgamiento
     set revocado_en = now(),
         revocado_por = app.identidad_actual(),
         motivo_revocacion = 'circuito cancelado: ' || btrim(p_motivo)
   where circuito_id = p_circuito
     and not irrevocable
     and revocado_en is null
     and 'firmar' = any (alcances);

  insert into public.otorgamiento
    (identidad_id, circuito_id, alcances, anclaje_destino_id, nivel_garantia_minimo,
     origen, cuenta_otorgante_id)
  select o.identidad_id, o.circuito_id, array['metadatos','leer']::text[],
         o.anclaje_destino_id, o.nivel_garantia_minimo, 'legal', v_cuenta
    from public.otorgamiento o
   where o.circuito_id = p_circuito
     and o.identidad_id is not null
     and not o.irrevocable
     and o.motivo_revocacion like 'circuito cancelado:%'
     and 'firmar' = any (o.alcances);

  update public.circuito
     set estado = 'cancelado',
         motivo_cancelacion = btrim(p_motivo),
         cerrado_en = now()
   where id = p_circuito;

  return query select v_inst, v_part;
end $$;

revoke all on function app.cancelar_circuito(uuid, text) from public;
grant execute on function app.cancelar_circuito(uuid, text) to app_rw;

comment on function app.cancelar_circuito(uuid, text) is
  'Cancela un circuito en curso. NO toca lo ya firmado ni los otorgamientos '
  'irrevocables. La autorización la decide quien la llama; esto comprueba el '
  'estado y serializa contra una firma en curso. Ver migración 037.';

commit;

-- Centinela de la 026.
do $centinela$
declare v_expr text; v_tabla text; v_pol text; v_mal text := '';
begin
  for v_tabla, v_pol, v_expr in
    select c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid)
      from pg_policy p join pg_class c on c.oid = p.polrelid
     where p.polcmd in ('r','*')
       and has_table_privilege('app_operador', c.oid, 'select')
  loop
    if v_expr ~ '(^|[^a-z_])(circuito|instancia|ubicacion|archivo|participacion|otorgamiento|marca_firma|certificado_finalizacion|registro_pendiente)([^a-z_]|$)' then
      v_mal := v_mal || format(E'\n  %s.%s', v_tabla, v_pol);
    end if;
  end loop;
  if v_mal <> '' then
    raise exception E'Políticas que nombran tablas del dominio y le cobran el GRANT a app_operador:%s', v_mal;
  end if;
end $centinela$;
