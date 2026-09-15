-- =============================================================================
-- ejerce/081_mensajes_y_consumos_sin_dueno.sql
--
-- Lo que hay que probar, y todo es plata:
--
--   1. Que un mensaje SIN cuenta se anote igual, con su costo, y que NO se
--      cobre: es el SMS de entrar al producto, decisión de Claudio del 15/9.
--   2. Que una línea sin dueño NO PUEDA estar cobrada. Es el candado que hace
--      que abrir `cuenta_id` a NULL no sea una puerta para que un consumo
--      cobrable desaparezca de toda factura.
--   3. Que una FIRMA sin dueño no entre nunca: una firma la emite alguien.
--   4. Que WhatsApp y SMS sean conceptos DISTINTOS, con precios distintos.
--   5. Que el saldo no se mueva por un consumo sin dueño (no hay a quién
--      cobrarle) y sí por uno con dueño.
--   6. Que una cuenta NO VEA las líneas de plataforma, y el operador sí.
--   7. Que quede UNA sola versión de `app.medir` y que `app.medir_sms` ya no
--      exista.
--
-- ⚠⚠ `app.medir()` NUNCA LANZA: ningún caso se da por bueno porque «no tiró
-- error». Todos miran EL CONTENIDO DE LA FILA.
--
-- ⚠ Con `is distinct from` siempre.
-- =============================================================================

\set ON_ERROR_STOP on

do $cinturon$ begin
  if to_regclass('public.banco_de_pruebas') is null then
    raise exception 'ABORTADO: esto no es el banco de pruebas.';
  end if;
end $cinturon$;

begin;

-- ── 0. El escenario ─────────────────────────────────────────────────────────
insert into plan (id, codigo, nombre_i18n) values
  ('e8100000-0000-0000-0000-0000000000f1', 'ej81_plan', '{"es":"Plan del ejerce 81"}'::jsonb)
on conflict do nothing;

insert into suscripcion (cuenta_id, plan_id, moneda)
values ('22222222-2222-2222-2222-222222222222', 'e8100000-0000-0000-0000-0000000000f1', 'UYU')
on conflict do nothing;

-- ⚠ Precios DISTINTOS a propósito: si el código tratara los dos canales como uno
-- solo, el precio saldría igual y el caso 4 lo delata.
insert into precio_metrica (plan_id, pais, moneda, metrica, precio_unitario) values
  ('e8100000-0000-0000-0000-0000000000f1', 'UY', 'UYU', 'sms', 3.0000),
  ('e8100000-0000-0000-0000-0000000000f1', 'UY', 'UYU', 'whatsapp', 7.0000)
on conflict do nothing;

insert into tarifa_costo (concepto, pais, moneda, costo_unitario) values
  ('sms', 'UY', 'USD', 0.045000),
  ('whatsapp', 'UY', 'USD', 0.005000)
on conflict do nothing;

insert into billing_config (cuenta_id, modalidad, metrica, modelo_comision, margen_pct)
values ('22222222-2222-2222-2222-222222222222', 'prepago', 'firma', 'margen_pct', 10.000)
on conflict do nothing;

-- ═══ 1. Un mensaje SIN cuenta se mide, con su costo, y no se cobra ══════════
do $sin_dueno$
declare v_id uuid; r record;
begin
  select app.medir_mensaje('sms', null, 2, '+59899123456', 'ej81:entrar:uno', 'entrar') into v_id;
  if v_id is null then
    raise exception '1. ⚠⚠ El SMS de entrar no dejó línea: se pierde lo que nos está costando';
  end if;

  select * into r from evento_medible where id = v_id;
  if r.cuenta_id is not null then raise exception '1. Salió con dueño y no tiene'; end if;
  if r.cobrada is distinct from false then
    raise exception '1. ⚠⚠ Se cobró un SMS de entrar, que por decisión del 15/9 es costo nuestro';
  end if;
  if r.precio_unitario is distinct from 0::numeric then
    raise exception '1. Precio % en una línea sin dueño', r.precio_unitario;
  end if;
  if r.cantidad is distinct from 2::numeric then
    raise exception '1. Se midieron % segmentos y fueron 2', r.cantidad;
  end if;
  -- ⚠ El costo SÍ tiene que estar: es lo que nos cuesta, y no depende de quién
  -- pague. Si no se anotara, medir un consumo sin dueño no serviría para nada.
  if r.costo_externo is distinct from 0.045000::numeric then
    raise exception '1. ⚠⚠ La línea sin dueño salió sin costo (%): entonces no dice cuánto nos cuesta', r.costo_externo;
  end if;
  if r.pais is distinct from 'UY'::char(2) then
    raise exception '1. El país no es el del destino: %', r.pais;
  end if;
  if (r.detalle ->> 'proposito') is distinct from 'entrar' then
    raise exception '1. El detalle perdió el propósito';
  end if;
  if (r.detalle ->> 'pais_destino') is distinct from 'UY' then
    raise exception '1. El país del destino no se resolvió desde el teléfono: %', r.detalle ->> 'pais_destino';
  end if;
end $sin_dueno$;

-- ═══ 2. Una línea sin dueño NO PUEDE estar cobrada ══════════════════════════
--
-- ⚠⚠ Es el candado que justifica haber abierto `cuenta_id` a NULL. Sin él,
-- cualquier consumo cobrable podría escribirse sin cliente y no aparecer jamás
-- en una factura, sin que nada proteste.
do $candado$
declare v_ok boolean := false;
begin
  begin
    insert into evento_medible (cuenta_id, periodo, tipo, pais, moneda,
                                precio_unitario, cobrada, clave_idempotencia)
    values (null, to_char(now(), 'YYYY-MM'), 'sms', 'UY', 'UYU', 5, true, 'ej81:cobrada_sin_dueno');
  exception when others then v_ok := true; end;
  if not v_ok then
    raise exception '2. ⚠⚠ Entró una línea SIN DUEÑO que igual se cobra: eso es plata que no aparece en ninguna factura';
  end if;

  -- Y con precio pero sin cobrar, tampoco: el precio de algo que nadie paga es
  -- una cifra que después alguien va a sumar.
  v_ok := false;
  begin
    insert into evento_medible (cuenta_id, periodo, tipo, pais, moneda,
                                precio_unitario, cobrada, clave_idempotencia)
    values (null, to_char(now(), 'YYYY-MM'), 'sms', 'UY', 'UYU', 5, false, 'ej81:precio_sin_dueno');
  exception when others then v_ok := true; end;
  if not v_ok then
    raise exception '2. Entró una línea sin dueño con precio';
  end if;
end $candado$;

-- ═══ 3. Una FIRMA sin dueño no existe ═══════════════════════════════════════
do $firma_sin_dueno$
declare v_ok boolean := false;
begin
  begin
    insert into evento_medible (cuenta_id, periodo, tipo, pais, moneda, nivel_firma,
                                precio_unitario, cobrada, clave_idempotencia)
    values (null, to_char(now(), 'YYYY-MM'), 'firma', 'UY', 'UYU', 'simple', 0, false, 'ej81:firma_sin_dueno');
  exception when others then v_ok := true; end;
  if not v_ok then
    raise exception '3. ⚠⚠ Entró una firma sin emisor: toda firma la emite alguien, y ese alguien es quien paga';
  end if;
end $firma_sin_dueno$;

-- ═══ 4. WhatsApp y SMS son conceptos distintos ══════════════════════════════
do $canales$
declare v_sms uuid; v_wa uuid; r_sms record; r_wa record;
begin
  select app.medir_mensaje('sms', '22222222-2222-2222-2222-222222222222', 1, '+59899123456', 'ej81:sms') into v_sms;
  select app.medir_mensaje('whatsapp', '22222222-2222-2222-2222-222222222222', 1, '+59899123456', 'ej81:wa') into v_wa;

  select * into r_sms from evento_medible where id = v_sms;
  select * into r_wa  from evento_medible where id = v_wa;

  if r_sms.tipo is distinct from 'sms' then raise exception '4. El SMS salió como %', r_sms.tipo; end if;
  if r_wa.tipo is distinct from 'whatsapp' then
    raise exception '4. ⚠⚠ El WhatsApp salió como «%»: los dos canales se están mezclando', r_wa.tipo;
  end if;

  if r_sms.precio_unitario is distinct from 3.0000 then
    raise exception '4. El SMS se cobró a % y la lista dice 3', r_sms.precio_unitario;
  end if;
  if r_wa.precio_unitario is distinct from 7.0000 then
    raise exception '4. ⚠⚠ El WhatsApp se cobró a % y la lista dice 7: está tomando el precio del otro canal', r_wa.precio_unitario;
  end if;

  -- Y los costos, que es de donde salió la decisión de separarlos.
  if r_sms.costo_externo is distinct from 0.045000::numeric
     or r_wa.costo_externo is distinct from 0.005000::numeric then
    raise exception '4. Los costos externos no son los de cada canal: sms=% wa=%',
      r_sms.costo_externo, r_wa.costo_externo;
  end if;

  if (r_wa.detalle ->> 'canal') is distinct from 'whatsapp' then
    raise exception '4. El detalle perdió el canal';
  end if;
end $canales$;

-- ═══ 5. El saldo: sin dueño no se mueve; con dueño sí ═══════════════════════
do $saldo$
declare v_sin uuid; v_con uuid; v_n int; v_monto numeric;
begin
  select app.medir_mensaje('sms', null, 3, '+5514999887766', 'ej81:saldo:sin') into v_sin;
  select count(*) into v_n from movimiento_saldo where evento_medible_id = v_sin;
  if v_n <> 0 then
    raise exception '5. ⚠⚠ Un consumo sin dueño movió el saldo % vez/veces, y no hay a quién cobrarle', v_n;
  end if;

  select app.medir_mensaje('whatsapp', '22222222-2222-2222-2222-222222222222', 2, '+59899123456', 'ej81:saldo:con') into v_con;
  select sum(-monto) into v_monto from movimiento_saldo
   where evento_medible_id = v_con and tipo = 'consumo';
  if v_monto is distinct from 14.0000 then
    raise exception '5. El saldo descontó % y dos segmentos de WhatsApp a 7 son 14', v_monto;
  end if;
end $saldo$;

-- ═══ 6. Una cuenta no ve las líneas de plataforma ═══════════════════════════
--
-- ⚠ La política compara `cuenta_id = app.cuenta_actual()`, y NULL nunca es igual
-- a nada. Funciona sola, pero se prueba: es la clase de cosa que alguien
-- «arregla» un día por creer que es un olvido.
do $rls$
declare v_cuenta int; v_operador int;
begin
  set local role app_rw;
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
  select count(*) into v_cuenta from evento_medible where cuenta_id is null;
  reset role;

  if v_cuenta <> 0 then
    raise exception '6. ⚠⚠ Una cuenta ve % línea(s) de consumo de la plataforma', v_cuenta;
  end if;

  select count(*) into v_operador from evento_medible where cuenta_id is null;
  if v_operador = 0 then
    raise exception '6. Ni el dueño ve las líneas de plataforma: entonces medirlas no sirve de nada';
  end if;
end $rls$;

-- ═══ 7. Una sola versión de medir, y medir_sms ya no existe ═════════════════
do $firmas$
declare v_n int;
begin
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app' and p.proname = 'medir';
  if v_n <> 1 then
    raise exception '7. ⚠⚠ Hay % versiones de app.medir: una llamada vieja resolvería a la equivocada sin avisar', v_n;
  end if;

  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app' and p.proname = 'medir_sms';
  if v_n <> 0 then
    raise exception '7. app.medir_sms sigue existiendo y la reemplaza app.medir_mensaje';
  end if;
end $firmas$;

-- ═══ 8. El país del destino sale del teléfono, y gana el prefijo más largo ══
do $prefijos$
declare v_id uuid; r record; v_uy char(2); v_br char(2); v_nada char(2);
begin
  -- Lo básico: cada teléfono a su país.
  select app.pais_de_telefono('+598 99 123 456') into v_uy;
  select app.pais_de_telefono('+5514999887766') into v_br;
  if v_uy is distinct from 'UY'::char(2) then raise exception '8. +598 dio % y es UY', v_uy; end if;
  if v_br is distinct from 'BR'::char(2) then raise exception '8. +55 dio % y es BR', v_br; end if;

  -- Un país que no está en el catálogo no rompe nada: el mensaje se mide igual,
  -- sin país, porque el hecho de que salió es el dato que no se puede perder.
  select app.pais_de_telefono('+34600111222') into v_nada;
  if v_nada is not null then raise exception '8. Un país que no está en el catálogo dio %', v_nada; end if;

  select app.medir_mensaje('sms', null, 1, '+34600111222', 'ej81:sin_pais') into v_id;
  if v_id is null then
    raise exception '8. ⚠⚠ Un mensaje a un país sin catálogo no se midió: salió y se pagó igual';
  end if;

  -- ⚠⚠ Y el que importa: con dos prefijos donde uno empieza igual que el otro,
  -- tiene que ganar el LARGO. Si gana el corto, todo el Caribe se costea como
  -- Estados Unidos y nadie lo nota hasta que llega la factura de Twilio.
  insert into pais (codigo, nombre_i18n, prefijo_telefonico)
  values ('US', '{"es":"Estados Unidos"}'::jsonb, '1') on conflict (codigo) do update set prefijo_telefonico = '1';
  insert into pais (codigo, nombre_i18n, prefijo_telefonico)
  values ('BS', '{"es":"Bahamas"}'::jsonb, '1242') on conflict (codigo) do update set prefijo_telefonico = '1242';

  if app.pais_de_telefono('+12425551234') is distinct from 'BS'::char(2) then
    raise exception '8. ⚠⚠ +1242 se resolvió como %, no como Bahamas: gana el prefijo corto y el costo sale equivocado',
      app.pais_de_telefono('+12425551234');
  end if;
  if app.pais_de_telefono('+15551234567') is distinct from 'US'::char(2) then
    raise exception '8. +1 dejó de resolver a Estados Unidos';
  end if;
end $prefijos$;

-- ═══ ⚠ EL SABOTAJE QUE NO SE PUEDE AISLAR, Y POR QUÉ ═══════════════════════
--
-- `app.wallet_consumir()` arranca con `if new.cuenta_id is null then return new`.
-- Quitarlo NO rompe ningún caso de acá, y se midió por qué en vez de suponerlo:
--
--   · El candado `medible_sin_dueno_no_se_cobra` OBLIGA a que toda línea sin
--     dueño tenga `cobrada = false` y `precio_unitario = 0`.
--   · El trigger sale en su PRIMERA línea con cualquiera de esas dos cosas,
--     antes de llegar a mirar la cuenta.
--
-- O sea: el corte está protegido por accidente por el candado, y hoy es
-- inalcanzable. **No se saca igual**, por dos razones: el día que alguien afloje
-- el candado —por ejemplo para permitir una línea sin dueño con precio
-- informativo— el wallet intentaría cobrarle a NULL; y medido el 15/9,
-- `app.modalidad_de_cuenta(null)` devuelve «pospago por omisión», así que ni
-- siquiera fallaría: descartaría el consumo en silencio, que es peor.
--
-- ⚠ Es la lección vieja de la casa: UNA PROTECCIÓN PUEDE ESTAR PROTEGIDA POR
-- ACCIDENTE POR OTRA. Queda escrito para que nadie lo saque creyendo que sobra,
-- ni lo cuente como probado.

do $listo$ begin
  raise notice '✓ 081: los mensajes se miden por canal, y lo que no tiene dueño se mide sin cobrarse.';
end $listo$;

rollback;
