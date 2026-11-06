/**
 * E2E (PGlite): on the switch to the daily pick run (ADR 0014) featured-ai-v1 takes no new match and locks the rows it
 * holds at kick-off as they stand, also a match of yesterday's football day first seen after 06:00.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FEATURED_AI_V1 } from '@fp/analysis';
import { Repository, type JobContext } from '@fp/database';
import { ApiFootball, ApiFootballClient } from '@fp/football';
import { createLogger, type Env } from '@fp/shared';
import { createTestDb } from '../../../packages/database/test/helpers.js';
import { featuredJob } from '../src/featured-job.js';

const thai = (s: string) => new Date(`${s}:00+07:00`);
let db: Awaited<ReturnType<typeof createTestDb>>;
let ctx: JobContext;
const q = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<R>(sql, params)).rows;

// fixture, Thai kick-off, the ai-v1 row it holds on football day 2027-01-05 (undefined = none)
const MATCHES: Array<[number, string, number | null | undefined]> = [
  [701, '2027-01-05T20:00', 1],
  [702, '2027-01-06T05:30', 2], // the last kick-off of the football day
  [703, '2027-01-05T21:00', null], // reserved earlier, out of the list now
  [704, '2027-01-05T22:00', undefined], // a pick with no row: never added
  [705, '2027-01-06T05:50', 3], // not kicked off yet at the second run
];

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(thai('2027-01-05T09:00'));
  db = await createTestDb();
  const client = new ApiFootballClient({ apiKey: 'test', fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch });
  const env = { API_FOOTBALL_KEY: 'test', API_FOOTBALL_BASE_URL: 'https://v3.football.api-sports.io', API_FOOTBALL_RPM: 1000, DATABASE_URL: 'pglite', TRACKED_LEAGUES: [88], SEASON: 2026, ODDS_MARKETS: [], ODDS_BOOKMAKERS: [], LOG_LEVEL: 'error' } as unknown as Env;
  ctx = { env, db, repo: new Repository(db), client, api: new ApiFootball(client), log: createLogger('error') };
  await db.exec(`insert into leagues (id, name) values (88, 'Eredivisie'); insert into teams (id, name) values (999, 'Away FC');`);
  for (const [id, ko, rank] of MATCHES) {
    await q(`insert into teams (id, name) values ($1, $2)`, [id, `T${id}`]);
    await q(`insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short) values ($1::int, 88, 2026, $2, $1::int, 999, 'NS')`, [id, thai(ko).toISOString()]);
    await q(
      `insert into analysis_predictions (fixture_id, publish_round, kind, market, selection, line, odds_at_publish, market_probability, signal_strength, decision_rule_version)
       values ($1, 'EARLY', 'SIGNAL', 'ASIAN_HANDICAP', 'HOME', -0.25, 1.95, 0.52, 'MEDIUM', 'hybrid-ai-v1')`,
      [id],
    );
    if (rank !== undefined)
      await q(`insert into featured_selections (football_date, version, fixture_id, league_id, phase, rank, first_reserved_at, first_rank) values ('2027-01-05', 'featured-ai-v1', $1, 88, 'RESERVED', $2, now(), $2)`, [id, rank]);
  }
}, 60_000);

afterAll(async () => {
  vi.useRealTimers();
  await db?.close();
});

const phases = async () =>
  Object.fromEntries((await q<{ fixture_id: string; phase: string; rank: number | null }>(`select fixture_id, phase, rank from featured_selections order by fixture_id`)).map((r) => [Number(r.fixture_id), [r.phase, r.rank]]));

describe('featured-ai-v1 frozen', () => {
  it('locks at kick-off as the rows stand, adds nothing', async () => {
    vi.setSystemTime(thai('2027-01-05T22:05'));
    await featuredJob(ctx, { config: FEATURED_AI_V1, freeze: true });
    expect(await phases()).toEqual({ 701: ['CONFIRMED', 1], 702: ['RESERVED', 2], 703: ['DROPPED', null], 705: ['RESERVED', 3] });
  });

  it('after 06:00 it still locks the last matches of yesterday\'s football day', async () => {
    vi.setSystemTime(thai('2027-01-06T05:40'));
    await featuredJob(ctx, { config: FEATURED_AI_V1, freeze: true });
    vi.setSystemTime(thai('2027-01-06T06:05'));
    await featuredJob(ctx, { config: FEATURED_AI_V1, freeze: true });
    expect(await phases()).toEqual({ 701: ['CONFIRMED', 1], 702: ['CONFIRMED', 2], 703: ['DROPPED', null], 705: ['CONFIRMED', 3] });
  });
});
