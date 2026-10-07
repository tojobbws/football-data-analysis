import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'node:url';
import type { Db, Queryable } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));

/** In-memory Postgres (PGlite) wrapped in our Db interface + all migrations applied. */
export async function createTestDb(): Promise<Db & { pg: PGlite }> {
  const pg = new PGlite();
  // Supabase roles referenced by RLS policies
  await pg.exec(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    end $$;`);

  const wrap = (q: { query: PGlite['query'] }): Queryable => ({
    query: async <R>(text: string, params?: unknown[]) => {
      const res = await q.query<R>(text, params as unknown[]);
      return { rows: res.rows };
    },
  });

  const db: Db & { pg: PGlite } = {
    pg,
    ...wrap(pg),
    exec: async (sql) => {
      await pg.exec(sql);
    },
    transaction: (fn) => pg.transaction((tx) => fn(wrap(tx))),
    close: () => pg.close(),
  };
  await runMigrations(db, MIGRATIONS_DIR);
  return db;
}
