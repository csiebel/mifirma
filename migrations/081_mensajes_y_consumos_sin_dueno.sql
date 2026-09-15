-- =============================================================================
-- MiFirma — 081_mensajes_y_consumos_sin_dueno.sql
-- WhatsApp como concepto propio, y consumos que no son de ningún cliente.
--
-- ═══ LAS DOS DECISIONES DE CLAUDIO (15/9/2026) ═══
--
--   1. EL SMS DE ENTRAR NO SE LE COBRA A NADIE, PERO SE MIDE. Sale antes de que
--      la persona elija empresa: se sabe quién es, no desde dónde entra, y si
--      pertenece a varias tampoco cuál va a elegir. Es costo de la plataforma —
--      lo que cuesta que la gente pueda entrar— y no algo que una empresa
--      provocó. Lo que SÍ se le cobra a la empresa es lo que ella provoca:
--      confirmar el celular de un empleado, y más adelante el código de acceso
--      que le pone a un firmante.
--
--   2. WHATSAPP SE CUENTA Y SE COBRA SEPARADO DEL SMS. Twilio cobra distinto
--      por cada uno. Separarlos hoy cuesta una línea; separarlos después
--      costaría rehacer meses de mediciones mezcladas.
--
-- ═══ LO QUE LA PRIMERA DECISIÓN ROMPE, Y CÓMO SE ARREGLA ═══
--
-- `evento_medible.cuenta_id` es NOT NULL desde la 079: toda línea tenía dueño.
-- Un consumo de plataforma no lo tiene. Se abre a NULL **con un candado**: una
-- línea sin dueño no puede cobrarse ni tener precio. Sin ese candado, `cuenta_id`
-- nullable sería una puerta para que un consumo cobrable se escriba sin cliente
-- y desaparezca de toda factura sin que nada proteste.
--
-- ⚠⚠ Y la RLS ya hace lo correcto sola, pero conviene decirlo: la política
-- compara `cuenta_id = app.cuenta_actual()`, y **NULL nunca es igual a nada**.
-- Una cuenta NO ve las líneas de plataforma. Sólo operador y sistema. Es lo que
-- se quiere —son costos internos— pero es por accidente feliz de cómo funciona
-- NULL, así que queda escrito para que nadie lo "arregle".
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- =============================================================================
-- 1. CONSUMOS SIN DUEÑO
-- =============================================================================
alter table evento_medible alter column cuenta_id drop not null;

-- ⚠ El candado. Una línea sin dueño no se cobra y no tiene precio: si no, un
-- consumo cobrable podría escribirse sin cliente y no aparecer en ninguna
-- factura, sin que nada avise.
alter table evento_medible drop constraint if exists medible_sin_dueno_no_se_cobra;
alter table evento_medible add constraint medible_sin_dueno_no_se_cobra
  check (cuenta_id is not null or (cobrada = false and precio_unitario = 0));

-- Y una firma SIEMPRE tiene dueño: el emisor. Una firma sin cuenta sería una
-- firma que nadie emitió.
alter table evento_medible drop constraint if exists medible_firma_con_dueno;
alter table evento_medible add constraint medible_firma_con_dueno
  check (tipo <> 'firma' or cuenta_id is not null);

comment on column evento_medible.cuenta_id is
  'La cuenta que paga: siempre el EMISOR. NULL = consumo de la plataforma, que no se le '
  'cobra a nadie (el SMS de entrar al producto, decisión del 15/9). Una línea sin cuenta '
  'no puede estar cobrada ni tener precio.';

-- =============================================================================
-- 2. WHATSAPP, CONCEPTO PROPIO
-- =============================================================================
alter table evento_medible drop constraint if exists evento_medible_tipo_check;
alter table evento_medible add constraint evento_medible_tipo_check
  check (tipo in (
    'firma', 'circuito_despachado', 'documento_completado',
    'sms', 'whatsapp', 'sello_tsa', 'verificacion_identidad',
    'almacenamiento', 'asistente_ia'));

-- El precio de venta y el costo, cada uno con su lugar propio.
do $metrica$
declare v_nombre text;
begin
  for v_nombre in
    select conname from pg_constraint
     where conrelid = 'precio_metrica'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%''circuito''::text%'
       and pg_get_constraintdef(oid) like '%''sms''::text%'
  loop
    execute format('alter table precio_metrica drop constraint %I', v_nombre);
  end loop;

  alter table precio_metrica add constraint precio_metrica_metrica_valida
    check (metrica in ('abono','firma','documento','circuito','sms','whatsapp','sello_tsa',
                       'asistente_ia','dispositivo_propio','identidad_digital','almacenamiento'));
end $metrica$;

alter table tarifa_costo drop constraint if exists tarifa_costo_concepto_check;
alter table tarifa_costo add constraint tarifa_costo_concepto_check
  check (concepto in ('firma_proveedor','sello_plataforma','sello_tsa','sms','whatsapp',
                      'verificacion_identidad','almacenamiento','asistente_ia'));

-- =============================================================================
-- 2 bis. EL PAÍS DEL DESTINO ES DATO DE PAÍS, NO UN MAPA EN EL CÓDIGO
--
-- Lo que cuesta un mensaje depende de adónde va. Para saberlo hay que sacar el
-- país del teléfono, y la tentación es un `if` con +598, +595 y +55 adentro de
-- TypeScript.
--
-- ⚠ Eso sería exactamente lo que el proyecto no hace: el marco de cada país es
-- DATO versionado, no conocimiento del código. Con el prefijo en la tabla, el
-- operador da de alta un país nuevo y los mensajes a ese país se miden solos.
--
-- ⚠⚠ Se resuelve por el prefijo MÁS LARGO que coincida, no por el primero. Con
-- +1 (Estados Unidos) y +1242 (Bahamas) conviviendo, el primero que coincida
-- siempre sería el corto y todo el Caribe se costearía como Estados Unidos.
-- =============================================================================
alter table pais add column if not exists prefijo_telefonico text;

comment on column pais.prefijo_telefonico is
  'Prefijo internacional sin el +, como texto ("598"). Dato del paquete de país. '
  'Se resuelve por el más largo que coincida. Migración 081.';

update pais set prefijo_telefonico = '598' where codigo = 'UY' and prefijo_telefonico is null;
update pais set prefijo_telefonico = '595' where codigo = 'PY' and prefijo_telefonico is null;
update pais set prefijo_telefonico = '55'  where codigo = 'BR' and prefijo_telefonico is null;

create or replace function app.pais_de_telefono(p_tel text)
returns char(2)
language sql stable security definer set search_path = pg_catalog, public
as $$
  select p.codigo
    from public.pais p
   where p.prefijo_telefonico is not null
     and regexp_replace(coalesce(p_tel, ''), '[^0-9]', '', 'g') like p.prefijo_telefonico || '%'
   -- ⚠ El más largo primero: si no, +1242 se resolvería como +1.
   order by length(p.prefijo_telefonico) desc
   limit 1;
$$;
revoke all on function app.pais_de_telefono(text) from public;
grant execute on function app.pais_de_telefono(text) to app_rw, app_operador;

-- =============================================================================
-- 3. `app.medir()` ACEPTA UN CONSUMO SIN DUEÑO
--
-- Cambian tres cosas y nada más:
--   · el país y la moneda ya no salen siempre de la cuenta — sin cuenta hay que
--     decírselos, y para un mensaje el país es el del DESTINO, que es lo que
--     determina lo que cuesta;
--   · sin cuenta no hay plan, ni precio, ni incluidas: la línea sale en 0 y sin
--     cobrar, que es exactamente lo que el candado de arriba exige;
--   · el costo externo se sigue resolviendo igual, porque eso no depende de
--     quién pague sino de qué se consumió y adónde.
-- =============================================================================
create or replace function app.medir(
  p_tipo            text,
  p_cuenta          uuid,
  p_clave           text,
  p_cantidad        numeric   default 1,
  p_unidad          text      default 'unidad',
  p_metrica_precio  text      default null,
  p_concepto_costo  text      default null,
  p_proveedor       uuid      default null,
  p_nivel_firma     text      default null,
  p_participacion   uuid      default null,
  p_instancia       uuid      default null,
  p_circuito        uuid      default null,
  p_detalle         jsonb     default null,
  -- ⚠ Sólo se usa cuando no hay cuenta. Con cuenta manda el país del emisor,
  -- como siempre: un uruguayo que firma para una empresa brasileña genera un
  -- consumo brasileño.
  p_pais_sin_cuenta char(2)   default null
)
returns uuid
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_plan     uuid;
  v_moneda   char(3);
  v_pais     char(2);
  v_periodo  char(7) := to_char(now(), 'YYYY-MM');
  v_metrica  text;
  v_concepto text;
  v_precio   numeric(14,4) := 0;
  v_incluida numeric(14,4) := 0;
  v_ya       numeric(14,4);
  v_cobrada  boolean := true;
  v_costo    numeric(14,4);
  v_mon_c    char(3);
  v_id       uuid;
begin
  if p_cuenta is not null then
    select c.pais into v_pais from public.cuenta c where c.id = p_cuenta;
    if not found then
      raise warning 'medir: no existe la cuenta %', p_cuenta;
      return null;
    end if;

    select s.plan_id, s.moneda into v_plan, v_moneda
      from public.suscripcion s
     where s.cuenta_id = p_cuenta and s.estado = 'activa'
     order by s.inicio desc limit 1;
  else
    -- Consumo de la plataforma: no hay emisor, así que el país lo dice quien
    -- mide. Para un mensaje es el país del destino.
    v_pais    := coalesce(p_pais_sin_cuenta, 'UY');
    v_cobrada := false;
  end if;

  v_moneda := coalesce(v_moneda, 'USD');

  v_metrica  := coalesce(p_metrica_precio, case p_tipo
                   when 'firma' then 'firma'
                   when 'circuito_despachado' then 'circuito'
                   when 'documento_completado' then 'documento'
                   when 'sms' then 'sms'
                   when 'whatsapp' then 'whatsapp'
                   when 'sello_tsa' then 'sello_tsa'
                   when 'verificacion_identidad' then 'identidad_digital'
                   when 'almacenamiento' then 'almacenamiento'
                   when 'asistente_ia' then 'asistente_ia' end);
  v_concepto := coalesce(p_concepto_costo, case p_tipo
                   when 'sms' then 'sms'
                   when 'whatsapp' then 'whatsapp'
                   when 'sello_tsa' then 'sello_tsa'
                   when 'verificacion_identidad' then 'verificacion_identidad'
                   when 'almacenamiento' then 'almacenamiento'
                   when 'asistente_ia' then 'asistente_ia' end);

  -- ── El precio, sólo si hay cuenta con plan. Sin plan se mide igual con precio
  -- 0: el hecho de que hubo consumo es el dato que no se puede perder.
  if v_plan is not null then
    v_precio := coalesce(app.precio_de_metrica(v_plan, v_pais, v_moneda, v_metrica), 0);

    select coalesce(pm.cantidad_incluida, 0) into v_incluida
      from public.precio_metrica pm
     where pm.plan_id = v_plan and pm.pais = v_pais and pm.moneda = v_moneda
       and pm.metrica = v_metrica and pm.vigente_hasta is null
     limit 1;

    -- ⚠⚠ Se cuentan TODAS las del período, no sólo las cobradas. Contar sólo
    -- las cobradas deja el contador en cero para siempre y nunca se llega a
    -- cobrar la primera.
    if coalesce(v_incluida, 0) > 0 then
      select coalesce(sum(e.cantidad), 0) into v_ya
        from public.evento_medible e
       where e.cuenta_id = p_cuenta and e.periodo = v_periodo and e.tipo = p_tipo;
      if v_ya + p_cantidad <= v_incluida then
        v_cobrada := false;
      end if;
    end if;
  end if;

  -- ── El costo externo no depende de quién pague, sino de qué se consumió y
  -- adónde. Se resuelve igual con cuenta y sin cuenta.
  if v_concepto is not null then
    select c.costo, c.moneda into v_costo, v_mon_c
      from app.costo_de_concepto(v_concepto, p_proveedor, v_pais) c;
  end if;

  insert into public.evento_medible (
    cuenta_id, periodo, tipo, cantidad, unidad,
    participacion_id, instancia_id, circuito_id, proveedor_id, nivel_firma, detalle,
    pais, plan_id, moneda, precio_unitario, cobrada,
    modelo_economico, costo_externo, moneda_costo, clave_idempotencia)
  values (
    p_cuenta, v_periodo, p_tipo, p_cantidad, p_unidad,
    p_participacion, p_instancia, p_circuito, p_proveedor, p_nivel_firma, p_detalle,
    v_pais, v_plan, v_moneda, case when v_cobrada then v_precio else 0 end, v_cobrada,
    case when v_costo is not null then 'costo' else 'sin_costo' end,
    v_costo, v_mon_c, p_clave)
  on conflict (clave_idempotencia) do nothing
  returning id into v_id;

  return v_id;

exception when others then
  raise warning 'medir(%): no se pudo medir para la cuenta % (%): %', p_tipo, p_cuenta, sqlstate, sqlerrm;
  return null;
end $$;

revoke all on function app.medir(text, uuid, text, numeric, text, text, text, uuid, text, uuid, uuid, uuid, jsonb, char) from public;
grant execute on function app.medir(text, uuid, text, numeric, text, text, text, uuid, text, uuid, uuid, uuid, jsonb, char) to app_rw;

-- ⚠⚠ La firma de `app.medir` cambió: la versión de 13 parámetros de la 079 sigue
-- existiendo y sería la que resolvería una llamada vieja, con el país saliendo
-- siempre de la cuenta. Se tira para que no haya dos.
drop function if exists app.medir(text, uuid, text, numeric, text, text, text, uuid, text, uuid, uuid, uuid, jsonb);

-- =============================================================================
-- 4. LA PUERTA DE LOS MENSAJES
--
-- Reemplaza a `app.medir_sms` de la 079: un solo camino para los dos canales,
-- porque es el mismo mecanismo con distinto precio — igual que los tres modos de
-- firma son configuración y no caminos de código distintos.
-- =============================================================================
create or replace function app.medir_mensaje(
  p_canal      text,         -- 'sms' | 'whatsapp'
  p_cuenta     uuid,         -- NULL = de la plataforma, no se le cobra a nadie
  p_segmentos  int,
  -- ⚠ Se pasa el TELÉFONO, no el país: el país lo resuelve la base con el
  -- catálogo, así el código no tiene que saber ningún prefijo.
  p_telefono   text,
  p_clave      text,
  p_proposito  text default null
)
returns uuid
language sql security definer set search_path = pg_catalog, public
as $$
  select app.medir(
    p_tipo     => case when p_canal = 'whatsapp' then 'whatsapp' else 'sms' end,
    p_cuenta   => p_cuenta,
    p_clave    => p_clave,
    -- Un mensaje que Twilio no supo segmentar igual salió y igual se paga: el
    -- mínimo es uno.
    p_cantidad => greatest(coalesce(p_segmentos, 1), 1),
    p_unidad   => 'segmento',
    p_detalle  => jsonb_build_object('canal', p_canal,
                                     'pais_destino', app.pais_de_telefono(p_telefono),
                                     'segmentos', p_segmentos,
                                     'proposito', p_proposito),
    p_pais_sin_cuenta => app.pais_de_telefono(p_telefono));
$$;
revoke all on function app.medir_mensaje(text, uuid, int, text, text, text) from public;
grant execute on function app.medir_mensaje(text, uuid, int, text, text, text) to app_rw;

comment on function app.medir_mensaje(text, uuid, int, text, text, text) is
  'Anota un mensaje enviado, por SMS o WhatsApp, con sus SEGMENTOS. Con cuenta se le cobra '
  'a esa empresa; sin cuenta es consumo de la plataforma y no se le cobra a nadie (el SMS '
  'de entrar al producto). Migración 081.';

-- La de la 079 se va: tenía un solo canal y no aceptaba consumo sin dueño.
drop function if exists app.medir_sms(uuid, int, char, text);

-- =============================================================================
-- 5. EL WALLET NO TIENE A QUIÉN COBRARLE UN CONSUMO SIN DUEÑO
--
-- Sin esto, `app.modalidad_de_cuenta(null)` se ejecuta con NULL y el resultado
-- depende de cómo esté escrita esa función — que es exactamente la clase de cosa
-- que no se deja al azar cuando hay plata de por medio.
-- =============================================================================
create or replace function app.wallet_consumir()
returns trigger
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare m record; v_reserva uuid; v_monto numeric(14,4);
begin
  if new.cuenta_id is null then return new; end if;
  if not new.cobrada or new.precio_unitario <= 0 then return new; end if;
  begin
    select * into m from app.modalidad_de_cuenta(new.cuenta_id);
    if m.modalidad <> 'prepago' then return new; end if;

    -- ⚠ El total es precio × cantidad, no el precio. Con las firmas daba igual
    -- porque la cantidad era siempre 1; con tres segmentos de SMS, no.
    v_monto := new.precio_unitario * new.cantidad;

    select r.id into v_reserva
      from public.reserva_saldo r
     where r.estado = 'activa'
       and (r.circuito_id = new.circuito_id
            or r.circuito_id = (select i.circuito_id from public.instancia i
                                 where i.id = new.instancia_id))
     limit 1;

    insert into public.movimiento_saldo (cuenta_id, moneda, tipo, monto, reserva_id, evento_medible_id, creado_por)
    values (new.cuenta_id, new.moneda, 'consumo', -v_monto, v_reserva, new.id, new.tipo);

    if v_reserva is not null then
      insert into public.movimiento_saldo (cuenta_id, moneda, tipo, monto, reserva_id, evento_medible_id, creado_por)
      values (new.cuenta_id, new.moneda, 'liberacion', v_monto, v_reserva, new.id, new.tipo);
    end if;
  exception when others then
    raise warning 'wallet_consumir: no se pudo registrar el consumo de la línea % (%): %', new.id, sqlstate, sqlerrm;
  end;
  return new;
end $$;

-- =============================================================================
-- 6. CENTINELAS
-- =============================================================================
do $centinela$
declare v_mal int;
begin
  -- Ninguna línea existente puede violar el candado nuevo.
  select count(*) into v_mal from evento_medible
   where cuenta_id is null and (cobrada or precio_unitario <> 0);
  if v_mal > 0 then
    raise exception '% línea(s) sin dueño que igual se cobran', v_mal;
  end if;

  -- La firma de `app.medir` tiene que ser una sola: dos versiones conviviendo
  -- harían que una llamada vieja resolviera a la equivocada sin avisar.
  select count(*) into v_mal from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app' and p.proname = 'medir';
  if v_mal <> 1 then
    raise exception 'Quedaron % versiones de app.medir y tiene que haber una', v_mal;
  end if;

  select count(*) into v_mal from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app' and p.proname = 'medir_sms';
  if v_mal <> 0 then
    raise exception 'app.medir_sms sigue existiendo: la reemplaza app.medir_mensaje';
  end if;
end $centinela$;

commit;
