import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from './db.js';

/**
 * Minimal migration runner (same SQL files the Supabase CLI uses in supabase/migrations).
 * Tracks applied files in `fp_schema_migrations`. Each file runs once, in name order.
 */
export async function runMigrations(db: Db, dir: string, log: (m: string) => void = () => {}): Promise<string[]> {
  await db.query(`create table if not exists fp_schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
  const applied = new Set((await db.query<{ name: string }>('select name from fp_schema_migrations')).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const done: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = await readFile(join(dir, f), 'utf8');
    log(`applying ${f}`);
    await db.exec(`begin; ${sql}\n; insert into fp_schema_migrations (name) values ('${f.replace(/'/g, "''")}'); commit;`);
    done.push(f);
  }
  return done;
}
