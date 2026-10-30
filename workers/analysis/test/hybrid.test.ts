/**
 * E2E (PGlite, all migrations): Hybrid AI engine (ADR 0010) — hybrid job with a fake decider, then publish.
 *  - legacy: the job does nothing; shadow: decisions stored, never published; hybrid: the valid decision published
 *    with its engine version and no model probability, a rules pick never in its place
 *  - fail-safe: invalid answers asked again then stored INVALID; API errors stored; nothing published for them
 *  - no duplicate decision or publication on a repeated run; nothing from after the decision time in the input
 *  - the DB keeps decisions append-only and before kickoff, and keeps the probability check for the rules
 * The real AI is never called here.
 */
import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HYBRID_PROMPT_VERSION, type HybridDecider, type RankerResult } from '@fp/ai';
import { Repository, type JobContext } from '@fp/database';
import { ApiFootball, ApiFootballClient } from '@fp/football';
import { createLogger, type Env } from '@fp/shared';
import { createTestDb } from '../../../packages/database/test/helpers.js';
import { hybridJob } from '../src/hybrid-job.js';
import { publishJob } from '../src/publish-job.js';

let db: Awaited<ReturnType<typeof createTestDb>>;
let ctx: JobContext;
const KO = new Date(Date.now() + 10 * 3_600_000); // inside the EARLY window (3–24 h)
const q = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<R>(sql, params)).rows;
const count = async (sql: string, params: unknown[] = []) => Number((await q<{ n: string }>(sql, params))[0]!.n);


const pick = (over: Record<string, unknown> = {}) => ({
  team_assessment_th: 'ทีมเหย้าฟอร์มดีกว่า',
  match_outlook_th: 'ทีมเหย้าน่าจะคุมเกม',
  market_comparison_th: 'ตลาดให้ทีมเหย้าต่อ',
  options_review: [{ option: 'UNDERDOG', supporting_evidence: ['ทีมเยือนเสียประตูน้อย'], counter_evidence: ['ทีมเหย้ายิงได้ทุกนัด'], assessment: 'MODERATE' }],
  market: 'AH',
  side: 'UNDERDOG',
  main_line: 0.75,
  confidence: 'MEDIUM',
  supporting_evidence: ['ทีมเยือนเสียประตูน้อยใน 6 นัด'],
  counter_evidence: ['ทีมเหย้ายิงได้ทุกนัด'],
  risk_factors: ['ยังไม่มีรายชื่อตัวจริง'],
  missing_data: [],
  summary_th: 'ทีมเยือนรับได้แน่นกว่าที่ราคาสะท้อน',
  ...over,
});

function fakeDecider(answers: Record<string, () => Partial<RankerResult> & { output?: unknown }>): HybridDecider & { calls: string[] } {
  const d = {
    calls: [] as string[],
    async decide(input: Record<string, unknown>): Promise<RankerResult> {
      const home = (input.match as { home: string }).home;
      d.calls.push(home);
      const a = answers[home];
      if (!a) throw new Error(`no answer for ${home}`);
      return { output: null, model: 'claude-sonnet-5-5', stopReason: 'end_turn', refusal: null, usage: { input_tokens: 2000, output_tokens: 500 }, ...a() };
    },
  };
  return d;
}

async function odds(fixture: number) {
  const t = new Date(Date.now() - 3_600_000).toISOString();
  for (const bk of [1, 2, 3])
    for (const [market, bet, sel, line, home, raw, o] of [
      ['ASIAN_HANDICAP', 4, 'HOME', -0.75, -0.75, 'Home -0.75', 1.95],
      ['ASIAN_HANDICAP', 4, 'AWAY', 0.75, -0.75, 'Away +0.75', 1.93],
      ['ASIAN_HANDICAP', 4, 'HOME', -1.5, -1.5, 'Home -1.5', 2.9],
      ['ASIAN_HANDICAP', 4, 'AWAY', 1.5, -1.5, 'Away +1.5', 1.4],
      ['OVER_UNDER', 5, 'OVER', 2.5, null, 'Over 2.5', 1.9],
      ['OVER_UNDER', 5, 'UNDER', 2.5, null, 'Under 2.5', 1.95],
      ['MATCH_WINNER', 1, 'HOME', null, null, 'Home', 1.8],
      ['MATCH_WINNER', 1, 'DRAW', null, null, 'Draw', 3.6],
      ['MATCH_WINNER', 1, 'AWAY', null, null, 'Away', 4.5],
    ] as const)
      await q(
        `insert into odds_history (fixture_id, bookmaker_id, market, api_bet_id, api_bet_name, selection, line, home_line, raw_value, odds, source_updated_at)
         values ($1, $2, $3, $4, 'x', $5, $6, $7, $8, $9, $10)`,
        [fixture, bk, market, bet, sel, line, home, raw, o, t],
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
    TRACKED_LEAGUES: [39],
    SEASON: 2026,
    ODDS_MARKETS: ['MATCH_WINNER', 'ASIAN_HANDICAP', 'OVER_UNDER'],
    ODDS_BOOKMAKERS: [],
    LOG_LEVEL: 'error',
  };
  ctx = { env, db, repo, client, api: new ApiFootball(client), log: createLogger('error') };

  await db.exec(`insert into leagues (id, name) values (39, 'Premier League');
                 insert into bookmakers (id, name) values (1, 'B1'), (2, 'B2'), (3, 'B3');
                 insert into teams (id, name) values (301, 'Good FC'), (302, 'NoOdds FC'), (303, 'Invalid FC'), (304, 'Down FC'), (305, 'Fog FC'), (999, 'Away FC'), (998, 'Other FC');`);
  await q(`insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short)
           select g, 39, 2026, $1, g, 999, 'NS' from generate_series(301, 305) g`, [KO.toISOString()]);
  // history: six finished matches of Good FC and of Away FC, one with xG and shots
  for (let i = 1; i <= 6; i++) {
    const at = new Date(Date.now() - i * 7 * 86_400_000).toISOString();
    await q(`insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short, goals_home, goals_away, ft_home, ft_away)
             values ($1, 39, 2026, $2, 301, 998, 'FT', 2, 1, 2, 1), ($3, 39, 2026, $2, 998, 999, 'FT', 1, 0, 1, 0)`, [4000 + i, at, 5000 + i]);
  }
  await q(`insert into fixture_statistics (fixture_id, team_id, type, value_num) values (4001, 301, 'expected_goals', 1.7), (4001, 998, 'expected_goals', 0.6), (4001, 301, 'shots_on_goal', 7), (4001, 998, 'shots_on_goal', 2)`);
  // a match that has not been played yet must never reach the input
  await q(`insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short) values (4999, 39, 2026, $1, 998, 301, 'NS')`, [new Date(Date.now() + 30 * 3_600_000).toISOString()]);
  // a postponed match of Good FC that falls before the real next one: it is not a next fixture
  await q(`insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short) values (4950, 39, 2026, $1, 301, 998, 'PST')`, [new Date(Date.now() + 20 * 3_600_000).toISOString()]);
  for (const f of [301, 303, 304, 305]) await odds(f);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

/** fixtures 301..305 play Away FC; the fake decider answers by the home team's name (302 has no odds, 304's AI is down) */
const answers = {
  'Good FC': () => ({ output: pick() }),
  // first answer on a line that is not the main line, the second with a banned word: never valid
  'Invalid FC': (() => {
    let n = 0;
    return () => ({ output: n++ === 0 ? pick({ main_line: 1.5 }) : pick({ summary_th: 'คู่นี้ทีเด็ด' }) });
  })(),
  'Fog FC': () => ({ output: pick({ market: 'NONE', side: 'NO_PICK', main_line: null, confidence: 'NONE', summary_th: 'หลักฐานยังไม่ชัดพอ' }) }),
};

describe('hybridJob', () => {
  it('does nothing while the engine is legacy', async () => {
    const d = fakeDecider(answers);
    expect(await hybridJob(ctx, { engine: 'legacy', decider: d })).toBe(0);
    expect(d.calls).toEqual([]);
    expect(await count('select count(*) n from hybrid_decisions')).toBe(0);
  });

  it('shadow: stores every decision as the AI saw and answered it, and publishes nothing from it', async () => {
    const d = fakeDecider(answers);
    expect(await hybridJob(ctx, { engine: 'shadow', decider: d })).toBe(5);
    // no market for 302: no AI call; 303 asked twice
    expect(d.calls.sort()).toEqual(['Down FC', 'Fog FC', 'Good FC', 'Invalid FC', 'Invalid FC']);
    const rows = await q<{ fixture_id: string; status: string; side: string | null; selection: string | null; line: string | null; odds: string | null; attempts: number; engine_mode: string; violations: string[] }>(
      `select fixture_id, status, side, selection, line, odds, attempts, engine_mode, violations from hybrid_decisions order by fixture_id`,
    );
    const by = Object.fromEntries(rows.map((r) => [Number(r.fixture_id), r]));
    expect(by[301]).toMatchObject({ status: 'OK', side: 'UNDERDOG', selection: 'AWAY', engine_mode: 'shadow', attempts: 1 });
    expect(Number(by[301]!.line)).toBe(0.75);
    expect(Number(by[301]!.odds)).toBe(1.93);
    expect(by[302]).toMatchObject({ status: 'OK', side: 'NO_PICK', attempts: 0 });
    expect(by[303]).toMatchObject({ status: 'INVALID', attempts: 2 });
    expect(by[303]!.violations.join(' ')).toMatch(/main_line 1.5 is not the UNDERDOG line 0.75.*banned word/);
    expect(by[304]).toMatchObject({ status: 'ERROR' });
    expect(by[305]).toMatchObject({ status: 'OK', side: 'NO_PICK' });

    // the input: Good FC's six played matches (newest first), the main lines, nothing after the decision time
    const [row] = await q<{ input: Record<string, any>; input_hash: string }>(`select input, input_hash from hybrid_decisions where fixture_id = 301`);
    expect(row!.input.home_team.last_10.matches).toBe(6);
    expect(row!.input.home_team.recent_matches.every((m: { date_utc: string }) => m.date_utc < new Date().toISOString().slice(0, 10))).toBe(true);
    expect(row!.input.home_team.recent_matches[0]).toMatchObject({ xg_for: 1.7, shots_on_target_for: 7, opponent: 'Other FC' });
    expect(row!.input.market.asian_handicap).toMatchObject({ status: 'OK', home_line: -0.75, favourite: 'Good FC', bookmakers: 3 });
    // next_match: Good FC's next stored fixture after this one is 4999 (not the postponed 4950); Away FC has none in the data
    expect(row!.input.home_team.next_match).toMatchObject({ competition: 'Premier League', venue: 'AWAY' });
    expect(row!.input.home_team.next_match.days_after_this_match).toBeCloseTo(0.8, 1);
    expect(row!.input.away_team.next_match).toBeNull();
    expect(row!.input.data_quality.missing).toContain('Away FC: no next fixture in the competitions we track');
    expect(row!.input.data_quality.next_match_scope).toContain('competitions we track only');
    expect(row!.input_hash).toMatch(/^[0-9a-f]{64}$/);

    // shadow mode: the rules engine still owns publishing (no rules run here, so nothing at all)
    await publishJob(ctx, { engine: 'shadow' });
    expect(await count('select count(*) n from analysis_predictions')).toBe(0);
  });

  it('a repeated run decides again only where no valid decision is fresh', async () => {
    const d = fakeDecider(answers);
    await hybridJob(ctx, { engine: 'shadow', decider: d });
    expect(d.calls.filter((c) => c === 'Good FC' || c === 'Fog FC')).toEqual([]);
    expect(await count(`select count(*) n from hybrid_decisions where fixture_id in (301, 302, 305)`)).toBe(3);
    expect(d.calls).toContain('Invalid FC');
  });

  it('hybrid: publishes the valid decision with its engine version, and nothing where there is none', async () => {
    await publishJob(ctx, { engine: 'hybrid' });
    const rows = await q<{ fixture_id: string; kind: string; market: string | null; selection: string | null; line: string | null; model_probability: string | null; market_probability: string | null; signal_strength: string | null; decision_rule_version: string; prompt_version: string; model_version_id: string; reason: string; odds_at_publish: string | null }>(
      `select fixture_id, kind, market, selection, line, model_probability, market_probability, signal_strength, decision_rule_version, prompt_version, model_version_id, reason, odds_at_publish
         from analysis_predictions order by fixture_id`,
    );
    expect(rows.map((r) => Number(r.fixture_id))).toEqual([301, 302, 305]);
    const [good, noOdds, fog] = rows;
    expect(good).toMatchObject({ kind: 'SIGNAL', market: 'ASIAN_HANDICAP', selection: 'AWAY', model_probability: null, signal_strength: 'MEDIUM', decision_rule_version: 'hybrid-ai-v1', prompt_version: HYBRID_PROMPT_VERSION, model_version_id: 'hybrid-ai-v1' });
    expect(Number(good!.line)).toBe(0.75);
    expect(Number(good!.odds_at_publish)).toBe(1.93);
    expect(Number(good!.market_probability)).toBeGreaterThan(0.49);
    expect(good!.reason).toContain('ทีมเยือนรับได้แน่นกว่าที่ราคาสะท้อน');
    expect(good!.reason).toContain('Hybrid AI');
    expect(noOdds).toMatchObject({ kind: 'NO_CLEAR_SIGNAL', decision_rule_version: 'hybrid-ai-v1' });
    expect(fog).toMatchObject({ kind: 'NO_CLEAR_SIGNAL' });

    const [snap] = await q<{ ai_reasoning: Record<string, unknown> }>(
      `select s.ai_reasoning from analysis_snapshots s join analysis_predictions p on p.id = s.analysis_prediction_id where p.fixture_id = 301`,
    );
    expect(snap!.ai_reasoning).toMatchObject({ engineVersion: 'hybrid-ai-v1', promptVersion: HYBRID_PROMPT_VERSION });
    expect(String(snap!.ai_reasoning.inputHash)).toMatch(/^[0-9a-f]{64}$/);

    // again: no duplicate publication, and the job has nothing left to decide for published rounds
    await publishJob(ctx, { engine: 'hybrid' });
    expect(await count('select count(*) n from analysis_predictions')).toBe(3);
  });

  it('stops calling the AI for the rest of the run on an error the next call would hit too', async () => {
    const before = await count('select count(*) n from hybrid_decisions');
    const calls: string[] = [];
    const broke: HybridDecider = {
      async decide(input) {
        calls.push((input.match as { home: string }).home);
        throw new Anthropic.BadRequestError(400, undefined, 'Your credit balance is too low', new Headers());
      },
    };
    await hybridJob(ctx, { engine: 'hybrid', decider: broke });
    expect(calls).toHaveLength(1);
    expect(await count('select count(*) n from hybrid_decisions')).toBe(before + 1);
  });
});

describe('hybrid_decisions and the record', () => {
  it('rejects a decision at or after kickoff and any change to a stored one', async () => {
    await q(`insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short) values (4998, 39, 2026, now() - interval '1 minute', 998, 999, '1H')`);
    await expect(q(`insert into hybrid_decisions (fixture_id, publish_round, engine_mode, engine_version, prompt_version, input, input_hash, status, side) values (4998, 'EARLY', 'hybrid', 'hybrid-ai-v1', 'hybrid-ai-v1', '{}', 'x', 'OK', 'NO_PICK')`)).rejects.toThrow(/before kickoff/);
    await expect(q(`update hybrid_decisions set side = 'OVER' where fixture_id = 301`)).rejects.toThrow();
    await expect(q(`delete from hybrid_decisions where fixture_id = 301`)).rejects.toThrow();
  });

  it('still requires a model probability for a rules pick', async () => {
    await expect(
      q(`insert into analysis_predictions (fixture_id, publish_round, kind, market, selection, line, decision_rule_version) values (303, 'LINEUP', 'SIGNAL', 'ASIAN_HANDICAP', 'HOME', -0.75, 'rules-v0.6')`),
    ).rejects.toThrow(/analysis_predictions_check/);
  });
});
