// Avisos en el teléfono: pedir el permiso, suscribirse, y el interruptor.
//
// El cartelito que aparece en el teléfono aunque MiFirma esté cerrada. Lo
// entrega el service worker (`sw.js`), no esta página: por eso primero tiene
// que estar registrado (`instalar.js`) y recién después esto tiene sentido.
//
// ⚠⚠ **El permiso se pide SIEMPRE en respuesta a un clic**, nunca al entrar.
// Un navegador que pregunta apenas abrís la página se contesta «No» sin leer, y
// ese «No» es para siempre: no hay forma de volver a preguntar desde el código.
// Por eso hay un interruptor y no un pedido automático.
//
// ⚠ El correo se sigue mandando igual. El aviso acelera; el correo prueba.
(function () {
  'use strict';

  const RUTA_CLAVE = '/push/clave';
  const RUTA_ALTA = '/push/suscribir';
  const RUTA_BAJA = '/push/baja';

  // ── Utilidades ──────────────────────────────────────────────────────────

  /** La clave VAPID viaja en base64url y `subscribe` la pide en bytes. */
  function claveABytes(base64url) {
    const relleno = '='.repeat((4 - (base64url.length % 4)) % 4);
    const base64 = (base64url + relleno).replace(/-/g, '+').replace(/_/g, '/');
    const crudo = atob(base64);
    const bytes = new Uint8Array(crudo.length);
    for (let i = 0; i < crudo.length; i++) bytes[i] = crudo.charCodeAt(i);
    return bytes;
  }

  /** Las mutaciones van con el token CSRF, igual que el resto de la consola. */
  function pedir(url, cuerpo) {
    const opciones = {
      method: cuerpo ? 'POST' : 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    };
    if (cuerpo) {
      opciones.headers['Content-Type'] = 'application/json';
      opciones.body = JSON.stringify(cuerpo);
      // ⚠ La cookie se llama `csrf_emp` — así, cortada. Escribirla
      // `csrf_empresa` de memoria costó un 403 en la primera prueba: el
      // servidor no encuentra el token y rechaza la mutación, con un mensaje
      // que no dice «te falta el CSRF». Es la misma función que usa consola.js;
      // el nombre se copia de ahí, no se adivina.
      const m = document.cookie.match(/(?:^|;\s*)csrf_emp=([^;]*)/);
      if (m) opciones.headers['X-CSRF-Token'] = decodeURIComponent(m[1]);
    }
    return fetch(url, opciones).then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // ── Estado ──────────────────────────────────────────────────────────────

  const soportado =
    'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  let clavePublica = null;

  async function suscripcionActual() {
    if (!soportado) return null;
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return null;
    return reg.pushManager.getSubscription();
  }

  /**
   * Qué mostrar. Cinco situaciones distintas, y cada una dice algo distinto —
   * «no anda» sin decir por qué es lo que hace que la gente escriba a soporte.
   */
  async function situacion() {
    if (!soportado) return 'sin_soporte';
    if (!clavePublica) return 'sin_configurar';
    if (Notification.permission === 'denied') return 'bloqueado';
    return (await suscripcionActual()) ? 'prendido' : 'apagado';
  }

  // ── Prender y apagar ────────────────────────────────────────────────────

  async function prender() {
    // El permiso, en el clic. Si ya estaba dado, esto vuelve enseguida.
    const permiso = await Notification.requestPermission();
    if (permiso !== 'granted') return situacion();

    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        // Obligatorio en todos los navegadores modernos: cada aviso que
        // mandamos tiene que ser visible para la persona. No se puede usar el
        // push para hacer cosas por atrás, y está bien que así sea.
        userVisibleOnly: true,
        applicationServerKey: claveABytes(clavePublica),
      });
    }
    const j = sub.toJSON();
    await pedir(RUTA_ALTA, { endpoint: j.endpoint, keys: j.keys });
    return 'prendido';
  }

  async function apagar() {
    const sub = await suscripcionActual();
    if (!sub) return 'apagado';
    const endpoint = sub.endpoint;
    // Primero el servidor: si se cancela local y falla el aviso al servidor,
    // quedaría mandándole a un dispositivo que ya no escucha.
    await pedir(RUTA_BAJA, { endpoint }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
    return 'apagado';
  }

  // ── La pantalla ─────────────────────────────────────────────────────────

  const TEXTOS = {
    prendido: {
      estado: 'Los avisos están prendidos en este dispositivo.',
      boton: 'Apagar los avisos',
    },
    apagado: {
      estado:
        'Te avisamos en este dispositivo cuando tengas algo para firmar, aunque MiFirma esté cerrada. ' +
        'El correo se manda igual: el aviso sólo hace que te enteres antes.',
      boton: 'Avisarme en este dispositivo',
    },
    bloqueado: {
      estado:
        'Bloqueaste los avisos para este sitio en tu navegador. Para volver a permitirlos hay que ' +
        'cambiarlo desde la configuración del navegador — desde acá ya no se puede preguntar.',
      boton: null,
    },
    sin_soporte: {
      estado:
        'Este navegador no puede mostrar avisos. En iPhone funcionan sólo si antes agregás ' +
        'MiFirma a la pantalla de inicio.',
      boton: null,
    },
    sin_configurar: {
      estado: 'Los avisos todavía no están habilitados en este servidor.',
      boton: null,
    },
  };

  async function pintar(mensaje) {
    const caja = document.getElementById('avisos');
    const pie = document.getElementById('avisosPie');
    const est = await situacion();
    const t = TEXTOS[est];

    if (caja) {
      caja.innerHTML =
        '<p class="pista">' + t.estado + '</p>' +
        (t.boton ? '<button type="button" class="btn" id="btnAvisos">' + t.boton + '</button>' : '') +
        (mensaje ? '<p class="pista" id="avisosMsg">' + mensaje + '</p>' : '');
      const b = document.getElementById('btnAvisos');
      if (b) {
        b.addEventListener('click', async () => {
          b.disabled = true;
          try {
            await (est === 'prendido' ? apagar() : prender());
            await pintar(est === 'prendido' ? 'Listo, no te avisamos más en este dispositivo.' : 'Listo. Te vamos a avisar acá.');
          } catch (e) {
            await pintar('No se pudo: ' + (e && e.message ? e.message : 'error'));
          }
        });
      }
    }

    // En el pie del lateral, sólo la invitación mientras estén apagados.
    if (pie) {
      if (est === 'apagado') {
        pie.innerHTML = '<button type="button" id="btnAvisosPie">Avisarme en este dispositivo</button>';
        document.getElementById('btnAvisosPie').addEventListener('click', async () => {
          try {
            await prender();
          } catch (e) {
            /* el detalle vive en Cuenta, que es donde se explica */
          }
          await pintar();
        });
      } else {
        pie.innerHTML = '';
      }
    }
  }

  async function arrancar() {
    if (!document.getElementById('avisos') && !document.getElementById('avisosPie')) return;
    if (soportado) {
      try {
        clavePublica = (await pedir(RUTA_CLAVE)).clave;
      } catch {
        clavePublica = null;
      }
    }
    await pintar();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', arrancar);
  } else {
    arrancar();
  }
})();
