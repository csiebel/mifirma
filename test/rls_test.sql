-- =============================================================================
-- MiFirma — tests de autorización
-- Se corren como app_rw (NO como superusuario: el superusuario bypassa RLS).
-- =============================================================================

\set ON_ERROR_STOP on

-- Identificadores de la semilla. Van acá y no en la línea de comandos: un test
-- que sólo corre si alguien recuerda nueve `-v` es un test que no se corre.
\set cuenta_a    'aaaaaaaa-0000-0000-0000-000000000001'
\set cuenta_b    'bbbbbbbb-0000-0000-0000-000000000001'
\set ident_a     'a0000000-0000-0000-0000-000000000001'
\set ident_b     'b0000000-0000-0000-0000-000000000001'
\set ident_ext   'e0000000-0000-0000-0000-000000000001'
\set anclaje_a   'a1000000-0000-0000-0000-000000000001'
\set anclaje_b   'b1000000-0000-0000-0000-000000000001'
\set anclaje_ext 'e1000000-0000-0000-0000-000000000001'
\set otorg_ext   'a8000000-0000-0000-0000-000000000001'

-- ---------- TEST 1: contexto vacío no ve absolutamente nada ------------------
begin;
  do $$
  declare v int;
  begin
    -- sin setear ningún GUC
    select count(*) into v from cuenta;          if v <> 0 then raise exception 'FALLA T1: cuenta visible sin contexto (%)', v; end if;
    select count(*) into v from circuito;        if v <> 0 then raise exception 'FALLA T1: circuito visible sin contexto (%)', v; end if;
    select count(*) into v from instancia;       if v <> 0 then raise exception 'FALLA T1: instancia visible sin contexto (%)', v; end if;
    select count(*) into v from archivo;         if v <> 0 then raise exception 'FALLA T1: archivo visible sin contexto (%)', v; end if;
    select count(*) into v from otorgamiento;    if v <> 0 then raise exception 'FALLA T1: otorgamiento visible sin contexto (%)', v; end if;
    select count(*) into v from identidad;       if v <> 0 then raise exception 'FALLA T1: identidad visible sin contexto (%)', v; end if;
    select count(*) into v from participacion;   if v <> 0 then raise exception 'FALLA T1: participacion visible sin contexto (%)', v; end if;
    raise notice 'OK T1 — contexto vacío no ve nada';
  end $$;
rollback;

-- ---------- TEST 2: aislamiento entre cuentas --------------------------------
begin;
  set local app.actor = 'cuenta';
  set local app.cuenta_id = :'cuenta_a';
  set local app.identidad_id = :'ident_a';
  set local app.anclajes_probados = :'anclaje_a';
  set local app.nivel_garantia = 'bajo';

  do $$
  declare v int;
  begin
    select count(*) into v from circuito;
    if v <> 1 then raise exception 'FALLA T2: la cuenta A debería ver 1 circuito propio, ve %', v; end if;
    raise notice 'OK T2 — la cuenta A ve su circuito';
  end $$;
rollback;

begin;
  set local app.actor = 'cuenta';
  set local app.cuenta_id = :'cuenta_b';
  set local app.identidad_id = :'ident_b';
  set local app.anclajes_probados = :'anclaje_b';
  set local app.nivel_garantia = 'bajo';

  do $$
  declare v int;
  begin
    select count(*) into v from circuito;
    if v <> 0 then raise exception 'FALLA T2: la cuenta B NO debería ver circuitos de A, ve %', v; end if;
    select count(*) into v from archivo;
    if v <> 0 then raise exception 'FALLA T2: la cuenta B NO debería ver archivos de A, ve %', v; end if;
    raise notice 'OK T2 — la cuenta B no ve nada de A';
  end $$;
rollback;

-- ---------- TEST 3: el firmante externo ve SOLO su otorgamiento --------------
begin;
  set local app.actor = 'externo';
  set local app.identidad_id = :'ident_ext';
  set local app.otorgamiento_id = :'otorg_ext';

  do $$
  declare v int;
  begin
    select count(*) into v from instancia;
    if v <> 1 then raise exception 'FALLA T3: el externo debería ver exactamente 1 instancia, ve %', v; end if;
    select count(*) into v from circuito;
    if v <> 0 then raise exception 'FALLA T3: el externo NO debería ver el circuito, ve %', v; end if;
    raise notice 'OK T3 — el externo ve solo su instancia';
  end $$;
rollback;

-- ---------- TEST 4: externo con otro otorgamiento_id no ve nada -------------
begin;
  set local app.actor = 'externo';
  set local app.identidad_id = :'ident_ext';
  set local app.otorgamiento_id = '00000000-0000-0000-0000-000000000000';

  do $$
  declare v int;
  begin
    select count(*) into v from instancia;
    if v <> 0 then raise exception 'FALLA T4: con otorgamiento inválido no debería ver nada, ve %', v; end if;
    raise notice 'OK T4 — otorgamiento inválido no da acceso';
  end $$;
rollback;

-- ---------- TEST 5: el firmante ve sus instancias por otorgamiento ----------
-- María pertenece a la cuenta B pero tiene dos otorgamientos sobre documentos
-- de la cuenta A: uno vigente sobre la instancia 1 y el irrevocable de la
-- instancia 2 que se emitió al firmar. Debe ver las dos, y ninguna otra.
begin;
  set local app.actor = 'cuenta';
  set local app.cuenta_id = :'cuenta_b';
  set local app.identidad_id = :'ident_ext';
  set local app.anclajes_probados = :'anclaje_ext';
  set local app.nivel_garantia = 'bajo';

  do $$
  declare v int;
  begin
    select count(*) into v from instancia;
    if v <> 2 then raise exception 'FALLA T5: el firmante debería ver 2 instancias por otorgamiento, ve %', v; end if;
    -- pero NO el circuito ni el archivo base, sobre los que no tiene otorgamiento
    select count(*) into v from circuito;
    if v <> 0 then raise exception 'FALLA T5: el firmante no debería ver el circuito, ve %', v; end if;
    raise notice 'OK T5 — el otorgamiento cruza la frontera de cuenta, y solo hasta donde alcanza';
  end $$;
rollback;

-- ---------- TEST 6: sin anclaje probado, el otorgamiento no vale ------------
begin;
  set local app.actor = 'cuenta';
  set local app.cuenta_id = :'cuenta_b';
  set local app.identidad_id = :'ident_ext';
  -- sin app.anclajes_probados
  set local app.nivel_garantia = 'bajo';

  do $$
  declare v int;
  begin
    select count(*) into v from instancia;
    if v <> 0 then raise exception 'FALLA T6: sin anclaje probado no debería ver nada, ve %', v; end if;
    raise notice 'OK T6 — registrarse no alcanza: hay que probar el anclaje';
  end $$;
rollback;

-- ---------- TEST 7: SET LOCAL no sobrevive a la transacción -----------------
begin;
  set local app.actor = 'cuenta';
  set local app.cuenta_id = :'cuenta_a';
commit;

do $$
begin
  if app.actor() <> 'anonimo' then
    raise exception 'FALLA T7: el contexto sobrevivió a la transacción (actor=%)', app.actor();
  end if;
  if app.cuenta_actual() is not null then
    raise exception 'FALLA T7: cuenta_id sobrevivió a la transacción';
  end if;
  raise notice 'OK T7 — SET LOCAL no filtra entre transacciones';
end $$;

-- ---------- TEST 8: el otorgamiento irrevocable no se puede revocar ---------
-- Hay DOS defensas: la política de UPDATE excluye las filas irrevocables (el
-- UPDATE no las alcanza y afecta 0 filas, sin excepción), y si alguna llegara
-- al trigger, éste la rechaza. Se verifica el EFECTO, no la excepción.
begin;
  set local app.actor = 'sistema';
  do $$
  declare v_afectadas int; v_revocados int;
  begin
    update otorgamiento set revocado_en = now() where irrevocable;
    get diagnostics v_afectadas = row_count;
    select count(*) into v_revocados from otorgamiento where irrevocable and revocado_en is not null;
    if v_afectadas <> 0 or v_revocados <> 0 then
      raise exception 'FALLA T8: se revocó un otorgamiento irrevocable (afectadas=%, revocados=%)',
        v_afectadas, v_revocados;
    end if;
    raise notice 'OK T8 — el irrevocable no se puede revocar (la política lo excluye del UPDATE)';
  end $$;
rollback;


-- ---------- TEST 11: la plata no cruza cuentas --------------------------------
-- Distinto de T2: acá no hay otorgamiento que valga. Un documento puede cruzar
-- de la cuenta A a un firmante de la B; una factura, jamás.
begin;
  set local app.actor = 'cuenta';
  set local app.cuenta_id = :'cuenta_b';
  set local app.identidad_id = :'ident_b';
  set local app.anclajes_probados = :'anclaje_b';
  set local app.nivel_garantia = 'bajo';

  do $$
  declare v int;
  begin
    select count(*) into v from factura_plataforma;
      if v <> 0 then raise exception 'FALLA T11: B ve facturas de A (%)', v; end if;
    select count(*) into v from factura_linea;
      if v <> 0 then raise exception 'FALLA T11: B ve líneas de factura de A (%)', v; end if;
    select count(*) into v from suscripcion;
      if v <> 0 then raise exception 'FALLA T11: B ve la suscripción de A (%)', v; end if;
    select count(*) into v from medio_pago;
      if v <> 0 then raise exception 'FALLA T11: B ve el medio de pago de A (%)', v; end if;
    raise notice 'OK T11 — la facturación no cruza cuentas';
  end $$;
rollback;

-- ---------- TEST 12: el firmante externo no ve nada de billing ----------------
-- Su otorgamiento le da acceso a UN documento. No lo convierte en cliente.
begin;
  set local app.actor = 'externo';
  set local app.identidad_id = :'ident_ext';
  set local app.otorgamiento_id = :'otorg_ext';
  set local app.anclajes_probados = :'anclaje_ext';
  set local app.nivel_garantia = 'bajo';

  do $$
  declare v int;
  begin
    select count(*) into v from instancia;
      if v <> 1 then raise exception 'FALLA T12: el externo debería ver 1 instancia, ve %', v; end if;
    select count(*) into v from factura_plataforma;
      if v <> 0 then raise exception 'FALLA T12: el externo ve facturas (%)', v; end if;
    select count(*) into v from medio_pago;
      if v <> 0 then raise exception 'FALLA T12: el externo ve medios de pago (%)', v; end if;
    select count(*) into v from suscripcion;
      if v <> 0 then raise exception 'FALLA T12: el externo ve suscripciones (%)', v; end if;
    raise notice 'OK T12 — el otorgamiento da acceso a un documento, no a la cuenta';
  end $$;
rollback;

-- ---------- TEST 13: sin capacidad de facturación no se ve la factura ---------
-- La cuenta correcta no alcanza: dentro de la cuenta A, quien no tiene la
-- capacidad `facturacion.leer` tampoco ve la factura de su propia empresa.
begin;
  set local app.actor = 'cuenta';
  set local app.cuenta_id = :'cuenta_a';
  set local app.identidad_id = :'ident_a';
  set local app.anclajes_probados = :'anclaje_a';
  set local app.nivel_garantia = 'bajo';

  do $$
  declare v int;
  begin
    if app.tiene_capacidad('facturacion','leer') then
      raise exception 'FALLA T13: la semilla le dio la capacidad a Ana; el test no prueba nada';
    end if;
    select count(*) into v from factura_plataforma;
      if v <> 0 then raise exception 'FALLA T13: sin capacidad ve la factura (%)', v; end if;
    raise notice 'OK T13 — la capacidad de facturación se verifica en la capa de datos';
  end $$;
rollback;
