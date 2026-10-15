/**
 * E2E: published picks (PGlite, all migrations) -> featured job over one football day (ADR 0004).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repository, type JobContext } from '@fp/database';
import { ApiFootball, ApiFootballClient } from '@fp/football';
import { addHours, createLogger, footballDay, type Env } from '@fp/shared';
import { createTestDb } from '../../../packages/database/test/helpers.js';
import { featuredJob } from '../src/featured-job.js';

let db: Awaited<ReturnType<typeof createTestDb>>;
let ctx: JobContext;
const day = footballDay(new Date(Date.now() + 2 * 86_400_000));
const morning = addHours(day.from, 1);
const STRONG = { win: 0.6, halfWin: 0, push: 0, halfLoss: 0, loss: 0.4 };
const WEAK = { win: 0.5, halfWin: 0, push: 0, halfLoss: 0, loss: 0.5 };

// fixture -> league, hours after the day starts, support score
const MATCHES: Array<[number, number, number, number]> = [
  [301, 39, 8, 9],
  [302, 39, 9, 8],
  [303, 39, 10, 7], // third EPL match: over the per-league cap
  [304, 140, 11, 6],
  [305, 135, 12, 5],
  [306, 78, 13, 4],
  [307, 61, 14, 3],
];

async function publish(fixtureId: number, round: 'EARLY' | 'LINEUP', support: number, dist: typeof STRONG | null) {
  const run = await db.query<{ id: string }>(`insert into analysis_runs (fixture_id, outcome) values ($1, $2) returning id`, [fixtureId, dist ? 'SIGNAL' : 'NO_CLEAR_SIGNAL']);
  if (!dist) {
    await db.query(`insert into analysis_predictions (fixture_id, publish_round, kind, run_id) values ($1, $2, 'NO_CLEAR_SIGNAL', $3)`, [fixtureId, round, run.rows[0]!.id]);
    return;
  }
  const cand = await db.query<{ id: number }>(
    `insert into analysis_candidates (run_id, fixture_id, market, selection, line, odds, model_probability, market_probability, support_score, rank)
     values ($1, $2, 'ASIAN_HANDICAP', 'HOME', -0.25, 1.95, 0.6, 0.52, $3, 1) returning id`,
    [run.rows[0]!.id, fixtureId, support],
  );
  await db.query(
    `insert into analysis_predictions (fixture_id, publish_round, kind, market, selection, line, odds_at_publish, model_probability, market_probability, signal_strength, run_id, candidate_id, model_distribution)
     values ($1, $2, 'SIGNAL', 'ASIAN_HANDICAP', 'HOME', -0.25, 1.95, 0.6, 0.52, 'MEDIUM', $3, $4, $5)`,
    [fixtureId, round, run.rows[0]!.id, cand.rows[0]!.id, JSON.stringify(dist)],
  );
}

const rows = async () =>
  (await db.query<{ fixture_id: number; phase: string; rank: number | null }>(`select fixture_id, phase, rank from featured_selections order by fixture_id`)).rows.map((r) => [
    Number(r.fixture_id),
    r.phase,
    r.rank == null ? null : Number(r.rank),
  ]);

beforeAll(async () => {
  db = await createTestDb();
  const repo = new Repository(db);
  const client = new ApiFootballClient({ apiKey: 'test', fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch });
  const env: Env = {
    API_FOOTBALL_KEY: 'test',
    API_FOOTBALL_BASE_URL: 'https://v3.football.api-sports.io',
    API_FOOTBALL_RPM: 1000,
    DATABASE_URL: 'pglite',
    TRACKED_LEAGUES: [39, 140, 135, 78, 61],
    SEASON: 2026,
    ODDS_MARKETS: ['MATCH_WINNER', 'ASIAN_HANDICAP', 'OVER_UNDER'],
    ODDS_BOOKMAKERS: [],
    LOG_LEVEL: 'error',
  };
  ctx = { env, db, repo, client, api: new ApiFootball(client), log: createLogger('error') };

  await db.query(`insert into leagues (id, name) values (39, 'EPL'), (140, 'La Liga'), (135, 'Serie A'), (78, 'Bundesliga'), (61, 'Ligue 1')`);
  await db.query(`insert into teams (id, name) select g, 'T' || g from generate_series(301, 307) g`);
  await db.query(`insert into teams (id, name) values (999, 'Away FC')`);
  for (const [id, league, h, support] of MATCHES) {
    await db.query(`insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short) values ($1::int, $2, 2026, $3, $1::int, 999, 'NS')`, [
      id,
      league,
      addHours(day.from, h).toISOString(),
    ]);
    await publish(id, 'EARLY', support, STRONG);
  }
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('featuredJob', () => {
  it('morning: reserves the 5 best picks, at most 2 per league', async () => {
    await featuredJob(ctx, { now: morning });
    expect(await rows()).toEqual([
      [301, 'RESERVED', 1],
      [302, 'RESERVED', 2],
      [304, 'RESERVED', 3],
      [305, 'RESERVED', 4],
      [306, 'RESERVED', 5],
    ]);
  });

  it('a reserved match whose LINEUP pick is no longer eligible is dropped and frees its slot', async () => {
    await publish(301, 'LINEUP', 9, WEAK);
    await featuredJob(ctx, { now: addHours(day.from, 7) });
    expect(await rows()).toEqual([
      [301, 'DROPPED', null],
      [302, 'RESERVED', 1],
      [303, 'RESERVED', 2], // the EPL cap has room again
      [304, 'RESERVED', 3],
      [305, 'RESERVED', 4],
      [306, 'RESERVED', 5],
    ]);
  });

  it('a reserved match confirmed at its LINEUP round keeps its slot for good', async () => {
    await publish(302, 'LINEUP', 8, STRONG);
    await featuredJob(ctx, { now: addHours(day.from, 8) });
    const r = await rows();
    expect(r.find((x) => x[0] === 302)).toEqual([302, 'CONFIRMED', 1]);
    await expect(db.query(`update featured_selections set rank = 9 where fixture_id = 302`)).rejects.toThrow(/locked/);
    await expect(db.query(`delete from featured_selections where fixture_id = 301`)).rejects.toThrow(/locked/);
  });

  it('a match outside the list at its LINEUP round is skipped; kick-off without LINEUP drops a reserved one', async () => {
    await publish(307, 'LINEUP', 3, STRONG);
    // 303 and 304 kick off without a LINEUP round
    await featuredJob(ctx, { now: addHours(day.from, 11.5) });
    const r = new Map((await rows()).map((x) => [x[0], x.slice(1)]));
    expect(r.get(303)).toEqual(['DROPPED', null]);
    expect(r.get(304)).toEqual(['DROPPED', null]);
    // 307 now has a slot (303/304 out) and its LINEUP pick is in -> confirmed
    expect(r.get(307)).toEqual(['CONFIRMED', 4]);
    expect(r.get(305)).toEqual(['RESERVED', 2]);
  });
});
