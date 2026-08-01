// ⚠ PRIMERO Y ANTES QUE NADA: en ESM los import se evalúan antes del cuerpo
// del archivo, así que cualquier módulo que lea process.env al importarse
// —como db/pool.ts— ya corrió cuando esta línea se ejecuta. Ver src/entorno.ts.
import './entorno';
import { construirServidor } from './server';
import { cerrarPool } from './db/pool';
import { validarSecretos } from './auth/validar_secretos';

validarSecretos();

const app = construirServidor();
const port = Number(process.env.PORT ?? 3000);

app
  .listen({ port, host: '0.0.0.0' })
  .then((addr) => app.log.info(`API escuchando en ${addr}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void (async () => {
      await app.close();
      await cerrarPool();
      process.exit(0);
    })();
  });
}
