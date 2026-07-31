import { HttpError } from '../../http/errors';
import { credencialesDe } from '../pasarelas';
import { PayPalAdapter } from './paypal';
import type { FetchLike, PasarelaAdapter } from './tipos';

// Factory: devuelve el adaptador de una pasarela ACTIVA, ya cableado con sus credenciales
// descifradas (credencialesDe). Fase 1: solo PayPal. fetchImpl es inyectable para tests.
export async function adaptadorDe(proveedor: string, fetchImpl?: FetchLike): Promise<PasarelaAdapter> {
  const cred = await credencialesDe(proveedor);
  if (!cred) throw new HttpError(404, `Pasarela no configurada: ${proveedor}`);
  if (!cred.activo) throw new HttpError(400, `La pasarela "${proveedor}" no está activa. Cargá y activá las credenciales en la consola de operador.`);

  switch (proveedor) {
    case 'paypal':
      return new PayPalAdapter(
        { clientId: cred.clientId, clientSecret: cred.clientSecret, modo: cred.modo, webhookId: cred.webhookSecret },
        fetchImpl,
      );
    default:
      throw new HttpError(501, `Adaptador no disponible en Fase 1: "${proveedor}" (solo PayPal por ahora).`);
  }
}
