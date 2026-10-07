import { describe, expect, it } from 'vitest';
import {
  computeElo,
  eloOneXTwo,
  expectedGoals,
  fitDixonColes,
  priceMarkets,
  priceSelection,
  redCardFactor,
  scoreMatrix,
  walkForwardBacktest,
  type MatchRecord,
} from '../src/index.js';

/** Deterministic RNG so tests are reproducible */
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

/** Synthetic league with KNOWN strengths: 20 teams, 3 double round-robin seasons. */
function synthLeague(seed = 7) {
  const r = rng(seed);
  const teams = Array.from({ length: 20 }, (_, i) => ({
    id: 100 + i,
    attack: Math.exp((r() - 0.5) * 0.8),
    defence: Math.exp((r() - 0.5) * 0.8),
  }));
  const c = 1.15;
  const homeAdv = 1.3;
  const matches: MatchRecord[] = [];
  let day = Date.UTC(2023, 7, 1);
  for (let season = 0; season < 3; season++) {
    for (const h of teams) {
      for (const a of teams) {
        if (h.id === a.id) continue;
        const lambda = c * h.attack * a.defence * homeAdv;
        const mu = c * a.attack * h.defence;
        matches.push({ homeTeamId: h.id, awayTeamId: a.id, homeGoals: poisson(lambda, r), awayGoals: poisson(mu, r), kickoffAt: new Date(day) });
        day += 3_600_000 * 20;
      }
    }
  }
  return { teams, matches, homeAdv, c };
}

function corr(xs: number[], ys: number[]) {
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  xs.forEach((x, i) => {
    sxy += (x - mx) * (ys[i]! - my);
    sxx += (x - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  });
  return sxy / Math.sqrt(sxx * syy);
}

describe('scoreMatrix / markets', () => {
  const matrix = scoreMatrix(1.6, 1.1, -0.05);
  it('sums to 1 and 1X2 sums to 1', () => {
    expect(matrix.flat().reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    const m = priceMarkets(matrix).filter((x) => x.market === 'MATCH_WINNER');
    expect(m.reduce((s, x) => s + x.probability, 0)).toBeCloseTo(1, 10);
  });
  it('AH 0 equals home share of decided games (draw = push)', () => {
    const h = priceSelection(matrix, { market: 'MATCH_WINNER', selection: 'HOME' }).probability;
    const a = priceSelection(matrix, { market: 'MATCH_WINNER', selection: 'AWAY' }).probability;
    const ah0 = priceSelection(matrix, { market: 'ASIAN_HANDICAP', selection: 'HOME', line: 0 }).probability;
    expect(ah0).toBeCloseTo(h / (h + a), 10);
  });
  it('two sides of a line are complementary (fair probs sum to 1)', () => {
    for (const line of [2.25, 2.5, 3]) {
      const o = priceSelection(matrix, { market: 'OVER_UNDER', selection: 'OVER', line }).probability;
      const u = priceSelection(matrix, { market: 'OVER_UNDER', selection: 'UNDER', line }).probability;
      expect(o + u).toBeCloseTo(1, 10);
    }
    const hm = priceSelection(matrix, { market: 'ASIAN_HANDICAP', selection: 'HOME', line: -0.75 }).probability;
    const ap = priceSelection(matrix, { market: 'ASIAN_HANDICAP', selection: 'AWAY', line: 0.75 }).probability;
    expect(hm + ap).toBeCloseTo(1, 10);
  });
  it('priceMarkets prices both AH sides', () => {
    const rows = priceMarkets(matrix, { ou: [2.5], ahHome: [-0.5] });
    expect(rows.map((r) => `${r.market}:${r.selection}:${r.line}`)).toEqual([
      'MATCH_WINNER:HOME:null',
      'MATCH_WINNER:DRAW:null',
      'MATCH_WINNER:AWAY:null',
      'OVER_UNDER:OVER:2.5',
      'OVER_UNDER:UNDER:2.5',
      'ASIAN_HANDICAP:HOME:-0.5',
      'ASIAN_HANDICAP:AWAY:0.5',
    ]);
  });
});

describe('fitDixonColes', () => {
  const { teams, matches, homeAdv } = synthLeague();
  const asOf = new Date(matches[matches.length - 1]!.kickoffAt.getTime() + 1);
  const model = fitDixonColes(matches, asOf, { halfLifeDays: 100_000 });

  it('recovers the true home advantage and team strengths', () => {
    expect(model.homeAdv).toBeGreaterThan(homeAdv - 0.12);
    expect(model.homeAdv).toBeLessThan(homeAdv + 0.12);
    expect(corr(teams.map((t) => Math.log(t.attack)), teams.map((t) => Math.log(model.attack.get(t.id)!)))).toBeGreaterThan(0.85);
    expect(corr(teams.map((t) => Math.log(t.defence)), teams.map((t) => Math.log(model.defence.get(t.id)!)))).toBeGreaterThan(0.85);
  });

  it('never uses matches on/after asOf', () => {
    const cut = matches[100]!.kickoffAt;
    expect(fitDixonColes(matches, cut).matchesUsed).toBe(100);
  });

  it('unknown teams fall back to average strength', () => {
    const g = expectedGoals(model, 99999, 99998);
    expect(g.lambda).toBeCloseTo(model.c * model.homeAdv, 10);
    expect(g.mu).toBeCloseTo(model.c, 10);
  });

  it('rho stays in a sane range', () => {
    expect(model.rho).toBeGreaterThanOrEqual(-0.25);
    expect(model.rho).toBeLessThanOrEqual(0.2);
  });

  it('uses xG when provided', () => {
    const withXg = matches.map((m) => ({ ...m, homeXg: 3, awayXg: 0.2 }));
    const mx = fitDixonColes(withXg, asOf, { xgWeight: 1 });
    expect(mx.c * mx.homeAdv).toBeGreaterThan(model.c * model.homeAdv * 1.5);
  });

  it('red-card discount: earlier red = less weight, off by default', () => {
    expect(redCardFactor(null, 1)).toBe(1);
    expect(redCardFactor(30, 0)).toBe(1);
    expect(redCardFactor(0, 1)).toBe(0);
    expect(redCardFactor(45, 1)).toBeCloseTo(0.5, 10);
    expect(redCardFactor(45, 0.5)).toBeCloseTo(0.75, 10);
    expect(redCardFactor(90, 1)).toBe(1);
    expect(redCardFactor(95, 1)).toBe(1);
  });

  it('down-weights matches distorted by an early red card', () => {
    // every 4th match: home side gets a red card at 5' and the score is a freak 7-0
    const distorted = matches.map((m, i) => (i % 4 === 0 ? { ...m, homeGoals: 7, awayGoals: 0, redCardMinute: 5 } : m));
    const off = fitDixonColes(distorted, asOf, { halfLifeDays: 100_000 });
    const on = fitDixonColes(distorted, asOf, { halfLifeDays: 100_000, redCardDiscount: 1 });
    const err = (x: typeof model) => Math.abs(x.c * x.homeAdv - model.c * model.homeAdv);
    expect(err(on)).toBeLessThan(err(off) / 3);
    // without red-card data the discount changes nothing
    const same = fitDixonColes(matches, asOf, { halfLifeDays: 100_000, redCardDiscount: 1 });
    expect(same.c).toBeCloseTo(model.c, 10);
    expect(same.homeAdv).toBeCloseTo(model.homeAdv, 10);
  });
});

describe('Elo', () => {
  it('stronger team gets higher rating and higher win probability', () => {
    const { teams, matches } = synthLeague(11);
    const elo = computeElo(matches, new Date('2100-01-01'));
    const strength = (t: (typeof teams)[number]) => Math.log(t.attack) - Math.log(t.defence);
    expect(corr(teams.map(strength), teams.map((t) => elo.ratings.get(t.id)!))).toBeGreaterThan(0.7);
    const best = [...teams].sort((a, b) => strength(b) - strength(a))[0]!;
    const worst = [...teams].sort((a, b) => strength(a) - strength(b))[0]!;
    const p = eloOneXTwo(elo, best.id, worst.id);
    expect(p.home + p.draw + p.away).toBeCloseTo(1, 10);
    expect(p.home).toBeGreaterThan(p.away);
  });
});

describe('walkForwardBacktest', () => {
  it('beats the base-rate baseline on data with real team differences', () => {
    const { matches } = synthLeague(3);
    const rep = walkForwardBacktest(matches, { warmupMatches: 190, refitEveryDays: 14 });
    expect(rep.matchesEvaluated).toBeGreaterThan(800);
    expect(rep.oneXTwo.dixonColes.logLoss).toBeLessThan(rep.oneXTwo.baseline.logLoss);
    expect(rep.skillVsBaseline).toBeGreaterThan(0);
    expect(rep.over25.dixonColesBrier).toBeLessThanOrEqual(rep.over25.baselineBrier + 0.005);
  }, 60_000);
});
