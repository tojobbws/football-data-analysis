/**
 * Back-office permissions are enforced by RLS, not by the website:
 * logged-in non-admins and anon must not read internal tables or write articles.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers.js';

let db: Awaited<ReturnType<typeof createTestDb>>;
const ADMIN = '11111111-1111-1111-1111-111111111111';
const EDITOR = '22222222-2222-2222-2222-222222222222';
const STRANGER = '33333333-3333-3333-3333-333333333333';

beforeAll(async () => {
  db = await createTestDb();
  // stand-in for Supabase's auth.uid(): reads the JWT subject from a setting
  await db.exec(`
    create schema if not exists auth;
    create or replace function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant all on all tables in schema public to anon, authenticated;   -- like Supabase's default grants
    grant usage on all sequences in schema public to anon, authenticated;
    insert into admin_users (user_id, email, role) values ('${ADMIN}', 'admin@x', 'ADMIN'), ('${EDITOR}', 'editor@x', 'EDITOR');
    insert into sync_runs (job) values ('details');
  `);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

/** run statements as a role / user inside one transaction, then roll back */
async function as<T>(role: 'anon' | 'authenticated', uid: string | null, fn: (q: (sql: string) => Promise<Array<Record<string, unknown>>>) => Promise<T>): Promise<T> {
  await db.exec(`begin; set local role ${role}; select set_config('test.uid', '${uid ?? ''}', true);`);
  try {
    return await fn(async (sql) => (await db.query<Record<string, unknown>>(sql)).rows);
  } finally {
    await db.exec('rollback;');
  }
}

describe('admin RLS', () => {
  it('internal tables are invisible to anon and to logged-in non-admins', async () => {
    expect(await as('anon', null, (q) => q('select * from sync_runs'))).toEqual([]);
    expect(await as('authenticated', STRANGER, (q) => q('select * from sync_runs'))).toEqual([]);
    expect((await as('authenticated', ADMIN, (q) => q('select * from sync_runs'))).length).toBe(1);
    expect((await as('authenticated', EDITOR, (q) => q('select * from sync_runs'))).length).toBe(1);
  });

  it('only admins/editors write articles; only ADMIN deletes; anon sees PUBLISHED only', async () => {
    const insert = `insert into articles (slug, title, body_md, status) values ('a1', 'T', 'body', 'DRAFT')`;
    await expect(as('authenticated', STRANGER, (q) => q(insert))).rejects.toThrow(/row-level security/);
    await expect(as('anon', null, (q) => q(insert))).rejects.toThrow(/row-level security/);

    await as('authenticated', EDITOR, async (q) => {
      await q(insert);
      const [a] = await q(`update articles set status = 'PUBLISHED' where slug = 'a1' returning published_at, updated_at`);
      expect(a!.published_at).not.toBeNull();
      expect(await q(`delete from articles where slug = 'a1' returning id`)).toEqual([]); // EDITOR cannot delete
    });

    await db.exec(`insert into articles (slug, title, body_md, status) values ('draft', 'D', 'x', 'DRAFT'), ('live', 'L', 'x', 'PUBLISHED')`);
    expect((await as('anon', null, (q) => q('select slug from articles'))).map((r) => r.slug)).toEqual(['live']);
    expect((await as('authenticated', ADMIN, (q) => q('select slug from articles order by slug'))).map((r) => r.slug)).toEqual(['draft', 'live']);
    expect((await as('authenticated', ADMIN, (q) => q(`delete from articles where slug = 'draft' returning id`))).length).toBe(1);
  });

  it('overview is admin only; users only see their own admin row', async () => {
    await expect(as('authenticated', STRANGER, (q) => q('select fp_admin_overview()'))).rejects.toThrow(/admin only/);
    const [o] = await as('authenticated', ADMIN, (q) => q('select fp_admin_overview() as o'));
    expect(o!.o).toMatchObject({ chain_ok: true, published: 0 });
    expect(await as('authenticated', ADMIN, (q) => q('select email from admin_users'))).toEqual([{ email: 'admin@x' }]);
    expect(await as('authenticated', STRANGER, (q) => q('select email from admin_users'))).toEqual([]);
  });

  it('coverage is admin only and compares the flags with what the season holds', async () => {
    await db.exec(`
      insert into leagues (id, name) values (39, 'Premier League');
      insert into league_seasons (league_id, season, is_current, coverage) values (39, 2026, true, '{"injuries": false}');
      insert into teams (id, name) values (1, 'A'), (2, 'B');
      insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short)
        values (1, 39, 2026, now() - interval '9 days', 1, 2, 'FT'), (2, 39, 2026, now() - interval '2 days', 2, 1, 'FT'),
               (3, 39, 2026, now() + interval '2 days', 1, 2, 'NS');
      insert into fixture_statistics (fixture_id, team_id, type, value_num) values (1, 1, 'expected_goals', 1.2);
    `);
    await expect(as('authenticated', STRANGER, (q) => q('select fp_admin_coverage()'))).rejects.toThrow(/admin only/);
    const [r] = await as('authenticated', ADMIN, (q) => q('select fp_admin_coverage() as c'));
    expect(r!.c).toEqual([
      { league_id: 39, league_name: 'Premier League', season: 2026, coverage: { injuries: false }, finished: 2, xg: 1, events: 0, lineups: 0, injuries: 0 },
    ]);
  });
});
