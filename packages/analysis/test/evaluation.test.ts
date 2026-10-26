import { describe, expect, it } from 'vitest';
import {
  benchmarkVerdict,
  clusteredMean,
  clusterSums,
  fairBrier,
  fairLogLoss,
  fairProbability,
  fairTarget,
  holmAdjust,
  normalCdf,
  pairedComparison,
  settle,
  twoSidedP,
  summarizeBenchmarkDays,
  type BenchmarkDay,
  type MarketSelection,
  type Outcome,
} from '../src/index.js';

describe('fairTarget', () => {
  it('scores every settlement outcome; push and void are left out', () => {
    expect(fairTarget('WIN')).toEqual({ weight: 1, y: 1 });
    expect(fairTarget('HALF_WIN')).toEqual({ weight: 0.5, y: 1 });
    expect(fairTarget('PUSH')).toBeNull();
    expect(fairTarget('HALF_LOSS')).toEqual({ weight: 0.5, y: 0 });
    expect(fairTarget('LOSS')).toEqual({ weight: 1, y: 0 });
    expect(fairTarget('VOID')).toBeNull();
    expect(fairTarget('PENDING')).toBeNull();
    expect(fairTarget(null)).toBeNull();
  });

  it('its weighted mean is the fair hit rate (W + ½HW) / (W + L + ½(HW + HL))', () => {
    const outcomes: Outcome[] = ['WIN', 'WIN', 'HALF_WIN', 'PUSH', 'HALF_LOSS', 'LOSS', 'LOSS', 'LOSS'];
    const ts = outcomes.map(fairTarget).filter((t) => t !== null);
    const hit = ts.reduce((a, t) => a + t.weight * t.y, 0) / ts.reduce((a, t) => a + t.weight, 0);
    expect(hit).toBeCloseTo((2 + 0.5) / (2 + 3 + 0.5 * 2), 12);
  });

  it('is the target of the fair probability: expected weighted result = p over a whole score matrix', () => {
    // a quarter line over a toy distribution of margins: E[w·y] / E[w] must equal fairProbability
    const sel: MarketSelection = { market: 'ASIAN_HANDICAP', selection: 'HOME', line: -0.75 };
    const scores: Array<[number, number, number]> = [
      [0, 0, 0.1],
      [1, 0, 0.25],
      [2, 0, 0.2],
      [0, 1, 0.15],
      [1, 1, 0.2],
      [3, 1, 0.1],
    ];
    const d = { win: 0, halfWin: 0, push: 0, halfLoss: 0, loss: 0 };
    let ew = 0;
    let ewy = 0;
    for (const [h, a, p] of scores) {
      const o = settle(sel, h, a);
      d[({ WIN: 'win', HALF_WIN: 'halfWin', PUSH: 'push', HALF_LOSS: 'halfLoss', LOSS: 'loss' } as const)[o]] += p;
      const t = fairTarget(o);
      if (t) {
        ew += p * t.weight;
        ewy += p * t.weight * t.y;
      }
    }
    expect(ewy / ew).toBeCloseTo(fairProbability(d), 12);
  });

  it('Brier and log loss', () => {
    expect(fairBrier(0.6, { weight: 1, y: 1 })).toBeCloseTo(0.16, 12);
    expect(fairBrier(0.6, { weight: 0.5, y: 0 })).toBeCloseTo(0.36, 12);
    expect(fairLogLoss(0.6, { weight: 1, y: 1 })).toBeCloseTo(-Math.log(0.6), 12);
    expect(fairLogLoss(0.6, { weight: 1, y: 0 })).toBeCloseTo(-Math.log(0.4), 12);
  });
});

describe('clusteredMean', () => {
  it('weighted mean and CR1 standard error by cluster', () => {
    const c = clusterSums([
      { cluster: 'd1', value: 1 },
      { cluster: 'd1', value: 0 },
      { cluster: 'd2', value: 1, weight: 0.5 },
      { cluster: 'd3', value: 0 },
    ]);
    const m = clusteredMean(c);
    expect(m).toMatchObject({ n: 4, clusters: 3, weight: 3.5 });
    expect(m.mean).toBeCloseTo(1.5 / 3.5, 12);
    // residuals per day: d1 1 - m·2, d2 0.5 - m·0.5, d3 0 - m·1
    const mean = 1.5 / 3.5;
    const ss = (1 - 2 * mean) ** 2 + (0.5 - 0.5 * mean) ** 2 + mean ** 2;
    expect(m.se).toBeCloseTo(Math.sqrt(1.5 * ss) / 3.5, 12);
    expect(m.lo).toBeCloseTo(m.mean! - 1.959964 * m.se!, 12);
  });

  it('one row per cluster is the usual standard error of a mean (with the G/(G-1) correction)', () => {
    const xs = [0.2, 0.5, 0.1, 0.9, 0.4];
    const m = clusteredMean(clusterSums(xs.map((x, i) => ({ cluster: String(i), value: x }))));
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (xs.length - 1));
    expect(m.se).toBeCloseTo(sd / Math.sqrt(xs.length), 12);
  });

  it('clustering widens the interval when a day moves together', () => {
    const rows = [
      ...Array.from({ length: 10 }, () => ({ cluster: 'a', value: 1 })),
      ...Array.from({ length: 10 }, () => ({ cluster: 'b', value: 0 })),
      ...Array.from({ length: 10 }, () => ({ cluster: 'c', value: 1 })),
      ...Array.from({ length: 10 }, () => ({ cluster: 'd', value: 0 })),
    ];
    const clustered = clusteredMean(clusterSums(rows));
    const independent = clusteredMean(clusterSums(rows.map((r, i) => ({ ...r, cluster: String(i) }))));
    expect(clustered.mean).toBe(0.5);
    expect(clustered.se!).toBeGreaterThan(independent.se! * 2);
  });

  it('no interval from fewer than two clusters; empty input has no mean', () => {
    expect(clusteredMean(clusterSums([{ cluster: 'x', value: 1 }]))).toMatchObject({ mean: 1, se: null, lo: null });
    expect(clusteredMean([])).toMatchObject({ n: 0, mean: null });
  });

  it('rows with zero weight (push) are dropped', () => {
    expect(clusterSums([{ cluster: 'x', value: 1, weight: 0 }])).toEqual([]);
  });
});

describe('p-values and Holm', () => {
  it('normal CDF', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 6);
    expect(normalCdf(-1.959964)).toBeCloseTo(0.025, 6);
  });

  it('two-sided p of a mean', () => {
    expect(twoSidedP({ mean: 1.959964, se: 1 })).toBeCloseTo(0.05, 5);
    expect(twoSidedP({ mean: 1, se: null })).toBeNull();
  });

  it('Holm keeps order, is monotone and caps at 1', () => {
    const ps: Array<number | null> = [0.01, 0.04, null, 0.03];
    const adj = holmAdjust(ps);
    expect(adj[2]).toBeNull();
    // sorted 0.01, 0.03, 0.04 -> 3·0.01, max(0.03, 2·0.03), max(0.06, 1·0.04)
    [0.03, 0.06, null, 0.06].forEach((v, i) => (v === null ? null : expect(adj[i]).toBeCloseTo(v, 12)));
    expect(holmAdjust([0.5, 0.6])).toEqual([1, 1]);
  });
});

describe('benchmarkVerdict', () => {
  const at = (mean: number, se: number, n = 500, clusters = 30) => ({ n, clusters, weight: n, mean, se, lo: mean - 1.959964 * se, hi: mean + 1.959964 * se });

  it('needs enough rows and days before concluding anything', () => {
    expect(benchmarkVerdict(at(0.05, 0.001, 99))).toBe('INSUFFICIENT_EVIDENCE');
    expect(benchmarkVerdict(at(0.05, 0.001, 500, 19))).toBe('INSUFFICIENT_EVIDENCE');
    expect(benchmarkVerdict({ ...at(0, 0), mean: null, se: null })).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('sign convention: model loss minus market loss', () => {
    expect(benchmarkVerdict(at(0.02, 0.005))).toBe('MARKET_BETTER');
    expect(benchmarkVerdict(at(-0.02, 0.005))).toBe('MODEL_BETTER');
    expect(benchmarkVerdict(at(0.002, 0.005))).toBe('NO_CLEAR_DIFFERENCE');
  });

  it('with an adjusted p the adjustment decides, not the raw interval', () => {
    expect(benchmarkVerdict(at(0.02, 0.005), { pAdjusted: 0.2 })).toBe('NO_CLEAR_DIFFERENCE');
    expect(benchmarkVerdict(at(0.02, 0.005), { pAdjusted: 0.01 })).toBe('MARKET_BETTER');
    expect(benchmarkVerdict(at(0.02, 0.005), { pAdjusted: null })).toBe('NO_CLEAR_DIFFERENCE');
  });
});

describe('pairedComparison', () => {
  it('scores both sides on the same rows; the difference is model minus market', () => {
    const r = pairedComparison([
      { cluster: 'd1', weight: 1, model: 0.3, market: 0.2 },
      { cluster: 'd1', weight: 0.5, model: 0.1, market: 0.2 },
      { cluster: 'd2', weight: 1, model: 0.25, market: 0.25 },
    ]);
    expect(r.model.mean).toBeCloseTo((0.3 + 0.05 + 0.25) / 2.5, 12);
    expect(r.market.mean).toBeCloseTo((0.2 + 0.1 + 0.25) / 2.5, 12);
    expect(r.diff.mean).toBeCloseTo(r.model.mean! - r.market.mean!, 12);
  });
});

describe('summarizeBenchmarkDays', () => {
  const d = (day: string, n: number, bm: number, bk: number, extra: Partial<BenchmarkDay> = {}): BenchmarkDay => ({
    day, n, w: n, wScored: n, brierModel: bm, brierMarket: bk, logLossModel: null, logLossMarket: null, hit: null, pModel: null, pMarket: null, clvN: 0, clvSum: null, ...extra,
  });

  it('means are total sums over total weight; the difference is clustered by day', () => {
    const s = summarizeBenchmarkDays([d('2026-10-20', 2, 0.6, 0.5), d('2026-10-21', 3, 0.6, 0.6), d('2026-10-22', 1, 0.1, 0.2)]);
    expect(s).toMatchObject({ n: 6, days: 3, from: '2026-10-20', to: '2026-10-22' });
    expect(s.brier.model.mean).toBeCloseTo(1.3 / 6, 12);
    expect(s.brier.market.mean).toBeCloseTo(1.3 / 6, 12);
    expect(s.brier.diff.mean).toBeCloseTo(0, 12);
    expect(s.brier.diff.clusters).toBe(3);
    expect(s.verdict).toBe('INSUFFICIENT_EVIDENCE'); // 6 rows over 3 days is far below the floor
  });

  it('hit uses every decided row, probabilities only the scored ones; CLV has its own count', () => {
    const s = summarizeBenchmarkDays([
      d('a', 4, 1, 1, { w: 3.5, wScored: 3, hit: 2, pModel: 1.8, pMarket: 1.5, clvN: 4, clvSum: 0.04 }),
      d('b', 2, 0.5, 0.5, { w: 2, wScored: 2, hit: 1, pModel: 1.1, pMarket: 1, clvN: 1, clvSum: -0.01 }),
    ]);
    expect(s.hit.mean).toBeCloseTo(3 / 5.5, 12);
    expect(s.pModel.mean).toBeCloseTo(2.9 / 5, 12);
    expect(s.pMarket.mean).toBeCloseTo(2.5 / 5, 12);
    expect(s.clv.mean).toBeCloseTo(0.03 / 5, 12);
  });

  it('a clearly worse model over enough days is MARKET_BETTER', () => {
    const days = Array.from({ length: 25 }, (_, i) => d(`d${i}`, 10, 2.6 + (i % 3) * 0.01, 2.5));
    expect(summarizeBenchmarkDays(days).verdict).toBe('MARKET_BETTER');
  });
});
