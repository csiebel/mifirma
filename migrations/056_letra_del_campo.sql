-- =============================================================================
-- MiFirma — migración 056: cómo se ve el valor de un campo
--
-- ═══ QUÉ AGREGA ═══
--
-- Dos columnas en `campo`: el CUERPO de la letra y el COLOR con que se dibuja
-- el valor. Las dos aceptan null, y null significa lo que se hace hoy:
--
--   · cuerpo null → se calcula para que entre en el recuadro. Es lo mismo que
--     hace Acrobat cuando el tamaño es «auto», y sigue siendo lo correcto por
--     omisión: el emisor dibuja una caja y el dato se acomoda solo.
--   · color null  → la tinta de siempre.
--
-- ⚠ Que null signifique «como hasta ahora» no es prolijidad: es lo que hace que
-- esta migración no cambie ni un pixel de ningún documento existente. Un
-- default distinto de null habría redibujado campos de documentos en curso.
--
-- ═══ POR QUÉ NO SE GUARDA EL TIPO DE LETRA ═══
--
-- Se evaluó y se dejó afuera A PROPÓSITO, no por falta de tiempo. El dibujante
-- mide el ancho del texto con una tabla de Helvetica escrita a mano
-- (`anchoHelvetica`), y esa medida es la que decide si la letra hay que
-- achicarla para que entre y dónde queda la línea de base. Otra fuente necesita
-- su propia tabla, y si está mal **no se rompe nada visible**: el texto se sale
-- del recuadro o queda corrido, en un documento ya firmado.
--
-- Y hay un segundo motivo, peor: un PDF no embebe la fuente entera, embebe
-- SÓLO las letras que ese documento usa. Reusar la fuente del formulario del
-- cliente para escribir lo que completa el firmante puede salir con huecos
-- —una «ñ» que el original nunca escribió— y falla del peor modo posible: bien
-- en un lector, en blanco en otro, sobre algo firmado.
--
-- Ese trabajo es el mismo que va a exigir la cobertura de alfabetos que
-- WinAnsi no cubre (chino, árabe, cirílico). Conviene hacerlo una vez.
--
-- ═══ EL COLOR SE GUARDA EN HEXA, NO EN TRES NÚMEROS ═══
--
-- El PDF lo quiere como tres decimales de 0 a 1, y podría guardarse así. Se
-- guarda `#rrggbb` porque es lo que entiende el selector de color del navegador
-- y lo que una persona puede leer y comparar de un vistazo en la base. La
-- conversión se hace en un solo lugar, al dibujar.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

alter table campo add column if not exists cuerpo numeric(5,2);
alter table campo add column if not exists color  text;

do $c$ begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.campo'::regclass
                    and conname = 'campo_cuerpo_razonable') then
    -- 4 puntos es ilegible y 72 no entra en ningún renglón de formulario. Los
    -- dos extremos son errores de tipeo, no decisiones.
    alter table campo add constraint campo_cuerpo_razonable
      check (cuerpo is null or (cuerpo >= 4 and cuerpo <= 72));
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.campo'::regclass
                    and conname = 'campo_color_hexa') then
    -- ⚠ En minúsculas y con el numeral. Aceptar varias formas del mismo color
    -- obliga a normalizar en cada lugar que lo lea, y alguno se va a olvidar.
    alter table campo add constraint campo_color_hexa
      check (color is null or color ~ '^#[0-9a-f]{6}$');
  end if;
end $c$;

comment on column campo.cuerpo is
  'Cuerpo de la letra en puntos PDF con que se dibuja el valor. NULL = se '
  'ajusta al alto del recuadro, que es lo que hace Acrobat con «auto». '
  'Ver migración 056.';

comment on column campo.color is
  'Color del valor, «#rrggbb» en minúsculas. NULL = la tinta de siempre. '
  'Ver migración 056.';

commit;

-- =============================================================================
-- CONTROL — el estado, comprobado
-- =============================================================================
do $control$
declare v_mal text := ''; v_n int;
begin
  if not exists (select 1 from information_schema.columns
                  where table_name = 'campo' and column_name = 'cuerpo') then
    v_mal := v_mal || E'\n  falta campo.cuerpo';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_name = 'campo' and column_name = 'color') then
    v_mal := v_mal || E'\n  falta campo.color';
  end if;

  -- ⚠ Lo que de verdad importa de esta migración: que NO haya tocado nada.
  -- Si algún campo quedó con cuerpo o color puestos, algo les puso un default y
  -- documentos que ya estaban en curso van a redibujarse distinto.
  select count(*) into v_n from campo where cuerpo is not null or color is not null;
  if v_n > 0 then
    v_mal := v_mal || format(
      E'\n  %s campo(s) quedaron con letra propia: esta migración no debía tocar ninguno', v_n);
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.campo'::regclass and conname = 'campo_cuerpo_razonable') then
    v_mal := v_mal || E'\n  falta campo_cuerpo_razonable';
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.campo'::regclass and conname = 'campo_color_hexa') then
    v_mal := v_mal || E'\n  falta campo_color_hexa';
  end if;

  -- ═══ SE EJERCE ESCRIBIENDO ═══
  --
  -- El catálogo puede estar perfecto y la combinación que importa igual no
  -- entrar: es lo que pasó con `campo_tiene_dueno` en la 052 y otra vez con
  -- `campo_quien_coherente` en la 055. Así que se guarda un campo con letra
  -- propia sobre un borrador real, se comprueba que el color mal escrito SÍ se
  -- rechace, y se borra todo.
  declare v_circ uuid; v_cuenta uuid; v_entro boolean := false;
  begin
    select c.id, c.cuenta_propietaria_id into v_circ, v_cuenta
      from public.circuito c where c.estado = 'borrador' limit 1;

    if v_circ is null then
      raise notice 'Sin documentos en borrador: no se pudo EJERCER la letra propia.';
    else
      begin
        insert into public.campo (circuito_id, cuenta_propietaria_id, codigo, etiqueta_i18n,
                                  tipo, completa_emisor, quien_completa, posicion_firmante,
                                  cuerpo, color, pagina, x, y, ancho, alto)
        values (v_circ, v_cuenta, '__prueba_letra__', '{"es":"prueba"}'::jsonb,
                'texto', false, 'firmante', 1, 9.5, '#1a3d7c', 0, 1, 1, 10, 10);
        v_entro := true;
      exception when others then
        v_mal := v_mal || format(E'\n  un campo con letra propia NO se puede guardar: %s', sqlerrm);
      end;

      -- Y al revés: un color mal escrito tiene que rebotar. Una restricción que
      -- nunca se probó en contra es una restricción que quizá no existe.
      if v_entro then
        begin
          update public.campo set color = 'azul'
           where circuito_id = v_circ and codigo = '__prueba_letra__';
          v_mal := v_mal || E'\n  ⚠ un color que no es hexa ENTRÓ igual: campo_color_hexa no está frenando nada';
        exception when check_violation then
          null;  -- lo esperado
        end;
      end if;

      delete from public.campo where circuito_id = v_circ and codigo = '__prueba_letra__';
    end if;
  end;

  if v_mal <> '' then
    raise exception E'La letra del campo quedó incompleta:%', v_mal;
  end if;

  raise notice '✓ 056: cuerpo y color por campo, y lo que ya existía sin tocar.';
end
$control$;
