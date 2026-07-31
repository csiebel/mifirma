# Esquema de login y seguridad — sesión por cookie httpOnly + CSRF

> Referencia portable del patrón de autenticación. Escrito para aplicarlo a **cualquier
> proyecto** (no atado a este), y para pasárselo a otro dev / otra sesión de IA.

## Idea central

La sesión es un **JWT firmado guardado en una cookie httpOnly** (no accesible por
JavaScript → un XSS no puede robar el token). Si hay varios tipos de usuario ("realms"),
cada uno tiene **su propia cookie con nombre por realm**. Como las cookies se mandan solas,
se agrega **protección CSRF** para las peticiones que mutan.

## Backend — piezas

1. **Cookie de sesión** `sess_<realm>`: `httpOnly` + `Secure` + `SameSite=Lax`, `maxAge` =
   vida del JWT. Nombre distinto por realm.
2. **Cookie CSRF** `csrf_<realm>`: **NO** httpOnly (el front la lee), `Secure` +
   `SameSite=Lax`, valor aleatorio. Se setea en el login.
3. **Verificador de sesión**: lee el token de (a) la cookie del realm; si no está, (b) el
   header `Authorization` (fallback, solo durante la migración). Marca un flag
   `req.authViaCookie`.
4. **Hook CSRF** (double-submit): en `POST/PUT/DELETE`, **solo si la identidad vino por
   cookie**, exige que `X-CSRF-Token` == cookie `csrf_<realm>` y que el `Origin`/`Referer`
   sea del propio dominio. Si la auth vino por header, **no chequea CSRF** (un atacante
   cross-site no puede setear ese header).
5. **Exentos de CSRF**: rutas públicas (login/registro/reset) y APIs con token propio
   (`api_token`).
6. **Login**: valida credenciales y setea `sess_<realm>` + `csrf_<realm>`. (Durante la
   migración además devuelve el token en el JSON, por compatibilidad; en la fase final se
   quita.)
7. **Logout**: endpoint que **borra** ambas cookies (`clearCookie`).
8. **Endpoint `/…/yo`** por realm: devuelve la identidad + datos de display, para que el
   front resuelva la sesión **sin token en storage**.

## Frontend — piezas

- **No** guardar el token en `localStorage`/`sessionStorage`.
- Todas las llamadas con `credentials: 'same-origin'` (la cookie viaja sola).
- En mutaciones: leer `csrf_<realm>` de `document.cookie` y mandarla en `X-CSRF-Token`.
- Resolver la sesión con `/…/yo` (no leer un JSON guardado).
- Logout llama al endpoint (no limpia storage).
- `401` → redirigir al login.

## Estrategia de migración incremental (lo que evita romper todo)

- **Fase A**: el backend acepta cookie **Y** header a la vez; el login setea la cookie
  además de devolver el token. No se rompe nada.
- **Fase B**: migrar los frontends **de a una superficie**, verificando cada una en
  producción. El CSRF condicional (solo para cookie-auth) deja convivir migrados y no
  migrados.
- **Fase C**: quitar el fallback del header + el token del JSON, cuando **todas** las
  superficies estén por cookie. Antes de cortar: **instrumentar** (loguear cuando alguien
  aún autentica por header) y esperar a que eso **caiga a cero** — así el "salto sin red"
  se vuelve seguro.

## Detalles que aprendimos (los que muerden si no los ves)

- **Nombres de cookie por realm.** Con nombre único + `Path` distinto, `document.cookie`
  queda ambiguo (te llegan dos y no sabés cuál leer).
- **CSRF condicional a cookie-auth** → no rompe clientes por header ni las APIs con
  `api_token`.
- **Handoff entre realms** (ej.: un usuario A "opera" en nombre de B): el endpoint que
  cruza debe **setear la cookie de sesión del realm destino** en su respuesta.
- **Sesiones abiertas al momento del deploy**: el peor caso debe ser **1 re-login** (el
  bootstrap detecta que falta cookie/csrf → manda al login), **nunca** un estado roto a
  mitad de acción.
- **Bug clásico**: si el bootstrap por `/…/yo` redirige al login en 401, **no debe pisar**
  la pantalla de "elegí nueva contraseña" cuando la URL trae un `#token` de invitación/reset
  → retornar temprano si hay token.
- **Auth defensiva por-ruta**: el hook central exige el token del realm salvo en una lista
  explícita de rutas públicas → si mañana agregás una ruta y olvidás validar, igual queda
  protegida.
- **No filtrar detalles internos** en errores 500 (mensaje genérico al cliente, log real
  del lado servidor).
- **Smoke tests del CSRF, 4 casos por superficie**: (a) cookie sin `X-CSRF` → 403; (b)
  cookie + token + Origin correctos → pasa; (c) header sin cookie → no chequea CSRF (cliente
  viejo sigue vivo); (d) cookie + Origin de otro dominio → 403.

## Trade-offs asumidos

- **Una sesión por realm por navegador** (cookie única por realm). Dos usuarios del mismo
  realm en el mismo navegador = caso borde aceptado.
- **Login unificado**: email + contraseña (sin pedir nombre de empresa/estudio), con
  desambiguación por email+password si el email existe en varias cuentas.
