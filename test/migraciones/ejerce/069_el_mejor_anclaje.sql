-- =============================================================================
-- ejerce/069_el_mejor_anclaje.sql
--
-- ═══ ROL: app_rw, con contexto real ═══
--
-- Segundo ejerce escrito con el patrón de la deuda 77(a). El anterior es el 067.
--
-- Se ejerce como `app_rw` porque es quien llama a esta función en producción: el
-- motor de firma. Como `postgres` la función devolvería lo mismo pero no se
-- estaría probando que la aplicación PUEDA llamarla — que es la mitad del
-- asunto, y la mitad que rompió más veces.
--
-- ⚠ Esta función decide con qué NIVEL DE GARANTÍA queda firmado un documento.
-- Un error acá no se ve al correr: se ve dentro de dos años, cuando alguien
-- discuta un expediente que dice «alto» sin serlo, o «bajo» siéndolo.
-- =============================================================================

\set ON_ERROR_STOP on

do $cinturon$ begin
  if to_regclass('public.banco_de_pruebas') is null then
    raise exception 'ABORTADO: esto no es el banco de pruebas. Falta la marca banco_de_pruebas.';
  end if;
end $cinturon$;

begin;

-- El escenario se arma como app_rw, con contexto. No con llave maestra: si la
-- aplicación no pudiera insertar un anclaje, querríamos enterarnos acá y no en
-- producción.
set role app_rw;
do $ctx$ begin
  perform set_config('app.actor', 'cuenta', true);
  perform set_config('app.cuenta_id', '22222222-2222-2222-2222-222222222222', true);
  perform set_config('app.identidad_id', '11111111-1111-1111-1111-111111111111', true);
end $ctx$;

do $prueba$
declare
  v_ident uuid := '11111111-1111-1111-1111-111111111111';
  v_email uuid; v_doc uuid; v_id uuid; v_nivel text;
begin
  -- ⚠ NOTA DE MÉTODO, aprendida rompiéndose:
  --
  -- Este ejerce NO revoca ni vence anclajes con un `update`: los inserta ya
  -- revocados o ya vencidos. No es una comodidad, es que no se puede —
  -- `app_rw` puede INSERTAR anclajes pero no modificarlos (medido el 5/9: el
  -- update devuelve 0 filas). Los anclajes son append-only para la aplicación,
  -- que es lo correcto: un hecho probado no se reescribe.
  --
  -- La primera versión de este archivo usaba `update` y daba «un anclaje
  -- revocado siguió ganando». El defecto no era de la función: era que la
  -- revocación nunca ocurría, en silencio.

  -- ── 1. Sin ningún anclaje, no devuelve nada ────────────────────────────────
  -- Cero filas es una RESPUESTA, no un error: quien llama tiene que decidir qué
  -- hacer con una firma sin prueba de identidad. Si devolviera un nivel por
  -- defecto, el motor firmaría creyendo que probó algo.
  if exists (select 1 from app.mejor_anclaje(v_ident)) then
    raise exception '⚠ sin anclajes, mejor_anclaje devolvió algo';
  end if;

  -- ── 2. Con uno solo de correo, gana ese ────────────────────────────────────
  insert into anclaje_identidad (identidad_id, tipo, valor_normalizado, metodo_prueba, nivel_garantia)
  values (v_ident, 'email', 'firmante@ejemplo.invalid', 'verificacion_email', 'bajo')
  returning id into v_email;

  select id, nivel_garantia into v_id, v_nivel from app.mejor_anclaje(v_ident);
  if v_id <> v_email or v_nivel <> 'bajo' then
    raise exception '⚠ con un solo anclaje de correo debería ganar ése';
  end if;

  -- ── 3. Un anclaje alto REVOCADO no vale ────────────────────────────────────
  insert into anclaje_identidad (identidad_id, tipo, valor_normalizado, metodo_prueba,
                                 nivel_garantia, idp, idp_sujeto, revocado_en)
  values (v_ident, 'documento', '99999999', 'oidc', 'alto', 'tuid', 'revocado', now());

  select id into v_id from app.mejor_anclaje(v_ident);
  if v_id <> v_email then
    raise exception '⚠ un anclaje revocado le ganó al de correo';
  end if;

  -- ── 4. Un anclaje alto VENCIDO tampoco ─────────────────────────────────────
  -- El certificado con el que alguien probó su identidad en marzo puede estar
  -- revocado en septiembre. Firmar en septiembre invocando aquella prueba sería
  -- afirmar algo que ya no es cierto.
  insert into anclaje_identidad (identidad_id, tipo, valor_normalizado, metodo_prueba,
                                 nivel_garantia, idp, idp_sujeto, vigente_hasta)
  values (v_ident, 'documento', '88888888', 'oidc', 'alto', 'tuid', 'vencido',
          now() - interval '1 day');

  select id into v_id from app.mejor_anclaje(v_ident);
  if v_id <> v_email then
    raise exception '⚠ un anclaje vencido le ganó al de correo';
  end if;

  -- ── 5. La cédula verificada, vigente: ahora sí gana el nivel alto ──────────
  -- Es el caso que justifica toda la migración. Si acá siguiera ganando el
  -- correo, verificarse con tuID no serviría para nada.
  insert into anclaje_identidad (identidad_id, tipo, valor_normalizado, metodo_prueba,
                                 nivel_garantia, idp, idp_sujeto, documento_tipo,
                                 documento_numero_norm, pais)
  values (v_ident, 'documento', '12345678', 'oidc', 'alto',
          'tuid', 'sujeto-tuid-1', 'CI', '12345678', 'UY')
  returning id into v_doc;

  select id, nivel_garantia into v_id, v_nivel from app.mejor_anclaje(v_ident);
  if v_id <> v_doc or v_nivel <> 'alto' then
    raise exception '⚠ el anclaje de nivel alto no le ganó al de correo';
  end if;

  -- ── 6. Entre dos del MISMO nivel, gana el más reciente ─────────────────────
  -- ⚠ Invierte lo que hacía la consulta vieja del motor, que tomaba el más
  -- antiguo. Para el correo daba igual —hay uno solo—; para documentos no, y
  -- quedarse con el más viejo sería elegir a propósito la prueba más envejecida.
  insert into anclaje_identidad (identidad_id, tipo, valor_normalizado, metodo_prueba,
                                 nivel_garantia, idp, idp_sujeto, probado_en)
  values (v_ident, 'documento', '12345678', 'oidc', 'alto', 'tuid', 'sujeto-tuid-0',
          now() - interval '30 days');

  select id into v_id from app.mejor_anclaje(v_ident);
  if v_id <> v_doc then
    raise exception '⚠ entre dos anclajes de nivel alto ganó el viejo';
  end if;

  -- ── 7. El vecino no se contamina ───────────────────────────────────────────
  -- La contra-prueba. Todo lo de arriba dice que la función encuentra lo que
  -- tiene que encontrar; esto dice que no encuentra lo que NO es suyo. Sin este
  -- paso, una función que ignorara `identidad_id` pasaría las seis anteriores.
  if exists (select 1 from app.mejor_anclaje('99999999-9999-9999-9999-999999999999'::uuid)) then
    raise exception '⚠ mejor_anclaje devolvió anclajes de otra identidad';
  end if;
end $prueba$;

reset role;
rollback;

do $ok$ begin
  raise notice '✓ 069: gana el nivel más alto, el más reciente en empate, y ni el revocado ni el vencido cuentan.';
end $ok$;
