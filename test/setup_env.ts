// Setea el secreto de firma ANTES de que se importen los módulos de auth. identity.ts
// (realm empresa) lee AUTH_DEV_SECRET en TIEMPO DE CARGA del módulo, así que este archivo
// debe ser el PRIMER import de cualquier test que construya el server o emita tokens de
// empresa. No termina en .test.ts, así que el runner no lo toma como suite.
process.env.AUTH_DEV_SECRET = process.env.AUTH_DEV_SECRET || 'csrf-test-secret';
