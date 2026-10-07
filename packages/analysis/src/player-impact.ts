/**
 * Player Impact layer — sits between the Probability Engine and the Candidate Generator.
 *
 * The team-level goal model (Dixon-Coles) does not know WHO plays. This layer:
 *  1. builds a profile of every player from recent match stats (attack share, defence share, minutes),
 *  2. finds who is missing (confirmed lineup at T-1h, otherwise injuries list),
 *  3. turns the missing shares into attack / defence losses per team,
 *  4. adjusts λ / μ:  λ' = λ · (1 − α·attackLoss_home) · (1 + α·defenceLoss_away)
 *                     μ' = μ · (1 − α·attackLoss_away) · (1 + α·defenceLoss_home)
 * α is calibrated per league on historical lineups (α = 0 means "no effect"), and the layer is only
 * trusted by the decision rules when it beats plain Dixon-Coles in a paired holdout test.
 */
import { pairedTest, Z_90, type MatchContext, type PairedTest } from './backtest.js';
import { scoreMatrix } from './dixon-coles.js';
import { priceSelection } from './markets.js';
import { logLoss3, type Probs3 } from './metrics.js';

export const IMPACT_VERSION = 'dc-impact-v0.1';

export interface PlayerMatchStat {
  fixtureId: number;
  kickoffAt: Date;
  teamId: number;
  playerId: number;
  minutes: number | null;
  position: string | null;
  rating: number | null;
  goals: number | null;
  assists: number | null;
  shotsTotal: number | null;
  passesKey: number | null;
}

export interface PlayerProfile {
  playerId: number;
  position: string | null;
  appearances: number;
  minutesShare: number;
  attackShare: number;
  defenceShare: number;
}

export interface TeamProfile {
  teamId: number;
  teamMatches: number;
  players: Map<number, PlayerProfile>;
}

export interface Absence {
  playerId: number;
  /** 1 = surely out, 0.5 = doubtful, 0.6 = benched regular */
  weight: number;
  source: 'INJURY' | 'LINEUP';
}

export interface TeamLoss {
  attackLoss: number;
  defenceLoss: number;
  missing: Array<{ playerId: number; weight: number; attackShare: number; defenceShare: number; source: Absence['source'] }>;
}

/** Positional weight of defensive responsibility (G = goalkeeper). */
const POS_DEF: Record<string, number> = { G: 3, D: 1.5, M: 0.8, F: 0.3 };
export const MAX_TEAM_LOSS = 0.6;

/** Attacking output of one appearance (goals dominate; creation counts too). */
function attackOutput(s: PlayerMatchStat): number {
  return (s.goals ?? 0) + 0.6 * (s.assists ?? 0) + 0.05 * (s.shotsTotal ?? 0) + 0.1 * (s.passesKey ?? 0);
}

/**
 * Profiles from the team's last `lookbackMatches` matches strictly before `before`.
 * `stats` may contain any teams; only `teamId` rows are used.
 */
export function buildTeamProfile(
  stats: readonly PlayerMatchStat[],
  teamId: number,
  before: Date,
  opts: { lookbackMatches?: number; lookbackDays?: number } = {},
): TeamProfile {
  const lookN = opts.lookbackMatches ?? 10;
  const minTime = before.getTime() - (opts.lookbackDays ?? 365) * 86_400_000;
  const rows = stats.filter((s) => s.teamId === teamId && s.kickoffAt.getTime() < before.getTime() && s.kickoffAt.getTime() >= minTime);
  const fixtures = [...new Map(rows.map((r) => [r.fixtureId, r.kickoffAt.getTime()])).entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, lookN)
    .map(([id]) => id);
  const keep = new Set(fixtures);
  const window = rows.filter((r) => keep.has(r.fixtureId) && (r.minutes ?? 0) > 0);

  const acc = new Map<number, { pos: Map<string, number>; apps: number; minutes: number; att: number; def: number }>();
  for (const r of window) {
    const a = acc.get(r.playerId) ?? { pos: new Map(), apps: 0, minutes: 0, att: 0, def: 0 };
    const min = r.minutes ?? 0;
    const ratingFactor = r.rating ? Math.min(1.2, Math.max(0.8, r.rating / 7)) : 1;
    a.apps += 1;
    a.minutes += min;
    a.att += attackOutput(r);
    a.def += min * (POS_DEF[r.position ?? ''] ?? 0.8) * ratingFactor;
    if (r.position) a.pos.set(r.position, (a.pos.get(r.position) ?? 0) + 1);
    acc.set(r.playerId, a);
  }
  const totalAtt = [...acc.values()].reduce((s, a) => s + a.att, 0);
  const totalDef = [...acc.values()].reduce((s, a) => s + a.def, 0);
  const teamMatches = fixtures.length;

  const players = new Map<number, PlayerProfile>();
  for (const [playerId, a] of acc) {
    const position = [...a.pos.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
    players.set(playerId, {
      playerId,
      position,
      appearances: a.apps,
      minutesShare: teamMatches ? a.minutes / (90 * teamMatches) : 0,
      attackShare: totalAtt > 0 ? a.att / totalAtt : 0,
      defenceShare: totalDef > 0 ? a.def / totalDef : 0,
    });
  }
  return { teamId, teamMatches, players };
}

/**
 * From a confirmed lineup: regulars (minutesShare >= minShare) who do not start are missing.
 * On the bench = partial absence (can still come on).
 */
export function absencesFromLineup(
  profile: TeamProfile,
  starters: ReadonlySet<number>,
  bench: ReadonlySet<number>,
  opts: { minShare?: number; benchWeight?: number } = {},
): Absence[] {
  const minShare = opts.minShare ?? 0.4;
  const out: Absence[] = [];
  for (const p of profile.players.values()) {
    if (p.minutesShare < minShare || starters.has(p.playerId)) continue;
    out.push({ playerId: p.playerId, weight: bench.has(p.playerId) ? (opts.benchWeight ?? 0.6) : 1, source: 'LINEUP' });
  }
  return out;
}

/** API-Football injury types: "Missing Fixture" (out) / "Questionable" (doubtful). */
export function absencesFromInjuries(rows: ReadonlyArray<{ playerId: number | null; type: string | null }>): Absence[] {
  const out = new Map<number, Absence>();
  for (const r of rows) {
    if (!r.playerId) continue;
    const weight = /question|doubt/i.test(r.type ?? '') ? 0.5 : 1;
    const prev = out.get(r.playerId);
    if (!prev || prev.weight < weight) out.set(r.playerId, { playerId: r.playerId, weight, source: 'INJURY' });
  }
  return [...out.values()];
}

export function teamLoss(profile: TeamProfile, absences: readonly Absence[]): TeamLoss {
  let att = 0;
  let def = 0;
  const missing: TeamLoss['missing'] = [];
  for (const a of absences) {
    const p = profile.players.get(a.playerId);
    if (!p) continue; // never played recently -> no measurable impact
    att += a.weight * p.attackShare;
    def += a.weight * p.defenceShare;
    missing.push({ playerId: a.playerId, weight: a.weight, attackShare: round(p.attackShare), defenceShare: round(p.defenceShare), source: a.source });
  }
  missing.sort((x, y) => y.attackShare + y.defenceShare - (x.attackShare + x.defenceShare));
  return { attackLoss: round(Math.min(MAX_TEAM_LOSS, att)), defenceLoss: round(Math.min(MAX_TEAM_LOSS, def)), missing };
}

export const NO_LOSS: TeamLoss = { attackLoss: 0, defenceLoss: 0, missing: [] };

export function applyImpact(g: { lambda: number; mu: number }, home: TeamLoss, away: TeamLoss, alpha: number) {
  if (!alpha) return { ...g };
  return {
    lambda: g.lambda * Math.max(0.3, 1 - alpha * home.attackLoss) * (1 + alpha * away.defenceLoss),
    mu: g.mu * Math.max(0.3, 1 - alpha * away.attackLoss) * (1 + alpha * home.defenceLoss),
  };
}

export function oneXTwoFrom(lambda: number, mu: number, rho: number): Probs3 {
  const m = scoreMatrix(lambda, mu, rho);
  return [
    priceSelection(m, { market: 'MATCH_WINNER', selection: 'HOME' }).probability,
    priceSelection(m, { market: 'MATCH_WINNER', selection: 'DRAW' }).probability,
    priceSelection(m, { market: 'MATCH_WINNER', selection: 'AWAY' }).probability,
  ];
}

// ---------------------------------------------------------------------------
// Calibration on history (uses CONFIRMED LINEUPS as the record of who was missing)
// ---------------------------------------------------------------------------

export interface ImpactMatch {
  fixtureId: number;
  homeTeamId: number;
  awayTeamId: number;
  kickoffAt: Date;
}

export interface LineupRecord {
  starters: Set<number>;
  bench: Set<number>;
}

export interface ImpactCalibration {
  alpha: number;
  eligible: number;
  tuneN: number;
  holdoutN: number;
  holdoutLogLossBase: number;
  holdoutLogLossImpact: number;
  test: PairedTest;
  enabled: boolean;
}

/**
 * For every evaluated match that has lineups for BOTH teams, re-price the walk-forward
 * Dixon-Coles prediction with lineup-based absences, choose α on the tune part,
 * and test it against plain Dixon-Coles on the holdout part.
 */
export function calibrateImpact(args: {
  matches: readonly ImpactMatch[]; // sorted exactly like ctxs (by kickoff)
  ctxs: readonly MatchContext[];
  dc: ReadonlyArray<{ lambda: number; mu: number; rho: number; oneXTwo: Probs3 }>;
  stats: readonly PlayerMatchStat[];
  lineups: ReadonlyMap<string, LineupRecord>; // key `${fixtureId}:${teamId}`
  alphas?: readonly number[];
  holdoutShare?: number;
  minHoldout?: number;
  zRequired?: number;
}): ImpactCalibration {
  const alphas = args.alphas ?? [0, 0.25, 0.5, 0.75, 1, 1.5];
  const rows: Array<{ ctx: MatchContext; dc: (typeof args.dc)[number]; home: TeamLoss; away: TeamLoss }> = [];
  args.ctxs.forEach((ctx, i) => {
    const m = args.matches[ctx.index]!;
    const lh = args.lineups.get(`${m.fixtureId}:${m.homeTeamId}`);
    const la = args.lineups.get(`${m.fixtureId}:${m.awayTeamId}`);
    if (!lh || !la || lh.starters.size < 11 || la.starters.size < 11) return;
    const ph = buildTeamProfile(args.stats, m.homeTeamId, m.kickoffAt);
    const pa = buildTeamProfile(args.stats, m.awayTeamId, m.kickoffAt);
    if (ph.teamMatches < 3 || pa.teamMatches < 3) return;
    rows.push({ ctx, dc: args.dc[i]!, home: teamLoss(ph, absencesFromLineup(ph, lh.starters, lh.bench)), away: teamLoss(pa, absencesFromLineup(pa, la.starters, la.bench)) });
  });

  const split = Math.floor(rows.length * (1 - (args.holdoutShare ?? 0.3)));
  const tune = rows.slice(0, split);
  const hold = rows.slice(split);
  const losses = (set: typeof rows, alpha: number) =>
    set.map((r) => {
      const g = applyImpact(r.dc, r.home, r.away, alpha);
      return logLoss3(alpha ? oneXTwoFrom(g.lambda, g.mu, r.dc.rho) : r.dc.oneXTwo, r.ctx.outcome);
    });
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Infinity);

  let best = { alpha: 0, ll: Infinity };
  for (const a of alphas) {
    const ll = mean(losses(tune, a));
    if (ll < best.ll - 1e-12) best = { alpha: a, ll };
  }
  const base = losses(hold, 0);
  const imp = losses(hold, best.alpha);
  const test = pairedTest(imp, base);
  return {
    alpha: best.alpha,
    eligible: rows.length,
    tuneN: tune.length,
    holdoutN: hold.length,
    holdoutLogLossBase: mean(base),
    holdoutLogLossImpact: mean(imp),
    test,
    enabled: best.alpha > 0 && hold.length >= (args.minHoldout ?? 100) && test.z >= (args.zRequired ?? Z_90),
  };
}

function round(x: number, d = 4) {
  return Math.round(x * 10 ** d) / 10 ** d;
}
