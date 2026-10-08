/**
 * Cross-league model for club cups whose teams come from different domestic leagues
 * (e.g. ASEAN Club Championship). Two levels:
 *
 *   attack(team) = A[league(team)] · a(team)      a, d = strength WITHIN its own league
 *   defence(team) = D[league(team)] · d(team)      A, D = strength of that league
 *
 *   λ = c · H · attack(home) · defence(away),   μ = c · attack(away) · defence(home)
 *
 * a, d come from a Dixon-Coles fit per domestic league (lots of data). A, D, c, H are fitted
 * on the cup matches only — the only matches that say how strong one league is vs another —
 * with a shrinkage prior toward 1. Naively pooling all matches into one fit was worse than the
 * cup alone in the backtest (scripts/backtest-pooled.ts); this two-level split was better.
 */
import { fitDixonColes, type DixonColesModel, type DixonColesOptions, type MatchRecord } from './dixon-coles.js';

export const CROSS_LEAGUE_VERSION = 'cross-league-v0.1';

export interface CrossLeagueOptions {
  dixonColes?: DixonColesOptions;
  /** Prior strength (goal units) pulling each league offset toward 1. Backtest: 4. */
  leaguePrior?: number;
  /** Half-life for weighting cup matches (default: dixonColes.halfLifeDays ?? 365). */
  halfLifeDays?: number;
  maxIterations?: number;
}

export interface CrossLeagueModel {
  version: string;
  asOf: Date;
  /** domestic league of each team (the one it played most matches in before asOf) */
  teamLeague: Map<number, number>;
  /** within-league fits */
  within: Map<number, DixonColesModel>;
  leagueAttack: Map<number, number>;
  leagueDefence: Map<number, number>;
  c: number;
  homeAdv: number;
  cupMatchesUsed: number;
}

/** League id used for teams with no domestic data (strength 1 within, own offset). */
export const UNKNOWN_LEAGUE = -1;

export function fitCrossLeague(
  cup: readonly MatchRecord[],
  domestic: ReadonlyMap<number, readonly MatchRecord[]>,
  asOf: Date,
  opts: CrossLeagueOptions = {},
): CrossLeagueModel {
  const before = (m: MatchRecord) => m.kickoffAt.getTime() < asOf.getTime();
  const k = opts.leaguePrior ?? 4;
  const decay = Math.log(2) / (opts.halfLifeDays ?? opts.dixonColes?.halfLifeDays ?? 365);

  // 1) team -> league, and within-league strengths
  const counts = new Map<number, Map<number, number>>();
  const within = new Map<number, DixonColesModel>();
  for (const [league, ms] of domestic) {
    const past = ms.filter(before);
    if (!past.length) continue;
    within.set(league, fitDixonColes(past, asOf, opts.dixonColes));
    for (const m of past)
      for (const t of [m.homeTeamId, m.awayTeamId]) {
        const c = counts.get(t) ?? new Map<number, number>();
        c.set(league, (c.get(league) ?? 0) + 1);
        counts.set(t, c);
      }
  }
  const teamLeague = new Map<number, number>();
  for (const [t, c] of counts) teamLeague.set(t, [...c.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0]);

  const model: CrossLeagueModel = {
    version: CROSS_LEAGUE_VERSION,
    asOf,
    teamLeague,
    within,
    leagueAttack: new Map(),
    leagueDefence: new Map(),
    c: 1.3,
    homeAdv: 1.2,
    cupMatchesUsed: 0,
  };

  // 2) league offsets + cup base rate / home advantage from cup matches (Maher fixed point)
  const past = cup.filter(before).map((m) => ({
    h: teamStrength(model, m.homeTeamId),
    a: teamStrength(model, m.awayTeamId),
    gh: m.homeGoals,
    ga: m.awayGoals,
    w: Math.exp((-decay * (asOf.getTime() - m.kickoffAt.getTime())) / 86_400_000),
  }));
  model.cupMatchesUsed = past.length;
  if (!past.length) return model;

  const A = model.leagueAttack;
  const D = model.leagueDefence;
  const g = (mp: Map<number, number>, l: number) => mp.get(l) ?? 1;
  let { c, homeAdv: H } = model;
  for (let it = 0; it < (opts.maxIterations ?? 200); it++) {
    const nA = new Map<number, number>();
    const dA = new Map<number, number>();
    for (const m of past) {
      add(nA, m.h.league, m.w * m.gh);
      add(dA, m.h.league, m.w * c * H * m.h.a * g(D, m.a.league) * m.a.d);
      add(nA, m.a.league, m.w * m.ga);
      add(dA, m.a.league, m.w * c * m.a.a * g(D, m.h.league) * m.h.d);
    }
    for (const [l, n] of nA) A.set(l, (n + k) / (dA.get(l)! + k));

    const nD = new Map<number, number>();
    const dD = new Map<number, number>();
    for (const m of past) {
      add(nD, m.h.league, m.w * m.ga);
      add(dD, m.h.league, m.w * c * g(A, m.a.league) * m.a.a * m.h.d);
      add(nD, m.a.league, m.w * m.gh);
      add(dD, m.a.league, m.w * c * H * g(A, m.h.league) * m.h.a * m.a.d);
    }
    for (const [l, n] of nD) D.set(l, (n + k) / (dD.get(l)! + k));

    let sGh = 0;
    let sGa = 0;
    let eH = 0;
    let eA = 0;
    for (const m of past) {
      sGh += m.w * m.gh;
      sGa += m.w * m.ga;
      eH += m.w * g(A, m.h.league) * m.h.a * g(D, m.a.league) * m.a.d;
      eA += m.w * g(A, m.a.league) * m.a.a * g(D, m.h.league) * m.h.d;
    }
    const nc = (sGh + sGa) / (eH * H + eA);
    const nH = sGh / (nc * eH);
    const delta = Math.max(Math.abs(nc - c), Math.abs(nH - H));
    c = nc;
    H = nH;
    if (delta < 1e-9) break;
  }
  model.c = c;
  model.homeAdv = H;
  return model;
}

function teamStrength(model: CrossLeagueModel, team: number) {
  const league = model.teamLeague.get(team) ?? UNKNOWN_LEAGUE;
  const f = model.within.get(league);
  return { league, a: f?.attack.get(team) ?? 1, d: f?.defence.get(team) ?? 1 };
}

export function crossLeagueExpectedGoals(model: CrossLeagueModel, homeTeamId: number, awayTeamId: number) {
  const h = teamStrength(model, homeTeamId);
  const a = teamStrength(model, awayTeamId);
  const A = (l: number) => model.leagueAttack.get(l) ?? 1;
  const D = (l: number) => model.leagueDefence.get(l) ?? 1;
  return {
    lambda: model.c * model.homeAdv * A(h.league) * h.a * D(a.league) * a.d,
    mu: model.c * A(a.league) * a.a * D(h.league) * h.d,
    homeLeague: h.league,
    awayLeague: a.league,
  };
}

/** w·a + (1−w)·b, cell by cell (a mixture of two score distributions; 1X2 probabilities average linearly). */
export function mixScoreMatrices(a: number[][], b: number[][], w: number): number[][] {
  return a.map((row, i) => row.map((p, j) => w * p + (1 - w) * (b[i]?.[j] ?? 0)));
}

function add(map: Map<number, number>, key: number, v: number) {
  map.set(key, (map.get(key) ?? 0) + v);
}
