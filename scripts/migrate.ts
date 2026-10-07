/**
 * Apply supabase/migrations/*.sql to DATABASE_URL.
 * (Alternative: `supabase db push` with the Supabase CLI — same files.)
 */
import { fileURLToPath } from 'node:url';
import { createPgDb, runMigrations } from '@fp/database';
import { loadDotEnvFile } from '@fp/shared';

loadDotEnvFile();
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const db = createPgDb(url, { max: 1 });
const dir = fileURLToPath(new URL('../supabase/migrations', import.meta.url));
try {
  const applied = await runMigrations(db, dir, (m) => console.log(m));
  console.log(applied.length ? `applied ${applied.length} migration(s)` : 'database is up to date');
} finally {
  await db.close();
}
