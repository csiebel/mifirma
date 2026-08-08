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
    // ⚠ No lo completa nadie: es texto que escribís vos y se estampa en la hoja.
    // Sirve para decir QUÉ se está aceptando al lado de una casilla, que sobre
    // un PDF sin formulario se estampaba como una X sola sin nada que la
    // explique — un documento firmado con una marca que no prueba nada.
    ['etiqueta', 'Texto fijo (no lo completa nadie)'],
  ];

  window.abrirCamposDelDocumento = async function (circuitoId, firmantes, instanciaId) {
    var estado = {
      campos: [], detectados: [], sinFormulario: false, sel: -1,
      // ⚠ De quién es el PRÓXIMO campo que se dibuje. Vive acá y no en el
      // <select>, porque la lista se repinta cada vez que se agrega uno y el
      // desplegable se reconstruye con él.
      //
      // Ese era el defecto: elegías «que escribe Claudio», tocabas la hoja —el
      // primer campo salía bien—, la lista se repintaba, el desplegable volvía
      // solo a «que escribo yo», y el SEGUNDO campo quedaba del emisor. En la
      // pantalla de firma salía gris en vez de amarillo y no había forma de
      // completarlo. Reportado así: «al segundo no lo ponía en amarillo, quedaba
      // en gris, por lo que no pude terminar y firmar».
      //
      // Es la misma familia que el tipo de marca del 3 de agosto: un estado que
      // vive en el DOM y se pierde cuando el DOM se rehace.
      quienNueva: null,
    };
    var HOJA = null;                 // el motor de cajas, cuando cargue
    var estado_quienInicial = 'emisor';
    firmantes = firmantes || [];
    // ⚠ Por omisión, el PRIMER FIRMANTE y no el emisor. Un campo que se agrega a
    // un documento que se manda a firmar es, casi siempre, un dato que aporta
    // quien firma; es la misma regla que ya gobierna adoptar un campo del
    // formulario. Si no hay firmantes todavía, el emisor es el único que puede.
    estado_quienInicial = firmantes.length ? 'f' + (firmantes[0].posicion || 1) : 'emisor';

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
          quien_completa: c.quien_completa ||
            (c.completa_emisor ? 'emisor' : (c.posicion_firmante != null ? 'firmante' : 'cualquiera')),
          posicion_firmante: c.posicion_firmante,
          cuerpo: c.cuerpo == null ? null : Number(c.cuerpo),
          color: c.color || null,
          obligatorio: c.obligatorio,
          pagina: c.pagina, x: Number(c.x), y: Number(c.y),
          ancho: Number(c.ancho), alto: Number(c.alto),
          usos: Number(c.usos || 0),
          id: c.id || null,
          valor: c.valor_emisor == null ? '' : String(c.valor_emisor),
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
        // La barra de zoom va en el encabezado «La hoja», al lado del título:
        // adentro del lienzo se iría con el scroll justo cuando hace falta.
        zoomEn: document.querySelector('.cp-hoja-cab'),
        campos: estado.campos,
        firmantes: firmantes,
        quienNueva: quienNueva,
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
        // ⚠ Ya no está «que escribo yo». Un dato que pone el emisor y el
        // firmante sólo lee ES un texto fijo: son lo mismo visto desde el
        // documento, y tener las dos formas dejaba un estado intermedio —el
        // campo propio vacío que nadie completa— que trababa documentos.
        firmantes.map(function (p) {
          // ⚠ El valor es el LUGAR de la persona, no su turno.
          //
          // Con el turno, en paralelo los tres firmantes valían 'f1': las tres
          // opciones eran la misma, las tres quedaban marcadas como elegidas, y
          // el navegador mostraba la última. Elegías Ana y aparecía Carla.
          // Reportado así: «selecciono a quien se lo pido y siempre me muestra
          // el mismo». Ver la migración 055.
          var v = 'f' + p.posicion;
          return '<option value="' + v + '"' + (quienNueva() === v ? ' selected' : '') +
            '>que escribe ' + esc(p.nombre || p.email) + '</option>';
        }).join('') +
        (firmantes.length > 1
          ? '<option value="cualquiera"' + (quienNueva() === 'cualquiera' ? ' selected' : '') +
            '>que llena cualquiera de ellos</option>'
          : '') +
        (!firmantes.length
          ? '<option value="emisor" selected>de texto fijo</option>'
          : '') +
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

    /** De quién es el próximo campo. Una sola copia, en `estado`. */
    function quienNueva() {
      if (estado.quienNueva == null) estado.quienNueva = estado_quienInicial;
      return estado.quienNueva;
    }

    function tipoNombre(t) {
      var f = TIPOS.filter(function (x) { return x[0] === t; })[0];
      return f ? f[1] : t;
    }

    function quienDe(c) {
      if (c.quien_completa === 'emisor') return 'emisor';
      if (c.quien_completa === 'cualquiera') return 'cualquiera';
      return 'f' + (c.posicion_firmante || 1);
    }

    /** Traduce lo que se elige en el desplegable al modo que guarda la base. */
    function aplicarQuien(campo, valor) {
      if (valor === 'emisor') {
        campo.quien_completa = 'emisor';
        campo.completa_emisor = true; campo.posicion_firmante = null;
      } else if (valor === 'cualquiera') {
        campo.quien_completa = 'cualquiera';
        campo.completa_emisor = false; campo.posicion_firmante = null;
      } else {
        campo.quien_completa = 'firmante';
        campo.completa_emisor = false; campo.posicion_firmante = Number(String(valor).slice(1));
      }
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

        // Un texto fijo no pregunta quién lo completa ni si es obligatorio:
        // las dos preguntas no tienen sentido y ofrecerlas confunde.
        (c.tipo === 'etiqueta'
          ? '<span class="cp-fijo">Se estampa tal cual, nadie lo completa</span>'

          // ⚠ SIN FIRMANTES NO SE DIBUJA UN DESPLEGABLE VACÍO.
          //
          // Hasta acá, si el documento todavía no tenía a quién mandárselo,
          // este `select` salía con CERO opciones: un recuadro vacío, sin
          // rótulo, al lado de una casilla sin rótulo. Reportado así: «¿qué es
          // esa dropdown list que pusiste antes del checkbox, para qué es?».
          //
          // Es el mismo defecto del 4 de agosto —«no entiendo qué significa yo
          // antes de enviar y no hay otra opción»— con otra cara: un control
          // que ofrece una sola cosa, o ninguna, no es un control. Es una
          // afirmación, y se escribe.
          : !firmantes.length
          ? '<span class="cp-fijo">Lo completás vos: este documento todavía no ' +
            'tiene firmantes</span>'
          : '<select data-quien="' + i + '" title="Quién escribe este dato">' +
        firmantes.map(function (p) {
          // ⚠ El valor es el LUGAR de la persona, no su turno.
          //
          // Con el turno, en paralelo los tres firmantes valían 'f1': las tres
          // opciones eran la misma, las tres quedaban marcadas como elegidas, y
          // el navegador mostraba la última. Elegías Ana y aparecía Carla.
          // Reportado así: «selecciono a quien se lo pido y siempre me muestra
          // el mismo». Ver la migración 055.
          var v = 'f' + p.posicion;
          return '<option value="' + v + '"' + (quienDe(c) === v ? ' selected' : '') + '>' +
            'Se lo pido a ' + esc(p.nombre || p.email) + '</option>';
        }).join('') +
        // ⚠ «Lo llena cualquiera» y no «lo llenan todos»: el dato entra UNA vez.
        // Dos personas no pueden escribir en el mismo renglón del papel, y el
        // primero que lo complete lo deja fijo para los demás.
        (firmantes.length > 1
          ? '<option value="cualquiera"' + (quienDe(c) === 'cualquiera' ? ' selected' : '') +
            '>Lo llena cualquiera de ellos</option>'
          : '') +
        '</select>') +

        // ⚠ LA CASILLA DICE LO QUE HACE, EN UNA ORACIÓN.
        //
        // Decía «Obligatorio», y Claudio pidió que «se diga en algún lado que
        // ese checkbox es para que llenar ese campo sea obligatorio». Una
        // palabra sola al lado de una casilla obliga a adivinar de qué es
        // obligatorio: ¿el campo? ¿la firma? ¿mostrarlo?
        //
        // Va en su propio renglón y no apretada al final de la fila: ahí
        // competía por el ancho con dos desplegables y quedaba cortada.
        (c.tipo === 'etiqueta' ? '' :
          '<label class="cp-obl"><input type="checkbox" data-obl="' + i + '"' +
          (c.obligatorio ? ' checked' : '') + ' /> ' +
          '<span>Hay que completarlo para poder firmar</span></label>') +
        '</div>' +

        (c.tipo === 'opcion'
          ? '<input data-ops="' + i + '" class="cp-ops" placeholder="Opciones separadas por coma" ' +
            'value="' + esc((c.opciones || []).join(', ')) + '" />'
          : '') +

        // ⚠ Si el campo lo completás vos, el lugar donde escribirlo es ACÁ.
        //
        // «Lo escribo yo» existía desde el primer día del módulo y no llevaba a
        // ninguna parte: el campo quedaba definido, vacío, y el documento salía
        // así. Si además era obligatorio, el firmante veía un recuadro gris que
        // no podía completar y no había forma de terminar de firmar.
        //
        // Va en la misma fila y no en otra pantalla: definir el campo y decir
        // qué dice son la misma decisión, y separarlas fue el error que ya
        // costó rehacer el editor entero.
        (c.completa_emisor
          ? '<div class="cp-valor">' +
            '<label class="campo" style="margin:0">' +
            (c.tipo === 'etiqueta' ? 'El texto que se estampa' : 'Lo que va a decir') +
            '</label>' +
            valorHtml(c, i) +
            '</div>'
          : '') +

        // ⚠ CÓMO SE VE EL VALOR. Vacío = «se ajusta solo», que es lo que hacía
        // hasta ahora y lo que hace Acrobat con «auto». No se pone un número por
        // omisión: escribir uno obliga a acertarle a mano en cada recuadro, y la
        // cuenta automática ya le acierta. Un texto fijo también lo lleva: se
        // estampa igual que un valor.
        '<div class="cp-letra">' +
        '<label for="cpCuerpo' + i + '">Tamaño</label>' +
        '<input type="number" id="cpCuerpo' + i + '" min="4" max="72" step="0.5" ' +
        'data-cuerpo="' + i + '" placeholder="se ajusta solo" ' +
        'value="' + (c.cuerpo == null ? '' : c.cuerpo) + '" />' +
        '<label for="cpColor' + i + '">Color</label>' +
        '<input type="color" id="cpColor' + i + '" data-color="' + i + '" ' +
        'value="' + (c.color || '#000000') + '" />' +
        (c.color
          ? '<button class="btn btn-s chico" data-sincolor="' + i + '" ' +
            'title="Volver al color de siempre">Quitar color</button>'
          : '') +
        '</div>' +

        '<div class="cp-campo-pie">' +
        '<span>hoja ' + (c.pagina + 1) + '</span>' +
        // ⚠ «Uno para cada firmante» no es un modo de campo: es una forma de
        // crearlos. Dos personas no pueden escribir en el mismo renglón del
        // papel, así que si son tres cédulas hacen falta tres recuadros. Lo que
        // se ahorra es dibujarlos de a uno y renombrarlos.
        (c.quien_completa === 'firmante' && firmantes.length > 1 && !c.usos
          ? '<button class="btn btn-s chico" data-cada="' + i + '" ' +
            'title="Crear uno igual para cada firmante, apilados">Uno para cada firmante</button>'
          : '') +
        (instanciaId
          ? '<button class="btn btn-s chico" data-ir="' + i + '">Ver en la hoja</button>'
          : '') +
        '</div></div>';
    }

    /** El control con el que el emisor escribe SU valor, según el tipo. */
    function valorHtml(c, i) {
      var v = c.valor == null ? '' : String(c.valor);
      if (c.tipo === 'casilla') {
        return '<label class="cp-obl" style="padding-top:4px">' +
          '<input type="checkbox" data-val="' + i + '"' + (v ? ' checked' : '') + ' /> ' +
          'Sí, marcada</label>';
      }
      if (c.tipo === 'opcion') {
        return '<select data-val="' + i + '" class="cp-ops">' +
          '<option value="">— elegí</option>' +
          (c.opciones || []).map(function (o) {
            return '<option value="' + esc(o) + '"' + (v === o ? ' selected' : '') + '>' +
              esc(o) + '</option>';
          }).join('') + '</select>';
      }
      if (c.tipo === 'parrafo') {
        return '<textarea data-val="' + i + '" class="cp-ops" rows="2" ' +
          'placeholder="Lo que va a salir impreso">' + esc(v) + '</textarea>';
      }
      return '<input data-val="' + i + '" class="cp-ops" maxlength="500" ' +
        'type="' + (c.tipo === 'fecha' ? 'date' : 'text') + '" ' +
        'placeholder="Lo que va a salir impreso" value="' + esc(v) + '" />';
    }

    function adoptar(d) {
      estado.campos.push({
        codigo: d.codigo, etiqueta: d.etiqueta, tipo: d.tipo, opciones: d.opciones,
        // ⚠ Por omisión lo completa el PRIMER firmante, no el emisor: un campo de
        // un formulario que se manda a firmar es, casi siempre, un dato que
        // aporta quien firma. Si no hay firmantes todavía, queda del emisor,
        // que es el único que puede.
        completa_emisor: !firmantes.length,
        // ⚠ EL MODO SE ESCRIBE ACÁ, NO SE DEDUCE DESPUÉS.
        //
        // Faltaba, y el campo adoptado del formulario del PDF quedaba sin modo.
        // Todo lo que lo miraba tenía que adivinarlo por las otras dos columnas
        // —y casi todo adivinaba bien, así que no se notó—, menos el botón
        // «Uno para cada firmante», que pregunta por el modo derecho viejo y
        // por lo tanto no aparecía. Reportado así: «cuando es un pdf con campos
        // sólo aparece después de agregar un segundo campo».
        //
        // Es la MISMA falta que costó la 052: allá un texto fijo salía a nombre
        // de un firmante porque el modo no se había escrito. Un campo se crea
        // diciendo quién lo completa, en todos los caminos que crean campos.
        quien_completa: firmantes.length ? 'firmante' : 'emisor',
        posicion_firmante: firmantes.length ? (firmantes[0].posicion || 1) : null,
        // ⚠ Lo que ese campo YA USA en el documento, leído de su `/DA`. No es
        // una preferencia nuestra: es la respuesta que dejó escrita quien armó
        // el formulario. Si el PDF no lo dice, queda en null y se ajusta solo.
        cuerpo: d.cuerpo == null ? null : Number(d.cuerpo),
        color: d.color || null,
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
      if ($('cpQuienNueva')) {
        $('cpQuienNueva').addEventListener('change', function () {
          estado.quienNueva = $('cpQuienNueva').value;
        });
      }

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

      // El valor se ve en la caja de la hoja mientras se escribe: es lo que va
      // a salir impreso, así que hay que poder mirarlo en su lugar.
      c.querySelectorAll('[data-val]').forEach(function (el) {
        var campo = estado.campos[+el.dataset.val];
        var evento = (campo.tipo === 'casilla' || campo.tipo === 'opcion' ||
                      campo.tipo === 'fecha') ? 'change' : 'input';
        el.addEventListener(evento, function () {
          campo.valor = campo.tipo === 'casilla' ? (el.checked ? 'sí' : '') : el.value;
          if (HOJA) HOJA.pintar();
        });
      });

      c.querySelectorAll('[data-tipo]').forEach(function (el) {
        el.addEventListener('change', function () {
          var campo = estado.campos[+el.dataset.tipo];
          campo.tipo = el.value;
          // Un texto fijo es tuyo y no es obligatorio: no hay a quién pedírselo.
          // Se ajusta acá y no se le pregunta, porque no hay nada que elegir.
          if (el.value === 'etiqueta') {
            // ⚠ Los TRES, no dos. Faltaba `quien_completa` y el campo se
            // guardaba como del primer firmante: el modo viejo se quedaba
            // pegado y ganaba en el payload, así que un texto fijo salía a
            // nombre de alguien. Se descubrió porque la prueba lo miró.
            campo.quien_completa = 'emisor';
            campo.completa_emisor = true;
            campo.posicion_firmante = null;
            campo.obligatorio = false;
          }
          estado.sel = +el.dataset.tipo;
          pintarLista();
          if (HOJA) HOJA.pintar();
        });
      });
      c.querySelectorAll('[data-quien]').forEach(function (el) {
        el.addEventListener('change', function () {
          aplicarQuien(estado.campos[+el.dataset.quien], el.value);
          pintarLista();
          if (HOJA) HOJA.pintar();
        });
      });
      c.querySelectorAll('[data-cuerpo]').forEach(function (el) {
        el.addEventListener('change', function () {
          var v = el.value.trim();
          // Vacío vuelve a «se ajusta solo». Es la única forma de deshacer, y
          // sin ella el que probó un número queda atrapado en él.
          estado.campos[+el.dataset.cuerpo].cuerpo = v === '' ? null : Number(v);
        });
      });
      c.querySelectorAll('[data-color]').forEach(function (el) {
        el.addEventListener('change', function () {
          estado.campos[+el.dataset.color].color = el.value.toLowerCase();
          estado.sel = +el.dataset.color;
          pintarLista();
        });
      });
      c.querySelectorAll('[data-sincolor]').forEach(function (el) {
        el.addEventListener('click', function (ev) {
          ev.stopPropagation();
          estado.campos[+el.dataset.sincolor].color = null;
          estado.sel = +el.dataset.sincolor;
          pintarLista();
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
      c.querySelectorAll('[data-cada]').forEach(function (el) {
        el.addEventListener('click', function (ev) {
          ev.stopPropagation();
          var base = estado.campos[+el.dataset.cada];
          var faltan = firmantes.filter(function (p) { return p.posicion !== base.posicion_firmante; });
          var alto = Number(base.alto) || 20;

          faltan.forEach(function (p, k) {
            var copia = {};
            for (var q in base) copia[q] = base[q];
            copia.codigo = base.codigo + '_f' + p.posicion;
            copia.quien_completa = 'firmante';
            copia.completa_emisor = false;
            copia.posicion_firmante = p.posicion;
            copia.usos = 0;
            copia.valor = '';
            // ⚠ Apilados hacia ABAJO, separados por su propio alto más un
            // respiro. En puntos PDF, bajar es restar. Quedan uno debajo del
            // otro y se acomodan arrastrando: adivinar dónde va el renglón de
            // cada uno en el documento del cliente no lo puede hacer nadie.
            copia.y = Number(base.y) - (k + 1) * (alto + 6);
            estado.campos.push(copia);
          });

          aviso('Listo: uno para cada firmante, apilados debajo del primero. ' +
            'Arrastralos al renglón que le toca a cada uno.', 'ok');
          pintarLista();
          if (HOJA) HOJA.pintar();
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
        // ⚠ Dos pasos, y en este orden. Un campo recién dibujado todavía no
        // existe en la base, así que su valor no se puede guardar antes que él.
        // Por eso la definición va primero y los valores después, releyendo los
        // ids que quedaron.
        await api('/circuitos/' + circuitoId + '/campos', 'PUT', {
          campos: estado.campos.map(function (c, i) {
            return {
              codigo: c.codigo, etiqueta: c.etiqueta, tipo: c.tipo,
              opciones: c.tipo === 'opcion' ? (c.opciones || []) : null,
              // ⚠ El MODO manda, y las otras dos se derivan de él.
              //
              // Acá quedó la lógica vieja de dos estados un rato: mandaba
              // `posicion_firmante: 1` para un campo de «cualquiera» —porque el
              // `|| 1` tapaba el null— y el modo se perdía en el camino. El
              // campo se guardaba como del primer firmante sin que nada fallara.
              quien_completa: c.quien_completa ||
                (c.completa_emisor ? 'emisor' : 'firmante'),
              completa_emisor: c.quien_completa === 'emisor' || !!c.completa_emisor,
              cuerpo: c.cuerpo == null ? null : Number(c.cuerpo),
              color: c.color || null,
              posicion_firmante: c.quien_completa === 'firmante'
                ? (c.posicion_firmante || 1)
                : (c.quien_completa ? null : (c.completa_emisor ? null : (c.posicion_firmante || 1))),
              obligatorio: !!c.obligatorio,
              pagina: c.pagina,
              x: +Number(c.x).toFixed(2), y: +Number(c.y).toFixed(2),
              ancho: +Number(c.ancho).toFixed(2), alto: +Number(c.alto).toFixed(2),
              orden: i + 1,
            };
          }),
        });

        var mios = estado.campos.filter(function (c) {
          return c.completa_emisor && String(c.valor || '').trim();
        });
        if (mios.length) {
          b.textContent = 'Guardando tus datos…';
          var frescos = (await api('/circuitos/' + circuitoId + '/campos')).campos || [];
          var porCodigo = {};
          frescos.forEach(function (f) { porCodigo[f.codigo] = f.id; });

          for (var k = 0; k < mios.length; k++) {
            var id = porCodigo[mios[k].codigo];
            if (!id) continue;
            await api('/circuitos/' + circuitoId + '/campos/valor', 'POST', {
              campo_id: id,
              valor: String(mios[k].valor).trim() || null,
            });
          }
        }

        volver();
      } catch (e) {
        b.disabled = false; b.textContent = antes;
        aviso(e.message);
      }
    });
  };
})();
