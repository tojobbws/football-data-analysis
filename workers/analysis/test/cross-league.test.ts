/**
 * E2E: a cross-league cup (CROSS_LEAGUE_CUPS: 1129 <- domestic 296, 278, ...) gets its sides blended with
 * the cross-league model; an ordinary league does not.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repository, type JobContext } from '@fp/database';
import { ApiFootball, ApiFootballClient } from '@fp/football';
import { createLogger, type Env } from '@fp/shared';
import { createTestDb } from '../../../packages/database/test/helpers.js';
import { computeProbabilities } from '../src/jobs.js';

let db: Awaited<ReturnType<typeof createTestDb>>;
let ctx: JobContext;
const NOW = new Date();

beforeAll(async () => {
  db = await createTestDb();
  const repo = new Repository(db);
  const client = new ApiFootballClient({ apiKey: 'test', fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch });
  const env: Env = {
    API_FOOTBALL_KEY: 'test',
    API_FOOTBALL_BASE_URL: 'https://v3.football.api-sports.io',
    API_FOOTBALL_RPM: 1000,
    DATABASE_URL: 'pglite',
    TRACKED_LEAGUES: [1129, 296],
    SEASON: 2026,
    ODDS_MARKETS: [],
    ODDS_BOOKMAKERS: [],
    LOG_LEVEL: 'error',
  };
  ctx = { env, db, repo, client, api: new ApiFootball(client), log: createLogger('error') };

  await db.query(`insert into leagues (id, name) values (1129, 'ASEAN Club Championship'), (296, 'Thai League 1'), (278, 'Super League')`);
  // 296: teams 1..6, 278: teams 11..16
  await db.query(`insert into teams (id, name) select g, 'Team ' || g from generate_series(1, 16) g`);
  const rows: string[] = [];
  let id = 1;
  let t = NOW.getTime() - 300 * 86_400_000;
  const push = (league: number, h: number, a: number, gh: number, ga: number) => {
    rows.push(`(${id++}, ${league}, 2026, to_timestamp(${t / 1000}), ${h}, ${a}, 'FT', ${gh}, ${ga}, ${gh}, ${ga})`);
    t += 6 * 3_600_000;
  };
  for (const [league, base] of [[296, 0], [278, 10]] as const)
    for (let rep = 0; rep < 2; rep++)
      for (let h = 1; h <= 6; h++) for (let a = 1; a <= 6; a++) if (h !== a) push(league, base + h, base + a, (7 - h) % 3 + 1, (7 - a) % 2);
  // cup: Thai sides (296) beat Malaysian sides (278) clearly, 36 matches
  for (let i = 0; i < 36; i++) {
    const th = (i % 6) + 1;
    const my = ((i * 5) % 6) + 11;
    if (i % 2) push(1129, th, my, 3, 0);
    else push(1129, my, th, 0, 2);
  }
  await db.query(
    `insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short, goals_home, goals_away, ft_home, ft_away) values ${rows.join(',')}`,
  );
  await db.query(`insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short)
                  values (9101, 1129, 2026, now() + interval '1 day', 13, 3, 'NS'),
                         (9102, 296, 2026, now() + interval '1 day', 2, 4, 'NS')`);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

const one = async (sql: string) => (await db.query<Record<string, unknown>>(sql)).rows[0]!;

describe('computeProbabilities with a cross-league cup', () => {
  it('blends the cross-league model into the cup sides and records it', async () => {
    await computeProbabilities(ctx, { now: NOW });
    const row = await one(`select inputs from probability_predictions
                            where fixture_id = 9101 and market = 'MATCH_WINNER' and selection = 'HOME' and inputs ? 'lambda'`);
    const inputs = row.inputs as Record<string, any>;
    expect(inputs.crossLeague).toMatchObject({ version: 'cross-league-v0.1', weightCupOnly: 0.5, homeLeague: 278, awayLeague: 296, cupMatchesUsed: 36 });
    // the cup says Thai League sides are stronger -> the away (Thai) side is the cross-league favourite
    expect(inputs.crossLeague.mu).toBeGreaterThan(inputs.crossLeague.lambda);
    expect(inputs.crossLeague.leagueAttack['296']).toBeGreaterThan(inputs.crossLeague.leagueAttack['278']);
  });

  it('leaves ordinary leagues untouched', async () => {
    const row = await one(`select inputs from probability_predictions
                            where fixture_id = 9102 and market = 'MATCH_WINNER' and selection = 'HOME' and inputs ? 'lambda'`);
    expect((row.inputs as Record<string, unknown>).crossLeague).toBeUndefined();
  });
});
