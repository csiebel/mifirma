-- =============================================================================
-- ejerce/070_entrar_con_identidad.sql
--
-- ═══ ROL: app_rw, con contexto real ═══
--
-- Tercer ejerce con el patrón de la deuda 77(a) (los anteriores: 067 y 069).
--
-- Se ejerce como `app_rw` porque es quien vincula, revoca y consulta en
-- producción. Y acá importa más que en los otros dos: la mitad de lo que hay que
-- probar es que UNA PERSONA NO VE NI TOCA LAS VINCULACIONES DE OTRA, y eso como
-- `postgres` no se puede probar — el superusuario saltea la RLS y todas las
-- pruebas de aislamiento darían verde con la política bien, mal o ausente.
--
-- ⚠ Lo que se decide acá es con qué identidad digital se ENTRA a una cuenta. Un
-- error no se ve al correr: se ve el día que alguien entre a la cuenta de otro.
-- =============================================================================

\set ON_ERROR_STOP on

do $cinturon$ begin
  if to_regclass('public.banco_de_pruebas') is null then
    raise exception 'ABORTADO: esto no es el banco de pruebas. Falta la marca banco_de_pruebas.';
  end if;
end $cinturon$;

begin;

-- Un proveedor de identidad para colgar las vinculaciones. Se inserta como
-- superusuario ANTES de bajar a app_rw: el catálogo lo administra el operador
-- (067) y app_rw no puede escribirlo — que app_rw no pueda es, justamente, otra
-- cosa que está bien.
insert into proveedor_firma (id, codigo, nombre_mostrado, entorno, endpoints, parametros)
values ('dddddddd-0000-0000-0000-00000000000d', 'idp_de_prueba', 'IdP de prueba',
        'homologacion', '{"homologacion":{"auth":"https://ejemplo.invalid"}}'::jsonb, '{}'::jsonb)
on conflict (codigo) do nothing;

-- ⚠ Las identidades del fixture nacen `latente` (default de la 003), y tanto el
-- login con contraseña como `app.identidad_por_idp` exigen `activa`. Sin esto la
-- función no encuentra NUNCA nada y medio ejerce prueba contra NULL — que fue
-- exactamente lo que pasó la primera vez (ver la nota de método de abajo).
update identidad set estado = 'activa'
 where id in ('11111111-1111-1111-1111-111111111111',
              'aaaaaaaa-0000-0000-0000-000000000001');

set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
  perform set_config('app.identidad_id', '11111111-1111-1111-1111-111111111111', true);
end $ctx$;

-- ═══ ⚠⚠ NOTA DE MÉTODO: POR QUÉ TODO SE COMPARA CON `is distinct from` ═══
--
-- Las comprobaciones de este archivo NO se escriben `if f(...) <> esperado`.
-- En SQL una comparación con NULL no es falsa: es NULL — y un `if NULL then` no
-- entra. Una función que devolviera NULL siempre pasaría todas esas pruebas sin
-- que nadie se entere.
--
-- No es teórico: la primera versión de este ejerce daba VERDE con la función
-- saboteada a propósito (se le quitó el filtro de `revocada_en`). El sabotaje no
-- se detectaba porque la función ya venía devolviendo NULL por otro motivo —las
-- identidades del fixture estaban `latente`— y las cuatro comprobaciones con
-- `<>` estaban comparando contra NULL sin decir nada.
--
-- `is distinct from` trata NULL como un valor más: NULL is distinct from X es
-- TRUE, y el `if` entra. Es la hermana de «un update que no afecta filas se ve
-- igual que uno que funcionó» (1/9) y de «bajo RLS un select no falla, devuelve
-- menos filas».
do $mio$
declare
  v_yo   uuid := '11111111-1111-1111-1111-111111111111';
  v_prov uuid := 'dddddddd-0000-0000-0000-00000000000d';
  v_id   uuid;
begin
  -- ── 1. Sin vincular, nadie es dueño de ese sujeto ─────────────────────────
  -- Cero es una respuesta: quien llama tiene que ofrecer vincular, no entrar.
  if app.identidad_por_idp(v_prov, 'sujeto-1') is not null then
    raise exception '⚠ sin vinculación, identidad_por_idp devolvió una identidad';
  end if;

  -- ── 2. Vincular lo propio se puede ────────────────────────────────────────
  insert into credencial_idp (identidad_id, proveedor_id, idp_sujeto, mostrado, vinculada_por)
  values (v_yo, v_prov, 'sujeto-1', 'C*** S****', v_yo)
  returning id into v_id;

  if app.identidad_por_idp(v_prov, 'sujeto-1') is distinct from v_yo then
    raise exception '⚠ vinculado, identidad_por_idp no devolvió a su dueño (devolvió %)',
      coalesce(app.identidad_por_idp(v_prov, 'sujeto-1')::text, 'NULL');
  end if;

  -- ── 3. La MISMA persona no puede vincular dos veces el mismo proveedor ────
  -- Dos filas «yo con tuID» no significan nada distinto de una, y hacen que
  -- revocar una deje la otra viva. Regla 2 de la migración.
  begin
    insert into credencial_idp (identidad_id, proveedor_id, idp_sujeto, vinculada_por)
    values (v_yo, v_prov, 'sujeto-otro-mio', v_yo);
    raise exception '⚠ dejó vincular dos veces el mismo proveedor a la misma persona';
  exception when unique_violation then null;
  end;
end $mio$;

-- ═══ Cambio de persona: ahora es Ana ═══════════════════════════════════════
--
-- ⚠ NOTA DE MÉTODO, aprendida rompiendo esta prueba dos veces:
--
-- El sujeto ajeno está protegido por DOS defensas distintas, y cada una actúa en
-- un lugar distinto. La primera versión probaba el índice único intentando
-- insertar la fila de Ana ESTANDO EN SESIÓN COMO CLAUDIO — y lo que saltaba era
-- la POLÍTICA («nadie escribe filas de otro»), nunca el índice. La prueba pasaba
-- por el motivo equivocado y el índice quedaba sin ejercitar.
--
-- El caso real no es que alguien inserte filas ajenas: es que ANA, con su propia
-- identidad y todo el derecho a vincularse, intente tomar un sujeto que otro ya
-- tiene. Ahí la política la deja pasar —la fila es suya— y el índice es la única
-- defensa que queda. Por eso este bloque cambia de contexto.
do $ctx_ana$ begin
  perform set_config('app.identidad_id', 'aaaaaaaa-0000-0000-0000-000000000001', true);
end $ctx_ana$;

do $como_ana$
declare
  v_ana  uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_yo   uuid := '11111111-1111-1111-1111-111111111111';
  v_prov uuid := 'dddddddd-0000-0000-0000-00000000000d';
  v_n    int;
begin
  -- ── 4. ⚠ UN SUJETO NO PUEDE PERTENECER A DOS IDENTIDADES ──────────────────
  -- El corazón de la migración, y la hermana de «una cédula, una identidad»
  -- (003). Si esto pasara, entrar con esa identidad sería ambiguo y el producto
  -- tendría que ADIVINAR a qué cuenta entrar.
  begin
    insert into credencial_idp (identidad_id, proveedor_id, idp_sujeto, vinculada_por)
    values (v_ana, v_prov, 'sujeto-1', v_ana);
    raise exception '⚠ dejó vincular el mismo sujeto a dos identidades';
  exception when unique_violation then null;
  end;

  -- ── 4 bis. Ana no puede vincular EN NOMBRE de Claudio ─────────────────────
  -- La política de INSERT, ejercitada. Sin esto, ponerla en `true` no lo delata
  -- nada: el paso 4 inserta una fila PROPIA (con sujeto ajeno) y lo que salta es
  -- el índice, no la política. Son dos defensas y cada una necesita su prueba.
  begin
    insert into credencial_idp (identidad_id, proveedor_id, idp_sujeto, vinculada_por)
    values (v_yo, v_prov, 'sujeto-puesto-por-ana', v_ana);
    raise exception '⚠ Ana pudo crear una vinculación a nombre de otra identidad';
  exception when insufficient_privilege then null;
  end;

  -- ── 5. Ana no ve NI UNA fila de Claudio ───────────────────────────────────
  -- La contra-prueba del vecino. Sin esto, una política escrita con `using
  -- (true)` pasaría todo lo anterior sin que nadie se entere.
  select count(*) into v_n from credencial_idp where identidad_id = v_yo;
  if v_n <> 0 then
    raise exception '⚠ Ana vio % vinculaciones de otra identidad', v_n;
  end if;

  -- ── 6. Y tampoco las revoca ───────────────────────────────────────────────
  -- ⚠ Bajo RLS un update que no alcanza filas NO falla: devuelve cero. Por eso
  -- se cuentan las filas afectadas, y no se confía en que «no tiró error»
  -- signifique algo. Es la lección del 1/9 y la del ejerce/069.
  update credencial_idp set revocada_en = now() where identidad_id = v_yo;
  get diagnostics v_n = row_count;
  if v_n <> 0 then
    raise exception '⚠ Ana pudo revocar % vinculaciones ajenas', v_n;
  end if;

  -- ── 6 bis. ⚠⚠ Ana no puede REGALAR su vinculación a otra identidad ────────
  --
  -- Lo que prueba el `with check` de la política, y el motivo por el que existe.
  -- El paso 6 no alcanza: ahí Ana intenta tocar filas que NO VE, y la política
  -- de SELECT ya la frena — así que la de UPDATE nunca se ejercita y podría
  -- estar en `using (true)` sin que nada lo delate. Medido: ese sabotaje pasaba
  -- en verde, protegido por accidente por otra política.
  --
  -- Acá Ana toca SU PROPIA fila, que ve y puede tocar, y le cambia el dueño. Sin
  -- `with check` la fila entra siendo suya y sale siendo de Claudio: una
  -- identidad digital regalada —o robada— entre cuentas.
  --
  -- ⚠ MEDIDO el 6/9, y el resultado sorprende: con el `with check` puesto en
  -- `true` a propósito, Postgres RECHAZA el movimiento igual. Hay una segunda
  -- defensa actuando sobre la fila resultante. O sea que este paso NO demuestra
  -- que el `with check` sea necesario — no se lo puede aislar — y queda como
  -- cinturón sobre tirantes: no cuesta nada y protege si algún día la otra
  -- defensa se afloja. Se deja escrito para que nadie lo saque creyendo que
  -- prueba algo que no prueba, ni lo saque creyendo que sobra.
  insert into credencial_idp (identidad_id, proveedor_id, idp_sujeto, vinculada_por)
  values (v_ana, v_prov, 'sujeto-de-ana', v_ana);
  begin
    update credencial_idp set identidad_id = v_yo
     where identidad_id = v_ana and idp_sujeto = 'sujeto-de-ana';
    raise exception '⚠ Ana pudo mover su vinculación a la identidad de otro';
  exception when insufficient_privilege then null;
  end;

  -- Ana deja su prueba revocada: si no, el paso 8 —donde toma el sujeto que
  -- Claudio liberó— choca contra la regla 2 (una vinculación vigente por persona
  -- y proveedor). Que haya chocado la primera vez es la regla funcionando.
  update credencial_idp set revocada_en = now(), revocada_por = v_ana
   where identidad_id = v_ana and idp_sujeto = 'sujeto-de-ana';
end $como_ana$;

-- ═══ Vuelve Claudio, a revocar lo suyo ═════════════════════════════════════
do $ctx_yo$ begin
  perform set_config('app.identidad_id', '11111111-1111-1111-1111-111111111111', true);
end $ctx_yo$;

do $revocar$
declare
  v_yo   uuid := '11111111-1111-1111-1111-111111111111';
  v_prov uuid := 'dddddddd-0000-0000-0000-00000000000d';
  v_n    int;
begin
  -- ── 7. Revocar libera el sujeto, y la historia queda ──────────────────────
  -- Desvincular y volver a vincular tiene que poder hacerse las veces que haga
  -- falta. Por eso los índices son PARCIALES sobre `revocada_en is null`.
  update credencial_idp set revocada_en = now(), revocada_por = v_yo
   where identidad_id = v_yo and revocada_en is null;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception '⚠ esperaba revocar 1 vinculación propia, revoqué %', v_n;
  end if;

  if app.identidad_por_idp(v_prov, 'sujeto-1') is not null then
    raise exception '⚠ una vinculación revocada siguió sirviendo para entrar';
  end if;

  -- La fila sigue estando: revocar no borra. Es lo que permite contestar «con
  -- qué identidad entraba esta persona en marzo».
  select count(*) into v_n from credencial_idp where identidad_id = v_yo;
  if v_n <> 1 then
    raise exception '⚠ revocar borró la fila: la historia se perdió';
  end if;
end $revocar$;

-- ═══ Y ahora Ana sí puede tomar el sujeto liberado ═════════════════════════
do $ctx_ana2$ begin
  perform set_config('app.identidad_id', 'aaaaaaaa-0000-0000-0000-000000000001', true);
end $ctx_ana2$;

do $ana_toma$
declare
  v_ana  uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_prov uuid := 'dddddddd-0000-0000-0000-00000000000d';
begin
  -- ── 8. El caso real de una cuenta que cambia de dueño ─────────────────────
  -- El paso 4 probó que un sujeto OCUPADO no se puede tomar; éste prueba que uno
  -- LIBERADO sí. Sin los dos, un índice único total (no parcial) pasaría el 4 y
  -- dejaría a esta persona sin poder vincularse nunca más.
  insert into credencial_idp (identidad_id, proveedor_id, idp_sujeto, vinculada_por)
  values (v_ana, v_prov, 'sujeto-1', v_ana);

  if app.identidad_por_idp(v_prov, 'sujeto-1') is distinct from v_ana then
    raise exception '⚠ después de revocar, el sujeto no quedó libre para otra identidad (devolvió %)',
      coalesce(app.identidad_por_idp(v_prov, 'sujeto-1')::text, 'NULL');
  end if;
end $ana_toma$;

-- ── 9. El sistema sí puede verlas todas ─────────────────────────────────────
-- El login corre como sistema, sin identidad en el contexto: si esta política
-- no lo contemplara, nadie podría entrar con identidad digital nunca.
do $ctx$ begin
  perform set_config('app.actor', 'sistema', true);
  perform set_config('app.identidad_id', '', true);
end $ctx$;

do $sistema$
declare v_n int;
begin
  select count(*) into v_n from credencial_idp;
  if v_n < 2 then
    raise exception '⚠ como sistema debería ver todas las vinculaciones, vi %', v_n;
  end if;
end $sistema$;

reset role;
rollback;

do $ok$ begin
  raise notice '✓ 070: un sujeto es de una sola identidad, revocar libera y deja historia, y nadie ve ni toca las vinculaciones ajenas.';
end $ok$;
