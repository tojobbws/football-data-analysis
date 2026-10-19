import { describe, expect, it } from 'vitest';
import { cropMatrix, matrixExpectedGoals, mostLikelyScore, priceMarkets, priceSelection, scoreMatrix, SNAPSHOT_MAX_GOALS } from '../src/index.js';

const sum = (m: number[][]) => m.reduce((s, r) => s + r.reduce((a, b) => a + b, 0), 0);
const full = scoreMatrix(1.6, 1.1, -0.08);
const stored = cropMatrix(full);

describe('stored scoreline matrix', () => {
  it('keeps the whole priced matrix, so cropping at the default size changes nothing', () => {
    expect(cropMatrix(full).flat().length).toBe(full.flat().length);
  });

  it('is (max+1) square and sums to 1', () => {
    expect(stored).toHaveLength(SNAPSHOT_MAX_GOALS + 1);
    expect(stored.every((r) => r.length === SNAPSHOT_MAX_GOALS + 1)).toBe(true);
    expect(Math.abs(sum(stored) - 1)).toBeLessThan(1e-4);
    expect(stored.flat().every((p) => p >= 0 && p <= 1)).toBe(true);
  });

  it('prices 1X2 like the full matrix and 1X2 sums to 1', () => {
    const a = (['HOME', 'DRAW', 'AWAY'] as const).map((s) => priceSelection(full, { market: 'MATCH_WINNER', selection: s }).probability);
    const b = (['HOME', 'DRAW', 'AWAY'] as const).map((s) => priceSelection(stored, { market: 'MATCH_WINNER', selection: s }).probability);
    a.forEach((p, i) => expect(Math.abs(p - b[i]!)).toBeLessThan(1e-5));
    expect(Math.abs(b.reduce((x, y) => x + y, 0) - 1)).toBeLessThan(1e-4);
  });

  it('prices over/under and handicap, quarter lines included, like the full matrix', () => {
    const a = priceMarkets(full, { ou: [2.25, 2.5, 2.75], ahHome: [-0.75, -0.25, 0.25] });
    const b = priceMarkets(stored, { ou: [2.25, 2.5, 2.75], ahHome: [-0.75, -0.25, 0.25] });
    expect(b).toHaveLength(a.length);
    a.forEach((p, i) => {
      expect(Math.abs(p.probability - b[i]!.probability)).toBeLessThan(1e-5);
      const d = b[i]!.distribution;
      expect(Math.abs(d.win + d.halfWin + d.push + d.halfLoss + d.loss - 1)).toBeLessThan(1e-4);
    });
  });

  it('over and under of one line are complementary when the line cannot push', () => {
    const over = priceSelection(stored, { market: 'OVER_UNDER', selection: 'OVER', line: 2.5 }).probability;
    const under = priceSelection(stored, { market: 'OVER_UNDER', selection: 'UNDER', line: 2.5 }).probability;
    expect(Math.abs(over + under - 1)).toBeLessThan(1e-4);
  });

  it('expected goals follow the rates and the likeliest score is a real cell', () => {
    const g = matrixExpectedGoals(stored);
    expect(g.home).toBeGreaterThan(1.4);
    expect(g.home).toBeLessThan(1.8);
    expect(g.away).toBeGreaterThan(0.95);
    expect(g.away).toBeLessThan(1.25);
    const s = mostLikelyScore(stored);
    expect(stored[s.home]![s.away]).toBe(s.probability);
  });

  it('refuses an empty matrix instead of storing NaN', () => {
    expect(() => cropMatrix([[0, 0], [0, 0]])).toThrow(/no probability mass/);
  });
});
