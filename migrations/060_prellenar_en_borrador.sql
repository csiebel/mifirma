-- 060 — El emisor puede PRE-llenar cualquier campo mientras el documento está
--       en borrador. Opción B del envío desde planilla, decidida el 13/8.
--
-- ═══ QUÉ CAMBIA Y QUÉ NO ═══
--
-- Hasta hoy la rama (a) de `app.puede_completar_campo` decía: el emisor
-- escribe SUS campos (quien_completa = 'emisor') y nada más. Con el envío
-- desde planilla la pregunta cambió: el Excel del emisor trae también el
-- teléfono de Juan, y dejarlo puesto en la copia de Juan es útil — como un
-- formulario preimpreso.
--
-- La regla nueva: **en borrador, el emisor puede escribir cualquier campo del
-- circuito**. Después del despacho, todo sigue exactamente igual que hoy:
-- cada campo lo toca su dueño y nadie más.
--
-- ═══ POR QUÉ ESTO NO REGALA NADA ═══
--
--  · En borrador NADIE vio el documento todavía: no hay lectura aceptada que
--    un prellenado pueda traicionar. El congelamiento del despacho
--    (`circuito_congelado`) y el estado 'borrador' acotan la ventana.
--  · El campo DEL FIRMANTE prellenado sigue siendo suyo: la rama (b) le
--    permite corregirlo hasta que se congela al firmar. Lo que firma es lo
--    que ve, y el expediente dice quién escribió qué (`completado_por`,
--    `origen='planilla'`) y si lo cambió.
--  · El campo de CUALQUIERA prellenado queda como respondido por el emisor.
--    No es un caso especial: la regla de ese tipo de campo siempre fue «el
--    primero que escribe, queda» (rama (c)) — el primero fue el emisor.
--
-- ⚠ La autorización sigue viviendo ACÁ, en la base (regla de oro nº 2). El
-- servicio de planilla valida formas y tipos, pero si mañana un camino nuevo
-- intenta escribir un campo fuera de estas reglas, lo frena esta función, no
-- una pantalla.
--
-- ⚠ Este número (060) estaba apalabrado para celular/contraseña en
-- `telefono-y-contrasena-del-usuario.md`; esa pasa a ser la 061. El diseño no
-- cambia, sólo el número.

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
         -- (a) El emisor, sobre CUALQUIER campo, y sólo mientras el documento
         --     no salió (060): antes del despacho no hay nada firmado ni leído
         --     que un prellenado pueda cambiar; después, esta rama no aplica y
         --     mandan (b) y (c) como siempre.
         (i.cuenta_propietaria_id = app.cuenta_actual()
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
         -- sabe qué versión se firmó. Un prellenado del emisor (060) cuenta
         -- como escrito: para los firmantes queda de sólo lectura, que es la
         -- misma regla de siempre con el emisor de primer escritor.
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

comment on function app.puede_completar_campo(uuid, uuid) is
  'Quién puede escribir un valor de campo. (a) el emisor, cualquier campo, sólo '
  'en borrador (060); (b) el firmante dueño del campo por su lugar; (c) '
  'cualquiera, una sola vez. La instancia tiene que estar abierta.';
