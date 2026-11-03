/**
 * E2E: Hybrid AI picks (PGlite, all migrations) -> featured job on featured-ai-v1 over one football day (ADR 0012).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repository, type JobContext } from '@fp/database';
import { FEATURED_AI_V1 } from '@fp/analysis';
import { ApiFootball, ApiFootballClient } from '@fp/football';
import { addHours, createLogger, footballDay, type Env } from '@fp/shared';
import { createTestDb } from '../../../packages/database/test/helpers.js';
import { featuredJob } from '../src/featured-job.js';

let db: Awaited<ReturnType<typeof createTestDb>>;
let ctx: JobContext;
const day = footballDay(new Date(Date.now() + 3 * 86_400_000));
const morning = addHours(day.from, 1);

// fixture, league, hours after the day starts, AI strength on the published row (LEAN = LOW confidence)
const MATCHES: Array<[number, number, number, 'MEDIUM' | 'LEAN']> = [
  [401, 39, 8, 'MEDIUM'],
  [402, 39, 9, 'MEDIUM'],
  [403, 39, 10, 'MEDIUM'], // third Premier League match: over the per-league cap
  [404, 140, 11, 'LEAN'], // the AI is LOW sure: out
  [405, 135, 12, 'MEDIUM'],
  [406, 88, 6, 'MEDIUM'], // not a big league: after the big ones although it kicks off first
  [407, 61, 14, 'MEDIUM'],
];

const rows = async () =>
  new Map(
    (await db.query<{ fixture_id: number; phase: string; rank: number | null }>(`select fixture_id, phase, rank from featured_selections where version = 'featured-ai-v1' order by fixture_id`)).rows.map((r) => [
      Number(r.fixture_id),
      [r.phase, r.rank == null ? null : Number(r.rank)] as const,
    ]),
  );

beforeAll(async () => {
  db = await createTestDb();
  const client = new ApiFootballClient({ apiKey: 'test', fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch });
  const env: Env = {
    API_FOOTBALL_KEY: 'test',
    API_FOOTBALL_BASE_URL: 'https://v3.football.api-sports.io',
    API_FOOTBALL_RPM: 1000,
    DATABASE_URL: 'pglite',
    TRACKED_LEAGUES: [39, 140, 135, 78, 61, 88],
    SEASON: 2026,
    ODDS_MARKETS: ['MATCH_WINNER', 'ASIAN_HANDICAP', 'OVER_UNDER'],
    ODDS_BOOKMAKERS: [],
    LOG_LEVEL: 'error',
  };
  ctx = { env, db, repo: new Repository(db), client, api: new ApiFootball(client), log: createLogger('error') };

  await db.query(`insert into leagues (id, name) values (39, 'EPL'), (140, 'La Liga'), (135, 'Serie A'), (78, 'Bundesliga'), (61, 'Ligue 1'), (88, 'Eredivisie')`);
  await db.query(`insert into teams (id, name) select g, 'T' || g from generate_series(401, 407) g`);
  await db.query(`insert into teams (id, name) values (999, 'Away FC')`);
  for (const [id, league, h, strength] of MATCHES) {
    await db.query(`insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short) values ($1::int, $2, 2026, $3, $1::int, 999, 'NS')`, [id, league, addHours(day.from, h).toISOString()]);
    // an AI pick has no model probability, no distribution and no candidate; it is published at the EARLY round only
    await db.query(
      `insert into analysis_predictions (fixture_id, publish_round, kind, market, selection, line, odds_at_publish, market_probability, signal_strength, decision_rule_version)
       values ($1, 'EARLY', 'SIGNAL', 'ASIAN_HANDICAP', 'HOME', -0.25, 1.95, 0.52, $2, 'hybrid-ai-v1')`,
      [id, strength],
    );
  }
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('featuredJob, featured-ai-v1', () => {
  it('morning: reserves MEDIUM picks, big five first, at most 2 per league, LOW left out', async () => {
    await featuredJob(ctx, { now: morning, config: FEATURED_AI_V1 });
    const r = await rows();
    expect([...r.entries()].filter(([, v]) => v[1] !== null).map(([k, v]) => [k, v[1]])).toEqual([
      [401, 1],
      [402, 2],
      [405, 3],
      [406, 5],
      [407, 4],
    ]);
  });

  it('the rules lists never take an AI pick', async () => {
    await featuredJob(ctx, { now: morning });
    expect((await db.query(`select 1 from featured_selections where version = 'featured-v1'`)).rows).toHaveLength(0);
  });

  it('at kick-off without a LINEUP round a reserved match is confirmed and keeps its slot; one never ranked is skipped', async () => {
    await featuredJob(ctx, { now: addHours(day.from, 10.5), config: FEATURED_AI_V1 });
    const r = await rows();
    expect(r.get(406)).toEqual(['CONFIRMED', expect.any(Number)]);
    expect(r.get(401)).toEqual(['CONFIRMED', expect.any(Number)]);
    expect(r.get(402)).toEqual(['CONFIRMED', expect.any(Number)]);
    expect(r.get(403)![0]).toBe('SKIPPED');
    expect(r.get(403)![1]).toBeNull();
    // still to play: reserved, not confirmed
    expect(r.get(405)![0]).toBe('RESERVED');
  });
});
