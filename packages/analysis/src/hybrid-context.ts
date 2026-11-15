/**
 * Hybrid AI input v2.0 (docs/adr/0020-hybrid-input-v20.md): context computed by us from stored data, never by the AI.
 * Pure functions; the worker loads the rows and buildHybridInput renders the result.
 */
import { eloExpected, goalDiffMultiplier } from './elo.js';
import type { Tie } from './cup.js';
import type { HybridMarket } from './hybrid-market.js';

const r = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

// ---------------------------------------------------------------- Elo

/** The Elo settings of the Hybrid AI input: the ones of elo-v0.1 (World-Football-Elo style). */
export const HYBRID_ELO = { initial: 1500, k: 20, homeAdvantage: 60 } as const;

export interface EloResult {
  id: number;
  kickoffAt: Date;
  homeTeamId: number;
  awayTeamId: number;
  homeGoals: number;
  awayGoals: number;
}

export interface EloBook {
  /** both teams' ratings just before each match */
  before: Map<number, { home: number; away: number }>;
  /** each team's rating after every result given, and how many matches it rests on */
  current: Map<number, { rating: number; games: number }>;
  /** the latest result counted */
  through: Date | null;
}

/**
 * Elo over every result given (any competition, oldest first), recording both ratings before each match. Every team
 * starts at HYBRID_ELO.initial, so clubs of leagues that never meet (no European or continental match stored between
 * them) are not on one scale; within a league, or between national teams, the ratings compare well.
 */
export function eloBook(results: readonly EloResult[]): EloBook {
  const ratings = new Map<number, number>();
  const games = new Map<number, number>();
  const before = new Map<number, { home: number; away: number }>();
  const sorted = [...results].sort((a, b) => a.kickoffAt.getTime() - b.kickoffAt.getTime() || a.id - b.id);
  for (const m of sorted) {
    const rh = ratings.get(m.homeTeamId) ?? HYBRID_ELO.initial;
    const ra = ratings.get(m.awayTeamId) ?? HYBRID_ELO.initial;
    before.set(m.id, { home: rh, away: ra });
    const actual = m.homeGoals > m.awayGoals ? 1 : m.homeGoals < m.awayGoals ? 0 : 0.5;
    const delta = HYBRID_ELO.k * goalDiffMultiplier(m.homeGoals - m.awayGoals) * (actual - eloExpected(rh, ra, HYBRID_ELO.homeAdvantage));
    ratings.set(m.homeTeamId, rh + delta);
    ratings.set(m.awayTeamId, ra - delta);
    games.set(m.homeTeamId, (games.get(m.homeTeamId) ?? 0) + 1);
    games.set(m.awayTeamId, (games.get(m.awayTeamId) ?? 0) + 1);
  }
  const current = new Map<number, { rating: number; games: number }>();
  for (const [team, rating] of ratings) current.set(team, { rating, games: games.get(team) ?? 0 });
  return { before, current, through: sorted.length ? sorted[sorted.length - 1]!.kickoffAt : null };
}

/** The match's Elo view: both ratings (rounded), the difference and the home side's expected score with home advantage. */
export function eloView(book: EloBook, homeTeamId: number, awayTeamId: number, neutralVenue: boolean) {
  const h = book.current.get(homeTeamId);
  const a = book.current.get(awayTeamId);
  if (!h || !a) return null;
  const adv = neutralVenue ? 0 : HYBRID_ELO.homeAdvantage;
  return {
    home_rating: Math.round(h.rating),
    home_rated_matches: h.games,
    away_rating: Math.round(a.rating),
    away_rated_matches: a.games,
    home_minus_away: Math.round(h.rating - a.rating),
    home_advantage_points: adv,
    home_expected_score: r(eloExpected(h.rating, a.rating, adv), 3),
  };
}

// ---------------------------------------------------------------- table stakes

export interface StakesTableRow {
  teamId: number;
  group: string;
  rank: number;
  points: number;
  played: number;
  zone: string | null;
}

/**
 * Where a team stands against the zones of its table (the provider's descriptions: Champions League, relegation ...):
 * its own zone, the nearest better zone above it and the nearest worse zone below it, with the points between, the
 * leader's gap, and the league matches left. Null when the team is not in the table.
 */
export function tableStakes(table: readonly StakesTableRow[], teamId: number, matchesLeft: number | null) {
  const me = table.find((t) => t.teamId === teamId);
  if (!me) return null;
  const group = table.filter((t) => t.group === me.group).sort((a, b) => a.rank - b.rank);
  const leader = group[0]!;
  const second = group[1];
  // the nearest row above with another zone, and the nearest row below with another zone
  const above = [...group].reverse().find((t) => t.rank < me.rank && t.zone !== me.zone && t.zone !== null);
  const below = group.find((t) => t.rank > me.rank && t.zone !== me.zone && t.zone !== null);
  return {
    rank: me.rank,
    teams_in_table: group.length,
    zone: me.zone,
    league_matches_left_including_this: matchesLeft,
    points_available: matchesLeft === null ? null : matchesLeft * 3,
    ...(me.rank === 1
      ? { points_ahead_of_second: second ? me.points - second.points : null }
      : { points_behind_leader: leader.points - me.points }),
    zone_above: above ? { zone: above.zone, its_lowest_rank: above.rank, points_behind: above.points - me.points } : null,
    zone_below: below ? { zone: below.zone, its_highest_rank: below.rank, points_ahead: me.points - below.points } : null,
  };
}

// ---------------------------------------------------------------- two-legged ties

/**
 * A two-legged tie from the analysed match's side: which leg it is, the first leg's score, the 90-minute aggregate
 * before this match from the home and away teams' sides, and the home team's goal margin in this match that would
 * leave the aggregate level (above it the home team goes through in 90 minutes, below it the away team does).
 */
export function tieSituation(tie: Tie, fixtureId: number, homeTeamId: number, names: { home: string; away: string }) {
  const index = tie.legs.findIndex((l) => l.id === fixtureId);
  if (index < 0) return null;
  const homeIsA = homeTeamId === tie.teamA;
  const level = {
    extra_time: tie.rule.extraTime,
    penalties: tie.rule.penalties,
    away_goals_rule: tie.rule.awayGoals,
  };
  if (index === 0) return { stage: tie.stage, leg: 1, legs: tie.rule.legs, second_leg_home_team: names.away, if_level_after_both_legs: level };
  const first = tie.legs[0]!;
  const aggHome = homeIsA ? tie.aggregate.a : tie.aggregate.b;
  const aggAway = homeIsA ? tie.aggregate.b : tie.aggregate.a;
  const levelMargin = aggAway - aggHome;
  return {
    stage: tie.stage,
    leg: 2,
    legs: tie.rule.legs,
    first_leg: first.ft ? { home_team: first.homeId === homeTeamId ? names.home : names.away, score_home_away: `${first.ft[0]}-${first.ft[1]}` } : null,
    aggregate_before_this_match: { [names.home]: aggHome, [names.away]: aggAway },
    home_margin_that_levels_aggregate: levelMargin,
    meaning:
      levelMargin > 0
        ? `${names.home} must win by more than ${levelMargin} to go through in 90 minutes`
        : levelMargin < 0
          ? `${names.home} go through in 90 minutes with a draw, a win, or a defeat by fewer than ${-levelMargin}`
          : `the aggregate is level: the winner of this match goes through in 90 minutes`,
    if_level_after_90_minutes: level,
  };
}

// ---------------------------------------------------------------- market movement

/** The market's main lines at one moment, from the home side, for comparing moments. */
export function marketMoment(m: HybridMarket, kickoffAt: Date) {
  const home = m.ah.options.find((o) => o.selection === 'HOME');
  const over = m.ou.options.find((o) => o.selection === 'OVER');
  return {
    as_of_utc: m.asOf,
    hours_before_kickoff: r((kickoffAt.getTime() - Date.parse(m.asOf)) / 3_600_000, 1),
    handicap_home_line: m.ah.status === 'OK' || m.ah.status === 'NO_FAVOURITE' ? m.ah.line : null,
    handicap_home_probability_no_vig: home ? home.marketProbability : null,
    total_line: m.ou.status === 'OK' ? m.ou.line : null,
    over_probability_no_vig: over ? over.marketProbability : null,
    match_odds_no_vig: m.x12 ? { home: m.x12.home, draw: m.x12.draw, away: m.x12.away } : null,
  };
}

type Moment = ReturnType<typeof marketMoment>;

/**
 * How the market moved from its opening (the first quotes we stored) and from 24 hours ago to now: line changes and,
 * on the 1X2, the change of the home and away win chances in percentage points. A positive handicap change means the
 * home line rose, so the market rates the home team lower.
 */
export function marketMovement(opening: Moment | null, dayAgo: Moment | null, now: Moment) {
  const diff = (a: number | null, b: number | null, d = 2) => (a === null || b === null ? null : r(b - a, d));
  const pts = (a: number | null | undefined, b: number | null | undefined) => (a == null || b == null ? null : r((b - a) * 100, 1));
  const change = (from: Moment | null) =>
    from
      ? {
          handicap_home_line_change: diff(from.handicap_home_line, now.handicap_home_line),
          total_line_change: diff(from.total_line, now.total_line),
          home_win_chance_change_points: pts(from.match_odds_no_vig?.home, now.match_odds_no_vig?.home),
          away_win_chance_change_points: pts(from.match_odds_no_vig?.away, now.match_odds_no_vig?.away),
        }
      : null;
  return { opening, day_ago: dayAgo, now, since_opening: change(opening), since_day_ago: change(dayAgo) };
}
