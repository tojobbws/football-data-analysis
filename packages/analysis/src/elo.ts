/**
 * Elo ratings (World-Football-Elo style): home advantage + goal-difference multiplier.
 * Used as an independent second opinion for 🤝 Model Agreement, and as the main
 * strength signal for national teams (few matches -> goal models are thin).
 */
import type { MatchRecord } from './dixon-coles.js';

export const ELO_VERSION = 'elo-v0.1';

export interface EloOptions {
  initial?: number;
  k?: number;
  homeAdvantage?: number;
}

export interface EloState {
  ratings: Map<number, number>;
  games: Map<number, number>;
  options: Required<EloOptions>;
}

const DEFAULTS: Required<EloOptions> = { initial: 1500, k: 20, homeAdvantage: 60 };

export function goalDiffMultiplier(gd: number): number {
  const d = Math.abs(gd);
  if (d <= 1) return 1;
  if (d === 2) return 1.5;
  return (11 + d) / 8;
}

export function eloExpected(home: number, away: number, homeAdvantage: number): number {
  return 1 / (1 + 10 ** ((away - (home + homeAdvantage)) / 400));
}

/** Ratings using only matches strictly before `asOf`. */
export function computeElo(all: readonly MatchRecord[], asOf: Date, opts: EloOptions = {}): EloState {
  const o = { ...DEFAULTS, ...opts };
  const ratings = new Map<number, number>();
  const games = new Map<number, number>();
  const matches = all.filter((m) => m.kickoffAt.getTime() < asOf.getTime()).sort((a, b) => a.kickoffAt.getTime() - b.kickoffAt.getTime());
  for (const m of matches) {
    const rh = ratings.get(m.homeTeamId) ?? o.initial;
    const ra = ratings.get(m.awayTeamId) ?? o.initial;
    const exp = eloExpected(rh, ra, o.homeAdvantage);
    const actual = m.homeGoals > m.awayGoals ? 1 : m.homeGoals < m.awayGoals ? 0 : 0.5;
    const delta = o.k * goalDiffMultiplier(m.homeGoals - m.awayGoals) * (actual - exp);
    ratings.set(m.homeTeamId, rh + delta);
    ratings.set(m.awayTeamId, ra - delta);
    games.set(m.homeTeamId, (games.get(m.homeTeamId) ?? 0) + 1);
    games.set(m.awayTeamId, (games.get(m.awayTeamId) ?? 0) + 1);
  }
  return { ratings, games, options: o };
}

/**
 * Elo expected score -> 1X2. Draw share is a heuristic (v0.1): league draw rate,
 * shrinking as the matchup gets more one-sided. Calibrate with the backtest.
 */
export function eloOneXTwo(state: EloState, homeTeamId: number, awayTeamId: number, leagueDrawRate = 0.26) {
  const rh = state.ratings.get(homeTeamId) ?? state.options.initial;
  const ra = state.ratings.get(awayTeamId) ?? state.options.initial;
  const e = eloExpected(rh, ra, state.options.homeAdvantage);
  const draw = leagueDrawRate * Math.exp(-(((e - 0.5) / 0.35) ** 2));
  let home = Math.max(0.01, e - draw / 2);
  let away = Math.max(0.01, 1 - e - draw / 2);
  const s = home + away + draw;
  home /= s;
  away /= s;
  return { home, draw: draw / s, away, expected: e, homeRating: rh, awayRating: ra };
}
