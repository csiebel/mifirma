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
const CACHE = 'mifirma-shell-v4';
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

  // Navegación: red primero (sin pasar por el cache HTTP del navegador, que en
  // iOS a veces ignora no-store), cache como respaldo offline por ruta real.
  e.respondWith(
    fetch(req.url, { cache: 'reload', credentials: 'same-origin' })
      .then((res) => {
        const copia = res.clone();
        caches.open(CACHE).then((c) => c.put(url.pathname, copia)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(url.pathname).then((r) => r || caches.match('/app')))
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
    data: { url: data.url || '/mi' },
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/mi';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes(url) && 'focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    }),
  );
});
