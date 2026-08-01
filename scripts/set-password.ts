/**
 * Fija la contraseña de una identidad desde la línea de comandos.
 *
 *   npm run set-password -- --email ana@empresa.com --password "..."
 *
 * Es una herramienta de rescate: se usa cuando alguien quedó afuera y el correo
 * no funciona. El camino normal es el recupero por correo, que además deja
 * constancia de quién lo pidió.
 *
 * ⚠ Revoca los dispositivos de confianza de esa identidad, igual que el
 * recupero: si hubo que rescatar una cuenta, los equipos que ya no piden
 * segundo factor son justamente los que hay que cortar.
 */
import { sql } from 'kysely';
import { db, cerrarPool } from '../src/db/pool';
import { hashPassword, validarPassword } from '../src/auth/password';

function arg(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = arg('email');
  const password = arg('password');
  if (!email || !password) {
    console.error('Uso: npm run set-password -- --email ana@empresa.com --password "..."');
    process.exit(1);
  }
  const err = validarPassword(password);
  if (err) {
    console.error(err);
    process.exit(1);
  }

  await db.transaction().execute(async (trx) => {
    await sql`select
      set_config('app.actor','sistema',true),
      set_config('app.cuenta_id','',true),
      set_config('app.identidad_id','',true),
      set_config('app.anclajes_probados','',true),
      set_config('app.nivel_garantia','ninguno',true),
      set_config('app.idioma','es',true),
      set_config('app.otorgamiento_id','',true)
    `.execute(trx);

    const i = await trx
      .selectFrom('identidad')
      .select(['id', 'email_mostrado'])
      .where('email_normalizado', '=', email.trim().toLowerCase())
      .executeTakeFirst();
    if (!i) throw new Error(`No existe ninguna identidad con el correo ${email}.`);

    await trx
      .insertInto('credencial')
      .values({
        identidad_id: i.id,
        hash_password: hashPassword(password),
        password_cambiada_en: new Date(),
      })
      .onConflict((oc) =>
        oc.column('identidad_id').doUpdateSet({
          hash_password: hashPassword(password),
          password_cambiada_en: new Date(),
          intentos_fallidos: 0,
          bloqueada_hasta: null,
        }),
      )
      .execute();

    await trx.updateTable('identidad').set({ estado: 'activa' }).where('id', '=', i.id).execute();

    const rev = await trx
      .updateTable('dispositivo_confiable')
      .set({ revocado_en: new Date() })
      .where('identidad_id', '=', i.id)
      .where('revocado_en', 'is', null)
      .executeTakeFirst();

    console.log(`Contraseña fijada para ${i.email_mostrado}.`);
    console.log(`Dispositivos de confianza revocados: ${rev.numUpdatedRows}`);
  });
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => cerrarPool());
