/**
 * Popularity registry: everyone reads it, only admins/editors write it (RLS), and the checks hold.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers.js';

let db: Awaited<ReturnType<typeof createTestDb>>;
const ADMIN = '11111111-1111-1111-1111-111111111111';
const STRANGER = '33333333-3333-3333-3333-333333333333';

beforeAll(async () => {
  db = await createTestDb();
  await db.exec(`
    create schema if not exists auth;
    create or replace function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    insert into admin_users (user_id, email, role) values ('${ADMIN}', 'admin@x', 'ADMIN');
    insert into leagues (id, name) values (140, 'La Liga'), (296, 'Thai League 1');
    insert into teams (id, name, slug) values (541, 'Real Madrid', 'rm'), (529, 'Barcelona', 'fcb'), (2780, 'Buriram', 'bur');
    insert into team_popularity (team_id, popularity) values (541, 100);
  `);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

async function as<T>(role: 'anon' | 'authenticated', uid: string | null, fn: (q: (sql: string) => Promise<Array<Record<string, unknown>>>) => Promise<T>): Promise<T> {
  await db.exec(`begin; set local role ${role}; select set_config('test.uid', '${uid ?? ''}', true);`);
  try {
    return await fn(async (sql) => (await db.query<Record<string, unknown>>(sql)).rows);
  } finally {
    await db.exec('rollback;');
  }
}

describe('popularity registry', () => {
  it('is readable by anon and by logged-in non-admins', async () => {
    expect(await as('anon', null, (q) => q('select team_id from team_popularity'))).toHaveLength(1);
    expect(await as('authenticated', STRANGER, (q) => q('select team_id from team_popularity'))).toHaveLength(1);
  });

  it('is not writable by anon or by a logged-in non-admin', async () => {
    await expect(as('anon', null, (q) => q(`insert into team_popularity (team_id, popularity) values (529, 90)`))).rejects.toThrow();
    await expect(as('authenticated', STRANGER, (q) => q(`insert into league_importance (league_id, importance) values (140, 90)`))).rejects.toThrow();
    // an update by a stranger changes nothing (RLS filters the row out)
    const rows = await as('authenticated', STRANGER, async (q) => {
      await q(`update team_popularity set popularity = 1 where team_id = 541`);
      return q(`select popularity from team_popularity where team_id = 541`);
    });
    expect(Number(rows[0]!.popularity)).toBe(100);
  });

  it('an admin can add, change and remove rows', async () => {
    await as('authenticated', ADMIN, async (q) => {
      await q(`insert into team_popularity (team_id, popularity) values (529, 95)`);
      await q(`insert into league_importance (league_id, importance, is_thai) values (296, 70, true)`);
      await q(`insert into rivalries (team_a_id, team_b_id, name, weight) values (529, 541, 'El Clásico', 15)`);
      await q(`update team_popularity set popularity = 90 where team_id = 529`);
      expect((await q(`select popularity from team_popularity where team_id = 529`))[0]!.popularity).toBe(90);
      await q(`delete from team_popularity where team_id = 529`);
      expect(await q(`select 1 from team_popularity where team_id = 529`)).toHaveLength(0);
    });
  });

  it('keeps ranges and the rivalry pair order honest', async () => {
    await expect(as('authenticated', ADMIN, (q) => q(`insert into team_popularity (team_id, popularity) values (529, 101)`))).rejects.toThrow();
    await expect(as('authenticated', ADMIN, (q) => q(`insert into league_importance (league_id, importance) values (140, -1)`))).rejects.toThrow();
    await expect(as('authenticated', ADMIN, (q) => q(`insert into rivalries (team_a_id, team_b_id, name) values (541, 529, 'wrong order')`))).rejects.toThrow();
    await expect(as('authenticated', ADMIN, (q) => q(`insert into rivalries (team_a_id, team_b_id, name, weight) values (529, 541, 'too big', 16)`))).rejects.toThrow();
    await as('authenticated', ADMIN, (q) => q(`insert into rivalries (team_a_id, team_b_id, name, weight) values (529, 541, 'ok', 15)`));
  });

  it('a team can have an every-season row and a season row side by side', async () => {
    await as('authenticated', ADMIN, async (q) => {
      await q(`insert into team_popularity (team_id, season, popularity) values (541, 2027, 70)`);
      expect(await q(`select season from team_popularity where team_id = 541 order by season`)).toHaveLength(2);
    });
  });

  it('has the foreign key names the admin page embeds by (PostgREST resource embedding)', async () => {
    const names = (await db.query<{ conname: string }>(`select conname from pg_constraint where conrelid = 'rivalries'::regclass and contype = 'f'`)).rows.map((r) => r.conname).sort();
    expect(names).toEqual(['rivalries_team_a_id_fkey', 'rivalries_team_b_id_fkey']);
  });

  it('seeds nothing for ids this database does not have, and does not fail', async () => {
    // the migration already ran on a database without Premier League teams: only existing ids may be present
    const ids = (await db.query<{ team_id: number }>(`select team_id from team_popularity`)).rows.map((r) => Number(r.team_id));
    expect(ids).toEqual([541]);
  });
});
