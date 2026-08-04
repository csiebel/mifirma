-- =============================================================================
-- Por qué un documento firmado no aparece en ninguna carpeta.
--
--   psql "$MIFIRMA_DB" -f db/diagnostico-bandeja.sql
--
-- SÓLO LEE. Todo corre dentro de una transacción que termina en rollback.
--
-- No devuelve filas para interpretar: corre la consulta real del repositorio
-- CON EL CONTEXTO DE ESA PERSONA y dice cuál de los tres motivos posibles es.
-- =============================================================================
\set ON_ERROR_STOP on
\pset pager off

-- ⚠ Cambiá esta línea si el correo es otro.
\set CORREO 'claudio.siebel@gmail.com'

begin;

-- ⚠ Por acá viaja el correo hasta el bloque de abajo. psql NO sustituye
-- variables adentro de un cuerpo $$...$$, así que pasarla como texto no
-- funciona: se pone en una GUC y el bloque la lee.
select set_config('mifirma.correo', :'CORREO', true) as correo_a_revisar;

do $diag$
declare
  v_correo     text := current_setting('mifirma.correo', true);
  v_ident      uuid;
  v_cuenta     uuid;
  v_cuenta_nom text;
  v_entrada    uuid;
  v_anclaje    uuid;
  v_n          int;
  r            record;
begin
  raise notice '';
  raise notice '════ 1. LA IDENTIDAD Y SU CUENTA PERSONA ════';

  select i.id into v_ident from identidad i where i.email_normalizado = lower(v_correo);
  if v_ident is null then
    raise notice '  ✗ No existe ninguna identidad con ese correo. Fin.';
    return;
  end if;
  raise notice '  identidad: %', v_ident;

  select cu.id, cu.nombre_mostrado into v_cuenta, v_cuenta_nom
    from cuenta cu
   where cu.identidad_titular_id = v_ident and cu.tipo = 'persona' and cu.estado <> 'cerrada';

  if v_cuenta is null then
    raise notice '  ✗ NO TIENE CUENTA PERSONA.';
    raise notice '    Recibidos ES la bandeja de la cuenta persona. Sin ella no hay';
    raise notice '    dónde poner el documento: el otorgamiento le da acceso, pero no';
    raise notice '    aparece en ninguna carpeta. Éste es el motivo.';
    raise notice '    (Ser miembro de una empresa no alcanza: un documento firmado a';
    raise notice '     título personal no entra al repositorio del empleador.)';
    for r in select cu.id, cu.tipo, cu.nombre_mostrado from cuenta cu
              join membresia m on m.cuenta_id = cu.id and m.identidad_id = v_ident
    loop
      raise notice '    · es miembro de: % (%) %', r.nombre_mostrado, r.tipo, r.id;
    end loop;
    return;
  end if;
  raise notice '  ✓ cuenta persona: % (%)', v_cuenta_nom, v_cuenta;

  select ca.id into v_entrada from carpeta ca
   where ca.cuenta_id = v_cuenta and ca.sistema = 'entrada';
  if v_entrada is null then
    raise notice '  ✗ Esa cuenta NO TIENE CARPETA DE ENTRADA.';
    raise notice '    ubicarEnBandeja inserta buscando sistema = entrada; sin ella el';
    raise notice '    insert no encuentra destino y no escribe nada, en silencio.';
    return;
  end if;
  raise notice '  ✓ carpeta de entrada: %', v_entrada;

  raise notice '';
  raise notice '════ 2. SUS DOCUMENTOS Y SI ESTÁN UBICADOS ════';
  for r in
    select c.titulo, c.estado as circ, o.instancia_id, o.revocado_en is not null as revocado,
           (select count(*) from ubicacion u
             where u.instancia_id = o.instancia_id and u.cuenta_id = v_cuenta) as ubic
      from otorgamiento o
      left join instancia ins on ins.id = o.instancia_id
      left join circuito c on c.id = coalesce(o.circuito_id, ins.circuito_id)
     where o.identidad_id = v_ident
     order by c.titulo
  loop
    raise notice '  % | circuito=% | revocado=% | ubicaciones=%',
      rpad(coalesce(r.titulo,'(sin título)'), 34), r.circ, r.revocado, r.ubic;
  end loop;

  select count(*) into v_n from otorgamiento o
   where o.identidad_id = v_ident and o.revocado_en is null
     and not exists (select 1 from ubicacion u
                      where u.instancia_id = o.instancia_id and u.cuenta_id = v_cuenta);
  if v_n > 0 then
    raise notice '';
    raise notice '  ✗ % documento(s) SIN UBICACIÓN.', v_n;
    raise notice '    Tiene acceso pero no está puesto en ninguna carpeta. Es el hueco';
    raise notice '    de abrir la cuenta con el documento ya despachado: ni el despacho';
    raise notice '    ni el alta lo ubican. Se arregla con el UPDATE del pie.';
  else
    raise notice '';
    raise notice '  ✓ Todos ubicados. El problema no es la ubicación: seguí al punto 3.';
  end if;

  raise notice '';
  raise notice '════ 3. LA CONSULTA REAL, CON SU CONTEXTO ════';

  select an.id into v_anclaje from anclaje_identidad an
   where an.identidad_id = v_ident and an.revocado_en is null
   order by an.probado_en limit 1;

  -- Con anclaje probado: es lo que produce un login normal con OTP.
  perform set_config('app.actor','cuenta',true),
          set_config('app.cuenta_id', v_cuenta::text, true),
          set_config('app.identidad_id', v_ident::text, true),
          set_config('app.anclajes_probados', coalesce(v_anclaje::text,''), true),
          set_config('app.nivel_garantia','bajo',true),
          set_config('app.otorgamiento_id','',true);

  select count(*) into v_n
    from ubicacion u
    left join instancia iu on iu.id = u.instancia_id
    join circuito c on c.id = coalesce(u.circuito_id, iu.circuito_id)
   where u.cuenta_id = v_cuenta and not u.archivada;
  raise notice '  con anclaje probado  → % documento(s) visibles', v_n;

  -- Sin anclaje probado: es lo que pasa si la sesión no acredita ninguno.
  perform set_config('app.anclajes_probados','',true);
  select count(*) into v_n
    from ubicacion u
    left join instancia iu on iu.id = u.instancia_id
    join circuito c on c.id = coalesce(u.circuito_id, iu.circuito_id)
   where u.cuenta_id = v_cuenta and not u.archivada;
  raise notice '  SIN anclaje probado  → % documento(s) visibles', v_n;
  raise notice '';
  raise notice '  Si el primero trae documentos y el segundo no, el problema no es la';
  raise notice '  ubicación sino la SESIÓN: app.tiene_otorgamiento exige un anclaje';
  raise notice '  probado EN ESA SESIÓN, y sin él la instancia y el circuito no se ven.';
  raise notice '  El join contra circuito es INNER, así que la fila desaparece entera.';
end $diag$;

rollback;

-- =============================================================================
-- EL ARREGLO, si el punto 2 mostró documentos sin ubicación.
--
-- No se corre solo: leelo, y si es tu caso, sacale los guiones.
-- Es idempotente y sólo agrega filas; no borra ni mueve nada.
-- =============================================================================
-- insert into ubicacion (cuenta_id, carpeta_id, instancia_id)
-- select cu.id, ca.id, o.instancia_id
--   from otorgamiento o
--   join identidad i  on i.id = o.identidad_id
--   join cuenta cu    on cu.identidad_titular_id = i.id
--                    and cu.tipo = 'persona' and cu.estado <> 'cerrada'
--   join carpeta ca   on ca.cuenta_id = cu.id and ca.sistema = 'entrada'
--  where o.revocado_en is null
--    and o.instancia_id is not null
--    and not exists (select 1 from ubicacion u
--                     where u.instancia_id = o.instancia_id and u.cuenta_id = cu.id)
--  group by cu.id, ca.id, o.instancia_id;
