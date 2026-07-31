# Plan — Migrar el token de sesión a cookie httpOnly (todos los realms)

> Estado: **diseño, sin implementar.** Este cambio toca la autenticación de los cuatro
> realms y las cinco interfaces a la vez, e introduce superficie de **CSRF**. Debe
> ejecutarse con **Claude Code** (typecheck + tests), no como entrega a ciegas.

## 1. Por qué

Hoy el token JWT de sesión viaja en el `Authorization: Bearer` y se guarda en el cliente
en `localStorage` / `sessionStorage`:

- `png_sesion` (empresa, en sessionStorage), `estudio_token`, `oferente_token`, y el token
  de operador.

Riesgo: cualquier JavaScript que corra en la página puede leer esos tokens (robo por XSS).
Está **parcialmente mitigado** por la CSP actual (script-src 'self' 'unsafe-inline', sin
scripts de otros orígenes), pero httpOnly lo cierra del todo: una cookie httpOnly no es
accesible desde JS.

**Contra:** al mover el token a una cookie que el navegador envía automáticamente, aparece
el riesgo de **CSRF** (un sitio atacante puede hacer que el navegador dispare peticiones con
la cookie adjunta). Hoy NO existe ese riesgo porque el token va en un header que un tercero
no puede setear. Por eso la migración **obliga** a sumar protección CSRF.

## 2. Decisión de diseño

- Token de sesión en **cookie httpOnly + Secure + SameSite=Lax** (o `Strict` donde no haya
  navegación cross-site legítima), con `Path` acotado por realm cuando aplique.
- Protección **CSRF** para métodos que mutan (POST/PUT/DELETE):
  - Verificar el header `Origin` / `Referer` contra el propio dominio (barato, primera línea).
  - **Double-submit token**: además de la cookie httpOnly de sesión, una cookie NO httpOnly
    con un token CSRF que el frontend lee y reenvía en un header `X-CSRF-Token`; el backend
    compara. (SameSite=Lax ya bloquea la mayoría de los casos; el double-submit es defensa
    en profundidad.)
- **Multi-cuenta:** hoy un mismo navegador puede tener sesión de empresa + estudio + oferente
  + operador. Con cookies hay que separarlas por **nombre de cookie por realm**
  (`sess_emp`, `sess_est`, `sess_ofe`, `sess_op`) para que no se pisen.

## 3. Estrategia incremental (para no romper el login en el camino)

**Fase A — backend acepta cookie O header (compatible hacia atrás).**
- Sumar `@fastify/cookie`.
- En login de cada realm, además de devolver el token en el JSON (como hoy), setear la
  cookie httpOnly del realm.
- Los verificadores (`autenticar`, `verificarTokenOperador`, `verificarTokenEstudio`,
  `verificarTokenOferente`) leen el token de: (1) la cookie del realm; si no está, (2) el
  header `Authorization` (fallback actual). Nada se rompe: los clientes viejos siguen andando.
- Endpoint de **logout** por realm que borra la cookie (`clearCookie`).

**Fase B — frontend deja de usar el header y de guardar el token.**
- `entrar.html`, `index.html` (/app), `mi.html`, `operador.html`, `estudio.html`,
  `oferente.html`: dejar de escribir el token en storage y de mandar `Authorization`.
  Las llamadas pasan a `credentials: 'same-origin'` (la cookie viaja sola).
- Sumar el manejo del **token CSRF**: leer la cookie no-httpOnly y mandarla en `X-CSRF-Token`
  en las peticiones que mutan.
- La "sesión" del cliente pasa a resolverse con un endpoint tipo `/…/yo` (ya existen para
  estudio y oferente; empresa/operador tienen equivalentes) en vez de leer el JSON guardado.

**Fase C — quitar el fallback de header y la devolución del token en el JSON.**
- Una vez que todas las interfaces usan cookie, remover el soporte de `Authorization` y
  dejar de devolver el token en el body del login. (Opcional; se puede mantener el header
  para clientes no-navegador como la API de integración, que usa `api_token`, no la sesión.)

## 4. Puntos a cuidar

- **API de integración** (`/integracion/*`, `api_token`): NO usa la sesión JWT; no se toca.
- **PWA `/mi`**: las peticiones del service worker y `fetch` deben ir con `credentials`.
- **CSP**: `form-action 'self'` y `frame-ancestors 'none'` ya ayudan contra CSRF por forms
  embebidos; mantenerlos.
- **Descargas por `<a>`/`<img>`** que hoy van con header `Authorization` y `fetch`→blob
  (banners de oferta, CSV de asientos, archivos de formularios): con cookie httpOnly pueden
  volver a `<img src>`/`<a href>` directos, pero hay que verificar CSRF/again el `Origin`.
- **Expiración y renovación**: la cookie debe expirar con el JWT (12 h hoy); definir si se
  renueva deslizante.
- **Subdominios**: si en el futuro hay `app.` / `api.` separados, fijar `Domain` con cuidado.

## 5. Verificación (con Claude Code)

- `npm run typecheck` limpio.
- Batería de tests de login de los cuatro realms (incluida la desambiguación multi-cuenta).
- Prueba manual en staging: login, navegación, logout y expiración en cada realm; y un
  intento de CSRF (POST cross-site) que debe ser rechazado.

## 5.bis Fase B — detalle de ejecución (frontends + CSRF)

**Regla de oro para no romper nada:** el CSRF se exige **solo cuando la request se
autenticó por COOKIE**. Si vino con `Authorization` (frontend no migrado o API de
integración), se saltea el CSRF — un atacante cross-site no puede setear ese header, así
que no hace falta. Esto deja convivir frontends migrados (cookie) y no migrados (header)
mientras se migra de a uno.

**Backend (una vez, antes de migrar frontends):**
- En el login de cada realm, además de la cookie de sesión (Fase A), setear una cookie
  `csrf_token` **NO httpOnly**, `SameSite=Lax`, `Secure`, con un valor aleatorio.
- Hook para métodos que mutan (`POST`/`PUT`/`DELETE`): si la identidad se resolvió por
  **cookie** (no había `Authorization`), exigir que el header `X-CSRF-Token` coincida con
  la cookie `csrf_token` (double-submit) y que el `Origin`/`Referer` sea del propio dominio.
  Si se resolvió por header, no chequear CSRF.
- **Exentos** del CSRF: rutas públicas (login/registro/reset) y la API de integración
  (`/integracion/*`, que usa `api_token`, no la sesión).
- Endpoint de **logout** por realm (ya de Fase A) que borra ambas cookies.

**Frontends — migrar DE A UN REALM, verificando entre cada uno.** Orden sugerido, de menor
a mayor riesgo:
1. `oferente.html` (más nuevo, aislado)
2. `estudio.html`
3. `entrar.html` + `index.html` (empresa — tiene OTP y desambiguación multi-empresa; probar bien)
4. `operador.html`
5. `mi.html` (PWA del empleado — probar con el service worker)

**Qué cambia cada frontend:**
- Dejar de guardar el token en `localStorage`/`sessionStorage` y de mandar `Authorization`.
- Todas las llamadas con `credentials: 'same-origin'` (la cookie viaja sola).
- En cada `POST`/`PUT`/`DELETE`, leer la cookie `csrf_token` y mandarla en `X-CSRF-Token`.
- Resolver la sesión con el endpoint `/…/yo` del realm en vez de leer el JSON guardado.
- El logout llama al endpoint de logout (borra cookies) en vez de limpiar storage.

**Verificación por realm (en prod, tras cada deploy):** login fresco (logout+login),
navegación, una acción que mute (crear/editar algo) para ejercitar el CSRF, y logout. En
empresa: además el OTP y la pantalla de elegir empresa. En `/mi`: que ande dentro de la PWA.

## 6. Alternativa mínima (si se posterga la migración)

Si no se hace la migración a cookies ahora, dos endurecimientos chicos reducen el riesgo:
- Acortar la vida del JWT y/o rotarlo.
- Mantener la CSP estricta (ya está) y evitar cualquier `innerHTML` con datos no escapados
  en los frontends (revisar que todo pase por `esc()`), que es el vector de XSS que robaría
  el token.
