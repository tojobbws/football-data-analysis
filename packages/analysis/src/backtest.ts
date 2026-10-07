/**
 * Walk-forward evaluation: every prediction only uses matches played BEFORE it (no look-ahead).
 *
 * Produces per-match prediction records first, so the tuner can score many settings,
 * time splits and ensemble weights without refitting.
 */
import {
  adjustTotals,
  expectedGoals,
  fitDixonColes,
  scoreMatrix,
  type DixonColesModel,
  type DixonColesOptions,
  type MatchRecord,
} from './dixon-coles.js';
import { eloExpected, goalDiffMultiplier, type EloOptions } from './elo.js';
import { priceSelection } from './markets.js';
import { brier3, brierBinary, calibration, logLoss3, outcomeIndex, rps3, type CalibrationBucket, type Probs3 } from './metrics.js';

export interface WalkForwardOptions {
  warmupMatches?: number;
  refitEveryDays?: number;
}

export interface MatchContext {
  index: number;
  kickoffAt: Date;
  outcome: 0 | 1 | 2;
  totalGoals: number;
  base: Probs3;
  baseOver25: number;
}

export interface DcPrediction {
  oneXTwo: Probs3;
  /** expected goals used for the sides (lets later layers re-price, e.g. Player Impact) */
  lambda: number;
  mu: number;
  rho: number;
  /** P(over 2.5) for each requested totals shrink value */
  over25: number[];
}

export const sortByTime = <T extends MatchRecord>(xs: readonly T[]): T[] => [...xs].sort((a, b) => a.kickoffAt.getTime() - b.kickoffAt.getTime());

/** Context (outcome + base rates from the past) for every evaluated match. */
export function matchContexts(input: readonly MatchRecord[], warmup: number): MatchContext[] {
  const matches = sortByTime(input);
  const out: MatchContext[] = [];
  let h = 1;
  let d = 1;
  let a = 1;
  let over = 1;
  let n = 0;
  let j = 0;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    // add all matches strictly before this kickoff to the running base rates
    while (j < i && matches[j]!.kickoffAt.getTime() < m.kickoffAt.getTime()) {
      const p = matches[j]!;
      const o = outcomeIndex(p.homeGoals, p.awayGoals);
      if (o === 0) h++;
      else if (o === 1) d++;
      else a++;
      if (p.homeGoals + p.awayGoals > 2.5) over++;
      n++;
      j++;
    }
    if (i < warmup) continue;
    const t = h + d + a;
    out.push({
      index: i,
      kickoffAt: m.kickoffAt,
      outcome: outcomeIndex(m.homeGoals, m.awayGoals),
      totalGoals: m.homeGoals + m.awayGoals,
      base: [h / t, d / t, a / t],
      baseOver25: over / (n + 2),
    });
  }
  return out;
}

/** Dixon-Coles predictions aligned with matchContexts(). Warm-started refits. */
export function dcWalkForward(
  input: readonly MatchRecord[],
  opts: WalkForwardOptions & { dixonColes?: DixonColesOptions; totalsShrinks?: readonly number[] } = {},
): DcPrediction[] {
  const warmup = opts.warmupMatches ?? 80;
  const refitMs = (opts.refitEveryDays ?? 7) * 86_400_000;
  const shrinks = opts.totalsShrinks ?? [0];
  const matches = sortByTime(input);
  const out: DcPrediction[] = [];
  let model: DixonColesModel | null = null;
  let lastFit = -Infinity;
  for (let i = warmup; i < matches.length; i++) {
    const m = matches[i]!;
    const t = m.kickoffAt.getTime();
    if (!model || t - lastFit >= refitMs) {
      model = fitDixonColes(matches, m.kickoffAt, opts.dixonColes, model ?? undefined);
      lastFit = t;
    }
    const g = expectedGoals(model, m.homeTeamId, m.awayTeamId);
    const matrix = scoreMatrix(g.lambda, g.mu, model.rho);
    const oneXTwo: Probs3 = [
      priceSelection(matrix, { market: 'MATCH_WINNER', selection: 'HOME' }).probability,
      priceSelection(matrix, { market: 'MATCH_WINNER', selection: 'DRAW' }).probability,
      priceSelection(matrix, { market: 'MATCH_WINNER', selection: 'AWAY' }).probability,
    ];
    const over25 = shrinks.map((s) => {
      const adj = adjustTotals(g, model!.leagueMeanTotal, s);
      const mx = s ? scoreMatrix(adj.lambda, adj.mu, model!.rho) : matrix;
      return priceSelection(mx, { market: 'OVER_UNDER', selection: 'OVER', line: 2.5 }).probability;
    });
    out.push({ oneXTwo, over25, lambda: g.lambda, mu: g.mu, rho: model.rho });
  }
  return out;
}

/** Elo predictions aligned with matchContexts() (incremental, very fast). */
export function eloWalkForward(input: readonly MatchRecord[], ctxs: readonly MatchContext[], opts: EloOptions = {}): Probs3[] {
  const initial = opts.initial ?? 1500;
  const k = opts.k ?? 20;
  const hadv = opts.homeAdvantage ?? 60;
  const matches = sortByTime(input);
  const ratings = new Map<number, number>();
  const out: Probs3[] = [];
  let j = 0;
  for (const c of ctxs) {
    const m = matches[c.index]!;
    while (j < c.index && matches[j]!.kickoffAt.getTime() < m.kickoffAt.getTime()) {
      const p = matches[j]!;
      const rh = ratings.get(p.homeTeamId) ?? initial;
      const ra = ratings.get(p.awayTeamId) ?? initial;
      const exp = eloExpected(rh, ra, hadv);
      const act = p.homeGoals > p.awayGoals ? 1 : p.homeGoals < p.awayGoals ? 0 : 0.5;
      const delta = k * goalDiffMultiplier(p.homeGoals - p.awayGoals) * (act - exp);
      ratings.set(p.homeTeamId, rh + delta);
      ratings.set(p.awayTeamId, ra - delta);
      j++;
    }
    const e = eloExpected(ratings.get(m.homeTeamId) ?? initial, ratings.get(m.awayTeamId) ?? initial, hadv);
    out.push(eloToProbs(e, c.base[1]));
  }
  return out;
}

/** Same heuristic as eloOneXTwo() */
export function eloToProbs(e: number, drawRate: number): Probs3 {
  const draw = drawRate * Math.exp(-(((e - 0.5) / 0.35) ** 2));
  const home = Math.max(0.01, e - draw / 2);
  const away = Math.max(0.01, 1 - e - draw / 2);
  const s = home + away + draw;
  return [home / s, draw / s, away / s];
}

export function blend(a: Probs3, b: Probs3, w: number): Probs3 {
  return [w * a[0] + (1 - w) * b[0], w * a[1] + (1 - w) * b[1], w * a[2] + (1 - w) * b[2]];
}

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

export interface Scores {
  logLoss: number;
  brier: number;
  rps: number;
  accuracy: number;
  n: number;
}

export function score1x2(preds: readonly Probs3[], ctxs: readonly MatchContext[], idx?: readonly number[]): Scores {
  const ids = idx ?? preds.map((_, i) => i);
  let ll = 0;
  let br = 0;
  let rp = 0;
  let hit = 0;
  for (const i of ids) {
    const p = preds[i]!;
    const o = ctxs[i]!.outcome;
    ll += logLoss3(p, o);
    br += brier3(p, o);
    rp += rps3(p, o);
    const pick = p[0] >= p[1] && p[0] >= p[2] ? 0 : p[2] >= p[1] ? 2 : 1;
    hit += pick === o ? 1 : 0;
  }
  const n = Math.max(1, ids.length);
  return { logLoss: ll / n, brier: br / n, rps: rp / n, accuracy: hit / n, n: ids.length };
}

export function scoreOver25(pOver: readonly number[], ctxs: readonly MatchContext[], idx?: readonly number[]): number {
  const ids = idx ?? pOver.map((_, i) => i);
  let s = 0;
  for (const i of ids) s += brierBinary(pOver[i]!, ctxs[i]!.totalGoals > 2.5);
  return s / Math.max(1, ids.length);
}

/** Per-match losses (for paired significance tests). */
export function lossesLogLoss1x2(preds: readonly Probs3[], ctxs: readonly MatchContext[], idx: readonly number[]): number[] {
  return idx.map((i) => logLoss3(preds[i]!, ctxs[i]!.outcome));
}

export function lossesBrierOver25(pOver: readonly number[], ctxs: readonly MatchContext[], idx: readonly number[]): number[] {
  return idx.map((i) => brierBinary(pOver[i]!, ctxs[i]!.totalGoals > 2.5));
}

export interface PairedTest {
  n: number;
  /** mean(reference loss - candidate loss): > 0 means candidate is better */
  meanImprovement: number;
  se: number;
  /** meanImprovement / se */
  z: number;
}

/**
 * Paired test on per-match losses of the SAME matches.
 * Much more sensitive than comparing two averages, and tells us whether
 * an improvement could just be noise.
 */
export function pairedTest(candidate: readonly number[], reference: readonly number[]): PairedTest {
  const n = Math.min(candidate.length, reference.length);
  if (n < 2) return { n, meanImprovement: 0, se: Infinity, z: 0 };
  const d = Array.from({ length: n }, (_, i) => reference[i]! - candidate[i]!);
  const mean = d.reduce((a, b) => a + b, 0) / n;
  const variance = d.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const se = Math.sqrt(variance / n);
  return { n, meanImprovement: mean, se, z: se > 0 ? mean / se : mean > 0 ? Infinity : 0 };
}

/** One-sided 90% critical value. */
export const Z_90 = 1.2816;

// ---------------------------------------------------------------------------
// Simple report (used by `npm run model:backtest`)
// ---------------------------------------------------------------------------

export interface BacktestOptions extends WalkForwardOptions {
  dixonColes?: DixonColesOptions;
  elo?: EloOptions;
  totalsShrink?: number;
  ensembleWeight?: number;
}

export interface BacktestReport {
  matchesEvaluated: number;
  from: string | null;
  to: string | null;
  oneXTwo: { dixonColes: Scores; elo: Scores; ensemble: Scores; baseline: Scores };
  over25: { dixonColesBrier: number; baselineBrier: number };
  calibrationHomeWin: CalibrationBucket[];
  /** > 0 means Dixon-Coles beats the baseline (relative log-loss improvement) */
  skillVsBaseline: number;
}

export function walkForwardBacktest(input: readonly MatchRecord[], opts: BacktestOptions = {}): BacktestReport {
  const warmup = opts.warmupMatches ?? 80;
  const ctxs = matchContexts(input, warmup);
  const dc = dcWalkForward(input, { ...opts, warmupMatches: warmup, totalsShrinks: [opts.totalsShrink ?? 0] });
  const elo = eloWalkForward(input, ctxs, opts.elo);
  const w = opts.ensembleWeight ?? 0.5;
  const dcScores = score1x2(dc.map((p) => p.oneXTwo), ctxs);
  const base = score1x2(ctxs.map((c) => c.base), ctxs);
  return {
    matchesEvaluated: ctxs.length,
    from: ctxs[0]?.kickoffAt.toISOString() ?? null,
    to: ctxs[ctxs.length - 1]?.kickoffAt.toISOString() ?? null,
    oneXTwo: {
      dixonColes: dcScores,
      elo: score1x2(elo, ctxs),
      ensemble: score1x2(dc.map((p, i) => blend(p.oneXTwo, elo[i]!, w)), ctxs),
      baseline: base,
    },
    over25: { dixonColesBrier: scoreOver25(dc.map((p) => p.over25[0]!), ctxs), baselineBrier: scoreOver25(ctxs.map((c) => c.baseOver25), ctxs) },
    calibrationHomeWin: calibration(dc.map((p, i) => ({ p: p.oneXTwo[0], happened: ctxs[i]!.outcome === 0 })), 10),
    skillVsBaseline: ctxs.length ? 1 - dcScores.logLoss / base.logLoss : 0,
  };
}

/** League base rates from past matches (Laplace-smoothed). */
export function baseRates(past: readonly MatchRecord[]): { p: Probs3; over25: number } {
  let h = 1;
  let d = 1;
  let a = 1;
  let over = 1;
  for (const m of past) {
    const o = outcomeIndex(m.homeGoals, m.awayGoals);
    if (o === 0) h++;
    else if (o === 1) d++;
    else a++;
    if (m.homeGoals + m.awayGoals > 2.5) over++;
  }
  const n = h + d + a;
  return { p: [h / n, d / n, a / n], over25: over / (past.length + 2) };
}
