(function () {
  'use strict';

  /* ===========================================================================
     Consola del operador.

     Tres pantallas: correo, Twilio y planes con precios. Es la parametría de la
     plataforma — lo que en payroll estaba desparramado entre código y base.

     ═══ REALM PROPIO ═══

     El operador no es un usuario de ninguna cuenta: tiene su propia tabla
     (`operador`, migración 010), su propio JWT y su propia cookie (`sess_op`,
     con Path=/operador). Por eso esta consola no comparte NADA con la del
     cliente, ni siquiera la sesión: entrar acá no te mete en ninguna empresa, y
     estar dentro de una empresa no te abre esto.

     ═══ LO QUE NO SE MUESTRA ═══

     Las credenciales guardadas —contraseña de SMTP, token de Twilio— nunca
     vuelven del servidor: llegan enmascaradas. Un campo vacío significa "no la
     cambies", no "borrala". Es la diferencia entre poder corregir el puerto sin
     tener la contraseña a mano y tener que volver a pedírsela a alguien.
     =========================================================================== */

  var YO = null;
  var PRESETS = {};
  var DATOS = null;       // respuesta de /operador/planes
  var PLAN_SEL = null;

  var VISTAS = ['correo', 'twilio', 'planes', 'paises', 'proveedores', 'pasarelas', 'operadores', 'plata', 'bitacora'];

  // El catálogo de países, tal como lo devuelve la base. Antes acá había un
  // `{ UY:'UYU', PY:'PYG', BR:'BRL' }` escrito a mano: agregar Chile era editar
  // este archivo, el HTML de al lado y dos archivos del servidor.
  var PAISES = [];

  /** La moneda de cobro de un país. Sin fila en el catálogo, dólares. */
  function monedaDe(pais) {
    for (var i = 0; i < PAISES.length; i++) if (PAISES[i].codigo === pais) return PAISES[i].moneda;
    return 'USD';
  }
  function nombreDe(pais) {
    for (var i = 0; i < PAISES.length; i++) {
      if (PAISES[i].codigo === pais) {
        var n = PAISES[i].nombre_i18n || {};
        return (PAISES[i].bandera ? PAISES[i].bandera + ' ' : '') + (n.es || n.en || pais);
      }
    }
    return pais;
  }

  var ETIQUETA_METRICA = {
    abono: 'Abono mensual',
    firma: 'Por firma',
    documento: 'Por documento',
    circuito: 'Por circuito enviado',
    sms: 'Por SMS enviado',
  };
  var AYUDA_METRICA = {
    abono: 'Lo fijo del plan, se cobre o no se use.',
    firma: 'Cada firma estampada. El mismo documento con tres firmantes cuenta tres.',
    documento: 'Cada documento, sin importar cuántos lo firmen.',
    circuito: 'Cada envío a firmar, sin importar cuántos documentos lleve.',
    sms: 'Lo que se le traslada al cliente por cada SMS de aviso.',
  };
  var ETIQUETA_NIVEL = { simple: 'Simple', avanzada: 'Avanzada' };

  // ---------------------------------------------------------------------------
  function $(id) { return document.getElementById(id); }

  /* ---------------------------------------------------------------------------
     Campos de credencial: por qué no son un input común.

     El 1/8/2026 la clave SMTP se sobrescribió sola dos veces. No se perdía: se
     GUARDABA OTRA. La causa es el gestor de contraseñas del navegador, que
     rellena cualquier `input[type=password]` de un sitio conocido — y como el
     formulario manda lo que haya en el campo al tocar "Guardar", cambiar el
     puerto o el remitente pisaba la credencial con una contraseña de otro lado.
     Sin error, sin aviso, y el síntoma aparecía recién al mandar un correo.

     Dos defensas, porque `autocomplete="off"` no la respeta nadie:

       1. Mientras hay credencial guardada, el input NO EXISTE en pantalla: se
          muestra la máscara y un botón "Cambiar". Un campo que no está no se
          autocompleta.
       2. El input arranca `readonly` y se libera al pedirlo explícitamente.
          Los gestores saltean los campos de sólo lectura.

     Y la regla de fondo: sólo se manda la credencial si el usuario abrió el
     campo a propósito. Nunca "por las dudas".
     --------------------------------------------------------------------------- */
  function campoSecreto(idInput, idBloque, idMask, idBoton) {
    return {
      /** Hay credencial guardada: mostrar la máscara y esconder el input. */
      pintar: function (tiene, mascara) {
        var inp = $(idInput), bloque = $(idBloque);
        inp.value = '';
        if (tiene) {
          $(idMask).textContent = mascara || '••••••••';
          bloque.classList.remove('hidden');
          inp.classList.add('hidden');
          inp.setAttribute('readonly', 'readonly');
        } else {
          bloque.classList.add('hidden');
          inp.classList.remove('hidden');
          inp.removeAttribute('readonly');
        }
      },
      cablear: function () {
        var b = $(idBoton);
        if (!b || b.dataset.listo) return;
        b.dataset.listo = '1';
        b.addEventListener('click', function () {
          var inp = $(idInput);
          $(idBloque).classList.add('hidden');
          inp.classList.remove('hidden');
          inp.removeAttribute('readonly');
          inp.value = '';
          inp.focus();
        });
      },
      /** El valor a mandar, o undefined si el usuario no lo tocó. */
      valor: function () {
        var inp = $(idInput);
        if (inp.classList.contains('hidden')) return undefined;
        return inp.value ? inp.value : undefined;
      },
    };
  }

  var SECRETO_CORREO = campoSecreto('cPassword', 'cPassGuardada', 'cPassMask', 'cPassCambiar');
  var SECRETO_TWILIO = campoSecreto('tToken', 'tTokenGuardado', 'tTokenMask', 'tTokenCambiar');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function csrf() {
    var m = document.cookie.match(/(?:^|;\s*)csrf_op=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  async function api(path, method, body) {
    var opt = { method: method || 'GET', credentials: 'same-origin', headers: {} };
    if (opt.method !== 'GET') {
      var c = csrf();
      if (c) opt.headers['X-CSRF-Token'] = c;
    }
    if (body) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    var r = await fetch(path, opt);
    var txt = await r.text();
    var data;
    try { data = txt ? JSON.parse(txt) : {}; } catch (e) { data = { error: txt }; }
    if (r.status === 401) { mostrarLogin(); throw new Error(data.error || 'Sesión vencida.'); }
    if (!r.ok) throw new Error(data.error || data.message || ('HTTP ' + r.status));
    return data;
  }

  function msg(id, texto, clase) {
    var el = $(id);
    if (el) el.innerHTML = texto ? '<div class="msg ' + clase + '">' + esc(texto) + '</div>' : '';
  }
  function ok(id, texto) {
    msg(id, texto, 'ok');
    setTimeout(function () { msg(id, '', ''); }, 3000);
  }

  // ===========================================================================
  // Sesión
  // ===========================================================================
  function mostrarLogin() {
    YO = null;
    $('vLogin').classList.remove('hidden');
    $('lateral').classList.add('hidden');
    $('contenido').classList.add('hidden');
    document.body.classList.remove('dentro');
  }

  function mostrarConsola() {
    $('vLogin').classList.add('hidden');
    $('lateral').classList.remove('hidden');
    $('contenido').classList.remove('hidden');
    document.body.classList.add('dentro');
    $('pieOperador').textContent = YO.usuario || '';
    $('pieRol').textContent = YO.es_superadmin
      ? 'Superadmin'
      : (YO.capacidades || []).length + ' privilegios';
    ir((location.hash || '').slice(1) || 'correo');
  }

  async function entrar() {
    var usuario = $('lUsuario').value.trim(), password = $('lPassword').value;
    if (!usuario || !password) return msg('msgLogin', 'Completá usuario y contraseña.', 'err');
    $('btnEntrar').disabled = true;
    msg('msgLogin', '', '');
    try {
      await api('/operador/login', 'POST', { usuario: usuario, password: password });
      YO = await api('/operador/yo');
      mostrarConsola();
    } catch (e) {
      msg('msgLogin', e.message, 'err');
    } finally {
      $('btnEntrar').disabled = false;
    }
  }

  async function salir() {
    try { await api('/operador/logout', 'POST'); } catch (e) { /* igual salimos */ }
    location.reload();
  }

  function ir(vista) {
    if (VISTAS.indexOf(vista) < 0) vista = 'correo';
    VISTAS.forEach(function (v) {
      var sec = $('v' + v[0].toUpperCase() + v.slice(1));
      if (sec) sec.classList.toggle('hidden', v !== vista);
    });
    document.querySelectorAll('nav.menu button').forEach(function (b) {
      b.setAttribute('aria-current', String(b.dataset.v === vista));
    });
    if (location.hash.slice(1) !== vista) location.hash = vista;
    window.scrollTo(0, 0);

    if (vista === 'correo') cargarCorreo();
    if (vista === 'twilio') cargarTwilio();
    if (vista === 'planes') cargarPlanes();
    if (vista === 'paises') cargarPaises();
    if (vista === 'proveedores') cargarProveedores();
    if (vista === 'pasarelas') cargarPasarelas();
    if (vista === 'operadores') cargarOperadores();
    if (vista === 'plata') cargarPlata();
    if (vista === 'bitacora') cargarBitacora();
  }

  // ===========================================================================
  // CORREO
  // ===========================================================================
  async function cargarCorreo() {
    try {
      var j = await api('/operador/correo');
      PRESETS = j.presets || {};
      pintarCorreo(j.config);
    } catch (e) {
      msg('msgCorreo', e.message, 'err');
    }
  }

  function pintarCorreo(c) {
    if (c) {
      $('cPreset').value = PRESETS[c.proveedor] ? c.proveedor : 'otro';
      $('cHost').value = c.host || '';
      $('cPuerto').value = c.puerto || '';
      $('cSeg').value = c.seguridad || 'tls';
      $('cUsuario').value = c.usuario || '';
      $('cRemNombre').value = c.remitente_nombre || '';
      $('cRemEmail').value = c.remitente_email || '';
      SECRETO_CORREO.pintar(c.tiene_password, c.password_mask);
    } else {
      aplicarPreset();
      $('cRemNombre').value = 'MiFirma';
      SECRETO_CORREO.pintar(false, '');
    }
    SECRETO_CORREO.cablear();

    // Guardada pero ilegible: la clave de cifrado del servidor no es la que se
    // usó para guardarla. Decirlo acá evita el ciclo de cargarla de nuevo una y
    // otra vez sin que nada mejore.
    if (c && c.tiene_password && c.password_descifrable === false) {
      msg('msgCorreo',
        'La contraseña está guardada pero no se puede descifrar: la clave de cifrado del servidor ' +
        '(huella ' + (c.huella_clave || '?') + ') no es la que se usó para guardarla. ' +
        'Cargala de nuevo.', 'err');
    }

    var estado = !c
      ? '<span class="pill off">Sin configurar</span>'
      : c.activo
        ? '<span class="pill on">Activa</span>'
        : '<span class="pill des">Configurada pero apagada</span>';
    $('estadoCorreo').innerHTML = estado +
      (c && !c.activo ? ' No sale ningún correo.' : '');

    $('accCorreo').innerHTML = !c
      ? ''
      : '<button class="btn btn-s chico" id="btnCorreoOnOff">' +
        (c.activo ? 'Apagar' : 'Encender') + '</button>';
    if (c) {
      $('btnCorreoOnOff').addEventListener('click', async function () {
        try {
          await api('/operador/correo', 'PATCH', { activo: !c.activo });
          cargarCorreo();
        } catch (e) { msg('msgCorreo', e.message, 'err'); }
      });
    }
  }

  function aplicarPreset() {
    var p = PRESETS[$('cPreset').value];
    if (!p) return;
    $('cHost').value = p.host;
    $('cPuerto').value = p.puerto;
    $('cSeg').value = p.seguridad;
  }

  async function guardarCorreo() {
    msg('msgCorreo', '', '');
    try {
      await api('/operador/correo', 'POST', {
        proveedor: $('cPreset').value,
        host: $('cHost').value.trim(),
        puerto: Number($('cPuerto').value),
        seguridad: $('cSeg').value,
        usuario: $('cUsuario').value.trim(),
        // undefined = "no la cambies". Nunca se manda lo que haya en el campo:
        // ver `campoSecreto`.
        password: SECRETO_CORREO.valor(),
        remitente_nombre: $('cRemNombre').value.trim(),
        remitente_email: $('cRemEmail').value.trim(),
      });
      // El orden importa: guardar deja la conexión apagada, y la prueba sale
      // por la conexión ACTIVA. Probar antes de encender falla siempre.
      ok('msgCorreo', 'Guardado. Encendela y después mandate un correo de prueba.');
      cargarCorreo();
    } catch (e) { msg('msgCorreo', e.message, 'err'); }
  }

  function probarCorreo() {
    abrirModal(
      '<h2>Correo de prueba</h2>' +
      '<p class="sub">Sale por la conexión guardada. Si está apagada, esto va a fallar — encendela primero.</p>' +
      '<label for="mPara">A qué dirección</label>' +
      '<input id="mPara" type="email" value="' + esc($('cUsuario').value) + '" />' +
      '<div id="msgModal"></div>' +
      '<div class="acc"><button class="btn btn-s" id="mCancel">Cancelar</button>' +
      '<button class="btn btn-p" id="mOk">Mandar</button></div>'
    );
    $('mCancel').addEventListener('click', cerrarModal);
    $('mOk').addEventListener('click', async function () {
      $('mOk').disabled = true;
      try {
        await api('/operador/correo/prueba', 'POST', { para: $('mPara').value.trim() });
        cerrarModal();
        ok('msgCorreo', 'Mandado. Si no llega en un par de minutos, mirá el spam.');
      } catch (e) { msg('msgModal', e.message, 'err'); $('mOk').disabled = false; }
    });
  }

  // ===========================================================================
  // TWILIO
  // ===========================================================================
  async function cargarTwilio() {
    try {
      var j = await api('/operador/twilio');
      pintarTwilio(j.config);
    } catch (e) { msg('msgTwilio', e.message, 'err'); }
  }

  function pintarTwilio(c) {
    if (c) {
      $('tSid').value = c.account_sid || '';
      $('tSms').value = c.from_sms || '';
      $('tWa').value = c.from_whatsapp || '';
      $('tContent').value = c.wa_content_sid || '';
      SECRETO_TWILIO.pintar(c.tiene_token, c.token_mask);
    } else {
      SECRETO_TWILIO.pintar(false, '');
    }
    SECRETO_TWILIO.cablear();
    $('estadoTwilio').innerHTML = !c
      ? '<span class="pill off">Sin configurar</span> El código sale por correo.'
      : c.activo
        ? '<span class="pill on">Activa</span>'
        : '<span class="pill des">Configurada pero apagada</span>';

    $('accTwilio').innerHTML = !c
      ? ''
      : '<button class="btn btn-s chico" id="btnTwOnOff">' + (c.activo ? 'Apagar' : 'Encender') + '</button>';
    if (c) {
      $('btnTwOnOff').addEventListener('click', async function () {
        try {
          await api('/operador/twilio', 'PATCH', { activo: !c.activo });
          cargarTwilio();
        } catch (e) { msg('msgTwilio', e.message, 'err'); }
      });
    }
  }

  async function guardarTwilio() {
    msg('msgTwilio', '', '');
    try {
      await api('/operador/twilio', 'POST', {
        account_sid: $('tSid').value.trim(),
        auth_token: SECRETO_TWILIO.valor(),
        from_sms: $('tSms').value.trim() || undefined,
        from_whatsapp: $('tWa').value.trim() || undefined,
        wa_content_sid: $('tContent').value.trim() || undefined,
      });
      ok('msgTwilio', 'Guardado.');
      cargarTwilio();
    } catch (e) { msg('msgTwilio', e.message, 'err'); }
  }

  function probarTwilio() {
    abrirModal(
      '<h2>Mensaje de prueba</h2>' +
      '<p class="sub">El teléfono va en formato internacional, con el «+» y el código de país.</p>' +
      '<label for="mCanal">Por dónde</label>' +
      '<select id="mCanal"><option value="sms">SMS</option><option value="whatsapp">WhatsApp</option></select>' +
      '<label for="mTel">Teléfono</label>' +
      '<input id="mTel" placeholder="+59899123456" />' +
      '<div id="msgModal"></div>' +
      '<div class="acc"><button class="btn btn-s" id="mCancel">Cancelar</button>' +
      '<button class="btn btn-p" id="mOk">Mandar</button></div>'
    );
    $('mCancel').addEventListener('click', cerrarModal);
    $('mOk').addEventListener('click', async function () {
      $('mOk').disabled = true;
      try {
        await api('/operador/twilio/prueba', 'POST', {
          canal: $('mCanal').value,
          telefono: $('mTel').value.trim(),
        });
        cerrarModal();
        ok('msgTwilio', 'Mandado.');
      } catch (e) { msg('msgModal', e.message, 'err'); $('mOk').disabled = false; }
    });
  }

  // ===========================================================================
  // PLANES Y PRECIOS
  // ===========================================================================
  async function cargarPlanes() {
    try {
      DATOS = await api('/operador/planes');
      // El catálogo de países define la moneda de cada precio: sin él, el
      // selector queda vacío y la columna «Moneda» miente.
      if (!PAISES.length) {
        try { PAISES = (await api('/operador/paises')).paises || []; } catch (e) { /* se ve igual */ }
      }
      llenarSelectorPaisPrecio();
      pintarPlanes();
      var sigue = PLAN_SEL && DATOS.planes.filter(function (p) { return p.id === PLAN_SEL.id; })[0];
      seleccionarPlan(sigue || DATOS.planes[0] || null);
    } catch (e) {
      $('tPlanes').innerHTML = '<tr><td colspan="4" class="vacio">' + esc(e.message) + '</td></tr>';
    }
  }

  function texto(m) {
    if (!m) return '';
    return m.es || m.pt || m.en || Object.values(m)[0] || '';
  }

  // ===========================================================================
  // PAÍSES
  //
  // ⚠ LA REGLA: la moneda de cobro es el DÓLAR salvo que el catálogo diga otra
  // cosa. Un país sin fila cobra en USD y funciona sin configurar nada; la
  // moneda local es la excepción declarada. Al revés —lista blanca de países—
  // cada país nuevo sería una migración, y es lo que había.
  //
  // Esta pantalla NO decide dónde se ofrece el producto: eso lo sigue decidiendo
  // tener precios cargados. Dos mecanismos para la misma pregunta terminan
  // siempre en un país que aparece en un lado y no en el otro.
  // ===========================================================================
  async function cargarPaises() {
    try {
      var j = await api('/operador/paises');
      PAISES = j.paises || [];
      pintarPaises();
      llenarSelectorPaisPrecio();
    } catch (e) {
      $('tPaises').innerHTML = '<tr><td colspan="6" class="vacio">' + esc(e.message) + '</td></tr>';
    }
  }

  function pintarPaises() {
    if (!PAISES.length) {
      $('tPaises').innerHTML =
        '<tr><td colspan="6" class="vacio">Ningún país configurado. Todo se cobra en dólares.</td></tr>';
      return;
    }
    $('tPaises').innerHTML = PAISES.map(function (p) {
      var n = p.nombre_i18n || {};
      // Sin procedencia, el marco legal es una opinión con formato de dato. Se
      // muestra en rojo hasta que un abogado local lo firme.
      var verif = p.verificado_por
        ? '<span class="pill on">' + esc(p.verificado_por) + (p.verificado_en ? ' · ' + esc(p.verificado_en) : '') + '</span>'
        : '<span class="pill des">SIN VERIFICAR</span>';
      return '<tr>' +
        '<td><b>' + (p.bandera ? esc(p.bandera) + ' ' : '') + esc(n.es || n.en || p.codigo) + '</b>' +
        ' <span class="mut">' + esc(p.codigo) + '</span></td>' +
        '<td><b>' + esc(p.moneda) + '</b>' +
        (p.admite_usd ? ' <span class="mut">o USD</span>' : '') +
        (p.tc_fuente ? '<br><span class="mut">TC: ' + esc(p.tc_fuente) + '</span>' : '') + '</td>' +
        '<td>' + esc(p.idioma) + '</td>' +
        '<td>' + esc(p.marco_legal || '—') +
        (p.certificador ? '<br><span class="mut">' + esc(p.certificador) + '</span>' : '') + '</td>' +
        '<td>' + verif + '</td>' +
        '<td style="text-align:right;white-space:nowrap">' +
        '<button class="btn chico" onclick="abrirPais(\'' + esc(p.codigo) + '\')">Editar</button> ' +
        '<button class="btn btn-d chico" onclick="borrarPais(\'' + esc(p.codigo) + '\')">Quitar</button>' +
        '</td></tr>';
    }).join('');
  }

  /** El selector de país de la pantalla de precios sale del catálogo. */
  function llenarSelectorPaisPrecio() {
    var sel = $('paisPrecio');
    if (!sel) return;
    var antes = sel.value;
    sel.innerHTML = PAISES.map(function (p) {
      var n = p.nombre_i18n || {};
      return '<option value="' + esc(p.codigo) + '">' +
             (p.bandera ? esc(p.bandera) + ' ' : '') + esc(n.es || n.en || p.codigo) +
             ' · ' + esc(p.moneda) + '</option>';
    }).join('');
    if (antes && sel.querySelector('option[value="' + antes + '"]')) sel.value = antes;
  }

  function abrirPais(codigo) {
    var p = null;
    for (var i = 0; i < PAISES.length; i++) if (PAISES[i].codigo === codigo) p = PAISES[i];
    var n = (p && p.nombre_i18n) || {};

    abrirModal(
      '<h2>' + (p ? 'Editar ' + esc(p.codigo) : 'Agregar país') + '</h2>' +
      '<p class="sub">La moneda que se escriba acá es en la que se le factura a las cuentas de ' +
      'ese país. Si no se configura ningún país, todo se cobra en dólares.</p>' +
      '<div class="dos">' +
      '<div><label>Código ISO (2 letras)</label>' +
      '<input id="pCod" maxlength="2" value="' + esc(p ? p.codigo : '') + '"' + (p ? ' disabled' : '') + ' /></div>' +
      '<div><label>Bandera</label>' +
      '<input id="pBan" maxlength="8" value="' + esc((p && p.bandera) || '') + '" placeholder="🇨🇱" /></div>' +
      '</div>' +
      '<div class="tres">' +
      '<div><label>Nombre (es)</label><input id="pEs" value="' + esc(n.es || '') + '" /></div>' +
      '<div><label>Nombre (pt)</label><input id="pPt" value="' + esc(n.pt || '') + '" /></div>' +
      '<div><label>Nombre (en)</label><input id="pEn" value="' + esc(n.en || '') + '" /></div>' +
      '</div>' +
      '<div class="tres">' +
      '<div><label>Moneda de cobro</label>' +
      '<input id="pMon" maxlength="3" value="' + esc((p && p.moneda) || 'USD') + '" /></div>' +
      '<div><label>Idioma</label>' +
      '<input id="pIdi" maxlength="5" value="' + esc((p && p.idioma) || 'es') + '" /></div>' +
      '<div><label>Orden</label>' +
      '<input id="pOrd" type="number" value="' + esc(String(p ? p.orden : 100)) + '" /></div>' +
      '</div>' +
      '<label style="display:flex;gap:8px;align-items:flex-start;margin-top:14px;font-size:13.5px">' +
      '<input type="checkbox" id="pUsd" style="width:auto;margin-top:3px"' +
      (p && p.admite_usd ? ' checked' : '') + ' />' +
      '<span>Además se le puede facturar en dólares.<br>' +
      '<span class="mut">Es una pregunta legal, no comercial: en Brasil los pagos domésticos ' +
      'entre residentes están en general restringidos al real. Dejalo sin marcar hasta que el ' +
      'abogado local lo confirme.</span></span></label>' +
      '<div class="dos" style="margin-top:14px">' +
      '<div><label>Marco legal</label>' +
      '<input id="pLey" value="' + esc((p && p.marco_legal) || '') + '" placeholder="Ley 18.600" /></div>' +
      '<div><label>Certificador acreditado</label>' +
      '<input id="pCert" value="' + esc((p && p.certificador) || '') + '" placeholder="tuID (Antel)" /></div>' +
      '</div>' +
      '<div class="dos">' +
      '<div><label>Fuente del tipo de cambio</label>' +
      '<input id="pTc" maxlength="40" value="' + esc((p && p.tc_fuente) || '') + '" placeholder="BCU" /></div>' +
      '<div><label>Verificado por</label>' +
      '<input id="pVer" value="' + esc((p && p.verificado_por) || '') + '" placeholder="Estudio, abogado" /></div>' +
      '</div>' +
      '<div class="dos">' +
      '<div><label>Fecha de verificación</label>' +
      '<input id="pVerEn" type="date" value="' + esc((p && p.verificado_en) || '') + '" /></div>' +
      '<div><label>Fuente del dato legal</label>' +
      '<input id="pFuente" value="' + esc((p && p.fuente) || 'SIN VERIFICAR') + '" /></div>' +
      '</div>' +
      '<div id="msgPais"></div>' +
      '<div class="acc">' +
      '<button class="btn" onclick="cerrarModal()">Cancelar</button>' +
      '<button class="btn btn-p" id="pOk">Guardar</button></div>'
    );

    $('pOk').addEventListener('click', async function () {
      var cod = (p ? p.codigo : $('pCod').value).trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(cod)) return msg('msgPais', 'El código va en dos letras: UY, PY, BR, CL…', 'err');
      var nom = {};
      if ($('pEs').value.trim()) nom.es = $('pEs').value.trim();
      if ($('pPt').value.trim()) nom.pt = $('pPt').value.trim();
      if ($('pEn').value.trim()) nom.en = $('pEn').value.trim();
      $('pOk').disabled = true;
      try {
        await api('/operador/paises', 'PUT', {
          codigo: cod,
          nombre_i18n: nom,
          bandera: $('pBan').value.trim() || null,
          idioma: $('pIdi').value.trim() || 'es',
          orden: Number($('pOrd').value || 100),
          moneda: ($('pMon').value.trim() || 'USD').toUpperCase(),
          admite_usd: $('pUsd').checked,
          tc_fuente: $('pTc').value.trim() || null,
          marco_legal: $('pLey').value.trim() || null,
          certificador: $('pCert').value.trim() || null,
          fuente: $('pFuente').value.trim() || 'SIN VERIFICAR',
          verificado_por: $('pVer').value.trim() || null,
          verificado_en: $('pVerEn').value || null,
        });
        cerrarModal();
        cargarPaises();
      } catch (e) {
        $('pOk').disabled = false;
        msg('msgPais', e.message, 'err');
      }
    });
  }

  async function borrarPais(codigo) {
    try {
      await api('/operador/paises/' + codigo, 'DELETE');
      cargarPaises();
    } catch (e) {
      msg('msgPaises', e.message, 'err');
    }
  }



  function pintarPlanes() {
    if (!DATOS.planes.length) {
      $('tPlanes').innerHTML =
        '<tr><td colspan="4" class="vacio">Todavía no hay ningún plan. Sin planes, la página comercial no muestra precios.</td></tr>';
      return;
    }
    $('tPlanes').innerHTML = DATOS.planes
      .map(function (p) {
        var paises = {};
        p.precios.forEach(function (x) { paises[x.pais] = true; });
        var lista = Object.keys(paises);
        return (
          '<tr data-plan="' + esc(p.id) + '" style="cursor:pointer">' +
          '<td><b>' + esc(texto(p.nombre_i18n) || p.codigo) + '</b>' +
          '<br><span style="font-size:12.5px;color:var(--mut)">' + esc(p.codigo) + '</span></td>' +
          '<td>' + (p.activo ? '' : '<span class="pill off">Inactivo</span>') +
          (p.publico ? '<span class="pill on">En la web</span>' : '<span class="pill off">No se anuncia</span>') +
          (p.destacado ? '<span class="pill des">Destacado</span>' : '') + '</td>' +
          '<td>' + (lista.length
            ? lista.map(function (x) { return '<span class="pill on">' + esc(x) + '</span>'; }).join('')
            : '<span class="pill off">Ningún país</span>') + '</td>' +
          '<td><div class="acc" style="justify-content:flex-end">' +
          '<button class="btn btn-s chico" data-edit="' + esc(p.id) + '">Editar</button>' +
          '<button class="btn btn-d chico" data-del="' + esc(p.id) + '">Borrar</button>' +
          '</div></td></tr>'
        );
      })
      .join('');

    var porId = {};
    DATOS.planes.forEach(function (p) { porId[p.id] = p; });
    var t = $('tPlanes');
    t.querySelectorAll('[data-plan]').forEach(function (tr) {
      tr.addEventListener('click', function (e) {
        if (e.target.closest('button')) return;
        seleccionarPlan(porId[tr.dataset.plan]);
      });
    });
    t.querySelectorAll('[data-edit]').forEach(function (b) {
      b.addEventListener('click', function () { abrirPlan(porId[b.dataset.edit]); });
    });
    t.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function () { borrarPlan(porId[b.dataset.del]); });
    });
  }

  function seleccionarPlan(p) {
    PLAN_SEL = p;
    document.querySelectorAll('#tPlanes tr').forEach(function (tr) {
      tr.style.background = p && tr.dataset.plan === p.id ? 'var(--soft)' : '';
    });
    pintarPrecios();
  }

  function pintarPrecios() {
    msg('msgPrecios', '', '');
    if (!PLAN_SEL) {
      $('nomPrecios').textContent = 'Elegí un plan';
      $('subPrecios').textContent = '';
      $('tPrecios').innerHTML = '';
      return;
    }
    var pais = $('paisPrecio').value;
    var moneda = monedaDe(pais);
    $('nomPrecios').textContent = 'Precios de ' + (texto(PLAN_SEL.nombre_i18n) || PLAN_SEL.codigo);
    $('subPrecios').textContent = 'Lo que no tenga precio, no se cobra ni se ofrece.';

    // Una fila por combinación posible. Las métricas de firma se abren en los
    // dos niveles porque una firma avanzada cuesta certificado y la simple no.
    var filas = [];
    DATOS.metricas.forEach(function (m) {
      if (DATOS.admite_nivel[m]) {
        DATOS.niveles.forEach(function (n) { filas.push({ metrica: m, nivel: n }); });
      } else {
        filas.push({ metrica: m, nivel: null });
      }
    });

    var vigentes = {};
    PLAN_SEL.precios.forEach(function (x) {
      if (x.pais === pais) vigentes[x.metrica + '|' + (x.nivel_firma || '')] = x;
    });

    $('tPrecios').innerHTML = filas
      .map(function (f) {
        var k = f.metrica + '|' + (f.nivel || '');
        var v = vigentes[k];
        return (
          '<tr><td><b>' + esc(ETIQUETA_METRICA[f.metrica] || f.metrica) + '</b>' +
          '<br><span style="font-size:12.5px;color:var(--mut)">' + esc(AYUDA_METRICA[f.metrica] || '') + '</span></td>' +
          '<td>' + (f.nivel ? esc(ETIQUETA_NIVEL[f.nivel]) : '—') + '</td>' +
          '<td>' + esc(v ? v.moneda : moneda) + '</td>' +
          '<td><input data-k="' + esc(k) + '" inputmode="decimal" style="max-width:130px" value="' +
          esc(v ? v.precio : '') + '" placeholder="—" /></td>' +
          '<td><div class="acc" style="justify-content:flex-end">' +
          '<button class="btn btn-s chico" data-guardar="' + esc(k) + '">Guardar</button>' +
          (v ? '<button class="btn btn-d chico" data-baja="' + esc(v.id) + '">Quitar</button>' : '') +
          '</div></td></tr>'
        );
      })
      .join('');

    var t = $('tPrecios');
    t.querySelectorAll('[data-guardar]').forEach(function (b) {
      b.addEventListener('click', function () { guardarPrecio(b.dataset.guardar, pais, moneda); });
    });
    t.querySelectorAll('[data-baja]').forEach(function (b) {
      b.addEventListener('click', function () { quitarPrecio(b.dataset.baja); });
    });
    t.querySelectorAll('input[data-k]').forEach(function (i) {
      i.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') guardarPrecio(i.dataset.k, pais, moneda);
      });
    });
  }

  async function guardarPrecio(k, pais, moneda) {
    var partes = k.split('|');
    var input = $('tPrecios').querySelector('input[data-k="' + k + '"]');
    var valor = (input.value || '').trim().replace(',', '.');
    if (valor === '') return msg('msgPrecios', 'Escribí un precio, o usá «Quitar» para darlo de baja.', 'err');
    try {
      await api('/operador/precios', 'PUT', {
        plan_id: PLAN_SEL.id,
        pais: pais,
        moneda: moneda,
        metrica: partes[0],
        nivel_firma: partes[1] || null,
        precio: Number(valor),
      });
      ok('msgPrecios', 'Guardado.');
      await cargarPlanes();
    } catch (e) { msg('msgPrecios', e.message, 'err'); }
  }

  async function quitarPrecio(id) {
    try {
      await api('/operador/precios/' + id, 'DELETE');
      ok('msgPrecios', 'Dado de baja. La fila queda en el histórico para poder costear facturas viejas.');
      await cargarPlanes();
    } catch (e) { msg('msgPrecios', e.message, 'err'); }
  }

  // ---- Alta y edición del plan ----
  var IDIOMAS = ['es', 'pt', 'en'];
  var NOMBRE_IDIOMA = { es: 'Español', pt: 'Português', en: 'English' };

  function abrirPlan(plan) {
    var nuevo = !plan;
    var datos = {
      nombre: Object.assign({}, plan ? plan.nombre_i18n : {}),
      descripcion: Object.assign({}, plan ? plan.descripcion_i18n : {}),
      incluye: Object.assign({}, plan ? plan.incluye_i18n : {}),
    };
    var lang = 'es';

    abrirModal(
      '<h2>' + (nuevo ? 'Nuevo plan' : 'Editar plan') + '</h2>' +
      '<p class="sub">Los textos son por idioma: el visitante ve el suyo, y si falta, el castellano.</p>' +
      (nuevo
        ? '<label for="mCodigo">Código</label><input id="mCodigo" maxlength="40" placeholder="profesional" />' +
          '<p class="pista">Interno y para siempre: es con lo que se referencia el plan en las facturas.</p>'
        : '<p class="pista" style="margin:0 0 8px">Código: <b>' + esc(plan.codigo) + '</b></p>') +
      '<div style="display:flex;justify-content:flex-end;margin:14px 0 0"><div class="idiomas" id="mIdiomas">' +
      IDIOMAS.map(function (l) {
        return '<button type="button" data-l="' + l + '" aria-pressed="' + (l === 'es') + '">' +
          l.toUpperCase() + '</button>';
      }).join('') + '</div></div>' +
      '<label for="mNombre">Nombre <span id="mLangLbl" style="font-weight:400;color:var(--mut)">(Español)</span></label>' +
      '<input id="mNombre" maxlength="80" />' +
      '<label for="mDesc">Una línea que lo explique</label>' +
      '<input id="mDesc" maxlength="160" placeholder="Para equipos que firman todos los días" />' +
      '<label for="mIncluye">Qué incluye</label>' +
      '<textarea id="mIncluye" placeholder="Una viñeta por línea"></textarea>' +
      '<div class="tres" style="margin-top:16px">' +
      '<div><label class="check"><input type="checkbox" id="mPublico" ' +
        (plan && plan.publico ? 'checked' : '') + ' /> Mostrarlo en la web</label></div>' +
      '<div><label class="check"><input type="checkbox" id="mDestacado" ' +
        (plan && plan.destacado ? 'checked' : '') + ' /> Destacado</label></div>' +
      '<div><label class="check"><input type="checkbox" id="mActivo" ' +
        (!plan || plan.activo ? 'checked' : '') + ' /> Activo</label></div>' +
      '</div>' +
      '<label for="mOrden">Orden</label>' +
      '<input id="mOrden" inputmode="numeric" style="max-width:120px" value="' +
        esc(plan ? plan.orden : 100) + '" />' +
      '<p class="pista">De menor a mayor, de izquierda a derecha en la página.</p>' +
      '<div id="msgModal"></div>' +
      '<div class="acc"><button class="btn btn-s" id="mCancel">Cancelar</button>' +
      '<button class="btn btn-p" id="mOk">Guardar</button></div>'
    );

    function volcar() {
      $('mNombre').value = datos.nombre[lang] || '';
      $('mDesc').value = datos.descripcion[lang] || '';
      $('mIncluye').value = (datos.incluye[lang] || []).join('\n');
      $('mLangLbl').textContent = '(' + NOMBRE_IDIOMA[lang] + ')';
    }
    function recoger() {
      var n = $('mNombre').value.trim();
      var d = $('mDesc').value.trim();
      var i = $('mIncluye').value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
      // Un idioma vacío se BORRA en vez de guardarse como cadena vacía: así la
      // web cae al castellano de respaldo en vez de mostrar un hueco.
      if (n) datos.nombre[lang] = n; else delete datos.nombre[lang];
      if (d) datos.descripcion[lang] = d; else delete datos.descripcion[lang];
      if (i.length) datos.incluye[lang] = i; else delete datos.incluye[lang];
    }

    volcar();
    $('mIdiomas').querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        recoger();
        lang = b.dataset.l;
        $('mIdiomas').querySelectorAll('button').forEach(function (x) {
          x.setAttribute('aria-pressed', String(x.dataset.l === lang));
        });
        volcar();
      });
    });

    $('mCancel').addEventListener('click', cerrarModal);
    $('mOk').addEventListener('click', async function () {
      recoger();
      if (!Object.keys(datos.nombre).length) {
        return msg('msgModal', 'Poné al menos el nombre en un idioma.', 'err');
      }
      var cuerpo = {
        nombre_i18n: datos.nombre,
        descripcion_i18n: datos.descripcion,
        incluye_i18n: datos.incluye,
        publico: $('mPublico').checked,
        destacado: $('mDestacado').checked,
        activo: $('mActivo').checked,
        orden: Number($('mOrden').value || 100),
      };
      $('mOk').disabled = true;
      try {
        if (nuevo) {
          var codigo = $('mCodigo').value.trim();
          if (!codigo) { $('mOk').disabled = false; return msg('msgModal', 'Falta el código.', 'err'); }
          cuerpo.codigo = codigo;
          await api('/operador/planes', 'POST', cuerpo);
        } else {
          await api('/operador/planes/' + plan.id, 'PUT', cuerpo);
        }
        cerrarModal();
        cargarPlanes();
      } catch (e) { msg('msgModal', e.message, 'err'); $('mOk').disabled = false; }
    });
  }

  function borrarPlan(plan) {
    abrirModal(
      '<h2>Borrar «' + esc(texto(plan.nombre_i18n) || plan.codigo) + '»</h2>' +
      '<p class="sub">Se lleva sus precios. Si hay cuentas en este plan no se puede: en ese caso ' +
      'desactivalo, que es lo que en realidad querés — dejar de ofrecerlo sin romper a los que ya lo tienen.</p>' +
      '<div id="msgModal"></div>' +
      '<div class="acc"><button class="btn btn-s" id="mCancel">Cancelar</button>' +
      '<button class="btn btn-d" id="mOk">Borrar</button></div>'
    );
    $('mCancel').addEventListener('click', cerrarModal);
    $('mOk').addEventListener('click', async function () {
      $('mOk').disabled = true;
      try {
        await api('/operador/planes/' + plan.id, 'DELETE');
        cerrarModal();
        PLAN_SEL = null;
        cargarPlanes();
      } catch (e) { msg('msgModal', e.message, 'err'); $('mOk').disabled = false; }
    });
  }

  // ===========================================================================
  // BITÁCORA
  //
  // El operador ve la actividad administrativa de TODAS las cuentas. Es una
  // decisión tomada, no un descuido: sirve para dar soporte —"¿salieron los
  // correos de este cliente?"— y tiene que estar dicho en el contrato.
  //
  // Lo que NO ve es el contenido: ni documentos, ni expedientes. Esa frontera la
  // sostiene la ausencia de GRANT sobre esas tablas, no una política que se
  // pueda pasar por alto, y la verifica el test C4.
  // ===========================================================================
  var ACCION_TEXTO = {
    'correo.enviado': 'Salió un correo',
    'correo.fallido': 'Un correo NO se pudo enviar',
    'cuenta.creada': 'Se creó una cuenta',
    'acceso.dado': 'Se dio un acceso',
    'acceso.quitado': 'Se quitó un acceso',
    'rol.creado': 'Se creó un rol',
    'carpeta.creada': 'Se creó una carpeta',
    'carpeta.permisos': 'Se cambiaron permisos de una carpeta',
  };

  async function cargarBitacora() {
    var f = $('bFiltro').value;
    $('tBitacora').innerHTML = '<tr><td colspan="4" class="vacio">Un momento…</td></tr>';
    try {
      var url = '/operador/bitacora?limit=300' + (f ? '&accion=' + encodeURIComponent(f) : '');
      var j = await api(url);
      var ev = j.eventos || j || [];
      if (!Array.isArray(ev)) ev = [];
      if (!ev.length) {
        $('tBitacora').innerHTML = '<tr><td colspan="4" class="vacio">No hay actividad registrada.</td></tr>';
        return;
      }
      $('tBitacora').innerHTML = ev.map(function (e) {
        var cuando = '';
        try { cuando = new Date(e.ocurrido_en).toLocaleString('es'); } catch (x) {}
        var d = e.despues || e.antes || {};
        var fallo = e.accion === 'correo.fallido';
        var det = fallo
          ? esc(d.destino || '') + ' — ' + esc(d.error || '')
          : esc(d.destino || d.nombre || d.codigo || d.email || '');
        return '<tr' + (fallo ? ' style="background:#fef3f2"' : '') + '>' +
          '<td style="white-space:nowrap;font-size:13px;color:var(--mut)">' + esc(cuando) + '</td>' +
          '<td>' + esc(e.cuenta_nombre || '—') + '</td>' +
          '<td><b>' + esc(ACCION_TEXTO[e.accion] || e.accion) + '</b></td>' +
          '<td style="font-size:13px;color:var(--mut)">' + det + '</td></tr>';
      }).join('');
      msg('msgBitacora', '', '');
    } catch (e) {
      $('tBitacora').innerHTML = '<tr><td colspan="4" class="vacio">' + esc(e.message) + '</td></tr>';
    }
  }

  // ===========================================================================
  // Modal
  // ===========================================================================
  function abrirModal(html) {
    $('modal').innerHTML = '<div class="fondo" id="fondo"><div class="modal">' + html + '</div></div>';
    $('fondo').addEventListener('mousedown', function (e) { if (e.target.id === 'fondo') cerrarModal(); });
    var primero = $('modal').querySelector('input,select,textarea');
    if (primero) setTimeout(function () { primero.focus(); }, 50);
  }
  function cerrarModal() { $('modal').innerHTML = ''; }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') cerrarModal(); });

  // ===========================================================================
  // Arranque
  // ===========================================================================
  async function arrancar() {
    try {
      YO = await api('/operador/yo');
      mostrarConsola();
      window.addEventListener('hashchange', function () {
        if (YO) ir((location.hash || '').slice(1));
      });
    } catch (e) {
      mostrarLogin();
      setTimeout(function () { $('lUsuario').focus(); }, 50);
    }
  }


  // ===========================================================================
  // PROVEEDORES DE FIRMA E IDENTIDAD
  //
  // ⚠ Esta pantalla NO muestra el secreto enmascarado, a diferencia de correo y
  // Twilio. No es una omisión: la migración 067 no le da permiso de lectura
  // sobre `credenciales_cif` a nadie, ni al operador. El servidor no puede
  // mandarlo aunque quisiera. Lo que se muestra es CUÁNDO y QUIÉN lo cargó, que
  // es la única información honesta que existe.
  // ===========================================================================

  var PROVEEDORES = [];
  var ACUERDOS = [];
  var CLAVE_EN_USO = '';

  async function cargarProveedores() {
    try {
      var j = await api('/operador/proveedores');
      PROVEEDORES = j.proveedores || [];
      CLAVE_EN_USO = j.clave_en_uso || '';
      var a = await api('/operador/exclusividad');
      ACUERDOS = a.acuerdos || [];
      pintarProveedores();
      pintarAcuerdos();
    } catch (e) {
      msg('msgProveedores', e.message, 'err');
    }
  }

  function pintarProveedores() {
    var t = $('tProveedores');
    if (!PROVEEDORES.length) {
      t.innerHTML = '<tr><td colspan="7" class="mut">Todavía no hay ningún proveedor configurado.</td></tr>';
    } else {
      t.innerHTML = PROVEEDORES.map(function (p) {
        var caps = (p.paises || []).map(function (x) {
          return esc(x.pais) + ': ' + (x.capacidades || []).join(', ') + (x.activo ? '' : ' (apagado)');
        }).join('<br>') || '<span class="mut">sin países</span>';

        // El ambiente activo sin URLs es el error más probable de toda la cadena
        // y no da síntoma hasta que un firmante lo usa. Se avisa acá.
        var ambienteOk = (p.ambientes_cargados || []).indexOf(p.entorno) >= 0;
        var amb = esc(p.entorno) + (ambienteOk ? '' :
          ' <span class="msg err" style="display:inline-block;padding:1px 6px">sin URLs</span>');

        var cred = p.tiene_credencial
          ? '<span class="mut">cargada ' + esc(String(p.credencial_puesta_en || '').slice(0, 10)) +
            '<br>' + esc(p.credencial_puesta_por || '') + '</span>'
          : '<span class="msg err" style="display:inline-block;padding:1px 6px">falta</span>';

        var salud = p.salud && p.salud !== 'operativo'
          ? ' <span class="mut">(' + esc(p.salud) + ')</span>' : '';

        return '<tr>' +
          '<td><b>' + esc(p.nombre_mostrado) + '</b><br><span class="mut">' + esc(p.codigo) + '</span></td>' +
          '<td>' + amb + '</td>' +
          '<td>' + cred + '</td>' +
          '<td>' + caps + '</td>' +
          '<td>' + (p.activo_global ? 'Encendido' : '<span class="mut">Apagado</span>') + salud + '</td>' +
          '<td><button class="btn chico" onclick="abrirProveedor(\'' + esc(p.codigo) + '\')">Editar</button></td>' +
          '<td><button class="btn chico" onclick="togglearProveedor(\'' + esc(p.codigo) + '\',' +
            (p.activo_global ? 'false' : 'true') + ')">' +
            (p.activo_global ? 'Apagar' : 'Encender') + '</button></td>' +
          '</tr>';
      }).join('');
    }
    $('claveEnUso').textContent = CLAVE_EN_USO ? 'Clave de cifrado en uso: ' + CLAVE_EN_USO : '';
  }

  function provPorCodigo(c) {
    for (var i = 0; i < PROVEEDORES.length; i++) if (PROVEEDORES[i].codigo === c) return PROVEEDORES[i];
    return null;
  }

  function abrirProveedor(codigo) {
    var p = codigo ? provPorCodigo(codigo) : null;
    var caps = (p && p.capacidades) || {};
    var params = (p && p.parametros) || {};

    function chk(id, campo, etiqueta, ayuda) {
      return '<label style="display:flex;gap:8px;align-items:flex-start;margin-top:8px;font-size:13.5px">' +
        '<input type="checkbox" id="' + id + '" style="width:auto;margin-top:3px"' +
        (caps[campo] ? ' checked' : '') + ' /><span>' + etiqueta +
        (ayuda ? '<br><span class="mut">' + ayuda + '</span>' : '') + '</span></label>';
    }

    abrirModal(
      '<h2>' + (p ? esc(p.nombre_mostrado) : 'Agregar proveedor') + '</h2>' +
      '<p class="sub">Las URLs y el ambiente se administran acá, sin tocar código. Lo que es código ' +
      'es el protocolo: cómo se le habla a cada proveedor.</p>' +

      '<div class="dos">' +
      '<div><label>Código</label><input id="pvCod" maxlength="40" value="' + esc(p ? p.codigo : '') + '"' +
        (p ? ' disabled' : '') + ' placeholder="tuid" /></div>' +
      '<div><label>Nombre</label><input id="pvNom" value="' + esc(p ? p.nombre_mostrado : '') + '" /></div>' +
      '</div>' +

      '<div class="dos">' +
      '<div><label>Ambiente activo</label><input id="pvEnt" value="' +
        esc(p ? p.entorno : 'integracion') + '" placeholder="preproduccion" /></div>' +
      '<div><label>Orden</label><input id="pvOrd" type="number" value="' +
        esc(String(p ? p.orden_preferencia : 100)) + '" /></div>' +
      '</div>' +

      '<label style="margin-top:12px">URLs por ambiente</label>' +
      '<textarea id="pvEnd" rows="8" style="font-family:monospace;font-size:12.5px">' +
        esc(JSON.stringify((p && p.endpoints) || {}, null, 2)) + '</textarea>' +
      '<span class="mut">El ambiente activo tiene que estar en esta lista y tener al menos una URL. ' +
      'Sólo https. Si falta, el firmante recibe un error de red que no explica nada.</span>' +

      '<div style="margin-top:14px"><label>Client ID</label>' +
      '<input id="pvCli" value="' + esc(params.client_id || '') + '" /></div>' +

      '<div style="margin-top:14px"><label>Credencial (client secret)</label>' +
      (p && p.tiene_credencial
        ? '<div class="mut" style="margin-bottom:6px">Cargada el ' +
          esc(String(p.credencial_puesta_en || '').slice(0, 10)) + ' por ' +
          esc(p.credencial_puesta_por || '') + '. ' +
          '<b>No se puede mostrar:</b> la base no le da permiso de lectura a nadie.</div>'
        : '') +
      '<input id="pvCred" type="password" autocomplete="new-password" placeholder="' +
        (p && p.tiene_credencial ? 'Dejar vacío para no cambiarla' : 'Pegá el secreto') + '" />' +
      '<span class="mut">Se guarda cifrada. Un campo vacío significa «no la cambies», nunca «borrala».</span></div>' +

      '<h3 style="margin-top:18px;font-size:14px">Qué sabe hacer</h3>' +
      '<span class="mut">Lo declara quien escribió el adaptador. El motor lo consulta antes de ' +
      'despachar un circuito, no cuando la firma falla.</span>' +
      chk('pvCapHash', 'firma_hash', 'Firma por hash',
          'Si no, pide el documento entero: el contenido de los clientes saldría del sistema.') +
      chk('pvCapIdent', 'identifica_titular', 'Sirve como proveedor de identidad') +
      chk('pvCapDoc', 'devuelve_documento_id', 'Devuelve el documento del titular (cédula, CPF)') +
      chk('pvCapTsa', 'sellado_tiempo', 'Hace sellado de tiempo') +
      chk('pvCapAlc', 'alcance_por_firma', 'Token de un solo uso por firma') +
      chk('pvCapLote', 'soporta_lote', 'Soporta lote',
          'Mirar esto ANTES de vender un envío masivo con firma avanzada.') +

      '<div id="msgModalProv" style="margin-top:10px"></div>' +
      '<div class="acciones">' +
      '<button class="btn btn-s" onclick="cerrarModal()">Cancelar</button>' +
      '<button class="btn btn-p" onclick="guardarProveedorForm(' + (p ? "'" + esc(p.codigo) + "'" : 'null') + ')">Guardar</button>' +
      '</div>',
    );
  }

  async function guardarProveedorForm(codigo) {
    var endpoints;
    try {
      endpoints = JSON.parse($('pvEnd').value || '{}');
    } catch (e) {
      msg('msgModalProv', 'Las URLs no son un JSON válido.', 'err');
      return;
    }
    var cred = $('pvCred').value;
    try {
      var r = await api('/operador/proveedores', 'POST', {
        codigo: codigo || $('pvCod').value.trim(),
        nombre_mostrado: $('pvNom').value.trim(),
        entorno: $('pvEnt').value.trim(),
        endpoints: endpoints,
        parametros: { client_id: $('pvCli').value.trim() },
        orden_preferencia: Number($('pvOrd').value || 100),
        credencial: cred ? cred : undefined,
      });
      if (r.id) {
        await api('/operador/proveedores/' + r.id + '/capacidades', 'PUT', {
          firma_hash: $('pvCapHash').checked,
          identifica_titular: $('pvCapIdent').checked,
          devuelve_documento_id: $('pvCapDoc').checked,
          sellado_tiempo: $('pvCapTsa').checked,
          alcance_por_firma: $('pvCapAlc').checked,
          soporta_lote: $('pvCapLote').checked,
        });
      }
      cerrarModal();
      cargarProveedores();
      ok('msgProveedores', 'Proveedor guardado.');
    } catch (e) {
      msg('msgModalProv', e.message, 'err');
    }
  }

  async function togglearProveedor(codigo, activo) {
    try {
      await api('/operador/proveedores/' + encodeURIComponent(codigo) + '/activo', 'PATCH', { activo: activo });
      cargarProveedores();
    } catch (e) {
      // El servidor se niega a encender sin credencial o sin URLs. El mensaje ya
      // explica cuál falta; no hay que traducirlo.
      msg('msgProveedores', e.message, 'err');
    }
  }

  // ---------------------------------------------------------------------------
  // Exclusividad por país
  // ---------------------------------------------------------------------------

  function pintarAcuerdos() {
    var t = $('tAcuerdos');
    if (!ACUERDOS.length) {
      t.innerHTML = '<tr><td colspan="6" class="mut">Sin acuerdos de exclusividad.</td></tr>';
      return;
    }
    t.innerHTML = ACUERDOS.map(function (a) {
      var marca = a.autorizacion_marca
        ? 'sí'
        : '<span class="mut">sin autorización — no se muestra ningún logo</span>';
      return '<tr>' +
        '<td><b>' + esc(a.pais) + '</b></td>' +
        '<td>' + esc(a.socio_nombre) + '<br><span class="mut">' + esc(a.proveedor_nombre) + '</span></td>' +
        '<td>' + esc(String(a.vigente_desde).slice(0, 10)) + ' → ' +
          (a.vigente_hasta ? esc(String(a.vigente_hasta).slice(0, 10)) : '<span class="mut">sin fin</span>') + '</td>' +
        '<td>' + esc((a.capacidades || []).join(', ')) + '</td>' +
        '<td>' + (a.vigente_hoy ? '<b>vigente</b>' : '<span class="mut">no vigente</span>') +
          '<br><span class="mut">marca: ' + marca + '</span></td>' +
        '<td>' + (a.vigente_hoy
          ? '<button class="btn chico" onclick="cerrarAcuerdoForm(\'' + esc(a.id) + '\')">Cerrar</button>'
          : '') + '</td>' +
        '</tr>';
    }).join('');
  }

  function abrirAcuerdo() {
    var opciones = PROVEEDORES.map(function (p) {
      return '<option value="' + esc(p.id) + '">' + esc(p.nombre_mostrado) + '</option>';
    }).join('');

    abrirModal(
      '<h2>Acuerdo de exclusividad</h2>' +
      '<p class="sub">Mientras esté vigente, en ese país sólo se ofrece este proveedor para las ' +
      'capacidades del acuerdo. Al vencer se apaga solo: nadie tiene que acordarse de sacar el logo.</p>' +

      '<div class="dos">' +
      '<div><label>País (2 letras)</label><input id="acPais" maxlength="2" /></div>' +
      '<div><label>Proveedor</label><select id="acProv">' + opciones + '</select></div>' +
      '</div>' +
      '<div><label>Empresa socia</label><input id="acSocio" /></div>' +
      '<div class="dos">' +
      '<div><label>Vigente desde</label><input id="acDesde" type="date" /></div>' +
      '<div><label>Vigente hasta</label><input id="acHasta" type="date" />' +
      '<span class="mut">Vacío = sin fecha de fin.</span></div>' +
      '</div>' +

      '<div class="dos" style="margin-top:12px">' +
      '<div><label>Logo del producto (URL)</label><input id="acLogoP" placeholder="https://…" /></div>' +
      '<div><label>Logo del socio (URL)</label><input id="acLogoS" placeholder="https://…" /></div>' +
      '</div>' +
      '<span class="mut">Tienen que ser https y públicas: los clientes de correo las cargan desde afuera.</span>' +

      '<label style="display:flex;gap:8px;align-items:flex-start;margin-top:14px;font-size:13.5px">' +
      '<input type="checkbox" id="acMarca" style="width:auto;margin-top:3px" />' +
      '<span>Tengo la autorización de uso de marca por escrito.<br>' +
      '<span class="mut">Sin esto no se muestra ningún logo, aunque estén cargados. Usar la marca ' +
      'del socio requiere su permiso, y eso es cláusula del acuerdo comercial.</span></span></label>' +

      '<div style="margin-top:12px"><label>Nota</label><input id="acNota" /></div>' +
      '<div id="msgModalAc" style="margin-top:10px"></div>' +
      '<div class="acciones">' +
      '<button class="btn btn-s" onclick="cerrarModal()">Cancelar</button>' +
      '<button class="btn btn-p" onclick="guardarAcuerdoForm()">Crear</button>' +
      '</div>',
    );
  }

  async function guardarAcuerdoForm() {
    try {
      await api('/operador/exclusividad', 'POST', {
        pais: $('acPais').value.trim().toUpperCase(),
        proveedor_id: $('acProv').value,
        socio_nombre: $('acSocio').value.trim(),
        vigente_desde: $('acDesde').value,
        vigente_hasta: $('acHasta').value || null,
        logo_producto_url: $('acLogoP').value.trim() || null,
        logo_socio_url: $('acLogoS').value.trim() || null,
        autorizacion_marca: $('acMarca').checked,
        nota: $('acNota').value.trim() || null,
      });
      cerrarModal();
      cargarProveedores();
      ok('msgProveedores', 'Acuerdo creado.');
    } catch (e) {
      msg('msgModalAc', e.message, 'err');
    }
  }

  async function cerrarAcuerdoForm(id) {
    var hoy = new Date().toISOString().slice(0, 10);
    // No se borra: se le pone fecha de fin. El acuerdo estuvo vigente y eso es un
    // hecho — hubo documentos firmados bajo él.
    if (!confirm('Se cierra el acuerdo con fecha de hoy (' + hoy + '). No se borra: queda la historia.')) return;
    try {
      await api('/operador/exclusividad/' + encodeURIComponent(id) + '/cerrar', 'PATCH', { vigente_hasta: hoy });
      cargarProveedores();
    } catch (e) {
      msg('msgProveedores', e.message, 'err');
    }
  }


  // ===========================================================================
  // PASARELAS DE PAGO
  //
  // La API existía desde antes y no tenía pantalla: las credenciales de PayPal y
  // compañía se cargaban a mano. Es el mismo problema que proveedores de firma,
  // con una diferencia que sí importa:
  //
  // ⚠ ACÁ EL SECRETO SÍ SE MUESTRA ENMASCARADO. `pasarela_pago` no tiene el grano
  // fino de permisos de la 067: el operador puede leer el cifrado, y el servidor
  // manda `client_secret_mask`. No es mejor ni peor por sí solo — es una decisión
  // distinta, tomada antes. Vale la pena saber que las dos pantallas se ven
  // parecidas y protegen cosas distintas.
  // ===========================================================================

  var PASARELAS = [];

  var CONOCIDAS = {
    paypal: 'PayPal',
    stripe: 'Stripe',
    mercadopago: 'MercadoPago',
    dlocal: 'dLocal',
  };

  async function cargarPasarelas() {
    try {
      var j = await api('/operador/pasarelas');
      PASARELAS = j.pasarelas || [];
      pintarPasarelas();
    } catch (e) {
      msg('msgPasarelas', e.message, 'err');
    }
  }

  function pintarPasarelas() {
    var t = $('tPasarelas');
    if (!PASARELAS.length) {
      t.innerHTML = '<tr><td colspan="6" class="mut">Ninguna pasarela configurada. Sin esto no se puede cobrar.</td></tr>';
      return;
    }
    t.innerHTML = PASARELAS.map(function (p) {
      var cred = p.tiene_secret
        ? '<span class="mut">' + esc(p.client_secret_mask || '••••••••') + '</span>'
        : '<span class="msg err" style="display:inline-block;padding:1px 6px">falta</span>';
      // El modo importa tanto como la credencial: una pasarela en sandbox parece
      // andar y no cobra nada. Se muestra al lado del estado, no escondido.
      var modo = p.modo === 'produccion'
        ? '<b>producción</b>'
        : '<span class="mut">sandbox — no cobra de verdad</span>';
      return '<tr>' +
        '<td><b>' + esc(CONOCIDAS[p.proveedor] || p.nombre) + '</b><br><span class="mut">' + esc(p.proveedor) + '</span></td>' +
        '<td>' + modo + '</td>' +
        '<td>' + esc(p.client_id || '') + '</td>' +
        '<td>' + cred + '</td>' +
        '<td>' + (p.activo ? 'Encendida' : '<span class="mut">Apagada</span>') + '</td>' +
        '<td><button class="btn chico" onclick="abrirPasarela(\'' + esc(p.proveedor) + '\')">Editar</button> ' +
        '<button class="btn chico" onclick="togglearPasarela(\'' + esc(p.proveedor) + '\',' +
          (p.activo ? 'false' : 'true') + ')">' + (p.activo ? 'Apagar' : 'Encender') + '</button> ' +
        (p.proveedor === 'paypal'
          ? '<button class="btn chico" onclick="probarPasarela(\'' + esc(p.proveedor) + '\')">Orden de prueba</button>'
          : '') +
        '</td>' +
        '</tr>';
    }).join('');
  }

  function pasarelaPor(cod) {
    for (var i = 0; i < PASARELAS.length; i++) if (PASARELAS[i].proveedor === cod) return PASARELAS[i];
    return null;
  }

  function abrirPasarela(cod) {
    var p = cod ? pasarelaPor(cod) : null;
    var opciones = Object.keys(CONOCIDAS).map(function (k) {
      return '<option value="' + k + '"' + (p && p.proveedor === k ? ' selected' : '') + '>' + CONOCIDAS[k] + '</option>';
    }).join('');

    abrirModal(
      '<h2>' + (p ? esc(CONOCIDAS[p.proveedor] || p.nombre) : 'Agregar pasarela') + '</h2>' +
      '<p class="sub">Las credenciales se guardan cifradas. Un campo vacío significa «no la cambies», ' +
      'nunca «borrala».</p>' +

      '<div class="dos">' +
      '<div><label>Proveedor</label><select id="paProv"' + (p ? ' disabled' : '') + '>' + opciones + '</select></div>' +
      '<div><label>Nombre</label><input id="paNom" value="' + esc(p ? p.nombre : '') + '" /></div>' +
      '</div>' +

      '<div><label>Modo</label><select id="paModo">' +
      '<option value="sandbox"' + (!p || p.modo !== 'produccion' ? ' selected' : '') + '>Sandbox (pruebas)</option>' +
      '<option value="produccion"' + (p && p.modo === 'produccion' ? ' selected' : '') + '>Producción</option>' +
      '</select>' +
      '<span class="mut">En sandbox el cobro parece funcionar y no entra un peso. Es la confusión ' +
      'más cara de esta pantalla.</span></div>' +

      '<div style="margin-top:14px"><label>Client ID</label>' +
      '<input id="paCli" value="' + esc(p ? p.client_id : '') + '" /></div>' +

      '<div style="margin-top:14px"><label>Client Secret</label>' +
      (p && p.tiene_secret
        ? '<div class="mut" style="margin-bottom:6px">Guardado: ' + esc(p.client_secret_mask || '••••••••') + '</div>'
        : '') +
      '<input id="paSec" type="password" autocomplete="new-password" placeholder="' +
        (p && p.tiene_secret ? 'Dejar vacío para no cambiarlo' : 'Pegá el secreto') + '" /></div>' +

      '<div style="margin-top:14px"><label>Webhook Secret</label>' +
      '<input id="paWeb" type="password" autocomplete="new-password" placeholder="' +
        (p && p.tiene_secret ? 'Dejar vacío para no cambiarlo' : 'Opcional') + '" />' +
      '<span class="mut">Es lo que prueba que un aviso de pago viene de la pasarela y no de ' +
      'cualquiera. Sin esto, un aviso de «pago aprobado» se puede falsificar.</span></div>' +

      '<div id="msgModalPa" style="margin-top:10px"></div>' +
      '<div class="acciones">' +
      '<button class="btn btn-s" onclick="cerrarModal()">Cancelar</button>' +
      '<button class="btn btn-p" onclick="guardarPasarelaForm(' + (p ? "'" + esc(p.proveedor) + "'" : 'null') + ')">Guardar</button>' +
      '</div>',
    );
  }

  async function guardarPasarelaForm(cod) {
    var sec = $('paSec').value;
    var web = $('paWeb').value;
    try {
      await api('/operador/pasarelas', 'POST', {
        proveedor: cod || $('paProv').value,
        nombre: $('paNom').value.trim() || $('paProv').value,
        modo: $('paModo').value,
        client_id: $('paCli').value.trim(),
        client_secret: sec ? sec : undefined,
        webhook_secret: web ? web : undefined,
      });
      cerrarModal();
      cargarPasarelas();
      ok('msgPasarelas', 'Pasarela guardada.');
    } catch (e) {
      msg('msgModalPa', e.message, 'err');
    }
  }

  async function togglearPasarela(cod, activo) {
    // ⚠ Encender una pasarela en modo producción es lo que hace que se le empiece
    // a cobrar a gente de verdad. Se pregunta una vez; apagar no pregunta nada.
    var p = pasarelaPor(cod);
    if (activo && p && p.modo === 'produccion') {
      if (!confirm('Vas a encender ' + (CONOCIDAS[cod] || cod) + ' en modo PRODUCCIÓN. Se van a cobrar pagos reales. ¿Seguir?')) return;
    }
    try {
      await api('/operador/pasarelas/' + encodeURIComponent(cod), 'PATCH', { activo: activo });
      cargarPasarelas();
    } catch (e) {
      msg('msgPasarelas', e.message, 'err');
    }
  }

  async function probarPasarela(cod) {
    msg('msgPasarelas', 'Creando la orden de prueba…', 'ok');
    try {
      var r = await api('/operador/pasarelas/' + encodeURIComponent(cod) + '/orden-prueba', 'POST',
        { monto: '10.00', moneda: 'USD' });
      var el = $('msgPasarelas');
      el.innerHTML = '<div class="msg ok">Orden ' + esc(r.order_id || '') + ' · estado ' + esc(r.estado || '') +
        (r.link_aprobacion
          ? ' · <a href="' + esc(r.link_aprobacion) + '" target="_blank" rel="noopener">abrir el link de aprobación</a>'
          : '') +
        '</div>';
    } catch (e) {
      msg('msgPasarelas', e.message, 'err');
    }
  }


  // ===========================================================================
  // OPERADORES — quién entra a esta consola y con qué privilegios
  //
  // ⚠ Es la pantalla más delicada de la consola, y hasta hoy no existía: se
  // administraba por API. Para un producto en proceso de certificación ISO 27001
  // la gestión de accesos privilegiados es de lo primero que mira un auditor, y
  // «se hace con curl» no es una respuesta.
  //
  // Todo lo que se hace acá queda en la bitácora de plataforma. No es un detalle
  // de implementación: es la razón por la que existe la bitácora.
  // ===========================================================================

  var OPERADORES = [];

  // El texto de cada privilegio. La lista de códigos la manda el servidor con
  // cada operador; acá sólo se traduce y se explica QUÉ PUEDE HACER quien lo
  // tiene — que es lo que hay que entender antes de tildar una casilla.
  var PRIVILEGIOS = {
    gestionar_planes:     ['Planes y precios', 'Cambia lo que se le cobra a todas las cuentas.'],
    gestionar_empresas:   ['Empresas', 'Ve y ajusta las cuentas cliente.'],
    gestionar_operadores: ['Operadores', 'Da de alta a otros operadores. Quien lo tiene puede darse cualquier otro privilegio.'],
    gestionar_pagos:      ['Pagos y proveedores', 'Pasarelas de cobro y proveedores de firma, con sus credenciales.'],
    gestionar_mensajeria: ['Correo y mensajería', 'Las credenciales por las que sale TODO: códigos de acceso, invitaciones, avisos de firma.'],
    gestionar_ofertas:    ['Ofertas', 'Promociones y descuentos.'],
    gestionar_firma:      ['Firma', 'Parámetros del motor de firma.'],
    gestionar_industrias: ['Industrias', 'El catálogo de rubros.'],
    gestionar_creditos:   ['Créditos', 'Ajustes de saldo de las cuentas.'],
    ver_auditoria:        ['Auditoría', 'Lee la bitácora de la plataforma.'],
  };

  // Los que pueden hacer daño de verdad si se los da de más.
  var SENSIBLES = ['gestionar_operadores', 'gestionar_mensajeria', 'gestionar_pagos', 'gestionar_creditos'];

  async function cargarOperadores() {
    try {
      var j = await api('/operador/operadores');
      OPERADORES = j.operadores || [];
      pintarOperadores();
    } catch (e) {
      msg('msgOperadores', e.message, 'err');
    }
  }

  function pintarOperadores() {
    var t = $('tOperadores');
    if (!OPERADORES.length) {
      t.innerHTML = '<tr><td colspan="5" class="mut">Sin operadores.</td></tr>';
      return;
    }
    t.innerHTML = OPERADORES.map(function (o) {
      var caps = o.es_superadmin
        ? '<b>todos</b> <span class="mut">(superadmin)</span>'
        : (o.capacidades || []).length
          ? (o.capacidades || []).map(function (c) {
              var p = PRIVILEGIOS[c];
              var txt = esc(p ? p[0] : c);
              return SENSIBLES.indexOf(c) >= 0 ? '<b>' + txt + '</b>' : txt;
            }).join(', ')
          : '<span class="mut">ninguno</span>';

      var yoMismo = YO && YO.usuario === o.usuario;

      return '<tr>' +
        '<td><b>' + esc(o.usuario) + '</b>' + (yoMismo ? ' <span class="mut">(vos)</span>' : '') +
          '<br><span class="mut">' + esc(o.nombre || '') + '</span></td>' +
        '<td>' + (o.activo ? 'Activo' : '<span class="mut">Inactivo</span>') + '</td>' +
        '<td>' + caps + '</td>' +
        '<td><span class="mut">' + esc(String(o.creado_en || '').slice(0, 10)) + '</span></td>' +
        '<td>' +
          '<button class="btn chico" onclick="abrirOperador(\'' + esc(o.id) + '\')">Privilegios</button> ' +
          // ⚠ No se puede desactivar a sí mismo: es la forma más fácil de quedarse
          // afuera de la consola sin nadie que pueda volver a entrar.
          (yoMismo || o.es_superadmin
            ? ''
            : '<button class="btn chico" onclick="togglearOperador(\'' + esc(o.id) + '\',' +
              (o.activo ? 'false' : 'true') + ')">' + (o.activo ? 'Desactivar' : 'Activar') + '</button> ') +
          '<button class="btn chico" onclick="resetPasswordOperador(\'' + esc(o.id) + '\',\'' + esc(o.usuario) + '\')">Contraseña</button>' +
        '</td>' +
        '</tr>';
    }).join('');
  }

  function opPorId(id) {
    for (var i = 0; i < OPERADORES.length; i++) if (OPERADORES[i].id === id) return OPERADORES[i];
    return null;
  }

  function casillasPrivilegios(marcadas, prefijo) {
    return Object.keys(PRIVILEGIOS).map(function (c) {
      var p = PRIVILEGIOS[c];
      var sens = SENSIBLES.indexOf(c) >= 0;
      return '<label style="display:flex;gap:8px;align-items:flex-start;margin-top:8px;font-size:13.5px">' +
        '<input type="checkbox" id="' + prefijo + c + '" style="width:auto;margin-top:3px"' +
        (marcadas.indexOf(c) >= 0 ? ' checked' : '') + ' />' +
        '<span>' + esc(p[0]) + (sens ? ' <b>·  sensible</b>' : '') +
        '<br><span class="mut">' + esc(p[1]) + '</span></span></label>';
    }).join('');
  }

  function leerPrivilegios(prefijo) {
    var out = [];
    Object.keys(PRIVILEGIOS).forEach(function (c) {
      var el = $(prefijo + c);
      if (el && el.checked) out.push(c);
    });
    return out;
  }

  function abrirOperador(id) {
    var o = opPorId(id);
    if (!o) return;
    if (o.es_superadmin) {
      alert('Es superadmin: tiene todos los privilegios y no se editan de a uno.');
      return;
    }
    abrirModal(
      '<h2>Privilegios de ' + esc(o.usuario) + '</h2>' +
      '<p class="sub">Cada privilegio abre una parte de la consola. Los marcados como ' +
      '<b>sensibles</b> permiten cambiar cosas que afectan a todas las cuentas o a la seguridad ' +
      'de la plataforma.</p>' +
      casillasPrivilegios(o.capacidades || [], 'op_') +
      '<div id="msgModalOp" style="margin-top:10px"></div>' +
      '<div class="acciones">' +
      '<button class="btn btn-s" onclick="cerrarModal()">Cancelar</button>' +
      '<button class="btn btn-p" onclick="guardarPrivilegios(\'' + esc(o.id) + '\')">Guardar</button>' +
      '</div>',
    );
  }

  async function guardarPrivilegios(id) {
    try {
      await api('/operador/operadores/' + encodeURIComponent(id), 'PATCH',
        { capacidades: leerPrivilegios('op_') });
      cerrarModal();
      cargarOperadores();
      ok('msgOperadores', 'Privilegios actualizados.');
    } catch (e) {
      msg('msgModalOp', e.message, 'err');
    }
  }

  function abrirNuevoOperador() {
    abrirModal(
      '<h2>Nuevo operador</h2>' +
      '<p class="sub">Alguien que va a poder entrar a esta consola. Empezá por lo mínimo: ' +
      'agregar un privilegio después es fácil, y darlo de más no se nota hasta que pasa algo.</p>' +
      '<div class="dos">' +
      '<div><label>Usuario</label><input id="noUsr" autocomplete="off" /></div>' +
      '<div><label>Nombre</label><input id="noNom" /></div>' +
      '</div>' +
      '<div><label>Contraseña inicial</label>' +
      '<input id="noPass" type="password" autocomplete="new-password" />' +
      '<span class="mut">Pasásela por un canal aparte, nunca por el mismo correo donde le ' +
      'avisás que tiene acceso.</span></div>' +
      '<h3 style="margin-top:18px;font-size:14px">Privilegios</h3>' +
      casillasPrivilegios([], 'no_') +
      '<div id="msgModalOp" style="margin-top:10px"></div>' +
      '<div class="acciones">' +
      '<button class="btn btn-s" onclick="cerrarModal()">Cancelar</button>' +
      '<button class="btn btn-p" onclick="crearOperadorForm()">Crear</button>' +
      '</div>',
    );
  }

  async function crearOperadorForm() {
    try {
      await api('/operador/operadores', 'POST', {
        usuario: $('noUsr').value.trim(),
        nombre: $('noNom').value.trim(),
        password: $('noPass').value,
        es_superadmin: false,
        capacidades: leerPrivilegios('no_'),
      });
      cerrarModal();
      cargarOperadores();
      ok('msgOperadores', 'Operador creado.');
    } catch (e) {
      msg('msgModalOp', e.message, 'err');
    }
  }

  async function togglearOperador(id, activo) {
    var o = opPorId(id);
    if (!activo && o && !confirm('Desactivar a ' + o.usuario + '. No va a poder entrar más a la consola. ¿Seguir?')) return;
    try {
      await api('/operador/operadores/' + encodeURIComponent(id), 'PATCH', { activo: activo });
      cargarOperadores();
    } catch (e) {
      msg('msgOperadores', e.message, 'err');
    }
  }

  async function resetPasswordOperador(id, usuario) {
    var nueva = prompt('Nueva contraseña para ' + usuario + ':');
    if (!nueva) return;
    try {
      await api('/operador/operadores/' + encodeURIComponent(id) + '/password', 'POST', { nueva: nueva });
      ok('msgOperadores', 'Contraseña cambiada. Pasásela por un canal aparte.');
    } catch (e) {
      msg('msgOperadores', e.message, 'err');
    }
  }


  // ⚠ INDUSTRIAS: la pantalla se sacó el 5/9. Es un catálogo heredado de payroll
  // —allá el rubro decidía convenio y aportes— que en MiFirma no lo mira nadie.
  // La API sigue existiendo y `cuenta.industria_id` sigue teniendo datos, así que
  // no se borró nada: sólo se dejó de ofrecer una pantalla para administrar algo
  // que no se usa.
  //
  // ⚠ PENDIENTE, y es lo que de verdad importa: el formulario de ALTA sigue
  // pidiendo el rubro. Sacar la pantalla y dejar el campo es lo peor de los dos
  // mundos — se le sigue preguntando al que se registra un dato que ya nadie
  // puede administrar. Eso pide su propia pasada, con migración.

  // ===========================================================================
  // PLATA — tres cosas chicas que van juntas porque son del mismo mundo
  //
  // Catálogos bancarios, lo que cuesta la IA, y la conexión con facturación. Cada
  // una sola no justifica un ítem en el menú; las tres desparramadas en la API y
  // sin pantalla, sí justificaban una.
  // ===========================================================================

  var TAB_PLATA = 'catalogos';
  var TABLA_CAT = 'banco';

  function irPlata(tab) {
    TAB_PLATA = tab;
    ['catalogos', 'ia', 'facturacion'].forEach(function (t) {
      var el = $('plata_' + t);
      if (el) el.classList.toggle('hidden', t !== tab);
      var b = $('tabPlata_' + t);
      if (b) b.setAttribute('aria-current', String(t === tab));
    });
    cargarPlata();
  }

  async function cargarPlata() {
    if (TAB_PLATA === 'catalogos') return cargarCatalogos();
    if (TAB_PLATA === 'ia') return cargarTarifasIa();
    if (TAB_PLATA === 'facturacion') return cargarFacturacion();
  }

  // ---- Catálogos bancarios ----
  async function cargarCatalogos() {
    TABLA_CAT = $('catTabla') ? $('catTabla').value : 'banco';
    try {
      var j = await api('/operador/catalogos-pago/' + TABLA_CAT);
      var it = j.items || [];
      $('tCatalogos').innerHTML = !it.length
        ? '<tr><td colspan="4" class="mut">Sin filas.</td></tr>'
        : it.map(function (x) {
            return '<tr><td>' + esc(x.pais) + '</td><td>' + esc(x.nombre) + '</td>' +
              '<td>' + (x.activo ? 'Sí' : '<span class="mut">No</span>') + '</td>' +
              '<td><button class="btn chico" onclick="borrarCatalogo(\'' + esc(x.id) + '\')">Borrar</button></td></tr>';
          }).join('');
    } catch (e) {
      msg('msgPlata', e.message, 'err');
    }
  }

  function agregarCatalogo() {
    var que = TABLA_CAT === 'banco' ? 'banco' : 'tipo de cuenta';
    abrirModal(
      '<h2>Agregar ' + que + '</h2>' +
      '<p class="sub">Es lo que la empresa cliente va a elegir de una lista al cargar un medio de ' +
      'pago. Escribirlo bien una vez evita tener «BROU», «Banco República» y «B.R.O.U.» conviviendo.</p>' +
      '<div class="dos">' +
      '<div><label>País (2 letras)</label><input id="caPais" maxlength="2" /></div>' +
      '<div><label>Orden</label><input id="caOrden" type="number" value="100" /></div>' +
      '</div>' +
      '<div><label>Nombre</label><input id="caNom" /></div>' +
      '<div id="msgModalCa" style="margin-top:10px"></div>' +
      '<div class="acciones">' +
      '<button class="btn btn-s" onclick="cerrarModal()">Cancelar</button>' +
      '<button class="btn btn-p" onclick="guardarCatalogoForm()">Agregar</button>' +
      '</div>',
    );
  }

  async function guardarCatalogoForm() {
    try {
      await api('/operador/catalogos-pago/' + TABLA_CAT, 'POST', {
        pais: $('caPais').value.trim().toUpperCase(),
        nombre: $('caNom').value.trim(),
        orden: Number($('caOrden').value || 100),
      });
      cerrarModal();
      cargarCatalogos();
      ok('msgPlata', 'Agregado.');
    } catch (e) {
      msg('msgModalCa', e.message, 'err');
    }
  }

  async function borrarCatalogo(id) {
    if (!confirm('Borrar esta fila?')) return;
    try {
      await api('/operador/catalogos-pago/' + TABLA_CAT + '/' + encodeURIComponent(id), 'DELETE');
      cargarCatalogos();
    } catch (e) { msg('msgPlata', e.message, 'err'); }
  }

  // ---- Tarifas de IA ----
  async function cargarTarifasIa() {
    try {
      var j = await api('/operador/tarifas-ia');
      var t = j.tarifas || [];
      $('tTarifasIa').innerHTML = !t.length
        ? '<tr><td colspan="5" class="mut">Sin tarifas cargadas. Sin esto el consumo de IA no se puede costear.</td></tr>'
        : t.map(function (x) {
            return '<tr><td><b>' + esc(x.modelo) + '</b></td>' +
              '<td>' + esc(x.moneda) + '</td>' +
              '<td>' + esc(String(x.precio_input_millon)) + '</td>' +
              '<td>' + esc(String(x.precio_output_millon)) + '</td>' +
              '<td>' + esc(String(x.vigente_desde || '').slice(0, 10)) +
              '<button class="btn chico" style="margin-left:8px" onclick="borrarTarifaIa(\'' + esc(x.id) + '\')">Borrar</button></td></tr>';
          }).join('');
    } catch (e) {
      msg('msgPlata', e.message, 'err');
    }
  }

  function abrirTarifaIa() {
    var hoy = new Date().toISOString().slice(0, 10);
    abrirModal(
      '<h2>Nueva tarifa de IA</h2>' +
      '<p class="sub">Lo que <b>cuesta</b> el modelo, no lo que se cobra. El precio de venta va ' +
      'en el plan, como cualquier otra métrica.</p>' +
      '<div><label>Modelo</label><input id="tiMod" placeholder="claude-sonnet-4-6" />' +
      '<span class="mut">Tal cual lo reporta el proveedor: es la llave con la que se casa el ' +
      'consumo registrado. Si no coincide, el consumo queda sin costear y nadie se entera.</span></div>' +
      '<div class="dos" style="margin-top:12px">' +
      '<div><label>Precio de entrada por millón</label><input id="tiIn" type="number" step="0.0001" /></div>' +
      '<div><label>Precio de salida por millón</label><input id="tiOut" type="number" step="0.0001" /></div>' +
      '</div>' +
      '<div style="margin-top:12px"><label>Vigente desde</label>' +
      '<input id="tiDesde" type="date" value="' + hoy + '" />' +
      '<span class="mut">No pisa la tarifa anterior: la sucede. Lo consumido antes de esta fecha ' +
      'se sigue costeando con la que regía entonces.</span></div>' +
      '<div id="msgModalTi" style="margin-top:10px"></div>' +
      '<div class="acciones">' +
      '<button class="btn btn-s" onclick="cerrarModal()">Cancelar</button>' +
      '<button class="btn btn-p" onclick="guardarTarifaIaForm()">Guardar</button>' +
      '</div>',
    );
  }

  async function guardarTarifaIaForm() {
    try {
      await api('/operador/tarifas-ia', 'POST', {
        modelo: $('tiMod').value.trim(),
        precio_input_millon: $('tiIn').value,
        precio_output_millon: $('tiOut').value,
        vigente_desde: $('tiDesde').value || undefined,
      });
      cerrarModal();
      cargarTarifasIa();
      ok('msgPlata', 'Tarifa guardada.');
    } catch (e) {
      msg('msgModalTi', e.message, 'err');
    }
  }

  async function borrarTarifaIa(id) {
    if (!confirm('Borrar esta tarifa?')) return;
    try {
      await api('/operador/tarifas-ia/' + encodeURIComponent(id), 'DELETE');
      cargarTarifasIa();
    } catch (e) { msg('msgPlata', e.message, 'err'); }
  }

  // ---- Integración de facturación ----
  async function cargarFacturacion() {
    var pais = $('facPais') ? $('facPais').value.trim().toUpperCase() : 'UY';
    if (!pais || pais.length !== 2) return;
    try {
      var f = await api('/operador/integracion-facturacion?pais=' + encodeURIComponent(pais));
      $('facModo').value = f.modo || 'archivo';
      $('facUrl').value = f.api_url || '';
      $('facFormato').value = f.archivo_formato || '';
      $('facEstado').innerHTML = (f.activo ? '<b>activa</b>' : '<span class="mut">inactiva</span>') +
        ' · credencial: ' + (f.tiene_credencial ? esc(f.credencial_mask) : '<span class="mut">sin cargar</span>');
      // El botón dice lo que va a hacer, no el estado actual: es la diferencia
      // entre apagar la facturación de un país sin querer y no hacerlo.
      $('facToggle').textContent = f.activo ? 'Desactivar en ' + pais : 'Activar en ' + pais;
      $('facToggle').dataset.activo = f.activo ? '1' : '';
    } catch (e) {
      msg('msgPlata', e.message, 'err');
    }
  }

  async function togglearFacturacion() {
    var pais = $('facPais').value.trim().toUpperCase();
    var activar = !$('facToggle').dataset.activo;
    // ⚠ Apagar la integración de un país significa que las facturas de ese país
    // dejan de emitirse. No es un interruptor de configuración: es dejar de
    // facturar. Se pregunta.
    if (!activar && !confirm('Vas a DESACTIVAR la facturación de ' + pais + '. Las facturas de ese país dejan de emitirse. ¿Seguir?')) return;
    try {
      await api('/operador/integracion-facturacion', 'PATCH', { pais: pais, activo: activar });
      cargarFacturacion();
    } catch (e) {
      msg('msgPlata', e.message, 'err');
    }
  }

  async function guardarFacturacion() {
    var cred = $('facCred').value;
    try {
      await api('/operador/integracion-facturacion', 'POST', {
        pais: $('facPais').value.trim().toUpperCase(),
        modo: $('facModo').value,
        api_url: $('facUrl').value.trim(),
        archivo_formato: $('facFormato').value.trim(),
        api_credencial: cred ? cred : undefined,
      });
      $('facCred').value = '';
      cargarFacturacion();
      ok('msgPlata', 'Guardado.');
    } catch (e) {
      msg('msgPlata', e.message, 'err');
    }
  }

  window.entrar = entrar;
  window.salir = salir;
  window.ir = ir;
  window.aplicarPreset = aplicarPreset;
  window.guardarCorreo = guardarCorreo;
  window.probarCorreo = probarCorreo;
  window.guardarTwilio = guardarTwilio;
  window.probarTwilio = probarTwilio;
  window.abrirPlan = abrirPlan;
  window.pintarPrecios = pintarPrecios;
  window.abrirPais = abrirPais;
  window.borrarPais = borrarPais;
  window.cargarBitacora = cargarBitacora;
  window.cerrarModal = cerrarModal;
  window.abrirProveedor = abrirProveedor;
  window.guardarProveedorForm = guardarProveedorForm;
  window.togglearProveedor = togglearProveedor;
  window.abrirAcuerdo = abrirAcuerdo;
  window.guardarAcuerdoForm = guardarAcuerdoForm;
  window.cerrarAcuerdoForm = cerrarAcuerdoForm;
  window.abrirPasarela = abrirPasarela;
  window.guardarPasarelaForm = guardarPasarelaForm;
  window.togglearPasarela = togglearPasarela;
  window.probarPasarela = probarPasarela;
  window.abrirOperador = abrirOperador;
  window.abrirNuevoOperador = abrirNuevoOperador;
  window.guardarPrivilegios = guardarPrivilegios;
  window.crearOperadorForm = crearOperadorForm;
  window.togglearOperador = togglearOperador;
  window.resetPasswordOperador = resetPasswordOperador;
  window.irPlata = irPlata;
  window.cargarCatalogos = cargarCatalogos;
  window.agregarCatalogo = agregarCatalogo;
  window.borrarCatalogo = borrarCatalogo;
  window.borrarTarifaIa = borrarTarifaIa;
  window.cargarFacturacion = cargarFacturacion;
  window.guardarFacturacion = guardarFacturacion;
  window.togglearFacturacion = togglearFacturacion;
  window.abrirTarifaIa = abrirTarifaIa;
  window.guardarTarifaIaForm = guardarTarifaIaForm;
  window.guardarCatalogoForm = guardarCatalogoForm;

  arrancar();
})();
