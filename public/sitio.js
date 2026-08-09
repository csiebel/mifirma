(function(){
  'use strict';

  // Marca que el JS corrió: recién ahí el CSS oculta lo que va a aparecer al
  // desplazar. Si este archivo no carga, la página se ve entera igual.
  document.documentElement.classList.add('js');

  /* =========================================================================
     Textos de la página comercial.
     Van acá y no en la base a propósito: son discurso de venta, cambian cuando
     cambia el pitch y no cuando cambia la configuración del producto. Los
     textos de la aplicación sí son paramétricos.
     ========================================================================= */
  var T = {
    es: {},
    pt: {
      'nav.comparar':'Comparar',
      'comp.kicker':'Com o que você vai nos comparar','comp.h2':'Hoje você escolhe entre uma plataforma global ou um certificador local.',
      'comp.p':'As duas resolvem uma parte. As globais trazem um produto maduro, mas cobram por usuário e em moeda estrangeira, com a assinatura credenciada como adicional à parte. Os certificadores locais têm o certificado que a sua lei reconhece, mas atuam em um só país.',
      'comp.a.q':'Plataformas globais','comp.a.h':'Produto maduro, modelo alheio',
      'comp.a.1':'Fluxo, campos e trilha de auditoria bem maduros',
      'comp.a.2':'Cobrança por usuário e por mês, em moeda estrangeira',
      'comp.a.3':'Com limite de envios por usuário, mesmo que você não use',
      'comp.a.4':'A assinatura credenciada é um adicional por destinatário',
      'comp.a.5':'Nota fiscal do exterior e suporte em outro fuso',
      'comp.b.q':'Certificadores locais','comp.b.h':'O certificado certo, um só país',
      'comp.b.1':'Certificado credenciado e reconhecido pela sua lei',
      'comp.b.2':'Nota fiscal local e atendimento no seu idioma',
      'comp.b.3':'Atuam em um país: se você assina com o Brasil, não serve',
      'comp.b.4':'O produto é a assinatura, não o fluxo de trabalho',
      'comp.b.5':'Sem envio em massa por planilha nem API para integrar',
      'comp.c.q':'MiFirma','comp.c.h':'As duas coisas',
      'comp.c.1':'Fluxo completo: campos, ordem de assinatura, cópias e lotes',
      'comp.c.2':'Certificados credenciados do Uruguai, Paraguai e Brasil',
      'comp.c.3':'Assinatura simples e avançada no mesmo circuito, sem adicional por destinatário',
      'comp.c.4':'Você paga pelo que assina, na sua moeda e com nota fiscal local',
      'comp.c.5':'Sem licenças por usuário nem limites de envio',
      'comp.nota':'As plataformas globais resolvem muito bem o fluxo de trabalho: campos, lembretes e auditoria. A diferença não está aí, e sim em como se cobra e em qual certificado se usa para que a assinatura valha onde você opera.',
      'nav.como':'Como funciona','nav.garantias':'Garantias','nav.paises':'Países','nav.planes':'Planos',
      'nav.entrar':'Entrar','nav.probar':'Testar',
      // ⚠ Decía «validade jurídica no seu país». Ver el comentario del H1 en
      // sitio.html: la promesa jurídica sale hasta que un abogado local firme
      // el paquete de cada país. Los tres idiomas cambian juntos, o el que no
      // cambió se convierte en la letra chica que nadie leyó.
      'hero.h1a':'Assine documentos com','hero.h1b':'prova de quem assinou','hero.h1c':'e quando.',
      'hero.lead':'Envie um PDF, marque o que cada pessoa precisa preencher e em que ordem cada uma assina. O MiFirma cuida do resto: os avisos, a assinatura criptográfica e o dossiê que comprova tudo o que aconteceu.',
      'hero.cta1':'Ver planos','hero.cta2':'Como funciona',
      'hero.nota':'Sem instalar nada. Quem assina não precisa criar conta.',
      'maq.archivo':'Contrato de aluguel.pdf','maq.tag1':'PREENCHE','maq.tag1b':'PREENCHE',
      'maq.campo1':'Valor mensal','maq.campo2':'Data de entrega',
      'maq.firmado':'Assinado · carimbo do tempo · LTV','maq.firmantes':'Signatários',
      'maq.firmo':'Assinou','maq.firmo2':'Assinou','maq.espera':'É a vez','maq.evidencia':'Dossiê',
      'maq.ev1':'Documento aberto','maq.ev2':'Identidade comprovada','maq.ev3':'Assinatura aplicada',
      'tira.et':'Certificados de assinatura avançada de',
      'gar.kicker':'O que não se negocia','gar.h2':'Segurança, integridade e rastreabilidade.',
      'gar.p':'São três coisas diferentes, e as três precisam existir. Uma assinatura que ninguém consegue verificar daqui a cinco anos não serve, por mais bonita que seja a tela onde foi feita.',
      'gar.1.h':'Segurança','gar.1.p':'Cada documento é criptografado e o acesso é decidido no banco de dados, não na aplicação. Um erro de programação não basta para alguém ver o que não lhe cabe. Nunca guardamos chaves privadas de assinatura, nem as nossas.',
      'gar.2.h':'Integridade','gar.2.p':'Depois de assinado, o documento não pode ser alterado sem que isso apareça. Cada assinatura fica encadeada à anterior e carimbada com a hora de uma autoridade externa: a data não depende do nosso relógio nem da nossa palavra.',
      'gar.3.h':'O marco legal de cada país','gar.3.p':'A lei não é a mesma em Montevidéu, em Assunção e em São Paulo. Cada país tem seu marco e seus certificadores credenciados, e o MiFirma trabalha com os de cada um. A lei local quem revisa é um advogado local, não um algoritmo.',
      'campos.kicker':'Preencher antes de assinar','campos.h2':'A maioria dos documentos não se assina: primeiro se preenche.',
      'campos.p':'Uma nota promissória precisa do valor. Um aluguel, da data de entrega. Um consentimento, do número do documento de quem assina. Enviar um PDF vazio e pedir que preencham à mão antes de digitalizar é exatamente o trabalho que viemos tirar de você.',
      'campos.1.h':'Cada um vê o seu.','campos.1.p':'Os campos são atribuídos por signatário. Ninguém preenche — nem vê — o que é do outro.',
      'campos.2.h':'Com regras.','campos.2.p':'Obrigatório ou opcional; texto, número, data ou seleção. É validado antes de a assinatura ser aplicada, não depois.',
      'campos.3.h':'E fica dentro do documento.','campos.3.p':'O preenchido faz parte do PDF assinado. Não é um anexo à parte que depois ninguém encontra.',
      'camino.h':'Caminho de assinaturas','camino.1':'Ana · Inquilina','camino.2':'Marcos · Fiador','camino.3':'Rita · Fiadora',
      'camino.4':'Jorge · Proprietário','camino.5':'Imobiliária · Cópia',
      'camino.ok':'Assinou','camino.ok2':'Assinou','camino.esp':'É a vez','camino.esp2':'Aguarda','camino.copia':'Sem assinar',
      'evid.kicker':'A prova','evid.h2':'Cada assinatura vem com seu dossiê.',
      'evid.p':'Não basta um PDF com um rabisco. O que sustenta uma assinatura num processo é poder mostrar quem a fez, quando, de onde e como se comprovou que era aquela pessoa. Isso é registrado sozinho, passo a passo, e entregue junto com o documento.',
      'evid.1.h':'Encadeado.','evid.1.p':'Cada evento fica ligado ao anterior: se alguém altera um, a corrente quebra e aparece.',
      'evid.2.h':'Com hora de um terceiro.','evid.2.p':'O carimbo do tempo é de uma autoridade credenciada, não do nosso servidor.',
      'evid.3.h':'Verificável sem nós.','evid.3.p':'O certificado se confere em qualquer leitor de PDF, mesmo que o MiFirma não exista mais.',
      'evid.tit':'Dossiê · Contrato de aluguel','evid.e1':'Circuito despachado','evid.e2':'Documento aberto',
      'evid.e3':'Identidade comprovada','evid.e4':'Campos preenchidos','evid.e5':'Assinatura aplicada','evid.e6':'Certificado emitido',
      'como.kicker':'Como funciona','como.h2':'Quatro passos, e o quarto é o sistema que faz.',
      'como.p':'Você monta uma vez e repete quantas vezes quiser. Se enviar o mesmo contrato para trezentas pessoas, ele se personaliza sozinho a partir de uma planilha.',
      'como.1.h':'Envie o documento','como.1.p':'Um PDF, do jeito que você tem.',
      'como.2.h':'Marque o que cada um preenche','como.2.p':'Valor, data, número do documento, uma cláusula. Cada signatário vê só os seus campos.',
      'como.3.h':'Defina o caminho','como.3.p':'Em ordem, todos ao mesmo tempo, ou misto. Com cópias para quem precisa saber sem assinar.',
      'como.4.h':'Assinam e você recebe tudo','como.4.p':'O documento assinado, o certificado de conclusão e o dossiê completo.',
      'pais.kicker':'Onde tem valor','pais.h2':'Um produto, três marcos legais.',
      'pais.p':'A diferença entre uma assinatura que se sustenta num processo e uma que não costuma estar no país onde foi assinada. O MiFirma se integra com os certificadores credenciados de cada um.',
      'planes.kicker':'Planos','planes.h2':'Você paga pelo que assina.',
      'planes.p':'Na sua moeda e com nota fiscal local. Sem mínimo de usuários nem licenças sobrando.',
      'cierre.h2':'Comece com um documento.','cierre.p':'Crie sua conta, envie um PDF e mande assinar. Você vai ver o dossiê completo do primeiro.',
      'cierre.cta1':'Criar conta','cierre.cta2':'Ver planos',
      'footer.legal':'Assinatura eletrônica · Uruguai · Paraguai · Brasil',
      'planes.consultar':'Consultar','planes.mes':'por mês','planes.vacio':'Ainda não há planos publicados para este país.',
      'planes.elegir':'Começar','planes.destacado':'Mais escolhido','pais.cert':'Certificados de '
    },
    en: {
      'nav.comparar':'Compare',
      'comp.kicker':'What you’ll compare us to','comp.h2':'Today you choose between a global platform and a local certifier.',
      'comp.p':'Each solves part of it. The global ones bring a mature product, but they charge per user and in foreign currency, with accredited signing as a separate surcharge. Local certifiers have the certificate your law recognises, but they operate in a single country.',
      'comp.a.q':'Global platforms','comp.a.h':'Mature product, someone else’s model',
      'comp.a.1':'Very mature workflow, fields and audit trail',
      'comp.a.2':'Charged per user per month, in foreign currency',
      'comp.a.3':'With send limits per user, whether you use them or not',
      'comp.a.4':'Accredited signing is a per-recipient surcharge',
      'comp.a.5':'Foreign invoicing and support in another time zone',
      'comp.b.q':'Local certifiers','comp.b.h':'The right certificate, one country',
      'comp.b.1':'Accredited certificate, recognised by your law',
      'comp.b.2':'Local invoicing and support in your language',
      'comp.b.3':'They operate in one country: no use if you sign with Brazil',
      'comp.b.4':'The product is the signature, not the workflow',
      'comp.b.5':'No bulk send from a spreadsheet, no API to integrate',
      'comp.c.q':'MiFirma','comp.c.h':'Both at once',
      'comp.c.1':'Full workflow: fields, signing order, copies and batches',
      'comp.c.2':'Accredited certificates from Uruguay, Paraguay and Brazil',
      'comp.c.3':'Simple and advanced signing in the same flow, no per-recipient surcharge',
      'comp.c.4':'You pay for what you sign, in your currency, with local invoicing',
      'comp.c.5':'No per-user licences, no send limits',
      'comp.nota':'Global platforms solve the workflow very well: fields, reminders and audit trail. The difference isn’t there — it’s in how you’re charged and which certificate makes the signature hold where you operate.',
      'nav.como':'How it works','nav.garantias':'Guarantees','nav.paises':'Countries','nav.planes':'Pricing',
      'nav.entrar':'Sign in','nav.probar':'Try it',
      'hero.h1a':'Sign documents with','hero.h1b':'proof of who signed','hero.h1c':'and when.',
      'hero.lead':'Upload a PDF, mark what each person has to fill in and the order they sign in. MiFirma handles the rest: the reminders, the cryptographic signature and the evidence file that proves everything that happened.',
      'hero.cta1':'See pricing','hero.cta2':'How it works',
      'hero.nota':'Nothing to install. Signers don’t need an account.',
      'maq.archivo':'Lease agreement.pdf','maq.tag1':'FILLS IN','maq.tag1b':'FILLS IN',
      'maq.campo1':'Monthly amount','maq.campo2':'Handover date',
      'maq.firmado':'Signed · timestamped · LTV','maq.firmantes':'Signers',
      'maq.firmo':'Signed','maq.firmo2':'Signed','maq.espera':'Their turn','maq.evidencia':'Evidence file',
      'maq.ev1':'Document opened','maq.ev2':'Identity proven','maq.ev3':'Signature applied',
      'tira.et':'Advanced signature certificates from',
      'gar.kicker':'Non-negotiable','gar.h2':'Security, integrity and traceability.',
      'gar.p':'Three different things, and all three have to be there. A signature nobody can verify five years from now is worthless, however nice the screen it was made on.',
      'gar.1.h':'Security','gar.1.p':'Every document is encrypted and access is decided in the database, not in the application. A coding mistake isn’t enough for someone to see what isn’t theirs. We never store signing private keys — not even our own.',
      'gar.2.h':'Integrity','gar.2.p':'Once signed, the document cannot be altered without it showing. Each signature is chained to the previous one and stamped with the time from an external authority, so the date doesn’t depend on our clock or our word.',
      'gar.3.h':'Each country’s legal framework','gar.3.p':'The law isn’t the same in Montevideo, Asunción and São Paulo. Each country has its own framework and accredited certifiers, and MiFirma works with each one’s. Local law is reviewed by a local lawyer, not by an algorithm.',
      'campos.kicker':'Fill in before signing','campos.h2':'Most documents aren’t signed first — they’re filled in first.',
      'campos.p':'A promissory note needs the amount. A lease needs the handover date. A consent form needs the signer’s ID number. Sending an empty PDF and asking people to fill it in by hand before scanning it is exactly the work we came to take off your plate.',
      'campos.1.h':'Each sees their own.','campos.1.p':'Fields are assigned per signer. Nobody fills in — or sees — what belongs to someone else.',
      'campos.2.h':'With rules.','campos.2.p':'Required or optional; text, number, date or choice. Validated before the signature is applied, not after.',
      'campos.3.h':'And it stays in the document.','campos.3.p':'What was filled in becomes part of the signed PDF. Not a separate attachment nobody can find later.',
      'camino.h':'Signing path','camino.1':'Ana · Tenant','camino.2':'Marcos · Guarantor','camino.3':'Rita · Guarantor',
      'camino.4':'Jorge · Landlord','camino.5':'Agency · Copy',
      'camino.ok':'Signed','camino.ok2':'Signed','camino.esp':'Their turn','camino.esp2':'Waiting','camino.copia':'No signature',
      'evid.kicker':'The proof','evid.h2':'Every signature comes with its evidence file.',
      'evid.p':'A PDF with a squiggle isn’t enough. What holds a signature up in court is being able to show who made it, when, from where, and how it was proven to be that person. That’s recorded automatically, step by step, and delivered with the document.',
      'evid.1.h':'Chained.','evid.1.p':'Each event is linked to the previous one: alter one and the chain breaks visibly.',
      'evid.2.h':'Timed by a third party.','evid.2.p':'The timestamp comes from an accredited authority, not from our server.',
      'evid.3.h':'Verifiable without us.','evid.3.p':'The certificate checks out in any PDF reader, even if MiFirma no longer exists.',
      'evid.tit':'Evidence file · Lease agreement','evid.e1':'Envelope dispatched','evid.e2':'Document opened',
      'evid.e3':'Identity proven','evid.e4':'Fields completed','evid.e5':'Signature applied','evid.e6':'Certificate issued',
      'como.kicker':'How it works','como.h2':'Four steps, and the fourth one is the system’s.',
      'como.p':'Set it up once and repeat it as often as you like. Sending the same contract to three hundred people? It personalises itself from a spreadsheet.',
      'como.1.h':'Upload the document','como.1.p':'A PDF, just as you have it.',
      'como.2.h':'Mark what each person fills in','como.2.p':'Amount, date, ID number, a clause. Each signer sees only their own fields.',
      'como.3.h':'Set the path','como.3.p':'In order, all at once, or mixed. With copies for whoever needs to know without signing.',
      'como.4.h':'They sign, you get everything','como.4.p':'The signed document, the completion certificate and the full evidence file.',
      'pais.kicker':'Where it holds up','pais.h2':'One product, three legal frameworks.',
      'pais.p':'The difference between a signature that holds up in court and one that doesn’t usually comes down to the country it was signed in. MiFirma integrates with each one’s accredited certifiers.',
      'planes.kicker':'Pricing','planes.h2':'You pay for what you sign.',
      'planes.p':'In your currency, with local invoicing. No user minimums, no licences going to waste.',
      'cierre.h2':'Start with one document.','cierre.p':'Create your account, upload a PDF and send it out. You’ll see the full evidence file of the very first one.',
      'cierre.cta1':'Create account','cierre.cta2':'See pricing',
      'footer.legal':'Electronic signature · Uruguay · Paraguay · Brazil',
      'planes.consultar':'Ask us','planes.mes':'per month','planes.vacio':'No plans published for this country yet.',
      'planes.elegir':'Get started','planes.destacado':'Most chosen','pais.cert':'Certificates from '
    }
  };

  // El español es el original y vive en el HTML: sirve de respaldo si falta una clave.
  var BASE = {};
  document.querySelectorAll('[data-t]').forEach(function(el){ BASE[el.dataset.t] = el.textContent; });
  T.es = Object.assign({}, BASE, {
    'planes.consultar':'Consultar','planes.mes':'por mes','pais.cert':'Certificados de ',
    'planes.vacio':'Todavía no hay planes publicados para este país.',
    'planes.elegir':'Empezar','planes.destacado':'El más elegido'
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
    pintarPaises(); pintarSelector(); cargarPlanes(PAIS);
  }

  /* ---------------- Países ----------------
     Sale de `/publico/paises`, que lo lee del catálogo de la base.

     ⚠ Acá estaban escritos a mano los tres países del MVP con su ley y su
     certificador. Un archivo del navegador es el peor lugar posible para una
     afirmación legal: nadie lo revisa cuando cambia una ley, y no tiene dónde
     anotar quién la verificó. Ahora eso es dato del paquete de país.

     Se conserva un respaldo mínimo para el caso de que la API no conteste: sin
     él la página quedaría sin países y sin explicación. */
  var RESPALDO = {
    UY:{ nombre:{es:'Uruguay',pt:'Uruguai',en:'Uruguay'}, ley:'Ley 18.600', cert:'tuID (Antel)', b:'🇺🇾' },
    PY:{ nombre:{es:'Paraguay',pt:'Paraguai',en:'Paraguay'}, ley:'Ley 4017', cert:'e-Firma', b:'🇵🇾' },
    BR:{ nombre:{es:'Brasil',pt:'Brasil',en:'Brazil'}, ley:'MP 2.200-2', cert:'ICP-Brasil (SERPRO)', b:'🇧🇷' }
  };
  var PAISES = JSON.parse(JSON.stringify(RESPALDO));
  var ORDEN = ['UY','PY','BR'], DISPONIBLES = ORDEN.slice(), PAIS = 'UY';

  function pintarPaises(){
    var c = document.getElementById('paisesDetalle');
    if (!c) return;
    c.innerHTML = ORDEN.filter(function(k){ return PAISES[k]; }).map(function(k){
      var p = PAISES[k];
      var nom = p.nombre[LANG] || p.nombre.es || k;
      return '<div class="card rev on"><div class="ico t" style="font-size:24px">' + (p.b||'') + '</div>' +
             '<h3>' + nom + '</h3>' +
             '<p>' + (p.ley ? '<b style="color:var(--ink)">' + p.ley + '</b><br>' : '') +
             (p.cert ? t('pais.cert') + p.cert + '.' : '') + '</p></div>';
    }).join('');
  }

  function pintarSelector(){
    var c = document.getElementById('selPais');
    if (!c) return;
    c.innerHTML = DISPONIBLES.map(function(k){
      var p = PAISES[k] || { b:'', nombre:{} };
      return '<button data-p="' + k + '" onclick="elegirPais(\'' + k + '\')">' +
             (p.b ? p.b + ' ' : '') + (p.nombre[LANG] || p.nombre.es || k) + '</button>';
    }).join('');
    marcarPais();
  }
  function marcarPais(){
    document.querySelectorAll('#selPais button').forEach(function(b){
      b.setAttribute('aria-pressed', String(b.dataset.p === PAIS));
    });
  }
  function elegirPais(k){ PAIS = k; marcarPais(); cargarPlanes(k); }

  /* ---------------- Planes ----------------
     Ni un monto está escrito acá: sale de la base, cargado por el operador.
     Un plan sin precio para este país no aparece. */
  function moneda(v, m){
    try{
      return new Intl.NumberFormat(LANG==='pt'?'pt-BR':LANG==='en'?'en-US':'es-UY',
        { style:'currency', currency:m, maximumFractionDigits: v % 1 ? 2 : 0 }).format(v);
    }catch(e){ return m + ' ' + v; }
  }
  var METRICA = {
    firma:{es:'Por firma',pt:'Por assinatura',en:'Per signature'},
    documento:{es:'Por documento',pt:'Por documento',en:'Per document'},
    circuito:{es:'Por circuito',pt:'Por circuito',en:'Per envelope'},
    sms:{es:'SMS',pt:'SMS',en:'SMS'}
  };
  var NIVEL = { simple:{es:'simple',pt:'simples',en:'simple'}, avanzada:{es:'avanzada',pt:'avançada',en:'advanced'} };

  async function cargarPaises(){
    try{
      var r = await fetch('/publico/paises');
      var j = await r.json();
      var l = j.paises || [];
      if (l.length){
        // ⚠ Se REEMPLAZA el mapa, no se completa. Si el catálogo dejó de
        // devolver un país, es porque dejamos de operar ahí; conservar la
        // versión vieja lo mantendría en la página con su ley y todo.
        PAISES = {};
        l.forEach(function(x){
          PAISES[x.pais] = {
            nombre: x.nombre_i18n || { es:x.pais },
            ley: x.marco_legal || '',
            cert: x.certificador || '',
            b: x.bandera || ''
          };
        });
        ORDEN = l.map(function(x){ return x.pais; });
        DISPONIBLES = ORDEN.slice();
      }
    }catch(e){ /* sin API, quedan los tres del respaldo */ }
    if (DISPONIBLES.indexOf(PAIS) < 0) PAIS = DISPONIBLES[0];
    pintarPaises();
    pintarSelector();
  }

  async function cargarPlanes(pais){
    var cont = document.getElementById('listaPlanes');
    if (!cont) return;
    try{
      var r = await fetch('/publico/planes?pais=' + encodeURIComponent(pais));
      var j = await r.json();
      var planes = j.planes || [];
      if (!planes.length){ cont.innerHTML = '<div class="vacio">' + t('planes.vacio') + '</div>'; return; }

      cont.innerHTML = planes.map(function(p){
        var abono = (p.precios||[]).filter(function(x){ return x.metrica === 'abono'; })[0];
        var unit  = (p.precios||[]).filter(function(x){ return x.metrica !== 'abono'; });

        var precio = abono
          ? '<div class="precio"><span class="n">' + moneda(abono.precio, p.moneda) + '</span><span class="u">' + t('planes.mes') + '</span></div>'
          : '<div class="precio"><span class="n">' + t('planes.consultar') + '</span></div>';

        var filas = unit.map(function(x){
          var n = (METRICA[x.metrica]||{})[LANG] || x.metrica;
          if (x.nivel_firma) n += ' ' + ((NIVEL[x.nivel_firma]||{})[LANG] || x.nivel_firma);
          return '<div><span>' + n + '</span><span>' + moneda(x.precio, p.moneda) + '</span></div>';
        }).join('');

        var inc = (p.incluye||[]).map(function(i){ return '<li>' + i + '</li>'; }).join('');

        return '<div class="plan' + (p.destacado ? ' destacado' : '') + '">' +
          (p.destacado ? '<span class="tag">' + t('planes.destacado') + '</span>' : '') +
          '<h3>' + p.nombre + '</h3>' +
          '<p class="desc">' + (p.descripcion || '') + '</p>' + precio +
          (filas ? '<div class="unit">' + filas + '</div>' : '') +
          (inc ? '<ul class="incluye">' + inc + '</ul>' : '') +
          '<a class="btn ' + (p.destacado ? 'btn-p' : 'btn-s') + '" href="/entrar#crear">' + t('planes.elegir') + '</a></div>';
      }).join('');
    }catch(e){
      cont.innerHTML = '<div class="vacio">' + t('planes.vacio') + '</div>';
    }
  }

  /* ---------------- Aparición al desplazar ---------------- */
  function revelar(){
    if (!('IntersectionObserver' in window)) {
      document.querySelectorAll('.rev').forEach(function(e){ e.classList.add('on'); });
      return;
    }
    var io = new IntersectionObserver(function(ent){
      ent.forEach(function(e){ if (e.isIntersecting){ e.target.classList.add('on'); io.unobserve(e.target); } });
    }, { rootMargin:'0px 0px -8% 0px', threshold:.08 });
    document.querySelectorAll('.rev').forEach(function(e){ io.observe(e); });
  }

  window.idioma = idioma;
  window.elegirPais = elegirPais;

  var guardado; try{ guardado = localStorage.getItem('mf_lang'); }catch(e){}
  var nav = (navigator.language || 'es').slice(0,2);
  if (!guardado && nav === 'pt') PAIS = 'BR';
  idioma(guardado || (T[nav] ? nav : 'es'));
  cargarPaises().then(function(){ cargarPlanes(PAIS); });
  revelar();
})();
