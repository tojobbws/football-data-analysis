import { describe, expect, it } from 'vitest';
import { expectedValue, fairProbability, isQuarterLine, settle, settleAsian } from '../src/index.js';

describe('settleAsian', () => {
  it('half lines', () => {
    expect(settleAsian(1, -0.5)).toBe('WIN');
    expect(settleAsian(0, -0.5)).toBe('LOSS');
    expect(settleAsian(0, 0.5)).toBe('WIN');
  });
  it('whole lines push', () => {
    expect(settleAsian(1, -1)).toBe('PUSH');
    expect(settleAsian(0, 0)).toBe('PUSH');
    expect(settleAsian(2, -1)).toBe('WIN');
  });
  it('quarter lines split', () => {
    expect(isQuarterLine(-0.25)).toBe(true);
    expect(isQuarterLine(0.75)).toBe(true);
    expect(isQuarterLine(-0.5)).toBe(false);
    expect(settleAsian(0, -0.25)).toBe('HALF_LOSS'); // draw on -0.25
    expect(settleAsian(0, 0.25)).toBe('HALF_WIN'); // draw on +0.25
    expect(settleAsian(1, -0.75)).toBe('HALF_WIN'); // win by 1 on -0.75
    expect(settleAsian(2, -0.75)).toBe('WIN');
    expect(settleAsian(1, -1.25)).toBe('HALF_LOSS');
  });
});

describe('settle by market', () => {
  it('1X2', () => {
    expect(settle({ market: 'MATCH_WINNER', selection: 'DRAW' }, 1, 1)).toBe('WIN');
    expect(settle({ market: 'MATCH_WINNER', selection: 'HOME' }, 1, 1)).toBe('LOSS');
  });
  it('Asian Handicap: Arsenal (away) +0.75', () => {
    const sel = { market: 'ASIAN_HANDICAP', selection: 'AWAY', line: 0.75 } as const;
    expect(settle(sel, 1, 1)).toBe('WIN');
    expect(settle(sel, 2, 1)).toBe('HALF_LOSS');
    expect(settle(sel, 3, 1)).toBe('LOSS');
  });
  it('Over/Under incl. quarter lines', () => {
    expect(settle({ market: 'OVER_UNDER', selection: 'UNDER', line: 3.5 }, 2, 1)).toBe('WIN');
    expect(settle({ market: 'OVER_UNDER', selection: 'OVER', line: 2.5 }, 2, 1)).toBe('WIN');
    expect(settle({ market: 'OVER_UNDER', selection: 'OVER', line: 3 }, 2, 1)).toBe('PUSH');
    expect(settle({ market: 'OVER_UNDER', selection: 'OVER', line: 2.75 }, 2, 1)).toBe('HALF_WIN');
    // 2.25 = half on 2.0 + half on 2.5
    expect(settle({ market: 'OVER_UNDER', selection: 'UNDER', line: 2.25 }, 1, 1)).toBe('HALF_WIN');
    expect(settle({ market: 'OVER_UNDER', selection: 'UNDER', line: 2.25 }, 1, 0)).toBe('WIN');
    expect(settle({ market: 'OVER_UNDER', selection: 'OVER', line: 2.25 }, 2, 0)).toBe('HALF_LOSS');
    expect(settle({ market: 'OVER_UNDER', selection: 'UNDER', line: 2.25 }, 2, 1)).toBe('LOSS');
  });
});

describe('fair probability / EV', () => {
  it('excludes pushes and is EV-neutral at fair odds', () => {
    const d = { win: 0.45, halfWin: 0.1, push: 0.1, halfLoss: 0.05, loss: 0.3 };
    const p = fairProbability(d);
    expect(expectedValue(d, 1 / p)).toBeCloseTo(0, 10);
    expect(expectedValue(d, 1 / p + 0.1)).toBeGreaterThan(0);
  });
});
