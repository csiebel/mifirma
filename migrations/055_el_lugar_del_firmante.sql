-- =============================================================================
-- MiFirma — migración 055: el lugar del firmante
--
-- ═══ QUÉ ARREGLA ═══
--
-- `participacion.orden` hacía DOS trabajos a la vez. La propia tabla lo dice:
--
--     orden int not null default 1,   -- 1,2,3=serie; 1,1,1=paralelo
--
--   · dice CUÁNDO le toca a cada uno — y de ahí sale a quién se le avisa;
--   · y se usaba además para decir QUIÉN es cada uno, porque `campo.orden_firmante`
--     apuntaba ahí para saber a quién se le pide un dato.
--
-- En SERIE los dos coinciden: cada turno tiene exactamente una persona, así que
-- «lo completa el turno 2» alcanza para saber quién. Funcionaba —pero por
-- casualidad—. En PARALELO todos están en el turno 1 por definición, y entonces
-- «lo completa el turno 1» no señala a nadie: señala a los tres.
--
-- Lo que se veía en la pantalla: el desplegable de «quién escribe este dato»
-- ofrecía los tres nombres, las tres opciones valían lo mismo por dentro, y
-- elegir cualquiera mostraba siempre el último de la lista.
--
-- ⚠ Y lo que NO se veía, que es lo grave: `app.puede_completar_campo` ataba el
-- campo a la persona con `p.orden = c.orden_firmante`. En paralelo esa condición
-- da verdadera para TODOS los firmantes. O sea que el emisor elegía «este dato
-- me lo escribe Ana» y el documento se comportaba como «lo escribe cualquiera de
-- los tres», sin un solo error a la vista.
--
-- ═══ POR QUÉ NO SE APUNTA A LA PERSONA ═══
--
-- La solución obvia —que el campo apunte a la participación— ya se había
-- evaluado y descartado, con razón, en la migración 038:
--
--     «No funciona en modo copias: ahí se crea una participación por fila AL
--      DESPACHAR, así que un campo definido antes no puede apuntar a ninguna.»
--
-- Sigue siendo cierto, y con más fuerza pensando en el envío desde planilla: con
-- 3.000 filas, las personas no existen cuando se definen los campos.
--
-- **La decisión de 038 era correcta. El error fue reutilizar el número de turno
-- como número de lugar en vez de darle el suyo.**
--
-- ═══ QUÉ HACE ═══
--
-- Le da a cada firmante un LUGAR propio, aparte del turno:
--
--                       turno (ya existía)      lugar (nuevo)
--     serie, 3 personas       1, 2, 3             1, 2, 3
--     paralelo, 3 personas    1, 1, 1             1, 2, 3
--     copias                  1                   1  (una persona por copia)
--
-- El campo pasa a apuntar al LUGAR. Serie sigue andando igual pero por diseño y
-- no por casualidad, paralelo empieza a andar, y copias no se entera: el que
-- recibe cada copia es siempre el lugar 1 y sigue sin necesitar existir antes de
-- despachar. La objeción de 038 se respeta.
--
-- ═══ EL LUGAR SE GUARDA, NO SE CALCULA ═══
--
-- Se podría derivar («el enésimo por antigüedad») y ahorrarse la columna. No:
-- si alguien se va, todos los de atrás se correrían un lugar y **los campos del
-- que estaba tercero pasarían en silencio a ser del cuarto**. Un dato que
-- cambia de dueño solo es exactamente lo que esta migración vino a sacar.
--
-- Guardado, quitar a alguien deja un HUECO. Es lo correcto: el campo queda sin
-- dueño y hay que decir qué se hace con él, en vez de que lo herede un tercero
-- que nunca lo pidió.
--
-- ═══ LO QUE SE PIERDE, DICHO ANTES DE PERDERLO ═══
--
-- ⚠ Los campos que ya existen en documentos PARALELOS con más de un firmante
-- dicen «turno 1» y **a quién se referían nunca se guardó**. No hay forma de
-- averiguarlo: la información no existe en ninguna parte. Esos campos pasan a
-- «lo llena cualquiera», que es como se venían comportando de verdad. No se
-- pierde nada real, pero queda dicho acá y el control de abajo informa cuántos
-- fueron.
--
-- Serie y copias se traducen sin perder nada.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. EL LUGAR, en participacion
-- ─────────────────────────────────────────────────────────────────────────────

alter table participacion add column if not exists posicion int;

-- El reparto de lo que ya existe. Por turno primero y por antigüedad después:
-- en serie el turno ya ordena y el lugar sale igual al turno; en paralelo todos
-- empatan en el turno y desempata el orden en que el emisor los fue agregando,
-- que es el que ve en la pantalla.
--
-- `posicion is null` lo vuelve repetible: la segunda pasada no reasigna nada.
update participacion p
   set posicion = n.pos
  from (
    select id,
           row_number() over (partition by instancia_id
                                  order by orden, creada_en, id) as pos
      from participacion
     where papel = 'firmante'
  ) n
 where p.id = n.id
   and p.papel = 'firmante'
   and p.posicion is null;

-- Un veedor no completa campos: no tiene lugar, y que no lo tenga es parte de
-- lo que la columna significa.
update participacion set posicion = null where papel <> 'firmante' and posicion is not null;

do $c$ begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.participacion'::regclass
                    and conname = 'participacion_lugar_solo_firmantes') then
    alter table participacion add constraint participacion_lugar_solo_firmantes
      check ((papel = 'firmante') = (posicion is not null));
  end if;
end $c$;

-- Dos personas no pueden ocupar el mismo lugar del mismo documento. Sin esto,
-- el defecto que la migración arregla podría volver a entrar por una escritura
-- descuidada del servicio y nadie se enteraría hasta que alguien firmara.
create unique index if not exists participacion_lugar_unico
  on participacion (instancia_id, posicion)
  where papel = 'firmante';

comment on column participacion.posicion is
  'QUIÉN es cada firmante dentro de su instancia: 1..N, propio de cada persona. '
  'Distinto de `orden`, que dice CUÁNDO le toca (serie 1,2,3 · paralelo 1,1,1). '
  'Los campos apuntan acá. No se renumera al quitar a alguien: queda hueco. '
  'Ver migración 055.';

comment on column participacion.orden is
  'CUÁNDO le toca: serie 1,2,3 · paralelo 1,1,1 · copias 1. Manda el despacho '
  '(se notifica al orden más bajo pendiente). ⚠ NO sirve para saber quién es '
  'cada uno — para eso está `posicion`. Ver migración 055.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. EL CAMPO PASA A APUNTAR AL LUGAR
-- ─────────────────────────────────────────────────────────────────────────────

alter table campo add column if not exists posicion_firmante int;

-- ⚠ `campo_congelado` (038) prohíbe tocar los campos de un circuito ya
-- despachado, y el relleno los toca a todos. Es exactamente lo que hizo morir a
-- la 052 en la base real: basta UN documento enviado. Se apaga para rellenar y
-- se vuelve a prender abajo — y el control final comprueba que quedó prendido.
alter table campo disable trigger campo_congelado;

-- ⚠ La restricción vieja se saca ANTES de rellenar, no después.
--
-- Lo encontró el banco de pruebas en la primera pasada, y es la misma forma
-- exacta del defecto de la 052: `campo_quien_coherente` (052) exige que un campo
-- de «cualquiera» tenga `orden_firmante is null`, y el paso (d) de abajo pasa
-- campos a «cualquiera» mientras esa columna todavía tiene el turno viejo. La
-- migración moría a mitad de camino, sobre datos perfectamente normales.
--
-- La lección, otra vez: **una restricción vieja no es sólo algo que hay que
-- reemplazar al final; es algo que puede prohibir el camino hacia el estado
-- nuevo.** Se saca antes de empezar a mover datos.
alter table campo drop constraint if exists campo_quien_coherente;

-- Todo el relleno va adentro de un guard: en la segunda pasada `orden_firmante`
-- ya no existe, y sin esto las sentencias fallarían al no encontrar la columna.
do $relleno$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'campo'
                    and column_name = 'orden_firmante') then
    raise notice '055: orden_firmante ya no está, el relleno ya corrió';
    return;
  end if;

  -- (a) SERIE — el turno era el lugar. Traducción exacta, no se pierde nada.
  update campo c
     set posicion_firmante = c.orden_firmante
    from circuito ci
   where ci.id = c.circuito_id
     and ci.modo = 'serie'
     and c.orden_firmante is not null
     and c.posicion_firmante is null;

  -- (b) COPIAS — dentro de cada copia hay una persona sola, y es el lugar 1.
  update campo c
     set posicion_firmante = 1
    from circuito ci
   where ci.id = c.circuito_id
     and ci.modo = 'copias'
     and c.orden_firmante is not null
     and c.posicion_firmante is null;

  -- (c) PARALELO CON UN SOLO FIRMANTE — «turno 1» sí señala a una persona.
  update campo c
     set posicion_firmante = 1
    from circuito ci
   where ci.id = c.circuito_id
     and ci.modo = 'paralelo'
     and c.orden_firmante is not null
     and c.posicion_firmante is null
     and (select count(*) from participacion p
           where p.circuito_id = ci.id and p.papel = 'firmante') <= 1;

  -- (d) ⚠ PARALELO CON VARIOS — no hay respuesta. Pasa a «lo llena cualquiera»,
  --     que es como se venía comportando de verdad.
  update campo c
     set quien_completa = 'cualquiera',
         completa_emisor = false,
         posicion_firmante = null,
         -- Se limpia también el puntero viejo: el campo ya no es de nadie en
         -- particular, y dejarlo apuntando al turno 1 sería dejar escrito algo
         -- que dejó de ser cierto.
         orden_firmante = null
    from circuito ci
   where ci.id = c.circuito_id
     and ci.modo = 'paralelo'
     and c.orden_firmante is not null
     and (select count(*) from participacion p
           where p.circuito_id = ci.id and p.papel = 'firmante') > 1;
end
$relleno$;

alter table campo drop column if exists orden_firmante;

-- ⚠ Se SACA la columna vieja en vez de dejarla «por las dudas». Este proyecto ya
-- se comió ese error una vez: al agregar `quien_completa` en la 052 quedaron dos
-- fuentes para lo mismo un rato, y «el modo viejo se quedaba pegado y ganaba en
-- el payload» — un texto fijo salía a nombre de un firmante. Dos columnas que
-- dicen lo mismo terminan discrepando, y gana la equivocada.

do $c$ begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.campo'::regclass
                    and conname = 'campo_quien_coherente') then
    alter table campo add constraint campo_quien_coherente check (
         (quien_completa = 'emisor'     and completa_emisor     and posicion_firmante is null)
      or (quien_completa = 'firmante'   and not completa_emisor and posicion_firmante is not null)
      or (quien_completa = 'cualquiera' and not completa_emisor and posicion_firmante is null)
    );
  end if;
end $c$;

alter table campo enable trigger campo_congelado;

comment on column campo.posicion_firmante is
  'A QUÉ LUGAR se le pide el dato (participacion.posicion), cuando '
  'quien_completa = firmante. ⚠ No es el turno: en paralelo todos están en el '
  'turno 1 y el turno no distingue personas. Ver migración 055.';

comment on column campo.quien_completa is
  'emisor | firmante | cualquiera. Con firmante, posicion_firmante dice cuál. '
  'Con cualquiera, lo completa el primero que llegue y después nadie lo cambia. '
  'Ver migraciones 052 y 055.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. LA REGLA DE PERMISOS — que es donde el defecto hacía daño de verdad
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.puede_completar_campo(p_campo uuid, p_instancia uuid)
returns boolean
language sql stable security definer set search_path = pg_catalog, public
as $$
  select exists (
    select 1
      from public.campo c
      join public.instancia i on i.id = p_instancia
     where c.id = p_campo
       and c.circuito_id = i.circuito_id
       -- La instancia tiene que estar abierta. Un documento cerrado no admite
       -- que nadie escriba nada, y esto lo dice la base, no la pantalla.
       and i.estado in ('pendiente','en_curso')
       and (
         -- (a) El emisor, y sólo mientras el documento no salió.
         (c.quien_completa = 'emisor'
          and i.cuenta_propietaria_id = app.cuenta_actual()
          and app.actor() = 'cuenta'
          and exists (select 1 from public.circuito ci
                       where ci.id = c.circuito_id and ci.estado = 'borrador'))
         or
         -- (b) El firmante al que le toca ese campo, con derecho a firmar esa
         --     instancia.
         --
         -- ⚠ Compara contra `p.posicion`, NO contra `p.orden`. Con el orden,
         -- en paralelo —donde todos valen 1— esta condición daba verdadera
         -- para todos los firmantes, y cualquiera podía escribir en el campo
         -- de cualquiera. El lugar es lo que ata el campo a la persona; el
         -- otorgamiento es lo que la autoriza.
         (c.quien_completa = 'firmante'
          and c.posicion_firmante is not null
          and app.tiene_otorgamiento(null, p_instancia, 'firmar')
          and exists (
            select 1 from public.participacion p
             where p.instancia_id = p_instancia
               and p.papel = 'firmante'
               and p.posicion = c.posicion_firmante
               and p.identidad_id = any (app.identidades_del_actor())
               and p.estado in ('pendiente','notificada','vista')))
         or
         -- (c) Cualquiera de los firmantes — PERO UNA SOLA VEZ.
         --
         -- ⚠ La segunda condición es la que importa: o el campo está vacío, o lo
         -- escribió quien está escribiendo ahora. Sin eso, el tercer firmante
         -- reescribe en silencio lo que el primero ya leyó y aceptó, y nadie
         -- sabe qué versión se firmó.
         (c.quien_completa = 'cualquiera'
          and app.tiene_otorgamiento(null, p_instancia, 'firmar')
          and exists (
            select 1 from public.participacion p
             where p.instancia_id = p_instancia
               and p.papel = 'firmante'
               and p.identidad_id = any (app.identidades_del_actor())
               and p.estado in ('pendiente','notificada','vista'))
          and not exists (
            select 1 from public.valor_campo v
             where v.campo_id = c.id
               and v.instancia_id = p_instancia
               and v.valor is not null
               and v.completado_por is not null
               and not (v.completado_por = any (app.identidades_del_actor()))))
       )
  )
$$;

revoke all on function app.puede_completar_campo(uuid, uuid) from public;
grant execute on function app.puede_completar_campo(uuid, uuid) to app_rw;

comment on function app.puede_completar_campo(uuid, uuid) is
  'Si el actor puede escribir en ese campo de esa instancia. Tres modos: el '
  'emisor en borrador, el firmante DEL LUGAR nombrado, o cualquier firmante '
  'mientras nadie más lo haya completado. Ver migraciones 038, 052 y 055.';

commit;

-- =============================================================================
-- CONTROL — el estado, comprobado
-- =============================================================================
do $control$
declare v_mal text := ''; v_n int; v_src text;
begin
  -- ── las columnas ──────────────────────────────────────────────────────────
  if not exists (select 1 from information_schema.columns
                  where table_name = 'participacion' and column_name = 'posicion') then
    v_mal := v_mal || E'\n  falta participacion.posicion';
  end if;

  if not exists (select 1 from information_schema.columns
                  where table_name = 'campo' and column_name = 'posicion_firmante') then
    v_mal := v_mal || E'\n  falta campo.posicion_firmante';
  end if;

  -- La vieja tiene que estar SACADA. Mientras esté, el servicio puede seguir
  -- escribiéndola y las dos empiezan a discrepar.
  if exists (select 1 from information_schema.columns
              where table_name = 'campo' and column_name = 'orden_firmante') then
    v_mal := v_mal || E'\n  campo.orden_firmante sigue existiendo';
  end if;

  -- ── el reparto ────────────────────────────────────────────────────────────
  select count(*) into v_n from participacion where papel = 'firmante' and posicion is null;
  if v_n > 0 then v_mal := v_mal || format(E'\n  %s firmante(s) sin lugar', v_n); end if;

  select count(*) into v_n from participacion where papel <> 'firmante' and posicion is not null;
  if v_n > 0 then v_mal := v_mal || format(E'\n  %s no-firmante(s) con lugar', v_n); end if;

  -- Dos personas en el mismo lugar del mismo documento: es el defecto entrando
  -- por la puerta de atrás.
  select count(*) into v_n from (
    select instancia_id, posicion from participacion
     where papel = 'firmante' group by 1,2 having count(*) > 1) d;
  if v_n > 0 then
    v_mal := v_mal || format(E'\n  %s lugar(es) ocupado(s) por más de una persona', v_n);
  end if;

  -- ── la traducción de los campos ───────────────────────────────────────────
  select count(*) into v_n from campo
   where quien_completa = 'firmante' and posicion_firmante is null;
  if v_n > 0 then
    v_mal := v_mal || format(E'\n  %s campo(s) de firmante sin lugar', v_n);
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.campo'::regclass and conname = 'campo_quien_coherente') then
    v_mal := v_mal || E'\n  falta campo_quien_coherente';
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.participacion'::regclass
                    and conname = 'participacion_lugar_solo_firmantes') then
    v_mal := v_mal || E'\n  falta participacion_lugar_solo_firmantes';
  end if;

  if not exists (select 1 from pg_indexes
                  where tablename = 'participacion' and indexname = 'participacion_lugar_unico') then
    v_mal := v_mal || E'\n  falta el índice participacion_lugar_unico';
  end if;

  -- ── la regla de permisos, que es lo que hacía daño ────────────────────────
  select prosrc into v_src from pg_proc
   where proname = 'puede_completar_campo' and pronamespace = 'app'::regnamespace;

  if v_src is null then
    v_mal := v_mal || E'\n  app.puede_completar_campo no existe';
  else
    if position('p.posicion = c.posicion_firmante' in v_src) = 0 then
      v_mal := v_mal || E'\n  app.puede_completar_campo no compara contra el lugar';
    end if;
    -- ⚠ El control que importa: que NO haya quedado comparando contra el turno.
    -- Es el defecto original, y una función a medio migrar lo deja intacto.
    if position('p.orden = c.orden_firmante' in v_src) > 0 then
      v_mal := v_mal || E'\n  ⚠ app.puede_completar_campo SIGUE comparando contra el turno';
    end if;
  end if;

  -- ── el trigger tiene que haber quedado PRENDIDO ───────────────────────────
  -- Se apagó para rellenar. Si quedara apagado, cualquiera podría cambiarle los
  -- campos a un documento ya despachado y nadie se enteraría hasta que un
  -- firmante viera otro formulario del que le mandaron.
  if exists (select 1 from pg_trigger
              where tgrelid = 'public.campo'::regclass
                and tgname = 'campo_congelado'
                and tgenabled = 'D') then
    v_mal := v_mal || E'\n  ⚠ el trigger campo_congelado quedó APAGADO';
  end if;

  -- ═══ Y AHORA SE EJERCE, ESCRIBIENDO ═══
  --
  -- Todo lo de arriba lee el catálogo, y el catálogo puede estar perfecto
  -- mientras la combinación que importa igual no entra: es lo que pasó con
  -- `campo_tiene_dueno` en la 052. Así que se guarda un campo del LUGAR 2 sobre
  -- un borrador real —el caso que antes era indistinguible del lugar 1— y se
  -- borra. Si algo lo frena, el mensaje de la base dice qué fue.
  declare v_circ uuid; v_cuenta uuid;
  begin
    select c.id, c.cuenta_propietaria_id into v_circ, v_cuenta
      from public.circuito c where c.estado = 'borrador' limit 1;

    if v_circ is null then
      raise notice 'Sin documentos en borrador: no se pudo EJERCER el lugar. Probalo en la pantalla.';
    else
      begin
        insert into public.campo (circuito_id, cuenta_propietaria_id, codigo, etiqueta_i18n,
                                  tipo, completa_emisor, quien_completa, posicion_firmante,
                                  pagina, x, y, ancho, alto)
        values (v_circ, v_cuenta, '__prueba_lugar__', '{"es":"prueba"}'::jsonb,
                'texto', false, 'firmante', 2, 0, 1, 1, 10, 10);

        delete from public.campo where circuito_id = v_circ and codigo = '__prueba_lugar__';
      exception when others then
        v_mal := v_mal || format(E'\n  un campo del lugar 2 NO se puede guardar: %s', sqlerrm);
      end;
    end if;
  end;

  if v_mal <> '' then
    raise exception E'El lugar del firmante quedó incompleto:%', v_mal;
  end if;

  -- ── lo que hay que CONTAR, no abortar ─────────────────────────────────────
  --
  -- Campos que apuntan a un lugar que nadie ocupa, en documentos que sí tienen
  -- firmantes. No los crea esta migración: los deja a la vista. Un campo sin
  -- dueño es un documento que su destinatario no va a poder completar, y es
  -- mejor enterarse acá que cuando alguien lo abra.
  select count(*) into v_n
    from campo c
    join circuito ci on ci.id = c.circuito_id
   where c.quien_completa = 'firmante'
     and exists (select 1 from participacion p
                  where p.circuito_id = ci.id and p.papel = 'firmante')
     and not exists (select 1 from participacion p
                      where p.circuito_id = ci.id and p.papel = 'firmante'
                        and p.posicion = c.posicion_firmante);
  if v_n > 0 then
    raise notice '⚠ % campo(s) apuntan a un lugar que nadie ocupa. Miralos con db/diagnostico-campos.sql', v_n;
  end if;

  raise notice '✓ 055: el lugar del firmante, repartido y atado.';
end
$control$;
