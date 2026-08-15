import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { abrirContextoPedido, fijarSesionDelPedido } from './auth/contexto_pedido';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { readFileSync, statSync} from 'node:fs';
import { ZodError } from 'zod';
import { autenticar, type Identidad } from './auth/identity';
import { HttpError } from './http/errors';
import { realmDePath, tokenDeCookie, tokenCsrfDeCookie, setCookieSesion, setCookieCsrf, LOGIN_PATHS } from './http/cookies_sesion';
import { verificarTokenOperador } from './operador/sesion';
import { registrarRutasAuth } from './http/routes/auth';
import { registrarRutasChat } from './http/routes/chat';
import { registrarRutasUsuarios } from './http/routes/usuarios';
import { registrarRutasRoles } from './http/routes/roles';
import { registrarRutasCarpetas } from './http/routes/carpetas';
import { registrarRutasAvisos } from './http/routes/avisos';
import { registrarRutasPerfil } from './http/routes/perfil';
import { registrarRutasOperador } from './http/routes/operador';
import { registrarRutasPublico } from './http/routes/publico';
import { registrarRutasPagosWebhook } from './http/routes/pagos_webhook';
import { registrarRutasAyuda } from './http/routes/ayuda';
import { registrarRutasDocumentos } from './http/routes/documentos';
import { registrarRutasRepositorio } from './http/routes/repositorio';
import { registrarRutasCircuitos } from './http/routes/circuitos';
import { registrarRutasFirma } from './http/routes/firma';

declare module 'fastify' {
  interface FastifyRequest {
    identidad: Identidad;
    authViaCookie: boolean; // true si la identidad se resolvió por cookie (no por Authorization)
  }
}

// Fase C (medir, sin cortar): loguea en warn cuando una request se autenticó por el header
// Authorization en vez de por cookie (cliente con JS viejo). Solo observabilidad: no cambia
// el flujo. Sin token ni datos sensibles: realm + ruta + método + user-agent truncado.
// Se excluye /integracion/* (usa api_token por header, es lo esperado).
function avisarAuthPorHeader(req: FastifyRequest, realm: string, path: string): void {
  if (path.startsWith('/integracion/')) return;
  const ua = req.headers['user-agent'];
  req.log.warn(
    { evento: 'auth_por_header_fase_c', realm, ruta: path, metodo: req.method, ua: (ua || '').slice(0, 120) },
    'Fase C: identidad resuelta por header Authorization (sin cookie)',
  );
}

export function construirServidor(): FastifyInstance {
  const app = Fastify({ logger: true, bodyLimit: 5 * 1024 * 1024, trustProxy: true }); // 5 MB: margen para subidas de imágenes en base64 (banners, fotos)

  // ⚠⚠ LA IP REAL DEL CLIENTE — y por qué se arregla acá arriba y no en cada llamador.
  //
  // `trustProxy: true` (arriba) hace que `req.ip` salga del PRIMER valor de la
  // cabecera `X-Forwarded-For`, que la manda el cliente. Medido el 11/8/2026 con
  // Fastify 5: con `X-Forwarded-For: 9.9.9.9`, `req.ip` vale `9.9.9.9`. O sea que
  // todo tope por IP era decorativo —cada pedido estrenaba cubeta cambiando un
  // número— y la IP que queda escrita en el expediente (`evidencia.ip`) la elegía
  // quien firma. En un producto de firma, esa columna es prueba.
  //
  // Cloudflare REESCRIBE `CF-Connecting-IP` en cada pedido, pise lo que pise el
  // cliente. Así que acá se pisa la XFF con ella antes de que nadie lea `req.ip`;
  // y si no viene, se borra la XFF y `req.ip` cae a la IP del socket.
  //
  // ⚠ Esto vale mientras TODO el tráfico entre por Cloudflare. Hoy vale porque el
  // 9/8 se borró el dominio público de Railway. Si algún día vuelve a existir un
  // camino directo al origen, esta cabecera se vuelve falsificable de nuevo.
  //
  // ⚠ El hook va PRIMERO a propósito: los hooks corren en el orden en que se dan
  // de alta, y el del rate-limit lo agrega su plugin al cargar, o sea después.
  //
  // ⚠ Y se corrige acá y no en cada llamador también a propósito: así `req.ip`
  // queda bien en los 22 lugares que lo usan —incluidos los ocho del expediente
  // de firma— sin tocar un solo archivo del dominio de firma, que está sellado.
  //
  // ⚠ Se toca SÓLO `x-forwarded-for`. `x-forwarded-proto` no se toca: de ahí sale
  // `req.protocol`, y con él el flag `Secure` de las cookies de sesión.
  app.addHook('onRequest', async (req) => {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf.trim()) req.headers['x-forwarded-for'] = cf.trim();
    else delete req.headers['x-forwarded-for'];
  });

  // Rate-limit por IP: defensa en profundidad contra fuerza bruta y abuso. Dos cubetas por
  // IP — una estricta para autenticación/alta, otra holgada para el uso normal de la app
  // (que hace muchas llamadas). Store en memoria: con varias instancias el límite es por
  // instancia, suficiente para el MVP. La IP con la que cuenta es la que deja el hook de
  // arriba, no la que manda el cliente.
  //
  // ⚠⚠ Y LAS RUTAS SE DECLARAN ADENTRO DE `app.after` (al final de esta función). Este
  // `register` NO carga el plugin en el acto: lo encola. Una ruta declarada antes de que
  // cargue no recibe el tope — ni el global de acá, ni el suyo propio de `config.rateLimit`.
  // Así estuvo desde que se escribió. Medido el 11/8/2026 contra el servidor: siete pedidos
  // seguidos a `/auth/registro` (tope 5/hora) pasaron los siete, y ninguna respuesta trajo
  // cabeceras `x-ratelimit-*`. Si alguna vez estas trece líneas salen del `after`, el tope
  // vuelve a desaparecer en silencio y nada lo avisa.
  const PREFIJOS_AUTH = ['/auth/', '/enrolar', '/operador/login', '/estudio/login', '/estudio/registro', '/estudio/reset', '/oferente/login', '/oferente/registro', '/oferente/reset'];
  const esAuth = (url: string) => {
    const path = (url || '').split('?')[0];
    return PREFIJOS_AUTH.some((p) => path.startsWith(p));
  };
  app.register(rateLimit, {
    global: true,
    timeWindow: '1 minute',
    max: (req: any) => (esAuth(req.url) ? 20 : 600),
    keyGenerator: (req: any) => (req.ip || 'sin-ip') + '|' + (esAuth(req.url) ? 'auth' : 'gen'),
    // ⚠ Un `HttpError`, NO un objeto pelado. El plugin LANZA lo que devuelve esta función
    // (`@fastify/rate-limit`, index.js:375), así que cae en `setErrorHandler`. Un objeto sin
    // `statusCode` se lee como 500 y sale tapado con «ocurrió un error en el servidor» —
    // medido el 11/8/2026, el primer día que el tope frenó algo. Nunca se había ejecutado:
    // el plugin no estaba enganchado a ninguna ruta, así que esta línea era letra muerta
    // desde que se escribió. Con `HttpError` sale 429 y con el texto de acá, que es apto
    // para el usuario.
    errorResponseBuilder: () =>
      new HttpError(429, 'Demasiadas solicitudes. Esperá un momento y reintentá.'),
  });

  // Cookies de sesión httpOnly (Fase A migración a cookies; ver docs/plan-auth-httponly-cookies.md).
  // Parsea req.cookies y habilita reply.setCookie/clearCookie. Sin firma: el valor es un JWT
  // que ya se verifica por su propia firma; no hace falta firmar la cookie además.
  app.register(cookie);

  // Subida de documentos. El `bodyLimit` de arriba (5 MB) es para cuerpos JSON;
  // los PDF van por multipart, con su propio tope. Un archivo por request: la
  // subida masiva es otro camino —una planilla más un PDF plantilla— y no una
  // request con doscientos adjuntos.
  app.register(multipart, { limits: { fileSize: 30 * 1024 * 1024, files: 1 } });

  // Cabeceras de seguridad en todas las respuestas (defensa en profundidad):
  //  - nosniff: el navegador no reinterpreta el tipo de un archivo (clave para los
  //    documentos subidos por usuarios: evita que un archivo se ejecute como HTML).
  //  - X-Frame-Options + frame-ancestors 'none': evitan clickjacking (embeber la app).
  //  - HSTS: fuerza HTTPS en visitas futuras.
  //  - CSP: permite el JS/CSS inline que usa el frontend y las fuentes de Google, y
  //    bloquea la carga de scripts/recursos de otros orígenes. Rutas que sirven imágenes
  //    (p. ej. SVG de beneficios) fijan su propia CSP más estricta en su handler.
  // ⚠ PRIMER hook de todos: abre el contexto del pedido.
  //
  // Va con `done()` adentro del `run` y no como hook async, porque lo que tiene
  // que quedar dentro del contexto es TODO lo que viene después —los otros
  // hooks, el handler, y cada `await` de la cadena—. Comprobado que propaga y
  // que no se cruza entre pedidos concurrentes antes de ponerlo acá.
  app.addHook('onRequest', (_req, _reply, done) => {
    abrirContextoPedido(() => done());
  });

  app.addHook('onRequest', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; " +
        // ⚠ `challenges.cloudflare.com` es el cartelito de «no soy un robot»
        // (Turnstile). Va en DOS directivas y hacen falta las dos: `script-src`
        // para el archivo que se carga, y `frame-src` porque el cartelito se
        // dibuja adentro de un iframe suyo. Con una sola, el widget no aparece y
        // la consola del navegador es el único lugar donde se entera alguien.
        //
        // ⚠⚠ Y `frame-src` lleva `'self'` PRIMERO, aprendido rompiendo: sin
        // `frame-src`, los iframes se rigen por `default-src 'self'` y la
        // consola podía embeber sus propios documentos. Al agregar la directiva
        // para Turnstile (10/8 de noche), el fallback dejó de existir y el visor
        // de documentos quedó bloqueado EN TODOS los navegadores — Chrome con un
        // cartel, Safari en blanco y callado. Se descubrió recién al día
        // siguiente, probando otra cosa. Una directiva explícita reemplaza al
        // fallback entero: hay que volver a decir lo que antes se heredaba.
        //
        // ⚠ `blob:` en `frame-src` es el visor (deuda 16, 12/8): la consola pide
        // el PDF con fetch —para poder LEER el error cuando los bytes no están,
        // en vez del ícono roto— y se lo da al iframe como blob. Un blob sólo
        // puede crearlo un script nuestro con datos que ya tiene, así que no
        // abre la puerta a embeber nada ajeno; `'self'` no lo cubre porque el
        // esquema `blob:` no cuenta como el propio origen. Igual que `img-src`,
        // que ya lo traía por las vistas previas.
        "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; " +
        "frame-src 'self' blob: https://challenges.cloudflare.com; " +
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src 'self' https://fonts.gstatic.com data:; " +
        "img-src 'self' data: blob:; " +
        "connect-src 'self'; " +
        "worker-src 'self'; " +
        "frame-ancestors 'none'; " +
        "base-uri 'self'; " +
        "form-action 'self'; " +
        "object-src 'none'",
    );

    // ── ⚠ FUERA DEL BUSCADOR, DE VERDAD ─────────────────────────────────────
    //
    // `robots.txt` es un pedido de buena fe: lo respeta el que quiere, y no
    // impide que una dirección aparezca indexada si alguien la enlaza desde
    // otro lado. Esta cabecera sí es una instrucción, y la respetan Google y
    // Bing.
    //
    // ⚠ **En `/firmar` es lo que más importa.** Esa dirección lleva el token
    // del firmante: un enlace de firma indexado es el documento de un cliente
    // abierto para cualquiera que lo busque. `robots.txt` solo no alcanza.
    //
    // El sitio comercial —`/` y lo que se le agregue— NO lleva la cabecera:
    // eso es contenido y tiene que poder encontrarse.
    const camino = (_req.url || '/').split('?')[0] || '/';
    if (/^\/(entrar|app|operador|firmar|publico)(\/|$)/.test(camino)) {
      reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
    }
  });

  app.get('/health', async () => ({ ok: true }));

  // ── Los tres archivos que el buscador y las redes van a pedir ─────────────
  //
  // ⚠ Van con ruta propia porque **acá no hay servidor de estáticos**: cada
  // archivo de `public/` que se sirve está en una de las listas de más abajo,
  // por nombre. Dejarlos sólo en la carpeta los deja en 404 — y un `og.png` en
  // 404 es un enlace compartido sin imagen, que es justo lo que se quería
  // arreglar.
  for (const [ruta, tipo] of [
    ['robots.txt', 'text/plain; charset=utf-8'],
    ['sitemap.xml', 'application/xml; charset=utf-8'],
  ] as const) {
    app.get('/' + ruta, async (_req, reply) => {
      try {
        reply
          .type(tipo)
          .header('Cache-Control', 'public, max-age=3600')
          .send(readFileSync(new URL('../public/' + ruta, import.meta.url), 'utf8'));
      } catch {
        reply.code(404).send('no encontrado');
      }
    });
  }

  // La tarjeta social. Se cachea largo: la piden los servidores de WhatsApp y
  // LinkedIn, no el navegador de la persona, y cambia una vez por año.
  app.get('/og.png', async (_req, reply) => {
    try {
      reply
        .type('image/png')
        .header('Cache-Control', 'public, max-age=86400')
        .send(readFileSync(new URL('../public/og.png', import.meta.url)));
    } catch {
      reply.code(404).send('og no encontrado');
    }
  });

  // Sitio comercial (público): presentación + planes + enrolamiento self-service.
  app.get('/', async (_req, reply) => {
    try {
      const html = readFileSync(new URL('../public/sitio.html', import.meta.url), 'utf8');
      reply.type('text/html').send(html);
    } catch {
      reply.type('text/html').send('<h1>Falta public/sitio.html</h1>');
    }
  });

  // Consola del CLIENTE (empresa): la app de siempre, ahora servida en /app.
  // La página es pública; las APIs validan el token de empresa adentro.
  app.get('/app', async (_req, reply) => {
    try {
      const html = sellarEstaticos(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'));
      reply.header('Cache-Control', 'no-store').type('text/html').send(html);
    } catch {
      reply.type('text/html').send('<h1>Falta public/index.html</h1>');
    }
  });

  // Consola de OPERADOR (proveedor del SaaS): página aparte, otra URL, otro acceso.
  // La página es pública; las APIs /operador/* validan el token de operador adentro.
  app.get('/operador', async (_req, reply) => {
    try {
      const html = sellarEstaticos(readFileSync(new URL('../public/operador.html', import.meta.url), 'utf8'));
      reply.header('Cache-Control', 'no-store').type('text/html').send(html);
    } catch {
      reply.type('text/html').send('<h1>Falta public/operador.html</h1>');
    }
  });




  // Página del FIRMANTE EXTERNO. Pública: quien llega no tiene cuenta y no
  // debería necesitar una. La autorización la lleva el token del enlace, que se
  // cambia por una cookie acotada a /firmar en `POST /firmar/abrir`.
  app.get('/firmar', async (_req, reply) => {
    try {
      const html = sellarEstaticos(readFileSync(new URL('../public/firmar.html', import.meta.url), 'utf8'));
      reply.header('Cache-Control', 'no-store').type('text/html').send(html);
    } catch {
      reply.type('text/html').send('<h1>Falta public/firmar.html</h1>');
    }
  });

  // Página de ACCESO: login y alta de empresa. Un solo realm.
  // Pública; sus llamadas (/auth/*) validan adentro.
  app.get('/entrar', async (_req, reply) => {
    try {
      const html = sellarEstaticos(readFileSync(new URL('../public/entrar.html', import.meta.url), 'utf8'));
      reply.header('Cache-Control', 'no-store').type('text/html').send(html);
    } catch {
      reply.type('text/html').send('<h1>Falta public/entrar.html</h1>');
    }
  });

  /**
   * Le pega a cada <script src="/x.js"> la fecha de modificación del archivo.
   *
   * ⚠ Esto no es una optimización: es la única forma de que un cambio en el
   * JavaScript llegue al navegador de alguien que ya tuvo la página abierta.
   *
   * `Cache-Control: no-cache` obliga a revalidar, pero como no mandábamos ni
   * ETag ni Last-Modified no había contra qué revalidar, y Safari se quedaba
   * con la copia vieja. El síntoma es el peor de todos para trabajar: el
   * servidor tiene el arreglo, el archivo en disco tiene el arreglo, y la
   * pantalla sigue haciendo lo de antes. Se perdieron dos vueltas de esta
   * sesión buscando en el código un botón que sí estaba.
   *
   * La URL cambia sólo cuando cambia el archivo, así que el caché sigue
   * sirviendo para lo que sirve.
   */
  function sellarEstaticos(html: string): string {
    return html.replace(/(<script src="\/)([a-z0-9_.-]+\.js)(")/g, (_m, a, archivo, c) => {
      try {
        const st = statSync(new URL('../public/' + archivo, import.meta.url));
        return a + archivo + '?v=' + Math.floor(st.mtimeMs) + c;
      } catch {
        return a + archivo + c;
      }
    });
  }

  // JavaScript de las páginas públicas. Se sirve como archivo suelto, igual que
  // el HTML: para dos archivos no vale la pena montar un servidor de estáticos.
  for (const js of ['sitio.js', 'entrar.js', 'consola.js', 'operador.js', 'firmar.js', 'marcas.js', 'rubrica.js', 'visor.js', 'campos.js', 'cajas.js', 'instalar.js', 'avisos.js', 'acceso.js']) {
    app.get('/' + js, async (_req, reply) => {
      try {
        const ruta = new URL('../public/' + js, import.meta.url);
        const body = readFileSync(ruta, 'utf8');
        // ETag además del no-cache: le da al navegador contra qué revalidar.
        reply
          .type('text/javascript')
          .header('Cache-Control', 'no-cache')
          .header('ETag', '"' + Math.floor(statSync(ruta).mtimeMs).toString(36) + '"')
          .send(body);
      } catch {
        reply.code(404).send('archivo no encontrado');
      }
    });
  }

  // pdf.js, servido desde nuestro dominio.
  //
  // ⚠ No es una comodidad: el CSP es `script-src 'self'` y `worker-src 'self'`,
  // a propósito. Traerlo de un CDN significaría abrirle la mano al CSP de una
  // aplicación que muestra documentos ajenos antes de firmarlos. Se copia con
  // `npm i pdfjs-dist` y queda versionado con el repo.
  //
  // El `.mjs` va con tipo JavaScript o el navegador rechaza el `import()`.
  for (const mj of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
    app.get('/vendor/' + mj, async (_req, reply) => {
      try {
        const body = readFileSync(new URL('../public/vendor/' + mj, import.meta.url), 'utf8');
        reply
          .type('text/javascript')
          .header('Cache-Control', 'public, max-age=604800, immutable')
          .send(body);
      } catch {
        reply.code(404).send('falta pdfjs: correr npm i pdfjs-dist y copiar a public/vendor');
      }
    });
  }

  // PWA: manifest, service worker e íconos. Públicos (sin token), servidos como
  // archivos sueltos igual que las páginas HTML.
  app.get('/manifest.webmanifest', async (_req, reply) => {
    try {
      const body = readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8');
      reply.type('application/manifest+json').send(body);
    } catch {
      reply.code(404).send('manifest no encontrado');
    }
  });
  app.get('/sw.js', async (_req, reply) => {
    try {
      const body = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
      reply.type('text/javascript').header('Service-Worker-Allowed', '/').header('Cache-Control', 'no-store').send(body);
    } catch {
      reply.code(404).send('sw no encontrado');
    }
  });
  for (const ic of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png']) {
    app.get('/' + ic, async (_req, reply) => {
      try {
        const buf = readFileSync(new URL('../public/' + ic, import.meta.url));
        reply.type('image/png').send(buf);
      } catch {
        reply.code(404).send('icono no encontrado');
      }
    });
  }
  for (const sv of ['favicon.svg', 'logo.svg', 'logo-blanco.svg']) {
    app.get('/' + sv, async (_req, reply) => {
      try {
        const body = readFileSync(new URL('../public/' + sv, import.meta.url), 'utf8');
        reply.type('image/svg+xml').send(body);
      } catch {
        reply.code(404).send('svg no encontrado');
      }
    });
  }
  // Rutas públicas (sin token): la página, health y el login de desarrollo.
  const PUBLICAS = new Set([
    // Páginas y estáticos
    '/',
    '/app',
    '/entrar',
    '/health',
    // ⚠ Los tres del buscador y las redes. Van acá **además** de tener ruta.
    //
    // Tener la ruta no alcanza: el hook central exige sesión para todo lo que
    // no esté en esta lista, así que sin agregarlos daban **401**, no 404 — y
    // un 401 en `robots.txt` es peor que un 404, porque el buscador lo lee como
    // «acá hay algo y no me dejan verlo».
    //
    // Es la segunda vez en la misma madrugada que un camino nuevo se olvida de
    // una lista que ya existía: la primera fue el token CSRF de la subida por
    // multipart. Misma forma, mismo remedio — ver el §2 de `lecciones-9-agosto`.
    '/robots.txt',
    '/sitemap.xml',
    '/og.png',
    '/sitio.js',
    '/entrar.js',
    '/consola.js',
    '/operador.js',
    '/firmar.js',
    '/marcas.js',
    '/campos.js',
    '/rubrica.js',
    '/visor.js',
    '/cajas.js',
    '/instalar.js',
    // ⚠ El ARCHIVO es público (es JavaScript de la página); las RUTAS de avisos
    // (/push/*) no: ésas piden sesión y por eso no están en esta lista.
    '/avisos.js',
    // El ARCHIVO es público (es JavaScript de la página); las rutas `/mi/*` que
    // usa piden sesión y por eso no están acá.
    '/acceso.js',
    '/vendor/pdf.min.mjs',
    '/vendor/pdf.worker.min.mjs',
    // El firmante externo: su autorización es el otorgamiento que lleva el
    // token, no una sesión de cuenta. El hook central no puede autenticarlo
    // porque no pertenece a ninguna.
    '/firmar',
    '/firmar/abrir',
    '/firmar/documento',
    '/firmar/firmar',
    '/firmar/rechazar',
    '/firmar/marca',
    // La autorización la lleva la cookie de firma, igual que las de arriba.
    '/firmar/campos',
    '/firmar/campos/guardar',
    '/firmar/cuenta',
    '/firmar/cuenta/crear',
    // La rúbrica del firmante sin cuenta: la carga él, en el acto de firmar.
    // Sin parámetros en el camino — PUBLICAS compara la ruta exacta.
    '/firmar/rubrica',
    '/firmar/rubrica/cargar',
    '/firmar/rubrica/imagen',
    '/firmar/rubrica/quitar',
    '/firmar/caracter',
    '/firmar/caracter/declarar',
    '/firmar/marcas',
    '/firmar/marca/agregar',
    '/firmar/marca/todas',
    '/firmar/marca/limpiar',
    '/firmar/marca/quitar',
    '/manifest.webmanifest',
    '/sw.js',
    '/favicon.svg',
    '/logo.svg',
    '/logo-blanco.svg',
    '/icon-192.png',
    '/icon-512.png',
    '/icon-maskable-512.png',
    '/apple-touch-icon.png',
    // Autenticación: todo lo que ocurre ANTES de tener sesión
    '/auth/login',
    '/auth/login/elegir-cuenta',
    '/auth/otp',
    '/auth/otp/elegir',
    '/auth/otp/reenviar',
    '/auth/reset/solicitar',
    '/auth/reset/confirmar',
    '/auth/registro',
    // Los dos pasos siguientes del alta: el token del correo ES la
    // credencial. Ver `services/auth_registro.ts`.
    '/auth/registro/ver',
    '/auth/registro/confirmar',
    '/auth/logout',
    // Datos que consume la página comercial sin token
    '/publico/planes',
    '/publico/industrias',
    '/publico/salud',
    '/publico/paises',
    // La clave pública del cartelito de «no soy un robot». Sin esta línea da 401
    // y la pantalla no lo dibuja nunca.
    '/publico/captcha',
    '/ayudas',
    '/i18n',
  ]);

  // Rutas públicas (sin token) de cada realm con auth propia: la página y los endpoints
  // pre-login (login/registro/reset). TODO lo demás bajo ese prefijo exige el token del
  // realm en el hook central (defensa en profundidad: si una ruta nueva se olvidara de
  // validar, igual queda protegida acá). Los handlers siguen resolviendo su sesión tipada.
  const PUBLICAS_OPERADOR = new Set(['/operador', '/operador/login', '/operador/logout']);
  const PUBLICAS_ESTUDIO = new Set([
    '/estudio',
    '/estudio/registro',
    '/estudio/registro/verificar',
    '/estudio/registro/reenviar',
    '/estudio/login',
    '/estudio/login/elegir',
    '/estudio/reset/solicitar',
    '/estudio/reset/confirmar',
    '/estudio/logout',
  ]);
  const PUBLICAS_OFERENTE = new Set([
    '/oferente',
    '/oferente/registro',
    '/oferente/registro/verificar',
    '/oferente/registro/reenviar',
    '/oferente/login',
    '/oferente/login/elegir',
    '/oferente/reset/solicitar',
    '/oferente/reset/confirmar',
    '/oferente/logout',
  ]);

  // Marca por request: true si la identidad terminó resolviéndose por cookie (lo pone el
  // puente de abajo). El hook de CSRF solo actúa cuando es true.
  app.decorateRequest('authViaCookie', false);

  // Autenticación: resuelve la identidad (empresa + usuario) y la adjunta al
  // request. A partir de acá todo handler usa withUsuario(...) / withTenant(...).
  app.addHook('preHandler', async (req) => {
    let path = req.url.split('?')[0];
    // Normalizamos la barra final: '/mi/' se trata igual que '/mi'. Algunos
    // navegadores/PWA (sobre todo iOS) agregan la barra, y sin esto la página
    // caía en el chequeo de token y devolvía "Falta el token Bearer".
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    // Puente cookie→header (Fase A): si el cliente NO manda Authorization pero sí trae
    // la cookie de sesión del realm, la exponemos como Bearer para que los verificadores
    // y los handlers (que leen req.headers.authorization) acepten la cookie sin cambios.
    // Header-first: si vino el header, se respeta tal cual (compatibilidad total).
    if (!req.headers.authorization) {
      const tok = tokenDeCookie(req, realmDePath(path));
      if (tok) {
        req.headers.authorization = `Bearer ${tok}`;
        req.authViaCookie = true; // identidad por cookie => el hook de CSRF aplica en mutaciones
      }
    }
    // La consola de operador tiene su propia autenticación (token), no la de cliente.
    if (path === '/operador' || path.startsWith('/operador/')) {
      if (!PUBLICAS_OPERADOR.has(path)) {
        await verificarTokenOperador(req.headers.authorization);
        if (!req.authViaCookie) avisarAuthPorHeader(req, 'operador', path);
      }
      return;
    }
    // Webhooks de pasarelas de pago: público (sin sesión), validado por la FIRMA del proveedor.
    if (path.startsWith('/pagos/webhook/')) return;
    if (PUBLICAS.has(path)) return;
    req.identidad = await autenticar(req.headers.authorization);
    // Los anclajes probados y el nivel de garantía viajan firmados en el token
    // y la BASE los necesita. Acá es donde entran al contexto; de ahí los toma
    // `withUsuario` sin que nadie tenga que acordarse de pasarlos.
    fijarSesionDelPedido(req.identidad);
    if (!req.authViaCookie) avisarAuthPorHeader(req, 'empresa', path);
  });

  // CSRF (Fase B): en métodos que mutan, si la identidad se resolvió por COOKIE, exigir
  // double-submit (header X-CSRF-Token == cookie csrf_<realm>) + Origin/Referer del propio
  // dominio. Si vino por Authorization (frontend no migrado o API de integración) no se
  // chequea nada: un atacante cross-site no puede setear ese header. Exentas: rutas públicas
  // (login/registro/reset/logout) y /integracion/* (usa api_token, no la sesión).
  app.addHook('preHandler', async (req) => {
    const m = req.method;
    if (m !== 'POST' && m !== 'PUT' && m !== 'DELETE') return;
    if (!req.authViaCookie) return;
    let path = req.url.split('?')[0];
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    if (path.startsWith('/integracion/')) return;
    if (PUBLICAS.has(path) || PUBLICAS_OPERADOR.has(path) || PUBLICAS_ESTUDIO.has(path) || PUBLICAS_OFERENTE.has(path)) return;
    // Double-submit: el header X-CSRF-Token debe coincidir con la cookie csrf del realm.
    const cookieTok = tokenCsrfDeCookie(req, realmDePath(path));
    const h = req.headers['x-csrf-token'];
    const headerTok = Array.isArray(h) ? h[0] : h;
    if (!cookieTok || !headerTok || cookieTok !== headerTok) {
      throw new HttpError(403, 'Falta o no coincide el token CSRF. Recargá la página e intentá de nuevo.');
    }
    // Origin/Referer del propio dominio (defensa en profundidad sobre SameSite=Lax).
    const host = req.headers.host;
    const fuente = req.headers.origin || req.headers.referer;
    let origenOk = false;
    if (host && fuente) {
      try {
        origenOk = new URL(fuente).host === host;
      } catch {
        origenOk = false;
      }
    }
    if (!origenOk) throw new HttpError(403, 'Origen no permitido para esta operación.');
  });

  // Set-cookie de sesión (Fase A): cuando un endpoint de login de la allowlist devuelve
  // { token }, además de mandarlo en el JSON (compat con los frontends actuales) lo
  // guardamos en la cookie httpOnly del realm. Se usa allowlist explícita —no "cualquier
  // payload con token"— para no confundir un api_token o el token de "abrir empresa como
  // contador" (que es de empresa, servido desde /estudio/*) con la sesión del path.
  app.addHook('preSerialization', async (req, reply, payload) => {
    let path = req.url.split('?')[0];
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    const realm = LOGIN_PATHS.get(path);
    if (realm) {
      const p = payload as { token?: unknown } | null;
      if (p && typeof p === 'object' && typeof p.token === 'string' && p.token) {
        setCookieSesion(req, reply, realm, p.token);
        setCookieCsrf(req, reply, realm); // cookie CSRF (no httpOnly) para el double-submit (Fase B)
      }
    }
    return payload;
  });

  // ⚠⚠ ADENTRO DE `app.after`, Y NO SUELTAS. Ver la nota larga en el `register` del
  // rate-limit: `app.register` encola el plugin, no lo carga; una ruta declarada antes de
  // que cargue queda SIN tope, sin que nada lo avise. `app.after` es exactamente «cuando
  // los plugins encolados ya cargaron». Comprobado el 11/8/2026: con las rutas sueltas
  // pasan 25 de 25 pedidos contra un tope de 20/minuto; adentro del `after`, 20 y 5 frenados.
  app.after(() => {
    registrarRutasAuth(app);
    registrarRutasChat(app);
    registrarRutasUsuarios(app);
    registrarRutasRoles(app);
    registrarRutasCarpetas(app);
    // Los avisos en el teléfono. Piden sesión: NO van a PUBLICAS.
    registrarRutasAvisos(app);
    // Tu acceso: contraseña, teléfono y canal del código. Self-scoped, con
    // sesión — tampoco van a PUBLICAS.
    registrarRutasPerfil(app);
    registrarRutasOperador(app);
    registrarRutasPublico(app);
    registrarRutasPagosWebhook(app);
    registrarRutasAyuda(app);
    registrarRutasDocumentos(app);
    registrarRutasRepositorio(app);
    registrarRutasCircuitos(app);
    registrarRutasFirma(app);
  });

  /**
   * ¿Este error es "no llegué a la base", o es un error de verdad?
   *
   * Se mira el código de red del socket y el SQLSTATE de la clase 08, que es la
   * de fallas de conexión. `pg` puede envolverlo en un `AggregateError` cuando
   * el host resuelve a varias direcciones, así que también se miran las causas.
   *
   * ⚠ Se comprueba por CÓDIGO y no por texto del mensaje: los textos cambian
   * entre versiones de la librería y del sistema operativo, y un `includes` que
   * deja de coincidir vuelve a tapar el error sin que nada lo diga.
   */
  const CODIGOS_RED = new Set([
    'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH',
    'ECONNRESET', 'EPIPE', 'EAI_AGAIN',
  ]);
  function esFallaDeConexion(e: unknown, hondura = 0): boolean {
    if (!e || typeof e !== 'object' || hondura > 4) return false;
    const c = (e as { code?: unknown }).code;
    if (typeof c === 'string') {
      // Clase 08 del SQLSTATE: connection exception. 57P01: el servidor cortó.
      if (CODIGOS_RED.has(c) || c.startsWith('08') || c === '57P01') return true;
    }
    const errores = (e as { errors?: unknown[] }).errors;
    if (Array.isArray(errores) && errores.some((x) => esFallaDeConexion(x, hondura + 1))) return true;
    return esFallaDeConexion((e as { cause?: unknown }).cause, hondura + 1);
  }

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      reply.code(400).send({ error: 'Datos inválidos', detalles: err.issues });
      return;
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    // Un HttpError lo escribimos nosotros: su texto es apto para el usuario
    // aunque el codigo sea 5xx. Los 502/503 de operacion --"no hay conexion de
    // correo activa"-- son justamente los que hay que poder leer en pantalla;
    // taparlos con "ocurrio un error en el servidor" manda a revisar el log del
    // servidor para entender algo que se resolvia solo.
    if (err instanceof HttpError) {
      if (status >= 500) app.log.error(err);
      reply.code(status).send({ error: err.message });
      return;
    }
    // ── Quedarse sin base NO es "un error en el servidor"
    //
    // Es la lección 5 del 1 de agosto: dos errores distintos no pueden tener el
    // mismo mensaje. En desarrollo esto pasa cada vez que se cae el túnel, y en
    // producción sería una caída de la base o de la red — dos situaciones
    // distintas de un bug nuestro, con dos respuestas distintas: en un bug no
    // sirve reintentar, acá sí.
    //
    // Costó dos diagnósticos a ciegas el 2 de agosto: pantalla de login con
    // "ocurrió un error en el servidor" mientras se revisaba el código de login,
    // que estaba perfecto.
    //
    // No filtra nada: que la base no esté disponible no le dice a un atacante
    // nada que no vea igual por el 503.
    if (esFallaDeConexion(err)) {
      app.log.error({ err }, 'SIN CONEXIÓN A LA BASE — ¿se cayó el túnel? source db/tunel.sh');
      reply.code(503).send({
        error:
          'El servidor no está pudiendo hablar con la base de datos. No es tu ' +
          'usuario ni tu contraseña: probá de nuevo en unos minutos.',
      });
      return;
    }

    if (status >= 500) {
      // No filtrar detalles internos (mensajes de la base, config, stack) al cliente:
      // se loguea del lado servidor y se responde con un mensaje genérico.
      app.log.error(err);
      reply.code(status).send({ error: 'Ocurrió un error en el servidor. Probá de nuevo en un momento.' });
      return;
    }
    // 4xx (incluye los HttpError intencionales): el mensaje es apto para el usuario.
    reply.code(status).send({ error: err instanceof Error ? err.message : 'Error' });
  });

  return app;
}
