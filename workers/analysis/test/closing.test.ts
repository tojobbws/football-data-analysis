/**
 * E2E: odds snapshots + a pre-kickoff candidates run in Postgres (PGlite) -> closing market.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repository, type JobContext } from '@fp/database';
import { ApiFootball, ApiFootballClient } from '@fp/football';
import { createLogger, type Env } from '@fp/shared';
import { createTestDb } from '../../../packages/database/test/helpers.js';
import { closingJob } from '../src/closing-job.js';
import { shadowReport } from '../src/shadow-report-job.js';

let db: Awaited<ReturnType<typeof createTestDb>>;
let ctx: JobContext;
const KO = new Date(Date.now() - 2 * 3_600_000);
const at = (h: number) => new Date(KO.getTime() + h * 3_600_000).toISOString();

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
  // 201 has odds · 202 has no odds
  await db.query(`insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short)
                  select g, 39, 2026, $1, 1, 2, '2H' from generate_series(201, 202) g`, [KO.toISOString()]);
  await db.query(`insert into bookmakers (id, name) values (1, 'A'), (2, 'B')`);

  const odds = (bk: number, market: string, bet: number, sel: string, line: number | null, home: number | null, raw: string, o: number, t: string) =>
    db.query(
      `insert into odds_history (fixture_id, bookmaker_id, market, api_bet_id, api_bet_name, selection, line, home_line, raw_value, odds, source_updated_at)
       values (201, $1, $2, $3, 'x', $4, $5, $6, $7, $8, $9)`,
      [bk, market, bet, sel, line, home, raw, o, t],
    );
  for (const bk of [1, 2]) {
    await odds(bk, 'MATCH_WINNER', 1, 'HOME', null, null, 'Home', 2.0, at(-1));
    await odds(bk, 'MATCH_WINNER', 1, 'DRAW', null, null, 'Draw', 3.5, at(-1));
    await odds(bk, 'MATCH_WINNER', 1, 'AWAY', null, null, 'Away', 4.0, at(-1));
    // main line -0.5 at evens; -1 further off; a post-kickoff quote must be ignored
    await odds(bk, 'ASIAN_HANDICAP', 4, 'HOME', -0.5, -0.5, 'Home -0.5', 1.95, at(-1));
    await odds(bk, 'ASIAN_HANDICAP', 4, 'AWAY', 0.5, -0.5, 'Away -0.5', 1.95, at(-1));
    await odds(bk, 'ASIAN_HANDICAP', 4, 'HOME', -0.5, -0.5, 'Home -0.5', 1.5, at(0.5));
    await odds(bk, 'ASIAN_HANDICAP', 4, 'HOME', -1, -1, 'Home -1', 2.6, at(-1));
    await odds(bk, 'ASIAN_HANDICAP', 4, 'AWAY', 1, -1, 'Away -1', 1.5, at(-1));
    await odds(bk, 'OVER_UNDER', 5, 'OVER', 2.5, null, 'Over 2.5', 1.9, at(-1));
    await odds(bk, 'OVER_UNDER', 5, 'UNDER', 2.5, null, 'Under 2.5', 2.0, at(-1));
  }

  const run = async (startedAt: string, p: number) => {
    const { rows } = await db.query<{ id: string }>(
      `insert into analysis_runs (fixture_id, outcome, started_at) values (201, 'NO_CLEAR_SIGNAL', $1) returning id`,
      [startedAt],
    );
    await db.query(
      `insert into analysis_candidates (run_id, fixture_id, market, selection, line, model_probability, market_probability)
       values ($1, 201, 'ASIAN_HANDICAP', 'AWAY', 0.5, $2, 0.5)`,
      [rows[0]!.id, p],
    );
  };
  await run(at(-3), 0.55);
  await run(at(-1.5), 0.58); // last run before kickoff
  await run(at(1), 0.9); // after kickoff: ignored
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('closing market', () => {
  it('keeps the 1X2 and the main AH and O/U line, with the last pre-kickoff model probability', async () => {
    expect(await closingJob(ctx)).toBe(7);
    const rows = (
      await db.query<Record<string, unknown>>(`select market, selection, line, bookmakers, median_odds, market_probability, model_probability from market_closing where fixture_id = 201`)
    ).rows;
    expect(rows.map((r) => `${r.market}|${r.selection}|${r.line == null ? '' : Number(r.line)}`).sort()).toEqual([
      'ASIAN_HANDICAP|AWAY|0.5',
      'ASIAN_HANDICAP|HOME|-0.5',
      'MATCH_WINNER|AWAY|',
      'MATCH_WINNER|DRAW|',
      'MATCH_WINNER|HOME|',
      'OVER_UNDER|OVER|2.5',
      'OVER_UNDER|UNDER|2.5',
    ]);
    const away = rows.find((r) => r.market === 'ASIAN_HANDICAP' && r.selection === 'AWAY')!;
    expect(Number(away.median_odds)).toBe(1.95);
    expect(Number(away.market_probability)).toBe(0.5);
    expect(Number(away.bookmakers)).toBe(2);
    expect(Number(away.model_probability)).toBe(0.58);
    expect(rows.find((r) => r.market === 'OVER_UNDER' && r.selection === 'OVER')!.model_probability).toBeNull();
  });

  it('is written once: a second run adds nothing', async () => {
    expect(await closingJob(ctx)).toBe(0);
    expect(Number((await db.query<{ n: string }>(`select count(*) n from market_closing`)).rows[0]!.n)).toBe(7);
  });
});

describe('shadow trial', () => {
  const shadow = (fixture: number, round: string, sel: string | null, line: number | null, odds: number | null = null) =>
    db.query(
      `insert into shadow_decisions (fixture_id, rules_version, publish_round, locked_at, evaluated_at, outcome, market, selection, line, odds, passed)
       values ($1, 'shadow-test', $2, now(), $3, $4, $5, $6, $7, $8, 1)`,
      [fixture, round, at(-1), sel ? 'SIGNAL' : 'NO_CLEAR_SIGNAL', sel ? 'ASIAN_HANDICAP' : null, sel, line, odds],
    );

  it('a locked shadow pick is immutable except for filling in closing odds and CLV once', async () => {
    await shadow(201, 'LINEUP', 'HOME', -0.5, 2.0);
    await expect(db.query(`update shadow_decisions set selection = 'AWAY' where fixture_id = 201 and publish_round = 'LINEUP'`)).rejects.toThrow(/immutable/);
    await expect(db.query(`delete from shadow_decisions where fixture_id = 201 and publish_round = 'LINEUP'`)).rejects.toThrow(/immutable/);
    // closing job: median of the last pre-kickoff quotes for Home -0.5 is 1.95 -> clv 2.0/1.95 - 1
    await closingJob(ctx);
    const row = (await db.query<Record<string, unknown>>(`select closing_odds, clv from shadow_decisions where fixture_id = 201 and publish_round = 'LINEUP'`)).rows[0]!;
    expect(Number(row.closing_odds)).toBe(1.95);
    expect(Number(row.clv)).toBeCloseTo(2.0 / 1.95 - 1, 4);
    await expect(db.query(`update shadow_decisions set clv = 0.5 where fixture_id = 201 and publish_round = 'LINEUP'`)).rejects.toThrow(/immutable/);
  });

  it('reports sides, results and CLV by round and keeps collecting below the minimum', async () => {
    await db.query(`update fixtures set status_short = 'FT', ft_home = 1, ft_away = 1 where id = 202`);
    await shadow(202, 'LINEUP', 'AWAY', 0.5); // 1-1 -> away +0.5 wins
    await shadow(202, 'EARLY', null, null);
    const r = await shadowReport(ctx, { rulesVersion: 'shadow-test' });
    const lineup = r.rounds.find((x) => x.round === 'LINEUP')!;
    expect(lineup.shadow).toMatchObject({ picks: 2, settled: 1, fairHitRate: 1, clvN: 1, sides: { 'AH ต่อ': 1, 'AH รอง': 1 } });
    expect(r.rounds.find((x) => x.round === 'EARLY')!.shadow.picks).toBe(0);
    expect(r.noClearSignal).toBe(0);
    expect(r.verdict).toBe('COLLECTING');
  });
});
