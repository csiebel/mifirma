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
  var SEL = null;         // carpeta seleccionada en la pantalla Carpetas
  var CARPETA = null;     // carpeta que se está mirando en Documentos

  /**
   * Ramas plegadas, por id.
   *
   * Va a localStorage porque es preferencia de vista, no dato ni credencial: si
   * alguien la lee, se entera de que tenés una carpeta cerrada. Los tokens
   * siguen sin pisar localStorage — ver el encabezado de este archivo.
   */
  var PLEGADAS = (function () {
    try { return new Set(JSON.parse(localStorage.getItem('mifirma.plegadas') || '[]')); }
    catch (e) { return new Set(); }
  })();
  /** Si la lista incluye toda la rama. Preferencia de vista, igual que el pliegue. */
  // La vista activa. Cadena vacía = todos los estados.
  //
  // ⚠ Es un FILTRO, no una carpeta. El árbol sirve para archivar como quiera la
  // persona; el estado es un hecho del sistema y no puede mover documentos de
  // lugar. Si lo hiciera, borraría el archivado de quien lo guardó en
  // «Clientes/Acme» y ataría los permisos —que viven por carpeta— al avance del
  // proceso. Decidido con Claudio el 2/8/2026.
  var VISTAS = [
    { k: '',          n: 'Todos' },
    { k: 'borrador',  n: 'Borradores' },
    { k: 'en_curso',  n: 'Esperando firmas' },
    { k: 'completo',  n: 'Terminados' },
    { k: 'cerrado',   n: 'Cancelados o vencidos' },
  ];
  var VISTA = '';

  function pintarVistas() {
    var c = $('vistasDocs');
    if (!c) return;
    c.innerHTML = VISTAS.map(function (v) {
      return '<button data-v="' + v.k + '" aria-pressed="' + (v.k === VISTA) + '">' +
             esc(v.n) + '</button>';
    }).join('');
    c.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        VISTA = b.dataset.v || '';
        pintarVistas();
        cargarDocumentos();
      });
    });
  }

  var CON_SUB = (function () {
    try { return localStorage.getItem('mifirma.sub') === '1'; } catch (e) { return false; }
  })();

  function guardarPlegadas() {
    try { localStorage.setItem('mifirma.plegadas', JSON.stringify(Array.from(PLEGADAS))); }
    catch (e) { /* modo privado: se pierde al recargar y no pasa nada */ }
  }
  var ROLES = [];         // roles de la cuenta (para los selectores)
  var CATALOGO = null;    // catálogo de capacidades

  var VISTAS = ['documentos', 'carpetas', 'accesos', 'roles', 'mifirma', 'actividad', 'cuenta'];

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

    if (vista === 'documentos') { armarZonaDeSoltar(); cargarArbolDocs(); }
    if (vista === 'carpetas') cargarCarpetas();
    if (vista === 'accesos') cargarUsuarios();
    if (vista === 'roles') cargarRoles();
    if (vista === 'mifirma') cargarFirmaVisual();
    if (vista === 'actividad') cargarActividad();
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


  // ═══════════════════════════════════════════════════════════════════════════
  // Carpetas inteligentes
  //
  // Se ven como carpetas, están siempre a la vista, y recorren el repositorio
  // entero. Lo que NO hacen es mover documentos: el que archivaste en
  // «Clientes/Acme» sigue ahí cuando termina de firmarse, y además aparece acá.
  //
  // ⚠ Es la diferencia que importa. Una carpeta de verdad por estado obligaría a
  // sacar el documento de donde lo pusiste —una `ubicacion` es única por
  // (cuenta, documento)— y ataría los permisos, que viven por carpeta, al avance
  // del proceso: quien veía el borrador podría perder el terminado.
  //
  // Que sean seguras no lo garantiza este archivo: `ubicacion_select` exige
  // `app.puede_en_carpeta(carpeta_id,'ver')`, así que buscar sin carpeta
  // devuelve exactamente lo que esta persona puede ver. La base ya lo resuelve.
  // ═══════════════════════════════════════════════════════════════════════════
  var INTELIGENTES = [
    { k: 'en_curso', n: 'Esperando firmas', d: 'M12 8v4l3 2', c: 'circle' },
    { k: 'completo', n: 'Firmados',         d: 'M5 13l4 4L19 7', c: '' },
    { k: 'borrador', n: 'Borradores',       d: 'M4 20h4L19 9a2 2 0 00-3-3L5 17z', c: '' },
  ];

  function iconoInteligente(v) {
    return '<svg viewBox="0 0 24 24" style="width:16px;height:16px;flex:none;stroke:currentColor;' +
           'fill:none;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round">' +
           (v.c === 'circle' ? '<circle cx="12" cy="12" r="9"/>' : '') +
           '<path d="' + v.d + '"/></svg>';
  }

  /** La carpeta de sistema que se pida —papelera, entrada—, esté donde esté. */
  function buscarSistema(nodos, clave) {
    for (var i = 0; i < (nodos || []).length; i++) {
      if (nodos[i].sistema === clave) return nodos[i];
      var h = buscarSistema(nodos[i].hijos, clave);
      if (h) return h;
    }
    return null;
  }

  function montarInteligentes(contenedorId) {
    var cont = $(contenedorId);
    if (!cont) return;
    cont.innerHTML =
      INTELIGENTES.map(function (v) {
        var sel = !CARPETA && VISTA === v.k;
        return '<div class="nodo" role="treeitem" data-int="' + v.k + '" aria-selected="' + sel + '">' +
               '<span class="chev hueco"></span>' + iconoInteligente(v) +
               '<span class="nom">' + esc(v.n) + '</span></div>';
      }).join('') +
      '<div style="height:1px;background:var(--line);margin:8px 4px"></div>';

    cont.querySelectorAll('[data-int]').forEach(function (n) {
      n.addEventListener('click', function () { elegirInteligente(n.dataset.int); });
    });
  }

  function elegirInteligente(k) {
    CARPETA = null;
    VISTA = k;
    var nom = INTELIGENTES.filter(function (v) { return v.k === k; })[0];
    $('nomCarpetaDocs').textContent = nom ? nom.n : 'Documentos';
    $('subDocs').textContent = 'todo el repositorio';
    montarInteligentes('inteligentesDocs');
    montarArbol('arbolDocs', null, elegirCarpetaDocs, true);
    cargarDocumentos();
  }

  async function cargarArbolDocs() {
    try {
      if (!ARBOL.length) ARBOL = (await api('/carpetas')).carpetas || [];
      // Si la carpeta que estaba abierta sigue existiendo se respeta; si no, la
      // raíz. Volver a la raíz cada vez que se cambia de pantalla es la clase de
      // detalle que hace que la gente deje de usar las carpetas.
      montarInteligentes('inteligentesDocs');
      if (!CARPETA && VISTA) { elegirInteligente(VISTA); return; }
      var previa = CARPETA && buscarNodo(ARBOL, CARPETA.id);
      elegirCarpetaDocs(previa || ARBOL[0] || null);
    } catch (e) {
      msg('msgDocs', e.message, 'err');
    }
  }

  function elegirCarpetaDocs(nodo) {
    CARPETA = nodo;
    // Volver a una carpeta de verdad limpia el filtro: si no, elegir «Clientes»
    // después de «Esperando firmas» muestra una carpeta a medias sin decir por
    // qué faltan documentos.
    VISTA = '';
    montarInteligentes('inteligentesDocs');
    montarArbol('arbolDocs', nodo && nodo.id, elegirCarpetaDocs, true);
    $('nomCarpetaDocs').textContent = nodo ? nodo.nombre : 'Sin carpetas';
    $('subDocs').textContent = nodo && !nodo.sistema ? nodo.ruta : '';
    cargarDocumentos();
  }

  function cambiarAlcance() {
    CON_SUB = !!$('subcarpetas').checked;
    try { localStorage.setItem('mifirma.sub', CON_SUB ? '1' : '0'); } catch (e) {}
    cargarDocumentos();
  }
  window.cambiarAlcance = cambiarAlcance;

  async function cargarDocumentos() {
    var carpetaId = CARPETA && CARPETA.id;
    // Sin carpeta y sin vista no hay nada que pedir: es el estado de arranque
    // antes de que llegue el árbol.
    if (!carpetaId && !VISTA) return;
    if ($('subcarpetas')) $('subcarpetas').checked = CON_SUB;
    // En una carpeta inteligente el alcance ya es todo el repositorio: ofrecer
    // «incluir subcarpetas» ahí es ofrecer algo que ya está puesto.
    var cab = $('subcarpetas') && $('subcarpetas').closest('label');
    if (cab) cab.style.display = carpetaId ? '' : 'none';
    pintarVistas();
    msg('msgDocs', '', '');
    $('tDocumentos').innerHTML = '<tr><td colspan="5" class="vacio">Un momento…</td></tr>';
    try {
      var j = await api('/documentos?' +
        (carpetaId ? 'carpeta_id=' + encodeURIComponent(carpetaId) : '') +
        (carpetaId && CON_SUB ? '&sub=1' : '') +
        (VISTA ? '&vista=' + VISTA : ''));
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
      var vacio = !CARPETA
        ? { en_curso:  'No hay ningún documento esperando firmas.',
            completo:  'Todavía no terminó de firmarse ningún documento.',
            borrador:  'No tenés ningún borrador sin enviar.',
            cerrado:   'No hay documentos cancelados ni vencidos.' }[VISTA] ||
            'No hay documentos.'
        : VISTA
        ? 'No hay documentos en ese estado en esta carpeta.'
        : CON_SUB
        ? 'No hay documentos en esta carpeta ni en las que cuelgan de ella.'
        : 'No hay documentos en esta carpeta.';
      $('tDocumentos').innerHTML =
        '<tr><td colspan="5" class="vacio">' + vacio + '</td></tr>';
      return;
    }
    $('tDocumentos').innerHTML = docs
      .map(function (d) {
        // Con la rama incluida hay que decir DE DÓNDE es cada documento: una
        // lista donde no se sabe en qué carpeta está cada fila convierte "mover"
        // en una apuesta. El nombre sale del árbol que ya tenemos en memoria, no
        // de una columna más en la consulta.
        var otraCarpeta = '';
        if ((!CARPETA || CON_SUB) && d.carpeta_id && (!CARPETA || d.carpeta_id !== CARPETA.id)) {
          var nodo = buscarNodo(ARBOL, d.carpeta_id);
          if (nodo) otraCarpeta = ' · en ' + esc(nodo.nombre);
        }
        return (
          '<tr draggable="true" data-doc="' + esc(d.instancia_id) + '">' +
          '<td><b>' + esc(d.titulo) + '</b>' +
          // Lo que te mandaron a firmar no es lo mismo que lo que mandaste vos,
          // y en la misma lista hay que poder distinguirlo de un vistazo.
          (d.origen === 'recibido'
            ? ' <span class="pill esp" style="font-size:11px">Recibido</span>'
            : '') + '<br>' +
          '<span style="font-size:12.5px;color:var(--mut)">' + tamano(d.bytes) +
          (d.paginas ? ' · ' + d.paginas + ' págs' : '') + otraCarpeta + '</span></td>' +
          '<td>' + (ESTADO_DOC[d.circuito_estado] || esc(d.circuito_estado)) +
          // Un documento despachado cuyo aviso no salió se ve idéntico a uno
          // que sí salió. Sin este cartel, el emisor espera para siempre la
          // firma de alguien que nunca se enteró.
          (d.sin_avisar
            ? '<br><span class="pill no" style="background:#fef3f2;color:var(--danger);margin-top:5px;' +
              'display:inline-block">No le llegó el aviso a ' + d.sin_avisar + '</span>'
            : '') +
          (d.cadena_rota
            ? '<br><span class="pill no" style="background:#fef3f2;color:var(--danger);margin-top:5px;' +
              'display:inline-block">Expediente comprometido</span>'
            : '') + '</td>' +
          '<td>' + (d.firmas_total
            ? d.firmas_hechas + ' de ' + d.firmas_total
            : '<span style="color:var(--mut)">sin firmantes</span>') + '</td>' +
          '<td>' + esc(fecha(d.creado_en)) + '</td>' +
          '<td><div class="acc" style="justify-content:flex-end">' +
          // ⚠ Este botón NO envía: abre la preparación —firmantes, orden,
          // dónde va cada firma— y el envío es el botón del pie de ese modal.
          // Se llamaba «Enviar a firmar» y mandaba a buscar en «Ver» lo que
          // estaba acá. Una etiqueta que promete el último paso y da el primero
          // esconde todo lo que hay en el medio.
          (d.circuito_estado === 'borrador'
            ? '<button class="btn btn-p chico" data-prep="' + esc(d.circuito_id) + '">Preparar</button>'
            : '') +
          (d.circuito_estado === 'enviado'
            ? '<button class="btn ' + (d.sin_avisar ? 'btn-p' : 'btn-s') + ' chico" data-reenv="' +
              esc(d.circuito_id) + '">Reenviar aviso</button>' +
              // Cancelar es sólo del que emitió: al que lo recibió para firmar
              // no le corresponde cerrarle el documento a los demás.
              (d.origen !== 'recibido'
                ? '<button class="btn btn-s chico" data-cancelar="' + esc(d.circuito_id) +
                  '" data-tit="' + esc(d.titulo) + '">Cancelar</button>'
                : '')
            : '') +
          '<button class="btn btn-s chico" data-ver="' + esc(d.instancia_id) +
          '" data-tit="' + esc(d.titulo) + '">Ver</button>' +
          (d.circuito_estado === 'completo'
            ? '<button class="btn btn-s chico" data-firmas="' + esc(d.instancia_id) + '">Firmas</button>' +
              // Es el entregable: lo que se presenta si hay que probar algo.
              '<button class="btn btn-s chico" data-cert="' + esc(d.instancia_id) + '">Certificado</button>'
            : '') +
          '<button class="btn btn-s chico" data-exp="' + esc(d.instancia_id) + '">Expediente</button>' +
          '<button class="btn btn-s chico" data-mover="' + esc(d.instancia_id) +
          '" data-tit="' + esc(d.titulo) + '">Mover</button>' +
          // Borrar de verdad SÓLO el borrador que nunca salió. En cuanto
          // alguien recibió acceso deja de ser un borrador, y la base lo
          // rechaza aunque este botón se muestre por error.
          (d.circuito_estado === 'borrador' && d.origen !== 'recibido'
            ? '<button class="btn btn-d chico" data-borrar="' + esc(d.circuito_id) +
              '" data-tit="' + esc(d.titulo) + '">Eliminar</button>'
            : '<button class="btn btn-s chico" data-papelera="' + esc(d.instancia_id) +
              '" data-tit="' + esc(d.titulo) + '">A la papelera</button>') +
          '</div></td></tr>'
        );
      })
      .join('');

    $('tDocumentos').querySelectorAll('[data-cancelar]').forEach(function (b) {
      b.addEventListener('click', function () {
        abrirModal(
          '<h2>Cancelar «' + esc(b.dataset.tit) + '»</h2>' +
          // Decir exactamente qué pasa con lo ya firmado evita la pregunta que
          // sigue, que siempre es la misma: «¿se borra lo que ya firmaron?».
          '<p class="sub">Se les avisa a los firmantes que ya no tienen que firmarlo. ' +
          'Lo que alguien haya firmado antes <b>sigue firmado y sigue valiendo</b>: ' +
          'una firma aplicada no se deshace. El documento queda cerrado, no borrado.</p>' +
          '<label for="mMotivo">Por qué lo cancelás</label>' +
          '<textarea id="mMotivo" maxlength="500" ' +
          'placeholder="Se firmó una versión nueva del contrato"></textarea>' +
          '<p class="pista">Va al expediente y se lo mandamos a los firmantes.</p>' +
          '<div id="msgModal"></div>' +
          '<div class="acc"><button class="btn btn-s" id="mCancel">Volver</button>' +
          '<button class="btn btn-d" id="mOk">Cancelar el documento</button></div>'
        );
        $('mCancel').addEventListener('click', cerrarModal);
        $('mOk').addEventListener('click', async function () {
          var motivo = ($('mMotivo').value || '').trim();
          if (!motivo) return msg('msgModal', 'Contá por qué lo cancelás.', 'err');
          $('mOk').disabled = true;
          try {
            var r = await api('/circuitos/' + b.dataset.cancelar + '/cancelar', 'POST',
                              { motivo: motivo });
            cerrarModal();
            await cargarDocumentos();
            msg('msgDocs', 'Documento cancelado. Avisamos a ' + r.avisados + ' persona(s).', 'ok');
          } catch (e) {
            msg('msgModal', e.message, 'err');
            $('mOk').disabled = false;
          }
        });
      });
    });

    $('tDocumentos').querySelectorAll('[data-borrar]').forEach(function (b) {
      b.addEventListener('click', function () {
        abrirModal(
          '<h2>Eliminar «' + esc(b.dataset.tit) + '»</h2>' +
          '<p class="sub">Todavía no se lo mandaste a nadie, así que se borra de verdad: ' +
          'el archivo, el circuito y su expediente. No queda nada.</p>' +
          '<div id="msgModal"></div>' +
          '<div class="acc"><button class="btn btn-s" id="mCancel">Cancelar</button>' +
          '<button class="btn btn-d" id="mOk">Eliminar</button></div>'
        );
        $('mCancel').addEventListener('click', cerrarModal);
        $('mOk').addEventListener('click', async function () {
          $('mOk').disabled = true;
          try {
            await api('/circuitos/' + b.dataset.borrar, 'DELETE');
            cerrarModal();
            cargarDocumentos();
          } catch (e) { $('mOk').disabled = false; msg('msgModal', e.message, 'err'); }
        });
      });
    });

    $('tDocumentos').querySelectorAll('[data-papelera]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var pap = buscarSistema(ARBOL, 'papelera');
        if (!pap) return msg('msgDocs', 'Esta cuenta no tiene papelera.', 'err');
        b.disabled = true;
        try {
          await api('/documentos/' + b.dataset.papelera + '/carpeta', 'PATCH',
                    { carpeta_id: pap.id });
          cargarDocumentos();
        } catch (e) { b.disabled = false; msg('msgDocs', e.message, 'err'); }
      });
    });

    $('tDocumentos').querySelectorAll('[data-ver]').forEach(function (b) {
      b.addEventListener('click', function () { abrirVisor(b.dataset.ver, b.dataset.tit); });
    });
    $('tDocumentos').querySelectorAll('[data-prep]').forEach(function (b) {
      b.addEventListener('click', function () { abrirCircuito(b.dataset.prep); });
    });
    $('tDocumentos').querySelectorAll('[data-reenv]').forEach(function (b) {
      b.addEventListener('click', async function () {
        b.disabled = true;
        msg('msgDocs', '', '');
        try {
          var r = await api('/circuitos/' + b.dataset.reenv + '/reenviar', 'POST');
          await cargarDocumentos();
          if (r.fallidos && r.fallidos.length) {
            msg('msgDocs', 'Volvió a fallar: ' + r.fallidos[0].error, 'err');
          } else {
            msg('msgDocs', 'Aviso reenviado a ' + r.notificados + ' persona(s).', 'ok');
          }
        } catch (e) { msg('msgDocs', e.message, 'err'); b.disabled = false; }
      });
    });
    $('tDocumentos').querySelectorAll('[data-exp]').forEach(function (b) {
      b.addEventListener('click', function () { verExpediente(b.dataset.exp); });
    });
    $('tDocumentos').querySelectorAll('[data-cert]').forEach(function (b) {
      b.addEventListener('click', function () {
        window.open('/documentos/' + b.dataset.cert + '/certificado', '_blank');
      });
    });

    $('tDocumentos').querySelectorAll('[data-firmas]').forEach(function (b) {
      b.addEventListener('click', function () { verFirmas(b.dataset.firmas); });
    });
    $('tDocumentos').querySelectorAll('tr[data-doc]').forEach(function (tr) {
      tr.addEventListener('dragstart', function (ev) {
        // Tipo propio y no 'text/plain': así una carpeta sabe que lo que le
        // están soltando es un documento nuestro y no texto de otra ventana.
        ev.dataTransfer.setData('text/x-mifirma-doc', tr.dataset.doc);
        ev.dataTransfer.effectAllowed = 'move';
        tr.classList.add('arrastrando');
      });
      tr.addEventListener('dragend', function () { tr.classList.remove('arrastrando'); });
    });
    $('tDocumentos').querySelectorAll('[data-mover]').forEach(function (b) {
      b.addEventListener('click', function () {
        moverDocumento(b.dataset.mover, b.dataset.tit, CARPETA && CARPETA.id);
      });
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
        var data = await subirUno(f, CARPETA.id, $('mTitulo').value.trim());
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
   * Sube UN archivo. Devuelve la respuesta del servidor o tira el error.
   *
   * No toca la pantalla a propósito: la usan el formulario y el arrastre, y
   * cada uno informa distinto. Una función que sube y además pinta obliga a que
   * los dos caminos se vean igual, y no se ven igual.
   */
  async function subirUno(archivo, carpetaId, titulo) {
    var fd = new FormData();
    fd.append('carpeta_id', carpetaId);
    if (titulo) fd.append('titulo', titulo);
    // El archivo va ÚLTIMO a propósito: el servidor lee el stream del archivo y
    // recién después los campos de texto. Si el archivo fuera primero,
    // `carpeta_id` no estaría disponible al procesarlo.
    fd.append('archivo', archivo, archivo.name);

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
    return data;
  }

  function esPdf(f) {
    return f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');
  }

  /**
   * Sube varios archivos, uno por documento.
   *
   * ⚠ De a uno y en orden, no todos en paralelo. Diez PDF de veinte megas
   * saliendo juntos saturan la conexión, y el servidor tiene que sellar y
   * encadenar evidencia por cada uno. Además, en serie el contador de progreso
   * dice algo cierto.
   *
   * Que uno falle NO cancela el resto: si en diez contratos hay uno protegido
   * con contraseña, lo razonable es subir nueve y decir cuál falló, no perder
   * las diez subidas.
   */
  async function subirVarios(lista, carpetaId) {
    var archivos = Array.prototype.slice.call(lista);
    var noPdf = archivos.filter(function (f) { return !esPdf(f); });
    archivos = archivos.filter(esPdf);

    if (!archivos.length) {
      return msg('msgDocs', 'Por ahora sólo se aceptan PDF.', 'err');
    }

    var fallidos = [];
    var duplicados = 0;
    for (var i = 0; i < archivos.length; i++) {
      msg('msgDocs', 'Subiendo ' + (i + 1) + ' de ' + archivos.length + ': ' + archivos[i].name + '…', '');
      try {
        var d = await subirUno(archivos[i], carpetaId, '');
        if (d.duplicado) duplicados++;
      } catch (e) {
        fallidos.push(archivos[i].name + ': ' + e.message);
      }
    }
    await cargarDocumentos();

    var partes = [];
    var ok = archivos.length - fallidos.length;
    if (ok) partes.push(ok + (ok === 1 ? ' documento subido' : ' documentos subidos'));
    if (duplicados) partes.push(duplicados + ' ya estaba(n) y se reusó el contenido');
    if (noPdf.length) partes.push(noPdf.length + ' archivo(s) que no son PDF se ignoraron');
    if (fallidos.length) partes.push('falló: ' + fallidos.join(' · '));
    msg('msgDocs', partes.join('. ') + '.', fallidos.length ? 'err' : 'ok');
  }

  /**
   * La zona de soltar archivos.
   *
   * El contador existe porque `dragleave` se dispara al pasar de un hijo a otro
   * dentro de la misma zona. Sin contarlo, el resaltado parpadea mientras el
   * usuario mueve el archivo por encima de la tabla.
   */
  function armarZonaDeSoltar() {
    var z = $('zonaDocs');
    if (!z || z.dataset.armada) return;
    z.dataset.armada = '1';
    var dentro = 0;

    z.addEventListener('dragenter', function (ev) {
      if (ev.dataTransfer.types.indexOf('Files') < 0) return;
      ev.preventDefault();
      dentro++;
      z.classList.add('encima');
    });
    z.addEventListener('dragover', function (ev) {
      if (ev.dataTransfer.types.indexOf('Files') < 0) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
    });
    z.addEventListener('dragleave', function () {
      dentro = Math.max(0, dentro - 1);
      if (!dentro) z.classList.remove('encima');
    });
    z.addEventListener('drop', function (ev) {
      if (!ev.dataTransfer.files || !ev.dataTransfer.files.length) return;
      ev.preventDefault();
      dentro = 0;
      z.classList.remove('encima');
      if (!CARPETA) return msg('msgDocs', 'Elegí una carpeta antes de subir.', 'err');
      subirVarios(ev.dataTransfer.files, CARPETA.id);
    });

    // Fuera de la zona, soltar un PDF hace que el navegador lo abra y se pierda
    // la sesión de la pantalla. Se descarta en silencio.
    ['dragover', 'drop'].forEach(function (t) {
      window.addEventListener(t, function (ev) {
        if (ev.dataTransfer && ev.dataTransfer.types.indexOf('Files') >= 0 && !z.contains(ev.target)) {
          ev.preventDefault();
        }
      });
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
            (enviado
              ? (p.estado === 'firmada' || p.estado === 'rechazada'
                  ? ''
                  : '<button class="btn btn-s chico" data-enlace="' + esc(p.id) + '">Copiar enlace</button>')
              // Ubicar la firma es del EMISOR y sólo en borrador: después del
              // despacho no se mueve, porque el firmante ya vio dónde iba. Lo
              // decide `app.puede_definir_marcas`; acá sólo se oculta el botón.
              : (p.papel === 'firmante'
                  ? '<button class="btn btn-s chico" data-marcas="' + esc(p.id) + '" ' +
                    'data-inst="' + esc(p.instancia_id) + '" ' +
                    'data-quien="' + esc(p.nombre || p.email) + '">Ubicar firma</button> '
                  : '') +
                '<button class="btn btn-d chico" data-quitar="' + esc(p.id) + '">Quitar</button>') +
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
        : 'Agregá a quién tiene que firmar y en qué orden. Ninguno necesita tener cuenta en MiFirma. ' +
          'Si el que firma sos vos, agregate con tu correo.') +
      '</p>' +
      (enviado ? '' :
        '<p class="pista" style="margin:-10px 0 0">Con <b>Ubicar firma</b>, en la fila de cada uno, ' +
        'elegís en qué hoja y en qué lugar se estampa su firma y su rúbrica. Es opcional: si no ' +
        'ubicás nada, el documento se firma igual y sale sin ningún trazo dibujado.</p>') +

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

    // El enlace personal de firma. Se copia al portapapeles y se muestra, porque
    // en algunos navegadores el portapapeles falla en silencio y quedarse sin el
    // enlace después de que el sistema dijo "copiado" es peor que no ofrecerlo.
    $('modal').querySelectorAll('[data-enlace]').forEach(function (b) {
      b.addEventListener('click', async function () {
        b.disabled = true;
        try {
          var r = await api('/circuitos/' + circuitoId + '/firmantes/' + b.dataset.enlace + '/enlace', 'POST');
          try { await navigator.clipboard.writeText(r.url); } catch (e) { /* se muestra igual */ }
          abrirModal(
            '<h2>Enlace de firma</h2>' +
            '<p class="sub">Es el enlace personal de <b>' + esc(r.nombre || r.email) + '</b>. ' +
            'Mandáselo por donde quieras.</p>' +
            '<input id="mUrl" readonly value="' + esc(r.url) + '" style="font-size:12.5px" />' +
            '<div class="msg err" style="margin-top:14px">Quien tenga este enlace puede firmar en ' +
            'nombre de esa persona. Que lo hayas copiado quedó anotado en el expediente del documento.</div>' +
            '<div class="acc"><button class="btn btn-p" id="mCancel">Listo</button></div>'
          );
          $('mUrl').select();
          $('mCancel').addEventListener('click', function () { cerrarModal(); cargarDocumentos(); });
        } catch (e) { msg('msgModal', e.message, 'err'); b.disabled = false; }
      });
    });

    $('modal').querySelectorAll('[data-quitar]').forEach(function (b) {
      b.addEventListener('click', async function () {
        try {
          await api('/circuitos/' + circuitoId + '/firmantes/' + b.dataset.quitar, 'DELETE');
          abrirCircuito(circuitoId);
        } catch (e) { msg('msgModal', e.message, 'err'); }
      });
    });

    // El editor visual vive en marcas.js: trae pdf.js y no tiene por qué
    // cargarse en cada visita a la consola.
    $('modal').querySelectorAll('[data-marcas]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!window.abrirEditorMarcas) {
          return msg('msgModal', 'No pude cargar el editor de firmas. Recargá la página.', 'err');
        }
        window.abrirEditorMarcas(b.dataset.inst, {
          id: b.dataset.marcas,
          nombre: b.dataset.quien,
          circuitoId: circuitoId,
        });
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
        } else if ($('mModo') && $('mModo').value === 'serie' && parts.length > r.notificados) {
          // En serie se avisa de a uno: decirlo evita que parezca que faltaron
          // avisos. El resto recibe el suyo cuando le toque.
          msg('msgDocs',
            'Enviado. Le avisamos a ' + r.notificados + '; a los demás les llega cuando les toque firmar.',
            'ok');
        } else {
          msg('msgDocs', 'Enviado. Le avisamos a ' + r.notificados + ' persona(s).', 'ok');
        }
      } catch (e) { msg('msgModal', e.message, 'err'); $('mEnviar').disabled = false; }
    });
  }

  /**
   * Mover el documento a otra carpeta.
   *
   * El selector lista el mismo árbol que el de la pantalla, sangrado igual: la
   * jerarquía tiene que verse, porque "Contratos" y "Contratos" pueden ser dos
   * carpetas distintas colgando de ramas distintas.
   */
  async function moverDocumento(instanciaId, titulo, carpetaActual) {
    if (!ARBOL.length) {
      try { ARBOL = (await api('/carpetas')).carpetas || []; } catch (e) {}
    }
    var lista = aplanar(ARBOL, [], 0);
    var opts = lista.map(function (c) {
      return '<option value="' + esc(c.id) + '"' + (c.id === carpetaActual ? ' selected' : '') + '>' +
        esc(c.nombre) + '</option>';
    }).join('');

    abrirModal(
      '<h2>Mover documento</h2>' +
      '<p class="sub">' + esc(titulo) + '</p>' +
      '<label>Carpeta de destino</label>' +
      '<select id="mCarpeta">' + opts + '</select>' +
      '<div class="msg" style="background:var(--soft);color:var(--mut);border:1px solid var(--line)">' +
      'Mover cambia dónde lo ves vos. No toca el documento, ni sus firmas, ni el enlace ' +
      'que ya recibieron los firmantes.</div>' +
      '<div id="mErr"></div>' +
      '<div class="acc"><button class="btn" id="mCancel">Cancelar</button>' +
      '<button class="btn btn-p" id="mOk">Mover</button></div>'
    );
    $('mCancel').addEventListener('click', cerrarModal);
    $('mOk').addEventListener('click', async function () {
      var destino = $('mCarpeta').value;
      $('mOk').disabled = true;
      try {
        await api('/documentos/' + instanciaId + '/carpeta', 'PATCH', { carpeta_id: destino });
        cerrarModal();
        cargarDocumentos();
      } catch (e) {
        $('mOk').disabled = false;
        $('mErr').innerHTML = '<div class="msg err">' + esc(e.message) + '</div>';
      }
    });
  }
  window.moverDocumento = moverDocumento;

  /**
   * Las firmas criptográficas del PDF.
   *
   * Es distinto del expediente, y la diferencia importa: el expediente cuenta lo
   * que pasó según nosotros; esto comprueba el documento en sí. Un tercero con
   * el PDF en la mano, sin acceso a nada nuestro, puede llegar al mismo
   * resultado — y eso es lo que hace que la firma valga.
   */
  function selloFecha(iso) {
    if (!iso) return 'sin fecha legible';
    try { return new Date(iso).toLocaleString('es'); } catch (e) { return iso; }
  }

  async function verFirmas(instanciaId) {
    abrirModal('<h2>Firmas del documento</h2><p class="sub">Verificando…</p>');
    try {
      var j = await api('/documentos/' + instanciaId + '/firmas');
      // Dos fallas distintas, dos mensajes distintos. Que una firma no verifique
      // y que sobren bytes al final son problemas diferentes, y el que lee esto
      // necesita saber cuál de los dos tiene.
      var rotas = j.firmas.filter(function (f) { return !f.verifica; }).length;
      var estado;
      if (!j.firmas.length) {
        // ⚠ Caso propio, y no un subcaso de "algo anda mal". Sin firmas no hay
        // nada que verificar, y el mensaje de los bytes sin cubrir imprimía
        // `null` porque ese número no significa nada cuando no verifica ninguna
        // firma. Dos situaciones distintas no comparten mensaje.
        estado = '<div class="msg err">Este PDF no tiene ninguna firma criptográfica.' +
          (j.origen === 'base'
            ? ' El circuito figura como firmado, pero lo que quedó guardado es el archivo ' +
              'original sin sellar: se firmó antes de que existiera el sellado PAdES. ' +
              'El expediente de ese documento sigue siendo válido; el PDF no prueba nada por sí solo.'
            : '') + '</div>';
      } else if (j.integro) {
        estado = '<div class="msg ok">' + j.firmas.length + ' firma(s) válida(s). ' +
          'El archivo es exactamente lo que se firmó.</div>';
      } else if (rotas) {
        estado = '<div class="msg err">' + rotas + ' de ' + j.firmas.length +
          ' firma(s) no verifican: el archivo cambió después de firmarse. ' +
          'No lo uses como prueba.</div>';
      } else {
        estado = '<div class="msg err">Quedan ' + j.bytes_sin_firmar +
          ' byte(s) al final del archivo que ninguna firma cubre. ' +
          'Alguien le agregó algo después de la última firma.</div>';
      }

      // ⚠ Que una firma no llegue al final del archivo NO es un problema: cada
      // firma se agrega escribiendo bytes al final, así que la primera nunca
      // puede cubrir a las que vinieron después. Decía "no cubre hasta el final"
      // y se leía como "te modificaron el documento", que es falso y asusta.
      // ⚠ Lo que cambió ENTRE firma y firma. Va arriba de las firmas y no al
      // final: si alguien tocó el documento después de que otro lo firmó, es lo
      // primero que hay que leer, no una nota al pie.
      //
      // Y va SEPARADO del veredicto de arriba a propósito: un documento
      // adulterado entre dos firmas da «íntegro» igual —las firmas no se
      // tocaron y no sobran bytes—, así que si esto se mezclara con aquello,
      // una de las dos preguntas taparía a la otra.
      var cambios = '';
      if (j.contenido_alterado_entre_firmas) {
        cambios += '<div class="msg err" style="margin-top:12px"><b>⚠ Alguien cambió lo que ' +
          'muestra el documento después de que alguien lo firmó.</b><br>' +
          'Las firmas verifican igual —no se tocaron sus bytes— pero la hoja que vio el ' +
          'primer firmante ya no dice lo mismo. No lo uses como prueba sin mirar el detalle.</div>';
      }
      if ((j.cambios || []).length) {
        cambios += '<div style="margin-top:14px">' +
          '<div style="font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;' +
          'color:var(--mut);font-weight:700">Qué pasó entre firma y firma</div>' +
          j.cambios.map(function (c) {
            return '<div style="font-size:12.5px;margin-top:6px;padding-left:10px;' +
              'border-left:2px solid ' + (c.contenidoAlterado ? 'var(--danger)' : 'var(--line)') + '">' +
              '<b>Después de la firma ' + c.despuesDeFirma + ':</b> ' + esc(c.relato) + '</div>';
          }).join('') + '</div>';
      }

      var alcances = {
        final: ['', 'Cubre el archivo completo'],
        firma_posterior: ['', 'Cubre hasta el byte %B; lo que sigue son las firmas posteriores'],
        sin_explicar: ['color:var(--mal,#c0392b);font-weight:600',
                       'Después de esta firma hay bytes que ninguna firma cubre']
      };
      var filas = j.firmas.map(function (f) {
        var cuando = '';
        if (f.firmada_en) { try { cuando = new Date(f.firmada_en).toLocaleString('es'); } catch (e) {} }
        var al = alcances[f.alcance] || ['', ''];
        var quien = f.nombre_declarado || f.motivo || ('Firma ' + f.numero);
        return '<div style="padding:12px 0;border-bottom:1px solid var(--line)">' +
          '<b style="font-size:14px">' + (f.verifica ? '✓ ' : '✗ ') + esc(quien) + '</b>' +
          (f.motivo && f.nombre_declarado ? '<div style="font-size:12.5px;color:var(--mut);margin-top:3px">' + esc(f.motivo) + '</div>' : '') +
          '<div style="font-size:12.5px;color:var(--mut);margin-top:3px">' +
          'Certificado: ' + esc(f.firmante || '—') +
          (f.emisor ? ' · emitido por ' + esc(f.emisor) : '') + '</div>' +
          (cuando ? '<div style="font-size:12.5px;color:var(--mut)">' + esc(cuando) + '</div>' : '') +
          // El sello de tiempo se muestra distinto del resto a propósito: es lo
          // único de esta pantalla que afirma un TERCERO. Todo lo demás lo
          // decimos nosotros, y esa diferencia es la que le da valor.
          (f.sello
            ? '<div style="font-size:12.5px;color:var(--acc-700);font-weight:600;margin-top:3px">' +
              '⏱ Hora certificada por una autoridad externa: ' +
              esc(selloFecha(f.sello.sellado_en)) + '</div>' +
              '<div style="font-size:11px;color:var(--mut)">serie ' +
              esc((f.sello.numero_serie || '').slice(0, 24)) + ' · política ' +
              esc(f.sello.politica) + '</div>'
            : '<div style="font-size:12px;color:var(--mut);margin-top:3px">' +
              'Sin sello de tiempo: la fecha de esta firma la afirmamos nosotros, ' +
              'no un tercero.</div>') +
          '<div style="font-size:12px;color:var(--mut);' + al[0] + '">' +
          esc(al[1].replace('%B', f.cubre_hasta)) + ' · ' + f.bytes_cubiertos + ' bytes firmados</div>' +
          '</div>';
      }).join('');

      abrirModal(
        '<h2>Firmas del documento</h2>' +
        '<p class="sub">Se comprueba el PDF en sí, no nuestra base de datos: por cada firma ' +
        'se recalcula el resumen de los bytes que dice cubrir.</p>' +
        estado +
        cambios +
        '<div style="max-height:50vh;overflow:auto;margin-top:12px">' + filas + '</div>' +
        '<div class="msg" style="background:var(--soft);color:var(--mut);border:1px solid var(--line)">' +
        'El certificado de sello es de desarrollo y está autofirmado: prueba que el documento ' +
        'no cambió, no la identidad de quien firmó.</div>' +
        '<div class="acc"><button class="btn btn-p" id="mCancel">Cerrar</button></div>'
      );
      $('mCancel').addEventListener('click', cerrarModal);
    } catch (e) {
      abrirModal('<h2>Firmas</h2><div class="msg err">' + esc(e.message) + '</div>' +
        '<div class="acc"><button class="btn btn-p" id="mCancel">Cerrar</button></div>');
      $('mCancel').addEventListener('click', cerrarModal);
    }
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
  // MI FIRMA — la representación visual
  //
  // ⚠ Esto NO es la firma. El valor legal lo da el PAdES; esto es una imagen.
  // La pantalla lo dice en voz alta a propósito: si el producto deja creer que
  // el trazo es lo que vale, el día que alguien lo discuta la respuesta llega
  // tarde. Regla de oro nº1.
  //
  // Todo el procesamiento de imagen ocurre ACÁ, en el navegador. No es una
  // optimización: una foto de una firma sobre un escritorio trae el escritorio,
  // y lo que no se sube no hay que custodiarlo después.
  // ===========================================================================

  async function cargarFirmaVisual() {
    msg('msgFirmaVisual', '', '');
    try {
      var j = await api('/mi/firma-visual');
      var hay = {};
      (j.imagenes || []).forEach(function (i) { hay[i.tipo] = i; });
      pintarLienzo('visorFirma', 'firma', hay.firma);
      pintarLienzo('visorRubrica', 'rubrica', hay.rubrica);
    } catch (e) {
      msg('msgFirmaVisual', e.message, 'err');
    }
  }

  function pintarLienzo(id, tipo, info) {
    var el = $(id);
    if (!el) return;
    if (!info) {
      el.innerHTML = '<span class="vacio">Todavía no cargaste ' +
        (tipo === 'firma' ? 'tu firma' : 'tu inicial') + '</span>';
      return;
    }
    // `?t=` obliga al navegador a no reusar la anterior después de cambiarla.
    el.innerHTML = '<img alt="" src="/mi/firma-visual/' + tipo + '?t=' + Date.now() + '" />';
  }

  /**
   * Deja la imagen lista para estampar: sin fondo y recortada al trazo.
   *
   * Dos pasos, y los dos importan:
   *
   * 1. Transparencia por luminancia. Todo lo que es claro —el papel— pasa a
   *    alpha 0. No es un recorte perfecto, es el que hace falta: el trazo de
   *    una lapicera sobre papel blanco tiene muchísimo contraste.
   * 2. Recorte al rectángulo que ocupa el trazo. Sin esto, una foto con la
   *    firma chiquita en el medio se estampa como un sello enorme casi vacío,
   *    y el usuario no entiende por qué le quedó torcida en el documento.
   */
  function limpiarImagen(img) {
    var c = document.createElement('canvas');
    // Tope de resolución: más que esto no mejora nada estampado y pesa de más.
    var esc = Math.min(1, 1400 / Math.max(img.width, img.height));
    c.width = Math.round(img.width * esc);
    c.height = Math.round(img.height * esc);
    var g = c.getContext('2d');
    g.drawImage(img, 0, 0, c.width, c.height);

    var d = g.getImageData(0, 0, c.width, c.height);
    var p = d.data;
    var x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;

    for (var i = 0; i < p.length; i += 4) {
      var lum = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
      if (lum > 205) {
        p[i + 3] = 0;                       // papel: fuera
      } else {
        // Semitransparencia en el borde del trazo, para que no quede aserrado.
        if (lum > 150) p[i + 3] = Math.round(p[i + 3] * (205 - lum) / 55);
        if (p[i + 3] > 8) {
          var px = (i / 4) % c.width, py = Math.floor((i / 4) / c.width);
          if (px < x0) x0 = px; if (px > x1) x1 = px;
          if (py < y0) y0 = py; if (py > y1) y1 = py;
        }
      }
    }
    g.putImageData(d, 0, 0);

    if (x1 < 0) return null;                 // no quedó ningún trazo
    var m = 6;                               // un respiro alrededor
    x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m);
    x1 = Math.min(c.width - 1, x1 + m); y1 = Math.min(c.height - 1, y1 + m);

    var r = document.createElement('canvas');
    r.width = x1 - x0 + 1; r.height = y1 - y0 + 1;
    r.getContext('2d').drawImage(c, x0, y0, r.width, r.height, 0, 0, r.width, r.height);
    return r;
  }

  function canvasABlob(canvas) {
    return new Promise(function (res) { canvas.toBlob(res, 'image/png'); });
  }

  async function mandarImagen(tipo, blob, origen) {
    var fd = new FormData();
    fd.append('origen', origen);
    fd.append('archivo', blob, tipo + '.png');
    var t = csrf();
    var r = await fetch('/mi/firma-visual/' + tipo, {
      method: 'POST',
      credentials: 'same-origin',
      headers: t ? { 'X-CSRF-Token': t } : {},
      body: fd,
    });
    var txt = await r.text();
    var data; try { data = txt ? JSON.parse(txt) : {}; } catch (e) { data = { error: txt }; }
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    return data;
  }

  async function subirFirmaVisual(tipo, input) {
    var f = input.files && input.files[0];
    input.value = '';
    if (!f) return;
    msg('msgFirmaVisual', 'Procesando la imagen…', '');
    try {
      var img = await new Promise(function (res, rej) {
        var i = new Image();
        i.onload = function () { res(i); };
        i.onerror = function () { rej(new Error('No pude leer esa imagen.')); };
        i.src = URL.createObjectURL(f);
      });
      var limpio = limpiarImagen(img);
      URL.revokeObjectURL(img.src);
      if (!limpio) {
        return msg('msgFirmaVisual',
          'No encontré ningún trazo en esa imagen: quedó toda clara. Probá con una ' +
          'foto con más contraste, o dibujá la firma acá mismo.', 'err');
      }
      await mandarImagen(tipo, await canvasABlob(limpio), 'subida');
      await cargarFirmaVisual();
      msg('msgFirmaVisual', 'Listo. Se le sacó el fondo y se recortó al trazo.', 'ok');
    } catch (e) {
      msg('msgFirmaVisual', e.message, 'err');
    }
  }

  /**
   * El pad para dibujarla con el dedo o el mouse.
   *
   * Vale más que la foto y conviene ofrecerlo primero: sale con fondo
   * transparente de fábrica, sin umbrales ni recortes que puedan salir mal. Y
   * en el expediente queda anotado que se dibujó en el momento, que no es lo
   * mismo que una imagen subida hace dos años y que cualquiera pudo mandarle.
   */
  function dibujarFirmaVisual(tipo) {
    abrirModal(
      '<h2>Dibujá tu ' + (tipo === 'firma' ? 'firma' : 'inicial') + '</h2>' +
      '<p class="sub">Con el dedo, el mouse o un lápiz. Se guarda sin fondo.</p>' +
      '<canvas id="padDibujo" width="900" height="300" style="height:220px"></canvas>' +
      '<div id="mErr"></div>' +
      '<div class="acc"><button class="btn btn-s" id="mLimpiar">Borrar</button>' +
      '<button class="btn" id="mCancel">Cancelar</button>' +
      '<button class="btn btn-p" id="mOk">Guardar</button></div>'
    );

    var cv = $('padDibujo');
    var g = cv.getContext('2d');
    g.lineWidth = 3.5; g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#111827';
    var trazando = false, hubo = false;

    function punto(ev) {
      var r = cv.getBoundingClientRect();
      return { x: (ev.clientX - r.left) * (cv.width / r.width),
               y: (ev.clientY - r.top) * (cv.height / r.height) };
    }
    cv.addEventListener('pointerdown', function (ev) {
      // Captura del puntero: si el dedo se va del canvas y vuelve, sigue el
      // mismo trazo en vez de cortarse. Firmar es un gesto continuo.
      cv.setPointerCapture(ev.pointerId);
      trazando = true; hubo = true;
      var p = punto(ev); g.beginPath(); g.moveTo(p.x, p.y);
    });
    cv.addEventListener('pointermove', function (ev) {
      if (!trazando) return;
      var p = punto(ev); g.lineTo(p.x, p.y); g.stroke();
    });
    ['pointerup', 'pointercancel'].forEach(function (t) {
      cv.addEventListener(t, function () { trazando = false; });
    });

    $('mLimpiar').addEventListener('click', function () {
      g.clearRect(0, 0, cv.width, cv.height); hubo = false;
    });
    $('mCancel').addEventListener('click', cerrarModal);
    $('mOk').addEventListener('click', async function () {
      if (!hubo) {
        return ($('mErr').innerHTML = '<div class="msg err">Todavía no dibujaste nada.</div>');
      }
      $('mOk').disabled = true;
      try {
        // El canvas ya viene transparente; sólo se recorta al trazo.
        var limpio = limpiarImagen(cv) || cv;
        await mandarImagen(tipo, await canvasABlob(limpio), 'dibujada');
        cerrarModal();
        await cargarFirmaVisual();
        msg('msgFirmaVisual', 'Guardada.', 'ok');
      } catch (e) {
        $('mOk').disabled = false;
        $('mErr').innerHTML = '<div class="msg err">' + esc(e.message) + '</div>';
      }
    });
  }

  async function quitarFirmaVisual(tipo) {
    try {
      await api('/mi/firma-visual/' + tipo, 'DELETE');
      await cargarFirmaVisual();
      // Se dice qué pasó de verdad: la imagen deja de usarse, no desaparece.
      // Los documentos que ya la llevan estampada siguen mostrándola, y el
      // expediente tiene que poder explicar cuál se usó en cada uno.
      msg('msgFirmaVisual',
        'Ya no se va a estampar. Los documentos que ya firmaste no cambian.', 'ok');
    } catch (e) {
      msg('msgFirmaVisual', e.message, 'err');
    }
  }

  window.subirFirmaVisual = subirFirmaVisual;
  window.dibujarFirmaVisual = dibujarFirmaVisual;
  window.quitarFirmaVisual = quitarFirmaVisual;

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
  var ICONO_CHEVRON = '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';

  /**
   * El árbol de carpetas. UN renderizador para las dos pantallas.
   *
   * Documentos y Carpetas muestran el mismo árbol con distinto propósito —una
   * navega, la otra administra permisos— pero si fueran dos funciones, el día
   * que se arregle un detalle en una, la otra queda distinta. Lo que cambia es
   * qué se hace al elegir un nodo y si acepta que le suelten cosas encima.
   *
   * El pliegue se guarda por id y no por posición: renombrar una carpeta o
   * mover una rama no tiene que reordenar lo que el usuario dejó cerrado.
   */
  function arbolHTML(nodos, selId, nivel) {
    var h = '';
    nodos.forEach(function (n) {
      var hijos = n.hijos || [];
      var plegada = PLEGADAS.has(n.id);
      h +=
        '<div class="rama">' +
        '<div class="nodo" data-id="' + esc(n.id) + '" role="treeitem"' +
        ' aria-selected="' + (n.id === selId) + '"' +
        ' style="padding-left:' + (8 + nivel * 15) + 'px">' +
        (hijos.length
          ? '<button type="button" class="chev' + (plegada ? ' plegada' : '') + '"' +
            ' data-plegar="' + esc(n.id) + '" aria-expanded="' + (!plegada) + '"' +
            ' aria-label="Plegar o desplegar ' + esc(n.nombre) + '">' + ICONO_CHEVRON + '</button>'
          : '<span class="chev hueco"></span>') +
        ICONO_CARPETA +
        '<span class="nom">' + esc(n.nombre) + '</span>' +
        (n.sistema ? '<span class="sis">del sistema</span>' : '') +
        '</div>' +
        (hijos.length
          ? '<div class="hijos"' + (plegada ? ' hidden' : '') + '>' +
            arbolHTML(hijos, selId, nivel + 1) + '</div>'
          : '') +
        '</div>';
    });
    return h;
  }

  /**
   * Los ancestros de un nodo, de la raíz hacia abajo.
   *
   * Hace falta para no dejar seleccionada una carpeta escondida: si el usuario
   * plegó "Contratos" y la carpeta abierta es "Contratos/2026", el árbol tiene
   * que abrirse solo hasta ahí. Un elemento seleccionado que no se ve es peor
   * que ninguno — la pantalla dice una cosa y muestra otra.
   */
  function ancestros(nodos, id, camino) {
    for (var i = 0; i < nodos.length; i++) {
      if (nodos[i].id === id) return camino;
      var h = ancestros(nodos[i].hijos || [], id, camino.concat([nodos[i].id]));
      if (h) return h;
    }
    return null;
  }

  function montarArbol(contenedorId, selId, alElegir, conDrop) {
    var cont = $(contenedorId);
    if (!cont) return;
    cont.setAttribute('role', 'tree');

    if (selId) {
      var camino = ancestros(ARBOL, selId, []) || [];
      var cambio = false;
      camino.forEach(function (id) { if (PLEGADAS.delete(id)) cambio = true; });
      if (cambio) guardarPlegadas();
    }

    cont.innerHTML = ARBOL.length
      ? arbolHTML(ARBOL, selId, 0)
      : '<div class="vacio">No hay carpetas visibles para vos.</div>';

    cont.querySelectorAll('[data-plegar]').forEach(function (b) {
      b.addEventListener('click', function (ev) {
        // Sin esto, plegar también selecciona la carpeta: el clic sube al nodo.
        ev.stopPropagation();
        var id = b.dataset.plegar;
        var rama = b.closest('.rama');
        var hijos = rama && rama.querySelector(':scope > .hijos');
        var plegada = !PLEGADAS.has(id);
        if (plegada) PLEGADAS.add(id); else PLEGADAS.delete(id);
        guardarPlegadas();
        b.classList.toggle('plegada', plegada);
        b.setAttribute('aria-expanded', String(!plegada));
        if (hijos) hijos.hidden = plegada;
      });
    });

    cont.querySelectorAll('.nodo').forEach(function (d) {
      d.addEventListener('click', function () { alElegir(buscarNodo(ARBOL, d.dataset.id)); });
      if (!conDrop) return;

      // Dos cosas se pueden soltar sobre una carpeta: una fila de la lista
      // (mover) o archivos del escritorio (subir ahí directamente). Se
      // distinguen por lo que trae el dataTransfer, no por un modo previo.
      d.addEventListener('dragover', function (ev) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = ev.dataTransfer.types.indexOf('Files') >= 0 ? 'copy' : 'move';
        d.classList.add('destino');
      });
      d.addEventListener('dragleave', function () { d.classList.remove('destino'); });
      d.addEventListener('drop', async function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        d.classList.remove('destino');
        var destino = d.dataset.id;

        if (ev.dataTransfer.files && ev.dataTransfer.files.length) {
          return subirVarios(ev.dataTransfer.files, destino);
        }
        var doc = ev.dataTransfer.getData('text/x-mifirma-doc');
        if (!doc) return;
        if (CARPETA && destino === CARPETA.id) return;   // ya está ahí
        try {
          await api('/documentos/' + doc + '/carpeta', 'PATCH', { carpeta_id: destino });
          await cargarDocumentos();
          msg('msgDocs', 'Documento movido.', 'ok');
        } catch (e) {
          // El permiso lo decide la base, no esta pantalla: acá sólo se cuenta
          // lo que dijo. Adivinar antes de preguntar sería tener la regla en
          // dos lugares, y uno de los dos siempre queda viejo.
          msg('msgDocs', e.message, 'err');
        }
      });
    });
  }

  function pintarArbol() {
    montarArbol('arbol', SEL && SEL.id, seleccionar, false);
  }

  function seleccionar(nodo) {
    SEL = nodo;
    montarArbol('arbol', nodo && nodo.id, seleccionar, false);
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
  // ACTIVIDAD
  //
  // La bitácora de la cuenta. Distinta del expediente: acá va lo administrativo
  // —se dio un acceso, se cambió un permiso, salió o falló un correo— y se
  // purga por retención. El expediente es del documento, es inmutable y se
  // guarda por el plazo legal.
  // ===========================================================================
  var ACCION_TEXTO = {
    'correo.enviado': 'Salió un correo',
    'correo.fallido': 'Un correo NO se pudo enviar',
    'cuenta.creada': 'Se creó la cuenta',
    'acceso.dado': 'Se le dio acceso a alguien',
    'acceso.quitado': 'Se le quitó el acceso a alguien',
    'rol.creado': 'Se creó un rol',
    'rol.borrado': 'Se borró un rol',
    'rol.renombrado': 'Se renombró un rol',
    'rol.capacidad_agregada': 'Se le agregó una capacidad a un rol',
    'rol.capacidad_quitada': 'Se le quitó una capacidad a un rol',
    'carpeta.creada': 'Se creó una carpeta',
    'carpeta.borrada': 'Se borró una carpeta',
    'carpeta.renombrada': 'Se renombró una carpeta',
    'carpeta.permisos': 'Se cambiaron permisos de una carpeta',
  };

  function detalle(e) {
    var d = e.despues || e.antes || {};
    if (e.accion === 'correo.fallido') return esc(d.destino || '') + ' — ' + esc(d.error || 'sin detalle');
    if (e.accion === 'correo.enviado') return esc(d.destino || '');
    var partes = [];
    ['nombre', 'codigo', 'email', 'estado', 'ruta', 'rol_id'].forEach(function (k) {
      if (d[k]) partes.push(k + ': ' + d[k]);
    });
    return esc(partes.join(' · '));
  }

  async function cargarActividad() {
    $('tActividad').innerHTML = '<tr><td colspan="4" class="vacio">Un momento…</td></tr>';
    try {
      var f = ($('filtroActividad') || {}).value || '';
      var j = await api('/bitacora?limit=200' + (f ? '&accion=' + encodeURIComponent(f) : ''));
      var ev = j.eventos || [];
      if (!ev.length) {
        $('tActividad').innerHTML = '<tr><td colspan="4" class="vacio">Todavía no hay actividad registrada.</td></tr>';
        return;
      }
      $('tActividad').innerHTML = ev.map(function (e) {
        var cuando = '';
        try { cuando = new Date(e.ocurrido_en).toLocaleString('es'); } catch (x) {}
        var fallo = e.accion === 'correo.fallido';
        return '<tr' + (fallo ? ' style="background:#fef3f2"' : '') + '>' +
          '<td style="white-space:nowrap;font-size:13px;color:var(--mut)">' + esc(cuando) + '</td>' +
          '<td><b>' + esc(ACCION_TEXTO[e.accion] || e.accion) + '</b></td>' +
          '<td>' + esc(e.usuario_nombre || e.usuario_email ||
            (e.actor_tipo === 'sistema' ? 'El sistema' : '—')) + '</td>' +
          '<td style="font-size:13px;color:var(--mut)">' + detalle(e) + '</td></tr>';
      }).join('');
      msg('msgActividad', '', '');
    } catch (e) {
      $('tActividad').innerHTML = '<tr><td colspan="4" class="vacio">' + esc(e.message) + '</td></tr>';
    }
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

  // Lo que necesitan las pantallas que viven en otro archivo (marcas.js). Es un
  // objeto y no cinco globales sueltas para que se vea de un vistazo cuál es la
  // superficie compartida. `api` sobre todo NO se copia: sabe del CSRF y del
  // 401, y dos versiones de esa decisión son una que se olvida de actualizar.
  window.uiMiFirma = {
    $: $, esc: esc, api: api, msg: msg,
    abrirModal: abrirModal, cerrarModal: cerrarModal,
  };

  arrancar();
})();
