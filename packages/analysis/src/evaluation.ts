/**
 * Scoring the model against the market on the same target, with honest uncertainty.
 *
 *  - Fair target: a settled selection scored against its fair probability (pushes out, half results
 *    as half a stake): WIN 1 at weight 1, HALF_WIN 1 at weight ½, HALF_LOSS 0 at weight ½, LOSS 0 at
 *    weight 1, PUSH and VOID left out. The weighted mean of the result is the fair hit rate
 *    (W + ½HW) / (W + L + ½(HW + HL)), so Brier and log loss on it are proper scores of the same
 *    probability the model and a no-vig market price both state.
 *  - Matches on one football day share news, weather and market moves, so they are not independent:
 *    means come with a cluster-robust standard error grouped by football day.
 *  - Differences are model loss − market loss: below 0 the model did better, above 0 the market did.
 */
import type { Outcome } from './settlement.js';

export interface FairTarget {
  weight: number;
  /** 1 = the selection won (fully or half), 0 = it lost */
  y: 0 | 1;
}

/** null = left out of every score (PUSH, VOID, unsettled). */
export function fairTarget(outcome: Outcome | 'VOID' | 'PENDING' | null | undefined): FairTarget | null {
  switch (outcome) {
    case 'WIN':
      return { weight: 1, y: 1 };
    case 'HALF_WIN':
      return { weight: 0.5, y: 1 };
    case 'HALF_LOSS':
      return { weight: 0.5, y: 0 };
    case 'LOSS':
      return { weight: 1, y: 0 };
    default:
      return null;
  }
}

export function fairBrier(p: number, t: FairTarget): number {
  return (p - t.y) ** 2;
}

export function fairLogLoss(p: number, t: FairTarget): number {
  return -Math.log(Math.max(1e-12, t.y ? p : 1 - p));
}

/** One football day's weighted sum: `s` = Σ weight·value, `w` = Σ weight, `n` = rows. */
export interface ClusterSum {
  key: string;
  n: number;
  w: number;
  s: number;
}

export function clusterSums(rows: ReadonlyArray<{ cluster: string; weight?: number; value: number }>): ClusterSum[] {
  const by = new Map<string, ClusterSum>();
  for (const r of rows) {
    const w = r.weight ?? 1;
    if (!(w > 0) || !Number.isFinite(r.value)) continue;
    const c = by.get(r.cluster) ?? { key: r.cluster, n: 0, w: 0, s: 0 };
    c.n += 1;
    c.w += w;
    c.s += w * r.value;
    by.set(r.cluster, c);
  }
  return [...by.values()];
}

export interface ClusteredMean {
  n: number;
  clusters: number;
  /** total weight (pushes out, halves as ½) */
  weight: number;
  mean: number | null;
  /** cluster-robust standard error; null with fewer than 2 clusters */
  se: number | null;
  lo: number | null;
  hi: number | null;
}

/** 1.959964 = two-sided 95% */
export const Z_95 = 1.959964;

/**
 * Weighted mean with a cluster-robust (CR1) standard error:
 * mean = Σs / Σw,  Var = G/(G−1) · Σ_g (s_g − mean·w_g)² / (Σw)².
 */
export function clusteredMean(clusters: readonly ClusterSum[], z = Z_95): ClusteredMean {
  const used = clusters.filter((c) => c.w > 0);
  const n = used.reduce((a, c) => a + c.n, 0);
  const W = used.reduce((a, c) => a + c.w, 0);
  const G = used.length;
  if (!(W > 0)) return { n, clusters: G, weight: 0, mean: null, se: null, lo: null, hi: null };
  const mean = used.reduce((a, c) => a + c.s, 0) / W;
  if (G < 2) return { n, clusters: G, weight: W, mean, se: null, lo: null, hi: null };
  const ss = used.reduce((a, c) => a + (c.s - mean * c.w) ** 2, 0);
  const se = Math.sqrt((G / (G - 1)) * ss) / W;
  return { n, clusters: G, weight: W, mean, se, lo: mean - z * se, hi: mean + z * se };
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26, error < 1.5e-7). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(x) / Math.SQRT2));
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** Two-sided p-value of a mean against 0. */
export function twoSidedP(m: Pick<ClusteredMean, 'mean' | 'se'>): number | null {
  if (m.mean === null || m.se === null || !(m.se > 0)) return null;
  return 2 * (1 - normalCdf(Math.abs(m.mean / m.se)));
}

/** Holm step-down adjustment; keeps the input order, null stays null. */
export function holmAdjust(pValues: ReadonlyArray<number | null>): Array<number | null> {
  const idx = pValues.map((p, i) => ({ p, i })).filter((x): x is { p: number; i: number } => x.p !== null).sort((a, b) => a.p - b.p);
  const out: Array<number | null> = pValues.map(() => null);
  const m = idx.length;
  let running = 0;
  idx.forEach((x, k) => {
    running = Math.max(running, Math.min(1, (m - k) * x.p));
    out[x.i] = running;
  });
  return out;
}

export type BenchmarkVerdict = 'MODEL_BETTER' | 'MARKET_BETTER' | 'NO_CLEAR_DIFFERENCE' | 'INSUFFICIENT_EVIDENCE';

/** Below either floor nothing is concluded, whatever the interval says. Set before any result was seen (docs/audit-remediation-plan.md). */
export const BENCHMARK_MIN = { n: 100, clusters: 20 } as const;

/**
 * Verdict on a model-minus-market loss difference. With `pAdjusted` (several leagues or markets tested
 * together, e.g. Holm) the difference must be significant after adjustment at `alpha`; without it the
 * 95% interval must exclude 0.
 */
export function benchmarkVerdict(
  diff: ClusteredMean,
  opts: { pAdjusted?: number | null; alpha?: number; min?: { n: number; clusters: number } } = {},
): BenchmarkVerdict {
  const min = opts.min ?? BENCHMARK_MIN;
  if (diff.mean === null || diff.se === null || diff.n < min.n || diff.clusters < min.clusters) return 'INSUFFICIENT_EVIDENCE';
  const significant = opts.pAdjusted !== undefined ? opts.pAdjusted !== null && opts.pAdjusted <= (opts.alpha ?? 0.05) : diff.lo! > 0 || diff.hi! < 0;
  if (!significant) return 'NO_CLEAR_DIFFERENCE';
  return diff.mean < 0 ? 'MODEL_BETTER' : 'MARKET_BETTER';
}

export interface PairedRow {
  /** football day (or any grouping of dependent rows) */
  cluster: string;
  weight: number;
  model: number;
  market: number;
}

export interface PairedComparison {
  model: ClusteredMean;
  market: ClusteredMean;
  /** model − market (losses: below 0 = model better) */
  diff: ClusteredMean;
}

/** Both sides scored on the same rows, the difference clustered the same way. */
export function pairedComparison(rows: readonly PairedRow[], z = Z_95): PairedComparison {
  const at = (pick: (r: PairedRow) => number) => clusteredMean(clusterSums(rows.map((r) => ({ cluster: r.cluster, weight: r.weight, value: pick(r) }))), z);
  return { model: at((r) => r.model), market: at((r) => r.market), diff: at((r) => r.model - r.market) };
}

/** One football day of the `web_benchmark_days` view (migration 0043): sums, not means. */
export interface BenchmarkDay {
  day: string;
  n: number;
  /** fair weight of every decided row */
  w: number;
  /** the part of `w` with both a model and a market probability */
  wScored: number;
  brierModel: number | null;
  brierMarket: number | null;
  logLossModel: number | null;
  logLossMarket: number | null;
  /** Σ w·y */
  hit: number | null;
  /** Σ w·p over the scored rows */
  pModel: number | null;
  pMarket: number | null;
  clvN: number;
  clvSum: number | null;
}

export interface BenchmarkSummary {
  n: number;
  days: number;
  from: string | null;
  to: string | null;
  brier: PairedComparison;
  logLoss: PairedComparison;
  /** fair hit rate */
  hit: ClusteredMean;
  /** mean probability the model / the market gave (scored rows): set beside `hit` it is calibration in the large */
  pModel: ClusteredMean;
  pMarket: ClusteredMean;
  clv: ClusteredMean;
  /** on the Brier difference, the primary score */
  verdict: BenchmarkVerdict;
}

/** Means and day-clustered intervals from per-day sums. */
export function summarizeBenchmarkDays(days: readonly BenchmarkDay[], opts: { z?: number; min?: { n: number; clusters: number } } = {}): BenchmarkSummary {
  const z = opts.z ?? Z_95;
  const used = days.filter((d) => d.n > 0 || d.clvN > 0);
  const mean = (w: (d: BenchmarkDay) => number, s: (d: BenchmarkDay) => number | null) =>
    clusteredMean(
      used.filter((d) => w(d) > 0 && s(d) !== null).map((d) => ({ key: d.day, n: d.n, w: w(d), s: s(d)! })),
      z,
    );
  const paired = (m: (d: BenchmarkDay) => number | null, k: (d: BenchmarkDay) => number | null): PairedComparison => ({
    model: mean((d) => d.wScored, m),
    market: mean((d) => d.wScored, k),
    diff: mean((d) => d.wScored, (d) => (m(d) === null || k(d) === null ? null : m(d)! - k(d)!)),
  });
  const brier = paired((d) => d.brierModel, (d) => d.brierMarket);
  const sorted = used.map((d) => d.day).sort();
  return {
    n: used.reduce((a, d) => a + d.n, 0),
    days: used.length,
    from: sorted[0] ?? null,
    to: sorted.at(-1) ?? null,
    brier,
    logLoss: paired((d) => d.logLossModel, (d) => d.logLossMarket),
    hit: mean((d) => d.w, (d) => d.hit),
    pModel: mean((d) => d.wScored, (d) => d.pModel),
    pMarket: mean((d) => d.wScored, (d) => d.pMarket),
    clv: clusteredMean(
      used.filter((d) => d.clvN > 0 && d.clvSum !== null).map((d) => ({ key: d.day, n: d.clvN, w: d.clvN, s: d.clvSum! })),
      z,
    ),
    verdict: benchmarkVerdict(brier.diff, { min: opts.min }),
  };
}
