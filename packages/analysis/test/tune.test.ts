import { describe, expect, it } from 'vitest';
import { adjustTotals, blend, pairedTest, tuneLeague, walkForwardBacktest, Z_90, type MatchRecord } from '../src/index.js';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
function poisson(rate: number, r: () => number) {
  const L = Math.exp(-rate);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= r();
  } while (p > L);
  return k - 1;
}

/** 20 teams, 2 seasons; sides strength is real, but TOTALS are pure league noise (like real data). */
function league(seed: number): MatchRecord[] {
  const r = rng(seed);
  const strength = Array.from({ length: 20 }, () => (r() - 0.5) * 0.9);
  const out: MatchRecord[] = [];
  let t = Date.UTC(2024, 7, 1);
  for (let s = 0; s < 2; s++)
    for (let h = 0; h < 20; h++)
      for (let a = 0; a < 20; a++) {
        if (h === a) continue;
        const diff = strength[h]! - strength[a]!;
        out.push({
          homeTeamId: h + 1,
          awayTeamId: a + 1,
          homeGoals: poisson(1.45 * Math.exp(diff / 2), r),
          awayGoals: poisson(1.15 * Math.exp(-diff / 2), r),
          kickoffAt: new Date(t),
        });
        t += 18 * 3_600_000;
      }
  return out;
}

describe('adjustTotals / blend', () => {
  it('shrinks the total toward the league mean and keeps the ratio', () => {
    const g = adjustTotals({ lambda: 3, mu: 1 }, 2, 0.5);
    expect(g.lambda + g.mu).toBeCloseTo(3, 10);
    expect(g.lambda / g.mu).toBeCloseTo(3, 10);
    expect(adjustTotals({ lambda: 3, mu: 1 }, 2, 0)).toEqual({ lambda: 3, mu: 1 });
  });
  it('blend is a convex combination', () => {
    const b = blend([0.6, 0.2, 0.2], [0.2, 0.3, 0.5], 0.5);
    expect(b[0] + b[1] + b[2]).toBeCloseTo(1, 10);
    expect(b[0]).toBeCloseTo(0.4, 10);
  });
});

describe('pairedTest', () => {
  it('detects a consistent improvement and ignores noise', () => {
    const ref = Array.from({ length: 200 }, (_, i) => 1 + ((i * 37) % 11) / 10);
    const better = ref.map((x, i) => x - 0.05 + (((i * 13) % 7) - 3) / 100);
    expect(pairedTest(better, ref).z).toBeGreaterThan(Z_90);
    const noisy = ref.map((x, i) => x + (((i * 17) % 9) - 4) / 10);
    expect(Math.abs(pairedTest(noisy, ref).z)).toBeLessThan(Z_90 * 2);
    expect(pairedTest([1], [2]).z).toBe(0);
  });
});

describe('tuneLeague', () => {
  const matches = league(21);
  const res = tuneLeague(matches, {
    warmupMatches: 150,
    grid: { priorStrength: [2, 10], halfLifeDays: [240], xgWeight: [0], totalsShrink: [0, 0.5, 1], eloK: [20], eloHomeAdvantage: [60], ensembleWeight: [0, 0.5, 1] },
  });

  it('uses a clean time split', () => {
    expect(res.tuneN + res.holdoutN).toBe(res.matchesEvaluated);
    expect(res.holdoutN).toBeGreaterThan(100);
    expect(res.combosTried).toBe(2);
  });

  it('enables sides when the model beats base rates on the holdout', () => {
    expect(res.sides.holdout.logLoss).toBeLessThan(res.sides.baselineHoldout.logLoss);
    expect(res.sides.enabled).toBe(true);
  });

  it('picks totals shrinkage when team totals are noise, and never does worse than untuned', () => {
    expect(res.totals.params.totalsShrink).toBeGreaterThan(0);
    expect(res.totals.holdoutBrier).toBeLessThanOrEqual(res.totals.untunedHoldoutBrier! + 0.002);
  });

  it('ensemble weight comes from the grid and Elo is only blended in when significantly better on tune split', () => {
    expect([0, 0.5, 1]).toContain(res.ensemble.weight);
    if (res.ensemble.weight < 1) expect(res.ensemble.tuneTestVsDc.z).toBeGreaterThanOrEqual(Z_90);
    else expect(res.ensemble.candidateWeight === 1 || res.ensemble.tuneTestVsDc.z < Z_90).toBe(true);
  });

  it('gates use the paired test', () => {
    expect(res.sides.enabled).toBe(res.holdoutN >= 100 && res.sides.test.z >= Z_90);
    expect(res.totals.enabled).toBe(res.holdoutN >= 100 && res.totals.test.z >= Z_90);
  });

  it('disables everything when the holdout is too small', () => {
    const tiny = tuneLeague(matches.slice(0, 260), {
      warmupMatches: 150,
      minHoldout: 60,
      grid: { priorStrength: [5], halfLifeDays: [240], xgWeight: [0], totalsShrink: [0], eloK: [20], eloHomeAdvantage: [60], ensembleWeight: [0.5] },
    });
    expect(tiny.holdoutN).toBeLessThan(60);
    expect(tiny.sides.enabled || tiny.totals.enabled || tiny.ensemble.enabled).toBe(false);
  });

  it('skips the red-card step when there are no red cards', () => {
    expect(res.redCard.matchesWithRedCard).toBe(0);
    expect(res.redCard.sides.tuneTest).toBeNull();
    expect(res.sides.params.redCardDiscount).toBe(0);
    expect(res.totals.params.redCardDiscount).toBe(0);
  });

  it('keeps a red-card discount only when it is significantly better on the tune split', () => {
    // ~8% of matches: one side down to 10 men early and loses heavily (not its normal strength)
    const r = rng(5);
    const withReds = matches.map((m) => {
      if (r() > 0.08) return m;
      const homeRed = r() < 0.5;
      const big = 3 + Math.floor(r() * 3);
      return { ...m, homeGoals: homeRed ? 0 : big, awayGoals: homeRed ? big : 0, redCardMinute: 5 + Math.floor(r() * 25) };
    });
    const g = { priorStrength: [5], halfLifeDays: [240], xgWeight: [0], totalsShrink: [0.5], eloK: [20], eloHomeAdvantage: [60], ensembleWeight: [1], redCardDiscount: [0.5, 1] };
    const t = tuneLeague(withReds, { warmupMatches: 150, grid: g });
    expect(t.redCard.matchesWithRedCard).toBeGreaterThan(30);
    expect(t.redCard.sides.tuneTest).not.toBeNull();
    expect(t.sides.params.redCardDiscount).toBeGreaterThan(0);
    for (const c of [t.redCard.sides, t.redCard.totals]) {
      if (c.discount > 0) expect(c.tuneTest!.z).toBeGreaterThanOrEqual(Z_90);
      else expect(c.tuneTest!.z).toBeLessThan(Z_90);
    }
    // too little event coverage -> step skipped
    const noEvents = tuneLeague(withReds, { warmupMatches: 150, grid: g, eventsShare: 0.1 });
    expect(noEvents.redCard.sides.tuneTest).toBeNull();
    expect(noEvents.sides.params.redCardDiscount).toBe(0);
  }, 60_000); // ~21 s on its own, close to the 30 s default once the suite runs files in parallel

  it('backtest report still works with ensemble', () => {
    const rep = walkForwardBacktest(matches, { warmupMatches: 150, ensembleWeight: 0.5 });
    expect(rep.oneXTwo.ensemble.n).toBe(rep.matchesEvaluated);
  });
});

describe('tuneLeague frozen final holdout (audit A-05)', () => {
  const small = { priorStrength: [8], halfLifeDays: [365], xgWeight: [0], totalsShrink: [0, 0.5], eloK: [20], eloHomeAdvantage: [60], ensembleWeight: [1, 0.5], redCardDiscount: [] };

  // one season is enough here and keeps this file inside the test timeout next to the red-card test
  const ms = league(7).slice(0, 380);
  const frozenFrom = ms[Math.floor(ms.length * 0.8)]!.kickoffAt;
  const scrambled = ms.map((m) => (m.kickoffAt >= frozenFrom ? { ...m, homeGoals: 7, awayGoals: 0 } : m));

  it('matches from frozenFrom on choose nothing and gate nothing: changing their results changes no output', () => {
    const a = tuneLeague(ms, { warmupMatches: 100, grid: small, frozenFrom });
    const b = tuneLeague(scrambled, { warmupMatches: 100, grid: small, frozenFrom });
    expect(a.frozenN).toBe(ms.length - Math.floor(ms.length * 0.8));
    expect(b).toEqual(a);
  });

  it('without frozenFrom nothing is frozen, and the same scramble does move the holdout', () => {
    const plain = tuneLeague(scrambled, { warmupMatches: 100, grid: small });
    expect(plain.frozenN).toBe(0);
    expect(plain.sides.holdout).not.toEqual(tuneLeague(ms, { warmupMatches: 100, grid: small }).sides.holdout);
  });
});
