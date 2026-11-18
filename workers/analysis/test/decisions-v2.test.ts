/**
 * E2E: stored DAILY Hybrid AI inputs (PGlite, all migrations) -> decisions-v2 job (fake Decisions client) -> decisions_v2.
 * The real OpenAI client is never called here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type OpenAI from 'openai';
import { parseDecisionsV2Answers, type DecisionsV2Client } from '@fp/ai';
import { MARGIN_LEVELS, TOTAL_LEVELS } from '@fp/analysis';
import { Repository, type JobContext } from '@fp/database';
import { ApiFootball, ApiFootballClient } from '@fp/football';
import { createLogger, type Env } from '@fp/shared';
import { createTestDb } from '../../../packages/database/test/helpers.js';
import { decisionsV2Job } from '../src/decisions-v2-job.js';

let db: Awaited<ReturnType<typeof createTestDb>>;
let ctx: JobContext;
const KO = new Date(Date.now() + 3 * 3_600_000);
const one = async (sql: string) => (await db.query<Record<string, unknown>>(sql)).rows[0]!;

type Answer = OpenAI.Decision['answers'][number];
const score = (name: string, labels: readonly string[], p: Record<string, number>): Answer => ({
  type: 'score', name, score: 0, confidence: 0.5, probabilities: labels.map((label, i) => ({ label, value: i, probability: p[label] ?? 0 })),
});
const TEAM = ['AWAY_CLEARLY', 'AWAY_SLIGHTLY', 'NEUTRAL', 'HOME_SLIGHTLY', 'HOME_CLEARLY'];
const GOALS = ['FEWER_CLEARLY', 'FEWER_SLIGHTLY', 'NEUTRAL', 'MORE_SLIGHTLY', 'MORE_CLEARLY'];
function answers(margin: Record<string, number>, opts: { total?: Record<string, number>; data?: number; refuseMargin?: boolean } = {}): Answer[] {
  return [
    opts.refuseMargin ? { type: 'refusal', name: 'margin_vs_market' } : score('margin_vs_market', MARGIN_LEVELS, margin),
    score('total_vs_market', TOTAL_LEVELS, opts.total ?? { AS_MARKET: 1 }),
    score('performance', TEAM, { HOME_SLIGHTLY: 0.7, NEUTRAL: 0.3 }),
    score('availability', TEAM, { NEUTRAL: 1 }),
    score('situation', TEAM, { NEUTRAL: 1 }),
    score('market_move', TEAM, { AWAY_SLIGHTLY: 0.8, NEUTRAL: 0.2 }),
    score('scoring_data', GOALS, { NEUTRAL: 1 }),
    score('game_state', GOALS, { NEUTRAL: 1 }),
    { type: 'predicate', name: 'data_sufficient', probability: opts.data ?? 0.9 },
    { type: 'predicate', name: 'lineup_uncertain', probability: 0.2 },
  ];
}

/** fake Decisions: answers per home team name found in the request text */
function fakeClient(by: Record<string, Answer[] | 'throw'>): DecisionsV2Client & { calls: string[] } {
  const c = {
    calls: [] as string[],
    async decide(body: OpenAI.DecisionCreateParams): Promise<OpenAI.Decision> {
      const text = JSON.stringify(body.input);
      const home = Object.keys(by).find((h) => text.includes(`"home\\":\\"${h}\\"`));
      c.calls.push(home ?? '?');
      const a = home ? by[home] : undefined;
      if (!a || a === 'throw') throw new Error('API down');
      // v1's flaw: the market probability written into the question. v2 questions carry no number at all.
      if (body.questions.some((q) => /\d\.\d/.test(JSON.stringify(q)))) throw new Error('a question carries a number');
      return { model: 'gpt-6-luna', answers: a, usage: { input_tokens: 9000, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 9000 } };
    },
  };
  return c;
}

function input(home: string) {
  return {
    match: { home, away: 'Away FC', competition: 'Premier League', kickoff_utc: KO.toISOString(), publish_round: 'DAILY' },
    market: {
      asian_handicap: {
        status: 'OK', favourite: home, home_line: -0.25, bookmakers: 6, price_age_hours: 1,
        options: [
          { option: 'FAVORITE', team_or_total: home, line: -0.25, odds_median: 1.95, market_probability_no_vig: 0.5 },
          { option: 'UNDERDOG', team_or_total: 'Away FC', line: 0.25, odds_median: 1.95, market_probability_no_vig: 0.5 },
        ],
      },
      over_under: {
        status: 'OK', line: 2.5, bookmakers: 6, price_age_hours: 1,
        options: [
          { option: 'OVER', team_or_total: 'OVER', line: 2.5, odds_median: 1.95, market_probability_no_vig: 0.5 },
          { option: 'UNDER', team_or_total: 'UNDER', line: 2.5, odds_median: 1.95, market_probability_no_vig: 0.5 },
        ],
      },
      match_odds_1x2_no_vig: { home: 0.42, draw: 0.27, away: 0.31, nBookmakers: 8 },
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
  await db.query(`insert into teams (id, name) select g, 'H' || g from generate_series(601, 606) g`);
  await db.query(`insert into teams (id, name) values (999, 'Away FC')`);
  await db.query(`insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short)
                  select g, 39, 2026, $1, g, 999, 'NS' from generate_series(601, 606) g`, [KO.toISOString()]);
  for (let id = 601; id <= 606; id++) {
    const inp = input(`H${id}`);
    await db.query(
      `insert into hybrid_decisions (fixture_id, publish_round, engine_mode, engine_version, prompt_version, input, input_hash, status, side)
       values ($1, 'DAILY', 'hybrid', 'hybrid-ai-v1', 'hybrid-ai-v2.1.1', $2, $3, 'OK', 'NO_PICK')`,
      [id, JSON.stringify(inp), `hash${id}`],
    );
  }
  // 606 kicks off in 2 minutes: too late for a decision
  await db.query(`update fixtures set kickoff_at = now() + interval '2 minutes' where id = 606`);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('decisionsV2Job', () => {
  it('does nothing while DECISIONS_V2 is unset', async () => {
    expect(await decisionsV2Job(ctx)).toBe(0);
    expect(Number((await one(`select count(*) n from decisions_v2`)).n)).toBe(0);
  });

  it('stores one priced decision per fixture before kickoff, with every option and its reasons', async () => {
    const client = fakeClient({
      H601: answers({ HOME_CLEARLY: 1 }), // a confident view against the line: a pick
      H602: answers({ AS_MARKET: 1 }), // the market view: never a pick
      H603: answers({}, { refuseMargin: true }), // no view: INVALID, stored
      H604: 'throw', // API error: no row, asked again next run
      H605: answers({ HOME_CLEARLY: 1 }, { data: 0.2 }), // a strong view on data the analyst calls insufficient
      H606: answers({ AS_MARKET: 1 }),
    });
    expect(await decisionsV2Job(ctx, { client })).toBe(4);
    expect(client.calls.sort()).toEqual(['H601', 'H602', 'H603', 'H604', 'H605']);

    const pick = await one(`select status, side, market, selection, line, odds, market_probability, fair_probability, ev, ev_sd, candidates, evidence, view, input_hash, odds_hash, prompt_version, rules_version from decisions_v2 where fixture_id = 601`);
    expect(pick).toMatchObject({ status: 'OK', side: 'FAVORITE', market: 'ASIAN_HANDICAP', selection: 'HOME', input_hash: 'hash601', prompt_version: 'decisions-v2-prompt-0.1', rules_version: 'decisions-v2-config-0.1' });
    expect(Number(pick.line)).toBe(-0.25);
    expect(Number(pick.odds)).toBe(1.95);
    expect(Number(pick.fair_probability)).toBeGreaterThan(Number(pick.market_probability));
    expect(Number(pick.ev)).toBeGreaterThanOrEqual(0.03);
    const cands = pick.candidates as Array<{ side: string; distribution: Record<string, number>; reasons: string[] }>;
    expect(cands.map((c) => c.side)).toEqual(['FAVORITE', 'UNDERDOG', 'OVER', 'UNDER']);
    expect(cands[0]!.distribution.halfLoss).toBeGreaterThan(0); // a quarter line keeps its half results
    expect(cands[1]!.reasons).toContain('EV_BELOW_THRESHOLD');
    const ev = pick.evidence as Array<{ side: string; supporting: Array<{ factor: string }>; conflicting: Array<{ factor: string }> }>;
    expect(ev.find((e) => e.side === 'FAVORITE')).toMatchObject({ supporting: [{ factor: 'performance' }], conflicting: [{ factor: 'market_move' }] });
    expect(String(pick.odds_hash)).toMatch(/^[0-9a-f]{64}$/);

    expect(await one(`select status, side, no_pick_reasons from decisions_v2 where fixture_id = 602`)).toMatchObject({ status: 'OK', side: 'NO_PICK' });
    expect(await one(`select status, side, view from decisions_v2 where fixture_id = 603`)).toMatchObject({ status: 'INVALID', side: null, view: null });
    const thin = await one(`select side, no_pick_reasons from decisions_v2 where fixture_id = 605`);
    expect(thin.side).toBe('NO_PICK');
    expect(thin.no_pick_reasons).toContain('DATA_INSUFFICIENT');
    expect(Number((await one(`select count(*) n from decisions_v2 where fixture_id in (604, 606)`)).n)).toBe(0);
  });

  it('asks each fixture once per version set; a failed call is asked again', async () => {
    const client = fakeClient({ H604: answers({ AS_MARKET: 1 }) });
    expect(await decisionsV2Job(ctx, { client })).toBe(1);
    expect(client.calls).toEqual(['H604']);
  });

  it('never stores after kickoff and never changes a stored row', async () => {
    await expect(
      db.query(`insert into decisions_v2 (fixture_id, hybrid_decision_id, input_hash, odds_snapshot, odds_hash, engine_version, rules_version, prompt_version, status, side)
                select 606, id, 'x', '{}', 'x', 'e', 'r', 'p', 'OK', 'NO_PICK' from hybrid_decisions where fixture_id = 606`).then(async () => {
        await db.query(`update fixtures set kickoff_at = now() - interval '1 minute' where id = 606`);
        await db.query(`insert into decisions_v2 (fixture_id, hybrid_decision_id, input_hash, odds_snapshot, odds_hash, engine_version, rules_version, prompt_version, status, side)
                        select 606, id, 'x', '{}', 'x', 'e2', 'r', 'p', 'OK', 'NO_PICK' from hybrid_decisions where fixture_id = 606`);
      }),
    ).rejects.toThrow(/before kickoff/);
    await expect(db.query(`update decisions_v2 set side = 'OVER' where fixture_id = 602`)).rejects.toThrow();
    await expect(db.query(`delete from decisions_v2 where fixture_id = 602`)).rejects.toThrow();
  });

  it('refuses a row whose Hybrid input belongs to another fixture', async () => {
    await expect(
      db.query(`insert into decisions_v2 (fixture_id, hybrid_decision_id, input_hash, odds_snapshot, odds_hash, engine_version, rules_version, prompt_version, status, side)
                select 601, id, 'x', '{}', 'x', 'e3', 'r', 'p', 'OK', 'NO_PICK' from hybrid_decisions where fixture_id = 602`),
    ).rejects.toThrow(/is not of fixture/);
  });
});

describe('parseDecisionsV2Answers', () => {
  it('reads the view, the factors and the predicates; a missing or broken view question is null', () => {
    const a = parseDecisionsV2Answers(answers({ HOME_SLIGHTLY: 0.6, AS_MARKET: 0.4 }))!;
    expect(a.view.margin).toMatchObject({ HOME_SLIGHTLY: 0.6, AS_MARKET: 0.4, AWAY_CLEARLY: 0 });
    expect(a.factors.map((f) => f.name)).toEqual(['performance', 'availability', 'situation', 'market_move', 'scoring_data', 'game_state']);
    expect(a.dataSufficient).toBe(0.9);
    expect(parseDecisionsV2Answers(answers({}, { refuseMargin: true }))).toBeNull();
    expect(parseDecisionsV2Answers(answers({ HOME_SLIGHTLY: 0.3 }))).toBeNull(); // sums to 0.3
  });
});
