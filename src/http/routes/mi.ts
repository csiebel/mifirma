import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

// Endpoints "self-service" para la app del empleado. Resuelven la propia
// relación laboral a partir de la identidad del usuario logueado, de modo que
// el empleado no necesita conocer su relacion_id. RLS (empresa + alcance) sigue
// aplicando en todas las consultas: nadie ve más de lo suyo.
export function registrarRutasMi(app: FastifyInstance) {
  // Datos del empleado logueado: persona, empresa y su relación principal.

  // Recibos del empleado, de todos sus períodos, más nuevo primero.

  // Saldo de licencia del año en curso + ausencias del empleado.

  // Novedades publicadas por RRHH, visibles para el empleado. limite opcional
  // (p. ej. ?limite=1 para mostrar la última en la pantalla de Inicio).

  // Certificaciones y estudios del empleado (los de su propia persona).





  // Evaluaciones de desempeño recibidas por el empleado (ciclo y resultado).

  // Capacitaciones del empleado (sus inscripciones, con el nombre del curso).

  // Solicitudes de licencia del empleado: pedir y ver las propias.

  // Conceptos de ausencia activos de la empresa (para el selector de "pedir licencia").


  // Notificaciones push: clave pública para suscribirse y alta/baja por dispositivo.



  // Ofertas / Beneficios: vidriera del empleado y su consentimiento por oferente.


  // Medición de publicidad: el empleado registra impresión/click de una oferta (telemetría
  // best-effort, deduplicada y validada en la capa de datos).


  // Foto de perfil del propio empleado (la carga RRHH/Admin; acá solo se lee).

  // Beneficios que ofrece la empresa (activos). La gestión es de RRHH; acá solo se leen.


  // Firma reutilizable del empleado (la dibuja una vez y se usa en sus documentos).

  // Medio de pago del propio empleado (read-only; lo configura la empresa).

  // Crédito (Fase 1): solicitud del empleado sobre una oferta financiera.

  // Etapa 2B: documentación que el empleado completa para una solicitud.
  const docArchivo = z.object({ base64: z.string().min(1), mime: z.string(), nombre: z.string().optional() });


  // Facturas del proveedor unipersonal logueado (su propia relación).
}
