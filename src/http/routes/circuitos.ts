import type { FastifyInstance } from 'fastify';
import { verMarcas, definirMarcas } from '../../services/marcas';
import { z } from 'zod';
import {
  verCircuito,
  agregarFirmante,
  agregarDestinatarios,
  agregarDestinatariosConDatos,
  quitarFirmante,
  reordenarFirmantes,
  configurarCircuito,
  despachar,
  cancelar,
  reenviarAvisos,
  enlaceDeFirma,
  asegurarQuePuedePreparar,
} from '../../services/circuito';
import {
  listarCampos, definirCampos, detectarCampos, guardarValorDelEmisor, mapearColumnasACampos,
} from '../../services/campos';
import { leerPlanilla, esPlanillaExcel } from '../../services/planilla_de_correos';
import { HttpError } from '../errors';

/**
 * Preparación y despacho de un circuito de firma.
 *
 * Todo lo de acá vale sólo en borrador, menos la lectura. Después del despacho
 * el circuito está congelado por un trigger de la base: la ruta corta antes
 * para dar un mensaje entendible, pero aunque no lo hiciera, la base no lo
 * dejaría pasar.
 */
export function registrarRutasCircuitos(app: FastifyInstance) {
  app.get('/circuitos/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { cuentaId, identidadId } = req.identidad;
    return verCircuito(cuentaId, identidadId, id);
  });

  app.patch('/circuitos/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z
      .object({
        titulo: z.string().min(1).max(200).optional(),
        modo: z.enum(['serie', 'paralelo', 'copias']).optional(),
        nivel_firma: z.enum(['simple', 'avanzada']).optional(),
        dias_vigencia: z.coerce.number().int().min(1).max(365).nullable().optional(),
        politica_rechazo: z.enum(['bloqueante', 'continua']).optional(),
      })
      .parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return configurarCircuito(cuentaId, identidadId, id, {
      titulo: b.titulo,
      modo: b.modo,
      nivelFirma: b.nivel_firma,
      diasVigencia: b.dias_vigencia,
      politicaRechazo: b.politica_rechazo,
    });
  });

  app.post('/circuitos/:id/firmantes', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z
      .object({
        email: z.string().email(),
        nombre: z.string().max(120).optional(),
        papel: z.enum(['firmante', 'veedor', 'copia']).optional(),
        orden: z.coerce.number().int().min(1).max(99).optional(),
        nivel_garantia_minimo: z.enum(['bajo', 'sustancial', 'alto']).optional(),
      })
      .parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return agregarFirmante(cuentaId, identidadId, id, {
      email: b.email,
      nombre: b.nombre ?? null,
      papel: b.papel,
      orden: b.orden,
      nivelGarantiaMinimo: b.nivel_garantia_minimo,
    });
  });

  /**
   * La lista entera de destinatarios, pegada de una planilla.
   *
   * Sólo en modo copias, y es lo que responde a «¿tengo que hacer el proceso
   * diez veces?». Los campos del documento se definen UNA vez sobre el circuito
   * y valen para las diez copias; lo único que se repite es a quién va cada una.
   *
   * ⚠ El texto llega crudo a propósito. Partirlo por comas, punto y coma o
   * saltos de línea lo hace el servicio, porque lo que el emisor tiene en la
   * mano es una columna de Excel o una lista de un correo, y pedirle que la
   * formatee es pedirle el trabajo que tiene que hacer el programa.
   */
  app.post('/circuitos/:id/destinatarios', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    // Dos formas de entrada, una a la vez: la LISTA pegada de siempre, o las
    // FILAS con datos por persona que armó la vista previa de la planilla. Las
    // filas van estructuradas —correo, nombre, valores por código— porque a
    // esa altura ya no hay nada que partir: lo que se ve en la tabla es lo que
    // entra, textual.
    const b = z.union([
      z.object({ lista: z.string().min(1).max(20000) }),
      z.object({
        filas: z.array(z.object({
          correo: z.string().min(3).max(320),
          nombre: z.string().max(120).nullable().optional(),
          valores: z.record(z.string(), z.string().max(2000)).default({}),
          fila: z.coerce.number().int().min(1).optional(),
        })).min(1).max(50),
      }),
    ]).parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    if ('lista' in b) return agregarDestinatarios(cuentaId, identidadId, id, b.lista);
    return agregarDestinatariosConDatos(cuentaId, identidadId, id, b.filas);
  });

  /**
   * La misma lista, pero adentro de un archivo.
   *
   * ⚠ **Esta ruta NO agrega a nadie.** Lee el archivo y devuelve TEXTO, que la
   * pantalla pone en el cuadro para que el emisor lo mire; agregar sigue siendo
   * el POST de arriba, con las mismas validaciones. La explicación larga de por
   * qué está en `services/planilla_de_correos.ts`, y el resumen es que una
   * planilla trae encabezados, filas vacías y un «Total» al final, y enterarse
   * de eso cuando ya son cuarenta destinatarios de un documento despachado es
   * tarde: los destinatarios de un circuito despachado no se sacan.
   *
   * Va con `:id` y exige poder preparar el circuito, aunque no toque la base.
   * Una ruta abierta que descomprime un zip que sube cualquiera es una bomba de
   * descompresión esperando; ésta pide, además, que el circuito sea tuyo y esté
   * en borrador.
   */
  app.post('/circuitos/:id/destinatarios/archivo', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { cuentaId, identidadId } = req.identidad;

    // Que el circuito sea suyo y esté en borrador se comprueba con la misma
    // función que usa agregar, y ANTES de leer un solo byte del archivo.
    const prep = await asegurarQuePuedePreparar(cuentaId, identidadId, id);

    const parte = await (req as any).file();
    if (!parte) throw new HttpError(400, 'No llegó ningún archivo.');

    const nombre = String(parte.filename || '');
    if (!/\.(xlsx|xlsm|xltx|csv|tsv|txt)$/i.test(nombre)) {
      throw new HttpError(
        400,
        'El archivo tiene que ser una planilla de Excel (.xlsx) o un texto ' +
          'separado por comas (.csv). Desde Excel: Archivo → Guardar como → CSV.',
      );
    }

    // ⚠ Tope propio, mucho más chico que los 30 MB de los PDF. Una lista de
    // correos no pesa un mega ni con dos mil filas, y un .xlsx es un zip: sin un
    // tope acá, cinco megas comprimidos se vuelven gigas al abrirlos.
    const datos: Buffer = await parte.toBuffer();
    if (datos.length > 2 * 1024 * 1024) {
      throw new HttpError(400, 'El archivo es demasiado grande. Una lista de correos no llega a 2 MB.');
    }

    let leida;
    try {
      leida = await leerPlanilla(datos, nombre);
    } catch (e: any) {
      // El error de una biblioteca de planillas no le dice nada a nadie
      // («readFiles(...).then is not a function» fue uno real). Se traduce.
      throw new HttpError(
        400,
        esPlanillaExcel(nombre)
          ? 'No pude leer esa planilla. Probá volver a guardarla desde Excel como .xlsx, o como CSV.'
          : 'No pude leer ese archivo como texto separado por comas.',
      );
    }

    // ═══ ¿Y ADEMÁS TRAE DATOS POR PERSONA? ═══
    //
    // Si la planilla tiene forma de tabla, el circuito es de copias y algún
    // título coincide con un campo del emisor, la respuesta suma `datos`: las
    // columnas mapeadas, las que no (con su porqué), y una fila por persona con
    // sus valores POR CÓDIGO de campo. La pantalla muestra eso como vista
    // previa; agregar sigue siendo el POST de siempre, ahora con `filas`.
    //
    // La tabla cruda no viaja: afuera de este cruce no significa nada, y todo
    // lo que la pantalla necesita ya va masticado en `datos`.
    const { tabla, ...resto } = leida;
    if (!tabla || prep.modo !== 'copias') return resto;

    const { campos } = await listarCampos(cuentaId, identidadId, id);
    const mapa = mapearColumnasACampos(tabla.titulos, campos);
    if (!mapa.columnas.length) return resto;

    const porTitulo = new Map(mapa.columnas.map((c) => [c.titulo, c.codigo]));
    return {
      ...resto,
      datos: {
        columnas: mapa.columnas,
        ignoradas: mapa.ignoradas,
        filas: tabla.filas.map((f) => ({
          fila: f.fila,
          correo: f.correo,
          nombre: f.nombre,
          valores: Object.fromEntries(
            Object.entries(f.datos)
              .filter(([titulo]) => porTitulo.has(titulo))
              .map(([titulo, valor]) => [porTitulo.get(titulo)!, valor]),
          ),
        })),
      },
    };
  });

  /**
   * El orden de firma, entero y de una vez.
   *
   * Recibe la lista completa y no «subí éste»: la posición depende de qué había
   * cuando la pantalla se dibujó, y entre eso y el clic pudo entrar otro
   * firmante. Si lo que llega no coincide con lo que hay, se rechaza entero.
   */
  app.put('/circuitos/:id/orden', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z
      .object({ participaciones: z.array(z.string().uuid()).min(1).max(200) })
      .parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return reordenarFirmantes(cuentaId, identidadId, id, b.participaciones);
  });

  app.delete('/circuitos/:id/firmantes/:pid', async (req) => {
    const p = z.object({ id: z.string().uuid(), pid: z.string().uuid() }).parse(req.params);
    const { cuentaId, identidadId } = req.identidad;
    return quitarFirmante(cuentaId, identidadId, p.id, p.pid);
  });

  // El acto. A partir de acá el circuito está congelado y hay gente afuera con
  // un enlace en la mano.
  // ---- Campos del documento ----
  //
  // Se manda el juego COMPLETO, no altas y bajas: la pantalla envía lo que
  // quedó después de arrastrar. Reconciliar fila por fila desde el navegador es
  // la clase de sincronización que se desincroniza.
  app.get('/circuitos/:id/campos', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { cuentaId, identidadId } = req.identidad;
    return listarCampos(cuentaId, identidadId, id);
  });

  /**
   * Los campos que el PDF YA TRAE, leídos de su AcroForm.
   *
   * Sólo lee y propone: adoptarlos es un PUT aparte. Un formulario con cuarenta
   * campos internos no se convierte en cuarenta obligaciones para el firmante
   * sin que alguien lo mire.
   */
  app.get('/circuitos/:id/campos/detectar', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { cuentaId, identidadId } = req.identidad;
    return detectarCampos(cuentaId, identidadId, id);
  });

  app.put('/circuitos/:id/campos', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({
      campos: z.array(z.object({
        codigo: z.string().min(1).max(60),
        etiqueta: z.string().min(1).max(120),
        tipo: z.enum(['texto','parrafo','numero','fecha','moneda','casilla','opcion','etiqueta']),
        opciones: z.array(z.string().max(120)).max(50).optional().nullable(),
        completa_emisor: z.boolean().optional(),
        quien_completa: z.enum(['emisor','firmante','cualquiera']).optional(),
        // El LUGAR del firmante (participacion.posicion), no su turno. Migración 055.
        posicion_firmante: z.number().int().min(1).max(99).optional().nullable(),
        // Cómo se ve el valor. Los mismos topes que la restricción de la base:
        // si la pantalla dejara mandar algo que la base rechaza, el error sale
        // como un 500 de Postgres en vez de una frase que se entienda. 056.
        cuerpo: z.number().min(4).max(72).optional().nullable(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().nullable(),
        obligatorio: z.boolean().optional(),
        pagina: z.number().int().min(0).max(2000),
        x: z.number(), y: z.number(),
        ancho: z.number().positive(), alto: z.number().positive(),
        orden: z.number().int().optional(),
        // Los demás lugares donde el formulario repite el dato (espejos, 059).
        // El tope es el mismo que el check de la base: si divergieran, la
        // pantalla ofrecería algo que la base rechaza con un 500 de Postgres en
        // vez de una frase que se entienda.
        espejos: z.array(z.object({
          pagina: z.number().int().min(0).max(2000),
          x: z.number(), y: z.number(),
          ancho: z.number().positive(), alto: z.number().positive(),
        })).max(30).optional().nullable(),
      })).max(200),
    }).parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return definirCampos(cuentaId, identidadId, id, b.campos as any);
  });

  /**
   * Lo que el emisor escribe en SUS campos, antes de mandar.
   *
   * ⚠ De a uno, como el firmante: el error de un campo no se lleva puestos los
   * otros cuatro que estaban bien, y si el navegador se cierra a mitad de un
   * formulario largo no se perdió nada.
   *
   * Quién puede y hasta cuándo lo decide `app.puede_completar_campo` en la base,
   * no esta ruta.
   */
  app.post('/circuitos/:id/campos/valor', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({
      campo_id: z.string().uuid(),
      valor: z.string().max(2000).nullable(),
    }).parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return guardarValorDelEmisor(cuentaId, identidadId, id, b.campo_id, b.valor);
  });

  // Cancelar un documento en curso. Motivo obligatorio: va al expediente y es
  // lo que el firmante va a leer en el aviso.
  app.post('/circuitos/:id/cancelar', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ motivo: z.string().min(1).max(500) }).parse(req.body);
    const { cuentaId, identidadId } = req.identidad;
    return cancelar(cuentaId, identidadId, id, b.motivo, {
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
  });

  app.post('/circuitos/:id/despachar', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { cuentaId, identidadId } = req.identidad;
    return despachar(cuentaId, identidadId, id, {
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
  });

  // El enlace personal de firma, para que el emisor lo entregue por su cuenta:
  // WhatsApp, en persona, o cuando el correo simplemente no llega. Queda
  // anotado en el expediente — ver el comentario del servicio.
  app.post('/circuitos/:id/firmantes/:pid/enlace', async (req) => {
    const p = z.object({ id: z.string().uuid(), pid: z.string().uuid() }).parse(req.params);
    const { cuentaId, identidadId } = req.identidad;
    return enlaceDeFirma(cuentaId, identidadId, p.id, p.pid, {
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
  });

  // Reenviar el aviso. No emite un otorgamiento nuevo: reusa el que ya existe,
  // así el enlace del correo original —si alguna vez llegó— sigue sirviendo.
  app.post('/circuitos/:id/reenviar', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { cuentaId, identidadId } = req.identidad;
    return reenviarAvisos(cuentaId, identidadId, id);
  });
  // ==========================================================================
  // Marcas: dónde se estampa la representación VISUAL de cada firmante.
  //
  // ⚠ No es la firma. Un documento sin marcas está firmado igual.
  // ==========================================================================

  app.get('/documentos/:id/marcas', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { cuentaId, identidadId } = req.identidad;
    return verMarcas(cuentaId, identidadId, id);
  });

  /**
   * Define las marcas de UN firmante. Reemplaza las que tuviera.
   *
   * PUT y no PATCH: el editor manda el estado completo de lo que el usuario ve.
   */
  app.put('/participaciones/:id/marcas', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z
      .object({
        marcas: z
          .array(
            z.object({
              tipo: z.enum(['firma', 'rubrica']),
              pagina: z.number().int().min(0).max(5000).optional(),
              x: z.number().min(0).max(20000),
              y: z.number().min(0).max(20000),
              ancho: z.number().min(8).max(2000),
              alto: z.number().min(8).max(2000),
              todas_las_paginas: z.boolean().optional(),
            }),
          )
          // El mismo tope que `definirMarcas`, y por la misma razón: un contrato
          // de 500 hojas rubricado entero son 500 marcas. Si acá fuera más bajo,
          // el caso que motivó la pantalla —el contrato largo— fallaría con un
          // error de validación en vez de con el mensaje que explica el límite.
          .max(1000),
      })
      .parse(req.body);

    const { cuentaId, identidadId } = req.identidad;
    return definirMarcas(
      cuentaId,
      identidadId,
      id,
      b.marcas.map((m) => ({ ...m, todasLasPaginas: m.todas_las_paginas })),
    );
  });

}
