import { describe, expect, it } from 'vitest';
import { closingLineValue, decideSettlement, expectedValue, fairProbability, isQuarterLine, settle, settleAsian, type FixtureState } from '../src/index.js';

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

  it('AH 0: win 22%, push 28%, loss 50% -> 22 / (22 + 50) with the push left out; the push returns the stake in EV', () => {
    const d = { win: 0.22, halfWin: 0, push: 0.28, halfLoss: 0, loss: 0.5 };
    expect(d.win + d.push + d.loss).toBeCloseTo(1, 12);
    expect(fairProbability(d)).toBeCloseTo(0.22 / 0.72, 12);
    // EV at the AH 0 price 4.475: the push adds nothing either way
    expect(expectedValue(d, 4.475)).toBeCloseTo(0.22 * 3.475 - 0.5, 12);
    expect(expectedValue(d, 1 / fairProbability(d))).toBeCloseTo(0, 12);
    // the 1X2 away chance (22%) is not this view's chance (30.6%)
    expect(fairProbability(d)).not.toBeCloseTo(d.win, 2);
    // and the settlement of AH 0 agrees: away win -> WIN, draw -> PUSH, away loss -> LOSS
    const sel = { market: 'ASIAN_HANDICAP', selection: 'AWAY', line: 0 } as const;
    expect([settle(sel, 0, 1), settle(sel, 1, 1), settle(sel, 2, 1)]).toEqual(['WIN', 'PUSH', 'LOSS']);
  });
});

describe('decideSettlement (Phase 7)', () => {
  const ko = new Date('2026-10-10T19:00:00Z');
  const h = (n: number) => new Date(ko.getTime() + n * 3_600_000);
  const ah = { market: 'ASIAN_HANDICAP', selection: 'AWAY', line: 0.75, kickoffAt: ko };
  const fx = (o: Partial<FixtureState> = {}): FixtureState => ({ statusShort: 'FT', kickoffAt: ko, home: 1, away: 0, syncedAt: h(3), ...o });

  it('settles on the 90-minute score', () => {
    expect(decideSettlement(ah, fx(), h(3))).toEqual({ action: 'SETTLE', status: 'HALF_LOSS', score: '1-0' });
    expect(decideSettlement({ market: 'MATCH_WINNER', selection: 'DRAW', line: null, kickoffAt: ko }, fx({ statusShort: 'AET', home: 1, away: 1 }), h(3))).toEqual({
      action: 'SETTLE',
      status: 'WIN',
      score: '1-1',
    });
    expect(decideSettlement({ market: 'OVER_UNDER', selection: 'UNDER', line: 2.5, kickoffAt: ko }, fx({ statusShort: 'PEN', home: 2, away: 2 }), h(3))).toMatchObject({
      status: 'LOSS',
    });
  });

  it('voids cancelled / abandoned / awarded matches', () => {
    for (const s of ['CANC', 'ABD', 'AWD', 'WO']) expect(decideSettlement(ah, fx({ statusShort: s, home: null, away: null }), h(1))).toEqual({ action: 'VOID', reason: s });
  });

  it('voids a match played more than 48h after the analysed kickoff', () => {
    expect(decideSettlement(ah, fx({ kickoffAt: h(72) }), h(80))).toEqual({ action: 'VOID', reason: 'RESCHEDULED' });
    // moved by less than 48h -> settles normally
    expect(decideSettlement(ah, fx({ kickoffAt: h(20) }), h(25)).action).toBe('SETTLE');
  });

  it('waits while not finished, voids only after 48h with FRESH fixture data', () => {
    expect(decideSettlement(ah, fx({ statusShort: '2H', home: 1, away: 0 }), h(1))).toMatchObject({ action: 'WAIT' });
    expect(decideSettlement(ah, fx({ statusShort: 'PST', home: null, away: null, syncedAt: h(10) }), h(49))).toMatchObject({ action: 'WAIT' });
    // stale sync (last refreshed before the deadline) must never void
    expect(decideSettlement(ah, fx({ statusShort: 'NS', home: null, away: null, syncedAt: h(-1) }), h(200))).toMatchObject({ action: 'WAIT' });
    expect(decideSettlement(ah, fx({ statusShort: 'PST', home: null, away: null, syncedAt: h(50) }), h(50))).toEqual({ action: 'VOID', reason: 'NOT_PLAYED_PST' });
  });

  it('waits instead of guessing on missing data', () => {
    expect(decideSettlement(ah, fx({ home: null }), h(3))).toMatchObject({ action: 'WAIT' });
    expect(decideSettlement({ market: 'OTHER', selection: 'X', line: null, kickoffAt: ko }, fx(), h(3))).toMatchObject({ action: 'WAIT' });
    expect(decideSettlement({ ...ah, line: null }, fx(), h(3))).toMatchObject({ action: 'WAIT' });
  });
});

describe('closingLineValue', () => {
  it('uses the median of bookmakers and needs at least 2', () => {
    expect(closingLineValue(2.1, [2.0])).toBeNull();
    expect(closingLineValue(2.1, [1.9, 2.0, 2.4])).toEqual({ closingOdds: 2.0, clv: 0.05 });
    expect(closingLineValue(1.8, [1.9, 2.1])).toEqual({ closingOdds: 2.0, clv: -0.1 });
  });
  it('keeps closing odds even without a publish price', () => {
    expect(closingLineValue(null, [1.9, 2.1])).toEqual({ closingOdds: 2.0, clv: null });
  });
});
