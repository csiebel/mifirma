(function () {
  'use strict';

  /* ===========================================================================
     La pantalla del firmante externo.

     Quien llega acá no tiene cuenta, no eligió usar MiFirma y probablemente no
     nos conoce. Todo lo que esta pantalla hace está subordinado a eso: se ve el
     documento antes que cualquier formulario, se dice quién lo manda, y el
     botón de firmar no se enciende hasta que la persona marca que consiente.

     ═══ EL CONSENTIMIENTO NO ES UNA CASILLA DE TÉRMINOS ═══

     Es un requisito de fondo de la firma electrónica: hay que poder demostrar
     que la persona quiso firmar electrónicamente, no que aceptó unas
     condiciones de uso. Por eso el texto exacto que se acepta va al expediente
     junto con su versión — dentro de tres años hay que poder decir qué decía
     exactamente lo que esta persona marcó.

     ═══ LO AUTÓGRAFO COMUNICA ═══

     Lo que se escribe en "tu firma" es representación visual. No es la firma y
     la pantalla no dice que lo sea.
     =========================================================================== */

  var DATOS = null;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function msg(t, clase) {
    $('msg').innerHTML = t ? '<div class="msg ' + clase + '">' + esc(t) + '</div>' : '';
  }

  async function api(path, body) {
    var r = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    var txt = await r.text();
    var data;
    try { data = txt ? JSON.parse(txt) : {}; } catch (e) { data = { error: txt }; }
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    return data;
  }

  function zonaHoraria() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; }
  }

  // Huella estable del navegador, sin datos personales: sirve para decir "el
  // mismo equipo que abrió el documento fue el que firmó".
  function huella() {
    try {
      var s = [navigator.userAgent, navigator.language, screen.width + 'x' + screen.height,
               new Date().getTimezoneOffset()].join('|');
      var h = 0;
      for (var i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
      return 'h' + (h >>> 0).toString(16);
    } catch (e) { return ''; }
  }

  function tokenDelHash() {
    var h = new URLSearchParams((location.hash || '').replace(/^#/, ''));
    return h.get('t') || '';
  }

  // ---------------------------------------------------------------------------
  // Pantallas
  // ---------------------------------------------------------------------------
  function pintarCabecera() {
    $('hTitulo').textContent = DATOS.titulo || 'Documento';
    $('hEmisor').textContent = DATOS.emisor ? 'Te lo envía ' + DATOS.emisor : '';
  }

  function pintarPanel() {
    var d = DATOS;

    if (d.estado === 'firmada') return pintarListo('Ya firmaste este documento.');
    if (d.estado === 'rechazada') return pintarListo('Rechazaste este documento.');

    if (d.papel !== 'firmante') {
      $('panel').innerHTML =
        '<h1>Copia para tu información</h1>' +
        '<p class="lead">Te enviaron este documento para que lo veas. No tenés que firmarlo.</p>';
      return;
    }

    if (!d.me_toca) {
      $('panel').innerHTML =
        '<h1>Todavía no es tu turno</h1>' +
        '<p class="lead">Este documento se firma en orden y falta que firme alguien antes que vos. ' +
        'Te vamos a avisar por correo cuando te toque.</p>';
      return;
    }

    var vence = '';
    if (d.vence_en) {
      try { vence = '<p class="pista">Podés firmarlo hasta el ' +
        new Date(d.vence_en).toLocaleDateString('es', { day: '2-digit', month: 'long', year: 'numeric' }) +
        '.</p>'; } catch (e) {}
    }

    $('panel').innerHTML =
      '<h1>Revisá y firmá</h1>' +
      '<p class="lead">Leé el documento de la izquierda antes de firmar. ' +
      'Cada paso queda registrado en el expediente de evidencias.</p>' +

      '<label for="fNombre">Tu firma</label>' +
      '<input type="text" id="fNombre" class="firmita" maxlength="120" value="' +
        esc(d.firmante.nombre || '') + '" placeholder="Escribí tu nombre" />' +
      '<p class="pista">Es la representación visual que se va a ver en el documento. ' +
      'El valor legal no lo da esto: lo da la firma electrónica.</p>' +

      '<label class="consent" for="fConsent">' +
      '<input type="checkbox" id="fConsent" />' +
      '<span>Acepto firmar este documento electrónicamente y que mi firma electrónica ' +
      'tenga el mismo valor que una firma manuscrita.</span></label>' +

      '<button class="btn btn-p" id="fFirmar" disabled>Firmar</button>' +
      vence +
      '<button class="btn btn-s" id="fRechazar">No lo voy a firmar</button>' +
      '<div id="msg"></div>';

    $('fConsent').addEventListener('change', function () {
      $('fFirmar').disabled = !$('fConsent').checked;
    });
    $('fFirmar').addEventListener('click', firmarAhora);
    $('fRechazar').addEventListener('click', abrirRechazo);
  }

  function pintarListo(texto, detalle) {
    $('pantalla').innerHTML =
      '<div class="listo" style="grid-column:1/-1">' +
      '<div><div class="tick"><svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg></div>' +
      '<h1>' + esc(texto) + '</h1>' +
      '<p class="lead">' + esc(detalle || 'Podés cerrar esta ventana.') + '</p>' +
      '<div id="ofrecerCuenta"></div></div></div>';
    ofrecerCuenta();
  }

  /**
   * El único momento en que esta persona nos está prestando atención.
   *
   * Firmó, salió bien, y hasta hoy la pantalla le decía «podés cerrar esta
   * ventana». Acá se le ofrece quedarse con el documento — y la oferta es
   * literal: al crear la cuenta aparece TODO lo que firmó antes, porque el
   * relleno de la bandeja ya está construido.
   *
   * No pide el correo: lo sabe. Quien llegó por este enlace ya probó que
   * controla esa casilla, así que no hay que hacérselo probar de nuevo.
   */
  async function ofrecerCuenta() {
    var caja = $('ofrecerCuenta');
    if (!caja) return;
    var d;
    try { d = await api('/firmar/cuenta', {}); } catch (e) { return; }
    if (d.ya_tiene) {
      caja.innerHTML =
        '<p class="lead">Este documento ya está en tu repositorio. ' +
        '<a href="/entrar">Entrá a MiFirma</a> para verlo.</p>';
      return;
    }

    var paises = [['UY', 'Uruguay'], ['PY', 'Paraguay'], ['BR', 'Brasil']];
    caja.innerHTML =
      '<div class="oferta">' +
      '<h2>Quedate con tu copia</h2>' +
      '<p class="lead">Creá tu cuenta gratis y este documento —y todos los que ' +
      'hayas firmado antes— quedan guardados a tu nombre. No hace falta que ' +
      'confirmes nada por correo: ya lo hiciste al abrir este enlace.</p>' +
      '<label for="ocPais">Tu país</label>' +
      '<select id="ocPais">' +
      paises.map(function (p) {
        return '<option value="' + p[0] + '"' +
               (p[0] === d.pais_sugerido ? ' selected' : '') + '>' + esc(p[1]) + '</option>';
      }).join('') +
      '</select>' +
      '<p class="pista">Define qué ley y qué certificadores aplican a lo tuyo. ' +
      'No se puede cambiar después.</p>' +
      (d.necesita_password
        ? '<label for="ocPass">Elegí una contraseña</label>' +
          '<input id="ocPass" type="password" autocomplete="new-password" />' +
          '<p class="pista">Mínimo 12 caracteres.</p>'
        : '<p class="pista">Vas a entrar con la contraseña que ya usás en MiFirma.</p>') +
      '<button class="btn btn-p" id="ocBtn">Crear mi cuenta</button>' +
      '<div id="ocMsg"></div></div>';

    $('ocBtn').addEventListener('click', async function () {
      var b = $('ocBtn');
      b.disabled = true; b.textContent = 'Creando…';
      try {
        await api('/firmar/cuenta/crear', {
          pais: $('ocPais').value,
          password: d.necesita_password ? $('ocPass').value : undefined,
        });
        location.href = '/app';
      } catch (e) {
        $('ocMsg').innerHTML = '<div class="msg err">' + esc(e.message) + '</div>';
        b.disabled = false; b.textContent = 'Crear mi cuenta';
      }
    });
  }

  async function firmarAhora() {
    var b = $('fFirmar');
    b.disabled = true;
    b.textContent = 'Firmando…';
    try {
      var r = await api('/firmar/firmar', {
        consentimiento: true,
        nombre_escrito: $('fNombre').value.trim() || undefined,
        zona_horaria: zonaHoraria(),
        huella: huella(),
      });
      pintarListo(
        'Listo, firmaste',
        r.completo
          ? 'El documento quedó firmado por todos. Te va a llegar una copia por correo.'
          : 'Falta que firmen ' + r.faltan + ' persona(s) más. Cuando terminen, te llega la copia.',
      );
    } catch (e) {
      msg(e.message, 'err');
      b.disabled = false;
      b.textContent = 'Firmar';
    }
  }

  function abrirRechazo() {
    $('panel').innerHTML =
      '<h1>No lo vas a firmar</h1>' +
      '<p class="lead">Contale al emisor por qué. Queda en el expediente del documento.</p>' +
      '<label for="fMotivo">Motivo</label>' +
      '<textarea id="fMotivo" maxlength="500" placeholder="Los datos del punto 3 no son correctos"></textarea>' +
      '<button class="btn btn-p" id="fConfirmar">Confirmar que no lo firmo</button>' +
      '<button class="btn btn-s" id="fVolver">Volver</button>' +
      '<div id="msg"></div>';

    $('fVolver').addEventListener('click', pintarPanel);
    $('fConfirmar').addEventListener('click', async function () {
      var m = $('fMotivo').value.trim();
      if (!m) return msg('Escribí el motivo.', 'err');
      $('fConfirmar').disabled = true;
      try {
        await api('/firmar/rechazar', { motivo: m });
        pintarListo('Quedó registrado', 'Le avisamos al emisor que no vas a firmar este documento.');
      } catch (e) { msg(e.message, 'err'); $('fConfirmar').disabled = false; }
    });
  }

  // ---------------------------------------------------------------------------
  // Arranque
  // ---------------------------------------------------------------------------
  async function arrancar() {
    var t = tokenDelHash();
    if (!t) {
      $('panel').innerHTML =
        '<h1>Falta el enlace</h1>' +
        '<p class="lead">Abrí el enlace tal como te llegó por correo. Si lo copiaste a mano, ' +
        'puede haber quedado cortado.</p>';
      return;
    }

    try {
      DATOS = await api('/firmar/abrir', { t: t, zona_horaria: zonaHoraria() });
    } catch (e) {
      $('panel').innerHTML = '<h1>No pudimos abrirlo</h1><p class="lead">' + esc(e.message) + '</p>';
      return;
    }

    // El token ya está en la cookie: se saca de la barra de direcciones para que
    // no quede en el historial ni se comparta sin querer al copiar la URL.
    try { history.replaceState(null, '', location.pathname); } catch (e) {}

    pintarCabecera();
    $('visor').src = '/firmar/documento';
    pintarPanel();
  }

  arrancar();
})();
