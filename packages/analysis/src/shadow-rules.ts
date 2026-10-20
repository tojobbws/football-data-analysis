/**
 * Shadow pick rules (never published): rules-v0.3 with the model's usual lean against the
 * market taken off first. The model is less sharp than the market, so its edge leans to whoever
 * gets the start (AH) and to unders (O/U) on almost every match; only a disagreement beyond that
 * usual lean should count. Judged by the shadow trial (ADR 0003, `model:shadow-report`).
 */
import { DEFAULT_RULES, type DecisionRules } from './candidates.js';

/**
 * Mean edge (model − market no-vig probability) per selection and line over every evaluated
 * candidate with market probability 15–85% and at least 20 matches, as of 2026-10-12
 * (analysis_candidates, ~17k AH and ~16k O/U rows). Frozen: same inputs give the same decision.
 */
export const MODEL_BIAS_2026_10_12: Readonly<Record<string, number>> = {
  'ASIAN_HANDICAP|AWAY|-1.75': -0.0754,
  'ASIAN_HANDICAP|AWAY|-1.5': -0.0599,
  'ASIAN_HANDICAP|AWAY|-1.25': -0.0621,
  'ASIAN_HANDICAP|AWAY|-1': -0.0598,
  'ASIAN_HANDICAP|AWAY|-0.75': -0.0414,
  'ASIAN_HANDICAP|AWAY|-0.5': -0.0225,
  'ASIAN_HANDICAP|AWAY|-0.25': -0.0136,
  'ASIAN_HANDICAP|AWAY|0': -0.0036,
  'ASIAN_HANDICAP|AWAY|0.25': 0.0094,
  'ASIAN_HANDICAP|AWAY|0.5': 0.0173,
  'ASIAN_HANDICAP|AWAY|0.75': 0.0273,
  'ASIAN_HANDICAP|AWAY|1': 0.0541,
  'ASIAN_HANDICAP|AWAY|1.25': 0.0576,
  'ASIAN_HANDICAP|AWAY|1.5': 0.0581,
  'ASIAN_HANDICAP|AWAY|1.75': 0.0729,
  'ASIAN_HANDICAP|AWAY|2': 0.0916,
  'ASIAN_HANDICAP|AWAY|2.25': 0.092,
  'ASIAN_HANDICAP|AWAY|2.5': 0.0859,
  'ASIAN_HANDICAP|AWAY|2.75': 0.0901,
  'ASIAN_HANDICAP|HOME|-2.75': -0.0901,
  'ASIAN_HANDICAP|HOME|-2.5': -0.0859,
  'ASIAN_HANDICAP|HOME|-2.25': -0.092,
  'ASIAN_HANDICAP|HOME|-2': -0.0916,
  'ASIAN_HANDICAP|HOME|-1.75': -0.0729,
  'ASIAN_HANDICAP|HOME|-1.5': -0.0581,
  'ASIAN_HANDICAP|HOME|-1.25': -0.0576,
  'ASIAN_HANDICAP|HOME|-1': -0.0541,
  'ASIAN_HANDICAP|HOME|-0.75': -0.0273,
  'ASIAN_HANDICAP|HOME|-0.5': -0.0173,
  'ASIAN_HANDICAP|HOME|-0.25': -0.0094,
  'ASIAN_HANDICAP|HOME|0': 0.0036,
  'ASIAN_HANDICAP|HOME|0.25': 0.0136,
  'ASIAN_HANDICAP|HOME|0.5': 0.0225,
  'ASIAN_HANDICAP|HOME|0.75': 0.0414,
  'ASIAN_HANDICAP|HOME|1': 0.0598,
  'ASIAN_HANDICAP|HOME|1.25': 0.0621,
  'ASIAN_HANDICAP|HOME|1.5': 0.0599,
  'ASIAN_HANDICAP|HOME|1.75': 0.0754,
  'OVER_UNDER|OVER|1.25': 0.0102,
  'OVER_UNDER|OVER|1.5': -0.0027,
  'OVER_UNDER|OVER|1.75': -0.008,
  'OVER_UNDER|OVER|2': -0.0174,
  'OVER_UNDER|OVER|2.25': -0.0303,
  'OVER_UNDER|OVER|2.5': -0.0399,
  'OVER_UNDER|OVER|2.75': -0.0481,
  'OVER_UNDER|OVER|3': -0.0611,
  'OVER_UNDER|OVER|3.25': -0.0583,
  'OVER_UNDER|OVER|3.5': -0.0561,
  'OVER_UNDER|OVER|3.75': -0.0605,
  'OVER_UNDER|OVER|4': -0.0716,
  'OVER_UNDER|OVER|4.25': -0.0692,
  'OVER_UNDER|OVER|4.5': -0.0656,
  'OVER_UNDER|OVER|4.75': -0.0732,
  'OVER_UNDER|OVER|5': -0.0928,
  'OVER_UNDER|OVER|5.25': -0.091,
  'OVER_UNDER|OVER|5.5': -0.0929,
  'OVER_UNDER|UNDER|1.25': -0.0102,
  'OVER_UNDER|UNDER|1.5': 0.0027,
  'OVER_UNDER|UNDER|1.75': 0.008,
  'OVER_UNDER|UNDER|2': 0.0174,
  'OVER_UNDER|UNDER|2.25': 0.0303,
  'OVER_UNDER|UNDER|2.5': 0.0399,
  'OVER_UNDER|UNDER|2.75': 0.0481,
  'OVER_UNDER|UNDER|3': 0.0611,
  'OVER_UNDER|UNDER|3.25': 0.0583,
  'OVER_UNDER|UNDER|3.5': 0.0561,
  'OVER_UNDER|UNDER|3.75': 0.0605,
  'OVER_UNDER|UNDER|4': 0.0716,
  'OVER_UNDER|UNDER|4.25': 0.0692,
  'OVER_UNDER|UNDER|4.5': 0.0656,
  'OVER_UNDER|UNDER|4.75': 0.0732,
  'OVER_UNDER|UNDER|5': 0.0928,
  'OVER_UNDER|UNDER|5.25': 0.091,
  'OVER_UNDER|UNDER|5.5': 0.0929,
};

export const SHADOW_RULES: DecisionRules = {
  ...DEFAULT_RULES,
  version: 'rules-v0.4-shadow',
  modelBias: MODEL_BIAS_2026_10_12,
  // frozen for the trial (ADR 0003): keeps choosing among every offered line, as when the trial began
  mainLineOnly: false,
};

/**
 * Shadow trial (ADR 0003): criteria fixed before any result was seen. Judged on LINEUP-round picks,
 * one per match; EARLY is reported beside it but never decides.
 */
export const SHADOW_TRIAL = {
  rulesVersion: SHADOW_RULES.version,
  round: 'LINEUP',
  minPicks: 300,
  extendTo: 600,
  /** shadow mean CLV must beat the real rules' by more than this many standard errors */
  clvZ: 2,
  /** shadow fair hit rate may be at most this far below the real rules' */
  maxFairDrop: 0.05,
} as const;

export interface TrialPick {
  /** settled outcome; null = not settled yet, VOID never counts */
  status: 'WIN' | 'HALF_WIN' | 'PUSH' | 'HALF_LOSS' | 'LOSS' | 'VOID' | null;
  clv: number | null;
}

export interface TrialSide {
  picks: number;
  settled: number;
  fairHitRate: number | null;
  clvN: number;
  clvMean: number | null;
  clvSe: number | null;
}

export function trialSide(picks: readonly TrialPick[]): TrialSide {
  const settled = picks.filter((p) => p.status && p.status !== 'VOID');
  const n = (s: TrialPick['status']) => settled.filter((p) => p.status === s).length;
  const up = n('WIN') + n('HALF_WIN') / 2;
  const down = n('LOSS') + n('HALF_LOSS') / 2;
  const clv = picks.map((p) => p.clv).filter((x): x is number => x !== null);
  const mean = clv.length ? clv.reduce((a, b) => a + b, 0) / clv.length : null;
  const se = clv.length >= 2 ? Math.sqrt(clv.reduce((a, x) => a + (x - mean!) ** 2, 0) / (clv.length - 1) / clv.length) : null;
  return { picks: picks.length, settled: settled.length, fairHitRate: up + down > 0 ? up / (up + down) : null, clvN: clv.length, clvMean: mean, clvSe: se };
}

export type TrialVerdict = 'COLLECTING' | 'PASS' | 'EXTEND' | 'FAIL';

/** COLLECTING below minPicks; then PASS when all criteria hold, else EXTEND until extendTo, then FAIL. */
export function trialVerdict(shadow: TrialSide, real: TrialSide, t: typeof SHADOW_TRIAL = SHADOW_TRIAL) {
  const clvDiff = shadow.clvMean !== null && real.clvMean !== null ? shadow.clvMean - real.clvMean : null;
  const clvSe = shadow.clvSe !== null && real.clvSe !== null ? Math.sqrt(shadow.clvSe ** 2 + real.clvSe ** 2) : null;
  const criteria = {
    enoughPicks: shadow.settled >= t.minPicks,
    clvBetter: clvDiff !== null && clvSe !== null && clvSe > 0 && clvDiff > t.clvZ * clvSe,
    fairNotWorse: shadow.fairHitRate !== null && real.fairHitRate !== null && shadow.fairHitRate >= real.fairHitRate - t.maxFairDrop,
  };
  const verdict: TrialVerdict = !criteria.enoughPicks
    ? 'COLLECTING'
    : criteria.clvBetter && criteria.fairNotWorse
      ? 'PASS'
      : shadow.settled < t.extendTo
        ? 'EXTEND'
        : 'FAIL';
  return { verdict, criteria, clvDiff, clvSe };
}
