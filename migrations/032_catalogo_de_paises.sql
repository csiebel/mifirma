-- =============================================================================
-- MiFirma — 032_catalogo_de_paises.sql
-- El catálogo de países: moneda de cobro, idioma y marco legal.
--
-- ═══ POR QUÉ ═══
--
-- Hasta hoy la moneda de cada país estaba escrita CUATRO veces, y ninguna en la
-- base:
--
--   public/operador.js:33   var MONEDA_PAIS = { UY:'UYU', PY:'PYG', BR:'BRL' }
--   public/operador.html    <option>🇺🇾 Uruguay · UYU</option> …
--   src/http/routes/auth.ts const MONEDA = { UY:'UYU', PY:'PYG', BR:'BRL' }
--   src/admin/provisioning  idiomaPorPais() → 'pt-BR' si es BR
--
-- O sea: agregar Chile era tocar código en cuatro archivos, y registrarse desde
-- un país no previsto daba «La moneda va en ISO 4217» sin decir por qué. Eso
-- contradice de frente el principio del proyecto —diseñar global, lanzar
-- angosto— y el del paquete de país: el marco de cada país es DATO, no código.
--
-- ═══ LA REGLA, Y ES AL REVÉS DE LO QUE ESTABA ═══
--
--   La moneda de cobro es el DÓLAR, salvo que el catálogo diga otra cosa.
--
-- Uruguay, Paraguay y Brasil dicen otra cosa —UYU, PYG, BRL— y por eso tienen
-- fila. Un país sin fila cobra en USD y funciona sin que nadie configure nada.
-- La moneda local es la excepción declarada, no el caso base: al revés, cada
-- país nuevo sería una migración.
--
-- ⚠ Dos cosas distintas que se confunden y acá quedan separadas:
--
--   · LA LISTA DE PRECIOS acepta la moneda del país y SIEMPRE el dólar. La fila
--     en USD es el precio de referencia y existe para todo plan (billing D5),
--     incluso donde no se pueda cobrar en dólares.
--   · COBRARLE A UNA CUENTA en dólares es otra pregunta, y es legal: en Brasil
--     los pagos domésticos entre residentes están en general restringidos al
--     real. Eso lo gobierna `admite_usd`, que es dato del paquete de país.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

create table pais (
  codigo          char(2) primary key,
  nombre_i18n     jsonb  not null,          -- {"es":"Uruguay","pt":"Uruguai","en":"Uruguay"}
  bandera         text,                     -- el emoji; es presentación, no dato
  idioma          text   not null default 'es',
  orden           int    not null default 100,

  -- ---- Comercial: lo define el operador -----------------------------------
  -- La moneda de cobro. Que el default sea USD no es decorativo: es la regla.
  moneda          char(3) not null default 'USD',
  -- ¿Se le puede facturar a una cuenta de acá en dólares? Sólo tiene sentido
  -- donde la moneda de cobro NO es el dólar.
  admite_usd      boolean not null default false,
  -- Organismo oficial del tipo de cambio: BCU, BCP, BCB/PTAX. Dato del paquete
  -- de país (billing-diseno §5).
  tc_fuente       text,

  -- ---- Legal: dato del paquete de país, se muestra en la página -----------
  marco_legal     text,                     -- 'Ley 18.600'
  certificador    text,                     -- 'tuID (Antel)'

  -- La procedencia. Sin esto la tabla es una opinión con formato de dato.
  fuente          text not null default 'SIN VERIFICAR',
  verificado_por  text,
  verificado_en   date,

  creado_en       timestamptz not null default now(),
  actualizado_en  timestamptz not null default now(),

  constraint pais_codigo_alfa2 check (codigo ~ '^[A-Z]{2}$'),
  constraint pais_moneda_iso   check (moneda ~ '^[A-Z]{3}$'),
  -- Declarar que admite dólares donde el cobro YA es en dólares no significa
  -- nada, y esconde un error de carga.
  constraint pais_usd_coherente check (not (admite_usd and moneda = 'USD'))
);

comment on table pais is
  'Catálogo de países. La moneda de cobro es USD salvo que acá diga otra cosa. '
  'Ver migración 032 y claude billing-diseno.md §5.';

-- ⚠ NO hay columna `activo`, a propósito. Qué países se ofrecen ya lo decide
-- tener precios cargados (`precio_metrica`, migración 019). Dos mecanismos para
-- la misma pregunta terminan siempre en un país que aparece en un lado y no en
-- el otro, y en media hora buscando cuál de los dos manda.

-- -----------------------------------------------------------------------------
-- El MVP. Son los tres que hoy estaban escritos en el navegador.
-- -----------------------------------------------------------------------------
insert into pais (codigo, nombre_i18n, bandera, idioma, orden, moneda, admite_usd,
                  tc_fuente, marco_legal, certificador, fuente) values
  ('UY', '{"es":"Uruguay","pt":"Uruguai","en":"Uruguay"}', '🇺🇾', 'es', 10,
   'UYU', true,  'BCU', 'Ley 18.600', 'tuID (Antel)',
   'SIN VERIFICAR — cobro en USD: práctica corriente según billing-diseno.md §5, falta abogado local'),
  ('PY', '{"es":"Paraguay","pt":"Paraguai","en":"Paraguay"}', '🇵🇾', 'es', 20,
   'PYG', true,  'BCP', 'Ley 4017', 'e-Firma',
   'SIN VERIFICAR — cobro en USD: práctica corriente según billing-diseno.md §5, falta abogado local'),
  ('BR', '{"es":"Brasil","pt":"Brasil","en":"Brazil"}', '🇧🇷', 'pt-BR', 30,
   'BRL', false, 'BCB', 'MP 2.200-2', 'ICP-Brasil (SERPRO)',
   'SIN VERIFICAR — pagos domésticos entre residentes restringidos al real (billing-diseno.md §5), falta abogado local')
on conflict (codigo) do nothing;

-- -----------------------------------------------------------------------------
-- La regla, en una función
--
-- Una función y no un join suelto: la usan el trigger, la aplicación y la
-- consola, y si cada uno la escribe por su cuenta se separan sin que nadie lo
-- note. `security definer` porque `pais` es catálogo global sin RLS, y así el
-- trigger no depende de qué GRANT tenga quien escribe.
-- -----------------------------------------------------------------------------
create or replace function app.moneda_de_cobro(p_pais char(2))
returns char(3)
language sql stable security definer set search_path = pg_catalog, public
as $$
  select coalesce((select p.moneda from public.pais p where p.codigo = upper(p_pais)), 'USD')::char(3);
$$;
revoke all on function app.moneda_de_cobro(char(2)) from public;
grant execute on function app.moneda_de_cobro(char(2)) to app_rw, app_operador;

/* ¿Se le puede facturar en dólares a una cuenta de este país?
   Sin fila, la moneda de cobro YA es el dólar, así que sí. */
create or replace function app.cobra_en_usd(p_pais char(2))
returns boolean
language sql stable security definer set search_path = pg_catalog, public
as $$
  select coalesce((select p.admite_usd or p.moneda = 'USD'
                     from public.pais p where p.codigo = upper(p_pais)), true);
$$;
revoke all on function app.cobra_en_usd(char(2)) from public;
grant execute on function app.cobra_en_usd(char(2)) to app_rw, app_operador;

-- -----------------------------------------------------------------------------
-- Antes de imponer la regla, comprobar que lo que ya está la cumple.
--
-- Un trigger que se instala sobre datos que lo violan no protege nada: protege
-- de lo que venga y deja adentro lo que ya estaba mal, que es justamente lo que
-- nadie va a volver a mirar.
-- -----------------------------------------------------------------------------
do $control$
declare v_mal text := '';
begin
  select string_agg(format(E'\n  precio %s: país %s en %s (correspondería %s o USD)',
                           pm.id, pm.pais, pm.moneda, app.moneda_de_cobro(pm.pais)), '')
    into v_mal
    from precio_metrica pm
   where pm.moneda <> app.moneda_de_cobro(pm.pais) and pm.moneda <> 'USD';
  if v_mal is not null then
    raise exception E'Hay precios cargados en una moneda que su país no cobra:%s', v_mal;
  end if;

  select string_agg(format(E'\n  cuenta %s: país %s facturada en %s', c.id, c.pais, c.moneda), '')
    into v_mal
    from cuenta c
   where c.moneda <> app.moneda_de_cobro(c.pais)
     and not (c.moneda = 'USD' and app.cobra_en_usd(c.pais));
  if v_mal is not null then
    raise exception E'Hay cuentas con una moneda que su país no cobra:%s', v_mal;
  end if;
end $control$;

-- -----------------------------------------------------------------------------
-- Que un precio en la moneda equivocada sea IMPOSIBLE, no improbable
--
-- ⚠ El mensaje de esta excepción NO llega al usuario: el manejador de errores
-- responde 500 genérico ante cualquier error que no sea un `HttpError`, y hace
-- bien —no filtrar mensajes de la base es correcto—. Por eso la validación
-- amable vive además en `guardarPrecio()`. Esto es el respaldo: vale para la
-- consola, para un script y para psql, que es donde de verdad se cargan datos
-- a mano un martes a las once de la noche.
-- -----------------------------------------------------------------------------
create or replace function app.precio_moneda_valida()
returns trigger
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_local char(3);
begin
  new.pais   := upper(new.pais);
  new.moneda := upper(new.moneda);
  v_local    := app.moneda_de_cobro(new.pais);
  if new.moneda <> v_local and new.moneda <> 'USD' then
    raise exception 'La moneda de cobro de % es %; un precio en % no se puede cobrar ahí',
      new.pais, v_local, new.moneda
      using errcode = '23514';
  end if;
  return new;
end $$;

create trigger precio_moneda_valida
  before insert or update of pais, moneda on precio_metrica
  for each row execute function app.precio_moneda_valida();

create or replace function app.cuenta_moneda_valida()
returns trigger
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_local char(3); v_admitidas text;
begin
  new.pais   := upper(new.pais);
  new.moneda := upper(new.moneda);
  v_local    := app.moneda_de_cobro(new.pais);
  if new.moneda <> v_local and not (new.moneda = 'USD' and app.cobra_en_usd(new.pais)) then
    v_admitidas := v_local ||
      case when app.cobra_en_usd(new.pais) and v_local <> 'USD' then ' o USD' else '' end;
    raise exception 'Una cuenta de % se factura en %; % no corresponde',
      new.pais, v_admitidas, new.moneda
      using errcode = '23514';
  end if;
  return new;
end $$;

create trigger cuenta_moneda_valida
  before insert or update of pais, moneda on cuenta
  for each row execute function app.cuenta_moneda_valida();

-- -----------------------------------------------------------------------------
-- Permisos
--
-- Catálogo global sin RLS, igual que `plan` e `industria`: no pertenece a
-- ninguna cuenta y el control es el GRANT. La página pública lo lee sin token
-- —los países en los que operamos y su marco legal son material comercial—; el
-- operador es el único que escribe.
-- -----------------------------------------------------------------------------
grant select on pais to app_rw;
grant select, insert, update, delete on pais to app_operador;

commit;

-- Centinela de la 026: se agregó una tabla que el operador lee.
do $centinela$
declare v_expr text; v_tabla text; v_pol text; v_mal text := '';
begin
  for v_tabla, v_pol, v_expr in
    select c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid)
      from pg_policy p join pg_class c on c.oid = p.polrelid
     where p.polcmd in ('r','*')
       and has_table_privilege('app_operador', c.oid, 'select')
  loop
    if v_expr ~ '(^|[^a-z_])(circuito|instancia|ubicacion|archivo|participacion|otorgamiento|marca_firma)([^a-z_]|$)' then
      v_mal := v_mal || format(E'\n  %s.%s', v_tabla, v_pol);
    end if;
  end loop;
  if v_mal <> '' then
    raise exception E'Políticas que nombran tablas del dominio de firmas y le cobran el GRANT a app_operador:%s', v_mal;
  end if;
end $centinela$;
