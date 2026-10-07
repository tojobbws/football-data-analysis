/**
 * Dixon-Coles style goal model.
 *
 *   home goals ~ Poisson(λ),  λ = c · attack[home] · defence[away] · homeAdv
 *   away goals ~ Poisson(μ),  μ = c · attack[away] · defence[home]
 *   + Dixon-Coles low-score correction τ(x, y; ρ)
 *
 * Fit: weighted Poisson maximum likelihood via fixed-point iteration (Maher),
 * with exponential time decay and a shrinkage prior (teams with few matches -> average).
 * ρ is estimated afterwards by 1-D search on actual (integer) goals.
 * When xG is available a blend of xG and goals is used as the "attacking output".
 * Matches with an early red card can be down-weighted (11 v 10 says less about normal strength).
 */

export interface MatchRecord {
  homeTeamId: number;
  awayTeamId: number;
  homeGoals: number;
  awayGoals: number;
  kickoffAt: Date;
  homeXg?: number | null;
  awayXg?: number | null;
  /** Minute of the first red card (either team) within 90 minutes; null/undefined = none or unknown. */
  redCardMinute?: number | null;
}

export interface DixonColesOptions {
  /** Half-life of match weight in days (default 240). */
  halfLifeDays?: number;
  /** Weight of xG vs goals when xG exists for both teams, 0..1 (default 0.5). */
  xgWeight?: number;
  /** Shrinkage strength in goal-units toward league average (default 3). */
  priorStrength?: number;
  /**
   * 0..1. A match with a red card at minute t gets weight × (1 − d·(90 − t)/90):
   * red at kick-off with d = 1 -> ignored, red at 90' -> unchanged (default 0 = off).
   */
  redCardDiscount?: number;
  maxIterations?: number;
  tolerance?: number;
}

export interface DixonColesModel {
  version: string;
  asOf: Date;
  attack: Map<number, number>;
  defence: Map<number, number>;
  /** Number of (weighted) matches each team has in the fit */
  teamMatches: Map<number, number>;
  c: number;
  homeAdv: number;
  rho: number;
  /** Time-weighted average total goals (actual) — anchor for totals shrinkage */
  leagueMeanTotal: number;
  matchesUsed: number;
  iterations: number;
  options: Required<DixonColesOptions>;
}

export const DIXON_COLES_VERSION = 'dixon-coles-v0.2';

const DEFAULTS: Required<DixonColesOptions> = {
  halfLifeDays: 240,
  xgWeight: 0.5,
  priorStrength: 3,
  redCardDiscount: 0,
  maxIterations: 300,
  tolerance: 1e-7,
};

export function tau(x: number, y: number, lambda: number, mu: number, rho: number): number {
  if (x === 0 && y === 0) return 1 - lambda * mu * rho;
  if (x === 0 && y === 1) return 1 + lambda * rho;
  if (x === 1 && y === 0) return 1 + mu * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

/**
 * Fit on matches strictly BEFORE `asOf` (never uses information from the future).
 */
export type WarmStart = Pick<DixonColesModel, 'attack' | 'defence' | 'c' | 'homeAdv'>;

export function fitDixonColes(all: readonly MatchRecord[], asOf: Date, opts: DixonColesOptions = {}, init?: WarmStart): DixonColesModel {
  const o = { ...DEFAULTS, ...opts };
  const decay = Math.log(2) / o.halfLifeDays;
  const matches = all
    .filter((m) => m.kickoffAt.getTime() < asOf.getTime())
    .map((m) => {
      const ageDays = (asOf.getTime() - m.kickoffAt.getTime()) / 86_400_000;
      const hasXg = isNum(m.homeXg) && isNum(m.awayXg);
      const w = o.xgWeight;
      return {
        h: m.homeTeamId,
        a: m.awayTeamId,
        gh: hasXg ? w * (m.homeXg as number) + (1 - w) * m.homeGoals : m.homeGoals,
        ga: hasXg ? w * (m.awayXg as number) + (1 - w) * m.awayGoals : m.awayGoals,
        ih: m.homeGoals,
        ia: m.awayGoals,
        wt: Math.exp(-decay * ageDays) * redCardFactor(m.redCardMinute, o.redCardDiscount),
      };
    });

  const teams = new Set<number>();
  for (const m of matches) {
    teams.add(m.h);
    teams.add(m.a);
  }
  // warm start (walk-forward refits converge in a few iterations instead of hundreds)
  const attack = new Map<number, number>([...teams].map((t) => [t, init?.attack.get(t) ?? 1]));
  const defence = new Map<number, number>([...teams].map((t) => [t, init?.defence.get(t) ?? 1]));
  const teamMatches = new Map<number, number>([...teams].map((t) => [t, 0]));
  for (const m of matches) {
    teamMatches.set(m.h, teamMatches.get(m.h)! + m.wt);
    teamMatches.set(m.a, teamMatches.get(m.a)! + m.wt);
  }

  const sumW = matches.reduce((s, m) => s + m.wt, 0);
  const sumGh = matches.reduce((s, m) => s + m.wt * m.gh, 0);
  const sumGa = matches.reduce((s, m) => s + m.wt * m.ga, 0);
  let homeAdv = init?.homeAdv ?? (sumGa > 0 ? sumGh / sumGa : 1.25);
  let c = init?.c ?? (sumW > 0 ? (sumGh + sumGa) / (sumW * (homeAdv + 1)) : 1.3);
  const leagueMeanTotal = sumW > 0 ? matches.reduce((s, m) => s + m.wt * (m.ih + m.ia), 0) / sumW : 2.6;
  const k = o.priorStrength;

  let it = 0;
  for (; it < o.maxIterations && matches.length > 0; it++) {
    let maxDelta = 0;

    // attack
    const numA = new Map<number, number>();
    const denA = new Map<number, number>();
    for (const m of matches) {
      add(numA, m.h, m.wt * m.gh);
      add(denA, m.h, m.wt * c * defence.get(m.a)! * homeAdv);
      add(numA, m.a, m.wt * m.ga);
      add(denA, m.a, m.wt * c * defence.get(m.h)!);
    }
    for (const t of teams) {
      // den = expected goals if attack were 1.0; prior adds k observed and k expected goals (pulls toward 1)
      const v = (numA.get(t)! + k) / (denA.get(t)! + k);
      maxDelta = Math.max(maxDelta, Math.abs(v - attack.get(t)!));
      attack.set(t, v);
    }

    // defence
    const numD = new Map<number, number>();
    const denD = new Map<number, number>();
    for (const m of matches) {
      add(numD, m.h, m.wt * m.ga);
      add(denD, m.h, m.wt * c * attack.get(m.a)!);
      add(numD, m.a, m.wt * m.gh);
      add(denD, m.a, m.wt * c * attack.get(m.h)! * homeAdv);
    }
    for (const t of teams) {
      const v = (numD.get(t)! + k) / (denD.get(t)! + k);
      maxDelta = Math.max(maxDelta, Math.abs(v - defence.get(t)!));
      defence.set(t, v);
    }

    // identifiability: geometric mean of attack and defence = 1 (absorbed into c)
    const ga = geoMean([...attack.values()]);
    const gd = geoMean([...defence.values()]);
    for (const t of teams) {
      attack.set(t, attack.get(t)! / ga);
      defence.set(t, defence.get(t)! / gd);
    }

    // home advantage and base rate
    let expHomeNoAdv = 0;
    let expAway = 0;
    for (const m of matches) {
      expHomeNoAdv += m.wt * attack.get(m.h)! * defence.get(m.a)!;
      expAway += m.wt * attack.get(m.a)! * defence.get(m.h)!;
    }
    const newC = (sumGh + sumGa) / (expHomeNoAdv * homeAdv + expAway);
    const newHome = sumGh / (newC * expHomeNoAdv);
    maxDelta = Math.max(maxDelta, Math.abs(newC - c), Math.abs(newHome - homeAdv));
    c = newC;
    homeAdv = newHome;

    if (maxDelta < o.tolerance) break;
  }

  const model: DixonColesModel = {
    version: DIXON_COLES_VERSION,
    asOf,
    attack,
    defence,
    teamMatches,
    c,
    homeAdv,
    rho: 0,
    leagueMeanTotal,
    matchesUsed: matches.length,
    iterations: it,
    options: o,
  };
  model.rho = estimateRho(model, matches);
  return model;
}

/** Weight multiplier for a match with a red card at `minute` (1 = no change). */
export function redCardFactor(minute: number | null | undefined, discount: number): number {
  if (!discount || !isNum(minute)) return 1;
  const t = Math.min(90, Math.max(0, minute));
  return Math.max(0, 1 - discount * ((90 - t) / 90));
}

function estimateRho(model: DixonColesModel, matches: Array<{ h: number; a: number; ih: number; ia: number; wt: number }>): number {
  let best = 0;
  let bestLl = -Infinity;
  for (let r = -0.25; r <= 0.2001; r += 0.005) {
    let ll = 0;
    let valid = true;
    for (const m of matches) {
      if (m.ih > 1 || m.ia > 1) continue;
      const { lambda, mu } = expectedGoals(model, m.h, m.a);
      const t = tau(m.ih, m.ia, lambda, mu, r);
      if (t <= 0) {
        valid = false;
        break;
      }
      ll += m.wt * Math.log(t);
    }
    if (valid && ll > bestLl) {
      bestLl = ll;
      best = Math.round(r * 1000) / 1000;
    }
  }
  return best;
}

/** Expected goals for a fixture. Unknown teams get average strength (1.0). */
export function expectedGoals(model: Pick<DixonColesModel, 'attack' | 'defence' | 'c' | 'homeAdv'>, homeTeamId: number, awayTeamId: number, neutral = false) {
  const ah = model.attack.get(homeTeamId) ?? 1;
  const dh = model.defence.get(homeTeamId) ?? 1;
  const aa = model.attack.get(awayTeamId) ?? 1;
  const da = model.defence.get(awayTeamId) ?? 1;
  const adv = neutral ? 1 : model.homeAdv;
  return { lambda: model.c * ah * da * adv, mu: model.c * aa * dh };
}

/**
 * Totals shrinkage: pull λ+μ toward the league mean (keeps the λ:μ ratio, so sides barely move).
 * Team-level totals are noisy; backtests showed raw totals were over-confident.
 */
export function adjustTotals(g: { lambda: number; mu: number }, leagueMeanTotal: number, shrink: number) {
  if (!shrink) return g;
  const t = g.lambda + g.mu;
  if (t <= 0) return g;
  const f = ((1 - shrink) * t + shrink * leagueMeanTotal) / t;
  return { lambda: g.lambda * f, mu: g.mu * f };
}

/** P(home = i, away = j) for i, j in 0..maxGoals, normalised to sum 1. */
export function scoreMatrix(lambda: number, mu: number, rho: number, maxGoals = 10): number[][] {
  const ph = poissonPmf(lambda, maxGoals);
  const pa = poissonPmf(mu, maxGoals);
  const m: number[][] = [];
  let total = 0;
  for (let i = 0; i <= maxGoals; i++) {
    const row: number[] = [];
    for (let j = 0; j <= maxGoals; j++) {
      const p = Math.max(0, ph[i]! * pa[j]! * tau(i, j, lambda, mu, rho));
      row.push(p);
      total += p;
    }
    m.push(row);
  }
  return m.map((row) => row.map((p) => p / total));
}

export function poissonPmf(rate: number, max: number): number[] {
  const out: number[] = [Math.exp(-rate)];
  for (let k = 1; k <= max; k++) out.push((out[k - 1]! * rate) / k);
  return out;
}

function add(map: Map<number, number>, key: number, v: number) {
  map.set(key, (map.get(key) ?? 0) + v);
}

function geoMean(xs: number[]): number {
  if (!xs.length) return 1;
  return Math.exp(xs.reduce((s, x) => s + Math.log(x), 0) / xs.length);
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
