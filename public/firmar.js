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
  var VISOR = null;
  // El tipo de marca que se coloca con el próximo toque. Vive acá, en la
  // barra que lo muestra, y el visor lo pregunta. Una sola copia.
  var TIPO_MARCA = 'firma';

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

      '<div id="cajaCaracter"></div>' +
      '<div id="cajaRubrica"></div>' +

      '<label class="consent" for="fConsent">' +
      '<input type="checkbox" id="fConsent" />' +
      '<span>Acepto firmar este documento electrónicamente y que mi firma electrónica ' +
      'tenga el mismo valor que una firma manuscrita.</span></label>' +

      '<button class="btn btn-p" id="fFirmar" disabled>Firmar</button>' +
      vence +
      '<button class="btn btn-s" id="fRechazar">No lo voy a firmar</button>' +
      '<div id="msg"></div>';

    // ⚠ Dos condiciones, no una. El consentimiento nunca alcanzó solo desde que
    // existe el carácter: si esta persona pertenece a alguna empresa, tiene que
    // decir en nombre de quién firma antes de poder firmar.
    window.__caracterListo = true;   // hasta que se sepa que hay algo que elegir
    function repasar() {
      var b = $('fFirmar');
      if (b) b.disabled = !($('fConsent') && $('fConsent').checked) || !window.__caracterListo;
    }
    window.__repasarFirmar = repasar;
    $('fConsent').addEventListener('change', repasar);
    $('fFirmar').addEventListener('click', firmarAhora);
    $('fRechazar').addEventListener('click', abrirRechazo);

    montarCaracter();

    // La firma autógrafa la carga la persona que firma, acá, ahora. Si no
    // carga ninguna se firma igual —el valor legal lo da el PAdES— pero se le
    // dice ANTES, no cuando abra el PDF y no vea su trazo.
    if (window.rubricaMiFirma) {
      window.rubricaMiFirma.montar($('cajaRubrica'), function (est) {
        // El visor dibuja la imagen de verdad adentro de la marca en cuanto la
        // hay: el punto de la pantalla es ver cómo va a quedar ANTES de firmar,
        // no al abrir el PDF firmado.
        window.__firmaEstado = est;
        if (VISOR) VISOR.avisarImagenes(est.tiene, est.version);
      });
    }
  }

  /**
   * En nombre de quién firma.
   *
   * ⚠ La pregunta sólo aparece si esta persona tiene alguna membresía activa.
   * Para la enorme mayoría de los firmantes —que no pertenecen a ninguna empresa
   * del sistema— no hay nada que elegir: firman a título personal y no se les
   * pregunta nada. Ésa es la diferencia entre esto y ponerlo en la pantalla del
   * emisor: allá era una pregunta en todos los envíos, acá es una pregunta sólo
   * cuando hay algo real que decidir.
   *
   * Y no la puede contestar el emisor: «firmo en representación de tal empresa»
   * es una afirmación sobre quién es esta persona, y nadie la hace por otro.
   */
  async function montarCaracter() {
    var caja = $('cajaCaracter');
    if (!caja) return;
    var d;
    try { d = await api('/firmar/caracter', {}); } catch (e) { return; }

    if (!d.empresas || !d.empresas.length) return;   // nada que preguntar

    window.__caracterListo = !!d.caracter;
    if (window.__repasarFirmar) window.__repasarFirmar();

    caja.innerHTML =
      '<label for="fCaracter">¿En nombre de quién firmás?</label>' +
      '<select id="fCaracter">' +
      '<option value=""' + (d.caracter ? '' : ' selected') + '>— elegí</option>' +
      '<option value="personal"' + (d.caracter === 'personal' ? ' selected' : '') +
        '>A título personal</option>' +
      d.empresas.map(function (e) {
        return '<option value="rep:' + e.id + '"' +
          (d.caracter === 'representacion' && d.cuenta_representada_id === e.id ? ' selected' : '') +
          '>En representación de ' + esc(e.nombre) + '</option>';
      }).join('') +
      '</select>' +
      '<p class="pista">Si firmás a título personal, el documento queda en tu repositorio y te ' +
      'lo llevás aunque cambies de trabajo. Si firmás por una empresa, el documento es de ella ' +
      'y dejás de verlo si algún día te vas.</p>' +
      '<div id="fCarMsg"></div>';

    $('fCaracter').addEventListener('change', async function () {
      var v = $('fCaracter').value;
      $('fCarMsg').innerHTML = '';
      if (!v) {
        window.__caracterListo = false;
        return window.__repasarFirmar && window.__repasarFirmar();
      }
      try {
        await api('/firmar/caracter/declarar', v === 'personal'
          ? { caracter: 'personal' }
          : { caracter: 'representacion', cuenta_representada_id: v.slice(4) });
        window.__caracterListo = true;
      } catch (e) {
        window.__caracterListo = false;
        $('fCarMsg').innerHTML = '<div class="msg err">' + esc(e.message) + '</div>';
      }
      if (window.__repasarFirmar) window.__repasarFirmar();
    });
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

    // ⚠ DOS SITUACIONES DISTINTAS, Y DECIRLES LO MISMO ES UN ERROR.
    //
    // `necesita_password` en falso significa que esta persona YA ENTRA a
    // MiFirma: tiene credencial. Lo que no tiene es cuenta persona — un
    // repositorio propio. Es el caso de quien trabaja en una empresa cliente:
    // entra todos los días, y este documento lo firmó a título personal, así
    // que no va al repositorio de su empleador.
    //
    // Decirle «creá tu cuenta gratis» a alguien que ya tiene usuario y
    // contraseña lo hace dudar de si el sistema lo reconoce, justo cuando le
    // estamos pidiendo confianza. Y la tarjeta se contradecía sola: ofrecía
    // crear una cuenta y abajo aclaraba que entrara con la contraseña de
    // siempre.
    var yaEntra = !d.necesita_password;

    caja.innerHTML =
      '<div class="oferta">' +
      (yaEntra
        ? '<h2>Guardalo en tu espacio personal</h2>' +
          '<p class="lead">Ya entrás a MiFirma, pero esto lo firmaste a título ' +
          'personal: no va al repositorio de tu empresa. Abrí tu espacio propio y ' +
          'este documento —y todos los que hayas firmado a tu nombre— quedan ahí, ' +
          'con vos, aunque cambies de trabajo. Entrás con la misma contraseña.</p>'
        : '<h2>Quedate con tu copia</h2>' +
          '<p class="lead">Creá tu cuenta gratis y este documento —y todos los que ' +
          'hayas firmado antes— quedan guardados a tu nombre. No hace falta que ' +
          'confirmes nada por correo: ya lo hiciste al abrir este enlace.</p>') +
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
        : '') +
      '<button class="btn btn-p" id="ocBtn">' +
        (yaEntra ? 'Abrir mi espacio personal' : 'Crear mi cuenta') + '</button>' +
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
        b.disabled = false;
        b.textContent = yaEntra ? 'Abrir mi espacio personal' : 'Crear mi cuenta';
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

  /**
   * La barra de arriba del documento.
   *
   * Sólo aparece si esta persona puede tocar algo. A quien recibió una copia
   * informativa, o a quien todavía no le toca, mostrarle botones que no hacen
   * nada es peor que no mostrarle nada.
   */
  function pintarBarraVisor(puedeTocar) {
    if (!puedeTocar) {
      $('visBarra').innerHTML =
        '<p class="pista">Documento enviado por ' + esc(DATOS.emisor || 'el emisor') + '</p>';
      return;
    }
    $('visBarra').innerHTML =
      '<div class="vis-seg">' +
      '  <button type="button" class="btn" id="vTFirma">Firma</button>' +
      '  <button type="button" class="btn" id="vTRubrica">Inicial</button>' +
      '</div>' +
      '<p class="pista" id="vPista"></p>' +
      '<div id="visMsg"></div>';

    // ⚠ El nombre del botón es el mismo que el del bloque de la derecha:
    // «Inicial», no «Rúbrica». Eran la misma cosa con dos nombres, y con dos
    // nombres no hay forma de darse cuenta de que lo son.
    function elegir(t) {
      TIPO_MARCA = t;
      $('vTFirma').className = 'btn ' + (t === 'firma' ? 'btn-p' : 'btn-s');
      $('vTRubrica').className = 'btn ' + (t === 'rubrica' ? 'btn-p' : 'btn-s');
      $('vPista').textContent = t === 'firma'
        ? 'Tocá la hoja para poner tu firma. Arrastrala para acomodarla.'
        : 'Tocá cada hoja para poner tu inicial. Arrastrala para acomodarla.';
    }
    $('vTFirma').addEventListener('click', function () { elegir('firma'); });
    $('vTRubrica').addEventListener('click', function () { elegir('rubrica'); });
    elegir(TIPO_MARCA);
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
    pintarPanel();

    // El visor va DESPUÉS del panel: montar pdf.js tarda —descarga el worker y
    // mide todas las hojas— y no hay motivo para que el formulario espere.
    var puedeTocar =
      DATOS.papel === 'firmante' && DATOS.me_toca &&
      DATOS.estado !== 'firmada' && DATOS.estado !== 'rechazada';

    if (window.visorMiFirma) {
      pintarBarraVisor(puedeTocar);
      VISOR = await window.visorMiFirma.montar($('visCaja'), {
        editable: puedeTocar,
        // El visor pregunta qué se coloca; no guarda su propia copia.
        tipoActual: function () { return TIPO_MARCA; },
        alCambiar: function () {
          if (window.rubricaMiFirma) window.rubricaMiFirma.revisarPedidos();
        },
      });
      // Las imágenes pueden haberse cargado mientras el PDF se estaba midiendo.
      if (VISOR && window.__firmaEstado) {
        VISOR.avisarImagenes(window.__firmaEstado.tiene, window.__firmaEstado.version);
      }
    } else {
      $('visCaja').innerHTML =
        '<iframe title="Documento" src="/firmar/documento" class="vis-iframe"></iframe>';
    }
  }

  arrancar();
})();
