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

  it('leaves 1X2 out of the candidates and keeps each index pointing at its snapshot position', () => {
    const oneXTwo = { market: 'MATCH_WINNER', selection: 'HOME', line: null, odds: 1.8, model: 0.6, market_p: 0.53, edge: 0.07, rank: null, reasons: ['MARKET_NOT_PICKABLE'] };
    const snap = source.snapshot.candidates_snapshot as unknown[];
    const withMw = buildShadowInput({ ...source, snapshot: { ...source.snapshot, candidates_snapshot: [oneXTwo, ...snap] } });
    expect(withMw.candidates.map((c) => [c.index, c.market])).toEqual([[1, 'ASIAN_HANDICAP'], [2, 'OVER_UNDER']]);
    expect((withMw.input.candidates as Array<{ index: number }>).map((c) => c.index)).toEqual([1, 2]);

    const out = { data_issues: [], conflicts_th: [], ranking: [{ candidate_index: 1, support: 'HIGH', reason_th: 'ข้อมูลชัด' }], no_clear_signal: false, top_pick_index: 1, explanation_th: 'ข้อมูลชัด' };
    expect(validateShadowOutput(out, withMw.input, withMw.candidates).pick).toMatchObject({ index: 1, market: 'ASIAN_HANDICAP' });
    const pickedMw = { ...out, ranking: [{ candidate_index: 0, support: 'HIGH', reason_th: 'ข้อมูลชัด' }], top_pick_index: 0 };
    expect(validateShadowOutput(pickedMw, withMw.input, withMw.candidates).ok).toBe(false);
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

describe('inventedNumbers: thousands separators and number formats', () => {
  const elo = allowedNumbers({ home_rating: 1474, away_rating: 1572, gap: -98, xg: 1.474, line: 2.25, big: 1234567, half: 1474.5 });
  it('reads a comma between groups of three digits as a thousands separator when that value is in the input', () => {
    expect(inventedNumbers('Elo ของเจ้าบ้าน 1,474 ส่วนทีมเยือน 1,572', elo)).toEqual([]);
    expect(inventedNumbers('ตัวเลข 1,234,567 และ 1,474.5', elo)).toEqual([]);
  });
  it('still flags a grouped number that is not in the input under either reading', () => {
    expect(inventedNumbers('Elo 1,476', elo)).toEqual(['1,476']);
    expect(inventedNumbers('Elo 1,600', elo)).toEqual(['1,600']);
    expect(inventedNumbers('รวม 1,234,568', elo)).toEqual(['1,234,568']);
  });
  it('keeps a dot as a decimal mark: 1.474 is never read as 1474', () => {
    const onlyThousand = allowedNumbers({ rating: 1474 });
    expect(inventedNumbers('xG 1.474', onlyThousand)).toEqual(['1.474']);
    expect(inventedNumbers('xG 1.474', elo)).toEqual([]);
  });
  it('keeps the decimal-comma reading it had before ("1,474" = 1.474, "2,25" = 2.25)', () => {
    const onlyDecimal = allowedNumbers({ xg: 1.474, line: 2.25 });
    expect(inventedNumbers('xG 1,474 เส้น 2,25', onlyDecimal)).toEqual([]);
  });
  it('ignores signs: negative values match their absolute value as before', () => {
    expect(inventedNumbers('ส่วนต่าง -98 และ −1,474', elo)).toEqual([]);
    expect(inventedNumbers('ส่วนต่าง -99', elo)).toEqual(['99']);
  });
  it('does not read malformed groups as thousands', () => {
    // a group of four digits is not a thousands group: the old decimal reading 1.4740 applies (not in the input)
    expect(inventedNumbers('ค่า 1,4740', allowedNumbers({ rating: 14740 }))).toEqual(['1,4740']);
    // two digits after a comma: decimal comma only
    expect(inventedNumbers('ค่า 14,74', allowedNumbers({ rating: 1474 }))).toEqual(['14,74']);
    // a broken group splits into numbers that are each checked
    expect(inventedNumbers('ค่า 12,345,67', allowedNumbers({ a: 12345, b: 67 }))).toEqual(['12,345']);
  });
  it('leaves percents and small integers as before', () => {
    expect(inventedNumbers('63% และ 2 ทีม', allowedNumbers({ p: 0.634 }))).toEqual([]);
    expect(inventedNumbers('1,000 ครั้ง', allowedNumbers({}))).toEqual([]);
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
