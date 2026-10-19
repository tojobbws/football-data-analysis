import { describe, expect, it } from 'vitest';
import {
  computeElo,
  dcWalkForward,
  eloWalkForward,
  expectedGoals,
  fitDixonColes,
  matchContexts,
  scoreMatrix,
  sortByTime,
  type MatchRecord,
} from '../src/index.js';

/**
 * A pre-match number may only use matches that kicked off before it. Each test builds the same
 * history twice, once with the matches from `asOf` on replaced by wildly different results, and
 * the output must not move. A model that peeked at a later result would.
 */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function history(seed = 11): MatchRecord[] {
  const r = rng(seed);
  const out: MatchRecord[] = [];
  let t = Date.UTC(2024, 0, 1);
  for (let round = 0; round < 12; round++) {
    for (let h = 0; h < 8; h++) {
      const a = (h + 1 + (round % 7)) % 8;
      if (a === h) continue;
      out.push({
        homeTeamId: 200 + h,
        awayTeamId: 200 + a,
        homeGoals: Math.floor(r() * 4),
        awayGoals: Math.floor(r() * 3),
        kickoffAt: new Date(t + h * 3_600_000),
        homeXg: r() * 3,
        awayXg: r() * 2,
      });
    }
    t += 7 * 86_400_000;
  }
  return out;
}

/** Same matches, but everything kicking off at or after `asOf` gets absurd results and xG. */
function scrambleFrom(ms: readonly MatchRecord[], asOf: Date): MatchRecord[] {
  return ms.map((m) => (m.kickoffAt.getTime() >= asOf.getTime() ? { ...m, homeGoals: 9, awayGoals: 0, homeXg: 8, awayXg: 0, redCardMinute: 1 } : m));
}

const all = history();
const asOf = all[Math.floor(all.length * 0.7)]!.kickoffAt;

describe('no data from the future', () => {
  it('Dixon-Coles fit ignores matches at or after asOf', () => {
    const a = fitDixonColes(all, asOf);
    const b = fitDixonColes(scrambleFrom(all, asOf), asOf);
    expect(b.rho).toBe(a.rho);
    expect(b.homeAdv).toBe(a.homeAdv);
    for (const [team, v] of a.attack) expect(b.attack.get(team)).toBe(v);
    for (const [team, v] of a.defence) expect(b.defence.get(team)).toBe(v);
  });

  it('a match kicking off exactly at asOf is not used', () => {
    const edge = all.filter((m) => m.kickoffAt.getTime() === asOf.getTime());
    expect(edge.length).toBeGreaterThan(0);
    const without = all.filter((m) => m.kickoffAt.getTime() < asOf.getTime());
    const a = fitDixonColes(all, asOf);
    const b = fitDixonColes(without, asOf);
    expect(b.homeAdv).toBe(a.homeAdv);
  });

  it('expected goals and the scoreline matrix do not move', () => {
    const a = fitDixonColes(all, asOf);
    const b = fitDixonColes(scrambleFrom(all, asOf), asOf);
    const ga = expectedGoals(a, 200, 203);
    const gb = expectedGoals(b, 200, 203);
    expect(gb).toEqual(ga);
    expect(scoreMatrix(gb.lambda, gb.mu, b.rho)).toEqual(scoreMatrix(ga.lambda, ga.mu, a.rho));
  });

  it('Elo ratings ignore matches at or after asOf', () => {
    const a = computeElo(all, asOf);
    const b = computeElo(scrambleFrom(all, asOf), asOf);
    expect([...b.ratings]).toEqual([...a.ratings]);
  });

  it('walk-forward Dixon-Coles for match i is unchanged when later results change', () => {
    const sorted = sortByTime(all);
    const cut = Math.floor(sorted.length * 0.7);
    const pa = dcWalkForward(sorted, { warmupMatches: 20 });
    const pb = dcWalkForward(scrambleFrom(sorted, sorted[cut]!.kickoffAt), { warmupMatches: 20 });
    // predictions are aligned from index `warmup`; every match before the cut sees the same past
    for (let i = 0; i < cut - 20; i++) expect(pb[i]).toEqual(pa[i]);
  });

  it('walk-forward Elo and base rates for match i are unchanged when later results change', () => {
    const sorted = sortByTime(all);
    const cut = Math.floor(sorted.length * 0.7);
    const scrambled = scrambleFrom(sorted, sorted[cut]!.kickoffAt);
    const ca = matchContexts(sorted, 20);
    const cb = matchContexts(scrambled, 20);
    const ea = eloWalkForward(sorted, ca);
    const eb = eloWalkForward(scrambled, cb);
    for (let i = 0; i < cut - 20; i++) {
      expect(cb[i]!.base).toEqual(ca[i]!.base);
      expect(cb[i]!.baseOver25).toBe(ca[i]!.baseOver25);
      expect(eb[i]).toEqual(ea[i]);
    }
  });
});
