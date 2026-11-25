/**
 * Home-page banners (0063, ADR 0024): anon reads only the banners that may show now, the gambling switch hides the
 * flagged ones at once, clicks go through fp_banner_click(), and only role ADMIN writes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers.js';

let db: Awaited<ReturnType<typeof createTestDb>>;
const ADMIN = '11111111-1111-1111-1111-111111111111';
const EDITOR = '22222222-2222-2222-2222-222222222222';

beforeAll(async () => {
  db = await createTestDb();
  await db.exec(`
    create schema if not exists auth;
    create or replace function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant all on all tables in schema public to anon, authenticated;
    grant usage on all sequences in schema public to anon, authenticated;
    insert into admin_users (user_id, email, role) values ('${ADMIN}', 'admin@x', 'ADMIN'), ('${EDITOR}', 'editor@x', 'EDITOR');
    insert into banners (name, image_wide_url, image_phone_url, alt_text, target_url, slots, priority, starts_at, ends_at, is_on, is_gambling) values
      ('live',     'https://img/w1.jpg', 'https://img/p1.jpg', 'a', 'https://a.example', '{home_top}', 1, now() - interval '1 day', null, true, false),
      ('gambling', 'https://img/w2.jpg', 'https://img/p2.jpg', 'b', 'https://b.example', '{home_top,home_league_1}', 5, now() - interval '1 day', null, true, true),
      ('ended',    'https://img/w3.jpg', 'https://img/p3.jpg', 'c', 'https://c.example', '{home_top}', 9, now() - interval '3 day', now() - interval '1 day', true, false),
      ('future',   'https://img/w4.jpg', 'https://img/p4.jpg', 'd', 'https://d.example', '{home_top}', 9, now() + interval '1 day', null, true, false),
      ('off',      'https://img/w5.jpg', 'https://img/p5.jpg', 'e', 'https://e.example', '{home_top}', 9, now() - interval '1 day', null, false, false);
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

const names = (rows: Array<Record<string, unknown>>) => rows.map((r) => r.name).sort();

describe('banners', () => {
  it('anon sees only the banners that may show now; admins see every banner', async () => {
    expect(names(await as('anon', null, (q) => q('select name from banners')))).toEqual(['gambling', 'live']);
    expect((await as('authenticated', EDITOR, (q) => q('select name from banners'))).length).toBe(5);
  });

  it('the gambling switch hides every gambling banner and refuses their clicks', async () => {
    await db.exec(`update site_settings set value = 'true' where key = 'hide_gambling_banners'`);
    try {
      expect(names(await as('anon', null, (q) => q('select name from banners')))).toEqual(['live']);
      const [r] = await as('anon', null, (q) => q(`select fp_banner_click((select id from banners where name = 'gambling'), true) as t`));
      expect(r!.t).toBeNull();
    } finally {
      await db.exec(`update site_settings set value = 'false' where key = 'hide_gambling_banners'`);
    }
  });

  it('fp_banner_click returns the destination and counts only when asked; ended banners go nowhere', async () => {
    const before = Number((await db.query<{ n: number }>('select count(*)::int as n from banner_clicks')).rows[0]!.n);
    const [hit] = await as('anon', null, (q) => q(`select fp_banner_click((select id from banners where name = 'live' limit 1), true) as t`));
    expect(hit!.t).toBe('https://a.example');
    await as('anon', null, (q) => q(`select fp_banner_click((select id from banners where name = 'live' limit 1), false)`));
    const [ended] = await as('anon', null, (q) => q(`select fp_banner_click((select id from banners where name = 'ended' limit 1), true) as t`));
    expect(ended!.t).toBeNull();
    // the as() transactions roll back, so count inside one
    await db.exec('begin; set local role anon;');
    try {
      await db.query(`select fp_banner_click((select id from banners where name = 'live' limit 1), true)`);
      await db.query(`select fp_banner_click((select id from banners where name = 'live' limit 1), false)`);
      await db.exec(`reset role;`);
      const n = Number((await db.query<{ n: number }>('select count(*)::int as n from banner_clicks')).rows[0]!.n);
      expect(n).toBe(before + 1);
    } finally {
      await db.exec('rollback;');
    }
  });

  it('anon cannot read clicks or settings; only ADMIN writes banners and settings', async () => {
    expect(await as('anon', null, (q) => q('select * from banner_clicks'))).toEqual([]);
    expect(await as('anon', null, (q) => q('select * from site_settings'))).toEqual([]);
    const insert = `insert into banners (name, image_wide_url, image_phone_url, alt_text, target_url, slots) values ('x', 'https://w', 'https://p', 'x', 'https://t', '{home_top}')`;
    await expect(as('anon', null, (q) => q(insert))).rejects.toThrow(/row-level security/);
    await expect(as('authenticated', EDITOR, (q) => q(insert))).rejects.toThrow(/row-level security/);
    await as('authenticated', ADMIN, async (q) => {
      await q(insert);
      expect(await q(`update site_settings set value = 'true' where key = 'hide_gambling_banners' returning key`)).toHaveLength(1);
    });
    expect(await as('authenticated', EDITOR, (q) => q(`update site_settings set value = 'true' returning key`))).toEqual([]);
  });

  it('refuses bad rows: unknown slot, http links, end before start', async () => {
    const row = (extra: string) =>
      db.query(`insert into banners (name, image_wide_url, image_phone_url, alt_text, target_url, slots, starts_at, ends_at) values ${extra}`);
    await expect(row(`('x', 'https://w', 'https://p', 'x', 'https://t', '{sidebar}', now(), null)`)).rejects.toThrow();
    await expect(row(`('x', 'https://w', 'https://p', 'x', 'http://t', '{home_top}', now(), null)`)).rejects.toThrow();
    await expect(row(`('x', 'https://w', 'https://p', 'x', 'https://t', '{home_top}', now(), now() - interval '1 day')`)).rejects.toThrow();
  });

  it('click counts are for admins only', async () => {
    await expect(as('anon', null, (q) => q('select * from fp_admin_banner_clicks()'))).rejects.toThrow();
    await as('authenticated', EDITOR, (q) => q('select * from fp_admin_banner_clicks()'));
  });
});
