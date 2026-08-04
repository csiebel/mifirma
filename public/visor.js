/* ===========================================================================
   El visor del firmante: ver el documento y decidir dónde queda su firma.

   ═══ POR QUÉ pdf.js Y NO UN <iframe> ═══

   Un iframe muestra el PDF pero no dice NADA sobre él: no se sabe dónde empieza
   cada hoja, ni a qué escala se está viendo, ni cómo convertir un punto de la
   pantalla a un punto del documento. Y esa conversión es todo el problema: la
   base guarda puntos PDF con origen abajo a la izquierda, y el navegador
   trabaja en píxeles con origen arriba a la izquierda.

   pdf.js da el `viewport` de cada hoja, que sabe hacer esa cuenta —incluida la
   rotación, que existe y rompe cualquier cálculo hecho a mano—. Se sirve desde
   nuestro dominio porque el CSP es `script-src 'self'`, y eso es a propósito en
   una aplicación que muestra documentos ajenos antes de firmarlos.

   Es el mismo motor que usa el editor del emisor (`marcas.js`). La diferencia
   son los permisos: acá se toca UNA participación, la de quien mira.

   ═══ QUIÉN PUEDE QUÉ ═══

   · La marca que reservó el emisor: se puede MOVER, no sacar. Correr una firma
     que tapa un párrafo es acomodar; hacerla desaparecer es firmar en otro
     lugar del que se pidió, y esa decisión no es del firmante.
   · La que agregó la persona: se mueve y se saca.
   · La de otro firmante: se ve, apagada, para no ponerle la propia encima. No
     se toca — y no porque esta pantalla no lo ofrezca, sino porque la política
     `app.puede_mover_marca` exige que la participación sea suya.

   ⚠ Nada de esto es la firma. Es dónde se estampa una imagen. El valor legal lo
   da el PAdES y el documento queda firmado igual sin ninguna marca.
   =========================================================================== */
(function () {
  'use strict';

  var ANCHO_OBJETIVO = 760;   // px de pantalla que ocupa una hoja
  var ESCALA_MAX = 1.6;

  // En puntos PDF. Los mismos que usa el editor del emisor: una firma de ~6 × 2
  // cm y una rúbrica de ~2 × 1,4 cm.
  var TAMANO = {
    firma:   { ancho: 170, alto: 55 },
    rubrica: { ancho: 55,  alto: 40 },
  };

  var pdfjs = null;
  async function cargarPdfjs() {
    if (pdfjs) return pdfjs;
    pdfjs = await import('/vendor/pdf.min.mjs');
    // El worker va por archivo y no por blob: `worker-src 'self'` bloquea los
    // blob, y está bien que los bloquee.
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
    return pdfjs;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function post(path, body) {
    return fetch(path, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(async function (r) {
      var txt = await r.text();
      var data;
      try { data = txt ? JSON.parse(txt) : {}; } catch (e) { data = { error: txt }; }
      if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
      return data;
    });
  }

  window.visorMiFirma = {
    /**
     * Monta el visor dentro de `caja`.
     *
     * `opciones.editable` decide si se puede tocar: falso cuando la persona ya
     * firmó, o cuando todavía no es su turno. En ese caso se ve el documento y
     * las marcas, y nada más.
     *
     * `opciones.alCambiar()` se llama cada vez que cambian las marcas, para que
     * el panel pueda decir si va a salir estampada o no.
     */
    montar: async function (caja, opciones) {
      var op = opciones || {};
      var estado = {
        viewports: [], escala: 1, paginas: 0,
        marcas: [], editable: !!op.editable,
        // Qué imágenes cargó, por tipo. Una marca de inicial no se dibuja con
        // la firma completa: son dos trazos distintos y confundirlos en la
        // vista previa haría que la persona apruebe algo que no va a ver.
        tiene: { firma: false, rubrica: false }, version: 0,
        campos: [],
      };

      caja.innerHTML = '<div class="vis-cargando">Abriendo el documento…</div>';

      // ---- el PDF ----
      var doc;
      try {
        var lib = await cargarPdfjs();
        doc = await lib.getDocument({ url: '/firmar/documento', withCredentials: true }).promise;
      } catch (e) {
        // Si pdf.js no carga, el documento se tiene que poder leer igual: se
        // vuelve al visor del navegador. Se pierde poder mover la firma, no
        // poder leer lo que se firma, que es lo que no se negocia.
        caja.innerHTML =
          '<iframe title="Documento" src="/firmar/documento" class="vis-iframe"></iframe>';
        return null;
      }

      estado.paginas = doc.numPages;
      caja.innerHTML = '<div id="visHojas" class="vis-hojas"></div>';
      var hojas = document.getElementById('visHojas');

      // Se dibuja cuando la hoja entra en pantalla, no antes: un contrato de
      // 200 hojas dibujado entero son ~1,6 GB de píxeles y una pestaña colgada.
      // Pero se MIDEN todas al abrir, porque hace falta para convertir
      // coordenadas en cualquier hoja aunque no se esté mirando.
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
      }, { root: hojas, rootMargin: '500px' });

      for (var n = 1; n <= doc.numPages; n++) {
        var pag = await doc.getPage(n);
        if (n === 1) {
          var base = pag.getViewport({ scale: 1 });
          estado.escala = Math.min(ESCALA_MAX, (hojas.clientWidth - 40 || ANCHO_OBJETIVO) / base.width);
        }
        var vp = pag.getViewport({ scale: estado.escala });
        estado.viewports[n - 1] = vp;

        var hoja = document.createElement('div');
        hoja.className = 'vis-hoja';
        hoja.dataset.pagina = String(n - 1);
        hoja.style.width = Math.round(vp.width) + 'px';
        hoja.style.height = Math.round(vp.height) + 'px';

        var num = document.createElement('span');
        num.className = 'vis-num';
        num.textContent = String(n);
        hoja.appendChild(num);
        hojas.appendChild(hoja);

        pendientes.set(hoja, (function (pagina, vista, destino) {
          return function () {
            var lienzo = document.createElement('canvas');
            lienzo.width = Math.round(vista.width);
            lienzo.height = Math.round(vista.height);
            lienzo.className = 'vis-lienzo';
            destino.insertBefore(lienzo, destino.firstChild);
            pagina.render({ canvasContext: lienzo.getContext('2d'), viewport: vista });
          };
        })(pag, vp, hoja));
        mirador.observe(hoja);

        if (estado.editable) hoja.addEventListener('pointerdown', clicEnHoja);
      }

      // =======================================================================
      // Coordenadas
      //
      // ⚠ Acá está todo el problema y por eso está aislado en dos funciones. La
      // pantalla mide en píxeles desde arriba-izquierda; el PDF en puntos desde
      // abajo-izquierda, y además la hoja puede venir rotada. Hacer la cuenta a
      // mano funciona con el primer documento y falla con el primero escaneado
      // al revés. `convertToPdfPoint` la hace bien.
      // =======================================================================
      function aPdf(pagina, xPx, yPx, anchoPx, altoPx) {
        var vp = estado.viewports[pagina];
        var a = vp.convertToPdfPoint(xPx, yPx + altoPx);
        var b = vp.convertToPdfPoint(xPx + anchoPx, yPx);
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

      function aviso(t, clase) {
        var e = document.getElementById('visMsg');
        if (!e) return;
        e.innerHTML = t ? '<div class="msg ' + (clase || 'err') + '">' + esc(t) + '</div>' : '';
        // Lo que sale bien se borra solo; lo que sale mal se queda hasta que
        // alguien haga algo al respecto.
        if (t && clase === 'ok') setTimeout(function () { e.innerHTML = ''; }, 6000);
      }

      // ---- las marcas que ya hay ----
      async function traerMarcas() {
        try {
          var d = await post('/firmar/marcas', {});
          estado.marcas = (d.marcas || []).filter(function (m) {
            return estado.viewports[m.pagina];
          });
        } catch (e) { estado.marcas = []; }
        pintar();
        // Agregar una inicial cambia lo que el documento le pide, y con eso el
        // aviso de qué le falta cargar. El panel se entera por acá.
        if (op.alCambiar) op.alCambiar(estado.marcas.filter(function (m) { return m.mia; }));
      }

      function pintar() {
        hojas.querySelectorAll('.vis-marca').forEach(function (n) { n.remove(); });
        estado.marcas.forEach(function (m) {
          var hoja = hojas.querySelector('.vis-hoja[data-pagina="' + m.pagina + '"]');
          if (!hoja) return;
          var p = aPantalla(m.pagina, m);

          var el = document.createElement('div');
          el.className = 'vis-marca' + (m.mia ? ' mia' : ' ajena');
          el.dataset.id = m.id;
          el.style.left = p.x + 'px';
          el.style.top = p.y + 'px';
          el.style.width = p.ancho + 'px';
          el.style.height = p.alto + 'px';

          if (m.mia && estado.tiene[m.tipo]) {
            // Se ve la firma de verdad, no un rectángulo con una etiqueta. Es
            // el punto de toda la pantalla: que la persona vea cómo va a quedar
            // ANTES de firmar, no al abrir el PDF firmado.
            var img = document.createElement('img');
            img.src = '/firmar/rubrica/imagen?tipo=' + m.tipo + '&v=' + estado.version;
            img.alt = '';
            el.appendChild(img);
          } else {
            var t = document.createElement('span');
            t.className = 'vis-et';
            t.textContent = m.mia
              ? (m.tipo === 'firma' ? 'Tu firma' : 'Tu rúbrica')
              : ((m.firmante || 'Otro firmante').split(' ')[0]);
            el.appendChild(t);
          }

          if (estado.editable && m.mia) {
            el.classList.add('arrastrable');
            el.addEventListener('pointerdown', empezarArrastre);
            // Sólo se saca la que puso la persona. La del emisor se mueve.
            if (m.propia) {
              var x = document.createElement('button');
              x.className = 'vis-quitar';
              x.type = 'button';
              x.title = 'Quitar';
              x.textContent = '×';
              x.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });
              x.addEventListener('click', function (ev) {
                ev.stopPropagation();
                quitar(m.id);
              });
              el.appendChild(x);
            }
          }
          hoja.appendChild(el);
        });
      }

      // ---- arrastrar ----
      var arr = null;
      function empezarArrastre(ev) {
        if (!estado.editable) return;
        ev.preventDefault();
        ev.stopPropagation();
        var el = ev.currentTarget;
        var hoja = el.parentElement;
        var r = el.getBoundingClientRect();
        arr = {
          el: el, hoja: hoja,
          id: el.dataset.id,
          dx: ev.clientX - r.left, dy: ev.clientY - r.top,
          ancho: r.width, alto: r.height,
        };
        el.setPointerCapture(ev.pointerId);
        el.classList.add('moviendo');
        el.addEventListener('pointermove', moverArrastre);
        el.addEventListener('pointerup', soltarArrastre);
        el.addEventListener('pointercancel', soltarArrastre);
      }

      function moverArrastre(ev) {
        if (!arr) return;
        ev.preventDefault();
        var rh = arr.hoja.getBoundingClientRect();
        // Se le impide salirse de la hoja: una marca fuera de la página no se
        // estampa en ningún lado y no hay forma de que la persona lo note.
        var x = Math.max(0, Math.min(rh.width - arr.ancho, ev.clientX - rh.left - arr.dx));
        var y = Math.max(0, Math.min(rh.height - arr.alto, ev.clientY - rh.top - arr.dy));
        arr.el.style.left = x + 'px';
        arr.el.style.top = y + 'px';
      }

      async function soltarArrastre(ev) {
        if (!arr) return;
        var a = arr; arr = null;
        a.el.classList.remove('moviendo');
        a.el.removeEventListener('pointermove', moverArrastre);
        a.el.removeEventListener('pointerup', soltarArrastre);
        a.el.removeEventListener('pointercancel', soltarArrastre);

        var pagina = Number(a.hoja.dataset.pagina);
        var p = aPdf(pagina, parseFloat(a.el.style.left), parseFloat(a.el.style.top), a.ancho, a.alto);
        try {
          await post('/firmar/marca', { marca_id: a.id, x: p.x, y: p.y });
          aviso('');
        } catch (e) {
          aviso(e.message);
        }
        // Se vuelve a leer del servidor y no se confía en lo que quedó en
        // pantalla: si la escritura falló, lo que se ve tiene que ser lo que
        // hay guardado, no lo que la mano arrastró.
        await traerMarcas();
      }

      // =======================================================================
      // Los campos del documento, SOBRE la hoja
      //
      // ⚠ Estaban en una lista en el panel de la derecha, y era el diseño
      // equivocado. Lo dijo el primer documento con formulario que se probó:
      // «no me deja editar ningún campo, cuando toco, el botón del mouse pone
      // la firma».
      //
      // Dos cosas fallaban a la vez, y las dos son la misma:
      //
      //  · El gesto natural sobre un formulario es tocar el renglón donde hay
      //    que escribir. Acá ese toque colocaba una firma. La pantalla castigaba
      //    exactamente lo que cualquiera iba a hacer primero, y encima dejaba
      //    una marca estampada que después había que ir a sacar.
      //
      //  · «Cargo» no significa nada solo. Significa algo abajo de «Nombre
      //    completo», en la sección del representante. Sacar el campo de su
      //    lugar le saca la mitad del sentido, y quien completa a ciegas
      //    completa mal — sobre un documento que después firma.
      //
      // El PDF ya dice dónde va cada dato: trae el rectángulo de cada campo.
      // Lo único que faltaba era creerle. Es el mismo motor de coordenadas que
      // las marcas, así que no hay una segunda forma de convertir puntos.
      //
      // ⚠ El valor vive en UN solo lugar: este input y el servidor. El panel de
      // la derecha no guarda una copia — sólo se entera de qué falta, por
      // `op.alCambiarCampos`. Duplicar estado acá ya nos costó dos síntomas
      // distintos con el tipo de marca; no se repite.
      // =======================================================================
      var CONTROLES = {
        casilla: 'casilla', opcion: 'opcion', parrafo: 'parrafo',
        fecha: 'fecha', texto: 'texto', numero: 'texto', moneda: 'texto',
      };

      async function traerCampos() {
        if (!op.campos) return;
        var lista;
        try { lista = await op.campos(); } catch (e) { return; }
        estado.campos = (lista || []).filter(function (c) {
          return estado.viewports[c.pagina];
        });
        pintarCampos();
        repasarCampos();
      }

      function pintarCampos() {
        hojas.querySelectorAll('.vis-campo').forEach(function (n) { n.remove(); });
        estado.campos.forEach(function (c) {
          var hoja = hojas.querySelector('.vis-hoja[data-pagina="' + c.pagina + '"]');
          if (!hoja) return;
          var p = aPantalla(c.pagina, c);

          var el = document.createElement('div');
          el.className = 'vis-campo' + (c.mio ? ' mio' : ' ajeno');
          el.dataset.campo = c.id;
          el.style.left = p.x + 'px';
          el.style.top = p.y + 'px';
          el.style.width = p.ancho + 'px';
          el.style.height = p.alto + 'px';
          el.title = c.etiqueta + (c.obligatorio ? ' (obligatorio)' : '');

          // El campo de otro se ve, con lo que haya escrito, y no se toca. Es
          // la misma regla que la marca ajena: mostrar el documento como va a
          // quedar, sin ofrecer tocar lo que no es de uno.
          if (!c.mio || !estado.editable) {
            var v = document.createElement('span');
            v.className = 'vis-campo-fijo';
            v.textContent = c.valor != null && c.valor !== ''
              ? (c.tipo === 'casilla' ? '✓' : String(c.valor))
              : '';
            v.style.fontSize = tamanoLetra(p) + 'px';
            el.appendChild(v);
            hoja.appendChild(el);
            return;
          }

          var ctrl = armarControl(c, p);
          // Sin esto, escribir en un campo también colocaría una firma: el
          // `pointerdown` sube hasta la hoja, que es la que la coloca.
          ctrl.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });
          ctrl.addEventListener('click', function (ev) { ev.stopPropagation(); });

          if (c.congelado) {
            ctrl.disabled = true;
            el.classList.add('congelado');
          } else {
            var evento = (c.tipo === 'casilla' || c.tipo === 'opcion' || c.tipo === 'fecha')
              ? 'change' : 'blur';
            ctrl.addEventListener(evento, function () { guardar(c, ctrl, el); });
          }

          el.appendChild(ctrl);
          if (c.obligatorio) {
            var ast = document.createElement('span');
            ast.className = 'vis-campo-obl';
            ast.textContent = '*';
            el.appendChild(ast);
          }
          hoja.appendChild(el);
        });
        marcarFaltantes();
      }

      function tamanoLetra(p) {
        return Math.round(Math.max(9, Math.min(15, p.alto * 0.58)));
      }

      function armarControl(c, p) {
        var clase = CONTROLES[c.tipo] || 'texto';
        var v = c.valor == null ? '' : String(c.valor);
        var el;

        if (clase === 'casilla') {
          el = document.createElement('input');
          el.type = 'checkbox';
          el.checked = !!v;
          return el;
        }
        if (clase === 'opcion') {
          el = document.createElement('select');
          var vacia = document.createElement('option');
          vacia.value = ''; vacia.textContent = '—';
          el.appendChild(vacia);
          (Array.isArray(c.opciones) ? c.opciones : []).forEach(function (o) {
            var op2 = document.createElement('option');
            op2.value = o; op2.textContent = o;
            if (v === o) op2.selected = true;
            el.appendChild(op2);
          });
        } else if (clase === 'parrafo') {
          el = document.createElement('textarea');
          el.value = v;
          el.maxLength = 2000;
        } else {
          el = document.createElement('input');
          el.type = clase === 'fecha' ? 'date' : 'text';
          el.value = v;
          el.maxLength = 500;
        }
        el.style.fontSize = tamanoLetra(p) + 'px';
        return el;
      }

      function leerControl(c, ctrl) {
        if (c.tipo === 'casilla') return ctrl.checked ? 'sí' : '';
        return String(ctrl.value || '');
      }

      async function guardar(c, ctrl, el) {
        var v = leerControl(c, ctrl);
        if (v === (c.valor == null ? '' : String(c.valor))) return;   // no cambió
        el.classList.remove('mal');
        try {
          await op.guardarCampo(c.id, v === '' ? null : v);
          c.valor = v === '' ? null : v;
          aviso('');
          el.classList.add('guardado');
          setTimeout(function () { el.classList.remove('guardado'); }, 1200);
        } catch (e) {
          el.classList.add('mal');
          aviso(e.message);
        }
        repasarCampos();
        marcarFaltantes();
      }

      /** Los obligatorios sin completar se ven en la hoja, no sólo en el panel. */
      function marcarFaltantes() {
        estado.campos.forEach(function (c) {
          if (!c.mio || !c.obligatorio) return;
          var el = hojas.querySelector('.vis-campo[data-campo="' + c.id + '"]');
          if (!el) return;
          var falta = c.valor == null || String(c.valor).trim() === '';
          el.classList.toggle('falta', falta && !c.congelado);
        });
      }

      function repasarCampos() {
        if (!op.alCambiarCampos) return;
        op.alCambiarCampos(estado.campos.filter(function (c) {
          return c.mio && c.obligatorio && !c.congelado &&
                 (c.valor == null || String(c.valor).trim() === '');
        }).map(function (c) { return { id: c.id, etiqueta: c.etiqueta }; }));
      }

      // ---- agregar ----
      async function clicEnHoja(ev) {
        if (!estado.editable) return;
        if (ev.target.closest('.vis-marca')) return;
        // Un campo es un lugar donde se escribe, no donde se firma.
        if (ev.target.closest('.vis-campo')) return;
        var hoja = ev.currentTarget;
        var pagina = Number(hoja.dataset.pagina);
        var vp = estado.viewports[pagina];

        // ⚠ El tipo elegido se PREGUNTA en el momento del clic; no se guarda acá.
        //
        // Antes el visor tenía su propia copia y la barra se la mandaba con
        // `elegirTipo`. Pero la barra se dibuja antes de que `montar()` termine
        // —el PDF tarda: descarga el worker y mide todas las hojas— así que los
        // clics de ese rato encontraban el visor en null, cambiaban el color del
        // botón y no cambiaban nada más. Resultado: el botón decía «Rúbrica», se
        // colocaba una firma, y la marca mostraba la imagen de la firma. Dos
        // síntomas, un solo estado duplicado.
        //
        // Con una función no hay dos copias que sincronizar: hay una sola, y es
        // la de quien dibuja el botón.
        var tipo = (op.tipoActual && op.tipoActual()) || 'firma';
        var t = TAMANO[tipo] || TAMANO.firma;

        var ya = estado.marcas.some(function (m) {
          return m.mia && m.pagina === pagina && m.tipo === tipo;
        });
        if (ya) {
          return aviso('En esta hoja ya tenés ' +
            (tipo === 'firma' ? 'tu firma' : 'tu inicial') + '. Arrastrala para acomodarla.');
        }

        // El clic queda en el CENTRO de la marca: es lo que la mano espera.
        var r = hoja.getBoundingClientRect();
        var anchoPx = t.ancho * estado.escala, altoPx = t.alto * estado.escala;
        var xPx = Math.max(0, Math.min(vp.width - anchoPx, ev.clientX - r.left - anchoPx / 2));
        var yPx = Math.max(0, Math.min(vp.height - altoPx, ev.clientY - r.top - altoPx / 2));
        var p = aPdf(pagina, xPx, yPx, anchoPx, altoPx);

        try {
          await post('/firmar/marca/agregar', {
            tipo: tipo, pagina: pagina,
            x: p.x, y: p.y, ancho: p.ancho, alto: p.alto,
          });
          aviso('');
        } catch (e) { aviso(e.message); }
        await traerMarcas();
      }

      async function quitar(id) {
        try {
          await post('/firmar/marca/quitar', { marca_id: id });
          aviso('');
        } catch (e) { aviso(e.message); }
        await traerMarcas();
      }

      await traerMarcas();
      await traerCampos();

      /**
       * La misma marca en todas las hojas, abajo a la derecha.
       *
       * ⚠ La esquina se calcula HOJA POR HOJA con `convertToPdfPoint`, no una
       * vez y se repite. Un documento escaneado puede traer hojas de distinto
       * tamaño y alguna rotada, y «abajo a la derecha» no es el mismo punto en
       * todas. Es la misma convención que usa el editor del emisor desde la 031:
       * treinta puntos de margen, que es donde se rubrica a mano.
       */
      async function enTodasLasHojas(tipo) {
        var t = TAMANO[tipo] || TAMANO.rubrica;
        var hojas = [];
        for (var pg = 0; pg < estado.paginas; pg++) {
          var vp = estado.viewports[pg];
          if (!vp) continue;
          var esq = vp.convertToPdfPoint(vp.width - (t.ancho + 30) * estado.escala,
                                         vp.height - 30 * estado.escala);
          hojas.push({ pagina: pg, x: esq[0], y: esq[1], ancho: t.ancho, alto: t.alto });
        }
        if (!hojas.length) return aviso('Todavía se está abriendo el documento.');

        try {
          var r = await post('/firmar/marca/todas', { tipo: tipo, hojas: hojas });
          aviso(
            r.puestas === 0
              ? 'Ya estaba en todas las hojas.'
              : (tipo === 'firma' ? 'Tu firma' : 'Tu inicial') + ' quedó en ' + r.puestas +
                ' hoja(s).' + (r.salteadas ? ' En ' + r.salteadas + ' ya había una y no se tocó.' : ''),
            'ok',
          );
        } catch (e) { aviso(e.message); }
        await traerMarcas();
      }

      async function limpiarMisMarcas() {
        try {
          var r = await post('/firmar/marca/limpiar', {});
          aviso(r.quitadas
            ? 'Saqué ' + r.quitadas + ' marca(s) tuya(s). Las que reservó el emisor quedan.'
            : 'No tenías ninguna marca puesta por vos.', 'ok');
        } catch (e) { aviso(e.message); }
        await traerMarcas();
      }

      return {
        enTodasLasHojas: enTodasLasHojas,
        limpiarMisMarcas: limpiarMisMarcas,
        paginas: function () { return estado.paginas; },
        /** Cuántos campos tiene que completar quien mira. 0 = no le piden nada. */
        cuantosCampos: function () {
          return estado.campos.filter(function (c) { return c.mio; }).length;
        },
        /**
         * Lleva la vista al campo y le da el foco.
         *
         * ⚠ Es lo que hace que el aviso «falta completar X» sirva de algo. Un
         * documento de veinte hojas con el campo que falta en la catorce
         * convierte «falta completar» en una adivinanza: la persona sabe qué
         * falta y no dónde, que es la mitad inútil del dato.
         */
        irACampo: function (id) {
          var el = hojas.querySelector('.vis-campo[data-campo="' + id + '"]');
          if (!el) return false;
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          el.classList.add('senalado');
          setTimeout(function () { el.classList.remove('senalado'); }, 1600);
          var c = el.querySelector('input,select,textarea');
          if (c) setTimeout(function () { c.focus(); }, 400);
          return true;
        },
        /** El panel avisa qué imágenes hay, para dibujarlas adentro de las marcas. */
        avisarImagenes: function (tiene, version) {
          estado.tiene = tiene || { firma: false, rubrica: false };
          estado.version = version || Date.now();
          pintar();
        },
        cuantasMias: function () {
          return estado.marcas.filter(function (m) { return m.mia; }).length;
        },
        cerrarEdicion: function () { estado.editable = false; pintar(); },
        recargar: traerMarcas,
      };
    },
  };
})();
