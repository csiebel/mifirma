-- =============================================================================
-- MiFirma — 076_el_medidor.sql
-- Que una firma deje su línea contable al firmarse.
--
-- ═══ EL AGUJERO QUE CIERRA ═══
--
-- La 073 creó `firma_facturable` —una línea por firma, con lo que se cobra y lo
-- que se debe— y dejó escrito, en su propio comentario, que NADIE la escribía.
-- La 074 armó la liquidación a proveedores sobre esas líneas. La consola muestra
-- las dos pantallas. Y todo eso venía dando cero, porque el producto firmaba sin
-- anotar en ningún lado que había firmado.
--
-- ═══ POR QUÉ UNA FUNCIÓN Y NO UN INSERT EN EL CÓDIGO ═══
--
-- Tres razones, y las tres son la misma regla de la casa:
--
--   1. La política de escritura de `firma_facturable` (073) exige actor
--      'sistema', a propósito: una cuenta que pudiera escribir su propia línea
--      podría escribirse el precio. Pero quien firma es una cuenta, o un
--      firmante externo sin cuenta. Si el insert lo hiciera el código, habría
--      que abrirle esa policy al firmante — o sea, regalar la caja.
--
--   2. El precio, las cantidades incluidas y el porcentaje del proveedor viven
--      en la base. Calcularlos en TypeScript sería una segunda copia de la
--      regla, que se desincroniza el día que alguien cambie una sola.
--
--   3. El tramo de firma está sellado. Con esto, lo que se le agrega es una
--      línea: `select app.medir_firma(...)`.
--
-- ═══ ⚠⚠ MEDIR NUNCA PUEDE TUMBAR UNA FIRMA ═══
--
-- Una firma que ya se aplicó al PDF es un hecho jurídico. Si el medidor falla
-- —falta un precio, un proveedor mal cargado, lo que sea— lo que NO puede pasar
-- es que se caiga la transacción y se pierda la firma. Por eso la función atrapa
-- todo, avisa por `raise warning` (que queda en el log del servidor) y devuelve
-- null. Se pierde una línea de facturación, que se puede reconstruir; no se
-- pierde una firma, que no.
--
-- Por la misma razón, cuando falta el precio la línea se escribe IGUAL, con
-- precio 0 y `cobrada = false`. El hecho de que hubo una firma es el dato que no
-- se puede perder; el precio se corrige después.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

create or replace function app.medir_firma(
  p_participacion uuid,
  p_nivel         text,      -- el nivel OBTENIDO: 'simple' o 'avanzada'
  p_proveedor_codigo text    -- con qué se firmó; null o el sello = sin proveedor
)
returns uuid
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_part       record;
  v_cuenta     record;
  v_plan       uuid;
  v_moneda     char(3);
  v_pais       char(2);
  v_periodo    char(7) := to_char(now(), 'YYYY-MM');
  v_prov       uuid;
  v_precio     numeric(14,4) := 0;
  v_incluida   numeric(14,4) := 0;
  v_ya         numeric(14,4);
  v_cobrada    boolean := true;
  v_modelo     text := 'sin_costo';
  v_costo      numeric(14,4);
  v_moneda_c   char(3);
  v_pct        numeric(6,3);
  v_liquidar   numeric(14,4);
  v_id         uuid;
begin
  select p.id, p.instancia_id, p.cuenta_propietaria_id
    into v_part
    from public.participacion p
   where p.id = p_participacion;
  if not found then
    raise warning 'medir_firma: no existe la participación %', p_participacion;
    return null;
  end if;

  -- ⚠ El país y la moneda son los del EMISOR, no los del firmante. Un uruguayo
  -- que firma un documento de una empresa brasileña genera una firma que se le
  -- cobra a la empresa brasileña, en su país y en su moneda.
  select c.pais, c.moneda into v_cuenta
    from public.cuenta c where c.id = v_part.cuenta_propietaria_id;
  v_pais := v_cuenta.pais;
  v_moneda := v_cuenta.moneda;

  select s.plan_id, s.moneda into v_plan, v_moneda
    from public.suscripcion s
   where s.cuenta_id = v_part.cuenta_propietaria_id and s.estado = 'activa'
   limit 1;
  if v_moneda is null then v_moneda := v_cuenta.moneda; end if;

  -- ── Con qué se firmó
  --
  -- El código que llega es el del sello usado. Si no está en el catálogo de
  -- proveedores, fue el sello de la plataforma: firma simple, sin proveedor.
  if p_proveedor_codigo is not null then
    select pf.id into v_prov from public.proveedor_firma pf
     where pf.codigo = p_proveedor_codigo;
  end if;
  if p_nivel = 'simple' then
    -- `facturable_nivel_coherente`: la simple es del sello y no cuelga de nadie.
    v_prov := null;
  elsif v_prov is null then
    raise warning 'medir_firma: firma avanzada (participación %) con proveedor «%» que no está en el catálogo',
      p_participacion, p_proveedor_codigo;
    return null;
  end if;

  -- ── Cuánto se le cobra
  select f.precio_unitario, f.cantidad_incluida
    into v_precio, v_incluida
    from app.precio_de_firma(v_plan, v_pais, v_moneda, p_nivel, v_prov) f;
  if v_precio is null then v_precio := 0; end if;
  if v_incluida is null then v_incluida := 0; end if;

  -- Las incluidas del mes.
  --
  -- ⚠ Se cuentan TODAS las firmas del período y de ese nivel, cobradas o no: la
  -- número 501 de un plan de 500 es la primera que se cobra. Contar sólo las
  -- cobradas —que fue el primer intento— nunca llega a la cuarta: como las tres
  -- primeras salen sin cobrar, el contador se queda en cero y no se cobra nunca
  -- ninguna. El ejerce lo agarró en el caso 3.
  if v_incluida > 0 then
    select count(*) into v_ya
      from public.firma_facturable ff
     where ff.cuenta_id = v_part.cuenta_propietaria_id
       and ff.periodo = v_periodo
       and ff.nivel_firma = p_nivel;
    if v_ya < v_incluida then v_cobrada := false; end if;
  end if;
  -- Sin plan no hay precio: se mide igual, pero no se cobra lo que nadie contrató.
  if v_plan is null then v_cobrada := false; end if;

  -- ── Cuánto nos cuesta, y a quién
  if v_prov is not null then
    select pp.modelo_economico, pp.costo_por_firma, pp.moneda_costo, pp.revenue_share_pct
      into v_modelo, v_costo, v_moneda_c, v_pct
      from public.proveedor_pais pp
     where pp.proveedor_id = v_prov and pp.pais = v_pais;
    if v_modelo is null then v_modelo := 'sin_costo'; end if;

    if v_modelo = 'revenue_share' then
      -- Sobre lo que se cobró. Una firma incluida en el plan no generó ingreso,
      -- así que no genera participación: 0, no null (el check la exige).
      v_liquidar := round(coalesce(case when v_cobrada then v_precio else 0 end, 0)
                          * coalesce(v_pct, 0) / 100, 4);
      v_costo := null; v_moneda_c := null;
    elsif v_modelo = 'costo' then
      v_liquidar := null;
    else
      v_costo := null; v_moneda_c := null; v_liquidar := null;
    end if;
  end if;

  insert into public.firma_facturable (
    participacion_id, instancia_id, cuenta_id, periodo, pais, nivel_firma,
    proveedor_id, plan_id, moneda, precio_unitario, cobrada,
    modelo_economico, costo_proveedor, moneda_costo, a_liquidar
  ) values (
    v_part.id, v_part.instancia_id, v_part.cuenta_propietaria_id, v_periodo,
    v_pais, p_nivel, v_prov, v_plan, v_moneda, v_precio, v_cobrada,
    v_modelo, v_costo, v_moneda_c, v_liquidar
  )
  -- Una firma se mide una vez. La segunda llamada es un reintento del mismo
  -- acto, no una firma nueva.
  on conflict (participacion_id) do nothing
  returning id into v_id;

  return v_id;

exception when others then
  -- ⚠⚠ Acá termina el medidor y sigue la firma. Ver el encabezado.
  raise warning 'medir_firma: no se pudo medir la participación % (%): %',
    p_participacion, sqlstate, sqlerrm;
  return null;
end $$;

comment on function app.medir_firma(uuid, text, text) is
  'Escribe la línea de firma_facturable de una firma recién aplicada, con el precio y el '
  'porcentaje del proveedor vigentes hoy. security definer porque la escribe el sistema y no '
  'la cuenta. ⚠ Nunca lanza: una firma no se pierde porque no se haya podido medir. '
  'Migración 076.';

revoke all on function app.medir_firma(uuid, text, text) from public;
grant execute on function app.medir_firma(uuid, text, text) to app_rw;

-- ⚠ El operador no mide: la línea la escribe el acto de firmar y nadie más. Si
-- alguien tuviera que reconstruir una línea perdida, se hace por psql y se
-- anota, que es justamente lo que obliga a mirarlo.
do $centinela$ begin
  if has_function_privilege('app_operador', 'app.medir_firma(uuid, text, text)', 'execute') then
    raise exception 'El operador no escribe líneas facturables: las escribe el acto de firmar';
  end if;
end $centinela$;

commit;
