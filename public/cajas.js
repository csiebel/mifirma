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
  var ESCALA_MAX = 1.4;          // techo del ajuste automático al abrir
  var MINIMO = 14;               // lado mínimo de una caja, en px de pantalla

  // Los escalones del zoom, relativos al ajuste automático. Fijos y no un
  // factor: así el 100% —la hoja entera en pantalla— siempre existe y se vuelve
  // a él sin buscarlo.
  var ZOOM_MIN = 0.4;
  var ZOOM_MAX = 4;
  var ZOOM_PASOS = [0.4, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5, 3, 4];
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

      // Las páginas se guardan: hacer zoom es pedirle a pdf.js un viewport
      // nuevo y volver a dibujar, y sin la página no se puede.
      var paginasPdf = [];
      var escalaAjuste = 1;

      // ═══ LA BARRA DE ZOOM ═══
      //
      // El ajuste automático entra la hoja entera, que es lo correcto para
      // leerla y no alcanza para ubicar un campo: en un formulario apretado un
      // renglón mide seis píxeles, y el recuadro cae en el de arriba o en el de
      // abajo. Pedido así: «que pueda existir la opción de zoom en las hojas
      // así se sabe bien dónde colocar los campos».
      //
      // ⚠ El zoom NO toca ninguna coordenada guardada. Todo se guarda en puntos
      // PDF y `aPdf`/`aPantalla` convierten con la escala vigente. Si algo se
      // moviera al hacer zoom, la conversión está mal en otro lado.
      var barra = document.createElement('div');
      barra.className = 'cj-zoom';
      barra.innerHTML =
        '<button type="button" data-z="-" title="Achicar" aria-label="Achicar">−</button>' +
        '<button type="button" data-z="fit" class="cj-zoom-n" title="Entrar la hoja en pantalla">100%</button>' +
        '<button type="button" data-z="+" title="Agrandar" aria-label="Agrandar">+</button>';
      // Dónde va la barra lo decide QUIEN LLAMA, no este archivo: el motor no
      // tiene por qué conocer la maqueta del editor. Sin `op.zoomEn` cae al
      // lado de la hoja, que funciona en cualquier lado.
      (op.zoomEn || caja.parentElement || caja).appendChild(barra);

      // Se miden todas las hojas al abrir —hace falta para convertir coordenadas
      // en cualquiera— pero se dibuja sólo la que se acerca a la pantalla, y se
      // SUELTA la que se aleja. Medido el 15/8 en el visor del firmante, que
      // tenía este mismo mirador sin la mitad de soltar: recorrer el contrato
      // de prueba de 500 hojas dejaba 515 MB de lienzos vivos. En este editor
      // el defecto era idéntico — mismo motor, mismo arreglo el mismo día.
      var tareas = new WeakMap();    // hoja -> render de pdf.js en vuelo
      var enVentana = new Set();     // hojas dentro de la ventana del mirador
      var cola = [];                 // hojas esperando su turno de dibujo
      var dibujando = false;

      function dibujarHoja(hoja, alTerminar) {
        var i = Number(hoja.dataset.pagina);
        var pagina = paginasPdf[i], vista = estado.viewports[i];
        if (!pagina || !vista || hoja.querySelector('canvas')) return alTerminar();
        var lienzo = document.createElement('canvas');
        lienzo.width = Math.round(vista.width);
        lienzo.height = Math.round(vista.height);
        lienzo.style.cssText = 'display:block;width:100%;height:100%';
        hoja.insertBefore(lienzo, hoja.firstChild);
        var t;
        try {
          t = pagina.render({ canvasContext: lienzo.getContext('2d'), viewport: vista });
        } catch (e) { return alTerminar(); }
        tareas.set(hoja, t);
        t.promise.catch(function () { /* cancelado: la hoja se fue de la vista */ })
          .then(function () {
            if (tareas.get(hoja) === t) tareas.delete(hoja);
            alTerminar();
          });
      }

      function soltarHoja(hoja) {
        var t = tareas.get(hoja);
        if (t) { try { t.cancel(); } catch (e) {} tareas.delete(hoja); }
        var lienzo = hoja.querySelector('canvas');
        if (lienzo) {
          // ⚠⚠ ACHICARLO A CERO ANTES DE SACARLO. Safari de iPhone no devuelve
          // la memoria de un canvas sacado del DOM hasta quién sabe cuándo:
          // sin esto, cada hoja soltada deja un fantasma del tamaño de la hoja.
          lienzo.width = 0;
          lienzo.height = 0;
          lienzo.remove();
        }
        // Y que el worker de pdf.js suelte lo que masticó de esta página.
        var i = Number(hoja.dataset.pagina);
        var pagina = paginasPdf[i];
        if (pagina) {
          (t ? t.promise.catch(function () {}) : Promise.resolve()).then(function () {
            if (!enVentana.has(hoja)) { try { pagina.cleanup(); } catch (e) {} }
          });
        }
      }

      // ⚠⚠ DE A UNA HOJA POR VEZ, tirando lo vencido — la razón entera está en
      // visor.js, donde el iPhone lo cobró dos veces la noche del 15/8. Mismo
      // motor, misma fila india.
      function drenar() {
        if (dibujando) return;
        var hoja;
        do { hoja = cola.shift(); }
        while (hoja && (!enVentana.has(hoja) || hoja.querySelector('canvas')));
        if (!hoja) return;
        dibujando = true;
        dibujarHoja(hoja, function () { dibujando = false; drenar(); });
      }

      var mirador = new IntersectionObserver(function (entradas) {
        entradas.forEach(function (e) {
          var hoja = e.target;
          if (e.isIntersecting) {
            enVentana.add(hoja);
            if (cola.indexOf(hoja) === -1) cola.push(hoja);
          } else {
            enVentana.delete(hoja);
            soltarHoja(hoja);
          }
        });
        drenar();
      }, { root: caja, rootMargin: '1000px' });

      for (var n = 1; n <= doc.numPages; n++) {
        var pag = await doc.getPage(n);
        paginasPdf[n - 1] = pag;
        if (n === 1) {
          var base = pag.getViewport({ scale: 1 });
          escalaAjuste = Math.min(ESCALA_MAX, (caja.clientWidth - 28 || ANCHO_OBJETIVO) / base.width);
          estado.escala = escalaAjuste;
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

        mirador.observe(hoja);

        // ⚠ `click`, no `mousedown` (15/8): con el dedo, desplazarse por el
        // documento también empieza apoyándolo en la hoja, y crear un campo en
        // ese instante sembraría uno por cada scroll. `click` sólo llega con un
        // toque de verdad. Ver el mismo cambio en marcas.js.
        hoja.addEventListener('click', clicEnHoja);
      }

      // =====================================================================
      // El zoom
      //
      // ⚠ Y REPINTAR LAS CAJAS. Se posicionan en píxeles a partir de puntos PDF
      // con la escala vigente: sin repintar quedan donde estaban y el recuadro
      // aparece lejísimos del renglón al que pertenece. Ése es el defecto que
      // este bloque tiene que no tener.
      // =====================================================================
      function aplicarZoom(nueva) {
        var e2 = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, nueva));
        if (Math.abs(e2 - estado.escala) < 0.001) return;

        var antes = caja.scrollTop / Math.max(1, caja.scrollHeight);
        estado.escala = e2;

        for (var i = 0; i < paginasPdf.length; i++) {
          var vista = paginasPdf[i].getViewport({ scale: estado.escala });
          estado.viewports[i] = vista;
          var h = caja.querySelector('.cj-hoja[data-pagina="' + i + '"]');
          if (!h) continue;
          h.style.width = Math.round(vista.width) + 'px';
          h.style.height = Math.round(vista.height) + 'px';
          soltarHoja(h);
          // Re-observar de cero: el mirador sólo avisa cuando una hoja CRUZA el
          // borde. Volver a observarla dispara el aviso inicial con el estado
          // de ahora: la visible se redibuja ya con la escala nueva, la lejana
          // queda suelta hasta que el scroll la acerque.
          mirador.unobserve(h);
          mirador.observe(h);
        }

        pintar();
        caja.scrollTop = antes * caja.scrollHeight;
        var et = barra.querySelector('.cj-zoom-n');
        if (et) et.textContent = Math.round((estado.escala / escalaAjuste) * 100) + '%';
      }

      barra.addEventListener('click', function (ev) {
        var b = ev.target.closest('[data-z]');
        if (!b) return;
        ev.preventDefault();
        if (b.dataset.z === 'fit') return aplicarZoom(escalaAjuste);
        // Escalones fijos en vez de multiplicar: así el 100% siempre existe y
        // se vuelve a él sin tener que buscarlo con la rueda.
        var rel = estado.escala / escalaAjuste;
        var paso = b.dataset.z === '+'
          ? ZOOM_PASOS.find(function (p) { return p > rel + 0.001; })
          : ZOOM_PASOS.slice().reverse().find(function (p) { return p < rel - 0.001; });
        if (paso) aplicarZoom(escalaAjuste * paso);
      });

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

        // Historia del foco, para que nadie la reviva: cuando esto corría en
        // `mousedown`, el navegador movía el foco DESPUÉS del handler y se
        // comía el `focus()` del editor — la primera letra desaparecía y
        // «Número de póliza» quedaba «úmero de póliza». Hacía falta un
        // `preventDefault` acá. Con `click` (15/8) el orden juega a favor: el
        // foco por defecto ya se movió ANTES, en el mousedown, así que el
        // `focus()` del editor corre último y gana solo. El preventDefault se
        // fue con el problema.

        var hoja = ev.currentTarget;
        var pagina = Number(hoja.dataset.pagina);
        var vp = estado.viewports[pagina];
        var r = hoja.getBoundingClientRect();

        // ⚠ El dedo no es una punta (15/8, iPhone): al ir a agarrar un campo o
        // su tirador, el toque cae a veces unos píxeles AFUERA — en la hoja — y
        // acá nacía un campo nuevo sin querer, uno por cada errada. En pantalla
        // táctil, un toque cerca de un campo existente lo SELECCIONA, que es lo
        // que la mano estaba intentando. Con mouse el margen es cero: la punta
        // del cursor no yerra, y pegado a un campo se puede querer crear otro.
        if (window.matchMedia('(pointer:coarse)').matches) {
          var xT = ev.clientX - r.left, yT = ev.clientY - r.top, M = 18;
          for (var k = 0; k < campos.length; k++) {
            if (campos[k].pagina !== pagina) continue;
            var q = aPantalla(pagina, campos[k]);
            if (xT >= q.x - M && xT <= q.x + q.ancho + M &&
                yT >= q.y - M && yT <= q.y + q.alto + M) {
              estado.sel = k;
              pintar();
              if (op.alTocar) op.alTocar(k);
              return;
            }
          }
        }

        var quien = (op.quienNueva && op.quienNueva()) || 'emisor';
        var t = NUEVA;
        var anchoPx = t.ancho * estado.escala, altoPx = t.alto * estado.escala;
        // El clic queda en el CENTRO: es lo que la mano espera.
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

        campos.push({
          codigo: codigoLibre(),
          etiqueta: 'Campo ' + (campos.length + 1),
          tipo: 'texto',
          opciones: null,
          quien_completa: quien === 'emisor' ? 'emisor'
            : (quien === 'cualquiera' ? 'cualquiera' : 'firmante'),
          completa_emisor: quien === 'emisor',
          posicion_firmante: (quien === 'emisor' || quien === 'cualquiera')
            ? null : Number(String(quien).slice(1)),
          // Un campo dibujado a mano no hereda letra de nadie: el PDF no tiene
          // formulario del que leerla. Null = se ajusta al recuadro. Ver 056.
          cuerpo: null, color: null,
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
        // ⚠ Se busca por LUGAR, no por turno: en paralelo el turno vale 1 para
        // todos y este rótulo mostraba siempre al mismo. Ver migración 055.
        var p = (op.firmantes || []).filter(function (x) {
          return x.posicion === c.posicion_firmante;
        })[0];
        return p ? (p.nombre || p.email) : 'el firmante que estaba en el lugar ' +
          (c.posicion_firmante || '?') + ' y ya no está';
      }

      function pintar() {
        caja.querySelectorAll('.cj-caja, .cj-espejo').forEach(function (n) { n.remove(); });

        // Los ESPEJOS primero, así quedan abajo de las cajas de verdad.
        //
        // Un espejo es otro lugar donde el formulario repite el mismo dato
        // (migración 059): el valor se va a dibujar ahí también, así que el
        // emisor TIENE que verlo — si no, al firmar «aparece en lugares que yo
        // no puse». Se dibuja punteado, sin tiradores y sin mouse: queda fijo
        // donde el formulario lo puso, no lo decidió el emisor.
        campos.forEach(function (c) {
          (c.espejos || []).forEach(function (e) {
            var hoja = caja.querySelector('.cj-hoja[data-pagina="' + e.pagina + '"]');
            if (!hoja || !estado.viewports[e.pagina]) return;
            var p = aPantalla(e.pagina, e);
            var col = COLOR[deQuien(c)];
            var el = document.createElement('div');
            el.className = 'cj-espejo';
            el.title = c.etiqueta + ' — el formulario repite este dato acá; se completa solo';
            el.style.cssText =
              'position:absolute;left:' + p.x + 'px;top:' + p.y + 'px;' +
              'width:' + p.ancho + 'px;height:' + p.alto + 'px;' +
              'border:1.5px dashed ' + col.borde + ';border-radius:4px;opacity:.55;' +
              'pointer-events:none;display:grid;place-items:center;overflow:hidden;' +
              'font-size:' + Math.round(Math.max(8, Math.min(11, p.alto * 0.5))) + 'px;' +
              'color:' + col.borde + ';user-select:none;z-index:2';
            var et = document.createElement('span');
            et.style.cssText = 'padding:0 3px;white-space:nowrap;overflow:hidden;' +
              'text-overflow:ellipsis;max-width:100%';
            et.textContent = c.etiqueta;
            el.appendChild(et);
            hoja.appendChild(el);
          });
        });

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
            // `click`, no `pointerdown`: tocarlo para VER qué es, sí; que se
            // seleccione solo porque el scroll pasó por encima, no.
            el.addEventListener('click', function (ev) {
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
            // El arrastre es NUESTRO, no del scroll: sin `touch-action:none`
            // iOS corta el gesto a mitad de camino para desplazar la hoja.
            // Sólo en los campos que se pueden mover — sobre uno ya completado
            // el dedo tiene que poder seguir scrolleando como si nada.
            el.style.touchAction = 'none';
            el.style.webkitTouchCallout = 'none';
            el.addEventListener('pointerdown', arrastrar);
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

        // Ya es nuestro gesto: que iOS no arranque una selección ni un menú.
        ev.preventDefault();

        estado.sel = i;
        // ⚠⚠ Acá había un `pintar()` y NO puede volver: redibuja todos los
        // recuadros, o sea DESTRUYE el elemento que el dedo está agarrando — y
        // el puntero capturado muere con él. Con los viejos eventos de mouse
        // colgados de `document` no se notaba; con captura, el arrastre nacía
        // muerto. La selección se pinta a mano, sobre los elementos vivos, y el
        // `pintar()` completo queda para `soltar`, cuando el gesto terminó.
        caja.querySelectorAll('.cj-caja.sel').forEach(function (s) {
          s.classList.remove('sel');
          s.style.boxShadow = '';
        });
        el.classList.add('sel');
        el.style.boxShadow = '0 0 0 3px rgba(37,99,235,.4)';
        if (op.alTocar) op.alTocar(i); // repinta la LISTA lateral, no las cajas

        var redimensionar = ev.target.classList.contains('cj-tirador');
        var vp = estado.viewports[c.pagina];
        var p0 = aPantalla(c.pagina, c);
        var x0 = ev.clientX, y0 = ev.clientY;
        var vivo = el;

        // La captura: sin ella, apenas el dedo se sale del recuadro los
        // eventos dejan de llegarle y el campo queda muerto a mitad de camino.
        try { el.setPointerCapture(ev.pointerId); } catch (e) { /* mouse viejo */ }

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
          el.removeEventListener('pointermove', mover);
          el.removeEventListener('pointerup', soltar);
          el.removeEventListener('pointercancel', soltar);
          pintar();
          if (op.alMover) op.alMover();
        }
        // En el elemento, no en `document`: la captura le trae todo. Y
        // `pointercancel` también suelta — si el sistema interrumpe el gesto,
        // el campo queda donde llegó, no colgado de un puntero fantasma.
        el.addEventListener('pointermove', mover);
        el.addEventListener('pointerup', soltar);
        el.addEventListener('pointercancel', soltar);
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
