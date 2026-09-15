-- =============================================================================
-- ejerce/082_los_topes_por_plan.sql
--
-- Lo que hay que probar, y todo es plata o es alguien que se queda afuera:
--
--   1. Sin tope configurado NO SE LIMITA NADA. Es lo que protege a los clientes
--      que ya están de quedarse sin servicio porque apareció una tabla.
--   2. Las TRES NATURALEZAS: usuarios es una foto, las firmas son caudal del mes,
--      el disco es un depósito. Medir una como la otra rompe el tope entero.
--   3. `frenar` impide AGREGAR y NO TOCA lo que ya existe — incluso cuando el
--      cliente ya estaba por encima porque le bajaron el plan (decisión de
--      Claudio del 15/9).
--   4. `cobrar_excedente` deja pasar y dice cuánto, por unidad y por bloque.
--   5. `avisar` deja pasar sin cobrar.
--   6. El override de la CUENTA gana sobre el del plan.
--   7. El aviso salta ANTES de llegar, no después.
--   8. El tope de usuarios distingue POR ROL.
--   9. El disco toma el número de `plan_custodia` y el comportamiento de acá.
--  10. Una cuenta no puede escribirse su propio tope.
--
-- ⚠ `control_de_tope` DEVUELVE, no lanza: ningún caso se da por bueno porque no
-- hubo error. Todos miran lo que devuelve.
--
-- ⚠ Con `is distinct from` siempre.
-- =============================================================================

\set ON_ERROR_STOP on

do $cinturon$ begin
  if to_regclass('public.banco_de_pruebas') is null then
    raise exception 'ABORTADO: esto no es el banco de pruebas.';
  end if;
  if to_regclass('public.plan_tope') is null then
    raise exception 'ABORTADO: no existe plan_tope; la 082 no corrió.';
  end if;
end $cinturon$;

begin;

-- ── 0. El escenario ─────────────────────────────────────────────────────────
insert into plan (id, codigo, nombre_i18n) values
  ('e8200000-0000-0000-0000-0000000000f1', 'ej82_plan', '{"es":"Plan del ejerce 82"}'::jsonb)
on conflict do nothing;

insert into suscripcion (cuenta_id, plan_id, moneda)
values ('22222222-2222-2222-2222-222222222222', 'e8200000-0000-0000-0000-0000000000f1', 'UYU')
on conflict do nothing;

-- ⚠⚠ GENTE DE VERDAD, Y NO ES DECORADO. El banco viene con CERO usuarios, y con
-- cero cualquier forma de contarlos da lo mismo: un caso que compare 0 contra 0
-- pasa en verde aunque la función esté contando cualquier cosa. Se comprobó con
-- un sabotaje —contar usuarios como si fueran consumos del mes— que NO se
-- detectaba hasta que hubo personas en la tabla.
--
-- Tres personas: dos administradoras y una lectora. Los números no son redondos
-- a propósito, para que un tope que mire el total no se pueda confundir con uno
-- que mire un rol.
insert into identidad (id, email_normalizado, email_mostrado, estado) values
  ('e8200000-0000-0000-0000-00000000a001', 'ej82.admin1@ejemplo.test', 'ej82.admin1@ejemplo.test', 'activa'),
  ('e8200000-0000-0000-0000-00000000a002', 'ej82.admin2@ejemplo.test', 'ej82.admin2@ejemplo.test', 'activa'),
  ('e8200000-0000-0000-0000-00000000a003', 'ej82.lector@ejemplo.test', 'ej82.lector@ejemplo.test', 'activa')
on conflict do nothing;

insert into rol (id, cuenta_id, codigo, nombre_i18n, sistema) values
  ('e8200000-0000-0000-0000-0000000000b1', '22222222-2222-2222-2222-222222222222', 'admin',  '{"es":"Administrador"}'::jsonb, true),
  ('e8200000-0000-0000-0000-0000000000b2', '22222222-2222-2222-2222-222222222222', 'lector', '{"es":"Lector"}'::jsonb, false)
on conflict do nothing;

insert into usuario_rol (identidad_id, cuenta_id, rol_id) values
  ('e8200000-0000-0000-0000-00000000a001', '22222222-2222-2222-2222-222222222222', 'e8200000-0000-0000-0000-0000000000b1'),
  ('e8200000-0000-0000-0000-00000000a002', '22222222-2222-2222-2222-222222222222', 'e8200000-0000-0000-0000-0000000000b1'),
  ('e8200000-0000-0000-0000-00000000a003', '22222222-2222-2222-2222-222222222222', 'e8200000-0000-0000-0000-0000000000b2')
on conflict do nothing;

-- ═══ 1. Sin tope configurado no se limita nada ══════════════════════════════
--
-- ⚠⚠ Este caso primero y a propósito: si esto fallara, el día que la migración
-- entre en producción todos los clientes actuales se quedarían sin poder hacer
-- nada. Es el que más daño haría.
do $sin_tope$
declare r record;
begin
  select * into r from app.control_de_tope('22222222-2222-2222-2222-222222222222', 'firma', 1);
  if r.permitido is distinct from true then
    raise exception '1. ⚠⚠ Sin tope configurado se frenó: todos los clientes actuales quedarían sin servicio';
  end if;
  if r.motivo is distinct from 'sin_tope' then raise exception '1. Motivo %', r.motivo; end if;
  if r.tope is not null then raise exception '1. Devolvió un tope y no hay ninguno'; end if;
end $sin_tope$;

-- ═══ 2. Las tres naturalezas ════════════════════════════════════════════════
do $naturalezas$
declare v_usuarios numeric; v_firmas numeric; v_disco numeric; v_n int;
begin
  -- FOTO: los usuarios se cuentan AHORA, no se suman por mes.
  select count(distinct identidad_id) into v_n from usuario_rol
   where cuenta_id = '22222222-2222-2222-2222-222222222222';
  -- ⚠ Sin gente, este caso no prueba nada: 0 = 0 con cualquier forma de contar.
  if v_n < 3 then raise exception '2. El escenario no armó los usuarios: hay %', v_n; end if;

  select app.uso_de('22222222-2222-2222-2222-222222222222', 'usuarios') into v_usuarios;
  if v_usuarios is distinct from v_n::numeric then
    raise exception '2. ⚠⚠ Los usuarios dan % y en la base hay %: no se están contando como una foto', v_usuarios, v_n;
  end if;
  -- Y por rol tiene que dar MENOS que el total, o no está mirando el rol.
  if app.uso_de('22222222-2222-2222-2222-222222222222', 'usuarios', 'admin') is distinct from 2::numeric then
    raise exception '2. ⚠ Los administradores dan % y son 2',
      app.uso_de('22222222-2222-2222-2222-222222222222', 'usuarios', 'admin');
  end if;

  -- CAUDAL: una firma medida en el período cuenta; una de otro período no.
  perform app.medir('firma', '22222222-2222-2222-2222-222222222222', 'ej82:f1', 1,
                    'unidad', null, null, null, 'simple');
  select app.uso_de('22222222-2222-2222-2222-222222222222', 'firma') into v_firmas;
  if v_firmas < 1 then raise exception '2. La firma del período no cuenta como uso'; end if;

  -- ⚠ Una línea de OTRO período no puede contar: si contara, el tope nunca se
  -- reiniciaría y el cliente quedaría trabado para siempre.
  insert into evento_medible (cuenta_id, periodo, tipo, nivel_firma, pais, moneda,
                              precio_unitario, cobrada, cantidad, clave_idempotencia)
  values ('22222222-2222-2222-2222-222222222222', '2020-01', 'firma', 'simple', 'UY', 'UYU',
          0, false, 500, 'ej82:vieja');
  if app.uso_de('22222222-2222-2222-2222-222222222222', 'firma') is distinct from v_firmas then
    raise exception '2. ⚠⚠ Una firma de otro período cuenta como uso de este mes: el caudal no se reinicia';
  end if;

  -- DEPÓSITO: sale de lo GUARDADO, no de lo consumido en el mes.
  --
  -- ⚠⚠ Se compara contra `custodia_usada` y se exige que haya algo. Con cero
  -- documentos este caso no prueba nada: medir el disco como si fuera un caudal
  -- del mes también da cero, y pasa en verde. Se comprobó con el sabotaje.
  select u.documentos into v_n from app.custodia_usada('22222222-2222-2222-2222-222222222222') u;
  if v_n < 1 then raise exception '2. El banco no tiene documentos guardados: el caso del disco no probaría nada'; end if;

  select app.uso_de('22222222-2222-2222-2222-222222222222', 'almacenamiento_documentos') into v_disco;
  if v_disco is distinct from v_n::numeric then
    raise exception '2. ⚠⚠ El disco da % y hay % documentos guardados: se está midiendo como un caudal del mes en vez de como un depósito', v_disco, v_n;
  end if;
end $naturalezas$;

-- ═══ 3. `frenar` impide agregar y no toca lo que ya existe ══════════════════
--
-- ⚠⚠ Este caso se construye con SMS y no con usuarios, y la razón importa: el
-- banco tiene CERO usuarios, así que un caso apoyado en «los que ya hay» no
-- podría distinguir «justo en el tope» de «por encima del tope» — los dos serían
-- cero. Un caso de prueba que depende de lo que el banco traiga no prueba lo que
-- dice que prueba. (Misma lección del ejerce de la 079, con otra cara.)
do $frenar$
declare r record; v_uso numeric;
begin
  -- Cinco SMS medidos, que es un uso que controlamos nosotros.
  for i in 1..5 loop
    perform app.medir('sms', '22222222-2222-2222-2222-222222222222', 'ej82:sms:' || i::text, 1);
  end loop;
  select app.uso_de('22222222-2222-2222-2222-222222222222', 'sms') into v_uso;
  if v_uso < 5 then raise exception '3. El escenario no quedó armado: uso %', v_uso; end if;

  -- ── Justo EN el tope: llegó al límite usando lo suyo.
  insert into plan_tope (plan_id, concepto, tope, al_llegar)
  values ('e8200000-0000-0000-0000-0000000000f1', 'sms', v_uso, 'frenar');

  select * into r from app.control_de_tope('22222222-2222-2222-2222-222222222222', 'sms', 1);
  if r.permitido is distinct from false then
    raise exception '3. Dejó pasar estando justo en el tope';
  end if;
  if r.motivo is distinct from 'tope_alcanzado' then
    raise exception '3. ⚠ Estar JUSTO en el tope dio «%»: llegar al límite usando lo propio no es lo mismo que haber quedado por encima', r.motivo;
  end if;

  -- ── POR ENCIMA del tope, que es la decisión de Claudio: le bajaron el plan y
  -- quedó arriba sin hacer nada. No puede agregar, pero lo que hay sigue.
  update plan_tope set tope = v_uso - 2
   where plan_id = 'e8200000-0000-0000-0000-0000000000f1' and concepto = 'sms';

  select * into r from app.control_de_tope('22222222-2222-2222-2222-222222222222', 'sms', 1);
  if r.permitido is distinct from false then
    raise exception '3. Dejó agregar estando ya por encima del tope';
  end if;
  if r.motivo is distinct from 'ya_estaba_por_encima' then
    raise exception '3. ⚠⚠ El motivo es «%» y tendría que distinguir que ya estaba por encima: al cliente que le bajaron el plan hay que decirle otra cosa que al que se pasó usando', r.motivo;
  end if;

  -- ⚠⚠ Y lo que ya existe sigue existiendo: preguntar por el tope no le quita
  -- nada a nadie. Es la decisión 3 y es lo que impide que un cambio de plan deje
  -- gente afuera de un día para el otro.
  if app.uso_de('22222222-2222-2222-2222-222222222222', 'sms') is distinct from v_uso then
    raise exception '3. ⚠⚠ Consultar el tope cambió el uso: frenar NO puede quitar lo que ya existe';
  end if;

  delete from plan_tope where plan_id = 'e8200000-0000-0000-0000-0000000000f1' and concepto = 'sms';
end $frenar$;

-- ═══ 4 a 7. Todo lo que sigue fija su tope RELATIVO AL USO QUE YA HAY ═══════
--
-- ⚠⚠ Y eso no es un detalle de estilo. El primer intento de estos casos ponía
-- «tope 10» a secas, suponiendo que el uso arrancaba en cero — y el caso 3, más
-- arriba, ya había medido cinco SMS. El excedente daba 8 donde se esperaban 3.
--
-- Es la misma lección que el ejerce de la 079 ya había dejado escrita: un caso
-- que depende de lo que hicieron los casos anteriores no prueba lo que dice que
-- prueba. Volvió a pasar, así que queda dicho más fuerte: **el tope se calcula
-- desde el uso, nunca se escribe a mano.**

-- ═══ 4. `cobrar_excedente`, por unidad y por bloque ═════════════════════════
do $excedente$
declare r record; v_uso numeric;
begin
  select app.uso_de('22222222-2222-2222-2222-222222222222', 'sms') into v_uso;

  -- Tope justo donde está: pedir 3 más son 3 de excedente, venga de donde venga.
  insert into plan_tope (plan_id, concepto, tope, al_llegar, excedente_modo)
  values ('e8200000-0000-0000-0000-0000000000f1', 'sms', v_uso, 'cobrar_excedente', 'por_unidad');

  select * into r from app.control_de_tope('22222222-2222-2222-2222-222222222222', 'sms', 3);
  if r.permitido is distinct from true then raise exception '4. Frenó con cobrar_excedente'; end if;
  if r.excedente is distinct from 3::numeric then
    raise exception '4. El excedente por unidad es % y tendría que ser 3', r.excedente;
  end if;

  -- Por bloque de 5: el mismo exceso de 3 se cobra como UN bloque. Un bloque
  -- empezado es un bloque vendido, que es como se venden los paquetes.
  update plan_tope set excedente_modo = 'por_bloque', excedente_bloque = 5
   where plan_id = 'e8200000-0000-0000-0000-0000000000f1' and concepto = 'sms';

  select * into r from app.control_de_tope('22222222-2222-2222-2222-222222222222', 'sms', 3);
  if r.excedente is distinct from 1::numeric then
    raise exception '4. ⚠ Con bloques de 5 y un exceso de 3 se cobra % y tendría que ser 1 bloque', r.excedente;
  end if;

  -- Y seis de exceso son dos bloques, no uno.
  select * into r from app.control_de_tope('22222222-2222-2222-2222-222222222222', 'sms', 6);
  if r.excedente is distinct from 2::numeric then
    raise exception '4. Con bloques de 5 y un exceso de 6 se cobra % y tendría que ser 2', r.excedente;
  end if;

  delete from plan_tope where plan_id = 'e8200000-0000-0000-0000-0000000000f1' and concepto = 'sms';
end $excedente$;

-- ═══ 5. `avisar` deja pasar SIN cobrar ══════════════════════════════════════
do $avisar$
declare r record; v_uso numeric;
begin
  select app.uso_de('22222222-2222-2222-2222-222222222222', 'sms') into v_uso;
  insert into plan_tope (plan_id, concepto, tope, al_llegar)
  values ('e8200000-0000-0000-0000-0000000000f1', 'sms', v_uso, 'avisar');

  select * into r from app.control_de_tope('22222222-2222-2222-2222-222222222222', 'sms', 5);
  if r.permitido is distinct from true then raise exception '5. `avisar` frenó'; end if;
  if r.excedente is distinct from 0::numeric then
    raise exception '5. ⚠⚠ `avisar` cobró % de excedente: se le estaría facturando a alguien a quien sólo había que avisarle', r.excedente;
  end if;
  if r.avisar is distinct from true then raise exception '5. Pasó el tope y no avisa'; end if;

  delete from plan_tope where plan_id = 'e8200000-0000-0000-0000-0000000000f1' and concepto = 'sms';
end $avisar$;

-- ═══ 6. El override de la cuenta gana sobre el del plan ═════════════════════
do $cascada$
declare r record; v_uso numeric;
begin
  select app.uso_de('22222222-2222-2222-2222-222222222222', 'sms') into v_uso;

  -- El plan frena donde está; la cuenta tiene una excepción que permite mucho más.
  insert into plan_tope (plan_id, concepto, tope, al_llegar)
  values ('e8200000-0000-0000-0000-0000000000f1', 'sms', v_uso, 'frenar');
  insert into plan_tope (cuenta_id, concepto, tope, al_llegar)
  values ('22222222-2222-2222-2222-222222222222', 'sms', v_uso + 100, 'cobrar_excedente');

  select * into r from app.control_de_tope('22222222-2222-2222-2222-222222222222', 'sms', 10);
  if r.tope is distinct from (v_uso + 100) then
    raise exception '6. ⚠⚠ Ganó el tope del plan (%) sobre el de la cuenta: la excepción que le diste a un cliente no vale', r.tope;
  end if;
  if r.permitido is distinct from true then
    raise exception '6. Frenó con el tope de la cuenta, que permite';
  end if;

  delete from plan_tope where concepto = 'sms';
end $cascada$;

-- ═══ 7. El aviso salta ANTES de llegar ══════════════════════════════════════
do $umbral$
declare r record; v_uso numeric; v_tope numeric;
begin
  select app.uso_de('22222222-2222-2222-2222-222222222222', 'sms') into v_uso;
  v_tope := v_uso + 100;   -- cien de margen desde donde esté

  insert into plan_tope (plan_id, concepto, tope, al_llegar, umbral_aviso_pct)
  values ('e8200000-0000-0000-0000-0000000000f1', 'sms', v_tope, 'frenar', 80);

  -- Quedando en la mitad del tope no avisa.
  select * into r from app.control_de_tope('22222222-2222-2222-2222-222222222222', 'sms',
                                           (v_tope / 2) - v_uso);
  if r.avisar is distinct from false then
    raise exception '7. Avisó a mitad de camino con umbral 80';
  end if;

  -- Quedando en el 85% sí, y todavía deja pasar: avisar cuando ya se pasó es
  -- llegar tarde, y es justamente para lo que sirve el umbral.
  select * into r from app.control_de_tope('22222222-2222-2222-2222-222222222222', 'sms',
                                           (v_tope * 0.85) - v_uso);
  if r.avisar is distinct from true then
    raise exception '7. ⚠ No avisó al 85%% de un tope con umbral 80: el aviso llega cuando ya no sirve';
  end if;
  if r.permitido is distinct from true then
    raise exception '7. Frenó al 85%% del tope';
  end if;

  delete from plan_tope where plan_id = 'e8200000-0000-0000-0000-0000000000f1' and concepto = 'sms';
end $umbral$;

-- ═══ 8. El tope de usuarios distingue por ROL ═══════════════════════════════
do $roles$
declare r record;
begin
  -- Dos administradores y tres personas en total. Un tope de 2 administradores
  -- tiene que frenar; el mismo número mirado como total, no.
  insert into plan_tope (plan_id, concepto, rol_codigo, tope, al_llegar)
  values ('e8200000-0000-0000-0000-0000000000f1', 'usuarios', 'admin', 2, 'frenar');

  select * into r from app.control_de_tope('22222222-2222-2222-2222-222222222222', 'usuarios', 1, 'admin');
  if r.uso is distinct from 2::numeric then
    raise exception '8. ⚠⚠ El tope de administradores cuenta % y hay 2 con ese rol: está mirando a toda la empresa', r.uso;
  end if;
  if r.permitido is distinct from false then
    raise exception '8. Dejó agregar un tercer administrador con tope de 2';
  end if;

  -- ⚠ Y el mismo tope SIN rol mira a los tres: si diera lo mismo, el rol no
  -- estaría haciendo nada.
  insert into plan_tope (plan_id, concepto, tope, al_llegar)
  values ('e8200000-0000-0000-0000-0000000000f1', 'usuarios', 2, 'frenar');
  select * into r from app.control_de_tope('22222222-2222-2222-2222-222222222222', 'usuarios', 1);
  if r.uso is distinct from 3::numeric then
    raise exception '8. ⚠ El tope sin rol cuenta % y en la empresa hay 3 personas', r.uso;
  end if;

  -- Un rol sobre algo que no son usuarios no puede existir.
  begin
    insert into plan_tope (plan_id, concepto, rol_codigo, tope)
    values ('e8200000-0000-0000-0000-0000000000f1', 'firma', 'admin', 5);
    raise exception '8. Entró un tope de FIRMAS con rol, que no significa nada';
  exception when check_violation then null;
  end;

  delete from plan_tope where plan_id = 'e8200000-0000-0000-0000-0000000000f1' and concepto = 'usuarios';
end $roles$;

-- ═══ 9. El disco: el número de custodia, el comportamiento de acá ═══════════
do $disco$
declare r record; v_usado numeric;
begin
  insert into plan_custodia (plan_id, modo, tope_documentos)
  values ('e8200000-0000-0000-0000-0000000000f1', 'con_tope', 3)
  on conflict (plan_id) do update set modo = 'con_tope', tope_documentos = 3, tope_bytes = null;

  select * into r from app.tope_efectivo('22222222-2222-2222-2222-222222222222', 'almacenamiento_documentos');
  if r.tope is distinct from 3::numeric then
    raise exception '9. ⚠ El tope de disco no salió de plan_custodia: dio %', r.tope;
  end if;
  -- Sin fila en plan_tope, el comportamiento por omisión es frenar — que en un
  -- depósito significa «no se puede subir más», jamás «se borra algo».
  if r.al_llegar is distinct from 'frenar' then raise exception '9. Comportamiento %', r.al_llegar; end if;
  if r.origen is distinct from 'custodia' then raise exception '9. Origen %', r.origen; end if;

  -- Y con una fila de plan_tope, el comportamiento sale de ahí y el número sigue
  -- saliendo de custodia: no se duplica el número en dos lugares.
  insert into plan_tope (plan_id, concepto, tope, al_llegar, umbral_aviso_pct)
  values ('e8200000-0000-0000-0000-0000000000f1', 'almacenamiento_documentos', 999, 'avisar', 90);

  select * into r from app.tope_efectivo('22222222-2222-2222-2222-222222222222', 'almacenamiento_documentos');
  if r.tope is distinct from 3::numeric then
    raise exception '9. ⚠⚠ El número salió de plan_tope (%) y tiene que salir de custodia: hay dos verdades', r.tope;
  end if;
  if r.al_llegar is distinct from 'avisar' then
    raise exception '9. El comportamiento no salió de plan_tope: %', r.al_llegar;
  end if;

  -- `sin_tope` no topea nada, y `sin_custodia` tampoco es un tope de cero.
  update plan_custodia set modo = 'sin_tope', tope_documentos = null
   where plan_id = 'e8200000-0000-0000-0000-0000000000f1';
  select * into r from app.tope_efectivo('22222222-2222-2222-2222-222222222222', 'almacenamiento_documentos');
  if r.tope is not null then
    raise exception '9. ⚠ Con custodia «sin tope» apareció un tope de %', r.tope;
  end if;

  delete from plan_tope where plan_id = 'e8200000-0000-0000-0000-0000000000f1';
end $disco$;

-- ═══ 10. Una cuenta no se escribe su propio tope ════════════════════════════
do $escritura$
declare v_ok boolean := false;
begin
  begin
    set local role app_rw;
    perform set_config('app.actor', 'cuenta', true);
    perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
    insert into plan_tope (cuenta_id, concepto, tope)
    values ('22222222-2222-2222-2222-222222222222', 'sms', 99999);
  exception when others then v_ok := true;
  end;
  reset role;
  if not v_ok then
    raise exception '10. ⚠⚠ Una cuenta se escribió su propio tope: elegir el propio límite es no tener límite';
  end if;
end $escritura$;

do $listo$ begin
  raise notice '✓ 082: los topes miden cada cosa por su naturaleza, y frenar no le quita nada a nadie.';
end $listo$;

rollback;
