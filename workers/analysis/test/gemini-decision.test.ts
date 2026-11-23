/**
 * E2E: stored DAILY Hybrid AI inputs (PGlite, all migrations) -> gemini-decision job (fake decider) -> decisions_shadow.
 * The real Gemini API is never called here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GeminiApiError, isPersistentApiError, type HybridDecider, type RankerResult } from '@fp/ai';
import { Repository, type JobContext } from '@fp/database';
import { ApiFootball, ApiFootballClient } from '@fp/football';
import { createLogger, type Env } from '@fp/shared';
import { createTestDb } from '../../../packages/database/test/helpers.js';
import { geminiDecisionConfig, geminiDecisionJob } from '../src/gemini-decision-job.js';

let db: Awaited<ReturnType<typeof createTestDb>>;
let ctx: JobContext;
const KO = new Date(Date.now() + 3 * 3_600_000);
const CONFIG = geminiDecisionConfig('gemini-3.8-flash');
const q = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<R>(sql, params)).rows;

const answer = (over: Record<string, unknown> = {}) => ({
  team_assessment_th: 'ทีมเยือนฟอร์มดีกว่า',
  match_outlook_th: 'เกมน่าจะสูสี',
  market_comparison_th: 'ตลาดให้ทีมเหย้าต่อเล็กน้อย',
  options_review: [{ option: 'UNDERDOG', supporting_evidence: ['ทีมเยือนฟอร์มดีกว่า'], counter_evidence: ['ทีมเหย้าได้เล่นในบ้าน'], assessment: 'MODERATE' }],
  market: 'AH',
  side: 'UNDERDOG',
  main_line: 0.25,
  confidence: 'MEDIUM',
  supporting_evidence: ['ทีมเยือนฟอร์มดีกว่า'],
  counter_evidence: ['ทีมเหย้าได้เล่นในบ้าน'],
  risk_factors: ['ยังไม่มีรายชื่อตัวจริง'],
  missing_data: [],
  summary_th: 'ทีมเยือนมีภาษีดีกว่าที่ราคาสะท้อน',
  ...over,
});

type Plan = { first: () => unknown; retried?: () => unknown } | 'throw' | 'persistent';

function fakeDecider(plans: Record<string, Plan>): HybridDecider & { calls: string[] } {
  const res = (output: unknown): RankerResult => ({ output, model: 'gemini-3.8-flash', stopReason: 'STOP', refusal: null, usage: { promptTokenCount: 18000, candidatesTokenCount: 2000 } });
  const plan = (input: Record<string, unknown>) => {
    const home = (input.match as { home: string }).home;
    d.calls.push(home);
    const p = plans[home];
    if (!p || p === 'throw') throw new Error('Gemini 503 UNAVAILABLE: overloaded');
    if (p === 'persistent') throw new GeminiApiError(429, 'RESOURCE_EXHAUSTED', 'Your prepayment credits are depleted');
    return p;
  };
  const d = {
    calls: [] as string[],
    async decide(input: Record<string, unknown>) {
      const p = plan(input) as Exclude<Plan, string>;
      return res(p.first());
    },
    async retry(input: Record<string, unknown>) {
      const p = plan(input) as Exclude<Plan, string>;
      return res((p.retried ?? p.first)());
    },
  };
  return d;
}

function input(home: string) {
  return {
    match: { home, away: 'Away FC', competition: 'Premier League', kickoff_utc: KO.toISOString(), publish_round: 'DAILY' },
    market: {
      asian_handicap: {
        status: 'OK', favourite: home, home_line: -0.25, bookmakers: 6, price_age_hours: 1,
        options: [
          { option: 'FAVORITE', team_or_total: home, line: -0.25, odds_median: 1.95, market_probability_no_vig: 0.5 },
          { option: 'UNDERDOG', team_or_total: 'Away FC', line: 0.25, odds_median: 1.9, market_probability_no_vig: 0.5 },
        ],
      },
      over_under: {
        status: 'OK', line: 2.5, bookmakers: 6, price_age_hours: 1,
        options: [
          { option: 'OVER', team_or_total: 'OVER', line: 2.5, odds_median: 1.95, market_probability_no_vig: 0.5 },
          { option: 'UNDER', team_or_total: 'UNDER', line: 2.5, odds_median: 1.95, market_probability_no_vig: 0.5 },
        ],
      },
    },
    injuries: [],
    prediction_timestamp_utc: new Date().toISOString(),
  };
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
    TRACKED_LEAGUES: [39],
    SEASON: 2026,
    ODDS_MARKETS: ['MATCH_WINNER', 'ASIAN_HANDICAP', 'OVER_UNDER'],
    ODDS_BOOKMAKERS: [],
    LOG_LEVEL: 'error',
    ANTHROPIC_API_KEY: undefined,
  };
  ctx = { env, db, repo, client, api: new ApiFootball(client), log: createLogger('error') };

  await db.query(`insert into leagues (id, name) values (39, 'Premier League')`);
  await db.query(`insert into teams (id, name) select g, 'H' || g from generate_series(701, 707) g`);
  await db.query(`insert into teams (id, name) values (999, 'Away FC')`);
  await db.query(`insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short)
                  select g, 39, 2026, $1, g, 999, 'NS' from generate_series(701, 707) g`, [KO.toISOString()]);
  for (let id = 701; id <= 707; id++) {
    await db.query(
      `insert into hybrid_decisions (fixture_id, publish_round, engine_mode, engine_version, prompt_version, input, input_hash, status, side)
       values ($1, 'DAILY', 'hybrid', 'hybrid-ai-v1', $2, $3, $4, 'OK', 'NO_PICK')`,
      [id, id === 707 ? 'hybrid-ai-v2.0' : 'hybrid-ai-v2.1.1', JSON.stringify(input(`H${id}`)), `hash${id}`],
    );
  }
  // 706 kicks off in 2 minutes: too late to ask
  await db.query(`update fixtures set kickoff_at = now() + interval '2 minutes' where id = 706`);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('geminiDecisionJob', () => {
  it('does nothing while GEMINI_DECISION is unset', async () => {
    expect(await geminiDecisionJob(ctx)).toBe(0);
    expect(Number((await q(`select count(*) n from decisions_shadow`))[0]!.n)).toBe(0);
  });

  it('stores one answer per fixture before kickoff: OK with the snapshot option, INVALID after its retry, nothing on an API error', async () => {
    const d = fakeDecider({
      H701: { first: () => answer() },
      // a number that is not in the input, twice: INVALID, stored, never asked again
      H702: { first: () => answer({ summary_th: 'ทีมเยือนชนะ 99 นัด' }), retried: () => answer({ summary_th: 'ทีมเยือนชนะ 98 นัด' }) },
      // rejected, then fixed by the feedback retry
      H703: { first: () => answer({ summary_th: 'ทีมเยือนชนะ 99 นัด' }), retried: () => answer({ market: 'OU', side: 'OVER', main_line: 2.5, options_review: [{ option: 'OVER', supporting_evidence: ['ยิงกันเยอะ'], counter_evidence: ['เกมสูสี'], assessment: 'MODERATE' }] }) },
      H704: 'throw',
      H705: { first: () => answer({ side: 'NO_PICK', market: 'NONE', main_line: null, confidence: 'NONE' }) },
      H706: { first: () => answer() },
      H707: { first: () => answer() },
    });
    expect(await geminiDecisionJob(ctx, { decider: d })).toBe(4);
    // 706 too late, 707 not a v2.1.1 input
    expect(d.calls).not.toContain('H706');
    expect(d.calls).not.toContain('H707');

    const rows = await q<Record<string, any>>(`select fixture_id, hybrid_decision_id, input_hash, config, model, status, side, market, selection, line, odds, market_probability, response, usage from decisions_shadow order by fixture_id`);
    expect(rows.map((r) => [Number(r.fixture_id), r.status, r.side])).toEqual([
      [701, 'OK', 'UNDERDOG'],
      [702, 'INVALID', null],
      [703, 'OK', 'OVER'],
      [705, 'OK', 'NO_PICK'],
    ]);
    const ok = rows[0]!;
    expect(ok).toMatchObject({ config: CONFIG, model: 'gemini-3.8-flash', market: 'ASIAN_HANDICAP', selection: 'AWAY', input_hash: 'hash701' });
    expect([Number(ok.line), Number(ok.odds), Number(ok.market_probability)]).toEqual([0.25, 1.9, 0.5]);
    expect(ok.response).toMatchObject({ status: 'OK', attempts: 1, confidence: 'MEDIUM' });
    expect(ok.usage).toMatchObject({ promptTokenCount: 18000 });
    expect(rows[1]!.response).toMatchObject({ status: 'INVALID', attempts: 2, feedback_retries: 1 });
    expect(rows[2]!.response).toMatchObject({ attempts: 2, feedback_retries: 1 });
    expect(rows[3]!.market).toBeNull();
  });

  it('asks again next run only where no row was stored', async () => {
    const d = fakeDecider({ H704: { first: () => answer() } });
    expect(await geminiDecisionJob(ctx, { decider: d })).toBe(1);
    expect(d.calls).toEqual(['H704']);
  });

  it('treats no credit as persistent and a rate limit or overload as transient', async () => {
    const err = new GeminiApiError(429, 'RESOURCE_EXHAUSTED', 'Your prepayment credits are depleted');
    expect(isPersistentApiError(err)).toBe(true);
    expect(isPersistentApiError(new GeminiApiError(429, 'RESOURCE_EXHAUSTED', 'Too many requests, retry in 20s'))).toBe(false);
    expect(isPersistentApiError(new GeminiApiError(503, 'UNAVAILABLE', 'overloaded'))).toBe(false);
  });
});
