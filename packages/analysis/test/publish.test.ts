import { describe, expect, it } from 'vitest';
import { buildReason, publishRoundFor, selectionLabel } from '../src/index.js';

describe('selectionLabel', () => {
  it('formats every market', () => {
    expect(selectionLabel('ASIAN_HANDICAP', 'AWAY', 0.75, 'Liverpool', 'Arsenal')).toBe('Arsenal +0.75');
    expect(selectionLabel('ASIAN_HANDICAP', 'HOME', -0.5, 'Liverpool', 'Arsenal')).toBe('Liverpool -0.5');
    expect(selectionLabel('ASIAN_HANDICAP', 'HOME', 0, 'Liverpool', 'Arsenal')).toBe('Liverpool 0');
    expect(selectionLabel('MATCH_WINNER', 'HOME', null, 'Liverpool', 'Arsenal')).toBe('Liverpool ชนะ');
    expect(selectionLabel('MATCH_WINNER', 'DRAW', null, 'Liverpool', 'Arsenal')).toBe('เสมอ');
    expect(selectionLabel('OVER_UNDER', 'UNDER', 3.5, 'Liverpool', 'Arsenal')).toBe('Under 3.5');
  });
});

describe('buildReason', () => {
  it('signal: numbers come from inputs, brand terms used, no gambling words', () => {
    const text = buildReason({
      kind: 'SIGNAL',
      round: 'LINEUP',
      home: 'Liverpool',
      away: 'Arsenal',
      pick: { label: 'Arsenal +0.75', modelProbability: 0.63, marketProbability: 0.55, odds: 1.95, nBookmakers: 8, strength: 'STRONG', agreement: true, gateZ: 2.4, modelSource: 'DC+IMPACT' },
      impact: {
        home: { attackLoss: 0.31, defenceLoss: 0.02, missing: [{ name: 'M. Salah', attackShare: 0.31, defenceShare: 0.02, weight: 1 }] },
        away: { attackLoss: 0, defenceLoss: 0, missing: [] },
      },
      marketMove: { opening: 2.05, current: 1.95 },
    });
    expect(text).toContain('🧭 เข็มทิศเกม: Arsenal +0.75');
    expect(text).toContain('63.0%');
    expect(text).toContain('55.0%');
    expect(text).toContain('+8.0 จุด');
    expect(text).toContain('🤝');
    expect(text).toContain('Liverpool ขาด M. Salah (พลังรุก −31%)');
    expect(text).toContain('📈');
    expect(text).toContain('z = 2.4');
    for (const banned of ['ทีเด็ด', 'แทง', 'กำไร', 'การันตี']) expect(text).not.toContain(banned);
  });

  it('no signal: explains the top reasons in Thai', () => {
    const text = buildReason({ kind: 'NO_CLEAR_SIGNAL', round: 'EARLY', home: 'A', away: 'B', rejectReasons: { EDGE_BELOW_MIN: 40, MARKET_GATED_OFF: 10, THIN_MARKET: 2 } });
    expect(text).toContain('🌫️ หมอกข้อมูล');
    expect(text).toContain('โมเดลกับตลาดมองใกล้เคียงกัน');
    expect(text).toContain('ยังไม่ผ่านการทดสอบย้อนหลัง');
    expect(text).not.toContain('ข้อมูลราคาตลาดไม่พอ');
  });
});

describe('publishRoundFor', () => {
  const ko = new Date('2026-10-18T16:30:00Z');
  const at = (minBefore: number) => new Date(ko.getTime() - minBefore * 60_000);
  it('EARLY within 24h but more than 3h before', () => {
    expect(publishRoundFor(ko, at(20 * 60), false)).toBe('EARLY');
    expect(publishRoundFor(ko, at(25 * 60), false)).toBeNull();
    expect(publishRoundFor(ko, at(2 * 60), false)).toBeNull();
  });
  it('LINEUP only with lineups, 15-80 min before', () => {
    expect(publishRoundFor(ko, at(60), true)).toBe('LINEUP');
    expect(publishRoundFor(ko, at(60), false)).toBeNull();
    expect(publishRoundFor(ko, at(10), true)).toBeNull();
  });
});
