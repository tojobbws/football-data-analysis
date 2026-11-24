/**
 * Hybrid AI v2.2-panel (EXPERIMENTAL, ADR 0022): three lenses over the v2.1.1 input and guards. The prompt prefix must
 * stay byte-identical across the three calls (OpenAI prompt caching), and no guard is loosened.
 */
import { describe, expect, it } from 'vitest';
import type { HybridOption } from '@fp/analysis';
import {
  createOpenAIHybridPanelDecider,
  HYBRID_OUTPUT_SCHEMA,
  HYBRID_PROMPT_VERSION_V211,
  HYBRID_PROMPT_VERSION_V22_PANEL,
  HYBRID_SYSTEM_PROMPT_V211,
  HYBRID_SYSTEM_PROMPT_V22_PANEL,
  locateViolations,
  PANEL_INSTRUCTION_V22,
  PANEL_ROLE_PROMPTS,
  PANEL_ROLES,
  panelUserMessage,
  prepareHybridInputV211,
  retryFeedbackV21,
  userMessage,
  validateHybridOutputV211,
} from '../src/index.js';

const match = (date: string, venue: 'HOME' | 'AWAY', score: string, xgFor: number | null, xgAgainst: number | null) => ({ date_utc: date, venue, opponent: 'X', score_for_against: score, xg_for: xgFor, xg_against: xgAgainst });

const rawInput = (): Record<string, unknown> => ({
  prediction_timestamp_utc: '2026-11-16T07:00:00.000Z',
  match: { home: 'Canada', away: 'Guatemala', competition: 'WC Qualification', kickoff_utc: '2026-11-16T23:00:00.000Z' },
  home_team: {
    name: 'Canada',
    recent_matches: [match('2026-11-13', 'HOME', '4-1', 1.71, 2.3), match('2026-10-10', 'HOME', '2-2', 1.2, 0.8)],
    last_10: { matches: 2, goals_for_avg: 3, goals_against_avg: 1.5, xg_for_avg: 1.46, xg_against_avg: 1.55 },
    last_5: { matches: 2, goals_for_avg: 3, goals_against_avg: 1.5, xg_for_avg: 1.46, xg_against_avg: 1.55 },
    league_table: { rank: 1, points: 11, goalDiff: 9, played: 5 },
  },
  away_team: {
    name: 'Guatemala',
    recent_matches: [match('2026-11-13', 'AWAY', '1-1', 0.9, 1.4)],
    last_10: { matches: 1, goals_for_avg: 1, goals_against_avg: 1, xg_for_avg: 0.9, xg_against_avg: 1.4 },
    last_5: { matches: 1, goals_for_avg: 1, goals_against_avg: 1, xg_for_avg: 0.9, xg_against_avg: 1.4 },
    league_table: { rank: 3, points: 5, goalDiff: -2, played: 5 },
  },
  market: { asian_handicap: { options: [] }, over_under: { options: [] } },
  data_quality: { missing: [] },
});
const input = () => prepareHybridInputV211(rawInput()).input;

const options: HybridOption[] = [
  { side: 'FAVORITE', market: 'ASIAN_HANDICAP', selection: 'HOME', line: -2.25, odds: 1.9, marketProbability: 0.51 },
  { side: 'UNDERDOG', market: 'ASIAN_HANDICAP', selection: 'AWAY', line: 2.25, odds: 1.95, marketProbability: 0.49 },
];
const answer = (summary: string, extra: Record<string, unknown> = {}) => ({
  team_assessment_th: 'แคนาดาฟอร์มดีกว่า',
  match_outlook_th: 'เกมน่าจะเปิด',
  market_comparison_th: 'ตลาดน่าจะสะท้อนฟอร์มของทั้งสองทีมไปแล้ว',
  options_review: [{ option: 'UNDERDOG', supporting_evidence: ['กัวเตมาลาเสมอ 1-1'], counter_evidence: ['ตัวอย่างของทีมเยือนมีน้อย'], assessment: 'MODERATE' }],
  market: 'AH',
  side: 'UNDERDOG',
  main_line: 2.25,
  confidence: 'MEDIUM',
  supporting_evidence: [],
  counter_evidence: [],
  risk_factors: [],
  missing_data: [],
  summary_th: summary,
  ...extra,
});

/** a fake OpenAI endpoint that records every request body */
function recorder() {
  const seen: Array<Record<string, any>> = [];
  const fetch = (async (_u: unknown, init?: { body?: string }) => {
    seen.push(JSON.parse(init?.body ?? '{}'));
    const body = { id: 'r', object: 'response', model: 'gpt-test', status: 'completed', incomplete_details: null, output: [{ type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '{"a":1}', annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { seen, fetch };
}

describe('prompt v2.2-panel', () => {
  it('is the v2.1.1 prompt with one shared sentence appended; v2.1.1 itself is unchanged', () => {
    expect(HYBRID_PROMPT_VERSION_V22_PANEL).toBe('hybrid-ai-v2.2-panel');
    expect(HYBRID_PROMPT_VERSION_V211).toBe('hybrid-ai-v2.1.1');
    expect(HYBRID_SYSTEM_PROMPT_V22_PANEL).toBe(`${HYBRID_SYSTEM_PROMPT_V211}\n${PANEL_INSTRUCTION_V22}`);
    expect(HYBRID_SYSTEM_PROMPT_V211).not.toContain('[PANEL ROLE]');
    expect(PANEL_INSTRUCTION_V22).toContain('[PANEL ROLE]');
    expect(PANEL_INSTRUCTION_V22).toMatch(/no new calculation/);
    expect(PANEL_INSTRUCTION_V22).toMatch(/match count/);
    expect(PANEL_INSTRUCTION_V22).toMatch(/plain Thai/);
  });

  it('has three lenses; the defender starts from NO_PICK; every lens keeps field names out of the Thai text', () => {
    expect(PANEL_ROLES).toEqual(['metrics', 'context', 'defender']);
    expect(PANEL_ROLE_PROMPTS.metrics).toContain('vs_closing_market');
    expect(PANEL_ROLE_PROMPTS.metrics).toContain('market_comparison_th');
    expect(PANEL_ROLE_PROMPTS.context).toContain('market.movement');
    expect(PANEL_ROLE_PROMPTS.defender).toMatch(/NO_PICK is the default/);
    for (const r of PANEL_ROLES) expect(PANEL_ROLE_PROMPTS[r]).toMatch(/never write them in a Thai text field/);
  });
});

describe('createOpenAIHybridPanelDecider: prompt-caching invariant', () => {
  it('the instructions and the user message up to [PANEL ROLE] are byte-identical across the three lenses', async () => {
    const { seen, fetch } = recorder();
    const data = input();
    for (const role of PANEL_ROLES) await createOpenAIHybridPanelDecider({ apiKey: 'k', model: 'gpt-test', role, fetch }).decide(data);
    expect(seen).toHaveLength(3);
    const prefix = userMessage(data);
    const marker = '\n\n[PANEL ROLE]\n';
    for (const [i, body] of seen.entries()) {
      expect(body.instructions).toBe(HYBRID_SYSTEM_PROMPT_V22_PANEL);
      expect(body.input).toHaveLength(1);
      const content = body.input[0].content as string;
      // the match data comes first, byte for byte, then the role
      expect(content.startsWith(prefix + marker)).toBe(true);
      expect(content.slice(0, content.indexOf(marker))).toBe(prefix);
      expect(content.slice(prefix.length + marker.length)).toBe(PANEL_ROLE_PROMPTS[PANEL_ROLES[i]!]);
      expect(body.text.format).toMatchObject({ type: 'json_schema', name: 'hybrid_decision', strict: true, schema: HYBRID_OUTPUT_SCHEMA });
    }
    expect(new Set(seen.map((b) => b.instructions)).size).toBe(1);
    expect(new Set(seen.map((b) => (b.input[0].content as string).split(marker)[0])).size).toBe(1);
  });

  it('a retry keeps the same prefix, then the previous answer and the feedback', async () => {
    const { seen, fetch } = recorder();
    const d = createOpenAIHybridPanelDecider({ apiKey: 'k', model: 'gpt-test', role: 'defender', fetch });
    await d.retry({ q: 1 }, { side: 'X' }, 'FEEDBACK');
    expect(seen[0]!.instructions).toBe(HYBRID_SYSTEM_PROMPT_V22_PANEL);
    expect(seen[0]!.input).toEqual([
      { role: 'user', content: panelUserMessage({ q: 1 }, 'defender') },
      { role: 'assistant', content: '{"side":"X"}' },
      { role: 'user', content: 'FEEDBACK' },
    ]);
    expect(panelUserMessage({ q: 1 }, 'defender').startsWith('Match data (JSON):\n{"q":1}\n\n[PANEL ROLE]\n')).toBe(true);
  });

  it('per-lens model, and reasoning.effort only when given', async () => {
    const { seen, fetch } = recorder();
    const d = createOpenAIHybridPanelDecider({ apiKey: 'k', model: 'gpt-metrics', role: 'metrics', reasoningEffort: 'high', fetch });
    expect(d).toMatchObject({ role: 'metrics', model: 'gpt-metrics' });
    await d.decide({ q: 1 });
    await createOpenAIHybridPanelDecider({ apiKey: 'k', model: 'gpt-context', role: 'context', fetch }).decide({ q: 1 });
    expect(seen[0]).toMatchObject({ model: 'gpt-metrics', reasoning: { effort: 'high' } });
    expect(seen[1]!.model).toBe('gpt-context');
    expect('reasoning' in seen[1]!).toBe(false);
  });
});

describe('v2.2-panel answers go through the v2.1.1 guards unchanged', () => {
  it('a valid panel answer passes validateHybridOutputV211', () => {
    const v = validateHybridOutputV211(answer('ทีมเยือนมีโอกาสเก็บผลไม่แพ้ตามเส้นต่อรอง'), input(), options);
    expect(v).toMatchObject({ ok: true, violations: [] });
    expect(v.decision).toMatchObject({ side: 'UNDERDOG', option: { line: 2.25 } });
  });

  it('the number guard still rejects a number the AI computed itself, and the retry names it', () => {
    const raw = answer('ตลาดน่าจะประเมินไว้แล้ว แต่ xG รวม 4.37 สูงกว่าเส้น');
    const v = validateHybridOutputV211(raw, input(), options);
    expect(v.ok).toBe(false);
    expect(v.violations.some((x) => x.startsWith('number not in input') && x.includes('4.37'))).toBe(true);
    const fb = retryFeedbackV21(locateViolations(raw, input(), options, { averageCounts: true }));
    expect(fb).toContain('Number 4.37 in summary_th');
  });

  it('the match-count rule and banned words still apply to the adversarial texts', () => {
    const noCount = answer('สรุปสั้น', { market_comparison_th: 'ทีมเหย้ายิงเฉลี่ย 3 ประตูซึ่งตลาดอาจสะท้อนแล้ว' });
    const v1 = validateHybridOutputV211(noCount, input(), options);
    expect(v1.ok).toBe(false);
    expect(v1.violations).toContain('average without match count in market_comparison_th');
    expect(retryFeedbackV21(locateViolations(noCount, input(), options, { averageCounts: true }))).toContain('the number of matches behind the average is not stated');
    const withCount = answer('สรุปสั้น', { market_comparison_th: 'ทีมเหย้ายิงเฉลี่ย 3 ประตูใน 2 นัดซึ่งตลาดอาจสะท้อนแล้ว' });
    expect(validateHybridOutputV211(withCount, input(), options).ok).toBe(true);
    const banned = answer('สรุปสั้น', { counter_evidence: ['ราคาไม่รวมกำไรของตลาด'] });
    expect(validateHybridOutputV211(banned, input(), options).violations.some((x) => x.startsWith('banned word'))).toBe(true);
  });

  it('a NO_PICK from the defender is a valid answer', () => {
    const v = validateHybridOutputV211(answer('ราคาตลาดสะท้อนข้อมูลแล้ว ยังไม่เลือกฝั่งใด', { side: 'NO_PICK', market: 'NONE', main_line: null, confidence: 'NONE', options_review: [] }), input(), options);
    expect(v.ok).toBe(true);
    expect(v.decision?.side).toBe('NO_PICK');
  });
});
