/**
 * The Hybrid AI's choices (ADR 0010): both sides of the main AH line (favourite / underdog) and of the main O/U
 * line, from fresh quotes known at the decision time only.
 */
import { describe, expect, it } from 'vitest';
import { hybridMarket, hybridOptions, type OddsQuote } from '../src/index.js';

const NOW = new Date('2026-10-24T08:00:00Z');
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000);

function ah(homeLine: number, home: number, away: number, books = [1, 2, 3], updatedAt = at(1)): OddsQuote[] {
  return books.flatMap((b) => [
    { bookmakerId: b, market: 'ASIAN_HANDICAP', selection: 'HOME', line: homeLine, homeLine, odds: home, updatedAt },
    { bookmakerId: b, market: 'ASIAN_HANDICAP', selection: 'AWAY', line: homeLine === 0 ? 0 : -homeLine, homeLine, odds: away, updatedAt },
  ]);
}
const ou = (line: number, over: number, under: number, books = [1, 2, 3], updatedAt = at(1)): OddsQuote[] =>
  books.flatMap((b) => [
    { bookmakerId: b, market: 'OVER_UNDER', selection: 'OVER', line, homeLine: null, odds: over, updatedAt },
    { bookmakerId: b, market: 'OVER_UNDER', selection: 'UNDER', line, homeLine: null, odds: under, updatedAt },
  ]);
const x12 = (h: number, d: number, a: number): OddsQuote[] =>
  [1, 2, 3].flatMap((b) => (['HOME', 'DRAW', 'AWAY'] as const).map((s, i) => ({ bookmakerId: b, market: 'MATCH_WINNER' as const, selection: s, line: null, homeLine: null, odds: [h, d, a][i]!, updatedAt: at(1) })));

describe('hybridMarket', () => {
  it('home giving goals: home is the favourite, away the underdog getting the same line', () => {
    const m = hybridMarket([...ah(-1.25, 2.02, 1.86), ...ah(-0.5, 1.5, 2.6), ...ou(2.75, 1.95, 1.9)], NOW);
    expect(m.ah).toMatchObject({ status: 'OK', line: -1.25, favourite: 'HOME', nBookmakers: 3 });
    const opts = hybridOptions(m);
    expect(opts.map((o) => [o.side, o.selection, o.line, o.odds])).toEqual([
      ['FAVORITE', 'HOME', -1.25, 2.02],
      ['UNDERDOG', 'AWAY', 1.25, 1.86],
      ['OVER', 'OVER', 2.75, 1.95],
      ['UNDER', 'UNDER', 2.75, 1.9],
    ]);
    // the two sides of one line are complements
    expect(opts[0]!.marketProbability + opts[1]!.marketProbability).toBeCloseTo(1, 4);
  });

  it('away giving goals: away is the favourite', () => {
    const m = hybridMarket(ah(0.75, 1.9, 1.98), NOW);
    expect(m.ah.favourite).toBe('AWAY');
    expect(m.ah.options[0]).toMatchObject({ side: 'FAVORITE', selection: 'AWAY', line: -0.75 });
    expect(m.ah.options[1]).toMatchObject({ side: 'UNDERDOG', selection: 'HOME', line: 0.75 });
  });

  it('a level line: the side the market rates higher on it is the favourite', () => {
    expect(hybridMarket(ah(0, 1.8, 2.1), NOW).ah.favourite).toBe('HOME');
    expect(hybridMarket(ah(0, 2.1, 1.8), NOW).ah.favourite).toBe('AWAY');
    // dead even on the line: the 1X2 decides; no 1X2 -> no favourite and no AH choice
    expect(hybridMarket([...ah(0, 1.95, 1.95), ...x12(3.2, 3.3, 2.3)], NOW).ah.favourite).toBe('AWAY');
    const even = hybridMarket(ah(0, 1.95, 1.95), NOW);
    expect(even.ah.status).toBe('NO_FAVOURITE');
    expect(even.ah.options).toEqual([]);
  });

  it('no choice from stale, thin or future quotes', () => {
    expect(hybridOptions(hybridMarket(ah(-0.5, 1.9, 1.95, [1, 2, 3], at(13)), NOW))).toEqual([]);
    expect(hybridMarket(ah(-0.5, 1.9, 1.95, [1, 2]), NOW).ah.status).toBe('TOO_FEW_BOOKMAKERS');
    expect(hybridOptions(hybridMarket(ah(-0.5, 1.9, 1.95, [1, 2, 3], new Date(NOW.getTime() + 60_000)), NOW))).toEqual([]);
  });
});
