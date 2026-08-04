/* ===========================================================================
   Las DOS imágenes del firmante: la firma autógrafa y la inicial (rúbrica).

   ⚠ NINGUNA DE LAS DOS ES LA FIRMA. Son las imágenes que se estampan para que
   un humano reconozca de un vistazo quién firmó; el valor legal lo da el PAdES.
   El documento queda firmado igual sin ninguna. La pantalla lo dice con todas
   las letras y ese texto no se saca.

   ═══ POR QUÉ SON DOS Y NO UNA ═══

   Porque cumplen funciones distintas y la ley local las trata distinto. La
   firma completa va donde se cierra el acto; la inicial va en cada hoja, y es
   lo que prueba que quien firmó vio TODAS las hojas y no le cambiaron una en el
   medio. Un contrato de cuarenta hojas rubricado entero son cuarenta iniciales
   y una firma.

   ⚠ Y ES TODO O NADA: si el emisor pidió inicial en cada hoja y la persona sólo
   cargó su firma, `marcasDelFirmante` descarta el estampado ENTERO —no la mitad—
   porque un documento con la firma sí y las iniciales no parece a medio hacer y
   después hay que explicar qué pasó. Por eso esta pantalla mira qué pide el
   documento y lo dice antes, no después.

   ═══ POR QUÉ ESTÁ ACÁ Y NO EN EL PERFIL ═══

   Porque quien firma con un enlace no tiene perfil. Recibe un correo, abre un
   documento y firma; puede no volver nunca. Si sus imágenes se cargaran en una
   pantalla de configuración, buena parte de los firmantes de este producto
   firmarían siempre sin nada estampado — que es exactamente lo que pasaba.

   Lo que carga acá queda en SU identidad, no en este documento: la próxima vez
   que le manden algo ya las tiene, y si abre cuenta se las encuentra cargadas.

   ═══ POR QUÉ EL RECORTE Y LA TRANSPARENCIA SE HACEN ACÁ ═══

   Porque el `canvas` ya sabe hacerlo y el servidor no. Hacerlo del otro lado
   obliga a sumar una dependencia nativa en el camino de un archivo subido por
   un desconocido. Acá es aritmética sobre píxeles que el navegador ya tiene en
   memoria. El servidor igual valida lo que llega: que sea PNG de verdad, que
   mida algo creíble, que no venga vacío.
   =========================================================================== */
(function () {
  'use strict';

  // Umbrales de luminancia para separar tinta de papel. Entre los dos hay una
  // rampa en vez de un corte: sin ella el trazo queda con borde de sierra y se
  // nota impreso. Calibrados para una foto de lapicera sobre papel blanco con
  // luz de ambiente; una foto oscura se recupera con el botón de contraste.
  var TINTA = 140;
  var PAPEL = 205;

  var ETIQUETA = {
    firma:   { titulo: 'Tu firma autógrafa',
               ayuda: 'La firma completa, la que va donde se cierra el documento.' },
    rubrica: { titulo: 'Tu inicial',
               ayuda: 'La versión corta, la que se pone en cada hoja para dejar constancia ' +
                      'de que las viste todas.' },
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /**
   * Deja transparente todo lo que sea papel y recorta al trazo.
   *
   * Devuelve un canvas nuevo, o null si no encontró tinta — que es un caso
   * real: una foto velada, o el pad sin dibujar.
   */
  function limpiar(fuente, ajuste) {
    var w = fuente.width, h = fuente.height;
    if (!w || !h) return null;

    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(fuente, 0, 0);

    var img = ctx.getImageData(0, 0, w, h);
    var d = img.data;
    var tinta = TINTA + (ajuste || 0);
    var papel = PAPEL + (ajuste || 0);
    var minX = w, minY = h, maxX = -1, maxY = -1;

    for (var i = 0, p = 0; i < d.length; i += 4, p++) {
      // Luminancia percibida, no promedio: el ojo pesa mucho más el verde, y
      // con el promedio una firma azul se pierde antes que una negra.
      var lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      var a;
      if (lum <= tinta) a = 255;
      else if (lum >= papel) a = 0;
      else a = Math.round(255 * (papel - lum) / (papel - tinta));

      // Lo que ya venía transparente sigue transparente: si sube un PNG
      // recortado, esto no se lo arruina.
      if (d[i + 3] < 250) a = Math.min(a, d[i + 3]);
      d[i + 3] = a;

      if (a > 16) {
        var x = p % w, y = (p / w) | 0;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) return null;
    ctx.putImageData(img, 0, 0);

    // Recorte al trazo con dos píxeles de aire. Sin recorte, el rectángulo que
    // el emisor reservó se llena de vacío y la firma sale diminuta en el medio.
    var pad = 2;
    var rx = Math.max(0, minX - pad), ry = Math.max(0, minY - pad);
    var rw = Math.min(w, maxX + pad + 1) - rx, rh = Math.min(h, maxY + pad + 1) - ry;

    // El servidor rechaza menos de 40 × 20. Se agranda acá con el factor entero
    // más chico que alcance, en vez de devolverle un error a alguien que hizo
    // todo bien — una inicial de dos trazos entra fácil en ese caso.
    var factor = Math.max(1, Math.ceil(Math.max(40 / rw, 20 / rh)));
    var salida = document.createElement('canvas');
    salida.width = Math.min(4000, rw * factor);
    salida.height = Math.min(4000, rh * factor);
    var sctx = salida.getContext('2d');
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(c, rx, ry, rw, rh, 0, 0, salida.width, salida.height);
    return salida;
  }

  function aBlob(canvas) {
    return new Promise(function (res) { canvas.toBlob(res, 'image/png'); });
  }

  /**
   * El pad de dibujo.
   *
   * Con `pointer` y no con `mouse` + `touch`: un solo camino para dedo, lápiz y
   * mouse. `touch-action:none` no es opcional — sin él el navegador scrollea la
   * página en vez de dejar dibujar, que en un teléfono es todo el problema.
   */
  function montarPad(lienzo) {
    var ctx = lienzo.getContext('2d');
    var dibujando = false, hubo = false, ultimo = null;

    function medir() {
      var dpr = Math.min(3, window.devicePixelRatio || 1);
      var r = lienzo.getBoundingClientRect();
      var w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
      // Sólo si cambió: tocar width/height BORRA el canvas, y un `resize`
      // espurio del teclado del teléfono borraría la firma ya hecha.
      if (lienzo.width === w && lienzo.height === h) return;
      lienzo.width = w; lienzo.height = h;
      ctx.lineWidth = 2.6 * dpr;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#0f1e2c';
    }
    medir();
    window.addEventListener('resize', medir);

    function punto(ev) {
      var r = lienzo.getBoundingClientRect();
      return {
        x: (ev.clientX - r.left) * (lienzo.width / r.width),
        y: (ev.clientY - r.top) * (lienzo.height / r.height),
      };
    }

    lienzo.addEventListener('pointerdown', function (ev) {
      ev.preventDefault();
      lienzo.setPointerCapture(ev.pointerId);
      dibujando = true; hubo = true;
      ultimo = punto(ev);
      // Un toque sin arrastre tiene que dejar un punto, no nada.
      ctx.beginPath();
      ctx.arc(ultimo.x, ultimo.y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fillStyle = '#0f1e2c';
      ctx.fill();
    });
    lienzo.addEventListener('pointermove', function (ev) {
      if (!dibujando) return;
      ev.preventDefault();
      var p = punto(ev);
      ctx.beginPath();
      ctx.moveTo(ultimo.x, ultimo.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ultimo = p;
    });
    function soltar() { dibujando = false; }
    lienzo.addEventListener('pointerup', soltar);
    lienzo.addEventListener('pointercancel', soltar);
    lienzo.addEventListener('pointerleave', soltar);

    return {
      hayAlgo: function () { return hubo; },
      limpiar: function () { ctx.clearRect(0, 0, lienzo.width, lienzo.height); hubo = false; },
    };
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

  async function subir(canvas, tipo, origen) {
    var blob = await aBlob(canvas);
    if (!blob) throw new Error('No pude generar la imagen.');
    var fd = new FormData();
    // ⚠ El tipo va en un campo del formulario y NO en el camino: `PUBLICAS` en
    // el servidor compara la ruta exacta y una con parámetro no coincide, así
    // que el firmante externo recibiría 401. Y va ANTES del archivo, porque
    // `req.file()` sólo ve los campos que llegaron primero.
    fd.append('tipo', tipo);
    fd.append('origen', origen);
    fd.append('archivo', blob, tipo + '.png');

    var r = await fetch('/firmar/rubrica/cargar', {
      method: 'POST', credentials: 'same-origin', body: fd,
    });
    var txt = await r.text();
    var data;
    try { data = txt ? JSON.parse(txt) : {}; } catch (e) { data = { error: txt }; }
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    return data;
  }

  // ---------------------------------------------------------------------------
  // Lo que usa firmar.js
  // ---------------------------------------------------------------------------

  window.rubricaMiFirma = (function () {
    var raiz = null;
    var alCambiar = null;
    var tiene = { firma: false, rubrica: false };   // qué cargó
    var pide  = { firma: false, rubrica: false };   // qué le pide ESTE documento
    var abierta = { firma: true, rubrica: false };  // qué bloque está desplegado
    var version = 0;                                // rompe el caché de las <img>

    function avisar() {
      version = Date.now();
      if (alCambiar) alCambiar({ tiene: tiene, pide: pide, version: version });
    }

    /** Qué tipos le pide este documento, mirando SUS marcas. */
    async function leerPedidos() {
      pide = { firma: false, rubrica: false };
      try {
        var d = await post('/firmar/marcas', {});
        (d.marcas || []).forEach(function (m) { if (m.mia) pide[m.tipo] = true; });
      } catch (e) { /* si no se puede preguntar, no se pide nada */ }
      // Si el documento pide inicial, el bloque se abre solo: es la diferencia
      // entre que la persona se entere ahora o al ver el PDF sin nada.
      if (pide.rubrica) abierta.rubrica = true;
    }

    async function leerCargadas() {
      var d = await post('/firmar/rubrica', {});
      tiene = { firma: false, rubrica: false };
      (d.imagenes || []).forEach(function (i) { tiene[i.tipo] = true; });
    }

    function aviso(tipo, texto, clase) {
      var m = document.getElementById('rubMsg-' + tipo);
      if (m) m.innerHTML = texto
        ? '<div class="msg ' + (clase || 'err') + '">' + esc(texto) + '</div>' : '';
    }

    /** Un bloque: el de firma o el de inicial. Los dos funcionan igual. */
    function pintarBloque(tipo) {
      var caja = document.getElementById('rubBloque-' + tipo);
      if (!caja) return;
      var e = ETIQUETA[tipo];

      if (!abierta[tipo] && !tiene[tipo]) {
        caja.innerHTML =
          '<button type="button" class="rub-desplegar" id="rubAbrir-' + tipo + '">' +
          '+ Cargar ' + esc(e.titulo.toLowerCase()) + '</button>';
        document.getElementById('rubAbrir-' + tipo).addEventListener('click', function () {
          abierta[tipo] = true; pintarBloque(tipo);
        });
        return;
      }

      if (tiene[tipo]) {
        caja.innerHTML =
          '<label>' + esc(e.titulo) + '</label>' +
          '<div class="rub-hecha">' +
          '  <img alt="" src="/firmar/rubrica/imagen?tipo=' + tipo + '&amp;v=' + version + '" />' +
          '</div>' +
          '<div class="rub-acc">' +
          '  <button type="button" class="btn btn-s" id="rubCambiar-' + tipo + '">Cambiarla</button>' +
          '  <button type="button" class="btn btn-s" id="rubQuitar-' + tipo + '">Quitarla</button>' +
          '</div>' +
          '<div id="rubMsg-' + tipo + '"></div>';
        document.getElementById('rubCambiar-' + tipo).addEventListener('click', function () {
          tiene[tipo] = false; abierta[tipo] = true; pintarBloque(tipo);
        });
        document.getElementById('rubQuitar-' + tipo).addEventListener('click', async function () {
          try {
            await post('/firmar/rubrica/quitar', { tipo: tipo });
            tiene[tipo] = false; abierta[tipo] = true;
            pintarBloque(tipo); avisar();
          } catch (err) { aviso(tipo, err.message); }
        });
        return;
      }

      caja.innerHTML =
        '<label>' + esc(e.titulo) + '</label>' +
        '<p class="pista" style="margin-top:0">' + esc(e.ayuda) +
        ' Dibujala con el dedo o el mouse, o sacale una foto sobre papel blanco. ' +
        'Queda guardada para la próxima vez.</p>' +
        '<div class="rub-tabs">' +
        '  <button type="button" class="btn btn-p rub-tab" id="rubTabDib-' + tipo + '">Dibujarla</button>' +
        '  <button type="button" class="btn btn-s rub-tab" id="rubTabFoto-' + tipo + '">Subir una foto</button>' +
        '</div>' +
        '<div id="rubDib-' + tipo + '">' +
        '  <canvas id="rubPad-' + tipo + '" class="rub-pad"></canvas>' +
        '  <div class="rub-acc">' +
        '    <button type="button" class="btn btn-s" id="rubBorrar-' + tipo + '">Borrar</button>' +
        '    <button type="button" class="btn btn-p" id="rubGuardarDib-' + tipo + '">Guardar</button>' +
        '  </div>' +
        '</div>' +
        '<div id="rubFoto-' + tipo + '" class="hidden">' +
        '  <input type="file" id="rubArchivo-' + tipo + '" accept="image/*" capture="environment" />' +
        '  <div id="rubPrevia-' + tipo + '"></div>' +
        '</div>' +
        '<div id="rubMsg-' + tipo + '"></div>';

      var pad = montarPad(document.getElementById('rubPad-' + tipo));
      var pendiente = null, ajuste = 0;

      function verTab(cual) {
        document.getElementById('rubTabDib-' + tipo).className =
          'btn rub-tab ' + (cual === 'dib' ? 'btn-p' : 'btn-s');
        document.getElementById('rubTabFoto-' + tipo).className =
          'btn rub-tab ' + (cual === 'foto' ? 'btn-p' : 'btn-s');
        document.getElementById('rubDib-' + tipo).classList.toggle('hidden', cual !== 'dib');
        document.getElementById('rubFoto-' + tipo).classList.toggle('hidden', cual !== 'foto');
        aviso(tipo, '');
      }
      document.getElementById('rubTabDib-' + tipo).addEventListener('click', function () { verTab('dib'); });
      document.getElementById('rubTabFoto-' + tipo).addEventListener('click', function () { verTab('foto'); });
      document.getElementById('rubBorrar-' + tipo).addEventListener('click', function () {
        pad.limpiar(); aviso(tipo, '');
      });

      document.getElementById('rubGuardarDib-' + tipo).addEventListener('click', async function () {
        if (!pad.hayAlgo()) return aviso(tipo, 'Dibujala antes de guardar.');
        var l = limpiar(document.getElementById('rubPad-' + tipo), 0);
        if (!l) return aviso(tipo, 'No encontré ningún trazo. Probá de nuevo.');
        await guardar(l, 'dibujada', 'rubGuardarDib-' + tipo);
      });

      document.getElementById('rubArchivo-' + tipo).addEventListener('change', function (ev) {
        var f = ev.target.files && ev.target.files[0];
        if (!f) return;
        var img = new Image();
        img.onload = function () {
          URL.revokeObjectURL(img.src);
          // Se baja a un máximo razonable antes de procesar: una foto de 12 MP
          // son 48 MB de píxeles y un teléfono viejo se queda sin memoria.
          var maxLado = 1600;
          var f2 = Math.min(1, maxLado / Math.max(img.width, img.height));
          var base = document.createElement('canvas');
          base.width = Math.round(img.width * f2);
          base.height = Math.round(img.height * f2);
          base.getContext('2d').drawImage(img, 0, 0, base.width, base.height);
          pendiente = base; ajuste = 0;
          previa();
        };
        img.onerror = function () { aviso(tipo, 'No pude leer esa imagen.'); };
        img.src = URL.createObjectURL(f);
      });

      function previa() {
        var l = limpiar(pendiente, ajuste);
        var c2 = document.getElementById('rubPrevia-' + tipo);
        if (!l) {
          c2.innerHTML = '';
          return aviso(tipo, 'No encontré tinta en esa foto. Probá con más luz, o subí el contraste.');
        }
        aviso(tipo, '');
        c2.innerHTML =
          '<div class="rub-hecha"></div>' +
          '<div class="rub-acc">' +
          '  <button type="button" class="btn btn-s" id="rubMenos-' + tipo + '">−&nbsp;contraste</button>' +
          '  <button type="button" class="btn btn-s" id="rubMas-' + tipo + '">+&nbsp;contraste</button>' +
          '  <button type="button" class="btn btn-p" id="rubGuardarFoto-' + tipo + '">Guardar</button>' +
          '</div>';
        l.className = 'rub-previa';
        c2.querySelector('.rub-hecha').appendChild(l);

        // El ajuste corre los dos umbrales juntos: subirlo toma como tinta lo
        // que estaba en el gris del medio, que es lo que rescata una foto
        // sacada con poca luz.
        document.getElementById('rubMas-' + tipo).addEventListener('click', function () {
          ajuste = Math.min(80, ajuste + 20); previa();
        });
        document.getElementById('rubMenos-' + tipo).addEventListener('click', function () {
          ajuste = Math.max(-80, ajuste - 20); previa();
        });
        document.getElementById('rubGuardarFoto-' + tipo).addEventListener('click', async function () {
          var l2 = limpiar(pendiente, ajuste);
          if (!l2) return aviso(tipo, 'No encontré tinta en esa foto.');
          await guardar(l2, 'subida', 'rubGuardarFoto-' + tipo);
        });
      }

      async function guardar(canvas, origen, idBoton) {
        var b = document.getElementById(idBoton);
        var antes = b ? b.textContent : '';
        if (b) { b.disabled = true; b.textContent = 'Guardando…'; }
        try {
          await subir(canvas, tipo, origen);
          tiene[tipo] = true;
          version = Date.now();
          pintarBloque(tipo);
          avisar();
        } catch (err) {
          aviso(tipo, err.message);
          if (b) { b.disabled = false; b.textContent = antes; }
        }
      }
    }

    function pintarFalta() {
      var c = document.getElementById('rubFalta');
      if (!c) return;
      var faltan = [];
      if (pide.firma && !tiene.firma) faltan.push('tu firma');
      if (pide.rubrica && !tiene.rubrica) faltan.push('tu inicial');

      if (faltan.length) {
        // ⚠ Es TODO O NADA: falta una y no se estampa NINGUNA. Se dice así,
        // porque «va a faltar tu inicial» haría esperar un documento con la
        // firma puesta y las hojas sin inicialar, que no es lo que pasa.
        c.innerHTML =
          '<div class="rub-aviso">Este documento te pide ' + esc(faltan.join(' y ')) +
          '. Si firmás sin cargarla' + (faltan.length > 1 ? 's' : '') +
          ', el documento queda firmado igual y con la misma validez, pero ' +
          '<b>no se va a estampar ninguna de las dos</b>: o van todas o no va ninguna.</div>';
      } else if (!pide.firma && !pide.rubrica && !tiene.firma) {
        c.innerHTML =
          '<div class="rub-aviso">Nadie reservó un lugar para tu firma en este documento. ' +
          'Podés cargarla y ponerla vos donde quieras, tocando la hoja.</div>';
      } else {
        c.innerHTML = '';
      }
    }

    function pintarTodo() {
      raiz.innerHTML =
        '<div id="rubBloque-firma" class="rub-bloque"></div>' +
        '<div id="rubBloque-rubrica" class="rub-bloque"></div>' +
        '<div id="rubFalta"></div>';
      pintarBloque('firma');
      pintarBloque('rubrica');
      pintarFalta();
    }

    return {
      /**
       * Dibuja los dos bloques dentro de `caja`.
       *
       * `cb({tiene, pide, version})` se llama al montar y en cada alta o baja.
       * El visor lo usa para dibujar la imagen de verdad adentro de la marca.
       */
      montar: async function (caja, cb) {
        raiz = caja;
        alCambiar = cb;
        try {
          await leerCargadas();
        } catch (e) {
          // Si no se puede ni preguntar —enlace vencido, por ejemplo— no se
          // muestra nada: firmar sigue funcionando y el documento sale sin
          // imágenes, que es la decisión ya tomada.
          caja.innerHTML = '';
          avisar();
          return;
        }
        await leerPedidos();
        pintarTodo();
        avisar();
      },

      /**
       * El visor avisa cuando el firmante agregó o sacó una marca: cambia lo
       * que el documento le pide, y con eso el aviso de qué le falta.
       */
      revisarPedidos: async function () {
        await leerPedidos();
        pintarBloque('rubrica');
        pintarFalta();
      },

      tiene: function () { return tiene; },
      version: function () { return version; },
    };
  })();
})();
