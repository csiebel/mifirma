-- =============================================================================
-- MiFirma — 082_los_topes_por_plan.sql
-- Los cuatro límites que pidió Claudio, como una sola pieza.
--
-- ═══ LO QUE CIERRA ═══
--
-- Claudio, el 14/9: tope de usuarios por tipo, de firmas por tipo, de documentos
-- guardados, y el criterio de cobro al superarlos. Hasta hoy el producto tenía
-- tres pedazos de eso, en tres lugares, y ninguno decía qué hacer al llegar:
--
--   · `precio_metrica.cantidad_incluida` (072) — cuántas NO SE COBRAN
--   · `billing_config.tope_excedente` (019)   — cuántas de más se permiten, sólo
--                                               de firmas, y sólo frenando
--   · `plan_custodia.tope_documentos/bytes`   — cuánto se puede guardar, sin
--                                               decir qué pasa al llegar
--
-- ⚠⚠ Y la distinción que estaba mezclada y hay que tener presente para leer esta
-- migración: **«incluidas» y «tope» no son lo mismo.** Incluidas es hasta dónde
-- no se cobra; tope es hasta dónde se puede. Un plan puede tener 500 firmas
-- incluidas y un tope de 1.000: entre 500 y 1.000 se cobra excedente, y en 1.000
-- se frena. Los cuatro límites de Claudio son de la segunda clase.
--
-- ═══ LAS TRES DECISIONES DE CLAUDIO (15/9/2026) ═══
--
--   1. LOS TIPOS DE USUARIO SON LOS ROLES plantilla: admin, emisor y lector.
--   2. QUÉ PASA AL LLEGAR LO ELIGE EL OPERADOR, TOPE POR TOPE: avisar, cobrar el
--      excedente, o frenar.
--   3. QUIEN YA ESTÁ POR ENCIMA SE CONGELA: no puede agregar, y lo que ya existe
--      sigue funcionando.
--
-- ⚠⚠ La tercera es la que más ordena todo, y vale más allá de los usuarios:
-- **FRENAR NUNCA QUITA LO QUE YA EXISTE.** Un documento firmado no se borra
-- porque el cliente cambió de plan; un usuario no se desconecta de un día para
-- el otro por una decisión comercial. Frenar sólo impide AGREGAR. Es la regla D3
-- del diseño del 30/7 —la deuda del emisor nunca toca lo firmado— aplicada a los
-- topes.
--
-- ═══ ⚠ POR QUÉ EL ALMACENAMIENTO NO SE MUDA ACÁ ═══
--
-- El diseño decía mudar `plan_custodia.tope_documentos` y `tope_bytes` a esta
-- tabla. Al ir a hacerlo se midió quién los lee: **seis archivos de código y dos
-- pantallas**, incluida la edición del plan en la consola del operador.
--
-- Mudarlos habría roto todo eso para ganar prolijidad. Entonces: **el NÚMERO
-- sigue viviendo en `plan_custodia`** —una sola verdad, sin duplicar— y esta
-- tabla aporta para esos dos conceptos lo único que hoy no existe: **qué pasa al
-- llegar y cuándo avisar**. `app.tope_efectivo` los junta.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- =============================================================================
-- 1. LA TABLA
-- =============================================================================
create table if not exists plan_tope (
  id            uuid primary key default gen_random_uuid(),

  -- Cascada conocida: (plan) es el nivel base del operador; `cuenta_id` es el
  -- override de un cliente puntual. «Volver a heredar» es borrar el override.
  plan_id       uuid references plan(id) on delete cascade,
  cuenta_id     uuid references cuenta(id) on delete cascade,

  concepto      text not null check (concepto in (
                  'usuarios',
                  'firma', 'circuito_despachado', 'documento_completado',
                  'sms', 'whatsapp', 'sello_tsa', 'verificacion_identidad',
                  'asistente_ia',
                  'almacenamiento_documentos', 'almacenamiento_mb')),

  -- Sólo para 'usuarios': sobre qué rol pesa el tope. NULL = el total de la
  -- empresa, sin distinguir.
  -- ⚠ Los códigos son los de `ROLES_BASE` en `src/admin/provisioning.ts`, que es
  -- donde se crean los roles de cada empresa nueva. Si alguna vez el operador
  -- puede definir tipos nuevos, esto pasa a ser una FK a un catálogo.
  rol_codigo    text check (rol_codigo in ('admin','emisor','lector')),

  -- Sólo para 'firma': un tope por tipo de firma, que es lo que Claudio pidió.
  nivel_firma   text check (nivel_firma in ('simple','avanzada')),

  tope          numeric(14,4) not null check (tope >= 0),

  -- ── Qué hace el sistema al llegar (decisión 2)
  --
  -- ⚠ El default es `frenar` y no es arbitrario: un tope que por omisión deja
  -- pasar y cobra es una factura sorpresa esperando a ocurrir. Quien quiera
  -- vender excedente lo dice.
  al_llegar     text not null default 'frenar'
                  check (al_llegar in ('avisar','cobrar_excedente','frenar')),

  -- Cómo se cobra lo que pasa del tope. Palabras de Claudio: «por usuario
  -- adicional o por x cantidad de usuarios».
  excedente_modo   text not null default 'por_unidad'
                     check (excedente_modo in ('por_unidad','por_bloque')),
  excedente_bloque int check (excedente_bloque is null or excedente_bloque > 0),

  -- Avisar antes de llegar: 80 = al usar el 80% del tope.
  umbral_aviso_pct int check (umbral_aviso_pct is null
                              or (umbral_aviso_pct > 0 and umbral_aviso_pct < 100)),

  vigente_desde date not null default current_date,
  vigente_hasta date,
  creado_en     timestamptz not null default now(),
  creado_por    uuid,

  constraint tope_nivel_coherente check (
    (cuenta_id is null and plan_id is not null) or (cuenta_id is not null)),
  -- Cobrar por bloque sin decir de cuánto es el bloque es un tope que no sabe
  -- cobrar; y un bloque sin cobrar por bloque es un número que no hace nada.
  constraint tope_bloque_coherente check (
    (excedente_modo = 'por_bloque') = (excedente_bloque is not null)),
  constraint tope_rol_solo_usuarios check (rol_codigo is null or concepto = 'usuarios'),
  constraint tope_nivel_solo_firma  check (nivel_firma is null or concepto = 'firma'),
  constraint tope_vigencia_coherente check (vigente_hasta is null or vigente_hasta >= vigente_desde)
);

-- Un solo tope vigente por combinación. `coalesce` porque dos NULL no son
-- iguales en SQL, y sin eso se podrían cargar cinco topes «de cualquier rol».
create unique index if not exists tope_plan_uq
  on plan_tope (plan_id, concepto, coalesce(rol_codigo,''), coalesce(nivel_firma,''))
  where cuenta_id is null and vigente_hasta is null;
create unique index if not exists tope_cuenta_uq
  on plan_tope (cuenta_id, concepto, coalesce(rol_codigo,''), coalesce(nivel_firma,''))
  where cuenta_id is not null and vigente_hasta is null;

comment on table plan_tope is
  'Hasta dónde puede llegar un cliente en cada concepto, y qué pasa cuando llega. '
  'NO confundir con `precio_metrica.cantidad_incluida`, que es hasta dónde no se cobra. '
  'Cascada: override de cuenta gana sobre el plan. Migración 082.';

-- =============================================================================
-- 2. EL TOPE EFECTIVO, CON SU CASCADA
--
-- ⚠ Para los dos conceptos de almacenamiento el NÚMERO sale de `plan_custodia`
-- (ver la cabecera), y de acá sale sólo el comportamiento. Si no hay fila en
-- `plan_tope` para ellos, el comportamiento por omisión es `frenar` — que para
-- un depósito significa «no se puede subir más», nunca «se borra algo».
-- =============================================================================
create or replace function app.tope_efectivo(
  p_cuenta uuid, p_concepto text, p_rol text default null, p_nivel text default null)
returns table (
  tope             numeric,
  al_llegar        text,
  excedente_modo   text,
  excedente_bloque int,
  umbral_aviso_pct int,
  origen           text
)
language plpgsql stable security definer set search_path = pg_catalog, public
as $$
declare
  v_plan uuid;
  r      record;
  v_cust record;
begin
  select s.plan_id into v_plan
    from public.suscripcion s
   where s.cuenta_id = p_cuenta and s.estado = 'activa'
   order by s.inicio desc limit 1;

  -- El override de la cuenta gana sobre el del plan. Es la cascada de todo el
  -- billing (019 §1).
  select t.* into r
    from public.plan_tope t
   where t.vigente_hasta is null
     and t.concepto = p_concepto
     and t.rol_codigo is not distinct from p_rol
     and t.nivel_firma is not distinct from p_nivel
     and (t.cuenta_id = p_cuenta or (t.cuenta_id is null and t.plan_id = v_plan))
   order by (t.cuenta_id is not null) desc
   limit 1;

  if p_concepto in ('almacenamiento_documentos', 'almacenamiento_mb') then
    select * into v_cust from app.custodia_de_cuenta(p_cuenta);
    -- Sólo el modo `con_tope` topea: `sin_tope` es sin límite y `sin_custodia`
    -- no guarda nada, que no es lo mismo que un tope de cero.
    if v_cust.modo is distinct from 'con_tope' then
      return;
    end if;
    tope := case p_concepto
              when 'almacenamiento_documentos' then v_cust.tope_documentos::numeric
              else round(v_cust.tope_bytes / 1048576.0, 4) end;
    if tope is null then return; end if;
    al_llegar        := coalesce(r.al_llegar, 'frenar');
    excedente_modo   := coalesce(r.excedente_modo, 'por_unidad');
    excedente_bloque := r.excedente_bloque;
    umbral_aviso_pct := r.umbral_aviso_pct;
    origen           := case when r.id is null then 'custodia'
                             when r.cuenta_id is not null then 'custodia+cuenta'
                             else 'custodia+plan' end;
    return next;
    return;
  end if;

  if r.id is null then return; end if;   -- sin tope configurado: no limita nada

  tope             := r.tope;
  al_llegar        := r.al_llegar;
  excedente_modo   := r.excedente_modo;
  excedente_bloque := r.excedente_bloque;
  umbral_aviso_pct := r.umbral_aviso_pct;
  origen           := case when r.cuenta_id is not null then 'cuenta' else 'plan' end;
  return next;
end $$;
revoke all on function app.tope_efectivo(uuid, text, text, text) from public;
grant execute on function app.tope_efectivo(uuid, text, text, text) to app_rw, app_operador;

-- =============================================================================
-- 3. EL USO, QUE SE MIDE DISTINTO SEGÚN LA NATURALEZA DEL CONCEPTO
--
-- ⚠⚠ Es el corazón de este bloque, y lo que el diseño de ayer dejó planteado:
--
--   · FOTO (usuarios): cuántos hay AHORA. No se reinicia nunca: es un estado.
--   · CAUDAL (firmas, mensajes, sellos, circuitos, documentos, identidad, IA):
--     cuánto va EN EL PERÍODO. Se reinicia cada mes.
--   · DEPÓSITO (almacenamiento): cuánto hay guardado AHORA. No se reinicia
--     nunca, y sólo crece.
--
-- Medir un usuario como caudal haría que los dados de baja siguieran contando;
-- medir el disco como caudal lo reiniciaría cada mes y el tope no apretaría
-- jamás. No son detalles: son el tope entero.
-- =============================================================================
create or replace function app.uso_de(
  p_cuenta uuid, p_concepto text, p_rol text default null, p_nivel text default null)
returns numeric
language plpgsql stable security definer set search_path = pg_catalog, public
as $$
declare v_n numeric; v_cust record;
begin
  if p_concepto = 'usuarios' then
    -- FOTO. Con rol, los que tienen ESE rol; sin rol, las personas distintas.
    if p_rol is null then
      select count(distinct ur.identidad_id) into v_n
        from public.usuario_rol ur where ur.cuenta_id = p_cuenta;
    else
      select count(distinct ur.identidad_id) into v_n
        from public.usuario_rol ur
        join public.rol r on r.id = ur.rol_id
       where ur.cuenta_id = p_cuenta and r.codigo = p_rol;
    end if;
    return coalesce(v_n, 0);
  end if;

  if p_concepto in ('almacenamiento_documentos', 'almacenamiento_mb') then
    -- DEPÓSITO.
    select * into v_cust from app.custodia_usada(p_cuenta);
    return case p_concepto
             when 'almacenamiento_documentos' then coalesce(v_cust.documentos, 0)::numeric
             else round(coalesce(v_cust.bytes, 0) / 1048576.0, 4) end;
  end if;

  -- CAUDAL. Del período corriente, y contando TODAS —cobradas o no—: si se
  -- contaran sólo las cobradas, lo incluido en el plan no gastaría tope y el
  -- límite no serviría de nada. Es la hermana de la trampa que agarró el ejerce
  -- de la 076.
  select coalesce(sum(e.cantidad), 0) into v_n
    from public.evento_medible e
   where e.cuenta_id = p_cuenta
     and e.periodo = to_char(now(), 'YYYY-MM')
     and e.tipo = p_concepto
     and (p_nivel is null or e.nivel_firma = p_nivel);
  return coalesce(v_n, 0);
end $$;
revoke all on function app.uso_de(uuid, text, text, text) from public;
grant execute on function app.uso_de(uuid, text, text, text) to app_rw, app_operador;

-- =============================================================================
-- 4. LA PUERTA ÚNICA: ¿PUEDE HACER ESTO, Y QUÉ PASA SI LO HACE?
--
-- ⚠ DEVUELVE, NO LANZA. Quien llama decide si contesta 402, si muestra un aviso
-- o si sigue de largo. Una función que lanza obliga a todos los llamadores a
-- atrapar, y el que se olvide tumba algo que no tenía por qué tumbarse.
--
-- ⚠⚠ Y LO QUE YA EXISTE NUNCA SE TOCA (decisión 3): esto se pregunta ANTES de
-- agregar algo. Si la respuesta es que no, lo que hay sigue exactamente igual.
-- =============================================================================
create or replace function app.control_de_tope(
  p_cuenta   uuid,
  p_concepto text,
  p_cuantos  numeric default 1,
  p_rol      text default null,
  p_nivel    text default null)
returns table (
  permitido  boolean,
  motivo     text,
  tope       numeric,
  uso        numeric,
  al_llegar  text,
  excedente  numeric,
  avisar     boolean
)
language plpgsql stable security definer set search_path = pg_catalog, public
as $$
declare t record; v_uso numeric; v_despues numeric; v_exceso numeric;
begin
  select * into t from app.tope_efectivo(p_cuenta, p_concepto, p_rol, p_nivel);

  -- Sin tope configurado no se limita nada. ⚠ Es deliberado: los clientes que ya
  -- están no pueden quedarse sin servicio porque apareció una tabla nueva.
  if t.tope is null then
    permitido := true; motivo := 'sin_tope'; avisar := false;
    excedente := 0; return next; return;
  end if;

  v_uso     := app.uso_de(p_cuenta, p_concepto, p_rol, p_nivel);
  v_despues := v_uso + coalesce(p_cuantos, 0);
  v_exceso  := greatest(v_despues - t.tope, 0);

  tope := t.tope; uso := v_uso; al_llegar := t.al_llegar;

  -- El aviso mira dónde queda DESPUÉS, no dónde estaba: avisar cuando ya se pasó
  -- es llegar tarde.
  avisar := t.umbral_aviso_pct is not null
            and t.tope > 0
            and v_despues >= t.tope * t.umbral_aviso_pct / 100.0;

  if v_exceso <= 0 then
    permitido := true; motivo := 'dentro_del_tope'; excedente := 0;
    return next; return;
  end if;

  if t.al_llegar = 'frenar' then
    -- ⚠ No se quita nada de lo que ya hay: sólo no se agrega. Si el cliente ya
    -- estaba por encima (le bajaron el plan), sigue trabajando con lo que tiene.
    permitido := false;
    -- ⚠ Estrictamente MAYOR. Estar JUSTO en el tope no es estar por encima: el
    -- que está en 10 de 10 llegó al límite usando lo suyo, y el que está en 12 de
    -- 10 quedó ahí porque le bajaron el plan. Son dos mensajes distintos para el
    -- cliente, y con `>=` los dos decían lo segundo. Lo agarró el ejerce.
    motivo    := case when v_uso > t.tope then 'ya_estaba_por_encima' else 'tope_alcanzado' end;
    excedente := 0;
    return next; return;
  end if;

  -- Deja pasar. Con `cobrar_excedente` se dice CUÁNTO se cobra de más; con
  -- `avisar`, se deja pasar sin cobrar.
  permitido := true;
  motivo    := case when t.al_llegar = 'avisar' then 'pasa_con_aviso' else 'pasa_con_excedente' end;
  excedente := case
    when t.al_llegar <> 'cobrar_excedente' then 0
    when t.excedente_modo = 'por_bloque'
      -- Se cobra el bloque entero apenas se entra en él: un bloque empezado es
      -- un bloque vendido, que es como se vende por paquetes en todos lados.
      then ceil(v_exceso / t.excedente_bloque::numeric)
    else v_exceso end;
  avisar := true;   -- pasarse siempre se avisa, haya umbral o no
  return next;
end $$;
revoke all on function app.control_de_tope(uuid, text, numeric, text, text) from public;
grant execute on function app.control_de_tope(uuid, text, numeric, text, text) to app_rw, app_operador;

comment on function app.control_de_tope(uuid, text, numeric, text, text) is
  'La puerta única de los topes: se pregunta ANTES de agregar algo. Devuelve si se puede, '
  'cuánto excedente se cobraría y si hay que avisar. NO lanza. Migración 082.';

-- =============================================================================
-- 5. RLS
--
-- `plan_tope` sin `cuenta_id` es lista de precios: se publica, como
-- `precio_metrica`. Con `cuenta_id` es el trato que se le dio a UN cliente, y eso
-- es del operador y de esa cuenta.
-- =============================================================================
alter table plan_tope enable row level security;
drop policy if exists tope_select on plan_tope;
drop policy if exists tope_escritura on plan_tope;
create policy tope_select on plan_tope for select using (
     cuenta_id is null
  or app.actor() in ('operador','sistema')
  or (app.actor() = 'cuenta' and cuenta_id = app.cuenta_actual())
);
create policy tope_escritura on plan_tope for all
  using (app.actor() = 'operador') with check (app.actor() = 'operador');

grant select on plan_tope to app_rw;
grant select, insert, update, delete on plan_tope to app_operador;

-- =============================================================================
-- 6. CENTINELAS
-- =============================================================================
do $centinela$
declare v_mal int;
begin
  -- Una cuenta no puede escribirse su propio tope: sería elegir su propio límite.
  if exists (select 1 from information_schema.role_table_grants
              where table_name = 'plan_tope' and grantee = 'app_rw'
                and privilege_type in ('INSERT','UPDATE','DELETE')) then
    raise exception 'app_rw no escribe topes: los pone el operador';
  end if;

  -- Ningún tope puede haber quedado con rol sobre algo que no son usuarios.
  select count(*) into v_mal from plan_tope
   where rol_codigo is not null and concepto <> 'usuarios';
  if v_mal > 0 then
    raise exception '% tope(s) con rol sobre un concepto que no son usuarios', v_mal;
  end if;

  -- Y las funciones tienen que existir con una sola firma cada una.
  select count(*) into v_mal from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app' and p.proname in ('tope_efectivo','uso_de','control_de_tope');
  if v_mal <> 3 then
    raise exception 'Quedaron % funciones de topes y tienen que ser 3', v_mal;
  end if;
end $centinela$;

commit;
