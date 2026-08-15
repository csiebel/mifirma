// «Tu acceso»: la contraseña, el celular y por dónde te llega el código.
//
// Vive en la pantalla Cuenta, debajo de los datos de la empresa. Archivo aparte
// y no dentro de consola.js a propósito: son 167 KB que arman toda la consola, y
// esto no necesita nada de ahí más que el token de la sesión.
//
// ⚠⚠ La regla que ordena esta pantalla, y que viene de la migración 061:
// **el número que carga la empresa es una propuesta y no abre ninguna puerta.**
// Sólo el que la persona confirma —con su contraseña y un código que le llega a
// ESE teléfono— sirve para recibir el código de acceso. Por eso acá hay tres
// estados distintos y no un campo de texto.
(function () {
  'use strict';

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

  function api(ruta, metodo, cuerpo) {
    var op = {
      method: metodo || 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    };
    if (cuerpo) {
      op.headers['Content-Type'] = 'application/json';
      op.body = JSON.stringify(cuerpo);
    }
    if (op.method !== 'GET') {
      var c = csrf();
      if (c) op.headers['X-CSRF-Token'] = c;
    }
    return fetch(ruta, op).then(async function (r) {
      var txt = await r.text();
      var j = null;
      try { j = JSON.parse(txt); } catch (e) { /* el mensaje va abajo */ }
      if (!r.ok) throw new Error((j && j.error) || 'No se pudo (HTTP ' + r.status + ').');
      return j;
    });
  }

  function aviso(id, texto, clase) {
    var e = $(id);
    if (e) e.innerHTML = texto ? '<div class="msg ' + clase + '">' + esc(texto) + '</div>' : '';
  }

  var estado = null;

  // ── El teléfono, en sus tres estados ────────────────────────────────────
  var TELEFONO = {
    sin_telefono: function () {
      return (
        '<p class="pista">Todavía no tenés un celular confirmado. Sirve para ' +
        'recibir el código cuando entrás desde un equipo nuevo.</p>' +
        campoTelefono('')
      );
    },
    // ⚠ El caso que justifica toda la migración: la empresa lo cargó, y hasta
    // que la persona no lo confirme NO sirve para nada. La pantalla lo dice con
    // todas las letras, porque si no parece que ya está puesto.
    propuesto: function (e) {
      return (
        '<div class="msg aviso" style="margin:0 0 12px">Tu empresa cargó el celular ' +
        '<b>' + esc(e.telefono_propuesto) + '</b>. Todavía no está confirmado: ' +
        'hasta que no lo confirmes vos, no se usa para nada.</div>' +
        campoTelefono(e.telefono_propuesto)
      );
    },
    confirmado: function (e) {
      return (
        '<p style="margin:0 0 10px"><b>' + esc(e.telefono) + '</b> ' +
        '<span class="pill ok">confirmado</span></p>' +
        '<button class="btn btn-s" id="acQuitarTel">Quitar este celular</button>' +
        '<div id="acQuitarCaja"></div>'
      );
    },
  };

  function campoTelefono(sugerido) {
    return (
      '<label class="campo" for="acTel">Celular</label>' +
      '<input id="acTel" placeholder="+59899123456" value="' + esc(sugerido || '') + '" />' +
      '<p class="pista">Con el código del país adelante.</p>' +
      '<label class="campo" for="acTelPass">Tu contraseña</label>' +
      '<input id="acTelPass" type="password" autocomplete="current-password" />' +
      '<p class="pista">La pedimos porque cambiar el celular es cambiar dónde ' +
      'llegan los códigos para entrar.</p>' +
      '<button class="btn btn-p" id="acPedirCodigo">Mandame el código</button>' +
      '<div id="acPaso2"></div>'
    );
  }

  // ── El canal ────────────────────────────────────────────────────────────
  var NOMBRE_CANAL = { email: 'Por correo', sms: 'Por SMS', whatsapp: 'Por WhatsApp' };

  function pintarCanal(e) {
    var html = e.canales_posibles
      .map(function (c) {
        return (
          '<label style="display:flex;align-items:center;gap:9px;min-height:40px;cursor:pointer">' +
          '<input type="radio" name="acCanal" value="' + c + '"' +
          (e.otp_canal === c ? ' checked' : '') + ' /> ' + NOMBRE_CANAL[c] + '</label>'
        );
      })
      .join('');

    // Lo que NO se puede elegir todavía, dicho con su motivo. Un canal que
    // falta sin explicación manda a la gente a soporte.
    if (e.estado_telefono !== 'confirmado') {
      html +=
        '<p class="pista">Para elegir SMS o WhatsApp, confirmá tu celular acá arriba.</p>';
    } else if (e.canales_posibles.length === 1) {
      html += '<p class="pista">Todavía no hay ningún canal de mensajes conectado.</p>';
    }

    // ⚠ El correo no se puede apagar y conviene decirlo: es lo que evita que
    // alguien quede afuera de su cuenta por perder el teléfono.
    html +=
      '<p class="pista">El correo queda siempre como respaldo: si no te llega por ' +
      'donde elegiste, vas a poder pedirlo por mail.</p>';
    return html;
  }

  // ── Pintar todo ─────────────────────────────────────────────────────────
  async function pintar() {
    var caja = $('acceso');
    if (!caja) return;
    try {
      estado = await api('/mi/acceso');
    } catch (e) {
      caja.innerHTML = '<div class="msg err">' + esc(e.message) + '</div>';
      return;
    }

    caja.innerHTML =
      '<h3 style="font-size:15px;margin:0 0 10px">Tu contraseña</h3>' +
      (estado.tiene_password
        ? '<label class="campo" for="acPassActual">Contraseña actual</label>' +
          '<input id="acPassActual" type="password" autocomplete="current-password" />' +
          '<label class="campo" for="acPassNueva">Contraseña nueva</label>' +
          '<input id="acPassNueva" type="password" autocomplete="new-password" />' +
          '<button class="btn btn-p" id="acGuardarPass" style="margin-top:12px">Cambiar la contraseña</button>' +
          '<div id="acMsgPass"></div>'
        : '<p class="pista">Tu cuenta todavía no tiene contraseña. Usá ' +
          '«¿Olvidaste tu contraseña?» en la pantalla de entrada para crear una.</p>') +
      '<hr style="border:0;border-top:1px solid var(--line);margin:22px 0">' +
      '<h3 style="font-size:15px;margin:0 0 10px">Tu celular</h3>' +
      TELEFONO[estado.estado_telefono](estado) +
      '<div id="acMsgTel"></div>' +
      '<hr style="border:0;border-top:1px solid var(--line);margin:22px 0">' +
      '<h3 style="font-size:15px;margin:0 0 10px">Por dónde te mandamos el código</h3>' +
      pintarCanal(estado) +
      '<div id="acMsgCanal"></div>';

    enganchar();
  }

  function enganchar() {
    var bPass = $('acGuardarPass');
    if (bPass) {
      bPass.addEventListener('click', async function () {
        aviso('acMsgPass', '', '');
        bPass.disabled = true;
        try {
          await api('/mi/password', 'PUT', {
            actual: $('acPassActual').value,
            nueva: $('acPassNueva').value,
          });
          $('acPassActual').value = '';
          $('acPassNueva').value = '';
          aviso('acMsgPass', 'Listo, tu contraseña cambió.', 'ok');
        } catch (e) {
          aviso('acMsgPass', e.message, 'err');
        }
        bPass.disabled = false;
      });
    }

    var bPedir = $('acPedirCodigo');
    if (bPedir) {
      bPedir.addEventListener('click', async function () {
        aviso('acMsgTel', '', '');
        bPedir.disabled = true;
        var tel = $('acTel').value.trim();
        try {
          var r = await api('/mi/telefono/codigo', 'POST', {
            password: $('acTelPass').value,
            telefono: tel,
          });
          // El paso 2 aparece recién ahora: pedir un código que todavía no
          // salió es lo que hace que la gente escriba cualquier cosa.
          $('acPaso2').innerHTML =
            '<div class="msg ok" style="margin:14px 0 12px">Te mandamos un código ' +
            (r.canal === 'whatsapp' ? 'por WhatsApp' : 'por SMS') + ' a <b>' + esc(tel) +
            '</b>. Vence en ' + r.vence_en_minutos + ' minutos.</div>' +
            '<label class="campo" for="acCodigo">El código</label>' +
            '<input id="acCodigo" inputmode="numeric" maxlength="6" placeholder="123456" />' +
            '<button class="btn btn-p" id="acConfirmar" style="margin-top:12px">Confirmar mi celular</button>';
          $('acConfirmar').addEventListener('click', async function () {
            aviso('acMsgTel', '', '');
            try {
              await api('/mi/telefono/confirmar', 'POST', {
                telefono: tel,
                codigo: $('acCodigo').value.trim(),
              });
              await pintar();
              aviso('acMsgTel', 'Listo, tu celular quedó confirmado.', 'ok');
            } catch (e2) {
              aviso('acMsgTel', e2.message, 'err');
            }
          });
        } catch (e) {
          aviso('acMsgTel', e.message, 'err');
        }
        bPedir.disabled = false;
      });
    }

    var bQuitar = $('acQuitarTel');
    if (bQuitar) {
      bQuitar.addEventListener('click', function () {
        // Sacar el teléfono también pide la contraseña: quien tenga tu sesión
        // no puede dejarte sin segundo factor.
        $('acQuitarCaja').innerHTML =
          '<label class="campo" for="acQuitarPass">Tu contraseña</label>' +
          '<input id="acQuitarPass" type="password" autocomplete="current-password" />' +
          '<button class="btn btn-d" id="acQuitarOk" style="margin-top:12px">Sacar el celular</button>';
        $('acQuitarOk').addEventListener('click', async function () {
          aviso('acMsgTel', '', '');
          try {
            await api('/mi/telefono', 'DELETE', { password: $('acQuitarPass').value });
            await pintar();
            aviso('acMsgTel', 'Sacamos tu celular.', 'ok');
          } catch (e) {
            aviso('acMsgTel', e.message, 'err');
          }
        });
      });
    }

    document.querySelectorAll('input[name="acCanal"]').forEach(function (r) {
      r.addEventListener('change', async function () {
        aviso('acMsgCanal', '', '');
        try {
          await api('/mi/canal', 'PUT', { canal: r.value });
          aviso('acMsgCanal', 'Listo. Te lo vamos a mandar ' +
            NOMBRE_CANAL[r.value].toLowerCase() + '.', 'ok');
        } catch (e) {
          aviso('acMsgCanal', e.message, 'err');
          await pintar();
        }
      });
    });
  }

  // Se pinta al entrar a Cuenta y no al cargar la consola: son cuatro consultas
  // que no le importan a nadie que esté mirando documentos.
  window.addEventListener('hashchange', function () {
    if (location.hash.slice(1) === 'cuenta') pintar();
  });
  document.addEventListener('DOMContentLoaded', function () {
    if (location.hash.slice(1) === 'cuenta') pintar();
  });
})();
