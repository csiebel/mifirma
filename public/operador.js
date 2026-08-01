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

  var VISTAS = ['correo', 'twilio', 'planes', 'bitacora'];

  var MONEDA_PAIS = { UY: 'UYU', PY: 'PYG', BR: 'BRL' };

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
    var moneda = MONEDA_PAIS[pais] || 'USD';
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
  window.cargarBitacora = cargarBitacora;
  window.cerrarModal = cerrarModal;

  arrancar();
})();
