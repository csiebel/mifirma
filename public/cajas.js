/* ===========================================================================
   El motor de cajas: dibujar el PDF y las cajas de los campos encima.

   ⚠ Esto NO es una pantalla. Es el motor que usa el editor de campos adentro de
   su propia pantalla, en la columna de la derecha.

   La primera versión era un modal aparte: se salía de la lista, se dibujaban las
   cajas, se volvía. Lo probó una persona y el veredicto fue exacto: «no queda
   donde lo puse, y el editor está confuso, no supe cómo usarlo». Las dos cosas
   tenían la misma causa —dos pantallas para una sola tarea— y una de ellas era
   un defecto de verdad: al volver, la lista se releía del servidor y pisaba las
   coordenadas que se acababan de dibujar.

   Con una sola pantalla eso no se puede volver a romper: hay una lista, hay una
   hoja al lado, y las dos miran el mismo array.

   ═══ POR QUÉ pdf.js Y NO UN <iframe> ═══

   Un iframe muestra el PDF pero no dice NADA sobre él: ni dónde empieza cada
   hoja, ni a qué escala se ve, ni cómo convertir un punto de la pantalla a un
   punto del documento. Y esa conversión es todo el problema: el PDF mide en
   puntos desde abajo-izquierda, el navegador en píxeles desde arriba-izquierda,
   y la hoja puede venir rotada. `convertToPdfPoint` hace esa cuenta bien.
   =========================================================================== */
(function () {
  'use strict';

  var ANCHO_OBJETIVO = 560;      // px de pantalla que ocupa una hoja en la columna
  var ESCALA_MAX = 1.4;
  var MINIMO = 14;               // lado mínimo de una caja, en px de pantalla
  var NUEVA = { ancho: 190, alto: 20 };          // puntos PDF: un renglón normal
  var NUEVA_CASILLA = { ancho: 16, alto: 16 };

  var COLOR = {
    emisor:     { borde: '#0e7490', fondo: 'rgba(14,116,144,.16)' },
    firmante:   { borde: '#d9a406', fondo: 'rgba(253,224,71,.38)' },
    // El que llena cualquiera: verde, para que se distinga de un vistazo del
    // que tiene dueño. No es un detalle: mirando la hoja hay que poder decir
    // «éste lo pone Claudio» y «éste lo pone el que llegue».
    cualquiera: { borde: '#0f766e', fondo: 'rgba(20,184,166,.24)' },
  };

  var pdfjs = null;
  async function cargarPdfjs() {
    if (pdfjs) return pdfjs;
    pdfjs = await import('/vendor/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
    return pdfjs;
  }

  window.cajasMiFirma = {
    /**
     * @param caja       dónde se dibuja (la columna derecha del editor)
     * @param op.instanciaId  de dónde se baja el PDF
     * @param op.campos       el array VIVO del editor: se modifica in situ
     * @param op.firmantes    para pintar de quién es cada caja
     * @param op.alTocar(i)   cuando se toca una caja: la lista la resalta
     * @param op.alMover()    cuando cambiaron las coordenadas de alguna
     * @param op.alCrear(i)   cuando un clic en la hoja creó una caja nueva
     * @param op.quienNueva() de quién es la caja que se cree con el próximo clic
     */
    montar: async function (caja, op) {
      var estado = { paginas: 0, viewports: [], escala: 1, sel: -1 };
      var campos = op.campos;

      caja.innerHTML =
        '<p style="color:var(--mut);font-size:13.5px;text-align:center;margin:28px 0">' +
        'Abriendo el documento…</p>';

      var doc;
      try {
        var lib = await cargarPdfjs();
        doc = await lib.getDocument({
          url: '/documentos/' + op.instanciaId + '/archivo',
          withCredentials: true,
        }).promise;
      } catch (e) {
        caja.innerHTML = '<div class="msg err">No pude abrir el documento para ubicar los ' +
          'campos. Podés definirlos igual desde la lista; van a caer en un lugar por ' +
          'omisión.</div>';
        return null;
      }

      estado.paginas = doc.numPages;
      caja.innerHTML = '';

      // Se miden todas las hojas al abrir —hace falta para convertir coordenadas
      // en cualquiera— pero se dibuja sólo la que entra en pantalla. Un contrato
      // de 200 hojas dibujado entero son ~1,6 GB de píxeles.
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
      }, { root: caja, rootMargin: '400px' });

      for (var n = 1; n <= doc.numPages; n++) {
        var pag = await doc.getPage(n);
        if (n === 1) {
          var base = pag.getViewport({ scale: 1 });
          estado.escala = Math.min(ESCALA_MAX, (caja.clientWidth - 28 || ANCHO_OBJETIVO) / base.width);
        }
        var vp = pag.getViewport({ scale: estado.escala });
        estado.viewports[n - 1] = vp;

        var hoja = document.createElement('div');
        hoja.className = 'cj-hoja';
        hoja.dataset.pagina = String(n - 1);
        hoja.style.cssText =
          'position:relative;margin:0 auto 14px;background:#fff;cursor:crosshair;' +
          'box-shadow:0 1px 6px rgba(16,24,40,.16);' +
          'width:' + Math.round(vp.width) + 'px;height:' + Math.round(vp.height) + 'px';

        var num = document.createElement('span');
        num.textContent = String(n);
        num.style.cssText =
          'position:absolute;left:-9px;top:-8px;background:var(--mut);color:#fff;font-size:11px;' +
          'min-width:18px;height:18px;line-height:18px;text-align:center;border-radius:9px;' +
          'padding:0 5px;z-index:2';
        hoja.appendChild(num);
        caja.appendChild(hoja);

        pendientes.set(hoja, (function (pagina, vista, destino) {
          return function () {
            var lienzo = document.createElement('canvas');
            lienzo.width = Math.round(vista.width);
            lienzo.height = Math.round(vista.height);
            lienzo.style.cssText = 'display:block;width:100%;height:100%';
            destino.insertBefore(lienzo, destino.firstChild);
            pagina.render({ canvasContext: lienzo.getContext('2d'), viewport: vista });
          };
        })(pag, vp, hoja));
        mirador.observe(hoja);

        hoja.addEventListener('mousedown', clicEnHoja);
      }

      // =====================================================================
      // Coordenadas — el mismo par de funciones que el visor del firmante y el
      // editor de marcas. Aislado a propósito: es donde se equivoca cualquiera.
      // =====================================================================
      function aPdf(pagina, xPx, yPx, anchoPx, altoPx) {
        var vp = estado.viewports[pagina];
        var a = vp.convertToPdfPoint(xPx, yPx + altoPx);
        var b = vp.convertToPdfPoint(xPx + anchoPx, yPx);
        return {
          x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]),
          ancho: Math.abs(b[0] - a[0]), alto: Math.abs(b[1] - a[1]),
        };
      }
      function aPantalla(pagina, c) {
        var vp = estado.viewports[pagina];
        var a = vp.convertToViewportPoint(c.x, c.y);
        var b = vp.convertToViewportPoint(c.x + c.ancho, c.y + c.alto);
        return {
          x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]),
          ancho: Math.abs(b[0] - a[0]), alto: Math.abs(b[1] - a[1]),
        };
      }

      function codigoLibre() {
        var usados = {};
        campos.forEach(function (c) { usados[c.codigo] = true; });
        var n = campos.length + 1;
        while (usados['campo_' + n]) n++;
        return 'campo_' + n;
      }

      function clicEnHoja(ev) {
        if (ev.target.classList.contains('cj-caja') ||
            ev.target.classList.contains('cj-tirador') ||
            ev.target.classList.contains('cj-quitar')) return;

        // ⚠ Sin esto, el campo nuevo se crea y el cursor NO queda en su nombre.
        //
        // El navegador mueve el foco al elemento tocado cuando termina el
        // `mousedown`, o sea DESPUÉS de este handler. Así que el `focus()` que
        // hace el editor sobre la casilla del nombre se aplica y se pierde un
        // instante más tarde, sin dejar rastro.
        //
        // El síntoma no era «no quedó el foco»: era que la primera letra que
        // escribías desaparecía. «Número de póliza» quedaba «úmero de póliza».
        ev.preventDefault();

        var hoja = ev.currentTarget;
        var pagina = Number(hoja.dataset.pagina);
        var vp = estado.viewports[pagina];
        var r = hoja.getBoundingClientRect();

        var quien = (op.quienNueva && op.quienNueva()) || 'emisor';
        var t = NUEVA;
        var anchoPx = t.ancho * estado.escala, altoPx = t.alto * estado.escala;
        // El clic queda en el CENTRO: es lo que la mano espera.
        var xPx = Math.max(0, Math.min(vp.width - anchoPx, ev.clientX - r.left - anchoPx / 2));
        var yPx = Math.max(0, Math.min(vp.height - altoPx, ev.clientY - r.top - altoPx / 2));
        var p = aPdf(pagina, xPx, yPx, anchoPx, altoPx);

        campos.push({
          codigo: codigoLibre(),
          etiqueta: 'Campo ' + (campos.length + 1),
          tipo: 'texto',
          opciones: null,
          quien_completa: quien === 'emisor' ? 'emisor'
            : (quien === 'cualquiera' ? 'cualquiera' : 'firmante'),
          completa_emisor: quien === 'emisor',
          orden_firmante: (quien === 'emisor' || quien === 'cualquiera')
            ? null : Number(String(quien).slice(1)),
          obligatorio: false,
          pagina: pagina, x: p.x, y: p.y, ancho: p.ancho, alto: p.alto,
          usos: 0,
        });
        estado.sel = campos.length - 1;
        pintar();
        if (op.alCrear) op.alCrear(estado.sel);
      }

      function deQuien(c) {
        if (c.quien_completa) return c.quien_completa === 'emisor' ? 'emisor'
          : (c.quien_completa === 'cualquiera' ? 'cualquiera' : 'firmante');
        return c.completa_emisor ? 'emisor' : 'firmante';
      }

      function nombreDe(c) {
        if (c.quien_completa === 'cualquiera') return 'lo llena cualquiera de los firmantes';
        if (c.completa_emisor) return 'texto fijo, no lo completa nadie';
        var p = (op.firmantes || []).filter(function (x) { return x.orden === c.orden_firmante; })[0];
        return p ? (p.nombre || p.email) : 'firmante ' + (c.orden_firmante || '?');
      }

      function pintar() {
        caja.querySelectorAll('.cj-caja').forEach(function (n) { n.remove(); });

        campos.forEach(function (c, i) {
          var hoja = caja.querySelector('.cj-hoja[data-pagina="' + c.pagina + '"]');
          if (!hoja || !estado.viewports[c.pagina]) return;
          var p = aPantalla(c.pagina, c);
          var col = COLOR[deQuien(c)];

          var el = document.createElement('div');
          el.className = 'cj-caja' + (i === estado.sel ? ' sel' : '');
          el.dataset.i = String(i);
          el.title = c.etiqueta + ' — ' + nombreDe(c);
          el.style.cssText =
            'position:absolute;left:' + p.x + 'px;top:' + p.y + 'px;' +
            'width:' + p.ancho + 'px;height:' + p.alto + 'px;' +
            'border:1.5px solid ' + col.borde + ';border-radius:4px;background:' + col.fondo + ';' +
            'cursor:move;display:grid;place-items:center;overflow:visible;' +
            'font-size:' + Math.round(Math.max(9, Math.min(12, p.alto * 0.55))) + 'px;' +
            'font-weight:600;color:' + col.borde + ';user-select:none;z-index:3' +
            (i === estado.sel ? ';box-shadow:0 0 0 3px rgba(37,99,235,.4)' : '');

          var et = document.createElement('span');
          et.style.cssText = 'padding:0 3px;pointer-events:none;white-space:nowrap;' +
            'overflow:hidden;text-overflow:ellipsis;max-width:100%';
          // ⚠ Si el emisor ya escribió el valor, se muestra EL VALOR y no la
          // etiqueta: es lo que va a salir impreso, y hay que poder verlo en su
          // lugar para saber si entra en el ancho que le diste.
          var suyo = c.completa_emisor && String(c.valor || '').trim();
          et.textContent = suyo ? String(c.valor).trim() : c.etiqueta;
          if (suyo) { et.style.fontWeight = '400'; et.style.color = '#0f1e2c'; }
          el.appendChild(et);

          // ⚠ Un campo que alguien YA completó no se mueve ni se saca: sus
          // coordenadas son las que se dibujaron en el documento que esa persona
          // vio. Cambiarlas después sería decir que escribió en otro lado.
          if (c.usos) {
            el.style.cursor = 'not-allowed';
            el.style.opacity = '.7';
            el.title += ' · ya completado, no se mueve';
            el.addEventListener('mousedown', function (ev) {
              ev.stopPropagation();
              if (op.alTocar) op.alTocar(i);
            });
          } else {
            // ⚠ El tirador tenía 11 px y estaba, pero nadie lo veía: el primero
            // que probó el editor pidió «que el campo sea sizeable», que ya lo
            // era. Un control que hay que descubrir es un control que no existe.
            // Ahora tiene 14, borde blanco para despegarlo del fondo del PDF, y
            // una sombra que lo levanta.
            el.innerHTML +=
              '<span class="cj-tirador" title="Arrastrá para cambiar el tamaño" ' +
              'style="position:absolute;right:-7px;bottom:-7px;width:14px;height:14px;' +
              'border-radius:4px;background:' + col.borde + ';border:2px solid #fff;' +
              'box-shadow:0 1px 3px rgba(16,24,40,.4);cursor:nwse-resize"></span>' +
              '<span class="cj-quitar" style="position:absolute;right:-7px;top:-7px;width:16px;' +
              'height:16px;border-radius:50%;background:var(--danger);color:#fff;font-size:11px;' +
              'line-height:16px;text-align:center;cursor:pointer">×</span>';
            el.addEventListener('mousedown', arrastrar);
          }
          hoja.appendChild(el);
        });
      }

      function arrastrar(ev) {
        ev.stopPropagation();
        var el = ev.currentTarget;
        var i = Number(el.dataset.i);
        var c = campos[i];

        if (ev.target.classList.contains('cj-quitar')) {
          campos.splice(i, 1);
          estado.sel = -1;
          pintar();
          if (op.alMover) op.alMover();
          return;
        }

        estado.sel = i;
        pintar();
        if (op.alTocar) op.alTocar(i);

        var redimensionar = ev.target.classList.contains('cj-tirador');
        var vp = estado.viewports[c.pagina];
        var p0 = aPantalla(c.pagina, c);
        var x0 = ev.clientX, y0 = ev.clientY;
        var vivo = caja.querySelector('.cj-caja[data-i="' + i + '"]');

        function mover(e2) {
          var dx = e2.clientX - x0, dy = e2.clientY - y0;
          var nx = p0.x, ny = p0.y, na = p0.ancho, nl = p0.alto;
          if (redimensionar) {
            na = Math.max(MINIMO, Math.min(vp.width - p0.x, p0.ancho + dx));
            nl = Math.max(MINIMO, Math.min(vp.height - p0.y, p0.alto + dy));
          } else {
            // No se puede sacar de la hoja: una caja fuera de la página no se
            // dibuja en ningún lado y no hay forma de que la persona lo note.
            nx = Math.max(0, Math.min(vp.width - p0.ancho, p0.x + dx));
            ny = Math.max(0, Math.min(vp.height - p0.alto, p0.y + dy));
          }
          var pdf = aPdf(c.pagina, nx, ny, na, nl);
          c.x = pdf.x; c.y = pdf.y; c.ancho = pdf.ancho; c.alto = pdf.alto;
          if (vivo) {
            vivo.style.left = nx + 'px'; vivo.style.top = ny + 'px';
            vivo.style.width = na + 'px'; vivo.style.height = nl + 'px';
          }
        }
        function soltar() {
          document.removeEventListener('mousemove', mover);
          document.removeEventListener('mouseup', soltar);
          pintar();
          if (op.alMover) op.alMover();
        }
        document.addEventListener('mousemove', mover);
        document.addEventListener('mouseup', soltar);
      }

      pintar();

      return {
        pintar: pintar,
        paginas: function () { return estado.paginas; },
        /** Trae la caja a la vista y la resalta. Lo usa la lista al seleccionar. */
        irA: function (i) {
          estado.sel = i;
          pintar();
          var el = caja.querySelector('.cj-caja[data-i="' + i + '"]');
          if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        },
        /** Si un campo no tiene coordenadas usables, lo pone en la hoja 1. */
        ubicarSuelto: function (i) {
          var c = campos[i];
          var vp = estado.viewports[0];
          if (!vp) return false;
          var t = c.tipo === 'casilla' ? NUEVA_CASILLA : NUEVA;
          // Escalonados, para que dos campos nuevos no queden uno encima del
          // otro — que es exactamente lo que pasaba con el lugar fijo.
          var k = campos.filter(function (x, j) { return j < i; }).length % 12;
          var anchoPx = t.ancho * estado.escala, altoPx = t.alto * estado.escala;
          var p = aPdf(0, 40 + k * 6, 60 + k * 26, anchoPx, altoPx);
          c.pagina = 0; c.x = p.x; c.y = p.y; c.ancho = p.ancho; c.alto = p.alto;
          pintar();
          return true;
        },
      };
    },
  };
})();
