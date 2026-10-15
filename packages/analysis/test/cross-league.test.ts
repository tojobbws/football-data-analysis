import { describe, expect, it } from 'vitest';
import { crossLeagueExpectedGoals, crossLeagueGate, fitCrossLeague, mixScoreMatrices, scoreMatrix, UNKNOWN_LEAGUE, type MatchRecord } from '../src/index.js';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function poisson(rate: number, r: () => number): number {
  const L = Math.exp(-rate);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= r();
  } while (p > L);
  return k - 1;
}

/**
 * Two domestic leagues with the SAME internal spread, but league 1 is much stronger than league 2.
 * Domestic results alone cannot tell that (each league only plays itself); the cup can.
 */
function world(seed = 11) {
  const r = rng(seed);
  const start = Date.UTC(2025, 0, 1);
  const leagues = [
    { id: 1, strength: 1.5, teams: [10, 11, 12, 13, 14, 15] },
    { id: 2, strength: 0.67, teams: [20, 21, 22, 23, 24, 25] },
  ];
  const within = (t: number) => 1 + ((t % 10) - 2.5) * 0.08; // same pattern in both leagues
  const strength = (t: number) => leagues.find((l) => l.teams.includes(t))!.strength * within(t);
  const play = (h: number, a: number, day: number): MatchRecord => ({
    homeTeamId: h,
    awayTeamId: a,
    homeGoals: poisson(1.35 * 1.2 * strength(h) / strength(a), r),
    awayGoals: poisson(1.35 * strength(a) / strength(h), r),
    kickoffAt: new Date(start + day * 86_400_000),
  });
  const domestic = new Map<number, MatchRecord[]>();
  for (const l of leagues) {
    const ms: MatchRecord[] = [];
    let day = 0;
    for (let rep = 0; rep < 4; rep++) for (const h of l.teams) for (const a of l.teams) if (h !== a) ms.push(play(h, a, day++ % 300));
    domestic.set(l.id, ms);
  }
  const cup: MatchRecord[] = [];
  for (let i = 0; i < 40; i++) {
    const t1 = leagues[0]!.teams[i % 6]!;
    const t2 = leagues[1]!.teams[(i * 5) % 6]!;
    cup.push(i % 2 ? play(t1, t2, 10 + i * 7) : play(t2, t1, 10 + i * 7));
  }
  return { domestic, cup, asOf: new Date(start + 400 * 86_400_000) };
}

describe('fitCrossLeague', () => {
  it('learns from cup matches that one league is stronger than the other', () => {
    const { domestic, cup, asOf } = world();
    const m = fitCrossLeague(cup, domestic, asOf);
    expect(m.cupMatchesUsed).toBe(40);
    expect(m.teamLeague.get(12)).toBe(1);
    expect(m.teamLeague.get(22)).toBe(2);
    expect(m.leagueAttack.get(1)! / m.leagueAttack.get(2)!).toBeGreaterThan(1.5);
    expect(m.leagueDefence.get(1)!).toBeLessThan(m.leagueDefence.get(2)!);
    // equal within-league rank, different leagues: league-1 side is the clear favourite either way round
    const g = crossLeagueExpectedGoals(m, 22, 12);
    expect(g.mu).toBeGreaterThan(g.lambda);
    expect(g.homeLeague).toBe(2);
  });

  it('without cup matches leagues are treated as equal (offsets stay at 1)', () => {
    const { domestic, asOf } = world();
    const m = fitCrossLeague([], domestic, asOf);
    expect(m.cupMatchesUsed).toBe(0);
    expect(m.leagueAttack.size).toBe(0);
    const g = crossLeagueExpectedGoals(m, 12, 22);
    const w1 = m.within.get(1)!;
    const w2 = m.within.get(2)!;
    // only home advantage and within-league strengths matter
    const expected = (m.homeAdv * w1.attack.get(12)! * w2.defence.get(22)!) / (w2.attack.get(22)! * w1.defence.get(12)!);
    expect(g.lambda / g.mu).toBeCloseTo(expected, 9);
  });

  it('never uses matches on/after asOf, and teams without domestic data get the unknown league', () => {
    const { domestic, cup } = world();
    const early = new Date(Date.UTC(2025, 0, 1));
    const m = fitCrossLeague(cup, domestic, early);
    expect(m.cupMatchesUsed).toBe(0);
    expect(m.within.size).toBe(0);
    expect(crossLeagueExpectedGoals(m, 999, 12).homeLeague).toBe(UNKNOWN_LEAGUE);
  });
});

describe('mixScoreMatrices', () => {
  it('averages 1X2 probabilities linearly and stays a distribution', () => {
    const a = scoreMatrix(2.0, 0.8, 0);
    const b = scoreMatrix(0.9, 1.6, -0.05);
    const mix = mixScoreMatrices(a, b, 0.5);
    const home = (mx: number[][]) => mx.reduce((s, row, i) => s + row.reduce((t, p, j) => t + (i > j ? p : 0), 0), 0);
    expect(home(mix)).toBeCloseTo((home(a) + home(b)) / 2, 12);
    expect(mix.flat().reduce((s, p) => s + p, 0)).toBeCloseTo(1, 12);
  });
});

describe('crossLeagueGate', () => {
  it('tests the production mix on the most recent 30% of the cup, walk-forward, with the usual holdout minimum', () => {
    const { domestic, cup } = world();
    const opts = { dixonColes: { priorStrength: 8, halfLifeDays: 365, xgWeight: 0 }, blend: 0.5, warmupMatches: 10 };
    const g = crossLeagueGate(cup, domestic, opts);
    // 40 cup matches - 10 warm-up = 30 evaluated, last 30% = 9 in the holdout
    expect(g.holdoutN).toBe(9);
    expect(g.test.n).toBe(9);
    expect(g.enabled).toBe(false); // fewer than 100 holdout matches
    // the league gap is learnable only from the cup: the mix beats the cup base rates here
    expect(g.test.meanImprovement).toBeGreaterThan(0);
    expect(crossLeagueGate(cup, domestic, { ...opts, minHoldout: 5, zRequired: -Infinity }).enabled).toBe(true);
  });
});
