/**
 * Per-league model tuning with an honest time split:
 *   - choose settings on the first part of the walk-forward period ("tune"),
 *   - report + gate on the most recent part ("holdout") that played no role in choosing.
 * A market is only `enabled` if the tuned model beats league base rates on the holdout
 * in a paired significance test (z >= 1.28, one-sided 90%) with at least 100 holdout matches.
 * Elo is only blended into 1X2 if it beats Dixon-Coles alone significantly on the tune split.
 * Red-card down-weighting is tried on top of the chosen settings and kept under the same rule.
 */
import type { DixonColesOptions, MatchRecord } from './dixon-coles.js';
import {
  blend,
  dcWalkForward,
  eloWalkForward,
  lossesBrierOver25,
  lossesLogLoss1x2,
  matchContexts,
  pairedTest,
  score1x2,
  scoreOver25,
  Z_90,
  type DcPrediction,
  type PairedTest,
  type Scores,
} from './backtest.js';
import type { Probs3 } from './metrics.js';

export interface TuneGrid {
  priorStrength: number[];
  halfLifeDays: number[];
  xgWeight: number[];
  totalsShrink: number[];
  eloK: number[];
  eloHomeAdvantage: number[];
  ensembleWeight: number[];
  /** Red-card discounts tried on top of the best settings (0 = off is always the reference). */
  redCardDiscount: number[];
}

export const DEFAULT_GRID: TuneGrid = {
  priorStrength: [3, 8, 20, 40],
  halfLifeDays: [180, 365, 730],
  xgWeight: [0, 0.5],
  totalsShrink: [0, 0.25, 0.5, 0.75, 1],
  eloK: [15, 20, 30],
  eloHomeAdvantage: [40, 60, 90],
  ensembleWeight: [0, 0.25, 0.5, 0.75, 1],
  redCardDiscount: [0.5, 1],
};

export interface TuneOptions {
  warmupMatches?: number;
  refitEveryDays?: number;
  holdoutShare?: number;
  /** Minimum holdout matches before any market can be enabled (default 100). */
  minHoldout?: number;
  /** One-sided z required on the paired holdout test vs base rates (default 1.2816 = 90%). */
  zRequired?: number;
  grid?: Partial<TuneGrid>;
  /** Share of matches with xG; below 15% the xG grid is skipped. */
  xgShare?: number;
  /** Share of matches whose events (cards) are known; below 15% the red-card step is skipped. */
  eventsShare?: number;
}

type DcParams = Required<Pick<DixonColesOptions, 'priorStrength' | 'halfLifeDays' | 'xgWeight' | 'redCardDiscount'>>;

export interface RedCardChoice {
  /** discount actually used (0 = off) */
  discount: number;
  /** best discount on the tune split before the significance guard */
  candidate: number;
  /** paired test (tune split) of the candidate vs no discount; null = step skipped */
  tuneTest: PairedTest | null;
}

export interface TuneResult {
  matchesEvaluated: number;
  tuneN: number;
  holdoutN: number;
  combosTried: number;
  sides: {
    params: DcParams;
    tune: Scores;
    holdout: Scores;
    baselineHoldout: Scores;
    skill: number;
    test: PairedTest;
    enabled: boolean;
  };
  totals: {
    params: DcParams & { totalsShrink: number };
    tuneBrier: number;
    holdoutBrier: number;
    baselineHoldoutBrier: number;
    /** holdout Brier of the untuned v0.1 setting (prior 3, half-life 240, xG 0.5, no shrink) for comparison */
    untunedHoldoutBrier: number | null;
    skill: number;
    test: PairedTest;
    enabled: boolean;
  };
  elo: { params: { k: number; homeAdvantage: number }; holdout: Scores };
  redCard: { matchesWithRedCard: number; sides: RedCardChoice; totals: RedCardChoice };
  ensemble: {
    weight: number;
    /** weight the grid preferred on the tune split before the "must beat DC significantly" guard */
    candidateWeight: number;
    /** paired test (tune split) of the candidate blend vs Dixon-Coles alone */
    tuneTestVsDc: PairedTest;
    holdout: Scores;
    skill: number;
    test: PairedTest;
    enabled: boolean;
  };
}

export function tuneLeague(matches: readonly MatchRecord[], opts: TuneOptions = {}): TuneResult {
  const grid: TuneGrid = { ...DEFAULT_GRID, ...opts.grid };
  if ((opts.xgShare ?? 1) < 0.15) grid.xgWeight = [0];
  const warmup = opts.warmupMatches ?? 100;
  const refit = opts.refitEveryDays ?? 14;
  const zReq = opts.zRequired ?? Z_90;

  const ctxs = matchContexts(matches, warmup);
  const split = Math.floor(ctxs.length * (1 - (opts.holdoutShare ?? 0.3)));
  const tuneIdx = range(0, split);
  const holdIdx = range(split, ctxs.length);
  const enoughHoldout = holdIdx.length >= (opts.minHoldout ?? 100);

  let combos = 0;
  type Base = Omit<DcParams, 'redCardDiscount'>;
  let bestSides: { p: Base; ll: number; preds: DcPrediction[] } | null = null;
  let bestTotals: { p: Base & { totalsShrink: number }; br: number; pOver: number[] } | null = null;
  let untunedOver: number[] | null = null;

  for (const priorStrength of grid.priorStrength)
    for (const halfLifeDays of grid.halfLifeDays)
      for (const xgWeight of grid.xgWeight) {
        combos++;
        const preds = dcWalkForward(matches, {
          warmupMatches: warmup,
          refitEveryDays: refit,
          dixonColes: { priorStrength, halfLifeDays, xgWeight },
          totalsShrinks: grid.totalsShrink,
        });
        const ll = score1x2(preds.map((p) => p.oneXTwo), ctxs, tuneIdx).logLoss;
        if (!bestSides || ll < bestSides.ll) bestSides = { p: { priorStrength, halfLifeDays, xgWeight }, ll, preds };
        grid.totalsShrink.forEach((totalsShrink, si) => {
          const pOver = preds.map((p) => p.over25[si]!);
          const br = scoreOver25(pOver, ctxs, tuneIdx);
          if (!bestTotals || br < bestTotals.br) bestTotals = { p: { priorStrength, halfLifeDays, xgWeight, totalsShrink }, br, pOver };
        });
      }

  // untuned reference for the report (what v0.1 did)
  if (grid.priorStrength.length) {
    const ref = dcWalkForward(matches, { warmupMatches: warmup, refitEveryDays: refit, dixonColes: { priorStrength: 3, halfLifeDays: 240, xgWeight: 0.5 }, totalsShrinks: [0] });
    untunedOver = ref.map((p) => p.over25[0]!);
  }

  let bestElo: { k: number; homeAdvantage: number; ll: number; preds: Probs3[] } | null = null;
  for (const k of grid.eloK)
    for (const homeAdvantage of grid.eloHomeAdvantage) {
      const preds = eloWalkForward(matches, ctxs, { k, homeAdvantage });
      const ll = score1x2(preds, ctxs, tuneIdx).logLoss;
      if (!bestElo || ll < bestElo.ll) bestElo = { k, homeAdvantage, ll, preds };
    }

  const bestS = bestSides!;
  const bestT = bestTotals!;
  const elo = bestElo!;

  // Red-card down-weighting on top of the best settings. Kept only if it beats "off"
  // SIGNIFICANTLY on the tune split (decided without the holdout, like the Elo guard).
  const matchesWithRedCard = matches.filter((m) => m.redCardMinute != null).length;
  const rcGrid = matchesWithRedCard > 0 && (opts.eventsShare ?? 1) >= 0.15 ? grid.redCardDiscount.filter((d) => d > 0) : [];
  const off: RedCardChoice = { discount: 0, candidate: 0, tuneTest: null };

  let sidesRc = off;
  let sidesPreds = bestS.preds;
  {
    let best: { d: number; ll: number; preds: DcPrediction[] } | null = null;
    for (const d of rcGrid) {
      const preds = dcWalkForward(matches, { warmupMatches: warmup, refitEveryDays: refit, dixonColes: { ...bestS.p, redCardDiscount: d }, totalsShrinks: [0] });
      const ll = score1x2(preds.map((p) => p.oneXTwo), ctxs, tuneIdx).logLoss;
      if (!best || ll < best.ll) best = { d, ll, preds };
    }
    if (best) {
      const t = pairedTest(lossesLogLoss1x2(best.preds.map((p) => p.oneXTwo), ctxs, tuneIdx), lossesLogLoss1x2(bestS.preds.map((p) => p.oneXTwo), ctxs, tuneIdx));
      const keep = t.z >= zReq;
      sidesRc = { discount: keep ? best.d : 0, candidate: best.d, tuneTest: t };
      if (keep) sidesPreds = best.preds;
    }
  }

  let totalsRc = off;
  let totalsPOver = bestT.pOver;
  {
    const { totalsShrink, ...base } = bestT.p;
    let best: { d: number; br: number; pOver: number[] } | null = null;
    for (const d of rcGrid) {
      const preds = dcWalkForward(matches, { warmupMatches: warmup, refitEveryDays: refit, dixonColes: { ...base, redCardDiscount: d }, totalsShrinks: [totalsShrink] });
      const pOver = preds.map((p) => p.over25[0]!);
      const br = scoreOver25(pOver, ctxs, tuneIdx);
      if (!best || br < best.br) best = { d, br, pOver };
    }
    if (best) {
      const t = pairedTest(lossesBrierOver25(best.pOver, ctxs, tuneIdx), lossesBrierOver25(bestT.pOver, ctxs, tuneIdx));
      const keep = t.z >= zReq;
      totalsRc = { discount: keep ? best.d : 0, candidate: best.d, tuneTest: t };
      if (keep) totalsPOver = best.pOver;
    }
  }

  const sides = { p: { ...bestS.p, redCardDiscount: sidesRc.discount }, preds: sidesPreds };
  const totals = {
    p: { ...bestT.p, redCardDiscount: totalsRc.discount },
    pOver: totalsPOver,
    br: scoreOver25(totalsPOver, ctxs, tuneIdx),
  };

  let bestW = { w: 1, ll: Infinity };
  for (const w of grid.ensembleWeight) {
    const ll = score1x2(sides.preds.map((p, i) => blend(p.oneXTwo, elo.preds[i]!, w)), ctxs, tuneIdx).logLoss;
    if (ll < bestW.ll) bestW = { w, ll };
  }
  // Guard: only blend in Elo if it beats Dixon-Coles alone SIGNIFICANTLY on the tune split.
  // (Decided without looking at the holdout, so holdout numbers stay honest.)
  const dcOnly = sides.preds.map((p) => p.oneXTwo);
  const candidate = sides.preds.map((p, i) => blend(p.oneXTwo, elo.preds[i]!, bestW.w));
  const tuneTestVsDc = pairedTest(lossesLogLoss1x2(candidate, ctxs, tuneIdx), lossesLogLoss1x2(dcOnly, ctxs, tuneIdx));
  const finalW = bestW.w < 1 && tuneTestVsDc.z >= zReq ? bestW.w : 1;

  const base1x2 = ctxs.map((c) => c.base);
  const baseHold = score1x2(base1x2, ctxs, holdIdx);
  const sidesHold = score1x2(sides.preds.map((p) => p.oneXTwo), ctxs, holdIdx);
  const ensPreds = sides.preds.map((p, i) => blend(p.oneXTwo, elo.preds[i]!, finalW));
  const ensHold = score1x2(ensPreds, ctxs, holdIdx);
  const baseOverHold = scoreOver25(ctxs.map((c) => c.baseOver25), ctxs, holdIdx);
  const totalsHold = scoreOver25(totals.pOver, ctxs, holdIdx);

  const skill = (model: number, base: number) => (base > 0 ? 1 - model / base : 0);
  const sidesSkill = skill(sidesHold.logLoss, baseHold.logLoss);
  const totalsSkill = skill(totalsHold, baseOverHold);
  const ensSkill = skill(ensHold.logLoss, baseHold.logLoss);

  const baseLoss1x2 = lossesLogLoss1x2(base1x2, ctxs, holdIdx);
  const sidesTest = pairedTest(lossesLogLoss1x2(sides.preds.map((p) => p.oneXTwo), ctxs, holdIdx), baseLoss1x2);
  const ensTest = pairedTest(lossesLogLoss1x2(ensPreds, ctxs, holdIdx), baseLoss1x2);
  const totalsTest = pairedTest(lossesBrierOver25(totals.pOver, ctxs, holdIdx), lossesBrierOver25(ctxs.map((c) => c.baseOver25), ctxs, holdIdx));
  const pass = (t: PairedTest) => enoughHoldout && t.z >= zReq;

  return {
    matchesEvaluated: ctxs.length,
    tuneN: tuneIdx.length,
    holdoutN: holdIdx.length,
    combosTried: combos,
    sides: {
      params: sides.p,
      tune: score1x2(sides.preds.map((p) => p.oneXTwo), ctxs, tuneIdx),
      holdout: sidesHold,
      baselineHoldout: baseHold,
      skill: sidesSkill,
      test: sidesTest,
      enabled: pass(sidesTest),
    },
    totals: {
      params: totals.p,
      tuneBrier: totals.br,
      holdoutBrier: totalsHold,
      baselineHoldoutBrier: baseOverHold,
      untunedHoldoutBrier: untunedOver ? scoreOver25(untunedOver, ctxs, holdIdx) : null,
      skill: totalsSkill,
      test: totalsTest,
      enabled: pass(totalsTest),
    },
    elo: { params: { k: elo.k, homeAdvantage: elo.homeAdvantage }, holdout: score1x2(elo.preds, ctxs, holdIdx) },
    redCard: { matchesWithRedCard, sides: sidesRc, totals: totalsRc },
    ensemble: { weight: finalW, candidateWeight: bestW.w, tuneTestVsDc, holdout: ensHold, skill: ensSkill, test: ensTest, enabled: pass(ensTest) },
  };
}

function range(a: number, b: number): number[] {
  return Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);
}
