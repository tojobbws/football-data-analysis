import { describe, expect, it } from 'vitest';
import { classifyMarket, impliedProbabilities, normaliseOdds, parseLine, parseSelection, type OddsItem } from '../src/index.js';

describe('parseLine', () => {
  it('parses simple and quarter lines', () => {
    expect(parseLine('-0.5')).toBe(-0.5);
    expect(parseLine('+0.75')).toBe(0.75);
    expect(parseLine('0')).toBe(0);
    expect(parseLine('-0, -0.5')).toBe(-0.25);
    expect(parseLine('-1,-1.5')).toBe(-1.25);
  });
  it('rejects garbage and non-quarter values', () => {
    expect(parseLine('abc')).toBeNull();
    expect(parseLine('0.3')).toBeNull();
  });
});

describe('parseSelection', () => {
  it('1X2', () => {
    expect(parseSelection('MATCH_WINNER', 'Home')).toEqual({ selection: 'HOME', line: null, homeLine: null });
    expect(parseSelection('MATCH_WINNER', 'Draw')?.selection).toBe('DRAW');
    expect(parseSelection('MATCH_WINNER', 'Away')?.selection).toBe('AWAY');
  });
  it('Asian Handicap: API quotes both sides with the HOME line', () => {
    expect(parseSelection('ASIAN_HANDICAP', 'Home -0.75')).toEqual({ selection: 'HOME', line: -0.75, homeLine: -0.75 });
    // "Away -0.75" is the other side of home -0.75 -> away +0.75
    expect(parseSelection('ASIAN_HANDICAP', 'Away -0.75')).toEqual({ selection: 'AWAY', line: 0.75, homeLine: -0.75 });
    expect(parseSelection('ASIAN_HANDICAP', 'Away +0.25')).toEqual({ selection: 'AWAY', line: -0.25, homeLine: 0.25 });
    expect(parseSelection('ASIAN_HANDICAP', 'Away +0')).toEqual({ selection: 'AWAY', line: 0, homeLine: 0 });
    expect(parseSelection('ASIAN_HANDICAP', 'Home +0')).toEqual({ selection: 'HOME', line: 0, homeLine: 0 });
    expect(parseSelection('ASIAN_HANDICAP', 'Draw')).toBeNull();
  });
  it('Over/Under', () => {
    expect(parseSelection('OVER_UNDER', 'Over 2.5')).toEqual({ selection: 'OVER', line: 2.5, homeLine: null });
    expect(parseSelection('OVER_UNDER', 'Under 3.25')).toEqual({ selection: 'UNDER', line: 3.25, homeLine: null });
    expect(parseSelection('OVER_UNDER', 'Over')).toBeNull();
  });
});

describe('classifyMarket', () => {
  it('maps API bet names', () => {
    expect(classifyMarket('Match Winner')).toBe('MATCH_WINNER');
    expect(classifyMarket('Asian Handicap')).toBe('ASIAN_HANDICAP');
    expect(classifyMarket('Goals Over/Under')).toBe('OVER_UNDER');
    expect(classifyMarket('Both Teams Score')).toBe('OTHER');
  });
});

describe('normaliseOdds', () => {
  const item: OddsItem = {
    league: { id: 39, season: 2026 },
    fixture: { id: 1001 },
    update: '2026-10-06T10:00:00+00:00',
    bookmakers: [
      {
        id: 8,
        name: 'Bet365',
        bets: [
          { id: 1, name: 'Match Winner', values: [{ value: 'Home', odd: '1.90' }, { value: 'Draw', odd: '3.60' }, { value: 'Away', odd: '4.20' }] },
          { id: 4, name: 'Asian Handicap', values: [{ value: 'Home -0.5', odd: '1.92' }, { value: 'Away -0.5', odd: '1.98' }, { value: 'Weird', odd: '2.0' }] },
          { id: 5, name: 'Goals Over/Under', values: [{ value: 'Over 2.5', odd: '1.85' }, { value: 'Under 2.5', odd: 'n/a' }] },
          { id: 8, name: 'Both Teams Score', values: [{ value: 'Yes', odd: '1.70' }] },
        ],
      },
    ],
  };

  it('keeps only configured markets and reports unparseable values', () => {
    const { rows, skipped } = normaliseOdds(item);
    expect(rows).toHaveLength(6);
    expect(skipped).toHaveLength(2);
    expect(rows.every((r) => r.sourceUpdatedAt === '2026-10-06T10:00:00.000Z')).toBe(true);
    const away = rows.find((r) => r.rawValue === 'Away -0.5');
    expect(away).toMatchObject({ market: 'ASIAN_HANDICAP', selection: 'AWAY', line: 0.5, homeLine: -0.5, odds: 1.98 });
  });

  it('filters markets', () => {
    const { rows } = normaliseOdds(item, ['OVER_UNDER']);
    expect(rows.map((r) => r.rawValue)).toEqual(['Over 2.5']);
  });
});

describe('impliedProbabilities', () => {
  it('removes the bookmaker margin', () => {
    const { probabilities, overround } = impliedProbabilities([1.9, 3.6, 4.2]);
    expect(probabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(overround).toBeGreaterThan(0);
    expect(probabilities[0]).toBeGreaterThan(probabilities[2]!);
  });
  it('throws on invalid input', () => {
    expect(() => impliedProbabilities([1.5])).toThrow();
    expect(() => impliedProbabilities([1, 2])).toThrow();
  });
});
