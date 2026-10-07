import { describe, expect, it } from 'vitest';
import { allowedNumbers, buildShadowInput, inventedNumbers, validateShadowOutput, type ShadowSource } from '../src/index.js';

const source: ShadowSource = {
  fixture: { home: 'Liverpool', away: 'Arsenal', league: 'Premier League', kickoffAt: new Date('2026-10-10T19:00:00Z'), homeTeamId: 40, awayTeamId: 42 },
  publishRound: 'EARLY',
  snapshot: {
    form_snapshot: { home: [{ venue: 'H', result: 'W', goalsFor: 2, goalsAgainst: 0, xgFor: 1.87, xgAgainst: 0.45 }], away: [] },
    xg_snapshot: { home: { matches: 1, xgFor: 1.87, xgAgainst: 0.45 }, away: null },
    injury_snapshot: [{ team_id: 42, player_id: 1, player_name: 'B. Saka', type: 'Missing Fixture', reason: 'Injury' }],
    lineup_snapshot: [],
    api_prediction_snapshot: null,
    model_snapshot: { modelSource: 'DC', prices: [{ model: 'dixon-coles-v0.2', market: 'MATCH_WINNER', selection: 'HOME', line: null, p: 0.52 }], impact: null },
    candidates_snapshot: [
      { market: 'ASIAN_HANDICAP', selection: 'AWAY', line: 0.75, odds: 1.95, model: 0.634, market_p: 0.55, edge: 0.084, rank: 1, reasons: [] },
      { market: 'OVER_UNDER', selection: 'UNDER', line: 2.5, odds: 2.05, model: 0.5, market_p: 0.48, edge: 0.02, rank: null, reasons: ['EDGE_TOO_SMALL'] },
    ],
  },
};

describe('buildShadowInput', () => {
  const { input, candidates } = buildShadowInput(source);
  it('indexes candidates with readable labels and hides nothing the AI needs', () => {
    expect(candidates.map((c) => c.label)).toEqual(['Arsenal +0.75', 'Under 2.5']);
    const c = (input.candidates as Array<Record<string, unknown>>)[1]!;
    expect(c.rule_rejections).toEqual(['EDGE_TOO_SMALL']);
    expect((input.injuries as Array<Record<string, unknown>>)[0]).toMatchObject({ team: 'AWAY', player: 'B. Saka' });
    expect(input.api_prediction).toBeNull();
    expect(input.confirmed_lineup).toBeNull();
  });
  it('does not reveal which candidate the rules picked', () => {
    expect(JSON.stringify(input)).not.toMatch(/"rank"|rules_pick|kind/);
  });
});

describe('inventedNumbers', () => {
  const allowed = allowedNumbers(buildShadowInput(source).input);
  it('accepts numbers from the input, incl. probabilities written as percents and signed lines', () => {
    expect(inventedNumbers('โมเดลให้ 63% ตลาดให้ 55% ราคา 1.95 กับ Arsenal +0.75 xG 1.87', allowed)).toEqual([]);
    expect(inventedNumbers('63.4% และ 2 ทีม 1 ประตู', allowed)).toEqual([]);
  });
  it('flags numbers that are not in the input', () => {
    expect(inventedNumbers('โอกาสชนะ 72%', allowed)).toEqual(['72%']);
    expect(inventedNumbers('ราคา 2.40', allowed)).toEqual(['2.40']);
    expect(inventedNumbers('ยิงมา 17 ลูก', allowed)).toEqual(['17']);
  });
});

describe('validateShadowOutput', () => {
  const { input, candidates } = buildShadowInput(source);
  const good = {
    data_issues: [],
    conflicts_th: ['โมเดลกับตลาดเห็นต่างกันเล็กน้อย'],
    ranking: [
      { candidate_index: 0, support: 'HIGH', reason_th: 'โมเดล 63% สูงกว่าตลาด 55%' },
      { candidate_index: 1, support: 'LOW', reason_th: 'ข้อมูลไม่ชัด' },
    ],
    no_clear_signal: false,
    top_pick_index: 0,
    explanation_th: 'Arsenal ขาด B. Saka แต่ข้อมูลยังชี้ไปที่ 🧱 กำแพง +0.75',
  };

  it('maps indices back to selections', () => {
    const v = validateShadowOutput(good, input, candidates);
    expect(v.ok).toBe(true);
    expect(v.pick).toMatchObject({ market: 'ASIAN_HANDICAP', selection: 'AWAY', line: 0.75 });
    expect(v.ranking[0]).toMatchObject({ label: 'Arsenal +0.75', support: 'HIGH' });
  });

  it('accepts 🌫️ (top index ignored)', () => {
    const v = validateShadowOutput({ ...good, no_clear_signal: true, top_pick_index: -1 }, input, candidates);
    expect(v.ok).toBe(true);
    expect(v.pick).toBeNull();
    expect(v.noClearSignal).toBe(true);
  });

  it('rejects invented numbers, banned words, bad indices and broken schema', () => {
    expect(validateShadowOutput({ ...good, explanation_th: 'โอกาส 72% ต้องแทง' }, input, candidates).violations).toEqual([
      'banned word "แทง"',
      'number not in input: 72%',
    ]);
    expect(validateShadowOutput({ ...good, top_pick_index: 5 }, input, candidates).violations).toEqual(['top_pick_index 5 is not a candidate']);
    expect(validateShadowOutput({ ...good, ranking: [good.ranking[1]], top_pick_index: 0 }, input, candidates).violations).toEqual([
      'top pick 0 is missing from the ranking',
    ]);
    expect(validateShadowOutput({ ...good, ranking: [{ ...good.ranking[0], candidate_index: 9 }] }, input, candidates).ok).toBe(false);
    const broken = validateShadowOutput({ ranking: 'x' }, input, candidates);
    expect(broken.ok).toBe(false);
    expect(broken.violations[0]).toMatch(/^schema:/);
  });
});
