/**
 * E2E: published analyses in Postgres (PGlite, all migrations + triggers) -> Settlement Engine.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repository, type JobContext } from '@fp/database';
import { ApiFootball, ApiFootballClient } from '@fp/football';
import { createLogger, type Env } from '@fp/shared';
import { createTestDb } from '../../../packages/database/test/helpers.js';
import { settleJob } from '../src/settle-job.js';

let db: Awaited<ReturnType<typeof createTestDb>>;
let ctx: JobContext;
const KO = new Date(Date.now() + 2 * 3_600_000);
const afterKo = (h: number) => new Date(KO.getTime() + h * 3_600_000);

const one = async (sql: string) => (await db.query<Record<string, unknown>>(sql)).rows[0]!;
const status = async (fixtureId: number, round = 'EARLY') =>
  one(`select status, result_score, settled_at, closing_odds, clv from analysis_predictions where fixture_id = ${fixtureId} and publish_round = '${round}'`);

beforeAll(async () => {
  db = await createTestDb();
  const repo = new Repository(db);
  const client = new ApiFootballClient({ apiKey: 'test', fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch });
  const env: Env = {
    API_FOOTBALL_KEY: 'test',
    API_FOOTBALL_BASE_URL: 'https://v3.football.api-sports.io',
    API_FOOTBALL_RPM: 1000,
    DATABASE_URL: 'pglite',
    TRACKED_LEAGUES: [39],
    SEASON: 2026,
    ODDS_MARKETS: ['MATCH_WINNER', 'ASIAN_HANDICAP', 'OVER_UNDER'],
    ODDS_BOOKMAKERS: [],
    LOG_LEVEL: 'error',
  };
  ctx = { env, db, repo, client, api: new ApiFootball(client), log: createLogger('error') };

  await db.query(`insert into leagues (id, name) values (39, 'Premier League')`);
  await db.query(`insert into teams (id, name) values (1, 'Home FC'), (2, 'Away FC')`);
  // 101 AH away +0.75 · 102 O/U · 103 cancelled · 104 postponed · 105 still playing · 106 no clear signal
  await db.query(`insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short)
                  select g, 39, 2026, $1, 1, 2, 'NS' from generate_series(101, 106) g`, [KO.toISOString()]);
  await db.query(`insert into bookmakers (id, name) values (1, 'A'), (2, 'B'), (3, 'C')`);
  // closing odds for the AH selection from 3 books (last quote before kickoff wins), 1 book after kickoff ignored
  await db.query(
    `insert into odds_history (fixture_id, bookmaker_id, market, api_bet_id, api_bet_name, selection, line, home_line, raw_value, odds, source_updated_at)
     values (101, 1, 'ASIAN_HANDICAP', 4, 'Asian Handicap', 'AWAY', 0.75, -0.75, 'Away -0.75', 2.10, $1),
            (101, 1, 'ASIAN_HANDICAP', 4, 'Asian Handicap', 'AWAY', 0.75, -0.75, 'Away -0.75', 1.90, $2),
            (101, 2, 'ASIAN_HANDICAP', 4, 'Asian Handicap', 'AWAY', 0.75, -0.75, 'Away -0.75', 1.95, $2),
            (101, 3, 'ASIAN_HANDICAP', 4, 'Asian Handicap', 'AWAY', 0.75, -0.75, 'Away -0.75', 2.00, $2),
            (101, 3, 'ASIAN_HANDICAP', 4, 'Asian Handicap', 'AWAY', 0.75, -0.75, 'Away -0.75', 3.50, $3)`,
    [afterKo(-5).toISOString(), afterKo(-0.5).toISOString(), afterKo(0.5).toISOString()],
  );

  const pub = (fixture: number, market: string, selection: string, line: number | null, odds: number) =>
    db.query(
      `insert into analysis_predictions (fixture_id, publish_round, kind, market, selection, line, odds_at_publish, model_probability, signal_strength)
       values ($1, 'EARLY', 'SIGNAL', $2, $3, $4, $5, 0.55, 'MEDIUM')`,
      [fixture, market, selection, line, odds],
    );
  await pub(101, 'ASIAN_HANDICAP', 'AWAY', 0.75, 2.1);
  await pub(102, 'OVER_UNDER', 'UNDER', 2.5, 1.9);
  await pub(103, 'MATCH_WINNER', 'HOME', null, 2.0);
  await pub(104, 'MATCH_WINNER', 'AWAY', null, 3.0);
  await pub(105, 'MATCH_WINNER', 'DRAW', null, 3.4);
  await db.query(`insert into analysis_predictions (fixture_id, publish_round, kind) values (106, 'EARLY', 'NO_CLEAR_SIGNAL')`);

  // results come in (ET goals must not count: 101 is 1-0 after 90', 2-0 after extra time)
  await db.query(`update fixtures set status_short = 'AET', ft_home = 1, ft_away = 0, goals_home = 2, goals_away = 0 where id = 101`);
  await db.query(`update fixtures set status_short = 'FT', ft_home = 0, ft_away = 0, goals_home = 0, goals_away = 0 where id = 102`);
  await db.query(`update fixtures set status_short = 'CANC' where id = 103`);
  await db.query(`update fixtures set status_short = 'PST' where id = 104`);
  await db.query(`update fixtures set status_short = '2H', goals_home = 0, goals_away = 0 where id = 105`);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('settleJob', () => {
  it('settles finished matches on the 90-minute score with closing odds + CLV', async () => {
    await settleJob(ctx, { now: afterKo(3) });
    const ah = await status(101);
    expect(ah.status).toBe('HALF_LOSS'); // away +0.75 at 0-1 down
    expect(ah.result_score).toBe('1-0');
    expect(ah.settled_at).not.toBeNull();
    expect(Number(ah.closing_odds)).toBe(1.95); // median of 1.90 / 1.95 / 2.00 — post-kickoff quote ignored
    expect(Number(ah.clv)).toBeCloseTo(2.1 / 1.95 - 1, 4);

    const ou = await status(102);
    expect(ou.status).toBe('WIN');
    expect(ou.closing_odds).toBeNull(); // no odds stored -> no CLV, still settled
  });

  it('voids cancelled matches, waits on live and postponed ones', async () => {
    expect((await status(103)).status).toBe('VOID');
    expect((await status(103)).result_score).toBe('CANC');
    expect((await status(104)).status).toBe('PENDING');
    expect((await status(105)).status).toBe('PENDING');
    expect((await status(106)).status).toBe('NO_SIGNAL');
  });

  it('voids a postponed match only once fresh data confirms it was not played within 48h', async () => {
    await settleJob(ctx, { now: afterKo(50) }); // fixture row last synced before the deadline -> still waits
    expect((await status(104)).status).toBe('PENDING');
    await db.query(`update fixtures set synced_at = $1 where id = 104`, [afterKo(49).toISOString()]);
    await settleJob(ctx, { now: afterKo(50) });
    const r = await status(104);
    expect(r.status).toBe('VOID');
    expect(r.result_score).toBe('NOT_PLAYED_PST');
  });

  it('settles exactly once: re-running changes nothing and the DB rejects a second settlement', async () => {
    const before = await status(101);
    await db.query(`update fixtures set ft_home = 0, ft_away = 3 where id = 101`); // a late score "correction"
    await settleJob(ctx, { now: afterKo(60) });
    expect(await status(101)).toEqual(before);
    await expect(db.query(`update analysis_predictions set status = 'WIN' where fixture_id = 101`)).rejects.toThrow(/already settled/);
  });

  it('performance view and hash chain stay consistent', async () => {
    const all = await one(`select * from analysis_performance where dimension = 'all'`);
    expect(Number(all.total_signals)).toBe(5);
    expect(Number(all.no_signal)).toBe(1);
    expect(Number(all.win)).toBe(1);
    expect(Number(all.half_loss)).toBe(1);
    expect(Number(all.void)).toBe(2);
    expect(Number(all.pending)).toBe(1);
    const chain = await one(`select bool_and(ok) as ok from fp_verify_prediction_chain()`);
    expect(chain.ok).toBe(true);
  });
});
