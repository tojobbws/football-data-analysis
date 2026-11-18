/**
 * Decisions v2 engine (experiment, shadow only; .scratch/decisions-v2/).
 *
 * Decisions v1 asked a model for a pick and for each option's "chance to come out ahead" with the market's no-vig
 * probability written into the question. The audit of 16–17 Nov found those chances echo the market (the chosen
 * option sat at or below its own market price in 11 of 13 picks), favourite + underdog chances summed to 0.91
 * (median) where they must sum to 1, and nothing in v1 turned a chance into an expected return. v2 splits the work:
 *
 *   1. Market reference: a score model (Poisson with a Dixon–Coles low-score term) fitted so that it prices the
 *      market's main AH line, main O/U line and, when quoted, the 1X2 draw at their de-margined consensus. Every
 *      option then has a full outcome distribution (win, half win, push, half loss, loss) from one coherent score
 *      distribution, so favourite + underdog and over + under always add up.
 *   2. Independent view: the analyst answers in categories, never numbers — does the data favour either team beyond
 *      the handicap line, and more or fewer goals than the total — with a probability per category. Each category
 *      moves the market's goal rates by a fixed factor (MARGIN_FACTOR, TOTAL_FACTOR, set before any evaluation and
 *      never tuned on results).
 *   3. Expected return: the view is a mixture of score models; each option's distribution, fair probability and
 *      expected profit at the snapshot's executable price come from that mixture, with the spread of the expected
 *      profit across the mixture as its uncertainty.
 *   4. Decision: the best option whose expected profit clears the threshold, and still clears zero after one
 *      standard deviation of uncertainty; otherwise NO_PICK. Every option keeps its numbers and its reasons.
 *
 * Point in time: everything here is computed from a snapshot the caller built at the decision time
 * (`oddsDispersion` drops quotes stored or updated after it). Closing prices are only ever read by the evaluation.
 */
import { consensus, median, type OddsQuote } from './candidates.js';
import { scoreMatrix } from './dixon-coles.js';
import type { HybridOption, HybridSide } from './hybrid-market.js';
import { distributionFor } from './markets.js';
import { expectedValue, fairProbability, type Outcome, type OutcomeDistribution } from './settlement.js';

export const DECISIONS_V2_ENGINE_VERSION = 'decisions-v2-engine-0.1';

// ---------------------------------------------------------------------------
// 1. Market reference: a score model that prices the main lines at the consensus
// ---------------------------------------------------------------------------

export interface MarketFitInput {
  /** main AH line from the home side (home −0.75 → −0.75) */
  ahHomeLine: number;
  /** de-margined consensus chance of the home side at that line (pushes out, as the price states it) */
  ahHomeProbability: number;
  /** main O/U total */
  ouLine: number;
  /** de-margined consensus chance of Over at that total */
  overProbability: number;
  /** de-margined 1X2 draw; when given, the low-score term ρ is fitted to it, otherwise ρ = 0 */
  drawProbability?: number | null;
}

export interface MarketFit {
  lambdaHome: number;
  lambdaAway: number;
  rho: number;
  /** model − market, in probability */
  residual: { ah: number; ou: number; draw: number | null };
  /** both main lines priced within MAX_FIT_RESIDUAL */
  ok: boolean;
}

export const MAX_FIT_RESIDUAL = 0.002;
const MAX_GOALS = 12;
const RHO_RANGE = [-0.2, 0.2] as const;

function ahHome(matrix: number[][], line: number) {
  return fairProbability(distributionFor(matrix, { market: 'ASIAN_HANDICAP', selection: 'HOME', line }));
}
function over(matrix: number[][], line: number) {
  return fairProbability(distributionFor(matrix, { market: 'OVER_UNDER', selection: 'OVER', line }));
}
function draw(matrix: number[][]) {
  let p = 0;
  for (let i = 0; i < matrix.length; i++) p += matrix[i]![i]!;
  return p;
}

/** Monotone root by bisection: f increasing on [lo, hi]; returns the x where f(x) ≈ target (clamped to the range). */
function bisect(f: (x: number) => number, target: number, lo: number, hi: number, iterations = 50): number {
  if (f(lo) >= target) return lo;
  if (f(hi) <= target) return hi;
  for (let k = 0; k < iterations; k++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** λ for a total T and a supremacy d (home − away goals); the caller keeps |d| < T so both stay positive. */
function split(total: number, d: number) {
  return { lambdaHome: (total + d) / 2, lambdaAway: (total - d) / 2 };
}

function fitForRho(m: MarketFitInput, rho: number) {
  const supremacyFor = (total: number) => {
    const maxD = total - 0.04;
    return bisect((d) => {
      const s = split(total, d);
      return ahHome(scoreMatrix(s.lambdaHome, s.lambdaAway, rho, MAX_GOALS), m.ahHomeLine);
    }, m.ahHomeProbability, -maxD, maxD, 40);
  };
  const total = bisect((t) => {
    const s = split(t, supremacyFor(t));
    return over(scoreMatrix(s.lambdaHome, s.lambdaAway, rho, MAX_GOALS), m.ouLine);
  }, m.overProbability, 0.3, 8, 40);
  return split(total, supremacyFor(total));
}

export function fitMarketScoreModel(m: MarketFitInput): MarketFit {
  const valid = (p: number) => Number.isFinite(p) && p > 0.02 && p < 0.98;
  if (!valid(m.ahHomeProbability) || !valid(m.overProbability)) throw new Error('market probabilities must be in (0.02, 0.98)');
  const withDraw = m.drawProbability != null && valid(m.drawProbability);
  // draws rise as ρ falls (DC raises 0-0 and 1-1 when ρ < 0), so "draw(−ρ)" is increasing in −ρ
  const rho = withDraw
    ? -bisect((negRho) => {
        const l = fitForRho(m, -negRho);
        return draw(scoreMatrix(l.lambdaHome, l.lambdaAway, -negRho, MAX_GOALS));
      }, m.drawProbability!, -RHO_RANGE[1], -RHO_RANGE[0], 25)
    : 0;
  const l = fitForRho(m, rho);
  const matrix = scoreMatrix(l.lambdaHome, l.lambdaAway, rho, MAX_GOALS);
  const residual = {
    ah: ahHome(matrix, m.ahHomeLine) - m.ahHomeProbability,
    ou: over(matrix, m.ouLine) - m.overProbability,
    draw: withDraw ? draw(matrix) - m.drawProbability! : null,
  };
  return { ...l, rho, residual, ok: Math.abs(residual.ah) <= MAX_FIT_RESIDUAL && Math.abs(residual.ou) <= MAX_FIT_RESIDUAL };
}

export function fitMatrix(fit: Pick<MarketFit, 'lambdaHome' | 'lambdaAway' | 'rho'>, homeFactor = 1, awayFactor = 1): number[][] {
  return scoreMatrix(fit.lambdaHome * homeFactor, fit.lambdaAway * awayFactor, fit.rho, MAX_GOALS);
}

// ---------------------------------------------------------------------------
// 2. Independent view in categories
// ---------------------------------------------------------------------------

/**
 * The view follows the market's own two numbers: the margin (what the Asian handicap prices) and the total (what the
 * over/under prices). Asking for each team's goals against a goal-rate number instead pulled the analyst toward
 * "fewer goals" for 8 of 10 teams in the stage-3 smoke test, while the same analyst read the total line as neutral.
 */
export const MARGIN_LEVELS = ['AWAY_CLEARLY', 'AWAY_SLIGHTLY', 'AS_MARKET', 'HOME_SLIGHTLY', 'HOME_CLEARLY'] as const;
export const TOTAL_LEVELS = ['FEWER_CLEARLY', 'FEWER_SLIGHTLY', 'AS_MARKET', 'MORE_SLIGHTLY', 'MORE_CLEARLY'] as const;
export type MarginLevel = (typeof MARGIN_LEVELS)[number];
export type TotalLevel = (typeof TOTAL_LEVELS)[number];

/**
 * How far each category moves the market's goal rates. Fixed before any evaluation (decisions-v2-config-0.1) and never
 * fitted to results. Margin: home rate × f, away rate × (2 − f), so HOME_SLIGHTLY moves about 0.08 goals of margin on
 * a 1.5–1.2 match, worth 2–3 points of AH chance; CLEARLY doubles it. Total: both rates × f, ±4% / ±8%, worth about
 * 2–3 / 5 points of over/under chance.
 */
export const MARGIN_FACTOR: Readonly<Record<MarginLevel, number>> = { AWAY_CLEARLY: 0.94, AWAY_SLIGHTLY: 0.97, AS_MARKET: 1, HOME_SLIGHTLY: 1.03, HOME_CLEARLY: 1.06 };
export const TOTAL_FACTOR: Readonly<Record<TotalLevel, number>> = { FEWER_CLEARLY: 0.92, FEWER_SLIGHTLY: 0.96, AS_MARKET: 1, MORE_SLIGHTLY: 1.04, MORE_CLEARLY: 1.08 };

export interface MarketView {
  /** chance of each category for the goal margin against the main handicap line */
  margin: Partial<Record<MarginLevel, number>>;
  /** chance of each category for total goals against the main total */
  total: Partial<Record<TotalLevel, number>>;
}

/** The market itself as a view: everything on AS_MARKET. */
export const MARKET_VIEW: MarketView = { margin: { AS_MARKET: 1 }, total: { AS_MARKET: 1 } };

/** A view's categories normalised to sum 1; null when it is not a probability distribution over those levels. */
export function normaliseLevels<L extends string>(levels: readonly L[], p: Partial<Record<L, number>>): Record<L, number> | null {
  const out = {} as Record<L, number>;
  let sum = 0;
  for (const k of Object.keys(p)) if (!(levels as readonly string[]).includes(k)) return null;
  for (const k of levels) {
    const v = p[k] ?? 0;
    if (!Number.isFinite(v) || v < 0 || v > 1) return null;
    out[k] = v;
    sum += v;
  }
  if (Math.abs(sum - 1) > 0.05) return null;
  for (const k of levels) out[k] /= sum;
  return out;
}

// ---------------------------------------------------------------------------
// 3. Expected return of each option under the view
// ---------------------------------------------------------------------------

export interface OptionEstimate {
  side: HybridSide;
  market: HybridOption['market'];
  selection: string;
  line: number;
  /** price the expected profit is taken at (the snapshot's median, which most bookmakers offer or beat) */
  odds: number;
  marketProbability: number;
  /** the market reference model's distribution of this option (should price it at marketProbability) */
  marketDistribution: OutcomeDistribution;
  /** the view's distribution: win, half win, push, half loss, loss */
  distribution: OutcomeDistribution;
  /** pushes out, comparable to marketProbability */
  fairProbability: number;
  /** expected profit per 1 unit staked at `odds` */
  ev: number;
  /** spread of the expected profit across the view's categories (model uncertainty, not match randomness) */
  evSd: number;
  /** share of the view's weight where the expected profit is above 0 */
  pEvPositive: number;
}

const zero = (): OutcomeDistribution => ({ win: 0, halfWin: 0, push: 0, halfLoss: 0, loss: 0 });

/** The margin and total categories are taken as independent (an assumption recorded in the spec). */
export function estimateOptions(fit: MarketFit, options: readonly HybridOption[], view: MarketView): OptionEstimate[] | null {
  const margin = normaliseLevels(MARGIN_LEVELS, view.margin);
  const total = normaliseLevels(TOTAL_LEVELS, view.total);
  if (!margin || !total) return null;
  const base = fitMatrix(fit);
  const parts: Array<{ w: number; matrix: number[][] }> = [];
  for (const m of MARGIN_LEVELS)
    for (const t of TOTAL_LEVELS) {
      const w = margin[m] * total[t];
      if (w > 1e-9) parts.push({ w, matrix: fitMatrix(fit, MARGIN_FACTOR[m] * TOTAL_FACTOR[t], (2 - MARGIN_FACTOR[m]) * TOTAL_FACTOR[t]) });
    }
  const W = parts.reduce((s, p) => s + p.w, 0);
  return options.map((o) => {
    const sel = { market: o.market, selection: o.selection, line: o.line } as Parameters<typeof distributionFor>[1];
    const d = zero();
    const evs: Array<{ w: number; ev: number }> = [];
    for (const p of parts) {
      const di = distributionFor(p.matrix, sel);
      for (const k of Object.keys(d) as Array<keyof OutcomeDistribution>) d[k] += (p.w / W) * di[k];
      evs.push({ w: p.w / W, ev: expectedValue(di, o.odds) });
    }
    const ev = evs.reduce((s, x) => s + x.w * x.ev, 0);
    const evSd = Math.sqrt(evs.reduce((s, x) => s + x.w * (x.ev - ev) ** 2, 0));
    return {
      side: o.side,
      market: o.market,
      selection: o.selection,
      line: o.line,
      odds: o.odds,
      marketProbability: o.marketProbability,
      marketDistribution: distributionFor(base, sel),
      distribution: d,
      fairProbability: fairProbability(d),
      ev,
      evSd,
      pEvPositive: evs.filter((x) => x.ev > 0).reduce((s, x) => s + x.w, 0),
    };
  });
}

// ---------------------------------------------------------------------------
// 4. Decision
// ---------------------------------------------------------------------------

export interface DecisionRulesV2 {
  version: string;
  /** expected profit per unit an option needs */
  minEv: number;
  /** and still above 0 after this many standard deviations of the view's uncertainty */
  evSdMultiplier: number;
  /** bookmakers needed on the option's main line */
  minBookmakers: number;
  /** newest price no older than this at the decision time */
  maxPriceAgeHours: number;
  /** the analyst's chance that the data is enough to judge both teams against the market; below it, no option is eligible */
  minDataSufficient: number;
}

/** Set before any evaluation; a change is a new version, judged on matches after it. */
export const DECISIONS_V2_RULES: DecisionRulesV2 = {
  version: 'decisions-v2-config-0.1',
  minEv: 0.03,
  evSdMultiplier: 1,
  minBookmakers: 3,
  maxPriceAgeHours: 12,
  minDataSufficient: 0.5,
};

export type DecisionV2Reason =
  | 'MARKET_FIT_FAILED'
  | 'DATA_INSUFFICIENT'
  | 'TOO_FEW_BOOKMAKERS'
  | 'STALE_PRICE'
  | 'EV_BELOW_THRESHOLD'
  | 'EV_NOT_ROBUST'
  | 'BETTER_OPTION_CHOSEN';

export interface MarketQuality {
  /** per market: bookmakers on the main line and the age of the newest price */
  ASIAN_HANDICAP?: { nBookmakers: number; ageHours: number | null };
  OVER_UNDER?: { nBookmakers: number; ageHours: number | null };
  /** the analyst's chance that the data is sufficient (null/absent = not asked, the gate is skipped) */
  dataSufficient?: number | null;
}

export interface CandidateV2 extends OptionEstimate {
  eligible: boolean;
  reasons: DecisionV2Reason[];
}

export interface DecisionV2 {
  engineVersion: string;
  rulesVersion: string;
  /** NO_PICK when no option passes */
  side: HybridSide | 'NO_PICK';
  chosen: CandidateV2 | null;
  candidates: CandidateV2[];
  noPickReasons: DecisionV2Reason[];
}

export function decideV2(fit: MarketFit, estimates: readonly OptionEstimate[], quality: MarketQuality, rules: DecisionRulesV2 = DECISIONS_V2_RULES): DecisionV2 {
  const candidates: CandidateV2[] = estimates.map((e) => {
    const reasons: DecisionV2Reason[] = [];
    const q = quality[e.market];
    if (!fit.ok) reasons.push('MARKET_FIT_FAILED');
    if (quality.dataSufficient != null && !(quality.dataSufficient >= rules.minDataSufficient)) reasons.push('DATA_INSUFFICIENT');
    if (!q || q.nBookmakers < rules.minBookmakers) reasons.push('TOO_FEW_BOOKMAKERS');
    if (!q || q.ageHours == null || q.ageHours > rules.maxPriceAgeHours) reasons.push('STALE_PRICE');
    if (!(e.ev >= rules.minEv)) reasons.push('EV_BELOW_THRESHOLD');
    if (!(e.ev - rules.evSdMultiplier * e.evSd > 0)) reasons.push('EV_NOT_ROBUST');
    return { ...e, eligible: reasons.length === 0, reasons };
  });
  const passing = candidates.filter((c) => c.eligible).sort((a, b) => b.ev - a.ev || a.side.localeCompare(b.side));
  const chosen = passing[0] ?? null;
  for (const c of passing.slice(1)) {
    c.eligible = false;
    c.reasons.push('BETTER_OPTION_CHOSEN');
  }
  const noPickReasons = chosen ? [] : [...new Set(candidates.flatMap((c) => c.reasons))];
  return { engineVersion: DECISIONS_V2_ENGINE_VERSION, rulesVersion: rules.version, side: chosen?.side ?? 'NO_PICK', chosen, candidates, noPickReasons };
}

// ---------------------------------------------------------------------------
// 5. Price dispersion at the decision time (point in time)
// ---------------------------------------------------------------------------

export interface PriceDispersion {
  nBookmakers: number;
  minOdds: number | null;
  medianOdds: number | null;
  maxOdds: number | null;
  /** consensus de-margined chance of the side at the line, from `consensus` at asOf */
  marketProbability: number | null;
}

/**
 * Each bookmaker's latest price of one side at one line, known at `asOf`: a quote updated after it or stored after
 * it (collectedAt, set in a replay) is left out, so a replay never sees a later price.
 */
export function oddsDispersion(quotes: readonly OddsQuote[], asOf: Date, market: HybridOption['market'], selection: string, line: number, maxAgeHours = Infinity): PriceDispersion {
  const t = asOf.getTime();
  const latest = new Map<number, OddsQuote>();
  for (const q of quotes) {
    if (q.market !== market || q.selection !== selection || q.line == null || Math.abs(q.line - line) > 1e-6) continue;
    if (q.updatedAt.getTime() > t || (q.collectedAt && q.collectedAt.getTime() > t)) continue;
    if (t - q.updatedAt.getTime() > maxAgeHours * 3_600_000) continue;
    const prev = latest.get(q.bookmakerId);
    if (!prev || prev.updatedAt < q.updatedAt) latest.set(q.bookmakerId, q);
  }
  const odds = [...latest.values()].map((q) => q.odds).filter((o) => o > 1);
  const c = consensus(quotes, asOf, maxAgeHours).find((x) => x.market === market && x.selection === selection && x.line != null && Math.abs(x.line - line) < 1e-6);
  return {
    nBookmakers: odds.length,
    minOdds: odds.length ? Math.min(...odds) : null,
    medianOdds: odds.length ? median(odds) : null,
    maxOdds: odds.length ? Math.max(...odds) : null,
    marketProbability: c ? c.marketProbability : null,
  };
}

// ---------------------------------------------------------------------------
// 6. Evaluation helpers (after the match; closing prices are read here only)
// ---------------------------------------------------------------------------

/** Profit of 1 unit staked at decimal `odds`, by settlement outcome. */
export function unitsFor(outcome: Outcome, odds: number): number {
  switch (outcome) {
    case 'WIN':
      return odds - 1;
    case 'HALF_WIN':
      return (odds - 1) / 2;
    case 'PUSH':
      return 0;
    case 'HALF_LOSS':
      return -0.5;
    case 'LOSS':
      return -1;
  }
}

/**
 * Closing line value in probability points: the closing consensus chance of the same side at the same line minus
 * the chance at the decision. Above 0 the market moved toward the choice. Null when the line was not quoted at close.
 */
export function clvPoints(decisionProbability: number, closingProbability: number | null): number | null {
  return closingProbability == null ? null : closingProbability - decisionProbability;
}

/** Odds bracket used for "performance by odds range". */
export function oddsBand(odds: number): '<1.80' | '1.80–1.99' | '2.00–2.19' | '≥2.20' {
  return odds < 1.8 ? '<1.80' : odds < 2 ? '1.80–1.99' : odds < 2.2 ? '2.00–2.19' : '≥2.20';
}

// ---------------------------------------------------------------------------
// 7. Reading a stored Hybrid AI input (the shared raw snapshot; never Hybrid's answer)
// ---------------------------------------------------------------------------

type HybridInputLike = Record<string, any>;

/** The main-line options exactly as the stored input states them (median price, de-margined consensus). */
export function hybridInputOptions(input: HybridInputLike): HybridOption[] {
  const out: HybridOption[] = [];
  const home = input.match?.home;
  for (const o of input.market?.asian_handicap?.options ?? [])
    out.push({ side: o.option, market: 'ASIAN_HANDICAP', selection: o.team_or_total === home ? 'HOME' : 'AWAY', line: Number(o.line), odds: Number(o.odds_median), marketProbability: Number(o.market_probability_no_vig) });
  for (const o of input.market?.over_under?.options ?? [])
    out.push({ side: o.option, market: 'OVER_UNDER', selection: String(o.team_or_total), line: Number(o.line), odds: Number(o.odds_median), marketProbability: Number(o.market_probability_no_vig) });
  return out;
}

/** Bookmakers and price age of each main line, as stored in the input. */
export function hybridInputQuality(input: HybridInputLike): MarketQuality {
  const q = (m: { bookmakers?: number; price_age_hours?: number | null; options?: unknown[] } | undefined) =>
    m && m.options?.length ? { nBookmakers: Number(m.bookmakers ?? 0), ageHours: m.price_age_hours == null ? null : Number(m.price_age_hours) } : undefined;
  return { ASIAN_HANDICAP: q(input.market?.asian_handicap), OVER_UNDER: q(input.market?.over_under) };
}

/** The market reference fitted to the input's main lines; null when either main line is missing. */
export function hybridInputFit(input: HybridInputLike): MarketFit | null {
  const opts = hybridInputOptions(input);
  const home = opts.find((o) => o.market === 'ASIAN_HANDICAP' && o.selection === 'HOME');
  const ov = opts.find((o) => o.side === 'OVER');
  if (!home || !ov) return null;
  const draw = input.market?.match_odds_1x2_no_vig?.draw;
  return fitMarketScoreModel({ ahHomeLine: home.line, ahHomeProbability: home.marketProbability, ouLine: ov.line, overProbability: ov.marketProbability, drawProbability: draw == null ? null : Number(draw) });
}

// ---------------------------------------------------------------------------
// 8. Evidence: which of the analyst's factor readings support or conflict with each option
// ---------------------------------------------------------------------------

/**
 * A factor reading is a probability over five ordered levels, −2 … +2. For team factors +2 favours the home team
 * strongly; for the goals factor +2 points to clearly more goals than the market's total.
 */
export interface FactorReading {
  name: string;
  kind: 'TEAM' | 'GOALS';
  /** probability per level, index 0 = −2 … index 4 = +2 */
  probabilities: readonly number[];
}

export interface OptionEvidence {
  side: HybridSide;
  supporting: Array<{ factor: string; lean: number }>;
  conflicting: Array<{ factor: string; lean: number }>;
}

/** expected level in −2 … +2 */
export function factorLean(p: readonly number[]): number {
  const s = p.reduce((a, b) => a + b, 0);
  return s > 0 ? p.reduce((a, x, i) => a + x * (i - 2), 0) / s : 0;
}

/** A factor counts when its expected level is at least `min` (0.25 of a level) toward or against the option. */
export function optionEvidence(options: readonly HybridOption[], factors: readonly FactorReading[], min = 0.25): OptionEvidence[] {
  return options.map((o) => {
    const dir = o.market === 'ASIAN_HANDICAP' ? (o.selection === 'HOME' ? 1 : -1) : o.selection === 'OVER' ? 1 : -1;
    const kind = o.market === 'ASIAN_HANDICAP' ? 'TEAM' : 'GOALS';
    const supporting: OptionEvidence['supporting'] = [];
    const conflicting: OptionEvidence['conflicting'] = [];
    for (const f of factors) {
      if (f.kind !== kind) continue;
      const lean = Math.round(factorLean(f.probabilities) * 1000) / 1000;
      if (lean * dir >= min) supporting.push({ factor: f.name, lean });
      else if (lean * dir <= -min) conflicting.push({ factor: f.name, lean });
    }
    return { side: o.side, supporting, conflicting };
  });
}
