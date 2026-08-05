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
  window.__camposListos = true;   // hasta que se sepa que hay campos obligatorios

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function msg(t, clase) {
    $('msg').innerHTML = t ? '<div class="msg ' + clase + '">' + esc(t) + '</div>' : '';
  }

  /* =========================================================================
     «¿Se colgó, o está trabajando?»

     Firmar tarda ocho segundos largos: hay que pedirle el sello de tiempo a una
     autoridad externa, armar el PKCS#7 y reescribir el PDF. Y quien está de este
     lado no tiene cuenta, no eligió usar MiFirma y no nos conoce: una pantalla
     quieta después de apretar Firmar es, para él, una pantalla rota. Lo que hace
     es apretar de nuevo.

     ⚠ Va adentro de `api()` y no en cada botón: por acá pasan todas las llamadas
     de esta pantalla. Y espera 180 ms antes de aparecer — la mayoría vuelven
     antes, y una barra que parpadea en cada tecla se aprende a ignorar.
     ======================================================================== */
  var enVuelo = 0;
  var temporizador = null;

  function marcarTrabajo(activo) {
    var b = document.getElementById('trabajando');
    if (!b) {
      if (!activo) return;
      b = document.createElement('div');
      b.id = 'trabajando';
      b.className = 'trabajando';
      b.setAttribute('role', 'status');
      b.setAttribute('aria-label', 'Trabajando');
      document.body.appendChild(b);
    }
    b.classList.toggle('visible', activo);
  }

  function abrioUno() {
    enVuelo++;
    if (temporizador || enVuelo > 1) return;
    temporizador = setTimeout(function () {
      temporizador = null;
      if (enVuelo > 0) marcarTrabajo(true);
    }, 180);
  }

  function cerroUno() {
    enVuelo = Math.max(0, enVuelo - 1);
    if (enVuelo > 0) return;
    if (temporizador) { clearTimeout(temporizador); temporizador = null; }
    marcarTrabajo(false);
  }

  /**
   * ⚠ La misma cuenta para los otros archivos de esta pantalla.
   *
   * El visor y el bloque de la rúbrica traen su propio `fetch` —son módulos
   * aparte, cargados por separado— y son justo los que más tardan, porque suben
   * y bajan imágenes. Sin esto, la barra sólo cubría la mitad de los clics de la
   * pantalla, que es peor que no tenerla: aparece a veces y se deja de mirar.
   *
   * Una sola cuenta compartida. Si dos módulos tienen una petición en vuelo, la
   * barra se va cuando vuelve la última, no cuando vuelve la primera.
   */
  window.trabajandoMiFirma = { abrio: abrioUno, cerro: cerroUno };

  async function api(path, body) {
    abrioUno();
    var r;
    try {
      r = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
    } finally {
      // En el `finally`: si la red se corta, la barra se va igual. Una barra que
      // queda girando para siempre miente peor que no tener ninguna.
      cerroUno();
    }
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

      '<div id="cajaCampos"></div>' +
      '<div id="cajaCaracter"></div>' +
      '<div id="cajaRubrica"></div>' +

      '<label class="consent" for="fConsent">' +
      '<input type="checkbox" id="fConsent" />' +
      '<span>Acepto firmar este documento electrónicamente y que mi firma electrónica ' +
      'tenga el mismo valor que una firma manuscrita.</span></label>' +

      '<button class="btn btn-p" id="fFirmar" disabled>Firmar</button>' +
      '<div id="faltaFirmar"></div>' +
      vence +
      '<button class="btn btn-s" id="fRechazar">No lo voy a firmar</button>' +
      '<div id="msg"></div>';

    // ⚠ Dos condiciones, no una. El consentimiento nunca alcanzó solo desde que
    // existe el carácter: si esta persona pertenece a alguna empresa, tiene que
    // decir en nombre de quién firma antes de poder firmar.
    window.__caracterListo = true;   // hasta que se sepa que hay algo que elegir

    /**
     * Enciende o apaga el botón de firmar — y DICE POR QUÉ.
     *
     * ⚠ Un botón deshabilitado sin explicación es indistinguible de uno roto.
     * Pasó de verdad: la pregunta del carácter vive arriba del panel, alguien
     * con el panel scrolleado no la ve, aprieta Firmar y no pasa nada. Desde
     * afuera eso es un sistema que falla en silencio, y la persona no tiene
     * ninguna forma de saber que le falta contestar algo que ni siquiera está
     * en pantalla.
     *
     * Es la misma lección del error que quedaba abajo del borde: lo que impide
     * avanzar tiene que estar escrito donde uno intenta avanzar, no donde el
     * programa lo tiene guardado.
     */
    function repasar() {
      var b = $('fFirmar');
      if (!b) return;
      var sinConsentir = !($('fConsent') && $('fConsent').checked);
      var sinCaracter = !window.__caracterListo;
      var sinCampos = window.__camposListos === false;
      b.disabled = sinConsentir || sinCaracter || sinCampos;

      var av = $('faltaFirmar');
      if (!av) return;
      if (sinCampos) {
        var falt = window.__camposFaltan || [];
        var puedoLlevar = VISOR && falt.length && falt[0].id;
        av.innerHTML =
          '<div class="msg aviso">Falta completar sobre el documento: <b>' +
          esc(falt.map(function (c) { return c.etiqueta || c; }).join(', ')) + '</b>.' +
          (puedoLlevar
            ? '<button type="button" class="btn btn-s" id="irCampo" ' +
              'style="margin-top:10px">Ir a ese campo</button>'
            : '') +
          '</div>';
        // Saber QUÉ falta sin saber DÓNDE es la mitad inútil del dato: en un
        // documento de veinte hojas, el campo que falta puede estar en la
        // catorce y no hay forma de encontrarlo mirando.
        if (puedoLlevar) {
          $('irCampo').addEventListener('click', function () { VISOR.irACampo(falt[0].id); });
        }
      } else if (sinCaracter) {
        av.innerHTML =
          '<div class="msg aviso">Falta que nos digas <b>en nombre de quién firmás</b>. ' +
          '<button type="button" class="btn btn-s" id="irCaracter" ' +
          'style="margin-top:10px">Ir a esa pregunta</button></div>';
        $('irCaracter').addEventListener('click', function () {
          var c = $('cajaCaracter');
          if (!c) return;
          c.scrollIntoView({ block: 'center', behavior: 'smooth' });
          var sel = $('fCaracter');
          if (sel) setTimeout(function () { sel.focus(); }, 350);
        });
      } else {
        av.innerHTML = '';
      }
    }
    window.__repasarFirmar = repasar;
    $('fConsent').addEventListener('change', repasar);
    $('fFirmar').addEventListener('click', firmarAhora);
    $('fRechazar').addEventListener('click', abrirRechazo);

    montarCampos();
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
   * Los datos que hay que completar antes de firmar.
   *
   * ═══ DÓNDE SE COMPLETAN ═══
   *
   * Sobre el documento, en el lugar donde van. No acá.
   *
   * ⚠ Acá había una lista de inputs, y estaba mal. El primer PDF con formulario
   * que se probó lo dijo entero: «no me deja editar ningún campo, cuando toco,
   * el botón del mouse pone la firma». La persona hace lo que haría con
   * cualquier formulario —tocar el renglón— y el sistema le estampaba una firma.
   *
   * Este panel pasa a decir CUÁNTOS son y a llevar hasta el que falta. Los
   * inputs viven en el visor, encima de su rectángulo. Ver `pintarCampos` en
   * visor.js.
   *
   * ⚠ Se guardan de a uno, apenas la persona sale del campo, y no al apretar
   * Firmar. Dos motivos: el error de un campo no se lleva puestos los otros
   * cuatro que estaban bien, y si el navegador se cierra a mitad de un
   * formulario largo no se perdió nada.
   *
   * ⚠ Y lo que se guarda NO es definitivo. El valor se congela recién al
   * firmar, con su hash, adentro de la misma transacción que la firma —
   * `congelarCampos` en el servidor—. Hasta ese momento se puede corregir; a
   * partir de ahí, no. Un campo editable sobre un documento firmado es un
   * documento que dice cosas distintas según cuándo se lo mire.
   */
  var CAMPOS = null;

  /**
   * La lista, una sola vez y compartida.
   *
   * ⚠ El visor y este panel miran EL MISMO array de objetos. No hay dos copias
   * del valor de un campo: el visor escribe `c.valor` y el panel lo lee de ahí.
   * Duplicar estado entre el visor y la barra ya costó dos síntomas distintos
   * con el tipo de marca; una promesa compartida cierra esa puerta.
   */
  function pedirCampos() {
    if (!CAMPOS) {
      CAMPOS = api('/firmar/campos', {})
        .then(function (d) { return d.campos || []; })
        .catch(function () { return []; });
    }
    return CAMPOS;
  }

  function faltantes(lista) {
    return lista.filter(function (c) {
      return c.mio && c.obligatorio && !c.congelado &&
             (c.valor == null || String(c.valor).trim() === '');
    }).map(function (c) { return { id: c.id, etiqueta: c.etiqueta }; });
  }

  function anotarFaltantes(falt) {
    window.__camposListos = falt.length === 0;
    window.__camposFaltan = falt;
    if (window.__repasarFirmar) window.__repasarFirmar();
  }

  /** El índice: cuántos datos piden y dónde están. Los inputs los pone el visor. */
  async function montarCampos() {
    var caja = $('cajaCampos');
    if (!caja) return;
    var lista = await pedirCampos();
    var mios = lista.filter(function (c) { return c.mio; });
    if (!mios.length) return;

    caja.innerHTML =
      '<label>Datos que te piden</label>' +
      '<p class="pista" style="margin-top:0">Este documento te pide <b>' + mios.length +
      (mios.length === 1 ? ' dato' : ' datos') + '</b>. Están marcados sobre el documento, ' +
      'en el lugar donde van: tocá el recuadro y escribí. Quedan fijos con tu firma y ' +
      'después no se pueden cambiar.</p>' +
      '<div id="campMsg"></div>';

    // El estado arranca acá porque el visor tarda —descarga el worker y mide
    // todas las hojas— y hasta que termine el botón de firmar no puede estar
    // encendido si hay obligatorios sin contestar.
    anotarFaltantes(faltantes(lista));
  }

  /**
   * El respaldo: los campos en el panel, con inputs.
   *
   * ⚠ Sólo cuando pdf.js NO cargó y el documento se está viendo en un iframe.
   * Ahí no hay hoja sobre la cual dibujar nada, y sin esto la persona no podría
   * completar y por lo tanto no podría firmar. Son dos caminos excluyentes: o
   * manda el visor, o manda esto. Nunca los dos.
   */
  async function camposEnElPanel() {
    var caja = $('cajaCampos');
    if (!caja) return;
    var lista = await pedirCampos();
    var mios = lista.filter(function (c) { return c.mio; });
    if (!mios.length) return;

    caja.innerHTML =
      '<label>Datos que te piden</label>' +
      '<p class="pista" style="margin-top:0">Se completan una sola vez y quedan fijos con tu ' +
      'firma. Después no se pueden cambiar.</p>' +
      mios.map(function (c, i) { return campoHtml(c, i); }).join('') +
      '<div id="campMsg"></div>';

    mios.forEach(function (c, i) {
      var el = $('camp' + i);
      if (!el) return;
      if (c.congelado) { el.disabled = true; return; }
      var evento = (c.tipo === 'casilla' || c.tipo === 'opcion') ? 'change' : 'blur';
      el.addEventListener(evento, async function () {
        var v = c.tipo === 'casilla' ? (el.checked ? 'sí' : '') : el.value;
        try {
          await api('/firmar/campos/guardar', { campo_id: c.id, valor: v === '' ? null : v });
          c.valor = v === '' ? null : v;
          el.style.borderColor = '';
          $('campMsg').innerHTML = '';
        } catch (e) {
          el.style.borderColor = 'var(--danger)';
          $('campMsg').innerHTML = '<div class="msg err">' + esc(e.message) + '</div>';
        }
        anotarFaltantes(faltantes(lista));
      });
    });

    anotarFaltantes(faltantes(lista));
  }

  function campoHtml(c, i) {
    var id = 'camp' + i;
    var v = c.valor == null ? '' : String(c.valor);
    var et = '<label for="' + id + '" style="margin-top:14px">' + esc(c.etiqueta) +
      (c.obligatorio ? ' <span style="color:var(--danger)">*</span>' : '') + '</label>';

    if (c.tipo === 'casilla') {
      return '<label class="consent" for="' + id + '" style="margin-top:12px">' +
        '<input type="checkbox" id="' + id + '"' + (v ? ' checked' : '') + ' />' +
        '<span>' + esc(c.etiqueta) + (c.obligatorio ? ' *' : '') + '</span></label>';
    }
    if (c.tipo === 'opcion') {
      var ops = Array.isArray(c.opciones) ? c.opciones : [];
      return et + '<select id="' + id + '" class="campo-dato">' +
        '<option value="">— elegí</option>' +
        ops.map(function (o) {
          return '<option value="' + esc(o) + '"' + (v === o ? ' selected' : '') + '>' + esc(o) + '</option>';
        }).join('') + '</select>';
    }
    if (c.tipo === 'parrafo') {
      return et + '<textarea id="' + id + '" maxlength="2000">' + esc(v) + '</textarea>';
    }
    var tipoHtml = c.tipo === 'fecha' ? 'date' : (c.tipo === 'numero' || c.tipo === 'moneda' ? 'text' : 'text');
    return et + '<input id="' + id + '" type="' + tipoHtml + '" class="campo-dato" maxlength="500" value="' +
      esc(v) + '" />';
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

    // Sin contestar, el bloque se marca: si la persona llega scrolleada, tiene
    // que reconocer de un vistazo qué es lo que le falta.
    caja.className = d.caracter ? '' : 'pendiente';
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
        caja.className = '';
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
      // El atajo del contrato largo: cuarenta hojas inicialadas a mano son
      // cuarenta toques y una probabilidad muy alta de saltearse una. Poner una
      // por una sigue estando: esto no reemplaza nada, evita lo repetitivo.
      '<button type="button" class="btn btn-s" id="vTodas">En todas las hojas</button>' +
      '<button type="button" class="btn btn-s" id="vLimpiar">Quitar las mías</button>' +
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
        ? 'Tocá la hoja para poner tu firma, o ponela en todas de una vez.'
        : 'Tocá cada hoja para poner tu inicial, o ponela en todas de una vez.';
    }
    $('vTFirma').addEventListener('click', function () { elegir('firma'); });
    $('vTRubrica').addEventListener('click', function () { elegir('rubrica'); });

    // Pone la marca del tipo elegido en todas las hojas. Que dependa del
    // segmentado y no sea un botón por tipo es a propósito: el tipo ya está
    // elegido arriba y repetirlo abajo es ofrecer dos verdades sobre lo mismo.
    $('vTodas').addEventListener('click', async function () {
      var b = $('vTodas');
      b.disabled = true;
      var antes = b.textContent;
      b.textContent = 'Poniendo…';
      if (VISOR) await VISOR.enTodasLasHojas(TIPO_MARCA);
      b.disabled = false; b.textContent = antes;
      if (window.rubricaMiFirma) window.rubricaMiFirma.revisarPedidos();
    });

    $('vLimpiar').addEventListener('click', async function () {
      if (VISOR) await VISOR.limpiarMisMarcas();
      if (window.rubricaMiFirma) window.rubricaMiFirma.revisarPedidos();
    });

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
        // Los campos se completan sobre la hoja. El panel no guarda copia del
        // valor: sólo se entera de qué falta.
        campos: pedirCampos,
        guardarCampo: function (id, valor) {
          return api('/firmar/campos/guardar', { campo_id: id, valor: valor });
        },
        alCambiarCampos: anotarFaltantes,
      });
      // Las imágenes pueden haberse cargado mientras el PDF se estaba midiendo.
      if (VISOR && window.__firmaEstado) {
        VISOR.avisarImagenes(window.__firmaEstado.tiene, window.__firmaEstado.version);
      }
      if (VISOR) {
        avisarDeLosCampos(VISOR.cuantosCampos());
      } else {
        // pdf.js no cargó y el documento quedó en un iframe: no hay hoja sobre
        // la cual escribir, así que los campos vuelven al panel.
        camposEnElPanel();
      }
    } else {
      $('visCaja').innerHTML =
        '<iframe title="Documento" src="/firmar/documento" class="vis-iframe"></iframe>';
      camposEnElPanel();
    }
  }

  /**
   * Que la barra diga que hay campos.
   *
   * ⚠ La barra explicaba cómo poner la firma y no decía una palabra de los
   * datos, sobre un documento que no se puede firmar sin completarlos. Lo que
   * bloquea tiene que estar escrito donde uno está mirando.
   */
  function avisarDeLosCampos(cuantos) {
    var p = $('vPista');
    if (!p || !cuantos) return;
    var n = document.createElement('span');
    n.className = 'vis-aviso-campos';
    n.textContent = cuantos === 1
      ? 'Este documento te pide 1 dato: está marcado en amarillo.'
      : 'Este documento te pide ' + cuantos + ' datos: están marcados en amarillo.';
    p.parentNode.insertBefore(n, p.nextSibling);
  }

  arrancar();
})();
