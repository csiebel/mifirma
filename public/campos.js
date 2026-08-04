/* ===========================================================================
   Los campos del documento: qué se completa, quién lo completa y cuándo.

   ═══ QUÉ PROBLEMA RESUELVE ═══

   «Antes de firmar necesito que pongas tu número de documento acá.» Hasta hoy
   eso no existía: el documento salía como estaba, y si faltaba un dato había
   que rehacer el PDF y volver a mandarlo.

   ═══ POR QUÉ EMPIEZA LEYENDO EL PDF Y NO DIBUJANDO CAJAS ═══

   Porque los documentos que la gente manda a firmar **ya son formularios**: un
   certificado médico, un formulario de visa, una declaración de impuestos.
   Traen sus campos declarados, con nombre y rectángulo exacto. Dibujar cajas
   encima de eso es trabajo repetido y queda peor alineado que el original.

   Así que primero se pregunta: ¿qué campos trae este archivo? Y de esos, ¿cuáles
   nos interesan y quién llena cada uno.

   ⚠ Detectar no es adoptar. El PDF puede traer cuarenta campos internos —los
   generadores de formularios los hacen— y convertirlos en cuarenta obligaciones
   para el firmante sin que nadie los mire sería peor que no tenerlos.

   ═══ LA REGLA QUE NO SE NEGOCIA ═══

   El valor se congela ANTES de firmar, con su hash, adentro de la misma
   transacción que la firma. Después de firmar no se toca: un campo editable
   sobre un documento firmado es un documento que dice cosas distintas según
   cuándo se lo mire. Eso lo hace `congelarCampos` en el servidor; acá sólo se
   decide qué campos hay.
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

  /**
   * Abre el editor de campos de un circuito.
   *
   * `firmantes` viene de la pantalla de preparación: son las personas entre las
   * que se reparte quién completa cada campo.
   */
  window.abrirCamposDelDocumento = async function (circuitoId, firmantes) {
    var estado = { campos: [], detectados: [], sinFormulario: false };

    abrirModal(
      '<h2>Campos del documento</h2>' +
      '<p class="sub">Datos que hay que completar antes de firmar. Cada uno lo llena ' +
      'alguien: vos ahora, o un firmante cuando le toque.</p>' +
      '<div id="cpCuerpo"><p style="color:var(--mut);font-size:14px">Leyendo el documento…</p></div>' +
      '<div id="cpErr"></div>' +
      '<div class="acc">' +
      '<button class="btn btn-s" id="cpVolver">Volver</button>' +
      '<button class="btn btn-p" id="cpOk">Guardar</button></div>'
    );
    var caja = document.querySelector('#modal .modal');
    if (caja) caja.classList.add('ancho');

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
          pagina: c.pagina, x: c.x, y: c.y, ancho: c.ancho, alto: c.alto,
          usos: Number(c.usos || 0),
        };
      });
    } catch (e) { aviso(e.message); }

    try {
      var det = await api('/circuitos/' + circuitoId + '/campos/detectar');
      estado.detectados = det.campos || [];
      estado.sinFormulario = !!det.sin_formulario;
    } catch (e) { estado.sinFormulario = true; }

    pintar();

    function pintar() {
      var sinAdoptar = estado.detectados.filter(function (d) {
        return !estado.campos.some(function (c) { return c.codigo === d.codigo; });
      });

      var html = '';

      // ── lo que el archivo trae y todavía no se adoptó ──
      if (sinAdoptar.length) {
        html +=
          '<div class="msg ok" style="margin:0 0 14px">Este documento ya trae <b>' +
          sinAdoptar.length + ' campo(s)</b> de formulario. Agregá los que quieras usar; ' +
          'los demás quedan como están y nadie los completa.' +
          // ⚠ Un formulario real trae doce campos y agregarlos de a uno son doce
          // toques antes de empezar a trabajar. Adoptarlos todos por omisión
          // sería peor —el PDF puede traer cuarenta internos— pero hacerlo en un
          // toque cuando la persona ya los miró no tiene ninguna contra.
          '<button class="btn btn-s chico" id="cpTodos" style="margin-top:10px">' +
          'Agregar los ' + sinAdoptar.length + '</button></div>' +
          '<table style="width:100%;margin-bottom:20px"><tbody>' +
          sinAdoptar.map(function (d, i) {
            return '<tr><td style="padding:7px 0;border-bottom:1px solid var(--line)">' +
              '<b>' + esc(d.etiqueta) + '</b>' +
              '<br><span style="font-size:12px;color:var(--mut)">' +
              tipoNombre(d.tipo) + ' · hoja ' + (d.pagina + 1) +
              (d.valor_actual ? ' · ya dice «' + esc(d.valor_actual) + '»' : '') +
              '</span></td>' +
              '<td style="padding:7px 0;border-bottom:1px solid var(--line);text-align:right">' +
              '<button class="btn btn-s chico" data-adoptar="' + i + '">Agregar</button>' +
              '</td></tr>';
          }).join('') +
          '</tbody></table>';
      } else if (estado.sinFormulario && !estado.campos.length) {
        html +=
          '<div class="msg aviso" style="margin:0 0 14px">Este PDF no trae campos de ' +
          'formulario. Podés agregarlos igual con <b>Agregar campo</b>; se dibujan sobre ' +
          'la hoja al firmar.</div>';
      }

      // ── los campos del circuito ──
      if (!estado.campos.length) {
        html += '<p style="color:var(--mut);font-size:14px;margin:16px 0">' +
          'Todavía no hay ningún campo. El documento se firma igual.</p>';
      } else {
        html += '<table style="width:100%"><tbody>' + estado.campos.map(filaCampo).join('') + '</tbody></table>';
      }

      html += '<button class="btn btn-s" id="cpAgregar" style="margin-top:14px">Agregar campo</button>';

      $('cpCuerpo').innerHTML = html;

      function adoptar(d) {
        estado.campos.push({
          codigo: d.codigo, etiqueta: d.etiqueta, tipo: d.tipo, opciones: d.opciones,
          // ⚠ Por omisión lo completa el PRIMER firmante, no el emisor.
          // Un campo de un formulario que se manda a firmar es, casi siempre,
          // un dato que aporta quien firma. Si fuera del emisor, lo cambia.
          completa_emisor: false, orden_firmante: 1, obligatorio: false,
          pagina: d.pagina, x: d.x, y: d.y, ancho: d.ancho, alto: d.alto, usos: 0,
        });
      }

      $('cpCuerpo').querySelectorAll('[data-adoptar]').forEach(function (b) {
        b.addEventListener('click', function () {
          adoptar(sinAdoptar[Number(b.dataset.adoptar)]);
          pintar();
        });
      });

      if ($('cpTodos')) {
        $('cpTodos').addEventListener('click', function () {
          sinAdoptar.forEach(adoptar);
          pintar();
        });
      }

      $('cpAgregar').addEventListener('click', function () {
        var n = estado.campos.length + 1;
        estado.campos.push({
          codigo: 'campo_' + n, etiqueta: 'Campo ' + n, tipo: 'texto', opciones: null,
          completa_emisor: false, orden_firmante: 1, obligatorio: false,
          pagina: 0, x: 60, y: 60, ancho: 200, alto: 20, usos: 0,
        });
        pintar();
      });

      enganchar();
    }

    function tipoNombre(t) {
      var f = TIPOS.filter(function (x) { return x[0] === t; })[0];
      return f ? f[1] : t;
    }

    function filaCampo(c, i) {
      var quien = c.completa_emisor ? 'emisor' : 'f' + (c.orden_firmante || 1);
      return '<tr><td colspan="2" style="padding:10px 0;border-bottom:1px solid var(--line)">' +
        '<div class="dos">' +
        '<div><label class="campo">Qué se pide</label>' +
        '<input data-et="' + i + '" maxlength="120" value="' + esc(c.etiqueta) + '" /></div>' +
        '<div><label class="campo">Tipo</label><select data-tipo="' + i + '">' +
        TIPOS.map(function (t) {
          return '<option value="' + t[0] + '"' + (c.tipo === t[0] ? ' selected' : '') + '>' + t[1] + '</option>';
        }).join('') + '</select></div>' +
        '</div>' +
        '<div class="dos" style="margin-top:8px">' +
        '<div><label class="campo">Quién lo completa</label><select data-quien="' + i + '">' +
        '<option value="emisor"' + (quien === 'emisor' ? ' selected' : '') + '>Yo, antes de enviar</option>' +
        (firmantes || []).map(function (p) {
          var v = 'f' + p.orden;
          return '<option value="' + v + '"' + (quien === v ? ' selected' : '') + '>' +
            esc(p.nombre || p.email) + ', al firmar</option>';
        }).join('') +
        '</select></div>' +
        '<div><label class="campo">&nbsp;</label>' +
        '<label class="permisos" style="display:block;padding-top:10px">' +
        '<input type="checkbox" data-obl="' + i + '"' + (c.obligatorio ? ' checked' : '') + ' /> ' +
        'Obligatorio</label></div>' +
        '</div>' +
        (c.tipo === 'opcion'
          ? '<label class="campo" style="margin-top:8px">Opciones, separadas por coma</label>' +
            '<input data-ops="' + i + '" value="' + esc((c.opciones || []).join(', ')) + '" />'
          : '') +
        '<div style="margin-top:8px;display:flex;justify-content:space-between;align-items:center">' +
        '<span style="font-size:12px;color:var(--mut)">' + esc(c.codigo) + ' · hoja ' + (c.pagina + 1) +
        (c.usos ? ' · <b>ya completado ' + c.usos + ' vez/veces</b>' : '') + '</span>' +
        '<button class="btn btn-d chico" data-borrar="' + i + '">Quitar</button>' +
        '</div></td></tr>';
    }

    function enganchar() {
      var c = $('cpCuerpo');
      c.querySelectorAll('[data-et]').forEach(function (el) {
        el.addEventListener('input', function () { estado.campos[+el.dataset.et].etiqueta = el.value; });
      });
      c.querySelectorAll('[data-tipo]').forEach(function (el) {
        el.addEventListener('change', function () {
          estado.campos[+el.dataset.tipo].tipo = el.value; pintar();
        });
      });
      c.querySelectorAll('[data-quien]').forEach(function (el) {
        el.addEventListener('change', function () {
          var campo = estado.campos[+el.dataset.quien];
          if (el.value === 'emisor') { campo.completa_emisor = true; campo.orden_firmante = null; }
          else { campo.completa_emisor = false; campo.orden_firmante = Number(el.value.slice(1)); }
        });
      });
      c.querySelectorAll('[data-obl]').forEach(function (el) {
        el.addEventListener('change', function () { estado.campos[+el.dataset.obl].obligatorio = el.checked; });
      });
      c.querySelectorAll('[data-ops]').forEach(function (el) {
        el.addEventListener('input', function () {
          estado.campos[+el.dataset.ops].opciones =
            el.value.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
        });
      });
      c.querySelectorAll('[data-borrar]').forEach(function (el) {
        el.addEventListener('click', function () {
          var campo = estado.campos[+el.dataset.borrar];
          if (campo.usos) {
            return aviso('Ese campo ya lo completó alguien. Quitarlo borraría lo que escribió.');
          }
          estado.campos.splice(+el.dataset.borrar, 1);
          aviso('');
          pintar();
        });
      });
    }

    $('cpOk').addEventListener('click', async function () {
      var b = $('cpOk');
      b.disabled = true;
      try {
        await api('/circuitos/' + circuitoId + '/campos', 'PUT', {
          campos: estado.campos.map(function (c, i) {
            return {
              codigo: c.codigo, etiqueta: c.etiqueta, tipo: c.tipo,
              opciones: c.tipo === 'opcion' ? (c.opciones || []) : null,
              completa_emisor: !!c.completa_emisor,
              orden_firmante: c.completa_emisor ? null : (c.orden_firmante || 1),
              obligatorio: !!c.obligatorio,
              pagina: c.pagina, x: c.x, y: c.y, ancho: c.ancho, alto: c.alto,
              orden: i + 1,
            };
          }),
        });
        volver();
      } catch (e) { b.disabled = false; aviso(e.message); }
    });
  };
})();
