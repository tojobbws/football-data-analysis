/**
 * Market-anchored model (experiment, 2026-10-22).
 *
 * The market price is the starting point, not something to out-predict from scratch: the
 * de-margined Pinnacle price of the main line is the base probability, and a small logistic layer
 * only learns how far to move it, from inputs the market may weigh wrongly:
 *
 *   logit(p) = logit(p_market) + β · x
 *
 *   x (Asian handicap, home side)        x (over/under, over side)
 *   - DC_GAP     Dixon-Coles vs market   - DC_GAP     Dixon-Coles vs market
 *   - XG_LUCK    goals minus xG, recent   - XG_LUCK    goals minus xG, both teams
 *   - REST       rest days               - CONGESTION matches in the last 14 days
 *   - CONGESTION matches in 14 days      - DEAD       teams with nothing left to play for
 *   - MOTIVATION nothing to play for     - EARLY      first rounds of a season
 *   - LINE / QUARTER / EARLY: where the market itself may lean (home favourites, quarter lines, season start)
 *
 * β is fitted walk-forward on past matches only (`scripts/market-anchor-research.ts`). With every
 * β at 0 the model is the market. Closing prices are never an input: they only measure CLV.
 */
import type { MatchRecord } from './dixon-coles.js';

export const MARKET_ANCHOR_VERSION = 'market-anchor-v0.1';

export const AH_FEATURES = ['HOME_BIAS', 'DC_GAP', 'XG_LUCK', 'REST', 'CONGESTION', 'MOTIVATION', 'LINE', 'QUARTER', 'EARLY'] as const;
export const OU_FEATURES = ['OVER_BIAS', 'DC_GAP', 'XG_LUCK', 'CONGESTION', 'DEAD', 'EARLY'] as const;
export type AnchorMarket = 'ASIAN_HANDICAP' | 'OVER_UNDER';

export const logit = (p: number) => Math.log(p / (1 - p));
export const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const clip = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const clipP = (p: number) => clip(p, 1e-4, 1 - 1e-4);

// ---------------------------------------------------------------------------
// Team inputs (everything strictly before `asOf`)
// ---------------------------------------------------------------------------

export interface XgLuck {
  /** mean (goals scored - xG) over the recent matches with xG; > 0 = finishing above the chances */
  scored: number;
  /** mean (goals conceded - xG against); > 0 = conceding more than the chances given up */
  conceded: number;
  matches: number;
}

/** Recent finishing luck of a team from its last `n` league matches with xG. */
export function xgLuck(matches: readonly MatchRecord[], teamId: number, asOf: Date, n = 8): XgLuck {
  let scored = 0;
  let conceded = 0;
  let k = 0;
  for (let i = matches.length - 1; i >= 0 && k < n; i--) {
    const m = matches[i]!;
    if (m.kickoffAt.getTime() >= asOf.getTime()) continue;
    if (m.homeXg == null || m.awayXg == null) continue;
    if (m.homeTeamId === teamId) {
      scored += m.homeGoals - m.homeXg;
      conceded += m.awayGoals - m.awayXg;
    } else if (m.awayTeamId === teamId) {
      scored += m.awayGoals - m.awayXg;
      conceded += m.homeGoals - m.homeXg;
    } else continue;
    k++;
  }
  return k ? { scored: scored / k, conceded: conceded / k, matches: k } : { scored: 0, conceded: 0, matches: 0 };
}

export interface Rest {
  /** days since the team's previous match in any competition we hold (capped at 14; 14 when unknown) */
  days: number;
  /** matches in the 14 days before kickoff, any competition */
  last14: number;
}

/** `kickoffs`: the team's kickoff times (ms) in any competition, sorted ascending. */
export function restOf(kickoffs: readonly number[], asOf: Date): Rest {
  const t = asOf.getTime();
  let prev: number | null = null;
  let last14 = 0;
  for (const k of kickoffs) {
    if (k >= t - 3_600_000) break; // the match itself (and anything after it) is not rest
    prev = k;
    if (t - k <= 14 * 86_400_000) last14++;
  }
  const days = prev === null ? 14 : Math.min(14, (t - prev) / 86_400_000);
  return { days, last14 };
}

/** Matches the team played in the season before kickoff, in any competition (`log`: the team's matches with their season). */
export function seasonPlayed(log: ReadonlyArray<{ kickoffAt: Date; season: number }>, season: number, asOf: Date): number {
  return log.filter((m) => m.season === season && m.kickoffAt.getTime() < asOf.getTime()).length;
}

export interface TableRow {
  teamId: number;
  points: number;
  played: number;
  goalDiff: number;
}

/** League table from the season's finished matches before `asOf`. */
export function leagueTable(seasonMatches: readonly MatchRecord[], asOf: Date): TableRow[] {
  const rows = new Map<number, TableRow>();
  const row = (id: number) => {
    let r = rows.get(id);
    if (!r) rows.set(id, (r = { teamId: id, points: 0, played: 0, goalDiff: 0 }));
    return r;
  };
  for (const m of seasonMatches) {
    const h = row(m.homeTeamId);
    const a = row(m.awayTeamId);
    if (m.kickoffAt.getTime() >= asOf.getTime()) continue;
    h.played++;
    a.played++;
    h.goalDiff += m.homeGoals - m.awayGoals;
    a.goalDiff += m.awayGoals - m.homeGoals;
    if (m.homeGoals > m.awayGoals) h.points += 3;
    else if (m.homeGoals < m.awayGoals) a.points += 3;
    else {
      h.points++;
      a.points++;
    }
  }
  return [...rows.values()].sort((x, y) => y.points - x.points || y.goalDiff - x.goalDiff);
}

/**
 * Nothing left to play for: the team can no longer reach the last European place (assumed 6th) and
 * the first relegation place (assumed third from bottom) can no longer catch it. Zones differ by
 * league; these assumed places are a stated simplification. Only judged in a double round robin
 * with at most `lateRounds` rounds left; earlier in the season nobody is "dead".
 */
export function isDead(table: readonly TableRow[], teamId: number, lateRounds = 10): boolean {
  const n = table.length;
  if (n < 10) return false;
  const rounds = 2 * (n - 1);
  const pos = table.findIndex((r) => r.teamId === teamId);
  if (pos < 0) return false;
  const me = table[pos]!;
  const left = rounds - me.played;
  if (left > lateRounds || left <= 0) return false;
  const euro = table[5]!;
  const rel = table[n - 3]!;
  const canReachEurope = pos <= 5 || me.points + 3 * left >= euro.points;
  const relCanCatch = pos >= n - 3 || rel.points + 3 * (rounds - rel.played) >= me.points;
  return !canReachEurope && !relCanCatch;
}

// ---------------------------------------------------------------------------
// Feature vectors
// ---------------------------------------------------------------------------

export interface MatchSituation {
  home: { luck: XgLuck; rest: Rest; dead: boolean; seasonPlayed: number };
  away: { luck: XgLuck; rest: Rest; dead: boolean; seasonPlayed: number };
}

/** AH, home side of `homeLine`. `dcHome` / `marketHome`: fair (push-free) probabilities of the home side. */
export function ahFeatures(s: MatchSituation, homeLine: number, dcHome: number | null, marketHome: number): number[] {
  const luck = (t: MatchSituation['home']) => t.luck.scored - t.luck.conceded;
  const restDays = (t: MatchSituation['home']) => clip(t.rest.days, 2, 8);
  const quarter = Math.abs((homeLine * 4) % 2) === 1 ? 1 : 0;
  return [
    1,
    dcHome === null ? 0 : clip(logit(clipP(dcHome)) - logit(clipP(marketHome)), -1.5, 1.5),
    clip(luck(s.home) - luck(s.away), -3, 3),
    (restDays(s.home) - restDays(s.away)) / 6,
    s.home.rest.last14 - s.away.rest.last14,
    Number(s.away.dead) - Number(s.home.dead),
    clip(homeLine, -3, 3),
    quarter,
    Math.min(s.home.seasonPlayed, s.away.seasonPlayed) < 5 ? 1 : 0,
  ];
}

/** O/U, over side of the total. */
export function ouFeatures(s: MatchSituation, dcOver: number | null, marketOver: number): number[] {
  const luck = (t: MatchSituation['home']) => t.luck.scored + t.luck.conceded;
  return [
    1,
    dcOver === null ? 0 : clip(logit(clipP(dcOver)) - logit(clipP(marketOver)), -1.5, 1.5),
    clip(luck(s.home) + luck(s.away), -4, 4),
    s.home.rest.last14 + s.away.rest.last14,
    Number(s.home.dead) + Number(s.away.dead),
    Math.min(s.home.seasonPlayed, s.away.seasonPlayed) < 5 ? 1 : 0,
  ];
}

// ---------------------------------------------------------------------------
// Logistic layer with the market as offset
// ---------------------------------------------------------------------------

export interface AnchorObservation {
  /** logit of the market's fair probability */
  offset: number;
  x: readonly number[];
  /** the side won (1) or lost (0); a half win / half loss is 1 / 0 with half the weight, as in `fairProbability` */
  y: number;
  /** stake that was not pushed back: 1, 0.5 for a half win or half loss (a full push is left out) */
  w: number;
}

export interface AnchorFit {
  market: AnchorMarket;
  features: readonly string[];
  /** coefficients on the standardised features (the intercept, index 0, is not standardised) */
  beta: number[];
  /** standard errors of beta (inverse Hessian) */
  se: number[];
  mean: number[];
  sd: number[];
  n: number;
  lambda: number;
}

/** An input in standard deviations from the fitted mean, capped at 3: never extrapolate far past the data the layer saw. */
function standard(v: number, j: number, mean: readonly number[], sd: readonly number[]): number {
  return j === 0 ? 1 : clip((v - mean[j]!) / sd[j]!, -3, 3);
}

function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((r, i) => [...r, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    [m[c], m[p]] = [m[p]!, m[c]!];
    const d = m[c]![c]!;
    if (Math.abs(d) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r]![c]! / d;
      if (f) for (let k = c; k <= n; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  return m.map((r, i) => (Math.abs(r[i]!) < 1e-12 ? 0 : r[n]! / r[i]!));
}

function invert(a: number[][]): number[][] {
  const n = a.length;
  return Array.from({ length: n }, (_, j) => solve(a, Array.from({ length: n }, (_, i) => (i === j ? 1 : 0))));
}

/**
 * Ridge-penalised logistic regression with the market logit as a fixed offset (Newton steps).
 * `lambda` pulls every β toward 0, i.e. toward "the market is right".
 */
export function fitAnchor(market: AnchorMarket, features: readonly string[], obs: readonly AnchorObservation[], lambda = 50): AnchorFit {
  const k = features.length;
  const mean = new Array<number>(k).fill(0);
  const sd = new Array<number>(k).fill(1);
  for (let j = 1; j < k; j++) {
    const xs = obs.map((o) => o.x[j]!);
    const mu = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    const v = xs.reduce((a, b) => a + (b - mu) ** 2, 0) / Math.max(1, xs.length - 1);
    mean[j] = mu;
    sd[j] = Math.sqrt(v) > 1e-9 ? Math.sqrt(v) : 1;
  }
  const z = obs.map((o) => o.x.map((v, j) => standard(v, j, mean, sd)));
  let beta = new Array<number>(k).fill(0);
  let hess: number[][] = [];
  for (let it = 0; it < 30; it++) {
    const g = beta.map((b) => lambda * b);
    hess = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? lambda : 0)));
    for (let i = 0; i < obs.length; i++) {
      const o = obs[i]!;
      const xi = z[i]!;
      const p = sigmoid(o.offset + xi.reduce((a, v, j) => a + v * beta[j]!, 0));
      const r = o.w * (p - o.y);
      const h = o.w * p * (1 - p);
      for (let a = 0; a < k; a++) {
        g[a]! += r * xi[a]!;
        for (let b = a; b < k; b++) hess[a]![b]! += h * xi[a]! * xi[b]!;
      }
    }
    for (let a = 0; a < k; a++) for (let b = 0; b < a; b++) hess[a]![b] = hess[b]![a]!;
    const step = solve(hess, g);
    beta = beta.map((b, j) => b - step[j]!);
    if (Math.max(...step.map(Math.abs)) < 1e-8) break;
  }
  const inv = invert(hess);
  return { market, features, beta, se: inv.map((r, i) => Math.sqrt(Math.max(0, r[i]!))), mean, sd, n: obs.length, lambda };
}

/** The anchored probability: the market's fair probability moved by the fitted layer. */
export function applyAnchor(fit: Pick<AnchorFit, 'beta' | 'mean' | 'sd'>, marketProbability: number, x: readonly number[]): number {
  const s = x.reduce((a, v, j) => a + standard(v, j, fit.mean, fit.sd) * fit.beta[j]!, 0);
  return sigmoid(logit(clipP(marketProbability)) + s);
}

/** How much each input moved the probability (logit units), for explaining a change. */
export function anchorContributions(fit: Pick<AnchorFit, 'beta' | 'mean' | 'sd' | 'features'>, x: readonly number[]): Record<string, number> {
  return Object.fromEntries(fit.features.map((f, j) => [f, standard(x[j]!, j, fit.mean, fit.sd) * fit.beta[j]!]));
}

/** Weighted log loss of probabilities `p` on observations (fair hit, push-free stake). */
export function anchorLosses(obs: readonly AnchorObservation[], p: readonly number[]): number[] {
  return obs.map((o, i) => {
    const q = clipP(p[i]!);
    return -o.w * (o.y * Math.log(q) + (1 - o.y) * Math.log(1 - q));
  });
}

/** Holm step-down: which of the p-values stay significant at `alpha` with the family corrected. */
export function holm(pValues: readonly number[], alpha = 0.05): boolean[] {
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const keep = new Array<boolean>(pValues.length).fill(false);
  for (let r = 0; r < order.length; r++) {
    if (order[r]!.p > alpha / (order.length - r)) break;
    keep[order[r]!.i] = true;
  }
  return keep;
}

/** Two-sided normal p-value of z. */
export function pValue(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const q = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return Math.min(1, 2 * q);
}
