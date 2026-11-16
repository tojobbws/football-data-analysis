/**
 * Hybrid AI v2.1 (EXPERIMENTAL, ADR 0021): aggregates the AI used to compute itself are given in the input; the
 * prompt forbids new calculations; a rejected answer is asked again with its exact violations. The v2.0 baseline and
 * the number guard are unchanged.
 */
import { describe, expect, it } from 'vitest';
import type { HybridOption } from '@fp/analysis';
import {
  allowedNumbers,
  createOpenAIHybridDeciderV21,
  HYBRID_PROMPT_VERSION,
  HYBRID_PROMPT_VERSION_V21,
  HYBRID_SYSTEM_PROMPT,
  HYBRID_SYSTEM_PROMPT_V21,
  inventedNumbers,
  locateViolations,
  NO_CALCULATION_RULE_V21,
  retryFeedbackV21,
  validateHybridOutput,
  withAggregatesV21,
} from '../src/index.js';

const match = (date: string, venue: 'HOME' | 'AWAY', score: string, xgFor: number | null, xgAgainst: number | null, np?: [number | null, number | null]) => ({
  date_utc: date,
  venue,
  opponent: 'X',
  score_for_against: score,
  xg_for: xgFor,
  xg_against: xgAgainst,
  ...(np ? { npxg_for: np[0], npxg_against: np[1] } : {}),
});

const input = (): Record<string, unknown> => ({
  match: { home: 'Canada', away: 'Guatemala', competition: 'WC Qualification', kickoff_utc: '2026-11-16T23:00:00.000Z' },
  home_team: {
    name: 'Canada',
    recent_matches: [
      match('2026-11-13', 'HOME', '4-1', 1.71, 2.3, [1.71, 1.51]),
      match('2026-10-14', 'AWAY', '0-0', null, null, [null, null]),
      match('2026-10-10', 'HOME', '2-2', 1.2, 0.8, [0.41, 0.8]),
    ],
    last_10: { matches: 3, goals_for_avg: 2, goals_against_avg: 1, xg_for_avg: 1.46, xg_against_avg: 1.55 },
    last_5: { matches: 3, goals_for_avg: 2, goals_against_avg: 1, xg_for_avg: 1.46, xg_against_avg: 1.55 },
    home_matches_in_last_10: { matches: 2, goals_for_avg: 3, goals_against_avg: 1.5 },
    league_table: { rank: 1, points: 11, goalDiff: 9, played: 5 },
    rest_days_before_this_match: 3.1,
  },
  away_team: {
    name: 'Guatemala',
    recent_matches: [match('2026-11-13', 'AWAY', '1-1', 0.9, 1.4)],
    last_10: { matches: 1, goals_for_avg: 1, goals_against_avg: 1, xg_for_avg: 0.9, xg_against_avg: 1.4 },
    last_5: { matches: 1, goals_for_avg: 1, goals_against_avg: 1, xg_for_avg: 0.9, xg_against_avg: 1.4 },
    away_matches_in_last_10: { matches: 1, goals_for_avg: 1, goals_against_avg: 1 },
    league_table: { rank: 3, points: 5, goalDiff: -2, played: 5 },
    rest_days_before_this_match: 2.6,
  },
  market: { asian_handicap: { options: [] }, over_under: { options: [] } },
  data_quality: { missing: ['no xG for 1 recent matches'] },
});

describe('withAggregatesV21', () => {
  it('adds per-match totals, null when a part is missing (never zero)', () => {
    const out = withAggregatesV21(input());
    const ms = (out.home_team as { recent_matches: Array<Record<string, unknown>> }).recent_matches;
    expect(ms[0]).toMatchObject({ goals_total: 5, xg_total: 4.01, npxg_total: 3.22 });
    expect(ms[1]).toMatchObject({ goals_total: 0, xg_total: null, npxg_total: null });
    // inputs before v1.5 have no npxG: no npxg_total key at all
    const away = (out.away_team as { recent_matches: Array<Record<string, unknown>> }).recent_matches[0]!;
    expect(away).toMatchObject({ goals_total: 2, xg_total: 2.3 });
    expect('npxg_total' in away).toBe(false);
  });

  it('adds window sums and averages over only the matches that have the value, with the count', () => {
    const t = withAggregatesV21(input()).home_team as Record<string, Record<string, unknown>>;
    expect(t.last_10).toMatchObject({
      goals_for_sum: 6,
      goals_against_sum: 3,
      goals_total_sum: 9,
      goals_total_avg: 3,
      goal_difference_avg: 1,
      xg_for_sum: 2.91,
      xg_against_sum: 3.1,
      xg_total_sum: 6.01,
      xg_total_avg: 3.01,
      xg_total_matches: 2,
      npxg_total_avg: 2.22,
      npxg_total_matches: 2,
    });
    // the existing window values are kept
    expect(t.last_10).toMatchObject({ matches: 3, xg_for_avg: 1.46 });
    // the venue window counts only the venue's matches (2 home matches of the first 10)
    expect(t.home_matches_in_last_10).toMatchObject({ goals_total_sum: 9, goals_total_avg: 4.5, xg_total_matches: 2 });
  });

  it('puts the two teams side by side with their sum and gap, and the table and rest-day gaps', () => {
    const c = withAggregatesV21(input()).comparison as Record<string, Record<string, unknown>>;
    expect(c.last_5!.xg_for_avg).toEqual({ home: 1.46, away: 0.9, sum: 2.36, gap_home_minus_away: 0.56 });
    expect(c.league_table!.points).toEqual({ home: 11, away: 5, gap_home_minus_away: 6 });
    expect(c.rest_days).toEqual({ home: 3.1, away: 2.6, gap_home_minus_away: 0.5 });
  });

  it('documents the definitions in data_quality and keeps what was there', () => {
    const dq = withAggregatesV21(input()).data_quality as Record<string, unknown>;
    expect(dq.missing).toEqual(['no xG for 1 recent matches']);
    expect(String((dq.aggregates as Record<string, string>).per_window)).toContain('never counted as zero');
  });

  it('does not change the given input (the stored v2.0 snapshot stays as it was)', () => {
    const before = input();
    const copy = structuredClone(before);
    withAggregatesV21(before);
    expect(before).toEqual(copy);
  });

  it('makes the AI\'s own totals traceable without loosening the guard', () => {
    const text = 'นัดล่าสุดมี 5 ประตูและ xG รวม 4.01';
    expect(inventedNumbers(text, allowedNumbers(input()))).toEqual(['4.01']);
    expect(inventedNumbers(text, allowedNumbers(withAggregatesV21(input())))).toEqual([]);
    // a total that is not one of the given aggregates is still rejected
    expect(inventedNumbers('xG รวม 4.37', allowedNumbers(withAggregatesV21(input())))).toEqual(['4.37']);
  });
});

describe('prompt v2.1', () => {
  it('keeps v2.0 as the locked baseline and adds the owner\'s rule and the no-vig wording', () => {
    expect(HYBRID_PROMPT_VERSION).toBe('hybrid-ai-v2.0');
    expect(HYBRID_PROMPT_VERSION_V21).toBe('hybrid-ai-v2.1');
    expect(HYBRID_SYSTEM_PROMPT_V21).toContain(NO_CALCULATION_RULE_V21);
    expect(HYBRID_SYSTEM_PROMPT_V21).toContain('ราคาที่ตัดค่าน้ำแล้ว');
    expect(HYBRID_SYSTEM_PROMPT_V21).toContain('goals_total');
    expect(HYBRID_SYSTEM_PROMPT_V21.startsWith(HYBRID_SYSTEM_PROMPT.split('\n\nOutput rules:')[0]!)).toBe(true);
    expect(HYBRID_SYSTEM_PROMPT).not.toContain(NO_CALCULATION_RULE_V21);
  });
});

const options: HybridOption[] = [
  { side: 'FAVORITE', market: 'ASIAN_HANDICAP', selection: 'HOME', line: -2.25, odds: 1.9, marketProbability: 0.51 },
  { side: 'UNDERDOG', market: 'ASIAN_HANDICAP', selection: 'AWAY', line: 2.25, odds: 1.95, marketProbability: 0.49 },
];
const answer = (summary: string, market = 'ข้อมูลตลาดใกล้เคียงกัน') => ({
  team_assessment_th: 'แคนาดาฟอร์มดีกว่า',
  match_outlook_th: 'เกมน่าจะเปิด',
  market_comparison_th: market,
  options_review: [{ option: 'UNDERDOG', supporting_evidence: ['กัวเตมาลาเสมอ 1-1'], counter_evidence: [], assessment: 'MODERATE' }],
  market: 'AH',
  side: 'UNDERDOG',
  main_line: 2.25,
  confidence: 'MEDIUM',
  supporting_evidence: [],
  counter_evidence: [],
  risk_factors: [],
  missing_data: [],
  summary_th: summary,
});

describe('locateViolations and retryFeedbackV21', () => {
  it('says which number, where, why and how to fix; and a banned word with the no-vig wording', () => {
    const raw = answer('นัดล่าสุดมี 5 ประตูและ xG รวม 4.37', 'ราคาไม่รวมค่ากำไรของตลาด');
    const v = locateViolations(raw, withAggregatesV21(input()), options);
    expect(v).toEqual([
      { kind: 'NUMBER_NOT_IN_INPUT', value: '4.37', field: 'summary_th', excerpt: expect.stringContaining('xG รวม 4.37') },
      { kind: 'BANNED_WORD', value: 'กำไร', field: 'market_comparison_th', excerpt: expect.stringContaining('ค่ากำไร') },
    ]);
    const msg = retryFeedbackV21(v);
    expect(msg).toContain('Number 4.37 in summary_th');
    expect(msg).toContain('this number is not in the input');
    expect(msg).toContain('ราคาที่ตัดค่าน้ำแล้ว');
    expect(msg).toContain('The match data has not changed');
  });

  it('a valid answer has no violation; the checks are exactly validateHybridOutput\'s', () => {
    const raw = answer('นัดล่าสุดมี 5 ประตูและ xG รวม 4.01');
    const agg = withAggregatesV21(input());
    expect(locateViolations(raw, agg, options)).toEqual([]);
    expect(validateHybridOutput(raw, agg, options).ok).toBe(true);
  });

  it('reports a non-text violation (a line that is not the option\'s) as OTHER', () => {
    const raw = { ...answer('สรุป'), main_line: 2.5 };
    expect(locateViolations(raw, withAggregatesV21(input()), options)).toEqual([{ kind: 'OTHER', value: 'main_line 2.5 is not the UNDERDOG line 2.25', field: null, excerpt: null }]);
  });
});

describe('createOpenAIHybridDeciderV21', () => {
  it('asks once with the match data; a retry sends the same data, the previous answer and the feedback', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const f = (async (_u: unknown, init?: { body?: string }) => {
      seen.push(JSON.parse(init?.body ?? '{}'));
      const body = { id: 'r', object: 'response', model: 'gpt-test', status: 'completed', incomplete_details: null, output: [{ type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '{"a":1}', annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const d = createOpenAIHybridDeciderV21({ apiKey: 'k', model: 'gpt-test', fetch: f });
    const data = { q: 1 };
    await d.decide(data);
    await d.retry(data, { side: 'X' }, 'FEEDBACK');
    expect(seen[0]).toMatchObject({ instructions: HYBRID_SYSTEM_PROMPT_V21, input: [{ role: 'user', content: 'Match data (JSON):\n{"q":1}' }] });
    expect(seen[1]!.input).toEqual([
      { role: 'user', content: 'Match data (JSON):\n{"q":1}' },
      { role: 'assistant', content: '{"side":"X"}' },
      { role: 'user', content: 'FEEDBACK' },
    ]);
  });
});
