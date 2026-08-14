import { sql } from 'kysely';
import { db } from '../db/pool';
import { fijarContexto } from '../db/contexto';
import { enviarCorreo } from './correo';
import { notificarUsuario } from './push';
import { registrarSistema } from './auditoria';

/**
 * Avisarle algo a alguien, por el canal que corresponda.
 *
 * ═══ POR QUÉ EXISTE ESTO ═══
 *
 * Porque el correo es UN canal, no EL canal. Hoy la plataforma ya habla por
 * Twilio (SMS y WhatsApp) y ya tiene push web; mañana hay apps de iOS y Android.
 * Si cada aviso se escribe como HTML adentro del servicio que lo dispara —que es
 * lo que pasaba con los ocho que había— agregar un canal significa reescribir
 * ocho lugares, y agregar un idioma, veinticuatro.
 *
 * La migración 014 ya había previsto todo esto: `plantilla_mensaje` tiene
 * `(codigo, canal, idioma)` con los cuatro canales, y `bloque_mensaje` deja que
 * el cliente agregue su párrafo. Estaba diseñado y sin usar.
 *
 * ═══ QUÉ HACE Y QUÉ NO ═══
 *
 * Hace: resolver a quién, por dónde, con qué texto y en qué idioma; pegar el
 * bloque del cliente; sustituir variables; y despachar.
 *
 * **No** manda SMS ni WhatsApp todavía, y es a propósito: cuestan plata por
 * mensaje, y quién los paga y en qué planes es una decisión del operador que
 * todavía no está parametrizada. Lo que sí queda hecho es que **prenderlos sea
 * cambiar `canalesPara()` y cargar plantillas**, no reescribir los avisos.
 *
 * ⚠ El texto por omisión vive en el código y el catálogo lo pisa. Al revés
 * —catálogo obligatorio— un despliegue con la tabla vacía deja al sistema mudo,
 * y quedarse sin avisar que un documento se canceló es peor que avisar con un
 * texto genérico.
 */

export type Canal = 'email' | 'sms' | 'whatsapp' | 'push';

/** Los mismos códigos que declara `plantilla_mensaje` en la migración 014. */
export type CodigoMensaje =
  | 'invitacion_firma' | 'turno_disponible' | 'recordatorio'
  | 'vencimiento_proximo' | 'copia_informativa' | 'completado'
  | 'rechazado' | 'cancelado' | 'entrega_fallida'
  | 'codigo_verificacion' | 'lote_despachado';

export interface Destinatario {
  identidadId: string | null;
  email: string;
  nombre?: string | null;
  idioma?: string | null;
}

interface Texto { asunto: string | null; cuerpo: string }

/**
 * Lo que se manda mientras el catálogo esté vacío.
 *
 * Es texto plano con variables entre comillas angulares, igual que las
 * plantillas: así el día que alguien cargue una, no cambia nada más que el
 * origen del texto. El HTML del correo se arma alrededor, no acá — un texto que
 * sirve para un SMS no puede traer etiquetas.
 */
const POR_OMISION: Partial<Record<CodigoMensaje, Partial<Record<Canal, Texto>>>> = {
  cancelado: {
    email: {
      asunto: '«titulo» — el documento se canceló',
      cuerpo:
        'Hola «nombre»:\n\n' +
        '«emisor» canceló el documento «titulo», así que ya no hace falta que lo firmes.\n\n' +
        'Motivo: «motivo»\n\n' +
        'Si ya lo habías firmado, tu firma sigue valiendo y el documento queda en tu ' +
        'repositorio con el estado «cancelado».',
    },
    push: { asunto: null, cuerpo: '«emisor» canceló «titulo»' },
    sms: { asunto: null, cuerpo: '«emisor» canceló el documento «titulo». Ya no hace falta que lo firmes.' },
  },
};

/** Sustituye «variable» y avisa si quedó alguna sin resolver. */
function rellenar(txt: string, vars: Record<string, string>, donde: string): string {
  const salida = txt.replace(/«([a-z_]+)»/gi, (_m, k: string) => vars[k] ?? `«${k}»`);
  const faltan = salida.match(/«[a-z_]+»/gi);
  if (faltan) {
    // No se corta el envío por esto: un aviso con un hueco llega; uno que no se
    // manda, no. Pero queda en el log, porque un hueco en un mensaje legal se
    // tiene que poder encontrar sin que lo reporte un cliente.
    console.warn('[mensajes] variables sin resolver en', donde, '->', [...new Set(faltan)].join(' '));
  }
  return salida;
}

async function enSistema<T>(fn: (trx: any) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await fijarContexto(trx, { actor: 'sistema' });
    return fn(trx);
  });
}

/**
 * El texto a mandar: el del catálogo si hay, el de acá si no.
 *
 * Cascada de idioma: el pedido, después español, después lo que haya. Un aviso
 * en el idioma equivocado es molesto; ninguno es un problema.
 */
export async function armar(
  codigo: CodigoMensaje,
  canal: Canal,
  idioma: string,
  vars: Record<string, string>,
  ambito: { cuentaId?: string | null; circuitoId?: string | null } = {},
): Promise<Texto | null> {
  const fila = await enSistema(async (trx) => {
    const r = await sql<{ asunto: string | null; cuerpo: string; admite_bloque: boolean }>`
      select asunto, cuerpo, admite_bloque
        from plantilla_mensaje
       where codigo = ${codigo} and canal = ${canal} and activa
       order by (idioma = ${idioma}) desc, (idioma = 'es') desc
       limit 1
    `.execute(trx);
    return r.rows[0] ?? null;
  });

  const base = fila ?? (() => {
    const t = POR_OMISION[codigo]?.[canal];
    return t ? { ...t, admite_bloque: true } : null;
  })();
  if (!base) return null;

  let cuerpo = base.cuerpo;

  // El párrafo del cliente. El de circuito le gana al de cuenta: quien arma un
  // envío puede decir algo que no vale para todos los demás.
  if (base.admite_bloque && (ambito.cuentaId || ambito.circuitoId)) {
    const bloque = await enSistema(async (trx) => {
      const r = await sql<{ cuerpo: string }>`
        select cuerpo from bloque_mensaje
         where codigo = ${codigo}
           and (idioma = ${idioma} or idioma = 'es')
           and (circuito_id = ${ambito.circuitoId ?? null}::uuid
                or (circuito_id is null and cuenta_id = ${ambito.cuentaId ?? null}::uuid))
         order by (circuito_id is not null) desc, (idioma = ${idioma}) desc
         limit 1
      `.execute(trx);
      return r.rows[0]?.cuerpo ?? null;
    });
    if (bloque) cuerpo += '\n\n' + bloque;
  }

  return {
    asunto: base.asunto ? rellenar(base.asunto, vars, `${codigo}/${canal}/asunto`) : null,
    cuerpo: rellenar(cuerpo, vars, `${codigo}/${canal}`),
  };
}

/**
 * Por dónde se le avisa a esta persona.
 *
 * ⚠ **Acá es donde se prenden los canales nuevos, y en ningún otro lado.**
 *
 * Hoy: correo siempre —es el piso: todo firmante tiene correo, por definición,
 * porque por ahí le llegó el documento— y push además, si tiene la aplicación y
 * una cuenta. El push no reemplaza al correo: avisa, no entrega. El enlace y la
 * constancia viajan por correo.
 *
 * Falta, y no por olvido: **SMS y WhatsApp cuestan por mensaje**. Quién los
 * paga, en qué planes y con qué tope es configuración del operador que todavía
 * no existe. Prenderlos va a ser agregar el canal acá y cargar su plantilla —no
 * tocar ningún aviso.
 */
export async function canalesPara(
  d: Destinatario,
  ambito: { cuentaId?: string | null } = {},
): Promise<Canal[]> {
  const canales: Canal[] = ['email'];

  if (d.identidadId && ambito.cuentaId) {
    // ⚠ La suscripción es de la IDENTIDAD, no de la cuenta: `push_suscripcion`
    // no tiene ni tuvo nunca `cuenta_id` (migración 014). Y así corresponde: una
    // persona puede estar en varias empresas y el teléfono sigue siendo el
    // mismo — el push llega al dispositivo de alguien, no a una empresa. El
    // filtro por empresa lo hace el RLS (`push_select`), que es donde vive la
    // autorización.
    //
    // ⚠⚠ Del 3/8 al 14/8 esta consulta pidió `cuenta_id` y reventaba con
    // «column "cuenta_id" does not exist» (42703) cada vez que se avisaba a
    // alguien con identidad. Como el único que llama a `avisar()` es la
    // cancelación de circuito, once días de cancelaciones devolvieron 500
    // DESPUÉS de haber cancelado, y ningún firmante se enteró de que ya no
    // tenía que firmar. Nadie lo vio porque no había un solo test de esta
    // función. Ahora lo hay: `test/mensajes/canales.test.ts`.
    //
    // `revocada_en is null`: un dispositivo dado de baja no prende el canal.
    const hay = await enSistema(async (trx) => {
      const r = await sql<{ n: number }>`
        select count(*)::int as n from push_suscripcion
         where identidad_id = ${d.identidadId}::uuid and revocada_en is null
      `.execute(trx);
      return (r.rows[0]?.n ?? 0) > 0;
    });
    if (hay) canales.push('push');
  }

  return canales;
}

const escHtml = (s: string) =>
  s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));

/** El texto plano de la plantilla, envuelto en el HTML del correo. */
const aHtml = (cuerpo: string) =>
  cuerpo.split(/\n{2,}/).map((p) => `<p>${escHtml(p).replace(/\n/g, '<br>')}</p>`).join('\n');

/**
 * Manda el aviso por todos los canales que correspondan. **Nunca lanza.**
 *
 * Un aviso que falla no puede tumbar la operación que lo disparó: cancelar un
 * documento tiene que quedar cancelado aunque el SMTP esté caído. Lo que falla
 * queda en la bitácora de plataforma, que es donde el operador mira si el
 * correo viene fallando — el expediente del documento es otra cosa y lo escribe
 * quien llama.
 */
export async function avisar(
  codigo: CodigoMensaje,
  destinatarios: Destinatario[],
  vars: Record<string, string>,
  ambito: { cuentaId?: string | null; circuitoId?: string | null } = {},
): Promise<{ enviados: number; fallidos: number }> {
  let enviados = 0;
  let fallidos = 0;

  for (const d of destinatarios) {
    const idioma = d.idioma || 'es';
    const suyas = { ...vars, nombre: d.nombre || d.email.split('@')[0]! };

    // ⚠⚠ Elegir los canales NO puede tumbar el aviso. Esta función promete más
    // arriba que «nunca lanza», y hasta el 14/8 no cumplía: `canalesPara` estaba
    // fuera del try, y su consulta rota se llevó puesto el aviso de cancelación
    // ENTERO —correo incluido— durante once días. Si averiguar los canales
    // falla, se degrada al correo: el push acelera, el correo prueba.
    let canales: Canal[];
    try {
      canales = await canalesPara(d, ambito);
    } catch (e) {
      canales = ['email'];
      console.error('canalesPara falló; se avisa sólo por correo:', e);
      if (ambito.cuentaId) {
        await registrarSistema(ambito.cuentaId, d.identidadId ?? null, {
          accion: 'aviso.canales_degradados',
          recursoTipo: 'mensaje',
          despues: { codigo, motivo: e instanceof Error ? e.message : String(e) },
        }).catch(() => {});
      }
    }

    for (const canal of canales) {
      const t = await armar(codigo, canal, idioma, suyas, ambito);
      if (!t) continue;                    // sin plantilla para ese canal: se saltea
      try {
        if (canal === 'email') {
          await enviarCorreo({
            para: d.email,
            asunto: t.asunto ?? codigo,
            html: aHtml(t.cuerpo),
            texto: t.cuerpo,
          });
        } else if (canal === 'push' && d.identidadId && ambito.cuentaId) {
          await notificarUsuario(ambito.cuentaId, d.identidadId, {
            title: t.asunto ?? 'MiFirma',
            body: t.cuerpo,
          } as any);
        } else {
          continue;                        // sms/whatsapp: ver `canalesPara`
        }
        enviados++;
      } catch (e) {
        fallidos++;
        if (ambito.cuentaId) {
          await registrarSistema(ambito.cuentaId, d.identidadId ?? null, {
            accion: 'aviso.fallido',
            recursoTipo: 'mensaje',
            despues: {
              codigo, canal,
              // Enmascarado: la bitácora la lee gente que no es parte del documento.
              destino: d.email.slice(0, 2) + '***@' + (d.email.split('@')[1] ?? ''),
              error: e instanceof Error ? e.message : String(e),
            },
          }).catch(() => {});
        }
      }
    }
  }

  return { enviados, fallidos };
}
