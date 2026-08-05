/* ===========================================================================
   Los campos del documento: qué se pide, quién lo escribe y DÓNDE va.

   ═══ QUÉ PROBLEMA RESUELVE ═══

   «Antes de firmar necesito que pongas tu número de documento acá.» Hasta hoy
   eso no existía: el documento salía como estaba, y si faltaba un dato había que
   rehacer el PDF y volver a mandarlo.

   ═══ UNA SOLA PANTALLA, Y ES LA LECCIÓN DE ESTE ARCHIVO ═══

   La primera versión eran dos: una lista para definir los campos y otro modal
   para ubicarlos sobre la hoja. Se probó una vez y el veredicto fue exacto:

     «el campo no queda donde lo puse... y el editor está confuso, primero hay
      que cargar los campos y luego ubicarlos, no supe mucho cómo usarlo»

   Las dos quejas son la misma cosa. Partir una tarea en dos pantallas que van y
   vienen obliga a llevar en la cabeza en cuál estás y qué te falta; y además
   escondía un defecto de verdad: al volver a la lista se releían los campos del
   servidor, y eso pisaba las coordenadas recién dibujadas. Lo que se acababa de
   hacer desaparecía sin decir nada.

   Ahora hay **una** pantalla: la lista a la izquierda, la hoja a la derecha, y
   un solo Guardar. Las dos columnas miran el MISMO array, así que no hay forma
   de que una pise a la otra.

   ═══ DETECTAR NO ES ADOPTAR ═══

   Un PDF que ya es formulario trae sus campos con nombre y rectángulo exacto: se
   ofrecen para agregar, no se agregan solos. Un generador de formularios puede
   dejar cuarenta campos internos, y convertirlos en cuarenta obligaciones para
   el firmante sin que nadie los mire sería peor que no tenerlos.

   ═══ LA REGLA QUE NO SE NEGOCIA ═══

   El valor se congela ANTES de firmar, con su hash, adentro de la misma
   transacción que la firma. Después no se toca: un campo editable sobre un
   documento firmado es un documento que dice cosas distintas según cuándo se lo
   mire. Eso lo hace `congelarCampos` en el servidor; acá sólo se decide qué
   campos hay y dónde van.
   =========================================================================== */
(function () {
  'use strict';

  function ui() { return window.uiMiFirma || {}; }
  function $(id) { return ui().$(id); }
  function esc(s) { return ui().esc(s); }
  function api(p, m, b) { return ui().api(p, m, b); }
  function abrirModal(h) { return ui().abrirModal(h); }

  var TIPOS = [
    ['texto', 'Texto'],
    ['parrafo', 'Párrafo'],
    ['numero', 'Número'],
    ['fecha', 'Fecha'],
    ['moneda', 'Importe'],
    ['casilla', 'Sí / No'],
    ['opcion', 'Lista de opciones'],
  ];

  window.abrirCamposDelDocumento = async function (circuitoId, firmantes, instanciaId) {
    var estado = { campos: [], detectados: [], sinFormulario: false, sel: -1 };
    var HOJA = null;                 // el motor de cajas, cuando cargue
    firmantes = firmantes || [];

    abrirModal(
      '<h2>Campos del documento</h2>' +
      '<p class="sub">Datos que hay que completar antes de firmar. De cada uno decidís ' +
      'tres cosas: <b>qué se pide</b>, <b>quién lo escribe</b> y <b>dónde va</b> en la hoja.</p>' +
      (!firmantes.length
        ? '<div class="msg aviso" style="margin:0 0 12px">Este documento todavía no tiene ' +
          'firmantes, así que por ahora los campos sólo los podés completar vos. Si querés ' +
          'pedirle un dato a quien firma, agregá primero los firmantes.</div>'
        : '') +
      '<div id="cpErr"></div>' +

      '<div class="cp-dos">' +
      '  <div class="cp-lista" id="cpCuerpo">' +
      '    <p style="color:var(--mut);font-size:14px">Leyendo el documento…</p>' +
      '  </div>' +
      '  <div class="cp-hoja">' +
      '    <div class="cp-hoja-cab">' +
      '      <b>La hoja</b>' +
      '      <span id="cpPista">Tocá donde va un dato. Arrastralo para acomodarlo y ' +
      'tirá del cuadradito de la esquina para darle el ancho.</span>' +
      '    </div>' +
      '    <div class="cp-lienzo" id="cpLienzo">' +
      (instanciaId
        ? '<p style="color:var(--mut);font-size:13.5px;text-align:center;margin:28px 0">' +
          'Abriendo el documento…</p>'
        : '<p style="color:var(--mut);font-size:13.5px;text-align:center;margin:28px 0">' +
          'No pude identificar el archivo de este documento.</p>') +
      '    </div>' +
      '  </div>' +
      '</div>' +

      '<div class="acc">' +
      '<button class="btn btn-s" id="cpVolver">Cancelar</button>' +
      '<button class="btn btn-p" id="cpOk">Guardar campos</button></div>'
    );
    var modal = document.querySelector('#modal .modal');
    if (modal) modal.classList.add('ancho');

    function volver() {
      if (window.abrirCircuito) window.abrirCircuito(circuitoId);
    }
    $('cpVolver').addEventListener('click', volver);

    function aviso(t, clase) {
      $('cpErr').innerHTML = t ? '<div class="msg ' + (clase || 'err') + '">' + esc(t) + '</div>' : '';
    }

    // ---- lo que ya está definido, y lo que el archivo propone ----
    try {
      var ya = await api('/circuitos/' + circuitoId + '/campos');
      estado.campos = (ya.campos || []).map(function (c) {
        return {
          codigo: c.codigo, etiqueta: c.etiqueta, tipo: c.tipo,
          opciones: c.opciones || null,
          completa_emisor: c.completa_emisor,
          orden_firmante: c.orden_firmante,
          obligatorio: c.obligatorio,
          pagina: c.pagina, x: Number(c.x), y: Number(c.y),
          ancho: Number(c.ancho), alto: Number(c.alto),
          usos: Number(c.usos || 0),
        };
      });
    } catch (e) { aviso(e.message); }

    try {
      var det = await api('/circuitos/' + circuitoId + '/campos/detectar');
      estado.detectados = det.campos || [];
      estado.sinFormulario = !!det.sin_formulario;
    } catch (e) { estado.sinFormulario = true; }

    pintarLista();

    // ---- la hoja, al lado ----
    if (instanciaId && window.cajasMiFirma) {
      HOJA = await window.cajasMiFirma.montar($('cpLienzo'), {
        instanciaId: instanciaId,
        campos: estado.campos,
        firmantes: firmantes,
        quienNueva: function () { return $('cpQuienNueva') ? $('cpQuienNueva').value : 'emisor'; },
        alTocar: function (i) { estado.sel = i; pintarLista(); },
        alMover: function () { pintarLista(); },
        alCrear: function (i) {
          estado.sel = i;
          pintarLista();
          // El campo nuevo se abre para escribirle el nombre: acabás de decir
          // DÓNDE va, y lo que falta es QUÉ pide.
          var et = $('et' + i);
          if (et) { et.focus(); et.select(); }
        },
      });
    }

    // =======================================================================
    // La lista
    // =======================================================================
    function pintarLista() {
      var sinAdoptar = estado.detectados.filter(function (d) {
        return !estado.campos.some(function (c) { return c.codigo === d.codigo; });
      });

      var html = '';

      if (sinAdoptar.length) {
        html +=
          '<div class="msg ok" style="margin:0 0 12px">Este PDF ya trae <b>' +
          sinAdoptar.length + ' campo(s)</b> de formulario, con su lugar exacto. ' +
          'Agregá los que quieras usar.' +
          '<button class="btn btn-s chico" id="cpTodos" style="margin-top:10px">' +
          'Agregar los ' + sinAdoptar.length + '</button></div>' +
          '<table style="width:100%;margin-bottom:16px"><tbody>' +
          sinAdoptar.map(function (d, i) {
            return '<tr><td style="padding:6px 0;border-bottom:1px solid var(--line)">' +
              '<b>' + esc(d.etiqueta) + '</b><br>' +
              '<span style="font-size:12px;color:var(--mut)">' + tipoNombre(d.tipo) +
              ' · hoja ' + (d.pagina + 1) +
              (d.valor_actual ? ' · ya dice «' + esc(d.valor_actual) + '»' : '') + '</span></td>' +
              '<td style="padding:6px 0;border-bottom:1px solid var(--line);text-align:right">' +
              '<button class="btn btn-s chico" data-adoptar="' + i + '">Agregar</button>' +
              '</td></tr>';
          }).join('') + '</tbody></table>';
      }

      // ── de quién es el próximo campo que se dibuje ──
      html +=
        '<div class="cp-nueva">' +
        '<label class="campo" style="margin:0">Al tocar la hoja, agrego un campo</label>' +
        '<select id="cpQuienNueva">' +
        '<option value="emisor">que escribo yo</option>' +
        firmantes.map(function (p) {
          return '<option value="f' + p.orden + '">que escribe ' +
            esc(p.nombre || p.email) + '</option>';
        }).join('') +
        '</select></div>';

      if (!estado.campos.length) {
        html += '<p style="color:var(--mut);font-size:14px;margin:16px 0">' +
          (instanciaId
            ? 'Todavía no hay ningún campo. <b>Tocá la hoja de la derecha</b> donde tenga ' +
              'que ir un dato y se agrega ahí. El documento se firma igual sin ninguno.'
            : 'Todavía no hay ningún campo.') + '</p>';
      } else {
        html += estado.campos.map(filaCampo).join('');
      }

      $('cpCuerpo').innerHTML = html;
      enganchar(sinAdoptar);

      var s = $('cpSel');
      if (s) s.scrollIntoView({ block: 'nearest' });
    }

    function tipoNombre(t) {
      var f = TIPOS.filter(function (x) { return x[0] === t; })[0];
      return f ? f[1] : t;
    }

    function quienDe(c) {
      return c.completa_emisor ? 'emisor' : 'f' + (c.orden_firmante || 1);
    }

    function filaCampo(c, i) {
      var sel = i === estado.sel;
      return '<div class="cp-campo' + (sel ? ' sel' : '') + '"' + (sel ? ' id="cpSel"' : '') +
        ' data-fila="' + i + '">' +

        '<div class="cp-campo-cab">' +
        '<span class="cp-punto ' + (c.completa_emisor ? 'emisor' : 'firmante') + '"></span>' +
        '<input class="cp-et" id="et' + i + '" data-et="' + i + '" maxlength="120" ' +
        'placeholder="¿Qué se pide?" value="' + esc(c.etiqueta) + '" />' +
        (c.usos
          ? '<span class="cp-usos" title="Ya lo completó alguien: no se mueve ni se quita">' +
            'completado</span>'
          : '<button class="btn btn-d chico" data-borrar="' + i + '">Quitar</button>') +
        '</div>' +

        '<div class="cp-campo-fila">' +
        '<select data-tipo="' + i + '">' +
        TIPOS.map(function (t) {
          return '<option value="' + t[0] + '"' + (c.tipo === t[0] ? ' selected' : '') + '>' +
            t[1] + '</option>';
        }).join('') + '</select>' +

        '<select data-quien="' + i + '">' +
        '<option value="emisor"' + (quienDe(c) === 'emisor' ? ' selected' : '') +
        '>Lo escribo yo</option>' +
        firmantes.map(function (p) {
          var v = 'f' + p.orden;
          return '<option value="' + v + '"' + (quienDe(c) === v ? ' selected' : '') + '>' +
            'Se lo pido a ' + esc(p.nombre || p.email) + '</option>';
        }).join('') + '</select>' +

        '<label class="cp-obl"><input type="checkbox" data-obl="' + i + '"' +
        (c.obligatorio ? ' checked' : '') + ' /> Obligatorio</label>' +
        '</div>' +

        (c.tipo === 'opcion'
          ? '<input data-ops="' + i + '" class="cp-ops" placeholder="Opciones separadas por coma" ' +
            'value="' + esc((c.opciones || []).join(', ')) + '" />'
          : '') +

        '<div class="cp-campo-pie">' +
        '<span>hoja ' + (c.pagina + 1) + '</span>' +
        (instanciaId
          ? '<button class="btn btn-s chico" data-ir="' + i + '">Ver en la hoja</button>'
          : '') +
        '</div></div>';
    }

    function adoptar(d) {
      estado.campos.push({
        codigo: d.codigo, etiqueta: d.etiqueta, tipo: d.tipo, opciones: d.opciones,
        // ⚠ Por omisión lo completa el PRIMER firmante, no el emisor: un campo de
        // un formulario que se manda a firmar es, casi siempre, un dato que
        // aporta quien firma. Si no hay firmantes todavía, queda del emisor,
        // que es el único que puede.
        completa_emisor: !firmantes.length,
        orden_firmante: firmantes.length ? (firmantes[0].orden || 1) : null,
        obligatorio: false,
        pagina: d.pagina, x: d.x, y: d.y, ancho: d.ancho, alto: d.alto, usos: 0,
      });
    }

    function enganchar(sinAdoptar) {
      var c = $('cpCuerpo');

      c.querySelectorAll('[data-adoptar]').forEach(function (b) {
        b.addEventListener('click', function () {
          adoptar(sinAdoptar[Number(b.dataset.adoptar)]);
          estado.sel = estado.campos.length - 1;
          pintarLista();
          if (HOJA) { HOJA.pintar(); HOJA.irA(estado.sel); }
        });
      });
      if ($('cpTodos')) {
        $('cpTodos').addEventListener('click', function () {
          sinAdoptar.forEach(adoptar);
          pintarLista();
          if (HOJA) HOJA.pintar();
        });
      }

      // ⚠ `input` y no `change` en la etiqueta: lo que se escribe se ve al
      // instante en la caja de la hoja. Es lo que ata las dos columnas — sin
      // eso, la lista y la hoja parecen dos cosas distintas.
      c.querySelectorAll('[data-et]').forEach(function (el) {
        el.addEventListener('input', function () {
          estado.campos[+el.dataset.et].etiqueta = el.value;
          if (HOJA) HOJA.pintar();
        });
        el.addEventListener('focus', function () {
          estado.sel = +el.dataset.et;
          if (HOJA) HOJA.irA(estado.sel);
          marcarSeleccion();
        });
      });

      c.querySelectorAll('[data-tipo]').forEach(function (el) {
        el.addEventListener('change', function () {
          estado.campos[+el.dataset.tipo].tipo = el.value;
          estado.sel = +el.dataset.tipo;
          pintarLista();
          if (HOJA) HOJA.pintar();
        });
      });
      c.querySelectorAll('[data-quien]').forEach(function (el) {
        el.addEventListener('change', function () {
          var campo = estado.campos[+el.dataset.quien];
          if (el.value === 'emisor') { campo.completa_emisor = true; campo.orden_firmante = null; }
          else { campo.completa_emisor = false; campo.orden_firmante = Number(el.value.slice(1)); }
          pintarLista();
          if (HOJA) HOJA.pintar();
        });
      });
      c.querySelectorAll('[data-obl]').forEach(function (el) {
        el.addEventListener('change', function () {
          estado.campos[+el.dataset.obl].obligatorio = el.checked;
        });
      });
      c.querySelectorAll('[data-ops]').forEach(function (el) {
        el.addEventListener('input', function () {
          estado.campos[+el.dataset.ops].opciones =
            el.value.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
        });
      });
      c.querySelectorAll('[data-ir]').forEach(function (el) {
        el.addEventListener('click', function () {
          estado.sel = +el.dataset.ir;
          if (HOJA) HOJA.irA(estado.sel);
          marcarSeleccion();
        });
      });
      c.querySelectorAll('[data-borrar]').forEach(function (el) {
        el.addEventListener('click', function () {
          var campo = estado.campos[+el.dataset.borrar];
          if (campo.usos) {
            return aviso('Ese campo ya lo completó alguien. Quitarlo borraría lo que escribió.');
          }
          estado.campos.splice(+el.dataset.borrar, 1);
          estado.sel = -1;
          aviso('');
          pintarLista();
          if (HOJA) HOJA.pintar();
        });
      });
      c.querySelectorAll('[data-fila]').forEach(function (el) {
        el.addEventListener('click', function (ev) {
          if (ev.target.closest('button')) return;
          estado.sel = +el.dataset.fila;
          if (HOJA) HOJA.irA(estado.sel);
          marcarSeleccion();
        });
      });
    }

    /** Resalta sin repintar: repintar mientras se escribe se lleva el foco. */
    function marcarSeleccion() {
      $('cpCuerpo').querySelectorAll('[data-fila]').forEach(function (el) {
        el.classList.toggle('sel', +el.dataset.fila === estado.sel);
      });
    }

    // =======================================================================
    // Guardar — uno solo, y guarda TODO: qué pide, quién lo escribe y dónde va
    // =======================================================================
    $('cpOk').addEventListener('click', async function () {
      var sinNombre = estado.campos.filter(function (c) { return !String(c.etiqueta || '').trim(); });
      if (sinNombre.length) {
        return aviso('Hay ' + sinNombre.length + ' campo(s) sin nombre. Escribí qué se pide en ' +
          'cada uno: es lo que va a leer quien lo complete.');
      }

      var b = $('cpOk');
      var antes = b.textContent;
      b.disabled = true; b.textContent = 'Guardando…';
      try {
        await api('/circuitos/' + circuitoId + '/campos', 'PUT', {
          campos: estado.campos.map(function (c, i) {
            return {
              codigo: c.codigo, etiqueta: c.etiqueta, tipo: c.tipo,
              opciones: c.tipo === 'opcion' ? (c.opciones || []) : null,
              completa_emisor: !!c.completa_emisor,
              orden_firmante: c.completa_emisor ? null : (c.orden_firmante || 1),
              obligatorio: !!c.obligatorio,
              pagina: c.pagina,
              x: +Number(c.x).toFixed(2), y: +Number(c.y).toFixed(2),
              ancho: +Number(c.ancho).toFixed(2), alto: +Number(c.alto).toFixed(2),
              orden: i + 1,
            };
          }),
        });
        volver();
      } catch (e) {
        b.disabled = false; b.textContent = antes;
        aviso(e.message);
      }
    });
  };
})();
