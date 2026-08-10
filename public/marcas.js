/* ===========================================================================
   Editor de marcas: dónde se estampa la firma y la rúbrica de cada firmante.

   ⚠ Una marca NO es una firma. Es una imagen ubicada; el valor legal lo da el
   PAdES. Un documento sin marcas está firmado igual. Ver
   claude/representacion-visual.md.

   ═══ POR QUÉ pdf.js Y NO UN <iframe> ═══

   Un iframe muestra el PDF pero no dice NADA sobre él: no se sabe dónde
   empieza cada página, ni a qué escala se está viendo, ni cómo convertir un
   punto de la pantalla a un punto del documento. Y esa conversión es todo el
   problema: la base guarda puntos PDF con origen abajo a la izquierda, y el
   navegador trabaja en píxeles con origen arriba a la izquierda.

   pdf.js da el `viewport` de cada página, que sabe hacer esa conversión
   —incluida la rotación, que existe y rompe cualquier cuenta hecha a mano—.
   Se sirve desde nuestro dominio: el CSP es `script-src 'self'` y eso es a
   propósito.

   ═══ POR QUÉ LAS HOJAS SE DIBUJAN DE A UNA, CUANDO SE VEN ═══

   El caso que motivó esta pantalla es el contrato largo: rubricar 200 hojas.
   Dibujar 200 canvas de una vez son ~1,6 GB de píxeles y una pestaña colgada.
   Se miden todas las páginas al abrir —hace falta para convertir coordenadas
   en cualquier hoja, aunque no se esté mirando— pero sólo se dibuja la que
   entra en pantalla.
   =========================================================================== */
(function () {
  'use strict';

  // Las funciones de la consola. Se toman en el momento de usarlas y no al
  // cargar el archivo: así no importa en qué orden entren los <script>, que es
  // exactamente el tipo de detalle que se rompe cuando alguien agrega uno.
  // `api` sobre todo NO se duplica: sabe del CSRF y del 401, y tener dos
  // versiones de esa decisión es tener una que se olvida de actualizar.
  function ui() { return window.uiMiFirma || {}; }
  function $(id) { return ui().$(id); }
  function esc(s) { return ui().esc(s); }
  function api(p, m, b) { return ui().api(p, m, b); }
  function abrirModal(h) { return ui().abrirModal(h); }
  function cerrarModal() { return ui().cerrarModal(); }

  var pdfjs = null;
  var ANCHO_OBJETIVO = 820;      // px de pantalla que ocupa una hoja
  var ESCALA_MAX = 1.6;
  var MINIMO = 24;               // lado mínimo de una marca, en px de pantalla

  async function cargarPdfjs() {
    if (pdfjs) return pdfjs;
    pdfjs = await import('/vendor/pdf.min.mjs');
    // El worker va por archivo y no por blob: `worker-src 'self'` bloquea los
    // blob, y está bien que los bloquee.
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
    return pdfjs;
  }

  var TAMANO = {
    firma:   { ancho: 170, alto: 55 },   // en puntos PDF, ~6 × 2 cm
    rubrica: { ancho: 55,  alto: 40 },
  };

  /**
   * Abre el editor para UN firmante.
   *
   * `participacion` trae id y nombre; `instanciaId` es el documento.
   */
  window.abrirEditorMarcas = async function (instanciaId, participacion) {
    var estado = {
      marcas: [], paginas: 0, viewports: [], escala: 1, tipo: 'rubrica',
    };

    abrirModal(
      '<h2>Dónde firma ' + esc(participacion.nombre || 'este firmante') + '</h2>' +
      // ⚠ Lo que hay que explicar no es cómo se usa: es QUÉ ES.
      //
      // Se leía como «poné la firma de esta persona» —o sea, firmar por otro—,
      // que contradice la regla del 3 de agosto: la imagen la aporta quien
      // firma, siempre. Lo que se hace acá es reservarle el renglón. Un contrato
      // con «Firma del solicitante» y «Firma por la empresa» en líneas distintas
      // necesita que cada uno firme en la suya, y eso lo sabe el que manda el
      // documento, no el que lo recibe.
      '<p class="sub">Le reservás el renglón: la marca le aparece en la pantalla en este ' +
      'lugar y ella pone ahí <b>su</b> firma. Puede acomodarla, no sacarla — correr una ' +
      'firma que tapa un párrafo es acomodar; hacerla desaparecer sería firmar en otro ' +
      'lado del que le pediste.</p>' +
      '<p class="sub">Elegí firma o rúbrica y hacé clic en la hoja. Arrastrá para acomodar y ' +
      'usá la esquina para agrandar. Si no le reservás nada, firma donde quiera: el ' +
      'documento queda firmado igual.</p>' +
      '<div class="acc" style="justify-content:flex-start;flex-wrap:wrap;gap:10px">' +
      '  <div class="acc" style="gap:4px">' +
      '    <button class="btn btn-p chico" id="tFirma">Firma</button>' +
      '    <button class="btn btn-s chico" id="tRubrica">Rúbrica</button>' +
      '  </div>' +
      '  <button class="btn btn-s chico" id="mTodas">Rubricar todas las hojas</button>' +
      '  <button class="btn btn-s chico" id="mFirmarTodas">Firmar todas las hojas</button>' +
      '  <button class="btn btn-d chico" id="mLimpiar">Quitar todas</button>' +
      '  <span id="mCuenta" style="font-size:13px;color:var(--mut)"></span>' +
      '</div>' +
      '<div id="hojas" style="max-height:58vh;overflow:auto;margin-top:12px;' +
      'background:#eef2f7;padding:12px;border-radius:10px;min-height:120px">' +
      '<p style="color:var(--mut);font-size:14px;text-align:center;margin:28px 0">Abriendo el documento…</p>' +
      '</div>' +
      '<div id="mErr"></div>' +
      '<div class="acc"><button class="btn btn-s" id="mCancel">Cancelar</button>' +
      '<button class="btn btn-p" id="mOk">Guardar</button></div>'
    );

    // Una hoja A4 a escala usable no entra en un modal de 440px.
    var caja0 = document.querySelector('#modal .modal');
    if (caja0) caja0.classList.add('ancho');

    // El editor ocupa el único modal que hay, así que al salir se vuelve a la
    // ficha del circuito en vez de dejar la pantalla vacía.
    function volver() {
      cerrarModal();
      if (window.abrirCircuito && participacion.circuitoId) {
        window.abrirCircuito(participacion.circuitoId);
      }
    }

    $('mCancel').addEventListener('click', volver);
    $('tFirma').addEventListener('click', function () { elegirTipo('firma'); });
    $('tRubrica').addEventListener('click', function () { elegirTipo('rubrica'); });

    function elegirTipo(t) {
      estado.tipo = t;
      $('tFirma').className = 'btn chico ' + (t === 'firma' ? 'btn-p' : 'btn-s');
      $('tRubrica').className = 'btn chico ' + (t === 'rubrica' ? 'btn-p' : 'btn-s');
    }
    elegirTipo('rubrica');

    // ---- render del PDF ----
    try {
      var lib = await cargarPdfjs();
      var doc = await lib.getDocument({
        url: '/documentos/' + instanciaId + '/archivo',
        withCredentials: true,
      }).promise;
      estado.paginas = doc.numPages;

      var cont = $('hojas');
      cont.innerHTML = '';

      // Se dibuja cuando la hoja entra en pantalla, no antes. `root: cont`
      // porque el que scrollea es el contenedor, no la ventana.
      var pendientes = new Map();
      var mirador = new IntersectionObserver(function (entradas) {
        entradas.forEach(function (e) {
          if (!e.isIntersecting) return;
          var dibujar = pendientes.get(e.target);
          if (!dibujar) return;
          pendientes.delete(e.target);
          mirador.unobserve(e.target);
          dibujar();
        });
      }, { root: cont, rootMargin: '400px' });

      for (var n = 1; n <= doc.numPages; n++) {
        var pag = await doc.getPage(n);

        if (n === 1) {
          var base = pag.getViewport({ scale: 1 });
          estado.escala = Math.min(ESCALA_MAX, ANCHO_OBJETIVO / base.width);
        }
        var vp = pag.getViewport({ scale: estado.escala });
        estado.viewports[n - 1] = vp;

        var caja = document.createElement('div');
        caja.className = 'hoja';
        caja.dataset.pagina = String(n - 1);
        caja.style.cssText =
          'position:relative;margin:0 auto 14px;background:#fff;box-shadow:0 1px 6px rgba(16,24,40,.14);' +
          'width:' + Math.round(vp.width) + 'px;height:' + Math.round(vp.height) + 'px';

        var num = document.createElement('span');
        num.textContent = String(n);
        num.style.cssText =
          'position:absolute;left:-10px;top:-8px;background:var(--mut);color:#fff;font-size:11px;' +
          'min-width:18px;height:18px;line-height:18px;text-align:center;border-radius:9px;' +
          'padding:0 5px;z-index:2';
        caja.appendChild(num);
        cont.appendChild(caja);

        pendientes.set(caja, (function (pagina, vista, destino) {
          return function () {
            var lienzo = document.createElement('canvas');
            lienzo.width = Math.round(vista.width);
            lienzo.height = Math.round(vista.height);
            lienzo.style.cssText = 'display:block;width:100%;height:100%';
            destino.insertBefore(lienzo, destino.firstChild);
            pagina.render({ canvasContext: lienzo.getContext('2d'), viewport: vista });
          };
        })(pag, vp, caja));
        mirador.observe(caja);

        caja.addEventListener('mousedown', hacerClicEnHoja);
      }
    } catch (e) {
      $('mErr').innerHTML =
        '<div class="msg err">No pude abrir el documento para ubicar las firmas: ' +
        esc(e.message) + '</div>';
      return;
    }

    // ---- marcas que ya existían ----
    try {
      var j = await api('/documentos/' + instanciaId + '/marcas');
      (j.marcas || [])
        .filter(function (m) { return m.participacion_id === participacion.id; })
        .forEach(function (m) {
          if (estado.viewports[m.pagina]) {
            estado.marcas.push({
              tipo: m.tipo, pagina: m.pagina,
              x: m.x, y: m.y, ancho: m.ancho, alto: m.alto,
            });
          }
        });
    } catch (e) { /* si no hay, no hay */ }
    pintar();

    // =======================================================================
    // Coordenadas
    //
    // ⚠ Acá está todo el problema y por eso está aislado en dos funciones.
    // La pantalla mide en píxeles desde arriba-izquierda; el PDF en puntos
    // desde abajo-izquierda, y además la página puede venir rotada. Hacer la
    // cuenta a mano funciona con el primer documento y falla con el primero
    // escaneado al revés. `convertToPdfPoint` la hace bien.
    // =======================================================================
    function aPdf(pagina, xPx, yPx, anchoPx, altoPx) {
      var vp = estado.viewports[pagina];
      var a = vp.convertToPdfPoint(xPx, yPx + altoPx);        // esquina inferior izq
      var b = vp.convertToPdfPoint(xPx + anchoPx, yPx);       // esquina superior der
      return {
        x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]),
        ancho: Math.abs(b[0] - a[0]), alto: Math.abs(b[1] - a[1]),
      };
    }
    function aPantalla(pagina, m) {
      var vp = estado.viewports[pagina];
      var a = vp.convertToViewportPoint(m.x, m.y);
      var b = vp.convertToViewportPoint(m.x + m.ancho, m.y + m.alto);
      return {
        x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]),
        ancho: Math.abs(b[0] - a[0]), alto: Math.abs(b[1] - a[1]),
      };
    }

    function hacerClicEnHoja(ev) {
      if (ev.target.classList.contains('marca') ||
          ev.target.classList.contains('tirador') ||
          ev.target.classList.contains('quitar')) return;
      var caja = ev.currentTarget;
      var pagina = Number(caja.dataset.pagina);
      var r = caja.getBoundingClientRect();
      var t = TAMANO[estado.tipo];
      var vp = estado.viewports[pagina];

      // Dos del mismo tipo en la misma hoja las rechaza la base (índice único).
      // Que lo diga la pantalla antes, y no un 500 después de veinte clics.
      var ya = estado.marcas.some(function (m) {
        return m.pagina === pagina && m.tipo === estado.tipo;
      });
      if (ya) {
        return aviso('En esta hoja ya pusiste ' +
          (estado.tipo === 'firma' ? 'la firma' : 'la rúbrica') + '. Movela o quitala.');
      }

      // El clic queda en el CENTRO de la marca: es lo que la mano espera.
      var anchoPx = t.ancho * estado.escala, altoPx = t.alto * estado.escala;
      // ⚠ El borde IZQUIERDO en el clic, no el centro — medido el 10/8 en la base:
      // TODOS los campos con x clavada en 0 (ROTAX, pasaportes: 190×20, la y sana)
      // nacieron de un clic sobre las etiquetas del lado izquierdo de la hoja.
      // Centrar un elemento de 190 pt hace fatal la franja de 95 pt del borde —
      // justo donde viven las etiquetas— y el recorte lo clavaba en 0 sin decir
      // nada. Con el borde izquierdo en el dedo, tocás donde ARRANCA el dato y el
      // recorte izquierdo es inalcanzable. La vertical sigue centrada: su franja
      // era de 10 pt e inofensiva.
      var xPx = Math.max(0, Math.min(vp.width - anchoPx, ev.clientX - r.left));
      var yPx = Math.max(0, Math.min(vp.height - altoPx, ev.clientY - r.top - altoPx / 2));
      var p = aPdf(pagina, xPx, yPx, anchoPx, altoPx);
      estado.marcas.push({ tipo: estado.tipo, pagina: pagina,
                           x: p.x, y: p.y, ancho: p.ancho, alto: p.alto });
      aviso('');
      pintar();
    }

    function aviso(texto) {
      $('mErr').innerHTML = texto ? '<div class="msg err">' + esc(texto) + '</div>' : '';
    }

    function pintar() {
      document.querySelectorAll('#hojas .marca').forEach(function (n) { n.remove(); });
      estado.marcas.forEach(function (m, i) {
        var caja = document.querySelector('#hojas .hoja[data-pagina="' + m.pagina + '"]');
        if (!caja) return;
        var p = aPantalla(m.pagina, m);
        var el = document.createElement('div');
        el.className = 'marca';
        el.dataset.i = String(i);
        el.style.cssText =
          'position:absolute;left:' + p.x + 'px;top:' + p.y + 'px;width:' + p.ancho +
          'px;height:' + p.alto + 'px;border:1.5px solid var(--brand-600);border-radius:6px;' +
          'background:rgba(37,99,235,.13);cursor:move;display:grid;place-items:center;' +
          'font-size:11px;font-weight:600;color:var(--brand-600);user-select:none;z-index:3';
        el.textContent = m.tipo === 'firma' ? 'Firma' : 'Rúbrica';
        // ⚠ EL TIRADOR TIENE QUE VERSE.
        //
        // Existía desde el principio: 12 px, del mismo azul que el borde del
        // recuadro y sin borde propio. Sobre el rectángulo azul no se
        // distinguía, y Claudio pidió como función nueva la de agrandar la
        // firma — que ya estaba. **Un control que no se ve es un control que no
        // existe**, y el arreglo no es explicarlo: es hacerlo visible.
        //
        // 14 px con borde blanco y sombra, igual que el del editor de campos,
        // que tuvo exactamente el mismo problema el 4 de agosto.
        el.innerHTML +=
          '<span class="tirador" style="position:absolute;right:-7px;bottom:-7px;width:14px;' +
          'height:14px;border-radius:4px;background:var(--brand-600);border:2px solid #fff;' +
          'box-shadow:0 1px 3px rgba(0,0,0,.35);cursor:nwse-resize" ' +
          'title="Arrastrá para cambiar el tamaño"></span>' +
          '<span class="quitar" style="position:absolute;right:-7px;top:-7px;width:16px;height:16px;' +
          'border-radius:50%;background:var(--danger);color:#fff;font-size:11px;line-height:16px;' +
          'text-align:center;cursor:pointer">×</span>';
        caja.appendChild(el);
        el.addEventListener('mousedown', arrastrar);
      });
      $('mCuenta').textContent = estado.marcas.length
        ? estado.marcas.length + ' marca(s) · ' + estado.paginas + ' hoja(s)'
        : estado.paginas + ' hoja(s), sin marcas';
    }

    function arrastrar(ev) {
      ev.stopPropagation();
      var el = ev.currentTarget;
      var i = Number(el.dataset.i);
      var m = estado.marcas[i];

      if (ev.target.classList.contains('quitar')) {
        estado.marcas.splice(i, 1);
        aviso('');
        return pintar();
      }
      var redimensionar = ev.target.classList.contains('tirador');
      var vp = estado.viewports[m.pagina];
      var p0 = aPantalla(m.pagina, m);
      var x0 = ev.clientX, y0 = ev.clientY;

      function mover(e2) {
        var dx = e2.clientX - x0, dy = e2.clientY - y0;
        var nx = p0.x, ny = p0.y, na = p0.ancho, nl = p0.alto;
        if (redimensionar) {
          na = Math.max(MINIMO, Math.min(vp.width - p0.x, p0.ancho + dx));
          nl = Math.max(MINIMO, Math.min(vp.height - p0.y, p0.alto + dy));
        } else {
          nx = Math.max(0, Math.min(vp.width - p0.ancho, p0.x + dx));
          ny = Math.max(0, Math.min(vp.height - p0.alto, p0.y + dy));
        }
        var pdf = aPdf(m.pagina, nx, ny, na, nl);
        m.x = pdf.x; m.y = pdf.y; m.ancho = pdf.ancho; m.alto = pdf.alto;
        el.style.left = nx + 'px'; el.style.top = ny + 'px';
        el.style.width = na + 'px'; el.style.height = nl + 'px';
      }
      function soltar() {
        document.removeEventListener('mousemove', mover);
        document.removeEventListener('mouseup', soltar);
        pintar();
      }
      document.addEventListener('mousemove', mover);
      document.addEventListener('mouseup', soltar);
    }

    // ---- los atajos que resuelven el contrato largo ----
    function enTodas(tipo) {
      var t = TAMANO[tipo];
      // Abajo a la derecha, con un margen: es donde se rubrica a mano.
      estado.marcas = estado.marcas.filter(function (m) { return m.tipo !== tipo; });
      for (var pg = 0; pg < estado.paginas; pg++) {
        var vp = estado.viewports[pg];
        var esq = vp.convertToPdfPoint(vp.width - (t.ancho + 30) * estado.escala,
                                       vp.height - 30 * estado.escala);
        estado.marcas.push({ tipo: tipo, pagina: pg,
                             x: esq[0], y: esq[1], ancho: t.ancho, alto: t.alto });
      }
      aviso('');
      pintar();
    }
    $('mTodas').addEventListener('click', function () { enTodas('rubrica'); });
    $('mFirmarTodas').addEventListener('click', function () { enTodas('firma'); });
    $('mLimpiar').addEventListener('click', function () { estado.marcas = []; aviso(''); pintar(); });

    $('mOk').addEventListener('click', async function () {
      $('mOk').disabled = true;
      try {
        await api('/participaciones/' + participacion.id + '/marcas', 'PUT', {
          marcas: estado.marcas.map(function (m) {
            return { tipo: m.tipo, pagina: m.pagina,
                     x: +m.x.toFixed(2), y: +m.y.toFixed(2),
                     ancho: +m.ancho.toFixed(2), alto: +m.alto.toFixed(2) };
          }),
        });
        volver();
      } catch (e) {
        $('mOk').disabled = false;
        aviso(e.message);
      }
    });
  };
})();
