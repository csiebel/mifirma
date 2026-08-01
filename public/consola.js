(function () {
  'use strict';

  /* ===========================================================================
     Consola del cliente.

     Reemplaza las 5.620 líneas de la consola de payroll, que hablaba de recibos
     y liquidaciones. Acá hay cuatro cosas y ninguna es el motor de firma
     todavía: carpetas, accesos, roles y datos de la cuenta. Son justamente las
     que hay que dejar armadas ANTES de que existan documentos, porque son las
     que van a decidir quién ve cuáles.

     ═══ ESTE ARCHIVO NO AUTORIZA NADA ═══

     Ocultar un botón no es un permiso: es cortesía. Cada llamada la vuelve a
     decidir la política RLS con el contexto de la sesión, y si la base dice que
     no, no importa lo que muestre esta pantalla. Por eso el árbol de carpetas
     se dibuja con lo que devuelve `GET /carpetas` y no se filtra acá: si una
     rama no vino, es porque no la ves.

     ═══ SESIÓN POR COOKIE ═══

     El token viaja en la cookie httpOnly `sess_emp`, que este JS no puede leer
     —ese es el punto— y por eso cada mutación manda el header X-CSRF-Token con
     el valor de la cookie `csrf_emp` (double-submit). No se guarda ningún token
     en localStorage: un token ahí es legible por cualquier script inyectado.
     =========================================================================== */

  var CUENTA = null;      // datos de /cuenta/datos
  var YO = null;          // /mi/quien-soy
  var ARBOL = [];         // árbol de carpetas
  var SEL = null;         // carpeta seleccionada
  var ROLES = [];         // roles de la cuenta (para los selectores)
  var CATALOGO = null;    // catálogo de capacidades

  var VISTAS = ['documentos', 'carpetas', 'accesos', 'roles', 'cuenta'];

  var ETIQUETA_ACCION = {
    ver: 'Ver que existe',
    leer: 'Abrir documentos',
    crear: 'Subir documentos',
    enviar: 'Enviar a firmar',
    mover: 'Mover documentos',
    organizar: 'Crear subcarpetas',
    permisos: 'Dar permisos',
  };

  // ---------------------------------------------------------------------------
  // Utilidades
  // ---------------------------------------------------------------------------
  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function csrf() {
    var m = document.cookie.match(/(?:^|;\s*)csrf_emp=([^;]*)/);
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
    // 401 es "no hay sesión", no un error de la pantalla: no tiene sentido
    // mostrar un cartel rojo en una consola a la que ya no se puede entrar.
    if (r.status === 401) { location.href = '/entrar'; throw new Error('Sesión vencida.'); }
    var txt = await r.text();
    var data;
    try { data = txt ? JSON.parse(txt) : {}; } catch (e) { data = { error: txt }; }
    if (!r.ok) throw new Error(data.error || data.message || ('HTTP ' + r.status));
    return data;
  }

  function msg(id, texto, clase) {
    var el = $(id);
    if (el) el.innerHTML = texto ? '<div class="msg ' + clase + '">' + esc(texto) + '</div>' : '';
  }

  function iniciales(nombre, email) {
    var s = (nombre || email || '?').trim();
    var p = s.split(/[\s@._-]+/).filter(Boolean);
    return ((p[0] || '?')[0] + (p[1] ? p[1][0] : '')).toUpperCase();
  }

  // ---------------------------------------------------------------------------
  // Navegación
  // ---------------------------------------------------------------------------
  function ir(vista) {
    if (VISTAS.indexOf(vista) < 0) vista = 'documentos';
    VISTAS.forEach(function (v) {
      var sec = $('v' + v[0].toUpperCase() + v.slice(1));
      if (sec) sec.classList.toggle('hidden', v !== vista);
    });
    document.querySelectorAll('nav.menu button').forEach(function (b) {
      b.setAttribute('aria-current', String(b.dataset.v === vista));
    });
    if (location.hash.slice(1) !== vista) location.hash = vista;
    window.scrollTo(0, 0);

    if (vista === 'documentos') cargarSelectorCarpetas();
    if (vista === 'carpetas') cargarCarpetas();
    if (vista === 'accesos') cargarUsuarios();
    if (vista === 'roles') cargarRoles();
    if (vista === 'cuenta') pintarCuenta();
  }

  async function salir() {
    try { await api('/auth/logout', 'POST'); } catch (e) { /* igual salimos */ }
    location.href = '/entrar';
  }

  // ---------------------------------------------------------------------------
  // Modal
  // ---------------------------------------------------------------------------
  function abrirModal(html) {
    $('modal').innerHTML = '<div class="fondo" id="fondo"><div class="modal">' + html + '</div></div>';
    $('fondo').addEventListener('mousedown', function (e) { if (e.target.id === 'fondo') cerrarModal(); });
    var primero = $('modal').querySelector('input,select');
    if (primero) setTimeout(function () { primero.focus(); }, 50);
  }
  function cerrarModal() { $('modal').innerHTML = ''; }

  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') cerrarModal(); });

  // ===========================================================================
  // DOCUMENTOS
  //
  // Subir un PDF no crea "un documento": crea un archivo, un circuito en
  // borrador, una instancia y una ubicación. Puede parecer mucho, pero es lo
  // que evita el rediseño de la semana siguiente — cuando le agregues firmantes
  // y lo mandes, el documento no se convierte en otra cosa, cambia de estado.
  // ===========================================================================
  var ESTADO_DOC = {
    borrador:  '<span class="pill no">Borrador</span>',
    enviado:   '<span class="pill esp">Esperando firmas</span>',
    completo:  '<span class="pill ok">Firmado</span>',
    cancelado: '<span class="pill no">Cancelado</span>',
    vencido:   '<span class="pill no">Vencido</span>',
  };

  function aplanar(nodos, salida, nivel) {
    (nodos || []).forEach(function (n) {
      salida.push({ id: n.id, nombre: '  '.repeat(nivel) + n.nombre });
      aplanar(n.hijos, salida, nivel + 1);
    });
    return salida;
  }

  async function cargarSelectorCarpetas() {
    try {
      if (!ARBOL.length) ARBOL = (await api('/carpetas')).carpetas || [];
      var lista = aplanar(ARBOL, [], 0);
      var sel = $('carpetaDocs');
      var previo = sel.value;
      sel.innerHTML = lista
        .map(function (c) { return '<option value="' + esc(c.id) + '">' + c.nombre + '</option>'; })
        .join('');
      if (previo) sel.value = previo;
      cargarDocumentos();
    } catch (e) {
      msg('msgDocs', e.message, 'err');
    }
  }

  async function cargarDocumentos() {
    var carpetaId = $('carpetaDocs').value;
    if (!carpetaId) return;
    msg('msgDocs', '', '');
    $('tDocumentos').innerHTML = '<tr><td colspan="5" class="vacio">Un momento…</td></tr>';
    try {
      var j = await api('/documentos?carpeta_id=' + encodeURIComponent(carpetaId));
      pintarDocumentos(j.documentos || []);
    } catch (e) {
      $('tDocumentos').innerHTML = '<tr><td colspan="5" class="vacio">' + esc(e.message) + '</td></tr>';
    }
  }

  function tamano(b) {
    return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
  }
  function fecha(s) {
    try { return new Date(s).toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' }); }
    catch (e) { return ''; }
  }

  function pintarDocumentos(docs) {
    if (!docs.length) {
      $('tDocumentos').innerHTML =
        '<tr><td colspan="5" class="vacio">No hay documentos en esta carpeta.</td></tr>';
      return;
    }
    $('tDocumentos').innerHTML = docs
      .map(function (d) {
        return (
          '<tr><td><b>' + esc(d.titulo) + '</b><br>' +
          '<span style="font-size:12.5px;color:var(--mut)">' + tamano(d.bytes) +
          (d.paginas ? ' · ' + d.paginas + ' págs' : '') + '</span></td>' +
          '<td>' + (ESTADO_DOC[d.circuito_estado] || esc(d.circuito_estado)) + '</td>' +
          '<td>' + (d.firmas_total
            ? d.firmas_hechas + ' de ' + d.firmas_total
            : '<span style="color:var(--mut)">sin firmantes</span>') + '</td>' +
          '<td>' + esc(fecha(d.creado_en)) + '</td>' +
          '<td><div class="acc" style="justify-content:flex-end">' +
          (d.circuito_estado === 'borrador'
            ? '<button class="btn btn-p chico" data-prep="' + esc(d.circuito_id) + '">Enviar a firmar</button>'
            : '') +
          '<button class="btn btn-s chico" data-ver="' + esc(d.instancia_id) +
          '" data-tit="' + esc(d.titulo) + '">Ver</button>' +
          '<button class="btn btn-s chico" data-exp="' + esc(d.instancia_id) + '">Expediente</button>' +
          '</div></td></tr>'
        );
      })
      .join('');

    $('tDocumentos').querySelectorAll('[data-ver]').forEach(function (b) {
      b.addEventListener('click', function () { abrirVisor(b.dataset.ver, b.dataset.tit); });
    });
    $('tDocumentos').querySelectorAll('[data-prep]').forEach(function (b) {
      b.addEventListener('click', function () { abrirCircuito(b.dataset.prep); });
    });
    $('tDocumentos').querySelectorAll('[data-exp]').forEach(function (b) {
      b.addEventListener('click', function () { verExpediente(b.dataset.exp); });
    });
  }

  /**
   * El visor.
   *
   * El documento se abre DENTRO de la consola y no en otra pestaña: el botón
   * atrás del navegador no es una forma de cerrar un documento, y cuando acá
   * adentro haya que poner campos y firmar, esta ventana es donde va a pasar.
   *
   * El PDF lo dibuja el visor del navegador dentro de un iframe. No usamos una
   * librería de render: la del navegador ya está, está probada y es la misma que
   * el firmante va a usar para leer lo que firma.
   */
  function abrirVisor(instanciaId, titulo) {
    var url = '/documentos/' + instanciaId + '/archivo';
    $('modal').innerHTML =
      '<div class="fondo" id="fondo"><div class="modal visor">' +
      '<div class="cabVisor">' +
      '<div style="min-width:0"><b style="display:block;font-size:15px;overflow:hidden;' +
      'text-overflow:ellipsis;white-space:nowrap">' + esc(titulo || 'Documento') + '</b>' +
      '<span style="font-size:12.5px;color:var(--mut)">Abrirlo queda registrado en el expediente</span></div>' +
      '<div class="acc">' +
      '<a class="btn btn-s chico" style="text-decoration:none" href="' + esc(url) +
      '" target="_blank" rel="noopener">Abrir aparte</a>' +
      '<button class="btn btn-p chico" id="mCerrar">Cerrar</button>' +
      '</div></div>' +
      '<iframe src="' + esc(url) + '" title="' + esc(titulo || 'Documento') + '"></iframe>' +
      '</div></div>';

    $('fondo').addEventListener('mousedown', function (e) { if (e.target.id === 'fondo') cerrarModal(); });
    $('mCerrar').addEventListener('click', cerrarModal);
    $('mCerrar').focus();
  }

  function abrirSubir() {
    abrirModal(
      '<h2>Subir documento</h2>' +
      '<p class="sub">Por ahora, PDF. Queda en borrador: todavía no se le pide la firma a nadie.</p>' +
      '<label class="campo" for="mArchivo">Archivo</label>' +
      '<input id="mArchivo" type="file" accept="application/pdf" />' +
      '<label class="campo" for="mTitulo">Título <span style="font-weight:400;color:var(--mut)">(opcional)</span></label>' +
      '<input id="mTitulo" maxlength="200" placeholder="Se usa el nombre del archivo" />' +
      '<p class="pista">Va a la carpeta que tenés elegida. Los permisos de esa carpeta deciden quién lo ve.</p>' +
      '<div id="msgModal"></div>' +
      '<div class="acc"><button class="btn btn-s" id="mCancel">Cancelar</button>' +
      '<button class="btn btn-p" id="mOk">Subir</button></div>'
    );
    $('mCancel').addEventListener('click', cerrarModal);
    $('mOk').addEventListener('click', async function () {
      var f = $('mArchivo').files[0];
      if (!f) return msg('msgModal', 'Elegí un archivo.', 'err');
      $('mOk').disabled = true;
      msg('msgModal', '', '');
      try {
        var fd = new FormData();
        fd.append('carpeta_id', $('carpetaDocs').value);
        var tit = $('mTitulo').value.trim();
        if (tit) fd.append('titulo', tit);
        // El archivo va ÚLTIMO a propósito: el servidor lee el stream del
        // archivo y recién después los campos de texto. Si el archivo fuera
        // primero, `carpeta_id` no estaría disponible al procesarlo.
        fd.append('archivo', f, f.name);

        var c = csrf();
        var r = await fetch('/documentos', {
          method: 'POST',
          credentials: 'same-origin',
          headers: c ? { 'X-CSRF-Token': c } : {},
          body: fd,   // sin Content-Type: lo pone el navegador con su boundary
        });
        var txt = await r.text();
        var data; try { data = txt ? JSON.parse(txt) : {}; } catch (e2) { data = { error: txt }; }
        if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));

        cerrarModal();
        await cargarDocumentos();
        if (data.duplicado) {
          msg('msgDocs', 'Ese archivo ya estaba subido: se reusó el mismo contenido.', 'ok');
        }
      } catch (e) {
        msg('msgModal', e.message, 'err');
        $('mOk').disabled = false;
      }
    });
  }

  /**
   * Preparar el circuito y despacharlo.
   *
   * Serie y paralelo no son dos pantallas ni dos caminos: es el mismo circuito
   * con distinto contenido en el orden de cada participación. En serie el
   * orden se autoincrementa; en paralelo son todos 1, y el servidor los aplana
   * cuando se cambia de modo — si no, el despacho notificaría sólo al primero y
   * el emisor creería que salió para todos.
   */
  var ESTADO_PART = {
    pendiente:  '<span class="pill no">Sin notificar</span>',
    notificada: '<span class="pill esp">Notificada</span>',
    vista:      '<span class="pill esp">Lo abrió</span>',
    firmada:    '<span class="pill ok">Firmó</span>',
    rechazada:  '<span class="pill no">Rechazó</span>',
    delegada:   '<span class="pill esp">Delegada</span>',
    vencida:    '<span class="pill no">Vencida</span>',
  };

  async function abrirCircuito(circuitoId) {
    try {
      var j = await api('/circuitos/' + circuitoId);
      pintarCircuito(circuitoId, j);
    } catch (e) {
      msg('msgDocs', e.message, 'err');
    }
  }

  function pintarCircuito(circuitoId, j) {
    var c = j.circuito;
    var parts = j.participaciones || [];
    var enviado = c.estado !== 'borrador';
    var serie = c.modo === 'serie';

    var filas = parts.length
      ? parts.map(function (p) {
          return (
            '<tr><td style="padding:9px 0;border-bottom:1px solid var(--line)">' +
            (serie ? '<b style="color:var(--mut)">' + p.orden + '.</b> ' : '') +
            '<b>' + esc(p.nombre || p.email) + '</b>' +
            (p.nombre ? '<br><span style="font-size:12.5px;color:var(--mut)">' + esc(p.email) + '</span>' : '') +
            '</td><td style="padding:9px 0;border-bottom:1px solid var(--line)">' +
            (p.papel === 'firmante' ? '' : '<span class="pill no">' + esc(p.papel) + '</span> ') +
            (ESTADO_PART[p.estado] || esc(p.estado)) +
            '</td><td style="padding:9px 0;border-bottom:1px solid var(--line);text-align:right">' +
            (enviado ? '' : '<button class="btn btn-d chico" data-quitar="' + esc(p.id) + '">Quitar</button>') +
            '</td></tr>'
          );
        }).join('')
      : '<tr><td colspan="3" style="padding:18px 0;color:var(--mut);font-size:14px">' +
        'Todavía no agregaste a nadie.</td></tr>';

    abrirModal(
      '<h2>' + esc(c.titulo) + '</h2>' +
      '<p class="sub">' +
      (enviado
        ? 'Ya se envió. El camino de firmas no se puede cambiar: la base lo congela después del despacho.'
        : 'Agregá a quién tiene que firmar y en qué orden. Ninguno necesita tener cuenta en MiFirma.') +
      '</p>' +

      (enviado ? '' :
        '<div class="dos">' +
        '<div><label class="campo" for="mModo">Orden de firma</label>' +
        '<select id="mModo">' +
        '<option value="serie"' + (serie ? ' selected' : '') + '>Uno después del otro</option>' +
        '<option value="paralelo"' + (serie ? '' : ' selected') + '>Todos a la vez</option>' +
        '</select></div>' +
        '<div><label class="campo" for="mDias">Vence en</label>' +
        '<select id="mDias">' +
        [['', 'Sin vencimiento'], ['7', '7 días'], ['15', '15 días'], ['30', '30 días'], ['90', '90 días']]
          .map(function (o) {
            return '<option value="' + o[0] + '"' +
              (String(c.dias_vigencia || '') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
          }).join('') +
        '</select></div></div>' +
        '<p class="pista">En serie, cada uno recibe el aviso cuando firma el anterior. ' +
        'A la vez, les llega a todos junto.</p>') +

      '<table style="width:100%;margin-top:18px"><tbody id="mParts">' + filas + '</tbody></table>' +

      (enviado ? '' :
        '<div class="dos" style="margin-top:16px">' +
        '<div><label class="campo" for="mEmail">Correo de quien firma</label>' +
        '<input id="mEmail" type="email" placeholder="persona@empresa.com" /></div>' +
        '<div><label class="campo" for="mNombre">Nombre <span style="font-weight:400;color:var(--mut)">(opcional)</span></label>' +
        '<input id="mNombre" maxlength="120" /></div></div>' +
        '<button class="btn btn-s" id="mAgregar" style="margin-top:10px">Agregar</button>') +

      '<div id="msgModal"></div>' +
      '<div class="acc">' +
      '<button class="btn btn-s" id="mCancel">' + (enviado ? 'Cerrar' : 'Después') + '</button>' +
      (enviado ? '' : '<button class="btn btn-p" id="mEnviar">Enviar a firmar</button>') +
      '</div>'
    );

    $('mCancel').addEventListener('click', function () { cerrarModal(); cargarDocumentos(); });

    $('modal').querySelectorAll('[data-quitar]').forEach(function (b) {
      b.addEventListener('click', async function () {
        try {
          await api('/circuitos/' + circuitoId + '/firmantes/' + b.dataset.quitar, 'DELETE');
          abrirCircuito(circuitoId);
        } catch (e) { msg('msgModal', e.message, 'err'); }
      });
    });

    if (enviado) return;

    async function guardarConfig() {
      var dias = $('mDias').value;
      await api('/circuitos/' + circuitoId, 'PATCH', {
        modo: $('mModo').value,
        dias_vigencia: dias === '' ? null : Number(dias),
      });
    }
    $('mModo').addEventListener('change', function () {
      guardarConfig().then(function () { abrirCircuito(circuitoId); })
        .catch(function (e) { msg('msgModal', e.message, 'err'); });
    });
    $('mDias').addEventListener('change', function () {
      guardarConfig().catch(function (e) { msg('msgModal', e.message, 'err'); });
    });

    $('mAgregar').addEventListener('click', async function () {
      var email = $('mEmail').value.trim();
      if (!email) return msg('msgModal', 'Falta el correo.', 'err');
      $('mAgregar').disabled = true;
      try {
        await api('/circuitos/' + circuitoId + '/firmantes', 'POST', {
          email: email,
          nombre: $('mNombre').value.trim() || undefined,
          // En serie cada uno va después del anterior; a la vez, todos en 1.
          orden: $('mModo').value === 'serie' ? parts.length + 1 : 1,
        });
        abrirCircuito(circuitoId);
      } catch (e) { msg('msgModal', e.message, 'err'); $('mAgregar').disabled = false; }
    });

    $('mEnviar').addEventListener('click', async function () {
      if (!parts.length) return msg('msgModal', 'Agregá al menos un firmante.', 'err');
      $('mEnviar').disabled = true;
      msg('msgModal', '', '');
      try {
        await guardarConfig();
        var r = await api('/circuitos/' + circuitoId + '/despachar', 'POST');
        cerrarModal();
        await cargarDocumentos();
        if (r.fallidos && r.fallidos.length) {
          // Se envió igual: el documento está despachado y los otorgamientos
          // emitidos. Lo que falló es el aviso, y eso se reintenta.
          msg('msgDocs',
            'Enviado, pero no salió el aviso a: ' +
            r.fallidos.map(function (f) { return f.email; }).join(', '), 'err');
        } else {
          msg('msgDocs', 'Enviado. Le avisamos a ' + r.notificados + ' persona(s).', 'ok');
        }
      } catch (e) { msg('msgModal', e.message, 'err'); $('mEnviar').disabled = false; }
    });
  }

  /**
   * El expediente.
   *
   * Se muestra el resultado de verificar la cadena arriba de todo, no escondido
   * al final: si no cierra, es lo primero que hay que saber.
   */
  async function verExpediente(instanciaId) {
    abrirModal('<h2>Expediente</h2><p class="sub">Buscando…</p>');
    try {
      var j = await api('/documentos/' + instanciaId + '/evidencia');
      var c = j.cadena;
      var estado = c.integra
        ? '<div class="msg ok">Cadena íntegra: ' + c.eventos + ' evento' + (c.eventos === 1 ? '' : 's') +
          ', sin huecos ni alteraciones.</div>'
        : '<div class="msg err">La cadena no cierra: ' + c.huecos + ' hueco(s) y ' + c.rotos +
          ' evento(s) alterado(s). No emitas un certificado con este expediente.</div>';

      var filas = j.eventos.map(function (e) {
        var d = e.descripcion_i18n || {};
        var texto = d.es || d.pt || d.en || e.tipo;
        var quien = e.nombre || e.email || ({ sistema: 'El sistema', proveedor: 'El proveedor' }[e.actor_tipo] || '—');
        var cuando = '';
        try { cuando = new Date(e.ocurrido_en).toLocaleString('es'); } catch (x) {}
        return (
          '<div style="display:flex;gap:12px;padding:12px 0;border-bottom:1px solid var(--line)">' +
          '<div style="flex:none;width:26px;height:26px;border-radius:50%;background:var(--acc-50);' +
          'color:var(--acc-700);display:grid;place-items:center;font-size:12px;font-weight:700">' +
          e.numero_orden + '</div>' +
          '<div style="flex:1;min-width:0">' +
          '<b style="font-size:14px">' + esc(texto) + '</b>' +
          (e.peso === 'alto' ? ' <span class="pill esp">hito</span>' : '') +
          '<div style="font-size:12.5px;color:var(--mut)">' + esc(quien) + ' · ' + esc(cuando) +
          (e.ip ? ' · ' + esc(e.ip) : '') + '</div>' +
          '<div style="font-size:11px;color:var(--mut);font-family:ui-monospace,monospace;' +
          'overflow:hidden;text-overflow:ellipsis">' + esc((e.hash_propio || '').slice(0, 32)) + '…</div>' +
          '</div></div>'
        );
      }).join('');

      abrirModal(
        '<h2>Expediente de evidencias</h2>' +
        '<p class="sub">Cada evento encadena con el anterior. Nadie —tampoco nosotros— puede ' +
        'editarlo ni borrarlo: la base no lo permite.</p>' +
        estado +
        '<div style="max-height:52vh;overflow:auto;margin-top:12px">' + filas + '</div>' +
        '<div class="acc"><button class="btn btn-p" id="mCancel">Cerrar</button></div>'
      );
      $('mCancel').addEventListener('click', cerrarModal);
    } catch (e) {
      abrirModal(
        '<h2>Expediente</h2><div class="msg err">' + esc(e.message) + '</div>' +
        '<div class="acc"><button class="btn btn-p" id="mCancel">Cerrar</button></div>'
      );
      $('mCancel').addEventListener('click', cerrarModal);
    }
  }

  // ===========================================================================
  // CARPETAS
  //
  // El árbol es la respuesta a "quiero que contabilidad vea los contratos pero
  // no los legajos". Los roles dicen qué sabe hacer cada uno; la carpeta dice
  // sobre qué. Herencia aditiva y sin denegación explícita (ver
  // `services/carpetas.ts`), así que la regla que se le explica al usuario es
  // una sola: lo que das arriba vale para todo lo que cuelga.
  // ===========================================================================
  async function cargarCarpetas() {
    try {
      var j = await api('/carpetas');
      ARBOL = j.carpetas || [];
      pintarArbol();
      var quedaSeleccionada = SEL && buscarNodo(ARBOL, SEL.id);
      seleccionar((quedaSeleccionada || ARBOL[0] || null));
    } catch (e) {
      $('arbol').innerHTML = '<div class="vacio">' + esc(e.message) + '</div>';
    }
  }

  function buscarNodo(nodos, id) {
    for (var i = 0; i < nodos.length; i++) {
      if (nodos[i].id === id) return nodos[i];
      var h = buscarNodo(nodos[i].hijos || [], id);
      if (h) return h;
    }
    return null;
  }

  var ICONO_CARPETA =
    '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 012-2h4l2 2.5h8a2 2 0 012 2V18a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>';

  function pintarArbol() {
    var html = '';
    function fila(n, nivel) {
      html +=
        '<div class="nodo" data-id="' + esc(n.id) + '" role="option" aria-selected="false"' +
        ' style="padding-left:' + (10 + nivel * 16) + 'px">' +
        ICONO_CARPETA + '<span>' + esc(n.nombre) + '</span>' +
        (n.sistema ? '<span class="sis">del sistema</span>' : '') +
        '</div>';
      (n.hijos || []).forEach(function (h) { fila(h, nivel + 1); });
    }
    ARBOL.forEach(function (n) { fila(n, 0); });
    $('arbol').innerHTML = html || '<div class="vacio">No hay carpetas visibles para vos.</div>';
    $('arbol').querySelectorAll('.nodo').forEach(function (d) {
      d.addEventListener('click', function () { seleccionar(buscarNodo(ARBOL, d.dataset.id)); });
    });
  }

  function seleccionar(nodo) {
    SEL = nodo;
    $('arbol').querySelectorAll('.nodo').forEach(function (d) {
      d.setAttribute('aria-selected', String(!!nodo && d.dataset.id === nodo.id));
    });
    if (!nodo) {
      $('nomCarpeta').textContent = 'Elegí una carpeta';
      $('rutaCarpeta').textContent = '';
      $('accCarpeta').innerHTML = '';
      $('tPermisos').innerHTML = '';
      return;
    }
    $('nomCarpeta').textContent = nodo.nombre;
    $('rutaCarpeta').textContent = nodo.sistema ? 'Carpeta del sistema' : nodo.ruta;
    $('accCarpeta').innerHTML = nodo.sistema
      ? ''
      : '<button class="btn btn-s chico" id="btnRenombrarC">Renombrar</button>' +
        '<button class="btn btn-d chico" id="btnBorrarC">Borrar</button>';
    if (!nodo.sistema) {
      $('btnRenombrarC').addEventListener('click', abrirRenombrarCarpeta);
      $('btnBorrarC').addEventListener('click', borrarCarpeta);
    }
    cargarPermisos(nodo.id);
  }

  async function cargarPermisos(carpetaId) {
    msg('msgPermisos', '', '');
    $('tPermisos').innerHTML = '<tr><td colspan="2" class="vacio">Un momento…</td></tr>';
    try {
      var j = await api('/carpetas/' + carpetaId + '/permisos');
      pintarPermisos(j);
    } catch (e) {
      // 403 acá es normal y no es una falla: quien no administra permisos ve la
      // carpeta pero no la matriz.
      $('tPermisos').innerHTML = '<tr><td colspan="2" class="vacio">' + esc(e.message) + '</td></tr>';
    }
  }

  function pintarPermisos(j) {
    var acciones = j.acciones || [];
    $('tPermisos').innerHTML = (j.roles || [])
      .map(function (r) {
        var casillas = acciones
          .map(function (a) {
            var propia = r.propias.indexOf(a) >= 0;
            var heredada = r.heredadas.indexOf(a) >= 0;
            return (
              '<label title="' + esc(a) + '">' +
              '<input type="checkbox" data-rol="' + esc(r.rol_id) + '" data-accion="' + esc(a) + '"' +
              (propia ? ' checked' : '') + ' />' +
              esc(ETIQUETA_ACCION[a] || a) +
              (heredada && !propia ? ' <span style="color:var(--acc-700)">(heredado)</span>' : '') +
              '</label>'
            );
          })
          .join('');
        var nota = r.heredadas.length
          ? '<span class="hered">Hereda ' +
            r.heredadas.map(function (a) { return esc(ETIQUETA_ACCION[a] || a).toLowerCase(); }).join(', ') +
            (r.heredadas_de ? ' de «' + esc(r.heredadas_de) + '»' : '') +
            '. Eso no se quita desde acá: se quita arriba.</span>'
          : '';
        return (
          '<tr><td><b>' + esc(r.nombre) + '</b>' +
          (r.sistema ? '<br><span style="font-size:12px;color:var(--mut)">rol del sistema</span>' : '') +
          '</td><td>' + casillas + nota + '</td></tr>'
        );
      })
      .join('');

    $('tPermisos').querySelectorAll('input[type=checkbox]').forEach(function (chk) {
      chk.addEventListener('change', function () { guardarPermiso(chk.dataset.rol); });
    });
  }

  // Se manda la fila entera del rol, no el cambio: `setPermiso` reemplaza el
  // conjunto, así que lo que se ve en pantalla es exactamente lo que queda.
  async function guardarPermiso(rolId) {
    var acciones = [];
    $('tPermisos').querySelectorAll('input[data-rol="' + rolId + '"]').forEach(function (c) {
      if (c.checked) acciones.push(c.dataset.accion);
    });
    // `ver` es la base: el backend la agrega igual, pero si no la reflejamos
    // acá la casilla queda desmarcada y la pantalla miente.
    if (acciones.length && acciones.indexOf('ver') < 0) {
      acciones.push('ver');
      var v = $('tPermisos').querySelector('input[data-rol="' + rolId + '"][data-accion="ver"]');
      if (v) v.checked = true;
    }
    try {
      await api('/carpetas/' + SEL.id + '/permisos', 'PUT', { rol_id: rolId, acciones: acciones });
      msg('msgPermisos', 'Guardado.', 'ok');
      setTimeout(function () { msg('msgPermisos', '', ''); }, 1500);
    } catch (e) {
      msg('msgPermisos', e.message, 'err');
      cargarPermisos(SEL.id); // volver a lo que dice la base, no a lo que quiso el clic
    }
  }

  function abrirNuevaCarpeta() {
    if (!SEL) return;
    abrirModal(
      '<h2>Nueva subcarpeta</h2>' +
      '<p class="sub">Va a colgar de «' + esc(SEL.nombre) + '».</p>' +
      '<label class="campo" for="mNombre">Nombre</label>' +
      '<input id="mNombre" maxlength="80" placeholder="Contratos 2026" />' +
      '<p class="pista">Los permisos que tenga «' + esc(SEL.nombre) + '» se heredan acá adentro.</p>' +
      '<div id="msgModal"></div>' +
      '<div class="acc">' +
      '<button class="btn btn-s" id="mCancel">Cancelar</button>' +
      '<button class="btn btn-p" id="mOk">Crear</button></div>'
    );
    $('mCancel').addEventListener('click', cerrarModal);
    $('mOk').addEventListener('click', async function () {
      var nombre = $('mNombre').value.trim();
      if (!nombre) return msg('msgModal', 'Poné un nombre.', 'err');
      $('mOk').disabled = true;
      try {
        await api('/carpetas', 'POST', { padre_id: SEL.id, nombre: nombre });
        cerrarModal();
        await cargarCarpetas();
      } catch (e) { msg('msgModal', e.message, 'err'); $('mOk').disabled = false; }
    });
  }

  function abrirRenombrarCarpeta() {
    abrirModal(
      '<h2>Renombrar carpeta</h2>' +
      '<label class="campo" for="mNombre">Nombre</label>' +
      '<input id="mNombre" maxlength="80" value="' + esc(SEL.nombre) + '" />' +
      '<p class="pista">Cambia lo que se ve. La ruta interna y los permisos quedan como están.</p>' +
      '<div id="msgModal"></div>' +
      '<div class="acc"><button class="btn btn-s" id="mCancel">Cancelar</button>' +
      '<button class="btn btn-p" id="mOk">Guardar</button></div>'
    );
    $('mCancel').addEventListener('click', cerrarModal);
    $('mOk').addEventListener('click', async function () {
      var nombre = $('mNombre').value.trim();
      if (!nombre) return msg('msgModal', 'Poné un nombre.', 'err');
      $('mOk').disabled = true;
      try {
        await api('/carpetas/' + SEL.id, 'PATCH', { nombre: nombre });
        cerrarModal();
        await cargarCarpetas();
      } catch (e) { msg('msgModal', e.message, 'err'); $('mOk').disabled = false; }
    });
  }

  function borrarCarpeta() {
    abrirModal(
      '<h2>Borrar «' + esc(SEL.nombre) + '»</h2>' +
      '<p class="sub">Sólo se puede si está vacía: sin subcarpetas y sin documentos.</p>' +
      '<div id="msgModal"></div>' +
      '<div class="acc"><button class="btn btn-s" id="mCancel">Cancelar</button>' +
      '<button class="btn btn-d" id="mOk">Borrar</button></div>'
    );
    $('mCancel').addEventListener('click', cerrarModal);
    $('mOk').addEventListener('click', async function () {
      $('mOk').disabled = true;
      try {
        await api('/carpetas/' + SEL.id, 'DELETE');
        cerrarModal();
        SEL = null;
        await cargarCarpetas();
      } catch (e) { msg('msgModal', e.message, 'err'); $('mOk').disabled = false; }
    });
  }

  // ===========================================================================
  // ACCESOS
  //
  // Dar acceso no crea una persona: resuelve una identidad global y le agrega
  // una membresía en esta cuenta. Por eso el formulario pide un correo y no un
  // "alta de empleado", y por eso dar de baja dice lo que dice.
  // ===========================================================================
  async function cargarUsuarios() {
    try {
      var r = await api('/usuarios/roles');
      ROLES = r.roles || [];
      var j = await api('/usuarios');
      pintarUsuarios(j.usuarios || []);
      msg('msgAccesos', '', '');
    } catch (e) {
      $('tUsuarios').innerHTML = '<tr><td colspan="4" class="vacio">' + esc(e.message) + '</td></tr>';
    }
  }

  var PILL_ESTADO = {
    activa: '<span class="pill ok">Activo</span>',
    suspendida: '<span class="pill esp">Suspendido</span>',
    terminada: '<span class="pill no">Sin acceso</span>',
  };

  function pintarUsuarios(us) {
    if (!us.length) {
      $('tUsuarios').innerHTML = '<tr><td colspan="4" class="vacio">Todavía sos la única persona en esta cuenta.</td></tr>';
      return;
    }
    $('tUsuarios').innerHTML = us
      .map(function (u) {
        var roles = u.roles.length
          ? u.roles.map(function (r) {
              return '<span class="pill rol">' + esc(r.nombre) +
                ' <a href="#" data-quitar="' + esc(u.identidad_id) + '|' + esc(r.rol_id) +
                '" title="Quitar" style="color:inherit">×</a></span>';
            }).join('')
          : '<span class="pill no">Sin rol</span>';
        var pendiente = u.tiene_password ? '' : '<span class="pill esp">Invitación pendiente</span>';
        return (
          '<tr><td><div class="pers"><div class="av">' + esc(iniciales(u.nombre, u.email)) + '</div>' +
          '<div><b>' + esc(u.nombre || u.email) + '</b><span>' + esc(u.email) + '</span></div></div></td>' +
          '<td>' + roles + '<a href="#" data-agregar="' + esc(u.identidad_id) +
          '" class="pill no" style="text-decoration:none">+ rol</a></td>' +
          '<td>' + (PILL_ESTADO[u.estado] || esc(u.estado)) + ' ' + pendiente + '</td>' +
          '<td><div class="acc">' +
          (u.tiene_password ? '' : '<button class="btn btn-s chico" data-reinv="' + esc(u.identidad_id) + '">Reinvitar</button>') +
          (u.estado === 'activa'
            ? '<button class="btn btn-s chico" data-estado="' + esc(u.identidad_id) + '|suspendida">Suspender</button>'
            : '<button class="btn btn-s chico" data-estado="' + esc(u.identidad_id) + '|activa">Reactivar</button>') +
          '<button class="btn btn-d chico" data-estado="' + esc(u.identidad_id) + '|terminada">Quitar acceso</button>' +
          '</div></td></tr>'
        );
      })
      .join('');

    var t = $('tUsuarios');
    t.querySelectorAll('[data-estado]').forEach(function (b) {
      b.addEventListener('click', function () {
        var p = b.dataset.estado.split('|');
        cambiarEstado(p[0], p[1]);
      });
    });
    t.querySelectorAll('[data-reinv]').forEach(function (b) {
      b.addEventListener('click', function () { reinvitar(b.dataset.reinv); });
    });
    t.querySelectorAll('[data-quitar]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        var p = a.dataset.quitar.split('|');
        quitarRol(p[0], p[1]);
      });
    });
    t.querySelectorAll('[data-agregar]').forEach(function (a) {
      a.addEventListener('click', function (e) { e.preventDefault(); abrirAgregarRol(a.dataset.agregar); });
    });
  }

  async function cambiarEstado(id, estado) {
    if (estado === 'terminada') {
      abrirModal(
        '<h2>Quitar el acceso</h2>' +
        '<p class="sub">Esta persona deja de entrar a tu cuenta. No se borra su identidad, ' +
        'no se toca lo que ya firmó y sigue entrando a las otras empresas donde tenga acceso.</p>' +
        '<div id="msgModal"></div>' +
        '<div class="acc"><button class="btn btn-s" id="mCancel">Cancelar</button>' +
        '<button class="btn btn-d" id="mOk">Quitar acceso</button></div>'
      );
      $('mCancel').addEventListener('click', cerrarModal);
      $('mOk').addEventListener('click', async function () {
        $('mOk').disabled = true;
        try {
          await api('/usuarios/' + id + '/estado', 'PUT', { estado: estado });
          cerrarModal();
          cargarUsuarios();
        } catch (e) { msg('msgModal', e.message, 'err'); $('mOk').disabled = false; }
      });
      return;
    }
    try {
      await api('/usuarios/' + id + '/estado', 'PUT', { estado: estado });
      cargarUsuarios();
    } catch (e) { msg('msgAccesos', e.message, 'err'); }
  }

  async function reinvitar(id) {
    try {
      await api('/usuarios/' + id + '/reinvitar', 'POST');
      msg('msgAccesos', 'Invitación enviada de nuevo.', 'ok');
    } catch (e) { msg('msgAccesos', e.message, 'err'); }
  }

  async function quitarRol(id, rolId) {
    try {
      await api('/usuarios/' + id + '/roles/' + rolId, 'DELETE');
      cargarUsuarios();
    } catch (e) { msg('msgAccesos', e.message, 'err'); }
  }

  function opcionesRol(excluir) {
    return ROLES.filter(function (r) { return !excluir || excluir.indexOf(r.id) < 0; })
      .map(function (r) { return '<option value="' + esc(r.id) + '">' + esc(r.nombre) + '</option>'; })
      .join('');
  }

  function abrirAgregarRol(id) {
    abrirModal(
      '<h2>Agregar un rol</h2>' +
      '<p class="sub">Los roles se suman: la persona termina con la unión de todas sus capacidades.</p>' +
      '<label class="campo" for="mRol">Rol</label>' +
      '<select id="mRol">' + opcionesRol(null) + '</select>' +
      '<div id="msgModal"></div>' +
      '<div class="acc"><button class="btn btn-s" id="mCancel">Cancelar</button>' +
      '<button class="btn btn-p" id="mOk">Agregar</button></div>'
    );
    $('mCancel').addEventListener('click', cerrarModal);
    $('mOk').addEventListener('click', async function () {
      $('mOk').disabled = true;
      try {
        await api('/usuarios/' + id + '/roles', 'POST', { rol_id: $('mRol').value });
        cerrarModal();
        cargarUsuarios();
      } catch (e) { msg('msgModal', e.message, 'err'); $('mOk').disabled = false; }
    });
  }

  function abrirNuevoAcceso() {
    if (!ROLES.length) return msg('msgAccesos', 'Primero cargá los roles.', 'err');
    abrirModal(
      '<h2>Dar acceso</h2>' +
      '<p class="sub">Le llega una invitación por correo para que elija su contraseña. ' +
      'Si esa persona ya usa MiFirma en otra empresa, entra con la que ya tiene.</p>' +
      '<label class="campo" for="mEmail">Correo</label>' +
      '<input id="mEmail" type="email" placeholder="persona@empresa.com" />' +
      '<label class="campo" for="mNombre">Nombre <span style="font-weight:400;color:var(--mut)">(opcional)</span></label>' +
      '<input id="mNombre" maxlength="120" />' +
      '<label class="campo" for="mRol">Rol</label>' +
      '<select id="mRol">' + opcionesRol(null) + '</select>' +
      '<p class="pista">Después, en Carpetas, decidís sobre qué documentos aplica ese rol.</p>' +
      '<div id="msgModal"></div>' +
      '<div class="acc"><button class="btn btn-s" id="mCancel">Cancelar</button>' +
      '<button class="btn btn-p" id="mOk">Dar acceso</button></div>'
    );
    $('mCancel').addEventListener('click', cerrarModal);
    $('mOk').addEventListener('click', async function () {
      var email = $('mEmail').value.trim();
      if (!email) return msg('msgModal', 'Falta el correo.', 'err');
      $('mOk').disabled = true;
      try {
        await api('/usuarios', 'POST', {
          email: email,
          nombre: $('mNombre').value.trim() || undefined,
          rol_id: $('mRol').value,
        });
        cerrarModal();
        cargarUsuarios();
      } catch (e) { msg('msgModal', e.message, 'err'); $('mOk').disabled = false; }
    });
  }

  // ===========================================================================
  // ROLES
  //
  // Una capacidad es binaria: la tenés o no. El "sobre qué documentos" no está
  // acá — está en Carpetas. Es la diferencia con payroll, donde cada capacidad
  // arrastraba un alcance atado al organigrama.
  // ===========================================================================
  async function cargarRoles() {
    try {
      if (!CATALOGO) CATALOGO = await api('/roles/catalogo');
      var j = await api('/roles/detalle');
      pintarRoles(j.roles || []);
      msg('msgRoles', '', '');
    } catch (e) {
      $('tRoles').innerHTML = '<tr><td colspan="3" class="vacio">' + esc(e.message) + '</td></tr>';
    }
  }

  function pintarRoles(roles) {
    $('tRoles').innerHTML = roles
      .map(function (r) {
        var caps = r.capacidades.length
          ? r.capacidades.slice(0, 6).map(function (c) {
              return '<span class="pill rol">' + esc(c.recurso) + '·' + esc(c.accion) + '</span>';
            }).join('') + (r.capacidades.length > 6
              ? '<span class="pill no">+' + (r.capacidades.length - 6) + '</span>' : '')
          : '<span class="pill no">Ninguna</span>';
        return (
          '<tr><td><b>' + esc(r.nombre) + '</b>' +
          (r.sistema ? '<br><span style="font-size:12px;color:var(--mut)">del sistema, no se edita</span>' : '') +
          '</td><td>' + caps + '</td>' +
          '<td><div class="acc">' +
          (r.sistema ? '' :
            '<button class="btn btn-s chico" data-caps="' + esc(r.rol_id) + '">Capacidades</button>' +
            '<button class="btn btn-s chico" data-ren="' + esc(r.rol_id) + '">Renombrar</button>' +
            '<button class="btn btn-d chico" data-del="' + esc(r.rol_id) + '">Borrar</button>') +
          '</div></td></tr>'
        );
      })
      .join('');

    var t = $('tRoles');
    var porId = {};
    roles.forEach(function (r) { porId[r.rol_id] = r; });
    t.querySelectorAll('[data-caps]').forEach(function (b) {
      b.addEventListener('click', function () { abrirCapacidades(porId[b.dataset.caps]); });
    });
    t.querySelectorAll('[data-ren]').forEach(function (b) {
      b.addEventListener('click', function () { abrirRenombrarRol(porId[b.dataset.ren]); });
    });
    t.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function () { borrarRol(porId[b.dataset.del]); });
    });
  }

  function abrirCapacidades(rol) {
    var tiene = {};
    rol.capacidades.forEach(function (c) { tiene[c.capacidad_id] = true; });
    var cuerpo = (CATALOGO.recursos || [])
      .map(function (g) {
        return (
          '<div style="margin-top:16px"><b style="font-size:13px;text-transform:uppercase;' +
          'letter-spacing:.06em;color:var(--mut)">' + esc(g.recurso) + '</b><div style="margin-top:6px">' +
          g.acciones.map(function (a) {
            return '<label style="display:flex;align-items:center;gap:8px;font-size:14px;padding:4px 0;cursor:pointer">' +
              '<input type="checkbox" data-cap="' + esc(a.id) + '" style="width:16px;height:16px;accent-color:var(--acc-700)"' +
              (tiene[a.id] ? ' checked' : '') + ' />' + esc(a.descripcion) + '</label>';
          }).join('') +
          '</div></div>'
        );
      })
      .join('');

    abrirModal(
      '<h2>Capacidades de «' + esc(rol.nombre) + '»</h2>' +
      '<p class="sub">Qué sabe hacer este rol. Sobre qué documentos lo puede hacer se decide en Carpetas.</p>' +
      '<div style="max-height:52vh;overflow:auto;margin:0 -4px;padding:0 4px">' + cuerpo + '</div>' +
      '<div id="msgModal"></div>' +
      '<div class="acc"><button class="btn btn-p" id="mCancel">Listo</button></div>'
    );
    $('mCancel').addEventListener('click', function () { cerrarModal(); cargarRoles(); });
    // Cada casilla guarda sola: un botón "Guardar" acá invita a cerrar el modal
    // creyendo que se guardó, y el error de anti-lockout aparecería tarde.
    $('modal').querySelectorAll('input[data-cap]').forEach(function (chk) {
      chk.addEventListener('change', async function () {
        try {
          await api('/roles/' + rol.rol_id + '/capacidad', 'PUT', {
            capacidad_id: chk.dataset.cap,
            activa: chk.checked,
          });
          msg('msgModal', '', '');
        } catch (e) {
          chk.checked = !chk.checked;
          msg('msgModal', e.message, 'err');
        }
      });
    });
  }

  function abrirNuevoRol() {
    abrirModal(
      '<h2>Nuevo rol</h2>' +
      '<p class="sub">Nace sin capacidades. Se las prendés después, una por una.</p>' +
      '<label class="campo" for="mNombre">Nombre</label>' +
      '<input id="mNombre" maxlength="80" placeholder="Contabilidad" />' +
      '<label class="campo" for="mCodigo">Código</label>' +
      '<input id="mCodigo" maxlength="40" placeholder="contabilidad" />' +
      '<p class="pista">El código es interno y no cambia. El nombre sí se puede cambiar.</p>' +
      '<div id="msgModal"></div>' +
      '<div class="acc"><button class="btn btn-s" id="mCancel">Cancelar</button>' +
      '<button class="btn btn-p" id="mOk">Crear</button></div>'
    );
    $('mCancel').addEventListener('click', cerrarModal);
    $('mNombre').addEventListener('input', function () {
      var c = $('mCodigo');
      if (!c.dataset.tocado) {
        c.value = $('mNombre').value.normalize('NFD').replace(/[̀-ͯ]/g, '')
          .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      }
    });
    $('mCodigo').addEventListener('input', function () { $('mCodigo').dataset.tocado = '1'; });
    $('mOk').addEventListener('click', async function () {
      var nombre = $('mNombre').value.trim(), codigo = $('mCodigo').value.trim();
      if (!nombre || !codigo) return msg('msgModal', 'Completá nombre y código.', 'err');
      $('mOk').disabled = true;
      try {
        await api('/roles', 'POST', { codigo: codigo, nombre: nombre });
        cerrarModal();
        cargarRoles();
      } catch (e) { msg('msgModal', e.message, 'err'); $('mOk').disabled = false; }
    });
  }

  function abrirRenombrarRol(rol) {
    abrirModal(
      '<h2>Renombrar rol</h2>' +
      '<label class="campo" for="mNombre">Nombre</label>' +
      '<input id="mNombre" maxlength="80" value="' + esc(rol.nombre) + '" />' +
      '<div id="msgModal"></div>' +
      '<div class="acc"><button class="btn btn-s" id="mCancel">Cancelar</button>' +
      '<button class="btn btn-p" id="mOk">Guardar</button></div>'
    );
    $('mCancel').addEventListener('click', cerrarModal);
    $('mOk').addEventListener('click', async function () {
      var nombre = $('mNombre').value.trim();
      if (!nombre) return msg('msgModal', 'Poné un nombre.', 'err');
      $('mOk').disabled = true;
      try {
        await api('/roles/' + rol.rol_id, 'PATCH', { nombre: nombre });
        cerrarModal();
        cargarRoles();
      } catch (e) { msg('msgModal', e.message, 'err'); $('mOk').disabled = false; }
    });
  }

  function borrarRol(rol) {
    abrirModal(
      '<h2>Borrar «' + esc(rol.nombre) + '»</h2>' +
      '<p class="sub">Sólo se puede si no lo tiene asignado nadie.</p>' +
      '<div id="msgModal"></div>' +
      '<div class="acc"><button class="btn btn-s" id="mCancel">Cancelar</button>' +
      '<button class="btn btn-d" id="mOk">Borrar</button></div>'
    );
    $('mCancel').addEventListener('click', cerrarModal);
    $('mOk').addEventListener('click', async function () {
      $('mOk').disabled = true;
      try {
        await api('/roles/' + rol.rol_id, 'DELETE');
        cerrarModal();
        cargarRoles();
      } catch (e) { msg('msgModal', e.message, 'err'); $('mOk').disabled = false; }
    });
  }

  // ===========================================================================
  // CUENTA
  // ===========================================================================
  function pintarCuenta() {
    if (!CUENTA) return;
    $('qNombre').value = CUENTA.nombre || '';
    $('qRazon').value = CUENTA.razon_social || '';
    $('qFiscal').value = CUENTA.identificacion_fiscal || '';
    $('qDomicilio').value = CUENTA.domicilio || '';
    $('qPais').textContent = CUENTA.pais || '—';
    $('qMoneda').textContent = CUENTA.moneda || '—';
  }

  async function guardarCuenta() {
    msg('msgCuenta', '', '');
    try {
      await api('/cuenta/datos', 'PUT', {
        nombre: $('qNombre').value.trim(),
        razon_social: $('qRazon').value.trim() || null,
        identificacion_fiscal: $('qFiscal').value.trim() || null,
        domicilio: $('qDomicilio').value.trim() || null,
      });
      CUENTA = await api('/cuenta/datos');
      $('pieCuenta').textContent = CUENTA.nombre || '';
      msg('msgCuenta', 'Guardado.', 'ok');
    } catch (e) { msg('msgCuenta', e.message, 'err'); }
  }

  // ===========================================================================
  // Arranque
  // ===========================================================================
  async function arrancar() {
    try {
      YO = await api('/mi/quien-soy');
    } catch (e) {
      // Si esto falla con algo que no sea 401, la sesión existe pero la cuenta
      // no responde: mejor decirlo que dejar la consola muda.
      $('pieCuenta').textContent = 'No se pudo cargar la cuenta';
      $('pieUsuario').textContent = e.message;
      return;
    }
    $('pieCuenta').textContent = YO.cuenta_nombre || '';
    $('pieUsuario').textContent = YO.email || '';
    document.title = (YO.cuenta_nombre ? YO.cuenta_nombre + ' · ' : '') + 'MiFirma';

    try { CUENTA = await api('/cuenta/datos'); } catch (e) { /* la vista lo muestra */ }

    ir((location.hash || '').slice(1) || 'documentos');
    window.addEventListener('hashchange', function () { ir((location.hash || '').slice(1)); });
  }

  window.ir = ir;
  window.salir = salir;
  window.abrirSubir = abrirSubir;
  window.abrirCircuito = abrirCircuito;
  window.cargarDocumentos = cargarDocumentos;
  window.abrirNuevaCarpeta = abrirNuevaCarpeta;
  window.abrirNuevoAcceso = abrirNuevoAcceso;
  window.abrirNuevoRol = abrirNuevoRol;
  window.guardarCuenta = guardarCuenta;
  window.cerrarModal = cerrarModal;

  arrancar();
})();
