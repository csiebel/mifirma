(function(){
  'use strict';

  /* =========================================================================
     Textos. Van acá, como los de la página comercial: son pocos, cambian con
     el diseño de las pantallas y no con la configuración del producto. El
     español vive en el HTML y hace de respaldo.
     ========================================================================= */
  var T = {
    es: {},
    pt: {
      'volver':'Voltar ao site','volver2':'Voltar','correo':'E-mail','password':'Senha',
      'login.h1':'Entrar no MiFirma','login.lead':'Com seu e-mail e sua senha.',
      'btn.entrar':'Entrar','olvide':'Esqueceu sua senha?',
      'sinCuenta':'Ainda não tem conta?','crear':'Crie aqui',
      'canal.h1':'Por onde mandamos o código?','canal.lead':'É um equipamento novo, então confirmamos que é você.',
      'canal.correo':'Por e-mail','canal.sms':'Por SMS','canal.wa':'Por WhatsApp',
      'otp.h1':'Digite o código','otp.codigo':'Código de 6 dígitos','btn.verificar':'Verificar',
      'otp.reenviar':'Enviar outro código','otp.destino':'Enviamos para {destino}.',
      'otp.enviado':'Pronto, enviamos outro para {destino}.',
      'cuenta.h1':'Em qual conta você quer entrar?','cuenta.lead':'Você tem acesso a mais de uma.',
      'crear.h1':'Crie a conta da sua empresa','crear.h1.persona':'Crie a sua conta',
      'crear.lead.persona':'É sua. Se um dia incluir alguém, você dá acesso com o papel que precisar.',
      'tipo.empresa':'Uma empresa','tipo.empresa.p':'Assina com o nome dela e inclui sua equipe.',
      'tipo.persona':'Eu, em nome próprio','tipo.persona.p':'Um profissional, um tabelião, alguém que assina sozinho.',
      'crear.fiscal.persona':'Documento (opcional)','crear.vos.persona':'Seus dados',
      'crear.tuNombre.p':'É o que seus signatários vão ver no e-mail.',
      'crear.v1.persona':'Você assina em nome próprio, com validade jurídica.',
      'err.crear.persona':'Preencha seu nome, e-mail e senha.',
      'crear.lead':'Você cria e depois adiciona sua equipe com o papel de cada um.',
      'crear.nombre':'Nome da empresa','crear.nombre.p':'É o que seus signatários vão ver no e-mail.',
      'crear.pais':'País','crear.fiscal':'CNPJ / RUC / RUT',
      'crear.pais.p':'O país define qual lei e quais certificadores se aplicam. Não pode ser alterado depois.',
      'crear.razon':'Razão social','crear.opcional':'(opcional)',
      'crear.vos':'Seu usuário de administrador','crear.tuNombre':'Seu nome',
      'crear.password':'Senha','crear.password.p':'Mínimo 12 caracteres. Não pedimos maiúsculas nem símbolos: o comprimento defende mais que as regras.',
      'crear.repetir':'Repita a senha','crear.btn':'Criar a conta',
      'crear.v1':'Adicione sua equipe com um e-mail e atribua um papel.',
      'crear.v2':'Cada pasta define quem vê e quem pode enviar.',
      'crear.v3':'Quem assina seus documentos não precisa de conta.',
      'crear.ya':'Já tem conta?','crear.entrar':'Entre aqui',
      'reset.h1':'Recuperar a senha','reset.lead':'Enviamos um link para escolher uma nova.',
      'reset.enviar':'Enviar link',
      'reset.ok':'Se esse e-mail tiver conta, o link chega em alguns minutos.',
      'np.h1':'Escolha sua senha','np.h1.inv':'Bem-vindo: escolha sua senha','np.lead':'Mínimo 12 caracteres.',
      'np.nueva':'Nova senha','np.repetir':'Repita','np.guardar':'Salvar e entrar',
      'np.ok':'Pronto. Entre com sua nova senha.',
      'np.h1.alta':'Confirme seu e-mail e escolha sua senha',
      'np.confirmar':'Confirmar e entrar',
      'crear.revisa':'Enviamos um e-mail para {email}. Abra-o para confirmar que é seu e escolher sua senha — até esse momento nenhuma conta foi criada.',
      'footer':'Assinatura eletrônica com validade jurídica','esperando':'Um momento…',
      'err.faltan':'Preencha o e-mail e a senha.','err.codigo':'O código tem 6 dígitos.',
      'err.correo':'Escreva seu e-mail.','err.noCoinciden':'As duas senhas precisam ser iguais.',
      'err.corta':'Mínimo 12 caracteres.','err.crear':'Preencha o nome da empresa, seu nome, e-mail e senha.',
      'ojo.ver':'Mostrar a senha','ojo.ocultar':'Ocultar a senha'
    },
    en: {
      'volver':'Back to site','volver2':'Back','correo':'Email','password':'Password',
      'login.h1':'Sign in to MiFirma','login.lead':'With your email and password.',
      'btn.entrar':'Sign in','olvide':'Forgot your password?',
      'sinCuenta':'Don’t have an account yet?','crear':'Create one',
      'canal.h1':'Where should we send the code?','canal.lead':'New device, so we check it’s really you.',
      'canal.correo':'By email','canal.sms':'By SMS','canal.wa':'By WhatsApp',
      'otp.h1':'Enter the code','otp.codigo':'6-digit code','btn.verificar':'Verify',
      'otp.reenviar':'Send another code','otp.destino':'We sent it to {destino}.',
      'otp.enviado':'Done, we sent another one to {destino}.',
      'cuenta.h1':'Which account do you want to enter?','cuenta.lead':'You have access to more than one.',
      'crear.h1':'Create your company account','crear.h1.persona':'Create your account',
      'crear.lead.persona':'It\u2019s yours. If you ever add someone, you give them the role they need.',
      'tipo.empresa':'A company','tipo.empresa.p':'Signs under its own name and adds its team.',
      'tipo.persona':'Just me','tipo.persona.p':'A professional, a notary, someone who signs alone.',
      'crear.fiscal.persona':'ID number (optional)','crear.vos.persona':'Your details',
      'crear.tuNombre.p':'This is what your signers will see in the email.',
      'crear.v1.persona':'You sign in your own name, with legal validity.',
      'err.crear.persona':'Fill in your name, email and password.',
      'crear.lead':'You create it, then add your team with the role each one needs.',
      'crear.nombre':'Company name','crear.nombre.p':'This is what your signers will see in the email.',
      'crear.pais':'Country','crear.fiscal':'Tax ID',
      'crear.pais.p':'The country decides which law and which certifiers apply. It can’t be changed later.',
      'crear.razon':'Legal name','crear.opcional':'(optional)',
      'crear.vos':'Your administrator account','crear.tuNombre':'Your name',
      'crear.password':'Password','crear.password.p':'At least 12 characters. We don\u2019t ask for capitals or symbols: length defends better than rules.',
      'crear.repetir':'Repeat the password','crear.btn':'Create the account',
      'crear.v1':'Add your team with an email and give each one a role.',
      'crear.v2':'Each folder decides who can see and who can send.',
      'crear.v3':'People signing your documents don’t need an account.',
      'crear.ya':'Already have an account?','crear.entrar':'Sign in',
      'reset.h1':'Reset your password','reset.lead':'We’ll email you a link to choose a new one.',
      'reset.enviar':'Send link',
      'reset.ok':'If that email has an account, the link arrives in a few minutes.',
      'np.h1':'Choose your password','np.h1.inv':'Welcome — choose your password','np.lead':'At least 12 characters.',
      'np.nueva':'New password','np.repetir':'Repeat it','np.guardar':'Save and sign in',
      'np.ok':'Done. Sign in with your new password.',
      'np.h1.alta':'Confirm your email and choose your password',
      'np.confirmar':'Confirm and sign in',
      'crear.revisa':'We sent an email to {email}. Open it to confirm it is yours and choose your password — no account exists until you do.',
      'footer':'Electronic signature with legal validity','esperando':'One moment…',
      'err.faltan':'Fill in the email and password.','err.codigo':'The code has 6 digits.',
      'err.correo':'Type your email.','err.noCoinciden':'Both passwords must match.',
      'err.corta':'At least 12 characters.','err.crear':'Fill in the company name, your name, email and password.',
      'ojo.ver':'Show the password','ojo.ocultar':'Hide the password'
    }
  };

  var BASE = {};
  document.querySelectorAll('[data-t]').forEach(function(el){ BASE[el.dataset.t] = el.textContent; });
  T.es = Object.assign({}, BASE, {
    'canal.sms':'Por SMS','canal.wa':'Por WhatsApp','esperando':'Un momento…',
    'otp.destino':'Te lo mandamos a {destino}.','otp.enviado':'Listo, te mandamos otro a {destino}.',
    'np.h1.inv':'Bienvenido: elegí tu contraseña',
    'reset.ok':'Si ese correo tiene cuenta, te llega un enlace en unos minutos.',
    'np.ok':'Listo. Entrá con tu contraseña nueva.',
    'np.h1.alta':'Confirmá tu correo y elegí tu contraseña',
    'np.confirmar':'Confirmar y entrar',
    'crear.revisa':'Te mandamos un correo a {email}. Abrilo para confirmar que es tuyo y elegir tu contraseña — hasta ese momento no se creó ninguna cuenta.',
    'err.faltan':'Completá el correo y la contraseña.','err.codigo':'El código tiene 6 dígitos.',
    'err.correo':'Escribí tu correo.','err.noCoinciden':'Las dos contraseñas tienen que ser iguales.',
    'err.corta':'Mínimo 12 caracteres.','err.crear':'Completá el nombre de la empresa, tu nombre, correo y contraseña.',
    'ojo.ver':'Mostrar la contraseña','ojo.ocultar':'Ocultar la contraseña',
    'crear.h1.persona':'Creá tu cuenta',
    'crear.lead.persona':'Es tuya. Si algún día sumás a alguien, le das acceso con el rol que necesite.',
    'crear.fiscal.persona':'Documento (opcional)','crear.vos.persona':'Tus datos',
    'crear.v1.persona':'Firmás a título propio, con validez legal.',
    'err.crear.persona':'Completá tu nombre, correo y contraseña.'
  });

  var LANG = 'es';
  function t(k){ return (T[LANG] && T[LANG][k]) || BASE[k] || ''; }
  function idioma(l){
    LANG = T[l] ? l : 'es';
    try{ localStorage.setItem('mf_lang', LANG); }catch(e){}
    document.documentElement.lang = LANG;
    document.querySelectorAll('[data-t]').forEach(function(el){
      var v = t(el.dataset.t); if (v) el.textContent = v;
    });
    document.querySelectorAll('.lang button').forEach(function(b){
      b.setAttribute('aria-pressed', String(b.dataset.l === LANG));
    });
  }

  var VISTAS = ['vLogin','vCanal','vOtp','vCuenta','vCrear','vReset','vNuevaPassword'];

  /* -------------------------------------------------------------------------
     Empresa o persona.

     No es un detalle de formulario: son dos tipos de cuenta distintos en la
     base (`cuenta.tipo`). La de persona lleva `identidad_titular_id` —la cuenta
     ES de alguien— y no crea fila en `empresa`, porque no hay razón social ni
     giro que registrar. El resto es idéntico: mismos roles, mismas carpetas,
     mismo repositorio. Un escribano que firma solo hoy puede sumar una
     secretaria mañana sin migrar nada.
     ------------------------------------------------------------------------- */
  var TIPO = 'empresa';
  var DESAFIO_OTP = null, DESAFIO_CUENTA = null, TOKEN_RESET = null, CANAL_TEL = 'sms';
  var TIPO_TOKEN = 'reset', NECESITA_PASSWORD = true;

  function $(id){ return document.getElementById(id); }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  function ver(v){ VISTAS.forEach(function(x){ $(x).classList.toggle('hidden', x!==v); }); window.scrollTo(0,0); }
  function msg(id, texto, clase){ $(id).innerHTML = texto ? '<div class="msg '+clase+'">'+esc(texto)+'</div>' : ''; }
  function ocupado(btn, si){
    var b = $(btn); b.disabled = si;
    if (si){ b.dataset.txt = b.textContent; b.textContent = t('esperando'); }
    else if (b.dataset.txt){ b.textContent = b.dataset.txt; }
  }

  /* -------------------------------------------------------------------------
     El ojo para ver la contraseña.

     Se inyecta por JS sobre CADA input[type=password] en vez de escribirlo en
     el HTML cinco veces: así ninguna pantalla nueva se olvida de ponerlo.

     No es una comodidad menor. Sin poder ver lo que escribe, la gente elige
     contraseñas cortas y fáciles de tipear —justo lo contrario de lo que pide
     una política de largo mínimo— y en el celular se equivoca y abandona.
     ------------------------------------------------------------------------- */
  var OJO = '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/></svg>';
  var OJO_TACHADO = '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-6.5 10-6.5c1.7 0 3.2.5 4.5 1.1M22 12s-3.6 6.5-10 6.5c-1.7 0-3.2-.5-4.5-1.1"/><path d="M9.9 9.9a3 3 0 004.2 4.2"/><path d="M3 3l18 18"/></svg>';

  function ponerOjos(){
    document.querySelectorAll('input[type=password]').forEach(function(inp){
      if (inp.parentNode && inp.parentNode.classList.contains('pw')) return;
      var caja = document.createElement('div');
      caja.className = 'pw';
      inp.parentNode.insertBefore(caja, inp);
      caja.appendChild(inp);

      var b = document.createElement('button');
      b.type = 'button';                 // sin esto, dentro de un form envía
      b.innerHTML = OJO;
      b.setAttribute('aria-label', t('ojo.ver'));
      b.dataset.ojo = '1';
      b.addEventListener('click', function(){
        var mostrar = inp.type === 'password';
        inp.type = mostrar ? 'text' : 'password';
        b.innerHTML = mostrar ? OJO_TACHADO : OJO;
        b.setAttribute('aria-label', t(mostrar ? 'ojo.ocultar' : 'ojo.ver'));
        inp.focus();
      });
      caja.appendChild(b);
    });
  }

  // Identificador de equipo. Estable por navegador: es lo que permite no pedir
  // código en cada ingreso. No identifica a la persona.
  function deviceId(){
    try{
      var k='mf_device_id', v=localStorage.getItem(k);
      if(!v){ v = crypto.randomUUID ? crypto.randomUUID() : 'd'+Date.now()+Math.random().toString(16).slice(2);
              localStorage.setItem(k,v); }
      return v;
    }catch(e){ return ''; }
  }

  async function api(path, method, body){
    var opt = { method: method||'GET', credentials:'same-origin', headers:{} };
    if (body){ opt.headers['Content-Type']='application/json'; opt.body=JSON.stringify(body); }
    var r = await fetch(path, opt);
    var txt = await r.text();
    var data; try{ data = txt ? JSON.parse(txt) : {}; }catch(e){ data = { error: txt }; }
    if (!r.ok) throw new Error(data.error || data.message || ('HTTP '+r.status));
    return data;
  }

  // El servidor responde con un `tipo` y esto elige la pantalla. Toda la lógica
  // de qué falta vive en el backend: el cliente sólo obedece.
  function seguir(j){
    if (j.tipo === 'sesion')        return entrar(j);
    if (j.tipo === 'otp')           return mostrarOtp(j);
    if (j.tipo === 'otp_elegir')    return mostrarCanal(j);
    if (j.tipo === 'elegir_cuenta') return mostrarCuentas(j);
    throw new Error('Respuesta inesperada del servidor.');
  }
  // La sesión viaja en la cookie httpOnly que setea el servidor. NO se guarda el
  // token en localStorage: ahí lo lee cualquier script inyectado, y en un
  // producto de firma electrónica el token de sesión es la firma de la persona.
  function entrar(_j){
    location.href = '/app';
  }

  async function login(){
    var email = $('email').value.trim(), password = $('password').value;
    if (!email || !password) return msg('msgLogin', t('err.faltan'), 'err');
    msg('msgLogin','',''); ocupado('btnLogin', true);
    try{ seguir(await api('/auth/login','POST',{ email:email, password:password, device_id:deviceId() })); }
    catch(e){ msg('msgLogin', e.message, 'err'); }
    finally{ ocupado('btnLogin', false); }
  }

  function mostrarCanal(j){
    DESAFIO_OTP = j.challenge; CANAL_TEL = j.canal_tel || 'sms';
    $('canalEmail').textContent = j.email_masked || '';
    $('canalTel').textContent = j.tel_masked || '';
    $('canalTelTitulo').textContent = t(CANAL_TEL === 'whatsapp' ? 'canal.wa' : 'canal.sms');
    msg('msgCanal','',''); ver('vCanal');
  }
  async function enviarCodigo(canal){
    msg('msgCanal','','');
    try{
      var j = await api('/auth/otp/elegir','POST',{ challenge:DESAFIO_OTP, canal:canal });
      mostrarOtp({ challenge:DESAFIO_OTP, canal:j.canal, destino_masked:j.destino_masked });
    }catch(e){ msg('msgCanal', e.message, 'err'); }
  }
  function mostrarOtp(j){
    DESAFIO_OTP = j.challenge;
    $('otpDestino').textContent = t('otp.destino').replace('{destino}', j.destino_masked || '');
    $('codigo').value = ''; msg('msgOtp','',''); ver('vOtp');
    setTimeout(function(){ $('codigo').focus(); }, 50);
  }
  async function verificarCodigo(){
    var code = $('codigo').value.trim();
    if (code.length !== 6) return msg('msgOtp', t('err.codigo'), 'err');
    msg('msgOtp','',''); ocupado('btnOtp', true);
    try{ seguir(await api('/auth/otp','POST',{ challenge:DESAFIO_OTP, code:code })); }
    catch(e){ msg('msgOtp', e.message, 'err'); }
    finally{ ocupado('btnOtp', false); }
  }
  async function reenviar(){
    msg('msgOtp','','');
    try{
      var j = await api('/auth/otp/reenviar','POST',{ challenge:DESAFIO_OTP });
      msg('msgOtp', t('otp.enviado').replace('{destino}', j.destino_masked || ''), 'ok');
    }catch(e){ msg('msgOtp', e.message, 'err'); }
  }

  function mostrarCuentas(j){
    DESAFIO_CUENTA = j.desafio;
    $('listaCuentas').innerHTML = (j.opciones||[]).map(function(o){
      return '<button class="opcion" data-c="'+esc(o.cuenta_id)+'"><b>'+esc(o.cuenta_nombre)+'</b></button>';
    }).join('');
    $('listaCuentas').querySelectorAll('[data-c]').forEach(function(b){
      b.addEventListener('click', function(){ elegirCuenta(b.dataset.c); });
    });
    msg('msgCuenta','',''); ver('vCuenta');
  }
  async function elegirCuenta(id){
    msg('msgCuenta','','');
    try{ entrar(await api('/auth/login/elegir-cuenta','POST',{ desafio:DESAFIO_CUENTA, cuenta_id:id })); }
    catch(e){ msg('msgCuenta', e.message, 'err'); }
  }
  function volverAlLogin(){ DESAFIO_OTP=null; DESAFIO_CUENTA=null; msg('msgLogin','',''); ver('vLogin'); }

  // ---------------- Alta de cuenta ----------------

  /**
   * Cambia el formulario según el tipo.
   *
   * En vez de escribir los textos a mano, se cambia la CLAVE de traducción de
   * cada elemento (`data-t`). Así cambiar de idioma después de elegir "persona"
   * sigue mostrando los textos de persona: `idioma()` recorre los mismos
   * elementos y encuentra la clave que corresponde. Escribiendo el texto a mano
   * habría que acordarse de repintar en dos lugares, y uno de los dos se olvida.
   */
  function pintarTipo(){
    var esP = TIPO === 'persona';
    $('bloqueEmpresa').classList.toggle('hidden', esP);
    $('bloqueRazon').classList.toggle('hidden', esP);
    $('pistaNombre').classList.toggle('hidden', !esP);

    // ⚠ A una persona NO se le pide el documento acá, y no es un olvido.
    //
    // El documento de alguien es un ANCLAJE de identidad (migración 003), y un
    // anclaje es una PRUEBA: se establece cuando la persona lo demuestra —con
    // un certificado, con un proveedor de identidad—, no cuando lo escribe en
    // un formulario. Guardar un número tipeado como si fuera identidad probada
    // es exactamente la confusión que este producto no se puede permitir: sobre
    // eso se decide después si una firma es oponible.
    //
    // La empresa es otra cosa: su RUT es un dato registral del contribuyente,
    // va en la tabla `empresa` y no pretende identificar a nadie.
    $('bloqueFiscal').classList.toggle('hidden', esP);
    $('filaPaisFiscal').style.gridTemplateColumns = esP ? '1fr' : '';

    $('crearTitulo').dataset.t = esP ? 'crear.h1.persona' : 'crear.h1';
    $('crearLead').dataset.t   = esP ? 'crear.lead.persona' : 'crear.lead';
    $('crearVos').dataset.t    = esP ? 'crear.vos.persona' : 'crear.vos';
    $('ventaja1').dataset.t    = esP ? 'crear.v1.persona' : 'crear.v1';
    $('cFiscal').placeholder   = esP ? '' : '21 555 3300 12';

    document.querySelectorAll('#vCrear [data-t]').forEach(function(el){
      var v = t(el.dataset.t); if (v) el.textContent = v;
    });
    document.querySelectorAll('.opcTipo').forEach(function(b){
      b.setAttribute('aria-pressed', String(b.dataset.tipo === TIPO));
    });
  }

  function elegirTipo(tipo){
    TIPO = tipo === 'persona' ? 'persona' : 'empresa';
    msg('msgCrear','','');
    pintarTipo();
  }

  async function crearCuenta(){
    var esP    = TIPO === 'persona';
    var admin  = { nombre: $('cAdminNombre').value.trim(), email: $('cAdminEmail').value.trim() };
    // Una cuenta de persona se llama como la persona. Pedir "nombre de la
    // cuenta" y "tu nombre" por separado es hacer que alguien escriba dos veces
    // lo mismo y después dude de si escribió mal alguno.
    var nombre = esP ? admin.nombre : $('cNombre').value.trim();
    if (!nombre || !admin.nombre || !admin.email) {
      return msg('msgCrear', t(esP ? 'err.crear.persona' : 'err.crear'), 'err');
    }

    msg('msgCrear','',''); ocupado('btnCrear', true);
    try{
      await api('/auth/registro','POST',{
        tipo: TIPO,
        nombre: nombre,
        pais: $('cPais').value,
        id_fiscal: esP ? undefined : ($('cFiscal').value.trim() || undefined),
        // La razón social es de la empresa. Mandarla en una cuenta de persona
        // sería inventarle una que no tiene.
        razon_social: esP ? undefined : ($('cRazon').value.trim() || undefined),
        admin: admin
      });
      // ⚠ La respuesta es la misma exista o no ese correo, y por eso el mensaje
      // también tiene que serlo: "te mandamos un correo", nunca "ya tenías
      // cuenta". Ver services/auth_registro.ts. La contraseña se elige al
      // abrir el enlace, o sea la elige quien probó leer esa casilla.
      msg('msgCrear', t('crear.revisa').replace('{email}', admin.email), 'ok');
      // Se le devuelve el texto al botón y recién ahí se lo deja quieto: si no,
      // queda diciendo «Esperá…» para siempre y parece colgado.
      ocupado('btnCrear', false);
      $('btnCrear').disabled = true;
    }catch(e){
      msg('msgCrear', e.message, 'err');
      ocupado('btnCrear', false);
    }
  }

  // ---------------- Recupero ----------------
  async function pedirReset(){
    var email = $('resetEmail').value.trim();
    if (!email) return msg('msgReset', t('err.correo'), 'err');
    ocupado('btnReset', true);
    try{
      await api('/auth/reset/solicitar','POST',{ email:email });
      // Respuesta idéntica exista o no la cuenta: decir "ese correo no está
      // registrado" convertiría este formulario en una herramienta para
      // averiguar quién usa MiFirma.
      msg('msgReset', t('reset.ok'), 'ok');
    }catch(e){ msg('msgReset', e.message, 'err'); }
    finally{ ocupado('btnReset', false); }
  }

  async function guardarPassword(){
    var a = $('np1').value, b = $('np2').value;
    if (TIPO_TOKEN !== 'alta' || NECESITA_PASSWORD) {
      if (a !== b) return msg('msgNp', t('err.noCoinciden'), 'err');
      if (a.length < 12) return msg('msgNp', t('err.corta'), 'err');
    }
    ocupado('btnNp', true);
    try{
      if (TIPO_TOKEN === 'alta') {
        // Acá recién se crea la cuenta. La sesión vuelve con el anclaje de
        // correo ya probado, así que "Recibidos" se ve lleno desde el primer
        // momento y no después de volver a entrar.
        var j = await api('/auth/registro/confirmar','POST',
                          { token:TOKEN_RESET, password: NECESITA_PASSWORD ? a : undefined });
        return entrar(j);
      }
      await api('/auth/reset/confirmar','POST',{ token:TOKEN_RESET, password:a });
      msg('msgNp', t('np.ok'), 'ok');
      setTimeout(function(){ location.hash=''; ver('vLogin'); }, 1200);
    }catch(e){ msg('msgNp', e.message, 'err'); }
    finally{ ocupado('btnNp', false); }
  }

  // El enlace del correo llega como /entrar#token=…&t=inv|reset. Va en el
  // fragmento y no en la query a propósito: el fragmento no viaja al servidor,
  // así que el token no queda en los logs ni se filtra por el Referer.
  function leerHash(){
    var h = new URLSearchParams((location.hash||'').replace(/^#/,''));
    if (h.get('crear') !== null || (location.hash||'') === '#crear'){ ver('vCrear'); return true; }
    var tk = h.get('token');
    if (!tk) return false;
    TOKEN_RESET = tk;
    TIPO_TOKEN  = h.get('t') || 'reset';
    if (TIPO_TOKEN === 'inv') $('npTitulo').textContent = t('np.h1.inv');
    if (TIPO_TOKEN === 'alta') {
      $('npTitulo').textContent = t('np.h1.alta');
      // Qué se está por crear. No crea nada: sirve para que la pantalla diga
      // el nombre de la cuenta, y para saber si esta persona ya tiene
      // contraseña —porque ya entra al sistema— y no hay que pedirle otra.
      api('/auth/registro/ver','POST',{ token: tk }).then(function(d){
        NECESITA_PASSWORD = !!d.necesita_password;
        $('npTitulo').textContent = t('np.h1.alta').replace('{cuenta}', d.nombre);
        if (!NECESITA_PASSWORD) {
          $('bloqueNp').style.display = 'none';
          $('btnNp').textContent = t('np.confirmar');
        }
      }).catch(function(e){ msg('msgNp', e.message, 'err'); });
    }
    ver('vNuevaPassword');
    return true;
  }

  window.idioma = idioma; window.ver = ver;
  window.login = login; window.enviarCodigo = enviarCodigo; window.verificarCodigo = verificarCodigo;
  window.reenviar = reenviar; window.volverAlLogin = volverAlLogin;
  window.pedirReset = pedirReset; window.guardarPassword = guardarPassword; window.crearCuenta = crearCuenta;
  window.elegirTipo = elegirTipo;
  Object.defineProperty(window, 'CANAL_TEL', { get: function(){ return CANAL_TEL; } });

  var guardado; try{ guardado = localStorage.getItem('mf_lang'); }catch(e){}
  var nav = (navigator.language || 'es').slice(0,2);
  idioma(guardado || (T[nav] ? nav : 'es'));
  ponerOjos();
  document.querySelectorAll('.opcTipo').forEach(function(b){
    b.addEventListener('click', function(){ elegirTipo(b.dataset.tipo); });
  });
  pintarTipo();
  if (!leerHash()) ver('vLogin');
  window.addEventListener('hashchange', function(){ if (!leerHash()) ver('vLogin'); });
})();
