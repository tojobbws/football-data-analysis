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

  it('review compares both featured versions with all LINEUP picks and buckets settled picks by edge', async () => {
    // a 14-point-edge pick that lost and an 8-point-edge pick that won; published before kickoff, the matches then move into the past
    await db.exec(`
      insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short)
        values (11, 39, 2026, now() + interval '1 day', 1, 2, 'NS'), (12, 39, 2026, now() + interval '1 day', 2, 1, 'NS');
      insert into analysis_predictions (fixture_id, publish_round, kind, market, selection, line, model_probability, market_probability, decision_rule_version) values
        (11, 'LINEUP', 'SIGNAL', 'ASIAN_HANDICAP', 'HOME', 0, 0.64, 0.50, 'rules-v0.3'),
        (12, 'LINEUP', 'SIGNAL', 'ASIAN_HANDICAP', 'AWAY', 0.5, 0.58, 0.50, 'rules-v0.5');
      update fixtures set kickoff_at = now() - interval '1 day', status_short = 'FT', ft_home = 1, ft_away = 0 where id in (11, 12);
      update analysis_predictions set status = 'LOSS', clv = 0.02 where fixture_id = 11;
      update analysis_predictions set status = 'WIN', clv = 0.01 where fixture_id = 12;
      insert into featured_selections (football_date, version, fixture_id, league_id, phase, rank, prediction_id, fair_probability, locked_at)
        select '2026-10-10', 'featured-v2', p.fixture_id, 39, 'CONFIRMED', p.fixture_id, p.id, 0.6, now() from analysis_predictions p where p.publish_round = 'LINEUP';
    `);
    await expect(as('authenticated', STRANGER, (q) => q('select fp_admin_review()'))).rejects.toThrow(/admin only/);
    const [r] = await as('authenticated', ADMIN, (q) => q('select fp_admin_review() as r'));
    const v = r!.r as {
      sides: Record<string, { picks: number; settled: number; fair_hit: number; clv_mean: number; avg_fair_probability: number | null }>;
      by_edge: Array<{ bucket: string; settled: number; fair_hit: number }>;
      by_rules: Array<{ rules: string; picks: number; settled: number }>;
      days: Array<{ version: string; day: string; picks: number; won: number; lost: number }>;
    };
    expect(v.sides['featured-v2']).toMatchObject({ picks: 2, settled: 2, fair_hit: 0.5 });
    expect(Number(v.sides['featured-v2']!.avg_fair_probability)).toBeCloseTo(0.6, 6);
    expect(Number(v.sides['featured-v2']!.clv_mean)).toBeCloseTo(0.015, 6);
    expect(v.sides['all:featured-v2']).toMatchObject({ picks: 2, settled: 2, fair_hit: 0.5 });
    expect(v.sides['featured-v1']).toBeUndefined(); // nothing confirmed for v1 yet
    expect(v.by_edge).toMatchObject([
      { bucket: '2) 6 to 9', settled: 1, fair_hit: 1 },
      { bucket: '4) 12 and over', settled: 1, fair_hit: 0 },
    ]);
    expect(v.by_rules).toMatchObject([{ rules: 'rules-v0.3', picks: 1, settled: 1 }, { rules: 'rules-v0.5', picks: 1, settled: 1 }]);
    expect(v.days).toMatchObject([{ version: 'featured-v2', day: '2026-10-10', picks: 2, won: 1, lost: 1 }]);
  });

  it('benchmark scores the last pre-kickoff forecasts of both sides on the same matches', async () => {
    // fixture 1 (home win), fixture 2 (draw) — fixtures from the coverage test
    await db.exec(`
      update fixtures set ft_home = 2, ft_away = 0 where id = 1;
      update fixtures set ft_home = 1, ft_away = 1 where id = 2;
      insert into model_versions (id, description) values ('dixon-coles-v0.2', 'dc'), ('ensemble-v0.1', 'ens') on conflict do nothing;
      insert into probability_predictions (fixture_id, model_version_id, computed_at, market, selection, probability) values
        -- fixture 1: DC says 0.5 home, the ensemble (preferred) says 0.6; a post-kickoff run is ignored
        (1, 'dixon-coles-v0.2', now() - interval '10 days', 'MATCH_WINNER', 'HOME', 0.5),
        (1, 'dixon-coles-v0.2', now() - interval '10 days', 'MATCH_WINNER', 'DRAW', 0.3),
        (1, 'dixon-coles-v0.2', now() - interval '10 days', 'MATCH_WINNER', 'AWAY', 0.2),
        (1, 'ensemble-v0.1', now() - interval '10 days', 'MATCH_WINNER', 'HOME', 0.6),
        (1, 'ensemble-v0.1', now() - interval '10 days', 'MATCH_WINNER', 'DRAW', 0.25),
        (1, 'ensemble-v0.1', now() - interval '10 days', 'MATCH_WINNER', 'AWAY', 0.15),
        (1, 'ensemble-v0.1', now() - interval '8 days', 'MATCH_WINNER', 'HOME', 0.01),
        (1, 'ensemble-v0.1', now() - interval '8 days', 'MATCH_WINNER', 'DRAW', 0.01),
        (1, 'ensemble-v0.1', now() - interval '8 days', 'MATCH_WINNER', 'AWAY', 0.98),
        -- fixture 2: model only, no benchmark
        (2, 'dixon-coles-v0.2', now() - interval '3 days', 'MATCH_WINNER', 'HOME', 0.4),
        (2, 'dixon-coles-v0.2', now() - interval '3 days', 'MATCH_WINNER', 'DRAW', 0.3),
        (2, 'dixon-coles-v0.2', now() - interval '3 days', 'MATCH_WINNER', 'AWAY', 0.3);
      insert into api_predictions (fixture_id, collected_at, percent_home, percent_draw, percent_away, raw) values
        (1, now() - interval '11 days', 10, 10, 80, '{}'),
        (1, now() - interval '10 days', 45, 45, 10, '{}'),   -- last before kickoff: wins
        (1, now() - interval '8 days', 100, 0, 0, '{}');     -- after kickoff: ignored
    `);
    await expect(as('authenticated', STRANGER, (q) => q('select fp_admin_benchmark()'))).rejects.toThrow(/admin only/);
    const [r] = await as('authenticated', ADMIN, (q) => q('select fp_admin_benchmark() as b'));
    const b = r!.b as { matched: number; model_only: number; benchmark_only: number; total: Record<string, number>; leagues: Array<{ league_name: string; n: number }> };
    expect(b).toMatchObject({ matched: 1, model_only: 1, benchmark_only: 0 });
    // model 0.6/0.25/0.15 on a home win: 0.16 + 0.0625 + 0.0225; benchmark 0.45/0.45/0.10: 0.3025 + 0.2025 + 0.01
    expect(b.total.model_brier).toBeCloseTo(0.245, 6);
    expect(b.total.benchmark_brier).toBeCloseTo(0.515, 6);
    expect(b.total.model_log_loss).toBeCloseTo(-Math.log(0.6), 6);
    expect(b.total.benchmark_log_loss).toBeCloseTo(-Math.log(0.45), 6);
    expect(b.total.brier_diff).toBeCloseTo(-0.27, 6);
    expect(b.leagues).toMatchObject([{ league_name: 'Premier League', n: 1 }]);
  });

  it('review fair hit counts half results as half a stake, like analysis_performance (audit A-06)', async () => {
    // WIN, HALF_WIN, HALF_LOSS, PUSH under one rules version: (1 + ½) / (1 + ½ + ½) = 0.75 (the old formula gave 1.5 / 3 = 0.5)
    await db.exec(`
      insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short)
        values (31, 39, 2026, now() + interval '1 day', 1, 2, 'NS'), (32, 39, 2026, now() + interval '1 day', 2, 1, 'NS'),
               (33, 39, 2026, now() + interval '1 day', 1, 2, 'NS'), (34, 39, 2026, now() + interval '1 day', 2, 1, 'NS');
      insert into analysis_predictions (fixture_id, publish_round, kind, market, selection, line, model_probability, market_probability, decision_rule_version)
        select id, 'EARLY', 'SIGNAL', 'ASIAN_HANDICAP', 'HOME', -0.25, 0.56, 0.5, 'rules-half-test' from fixtures where id between 31 and 34;
      update fixtures set kickoff_at = now() - interval '1 day', status_short = 'FT', ft_home = 1, ft_away = 0 where id between 31 and 34;
      update analysis_predictions set status = 'WIN' where fixture_id = 31;
      update analysis_predictions set status = 'HALF_WIN' where fixture_id = 32;
      update analysis_predictions set status = 'HALF_LOSS' where fixture_id = 33;
      update analysis_predictions set status = 'PUSH' where fixture_id = 34;
    `);
    const [r] = await as('authenticated', ADMIN, (q) => q('select fp_admin_review() as r'));
    const v = r!.r as { by_rules: Array<{ rules: string; picks: number; settled: number; fair_hit: number }> };
    const half = v.by_rules.find((x) => x.rules === 'rules-half-test');
    expect(half).toMatchObject({ picks: 4, settled: 3 });
    expect(Number(half!.fair_hit)).toBeCloseTo(0.75, 9);
    const [perf] = await as('authenticated', ADMIN, (q) =>
      q(`select round((count(*) filter (where status = 'WIN') + 0.5 * count(*) filter (where status = 'HALF_WIN'))::numeric
               / (count(*) filter (where status in ('WIN','LOSS')) + 0.5 * count(*) filter (where status in ('HALF_WIN','HALF_LOSS'))), 4) as w
           from analysis_predictions where decision_rule_version = 'rules-half-test'`),
    );
    expect(Number(perf!.w)).toBeCloseTo(Number(half!.fair_hit), 4);
  });
});
