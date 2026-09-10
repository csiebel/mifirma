// Service worker de MiFirma.
//
// Estrategia deliberadamente conservadora: network-first para la NAVEGACIÓN
// (siempre contenido fresco si hay red; el cache es solo respaldo cuando estás
// offline). Las llamadas a la API, a otros orígenes y todo lo que no sea una
// navegación GET del mismo origen pasan DERECHO, sin que el worker las toque
// ni las cachee. Así no hay riesgo de servir datos viejos ni de romper la API.
//
// Para invalidar el cache (p. ej. tras un cambio grande), subí el número de CACHE.
//
// ⚠ v4 (14/8): el shell precacheaba `/mi`, que es una ruta de PAYROLL y en
// MiFirma no existe. `addAll` es todo-o-nada: el 404 de `/mi` tiraba abajo el
// precache ENTERO, y el `.catch(() => {})` se lo tragaba sin decir nada. El
// respaldo sin conexión no existía y nadie se enteraba. Las dos rutas de acá
// abajo son las dos puertas reales de la webapp.
//
// ⚠ Subir el número de CACHE también sirve para desalojar cualquier resto que
// haya quedado de payroll en un navegador que alguna vez abrió `/mi`.
// ⚠ v6 (10/9): la excepción de `/cdn-cgi/*` (la vuelta de Cloudflare Access).
// ⚠ v5 (6/9): además de estrenar la excepción de `/identidad/*`, subir el
// número DESALOJA lo que la versión anterior alcanzó a guardar de esas
// vueltas — el `caches.put` de abajo las cacheaba por camino, así que un
// navegador que ya hizo un viaje tiene guardada la respuesta de un canje.
const CACHE = 'mifirma-shell-v6';
const SHELL = ['/app', '/entrar'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {})
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // POST/PUT a la API: pasa derecho
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // fuentes, etc.: pasan derecho
  if (req.mode !== 'navigate') return; // fetch de datos de la app: pasa derecho

  // ⚠⚠ LA CONSOLA DEL OPERADOR NO ES DE ESTA APP, Y ADEMÁS TIENE PUERTA PROPIA.
  //
  // `/operador` está detrás de Cloudflare Access. Cuando el worker interceptaba
  // esa navegación, el pedido salía desde adentro de la app y **no podía seguir
  // el salto a `…cloudflareaccess.com`**: se caía, el worker servía el respaldo
  // (`/app`), la consola del cliente veía un 401 y mandaba a `/entrar`.
  //
  // Efecto: la pantalla de Access NUNCA aparecía y el código de seis dígitos
  // NUNCA llegaba. Parecía que Cloudflare estaba mal configurado; Cloudflare
  // hacía exactamente lo que le pidieron. Encontrado el 15/8/2026.
  //
  // > Regla: un service worker manda sobre TODO su origen, incluidas puertas
  // > que no son suyas. Lo que se autentica afuera, pasa derecho.
  if (url.pathname === '/operador' || url.pathname.startsWith('/operador/')) return;

  // ⚠⚠ LA VUELTA DE UN PROVEEDOR DE IDENTIDAD NO ES UNA PANTALLA: ES UN TRÁMITE
  // QUE TERMINA EN UNA REDIRECCIÓN. Y una redirección no puede salir de acá.
  //
  // `respondWith` con una respuesta cuyo `redirected` es true está PROHIBIDO
  // para una navegación: el navegador la rechaza y rehace la navegación sin el
  // worker. Como el `fetch` de abajo sigue los saltos solo, eso es exactamente
  // lo que pasaba — y el segundo viaje llegaba con el código de un solo uso ya
  // gastado. Medido el 6/9 en el log del servidor: 302 → 200 en la pantalla
  // correcta → y un segundo después el MISMO código otra vez, con 502.
  //
  // Efecto para quien lo vivía: el login funcionaba, se veía la pantalla buena
  // un instante, y terminaba en un error. Lo peor de los dos mundos, porque el
  // error decía «TuID rechazó el código» y tuID no había rechazado nada.
  //
  // > Regla, hermana de la de arriba: lo que TERMINA EN UNA REDIRECCIÓN pasa
  // > derecho. El worker sólo puede responder navegaciones que devuelven una
  // > página.
  if (url.pathname.startsWith('/identidad/')) return;

  // ⚠⚠ Y LA VUELTA DE CLOUDFLARE ACCESS ES EL MISMO CASO, POR TERCERA VEZ.
  //
  // `/cdn-cgi/access/authorized?...` es adonde Cloudflare manda al navegador
  // después de la pantalla de Access, y desde ahí lo redirige a `/operador`.
  // Es una navegación que TERMINA EN UNA REDIRECCIÓN: el worker la interceptaba,
  // el `fetch` seguía el salto, y el navegador rechazaba la respuesta con
  // `ERR_FAILED`. Se vio el 7/9 (y «se arregló solo al reintentar», porque al
  // segundo intento la cookie ya estaba y Access no redirigía) y el 10/9, que
  // fue cuando se entendió. `/cdn-cgi/` entero es de Cloudflare — Access,
  // desafíos, lo que agreguen mañana — y nada de eso es de esta app.
  //
  // > Tres veces la misma regla en tres puertas distintas (15/8, 6/9, 10/9):
  // > lo que se autentica afuera y lo que termina en una redirección, pasan
  // > derecho. La próxima puerta nueva se agrega acá ANTES de probarla.
  if (url.pathname.startsWith('/cdn-cgi/')) return;

  // Navegación: red primero (sin pasar por el cache HTTP del navegador, que en
  // iOS a veces ignora no-store), cache como respaldo offline por ruta real.
  e.respondWith(
    fetch(req.url, { cache: 'reload', credentials: 'same-origin' })
      .then((res) => {
        const copia = res.clone();
        caches.open(CACHE).then((c) => c.put(url.pathname, copia)).catch(() => {});
        return res;
      })
      .catch(() =>
        caches.match(url.pathname).then((r) => {
          if (r) return r;
          // ⚠⚠ El respaldo sin conexión es SÓLO para las puertas de esta app.
          //
          // Antes, cualquier navegación que fallara terminaba mostrando la
          // consola del cliente (`/app`), viniera de donde viniera. Eso convertía
          // un problema de red en una pantalla equivocada: quien abría su enlace
          // de firma sin conexión veía la consola del EMISOR, y quien iba al
          // operador terminaba en el login del cliente.
          //
          // Una pantalla equivocada es peor que un error honesto: el error se
          // entiende y se reintenta; la pantalla equivocada manda a buscar el
          // problema a otro lado.
          if (SHELL.includes(url.pathname)) return caches.match('/app');
          return Response.error();
        })
      )
  );
});

// --- Notificaciones push ---
// El backend envía un JSON { title, body, url }. Mostramos la notificación y, al
// tocarla, enfocamos una ventana abierta de la app o abrimos /mi.
self.addEventListener('push', (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch (err) {
    data = { title: 'MiFirma', body: e.data ? e.data.text() : '' };
  }
  const title = data.title || 'MiFirma';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    // ⚠ `/app`, no `/mi`: `/mi` era la pantalla del empleado en PAYROLL y acá
    // no existe. Tocar el cartelito habría abierto un 404.
    data: { url: data.url || '/app' },
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/app';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes(url) && 'focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    }),
  );
});
