import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repository, type JobContext } from '@fp/database';
import { ApiFootball, ApiFootballClient } from '@fp/football';
import { createLogger, type Env } from '@fp/shared';
import { cropMatrix, scoreMatrix } from '@fp/analysis';
import { createTestDb } from '../../../packages/database/test/helpers.js';
import { qualificationJob } from '../src/qualification-job.js';

let db: Awaited<ReturnType<typeof createTestDb>>;
let ctx: JobContext;
const NOW = new Date('2027-03-10T12:00:00Z');
const day = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString();
const q = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<R>(sql, params)).rows;

async function matrixFor(fixtureId: number, kickoffDays: number, lambda: number, mu: number) {
  await q(
    `insert into scoreline_snapshots (fixture_id, model_version_id, computed_at, source, max_goals, sides_lambda, sides_mu, sides_rho, sides_matrix, totals_lambda, totals_mu, totals_matrix)
     values ($1, 'dixon-coles-v0.2', $2, 'live', 10, $3, $4, -0.05, $5, $3, $4, $5)`,
    [fixtureId, new Date(NOW.getTime() + kickoffDays * 86_400_000 - 3_600_000).toISOString(), lambda, mu, JSON.stringify(cropMatrix(scoreMatrix(lambda, mu, -0.05)))],
  );
}

beforeAll(async () => {
  db = await createTestDb();
  const repo = new Repository(db);
  const client = new ApiFootballClient({ apiKey: 'test', fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch });
  const env: Env = {
    API_FOOTBALL_KEY: 'test',
    API_FOOTBALL_BASE_URL: 'https://v3.football.api-sports.io',
    API_FOOTBALL_RPM: 1000,
    DATABASE_URL: 'pglite',
    TRACKED_LEAGUES: [2],
    SEASON: 2026,
    ODDS_MARKETS: ['MATCH_WINNER'],
    ODDS_BOOKMAKERS: [],
    LOG_LEVEL: 'error',
  };
  ctx = { env, db, repo, client, api: new ApiFootball(client), log: createLogger('error') };

  await db.exec(`
    insert into leagues (id, name) values (2, 'Champions League'), (3, 'Europa League'), (9, 'Some Cup');
    insert into teams (id, name) select g, 'Team ' || g from generate_series(1, 12) g;
    insert into model_versions (id) values ('dixon-coles-v0.2');
    insert into competition_rules (league_id, from_season, stage, legs, extra_time, penalties) values
      (2, 2021, 'ROUND_OF_16', 2, true, true), (2, 2021, 'FINAL', 1, true, true), (3, 2021, 'ROUND_OF_16', 2, true, true);
  `);
  const fx = (id: number, league: number, round: string, home: number, away: number, kickoffDays: number, status: string, ft: [number, number] | null) =>
    q(
      `insert into fixtures (id, league_id, season, round, kickoff_at, home_team_id, away_team_id, status_short, ft_home, ft_away, goals_home, goals_away)
       values ($1, $2, 2026, $3, $4, $5, $6, $7, $8, $9, $8, $9)`,
      [id, league, round, day(kickoffDays), home, away, status, ft?.[0] ?? null, ft?.[1] ?? null],
    );
  // tie 1 (priced): team 1 won the first leg 2-0 at home; the second leg is in 2 days, matrix stored
  await fx(100, 2, 'Round of 16', 1, 2, -7, 'FT', [2, 0]);
  await fx(101, 2, 'Round of 16', 2, 1, 2, 'NS', null);
  await matrixFor(101, 2, 1.3, 1.1);
  // tie 2 (no stored matrix for the second leg): skipped, not guessed
  await fx(102, 2, 'Round of 16', 3, 4, -7, 'FT', [1, 1]);
  await fx(103, 2, 'Round of 16', 4, 3, 2, 'NS', null);
  // tie 3 (second leg more than 7 days away): not yet
  await fx(104, 2, 'Round of 16', 5, 6, -7, 'FT', [0, 0]);
  await fx(105, 2, 'Round of 16', 6, 5, 20, 'NS', null);
  await matrixFor(105, 20, 1.3, 1.1);
  // a final is a single match: no tie; a competition without rules: no tie
  await fx(106, 2, 'Final', 7, 8, 3, 'NS', null);
  await fx(107, 9, 'Round of 16', 9, 10, -7, 'FT', [1, 0]);
  await fx(108, 9, 'Round of 16', 10, 9, 2, 'NS', null);
  await matrixFor(108, 2, 1.3, 1.1);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('qualificationJob', () => {
  it('prices only the ties it has the matrices for, and writes one forecast with the aggregate and assumptions', async () => {
    expect(await qualificationJob(ctx, { now: NOW })).toBe(1);
    const rows = await q<{ fixture_id: string; leg: number; agg_a: number; agg_b: number; p_a: string; p_b: string; stage: string; source: string; team_a_id: string; assumptions: string[] }>(`select * from qualification_snapshots`);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(Number(r.fixture_id)).toBe(101);
    expect([r.leg, r.agg_a, r.agg_b, r.stage, r.source, Number(r.team_a_id)]).toEqual([2, 2, 0, 'ROUND_OF_16', 'live', 1]);
    expect(Number(r.p_a) + Number(r.p_b)).toBeCloseTo(1, 4);
    expect(Number(r.p_a)).toBeGreaterThan(0.8); // 2-0 up, level scoring rates, second leg away
    expect(Number(r.p_a)).toBeLessThan(0.99);
    expect(JSON.stringify(r.assumptions)).toContain('50/50');
  });

  it('is not repeated within the gap, and stays one row per run when re-run later', async () => {
    expect(await qualificationJob(ctx, { now: new Date(NOW.getTime() + 3_600_000) })).toBe(0);
    expect(await q(`select 1 from qualification_snapshots`)).toHaveLength(1);
    expect(await qualificationJob(ctx, { now: new Date(NOW.getTime() + 7 * 3_600_000) })).toBe(1);
    expect(await q(`select 1 from qualification_snapshots where fixture_id = 101`)).toHaveLength(2); // history kept, not overwritten
  });

  it('never forecasts a single-match stage, a competition without rules, or a tie further away than the window', async () => {
    const fixtures = (await q<{ fixture_id: string }>(`select distinct fixture_id from qualification_snapshots`)).map((r) => Number(r.fixture_id));
    expect(fixtures).toEqual([101]);
  });

  it('a finished tie, or one whose next leg has started, gets nothing new', async () => {
    await q(`update fixtures set status_short = '1H', kickoff_at = $1 where id = 101`, [new Date(NOW.getTime() - 600_000).toISOString()]);
    expect(await qualificationJob(ctx, { now: new Date(NOW.getTime() + 20 * 3_600_000) })).toBe(0);
    await q(`update fixtures set status_short = 'NS', kickoff_at = $1 where id = 101`, [day(2)]);
  });
});

describe('before migration 0040', () => {
  it('finds no rules and does nothing instead of failing the hourly run', async () => {
    const broken = new Repository({ ...db, query: async () => Promise.reject(new Error('relation does not exist')) } as never);
    expect(await broken.competitionRuleRows()).toEqual([]);
  });
});

describe('web_qualification', () => {
  it('shows the last forecast made before kickoff, and whether the league passed its model test', async () => {
    const [v] = await q<{ fixture_id: string; leg: number; sides_tested: boolean; p_a: string }>(`select * from web_qualification where fixture_id = 101`);
    expect(v!.leg).toBe(2);
    expect(v!.sides_tested).toBe(false);
    await q(`insert into model_configs (league_id, purpose, model_version_id, params, metrics, enabled, matches_evaluated, tuned_at) values (2, 'SIDES', 'dixon-coles-v0.2', '{}', '{}', true, 200, '2027-03-01')`);
    expect((await q<{ sides_tested: boolean }>(`select sides_tested from web_qualification where fixture_id = 101`))[0]!.sides_tested).toBe(true);
    const latest = (await q<{ p_a: string }>(`select p_a from qualification_snapshots where fixture_id = 101 order by computed_at desc limit 1`))[0]!;
    expect(Number(v!.p_a)).toBeCloseTo(Number(latest.p_a), 5);
  });

  it('ignores a forecast stamped at or after kickoff', async () => {
    await q(`insert into qualification_snapshots (fixture_id, model_version_id, computed_at, tie_key, stage, leg, team_a_id, team_b_id, p_a, p_b, p_extra_time, p_penalties) values (101, 'qualification-v0.1', $1, 'x', 'ROUND_OF_16', 2, 1, 2, 0.01, 0.99, 0, 0)`, [day(3)]);
    expect(Number((await q<{ p_a: string }>(`select p_a from web_qualification where fixture_id = 101`))[0]!.p_a)).toBeGreaterThan(0.5);
  });

  it('anon reads the view but not the snapshots', async () => {
    await db.exec('set role anon');
    try {
      expect((await q(`select 1 from web_qualification`)).length).toBe(1);
      await expect(q(`select 1 from qualification_snapshots`)).rejects.toThrow();
    } finally {
      await db.exec('reset role');
    }
  });
});
