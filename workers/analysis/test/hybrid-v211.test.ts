/**
 * E2E (PGlite, all migrations): Hybrid AI v2.1.1 (ADR 0021) in the hybrid job, with a fake decider.
 *  - the stored decision carries prompt_version hybrid-ai-v2.1.1 and exactly the input the AI saw: the precomputed
 *    totals with their match counts and data_quality.cutoff_warnings
 *  - a rejected answer is asked again with its located violations, on the same input; the number guard is unchanged
 *  - an average without its match count is a violation, fixed by the feedback retry
 *  - the published pick keeps the v2.1.1 prompt version
 * The real AI is never called here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HYBRID_PROMPT_VERSION_V211, type HybridDecider, type RankerResult } from '@fp/ai';
import { Repository, type JobContext } from '@fp/database';
import { ApiFootball, ApiFootballClient } from '@fp/football';
import { createLogger, type Env } from '@fp/shared';
import { createTestDb } from '../../../packages/database/test/helpers.js';
import { hybridJob, hybridPromptVersion, hybridVersion } from '../src/hybrid-job.js';
import { publishJob } from '../src/publish-job.js';

let db: Awaited<ReturnType<typeof createTestDb>>;
let ctx: JobContext;
const KO = new Date(Date.now() + 10 * 3_600_000);
const q = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<R>(sql, params)).rows;

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

type Call = { kind: 'decide' | 'retry'; home: string; input: Record<string, unknown>; feedback?: string; previous?: unknown };

/** answers by home team: first() for a first ask, retried() for a feedback retry */
function fakeDecider(answers: Record<string, { first: () => unknown; retried?: () => unknown }>): HybridDecider & { calls: Call[] } {
  const res = (output: unknown): RankerResult => ({ output, model: 'gpt-test', stopReason: 'completed', refusal: null, usage: { input_tokens: 2000, output_tokens: 500 } });
  const d = {
    calls: [] as Call[],
    async decide(input: Record<string, unknown>) {
      const home = (input.match as { home: string }).home;
      d.calls.push({ kind: 'decide', home, input });
      return res(answers[home]!.first());
    },
    async retry(input: Record<string, unknown>, previous: unknown, feedback: string) {
      const home = (input.match as { home: string }).home;
      d.calls.push({ kind: 'retry', home, input, feedback, previous });
      return res(answers[home]!.retried!());
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
  };
  ctx = { env, db, repo: new Repository(db), client, api: new ApiFootball(client), log: createLogger('error') };
  await db.exec(`insert into leagues (id, name) values (39, 'Premier League');
                 insert into bookmakers (id, name) values (1, 'B1'), (2, 'B2'), (3, 'B3');
                 insert into teams (id, name) values (401, 'Retry FC'), (402, 'Average FC'), (999, 'Away FC'), (998, 'Other FC');`);
  await q(`insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short) select g, 39, 2026, $1, g, 999, 'NS' from generate_series(401, 402) g`, [KO.toISOString()]);
  // six past matches of each home team (2-1, xG 1.7 / 0.6 in the newest one) and of Away FC
  for (let i = 1; i <= 6; i++) {
    const at = new Date(Date.now() - i * 7 * 86_400_000).toISOString();
    await q(`insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short, goals_home, goals_away, ft_home, ft_away)
             values ($1, 39, 2026, $2, 401, 998, 'FT', 2, 1, 2, 1), ($3, 39, 2026, $2, 402, 998, 'FT', 2, 1, 2, 1), ($4, 39, 2026, $2, 998, 999, 'FT', 1, 0, 1, 0)`,
      [6000 + i, at, 6100 + i, 6200 + i]);
  }
  await q(`insert into fixture_statistics (fixture_id, team_id, type, value_num) values (6001, 401, 'expected_goals', 1.7), (6001, 998, 'expected_goals', 0.6)`);
  for (const f of [401, 402]) await odds(f);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('hybridVersion', () => {
  it('defaults to v2.1.1; HYBRID_VERSION=v2.0 is the rollback', () => {
    expect(hybridVersion({})).toBe('v2.1.1');
    expect(hybridVersion({ HYBRID_VERSION: 'v2.0' })).toBe('v2.0');
    expect(hybridPromptVersion('v2.1.1')).toBe('hybrid-ai-v2.1.1');
    expect(hybridPromptVersion('v2.0')).toBe('hybrid-ai-v2.0');
  });
});

describe('hybridJob v2.1.1', () => {
  it('stores the v2.1.1 input and version, and fixes rejected answers with a feedback retry on the same input', async () => {
    const d = fakeDecider({
      // an invented match total first, then the precomputed one
      'Retry FC': { first: () => pick({ summary_th: 'นัดล่าสุด xG รวม 9.99' }), retried: () => pick({ summary_th: 'นัดล่าสุดมี xG รวม 2.3 จาก 3 ประตู' }) },
      // an average without its match count first, then with it
      'Average FC': { first: () => pick({ summary_th: 'ทีมเหย้ายิงเฉลี่ย 2 ประตูต่อเกม' }), retried: () => pick({ summary_th: 'ทีมเหย้ายิงเฉลี่ย 2 ประตูใน 6 นัด' }) },
    });
    expect(await hybridJob(ctx, { sameFootballDay: false, engine: 'hybrid', decider: d, version: 'v2.1.1' })).toBe(2);

    const rows = await q<{ fixture_id: string; status: string; side: string; prompt_version: string; input: Record<string, any>; votes: Array<Record<string, unknown>>; violations: string[] }>(
      'select fixture_id, status, side, prompt_version, input, votes, violations from hybrid_decisions order by fixture_id',
    );
    expect(rows.map((r) => [Number(r.fixture_id), r.status, r.side, r.prompt_version])).toEqual([
      [401, 'OK', 'UNDERDOG', HYBRID_PROMPT_VERSION_V211],
      [402, 'OK', 'UNDERDOG', HYBRID_PROMPT_VERSION_V211],
    ]);
    // the input as the AI saw it: totals with their counts, the cut-off check clean
    const input = rows[0]!.input;
    expect(input.home_team.recent_matches[0]).toMatchObject({ score_for_against: '2-1', goals_total: 3, xg_total: 2.3 });
    expect(input.home_team.last_10).toMatchObject({ goals_matches: 6, goals_total_avg: 3, xg_total_matches: 1, xg_total_avg: 2.3 });
    expect(input.data_quality.cutoff_warnings).toEqual([]);
    expect(input.data_quality.aggregates).toBeTruthy();

    // every rejected answer was asked again once, with the same input and the located violation
    const retries = d.calls.filter((c) => c.kind === 'retry');
    expect(retries).toHaveLength(6);
    for (const r of retries) {
      const first = d.calls.find((c) => c.kind === 'decide' && c.home === r.home)!;
      expect(r.input).toEqual(first.input);
    }
    expect(retries.find((r) => r.home === 'Retry FC')!.feedback).toContain('Number 9.99 in summary_th');
    expect(retries.find((r) => r.home === 'Average FC')!.feedback).toContain('the number of matches behind the average is not stated');
    // no feedback ever names a team or a market to choose
    for (const r of retries) expect(r.feedback).not.toMatch(/choose|UNDERDOG|FAVORITE|OVER|UNDER\b/);

    expect(rows[0]!.votes).toEqual(Array(3).fill(expect.objectContaining({ status: 'OK', attempts: 2, feedbackRetries: 1 })));
    expect(rows[0]!.violations).toContain('answer 1: attempt 1: number not in input: 9.99');
    expect(rows[1]!.violations).toContain('answer 1: attempt 1: average without match count in summary_th');
  });

  it('publishes the v2.1.1 decision with its prompt version', async () => {
    await publishJob(ctx, { engine: 'hybrid' });
    const rows = await q<{ fixture_id: string; prompt_version: string; kind: string }>('select fixture_id, prompt_version, kind from analysis_predictions order by fixture_id');
    expect(rows.map((r) => [Number(r.fixture_id), r.kind, r.prompt_version])).toEqual([
      [401, 'SIGNAL', HYBRID_PROMPT_VERSION_V211],
      [402, 'SIGNAL', HYBRID_PROMPT_VERSION_V211],
    ]);
  });
});
