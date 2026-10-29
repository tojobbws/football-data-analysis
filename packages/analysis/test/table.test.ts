/**
 * The league table as it stood before a date, rebuilt from results (hybrid input v2, gap G2): only matches that
 * kicked off before the date count, points then goal difference then goals scored, a team with no match is absent.
 */
import { describe, expect, it } from 'vitest';
import { rankAsOf, tableAsOf, type TableMatch } from '../src/table.js';

const m = (day: number, home: number, away: number, gh: number, ga: number): TableMatch => ({
  kickoffAt: new Date(Date.UTC(2026, 9, day, 15)),
  homeTeamId: home,
  awayTeamId: away,
  goalsHome: gh,
  goalsAway: ga,
});
const at = (day: number) => new Date(Date.UTC(2026, 9, day, 12));

describe('tableAsOf', () => {
  it('counts only matches that kicked off strictly before the date', () => {
    const matches = [m(1, 2, 3, 1, 0), m(8, 1, 2, 0, 2)];
    expect(tableAsOf(matches, at(8)).map((r) => r.teamId)).toEqual([2, 3]); // team 1 has not played yet
    expect(tableAsOf(matches, new Date(Date.UTC(2026, 9, 8, 15))).length).toBe(2); // kicking off at the date itself: not counted
    expect(tableAsOf(matches, at(9)).map((r) => r.teamId)).toEqual([2, 3, 1]);
  });

  it('orders by points, then goal difference, then goals scored, then team id', () => {
    const matches = [m(1, 10, 11, 2, 0), m(1, 12, 13, 3, 1), m(2, 14, 15, 1, 0), m(2, 16, 17, 1, 1)];
    const t = tableAsOf(matches, at(5));
    // 12: 3 pts gd+2 gf3 · 10: 3 pts gd+2 gf2 · 14: 3 pts gd+1 · draws 16, 17: 1 pt (tie on all: team id) · losers 13 (gd-2) and 11 (gd-2, gf0) and 15 (gd-1)
    expect(t.slice(0, 4).map((r) => r.teamId)).toEqual([12, 10, 14, 16]);
    expect(t.map((r) => r.rank)).toEqual(t.map((_, i) => i + 1));
  });

  it('gives win, draw and loss 3, 1 and 0 points and tracks played, goals for and goal difference', () => {
    const t = tableAsOf([m(1, 1, 2, 2, 0), m(2, 2, 1, 1, 1)], at(5));
    expect(t.find((r) => r.teamId === 1)).toMatchObject({ played: 2, points: 4, goalDiff: 2, goalsFor: 3 });
    expect(t.find((r) => r.teamId === 2)).toMatchObject({ played: 2, points: 1, goalDiff: -2, goalsFor: 1 });
  });

  it('is empty before the first match', () => {
    expect(tableAsOf([m(3, 1, 2, 1, 0)], at(1))).toEqual([]);
  });
});

describe('rankAsOf', () => {
  const matches = [m(1, 2, 3, 1, 0), m(2, 3, 4, 3, 0), m(8, 1, 2, 0, 2)];
  it('is the position and table size before the date', () => {
    expect(rankAsOf(matches, at(8), 2)).toEqual({ rank: 2, tableSize: 3, played: 1 });
    expect(rankAsOf(matches, at(15), 3)).toEqual({ rank: 2, tableSize: 4, played: 2 });
  });
  it('is null for a team that has not played yet (no position is better than a made-up one)', () => {
    expect(rankAsOf(matches, at(8), 1)).toBeNull();
    expect(rankAsOf([], at(8), 1)).toBeNull();
  });
  it('does not see a match played after the date (no future data)', () => {
    const early = rankAsOf(matches, at(4), 2)!;
    const late = rankAsOf(matches, at(15), 2)!;
    expect(early.played).toBe(1);
    expect(late.played).toBe(2);
    expect(early).not.toEqual(late);
  });
});
