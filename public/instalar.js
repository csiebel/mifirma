// Instalación de la webapp: enciende el service worker y ofrece «Instalar».
//
// ⚠ Por qué existe este archivo: el manifiesto y `sw.js` estaban escritos desde
// el 4/8, pero NADIE los encendía. El único `serviceWorker.register` del
// repositorio vivía en `mi.html`, que es resto de payroll y no se sirve. O sea
// que la webapp era instalable en el papel y no en la realidad: en producción,
// `navigator.serviceWorker.getRegistrations()` daba 0 (medido el 14/8).
//
// Se carga en `/app` y en `/entrar`. **NO se carga en `/firmar`**, y eso es
// deliberado: al firmante ocasional no se le ofrece instalar nada nunca
// (`apps-y-dispositivos.md` §0). Llega por un enlace, firma y sigue con su
// vida; un banner de «descargá la app» ahí es la forma conocida de perder
// firmas.
//
// El botón sólo aparece si la página trae el hueco `#instalar`. Así este mismo
// archivo sirve para las dos páginas sin condicionales por URL.
(function () {
  'use strict';

  // ── 1. El service worker ────────────────────────────────────────────────
  //
  // Sin esto no hay instalación, no hay respaldo sin conexión y no hay push:
  // las notificaciones se entregan al service worker, no a la página.
  //
  // ⚠ Registrar es idempotente: si ya está, el navegador no hace nada.
  if ('serviceWorker' in navigator) {
    // Después de `load` para no competir con la carga de la página.
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {
        // Un service worker que no registra no rompe nada: la app funciona
        // igual, sin instalación ni respaldo. No vale molestar al usuario.
      });
    });
  }

  // ── 2. ¿Ya está instalada? ──────────────────────────────────────────────
  function yaInstalada() {
    return (
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true
    );
  }

  // iPhone y iPad no tienen diálogo de instalación: se hace a mano desde
  // Compartir → «Agregar a inicio». Safari no avisa de ninguna forma, así que
  // si no lo explicamos, no pasa.
  function esIOS() {
    var ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document);
  }

  // ── 3. El botón ─────────────────────────────────────────────────────────
  //
  // ⚠ Hay MÁS DE UN hueco desde el rediseño de teléfono (15/8): el del pie del
  // lateral, que se ve en la computadora, y el de la hoja de «Más», que se ve
  // en el teléfono. Por eso `.huecoInstalar` (clase) y no `#instalar` (id): con
  // el id sólo se llenaba el primero, y en el teléfono —justo donde instalar
  // tiene sentido— el botón no aparecía.
  var invitacion = null; // el `beforeinstallprompt` que guardó el navegador

  function huecos() {
    return document.querySelectorAll('.huecoInstalar');
  }

  function pintar() {
    var lista = huecos();
    if (!lista.length) return; // esta página no ofrece instalar (p. ej. /entrar)
    if (yaInstalada()) {
      lista.forEach(function (h) { h.innerHTML = ''; });
      return;
    }

    function vaciarTodos() {
      huecos().forEach(function (h) { h.innerHTML = ''; });
    }

    if (invitacion) {
      lista.forEach(function (h) {
        h.innerHTML = '<button type="button">Instalar MiFirma</button>';
        h.querySelector('button').addEventListener('click', function () {
          var guardada = invitacion;
          invitacion = null; // una invitación se usa una sola vez
          guardada.prompt();
          // Diga que sí o que no, el botón se va: no se insiste en esta visita.
          guardada.userChoice.then(vaciarTodos).catch(vaciarTodos);
        });
      });
      return;
    }

    if (esIOS()) {
      lista.forEach(function (h) {
        h.innerHTML =
          '<button type="button">Instalar MiFirma</button>' +
          '<p class="comoInstalar" hidden>Tocá <b>Compartir</b> abajo y elegí ' +
          '<b>Agregar a inicio</b>. MiFirma queda con su ícono, como una app.</p>';
        h.querySelector('button').addEventListener('click', function () {
          var p = h.querySelector('.comoInstalar');
          if (p) p.hidden = !p.hidden;
        });
      });
    }
    // Ni invitación ni iOS: el navegador no permite instalar (o ya lo hizo).
    // No se muestra un botón que no va a hacer nada.
  }

  // El navegador avisa cuando la webapp cumple los requisitos para instalarse.
  // Hay que interceptarlo y guardarlo: si se deja pasar, Chrome muestra su
  // propio cartel donde quiere, o no lo muestra nunca.
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    invitacion = e;
    pintar();
  });

  window.addEventListener('appinstalled', function () {
    invitacion = null;
    huecos().forEach(function (h) { h.innerHTML = ''; });
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', pintar);
  } else {
    pintar();
  }
})();
