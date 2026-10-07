/**
 * E2E: published analysis + snapshot (PGlite, all migrations) -> AI shadow job (fake ranker) -> settle.
 * The real Claude client is never called here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RankerResult, ShadowRanker } from '@fp/ai';
import { Repository, type JobContext } from '@fp/database';
import { ApiFootball, ApiFootballClient } from '@fp/football';
import { createLogger, type Env } from '@fp/shared';
import { createTestDb } from '../../../packages/database/test/helpers.js';
import { aiShadowJob } from '../src/ai-shadow-job.js';
import { settleJob } from '../src/settle-job.js';

let db: Awaited<ReturnType<typeof createTestDb>>;
let ctx: JobContext;
const KO = new Date(Date.now() + 3 * 3_600_000);
const one = async (sql: string) => (await db.query<Record<string, unknown>>(sql)).rows[0]!;

const candidates = [
  { market: 'ASIAN_HANDICAP', selection: 'AWAY', line: 0.75, odds: 1.95, model: 0.634, market_p: 0.55, edge: 0.084, rank: 1, reasons: [] },
  { market: 'OVER_UNDER', selection: 'UNDER', line: 2.5, odds: 2.05, model: 0.5, market_p: 0.48, edge: 0.02, rank: null, reasons: ['EDGE_TOO_SMALL'] },
];

/** fake AI: answers per fixture id found in the input's home team name */
function fakeRanker(answers: Record<string, Partial<RankerResult> & { output?: unknown }>): ShadowRanker & { calls: number } {
  const r = {
    calls: 0,
    async rank(input: Record<string, unknown>): Promise<RankerResult> {
      r.calls++;
      const home = (input.fixture as { home: string }).home;
      const a = answers[home];
      if (!a) throw new Error('API down');
      return { output: null, model: 'claude-opus-5-5', stopReason: 'end_turn', refusal: null, usage: { input_tokens: 1000, output_tokens: 300 }, ...a };
    },
  };
  return r;
}

const answer = (top: number, extra: Record<string, unknown> = {}) => ({
  output: {
    data_issues: [],
    conflicts_th: [],
    ranking: [
      { candidate_index: top, support: 'HIGH', reason_th: 'ข้อมูลสนับสนุน' },
      { candidate_index: 1 - top, support: 'LOW', reason_th: 'ไม่ชัด' },
    ],
    no_clear_signal: false,
    top_pick_index: top,
    explanation_th: 'โมเดลให้ 63% ส่วนตลาดให้ 55%',
    ...extra,
  },
});

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
    ANTHROPIC_API_KEY: undefined,
  };
  ctx = { env, db, repo, client, api: new ApiFootball(client), log: createLogger('error') };

  await db.query(`insert into leagues (id, name) values (39, 'Premier League')`);
  // fixture 201..205, home team name = 'H' || id so the fake AI can answer per fixture
  await db.query(`insert into teams (id, name) select g, 'H' || g from generate_series(201, 205) g`);
  await db.query(`insert into teams (id, name) values (999, 'Away FC')`);
  await db.query(`insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short)
                  select g, 39, 2026, $1, g, 999, 'NS' from generate_series(201, 205) g`, [KO.toISOString()]);
  for (let id = 201; id <= 205; id++) {
    const signal = id !== 202;
    const p = await db.query<{ id: number }>(
      signal
        ? `insert into analysis_predictions (fixture_id, publish_round, kind, market, selection, line, odds_at_publish, model_probability, signal_strength)
           values (${id}, 'EARLY', 'SIGNAL', 'ASIAN_HANDICAP', 'AWAY', 0.75, 1.95, 0.634, 'MEDIUM') returning id`
        : `insert into analysis_predictions (fixture_id, publish_round, kind) values (${id}, 'EARLY', 'NO_CLEAR_SIGNAL') returning id`,
    );
    await db.query(
      `insert into analysis_snapshots (analysis_prediction_id, form_snapshot, xg_snapshot, injury_snapshot, lineup_snapshot, api_prediction_snapshot, model_snapshot, candidates_snapshot)
       values ($1, $2, null, '[]', '[]', null, $3, $4)`,
      [p.rows[0]!.id, JSON.stringify({ home: [], away: [] }), JSON.stringify({ modelSource: 'DC', prices: [] }), JSON.stringify(id === 205 ? [] : candidates)],
    );
  }
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('aiShadowJob', () => {
  it('skips cleanly without an API key', async () => {
    expect(await aiShadowJob(ctx)).toBe(0);
    expect(Number((await one(`select count(*) n from ai_shadow_rankings`)).n)).toBe(0);
  });

  it('stores the AI ranking before kickoff, never touching the published record', async () => {
    const before = await one(`select record_hash, status from analysis_predictions where fixture_id = 201`);
    const ranker = fakeRanker({
      H201: answer(0), // agrees with the rules pick
      H202: answer(1), // rules said 🌫️, AI picks Under 2.5
      H203: answer(0, { explanation_th: 'โอกาส 72% แน่นอน' }), // invented number -> INVALID
      H204: { output: null, stopReason: 'refusal', refusal: { category: 'general_harms', explanation: null } },
      // H205 has no candidates -> no call
    });
    expect(await aiShadowJob(ctx, { ranker })).toBe(4);
    expect(ranker.calls).toBe(4);

    const a = await one(`select status, pick_market, pick_selection, pick_line, pick_odds, agrees_with_rules, no_clear_signal, prompt_version, ranking from ai_shadow_rankings where fixture_id = 201`);
    expect(a).toMatchObject({ status: 'OK', pick_market: 'ASIAN_HANDICAP', pick_selection: 'AWAY', agrees_with_rules: true, no_clear_signal: false, prompt_version: 'ai-shadow-v0.1' });
    expect(Number(a.pick_line)).toBe(0.75);
    expect(Number(a.pick_odds)).toBe(1.95);
    expect((a.ranking as Array<{ label: string }>)[0]!.label).toBe('Away FC +0.75');

    expect(await one(`select status, pick_selection, agrees_with_rules from ai_shadow_rankings where fixture_id = 202`)).toMatchObject({ status: 'OK', pick_selection: 'UNDER', agrees_with_rules: false });
    const bad = await one(`select status, pick_market, guard_violations from ai_shadow_rankings where fixture_id = 203`);
    expect(bad.status).toBe('INVALID');
    expect(bad.pick_market).toBeNull();
    expect(bad.guard_violations).toEqual(['number not in input: 72%']);
    expect((await one(`select status from ai_shadow_rankings where fixture_id = 204`)).status).toBe('REFUSED');

    expect(await one(`select record_hash, status from analysis_predictions where fixture_id = 201`)).toEqual(before);
  });

  it('ranks each analysis once; an API error is retried on the next run', async () => {
    const down = fakeRanker({});
    await aiShadowJob(ctx, { ranker: down });
    expect(down.calls).toBe(0); // 201-204 done, 205 has no candidates
  });

  it('is immutable and refuses rows after kickoff', async () => {
    await expect(db.query(`update ai_shadow_rankings set explanation_th = 'x' where fixture_id = 201`)).rejects.toThrow(/immutable/);
    await expect(db.query(`delete from ai_shadow_rankings where fixture_id = 201`)).rejects.toThrow();
    await db.query(`update fixtures set kickoff_at = now() - interval '1 hour' where id = 205`);
    const pid = (await one(`select id from analysis_predictions where fixture_id = 205`)).id;
    // prediction kickoff_at is copied at publish; simulate a late write directly
    await db.query(`alter table analysis_predictions disable trigger analysis_predictions_update`);
    await db.query(`update analysis_predictions set kickoff_at = now() - interval '1 hour' where id = $1`, [pid]);
    await db.query(`alter table analysis_predictions enable trigger analysis_predictions_update`);
    await expect(
      db.query(`insert into ai_shadow_rankings (analysis_prediction_id, fixture_id, kickoff_at, model, prompt_version, status, input) values ($1, 205, now(), 'm', 'v', 'OK', '{}')`, [pid]),
    ).rejects.toThrow(/before kickoff/);
  });

  it('settles the AI pick with the same rules and compares rules vs AI', async () => {
    await db.query(`update fixtures set status_short = 'FT', ft_home = 1, ft_away = 0, goals_home = 1, goals_away = 0 where id in (201, 202)`);
    await settleJob(ctx, { now: new Date(KO.getTime() + 3 * 3_600_000) });
    expect((await one(`select ai_status, ai_result_score from ai_shadow_rankings where fixture_id = 201`))).toMatchObject({ ai_status: 'HALF_LOSS', ai_result_score: '1-0' });
    expect((await one(`select ai_status from ai_shadow_rankings where fixture_id = 202`)).ai_status).toBe('WIN'); // Under 2.5 at 1-0
    expect((await one(`select status from analysis_predictions where fixture_id = 201`)).status).toBe('HALF_LOSS');
    await expect(db.query(`update ai_shadow_rankings set ai_status = 'WIN' where fixture_id = 201`)).rejects.toThrow(/already settled/);

    const rows = (await db.query<Record<string, unknown>>(`select * from ai_shadow_comparison order by source`)).rows;
    const ai = rows.find((r) => r.source === 'AI')!;
    const rules = rows.find((r) => r.source === 'RULES')!;
    expect(Number(ai.fixtures_compared)).toBe(2); // only status OK rows
    expect(Number(ai.agreement_rate)).toBe(0.5);
    expect(Number(ai.win)).toBe(1);
    expect(Number(ai.half_loss)).toBe(1);
    expect(Number(rules.signals)).toBe(1);
    expect(Number(rules.half_loss)).toBe(1);
  });
});
