/**
 * E2E (PGlite, all migrations): Hybrid AI v2.2-panel (EXPERIMENTAL, ADR 0022) in the hybrid job, with one fake decider
 * per lens. The real AI is never called here.
 *  - the three lenses see exactly the same v2.1.1 input (cut-off check, totals with counts)
 *  - each lens is validated by the v2.1.1 validator and retried with its located violations
 *  - metrics + context agree, defender NO_PICK: a 2/3 pick with the metrics text; votes carry role and model
 *  - the decision is stored and published under hybrid-ai-v2.2-panel
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HYBRID_PROMPT_VERSION_V22_PANEL, type HybridDecider, type PanelRole, type RankerResult } from '@fp/ai';
import { Repository, type JobContext } from '@fp/database';
import { ApiFootball, ApiFootballClient } from '@fp/football';
import { createLogger, type Env } from '@fp/shared';
import { createTestDb } from '../../../packages/database/test/helpers.js';
import { hybridJob } from '../src/hybrid-job.js';
import { publishJob } from '../src/publish-job.js';

let db: Awaited<ReturnType<typeof createTestDb>>;
let ctx: JobContext;
const KO = new Date(Date.now() + 10 * 3_600_000);
const q = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<R>(sql, params)).rows;

const answer = (over: Record<string, unknown> = {}) => ({
  team_assessment_th: 'ทีมเหย้าฟอร์มดีกว่า',
  match_outlook_th: 'ทีมเหย้าน่าจะคุมเกม',
  market_comparison_th: 'ตลาดน่าจะสะท้อนฟอร์มทีมเหย้าไปแล้ว',
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
const noPick = (text: string) => answer({ side: 'NO_PICK', market: 'NONE', main_line: null, confidence: 'NONE', options_review: [], summary_th: text });

type Call = { role: PanelRole; kind: 'decide' | 'retry'; input: Record<string, unknown>; feedback?: string };
const calls: Call[] = [];

function fake(role: PanelRole, first: () => unknown, retried?: () => unknown): HybridDecider {
  const res = (output: unknown): RankerResult => ({ output, model: `gpt-${role}`, stopReason: 'completed', refusal: null, usage: { input_tokens: 2000, output_tokens: 500 } });
  return {
    async decide(input) {
      calls.push({ role, kind: 'decide', input });
      return res(first());
    },
    async retry(input, _previous, feedback) {
      calls.push({ role, kind: 'retry', input, feedback });
      return res((retried ?? first)());
    },
  };
}

async function odds(fixture: number) {
  const t = new Date(Date.now() - 3_600_000).toISOString();
  for (const bk of [1, 2, 3])
    for (const [market, bet, sel, line, home, raw, o] of [
      ['ASIAN_HANDICAP', 4, 'HOME', -0.75, -0.75, 'Home -0.75', 1.95],
      ['ASIAN_HANDICAP', 4, 'AWAY', 0.75, -0.75, 'Away +0.75', 1.93],
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
    HYBRID_VERSION: 'v2.2-panel',
  };
  ctx = { env, db, repo: new Repository(db), client, api: new ApiFootball(client), log: createLogger('error') };
  await db.exec(`insert into leagues (id, name) values (39, 'Premier League');
                 insert into bookmakers (id, name) values (1, 'B1'), (2, 'B2'), (3, 'B3');
                 insert into teams (id, name) values (401, 'Panel FC'), (999, 'Away FC'), (998, 'Other FC');`);
  await q(`insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short) values (401, 39, 2026, $1, 401, 999, 'NS')`, [KO.toISOString()]);
  for (let i = 1; i <= 6; i++) {
    const at = new Date(Date.now() - i * 7 * 86_400_000).toISOString();
    await q(`insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short, goals_home, goals_away, ft_home, ft_away)
             values ($1, 39, 2026, $2, 401, 998, 'FT', 2, 1, 2, 1), ($3, 39, 2026, $2, 998, 999, 'FT', 1, 0, 1, 0)`,
      [6000 + i, at, 6200 + i]);
  }
  await q(`insert into fixture_statistics (fixture_id, team_id, type, value_num) values (6001, 401, 'expected_goals', 1.7), (6001, 998, 'expected_goals', 0.6)`);
  await odds(401);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('hybridJob v2.2-panel', () => {
  it('asks the three lenses on the same v2.1.1 input and stores a 2/3 pick with the metrics text', async () => {
    const panelDeciders = {
      // an invented number first, fixed by the feedback retry (the v2.1.1 guard, unchanged)
      metrics: fake('metrics', () => answer({ summary_th: 'xG รวม 9.99 สูงกว่าที่ตลาดคิด' }), () => answer({ summary_th: 'คุณภาพโอกาสยิง (xG) ของทีมเยือนดีกว่าที่ราคาสะท้อน' })),
      context: fake('context', () => answer({ summary_th: 'บริบทเกมเอื้อทีมเยือน' })),
      defender: fake('defender', () => noPick('ราคาตลาดสะท้อนข้อมูลแล้ว')),
    };
    expect(await hybridJob(ctx, { sameFootballDay: false, engine: 'hybrid', panelDeciders })).toBe(1);

    const [row] = await q<{ status: string; side: string; line: string; prompt_version: string; summary_th: string; model: string; input: Record<string, any>; votes: Array<Record<string, unknown>>; violations: string[] }>(
      'select status, side, line, prompt_version, summary_th, model, input, votes, violations from hybrid_decisions where fixture_id = 401',
    );
    expect(row).toMatchObject({ status: 'OK', side: 'UNDERDOG', prompt_version: HYBRID_PROMPT_VERSION_V22_PANEL, model: 'gpt-metrics' });
    expect(Number(row!.line)).toBe(0.75);
    expect(row!.summary_th).toBe('คุณภาพโอกาสยิง (xG) ของทีมเยือนดีกว่าที่ราคาสะท้อน');
    expect(row!.votes).toEqual([
      expect.objectContaining({ status: 'OK', side: 'UNDERDOG', role: 'metrics', model: 'gpt-metrics', attempts: 2, feedbackRetries: 1 }),
      expect.objectContaining({ status: 'OK', side: 'UNDERDOG', role: 'context', model: 'gpt-context', attempts: 1, feedbackRetries: 0 }),
      expect.objectContaining({ status: 'OK', side: 'NO_PICK', role: 'defender', model: 'gpt-defender', attempts: 1 }),
    ]);
    expect(row!.violations).toContain('answer 1: attempt 1: number not in input: 9.99');

    // one parallel round: one first ask per lens, on byte-identical input (the v2.1.1 pipeline), plus the one retry
    const firsts = calls.filter((c) => c.kind === 'decide');
    expect(firsts.map((c) => c.role).sort()).toEqual(['context', 'defender', 'metrics']);
    const json = firsts.map((c) => JSON.stringify(c.input));
    expect(new Set(json).size).toBe(1);
    // jsonb does not keep key order: compare the stored input by value
    expect(row!.input).toEqual(firsts[0]!.input);
    expect(row!.input.data_quality.cutoff_warnings).toEqual([]);
    expect(row!.input.data_quality.aggregates).toBeTruthy();
    expect(row!.input.home_team.last_10).toMatchObject({ goals_matches: 6 });
    const retry = calls.find((c) => c.kind === 'retry')!;
    expect(retry.role).toBe('metrics');
    expect(retry.feedback).toContain('Number 9.99 in summary_th');
    expect(JSON.stringify(retry.input)).toBe(json[0]);
  });

  it('publishes the panel decision under its prompt version when HYBRID_VERSION=v2.2-panel', async () => {
    await publishJob(ctx, { engine: 'hybrid' });
    const rows = await q<{ fixture_id: string; prompt_version: string; kind: string }>('select fixture_id, prompt_version, kind from analysis_predictions order by fixture_id');
    expect(rows.map((r) => [Number(r.fixture_id), r.kind, r.prompt_version])).toEqual([[401, 'SIGNAL', HYBRID_PROMPT_VERSION_V22_PANEL]]);
  });
});
