/**
 * Hybrid AI decision engine (docs/adr/0010-hybrid-ai-picks.md): the AI reads verified pre-match data and the
 * market's main lines and chooses one of AH favourite, AH underdog, Over, Under, or NO_PICK.
 *
 * Every number the AI sees is computed here from stored data (averages, rest days, prices); the AI chooses and
 * explains, it never creates a number: its Thai text is checked so every number traces back to the input.
 * Bump HYBRID_PROMPT_VERSION on any change to the prompt, the schema or the input; every stored decision
 * records the version that produced it.
 */
import { z } from 'zod';
import { STARTERS_WINDOW, type HybridMarket, type HybridOption, type HybridSide, type RegularStarters, type StartersCompetitionKind } from '@fp/analysis';
import { BANNED_WORDS, allowedNumbers, inventedNumbers } from './guards.js';

export const HYBRID_ENGINE_VERSION = 'hybrid-ai-v1';
// v1.1 (2026-10-27): the 14-day window is a value in the input (the AI quoted it and the number guard refused it)
// v1.2 (2026-10-30): each team carries next_match, its next scheduled fixture in a tracked competition (rotation context)
// v1.3 (2026-10-30): input v2 on: each opponent's table position as of its match date (null for a cup or split league),
//   and whether the league reports injuries at all (docs/research/hybrid-input-audit-2026-10-29.md, gaps G1 and G2)
// v1.4 (2026-10-30): the Thai text no longer states the confidence level (it is the `confidence` field, shown in admin only)
// v1.5 (2026-11-04): expected-goals metrics per match and per window: xG difference, npxG, shooting performance,
//   xPTS and goals prevented (input flag `xgMetrics`; computed here, see expectedMetrics())
// v1.6 (2026-11-05): legacy_statistical_model (Dixon-Coles) is gone from the input and the prompt: it leaned about 5 points
//   to the underdog and the under, and beside the market it added nothing; and the AI answers HYBRID_VOTES times on the
//   same input, a choice being used only when HYBRID_MAJORITY answers agree (docs/adr/0013-hybrid-majority-of-three.md)
// v1.7 (2026-11-10): recent_starters, how many of each team's last stored lineups each player started (a domestic cup also
//   marks the previous round's XI), and each injury's recent starts (docs/adr/0016-regular-starters.md)
// v1.8 (2026-11-15): total_goals_vs_line counts recent totals against the market's main over/under line (over, exactly
//   on a whole line, under) in place of a fixed 2.5; rest days and recent congestion are counted to this match's kickoff,
//   not to the decision time; data_quality.recent_matches_scope says a team's matches in competitions we do not store
//   (most domestic cups) are missing (docs/adr/0019-over-under-shadow.md)
// v1.9 (2026-11-15): an Over/Under choice needs the chance figures of both teams (npxG for and against, shots on target)
//   to agree with the counts at the line, and a line far from 2.5 or a gap in strength is not argued against on recent
//   goal counts alone; without xG for most matches, no total (the 28 O/U misses read one by one, ADR 0019 amendment 2)
// v2.0 (2026-11-16): input v2.0, the owner's list (docs/adr/0020-hybrid-input-v20.md): market movement, two-legged tie,
//   table stakes, season home/away record, red cards, injured players' season figures, head to head, derby, neutral
//   venue, possession / corners / yellow cards, API-Football's prediction; computed: each recent match against the
//   closing market, Elo ratings (team and opponents), starters' workload. Frozen after this until 100 settled picks.
export const HYBRID_PROMPT_VERSION = 'hybrid-ai-v2.0';
/**
 * v1.8: what recent_matches, rest_days_before_this_match and recent_congestion can miss. Checked 2026-11-15: the FA Cup,
 * DFB-Pokal, Coppa Italia, Coupe de France, KNVB Beker and Taça de Portugal are not in the database at all.
 */
export const RECENT_MATCHES_SCOPE =
  'competitions we store only: a team\'s matches in competitions we do not store (most domestic cups, such as the FA Cup, DFB-Pokal, Coppa Italia and Coupe de France) are missing, so a team may have played more recently and more often than recent_matches, rest_days_before_this_match and recent_congestion show';
/** The total the recent matches are counted against when the market has no usable main over/under line. */
export const FALLBACK_TOTAL_LINE = 2.5;
/**
 * The provider's xG of one penalty: API-Football's xG counts penalties at exactly this value (a team whose only shot
 * was a penalty has xG 0.79; checked on the stored matches 2026-11-04). npxG takes it off once per penalty taken.
 */
export const PENALTY_XG = 0.79;
/** The pick decision matters more than prose: Sonnet by default, HYBRID_AI_MODEL overrides it. */
export const HYBRID_AI_MODEL = 'claude-sonnet-5-5';
/** Answers that fail validation are asked again this many times in total before the decision fails safely. */
export const HYBRID_MAX_ATTEMPTS = 2;
/**
 * v1.6: the AI answers this many times on the same input (independent calls). Asked twice on the same live input, the
 * model gave the same answer only 118 times in 201 (replay of 2026-11-05): a single answer is partly chance.
 */
export const HYBRID_VOTES = 3;
/** A choice (an option or NO_PICK) is used only when at least this many valid answers gave it. */
export const HYBRID_MAJORITY = 2;

/**
 * The choice that at least `majority` of the answers gave (null = an answer that is not valid) and the index of the
 * first answer that gave it; null when no choice reaches the majority.
 */
export function majorityVote<S extends string>(sides: ReadonlyArray<S | null>, majority = HYBRID_MAJORITY): { side: S; votes: number; first: number } | null {
  const counts = new Map<S, number>();
  for (const s of sides) if (s !== null) counts.set(s, (counts.get(s) ?? 0) + 1);
  let best: { side: S; votes: number; first: number } | null = null;
  for (const [side, votes] of counts) if (votes >= majority && (!best || votes > best.votes)) best = { side, votes, first: sides.indexOf(side) };
  return best;
}

// ---------------------------------------------------------------- input

/** One finished match of a team, from that team's side. */
export interface TeamMatch {
  kickoffAt: string;
  competition: string;
  venue: 'HOME' | 'AWAY';
  opponent: string;
  /** opponent's current table position in that competition and the table size; null when unknown */
  opponentRank: number | null;
  opponentTableSize: number | null;
  goalsFor: number;
  goalsAgainst: number;
  xgFor: number | null;
  xgAgainst: number | null;
  shotsOnTargetFor: number | null;
  shotsOnTargetAgainst: number | null;
  shotsFor: number | null;
  shotsAgainst: number | null;
  /** Inputs of the expected-goals metrics (prompt v1.5); undefined or null = unknown, the metric is then null. */
  status?: 'FT' | 'AET' | 'PEN';
  /** score including extra time (the period xG covers); goalsFor/goalsAgainst are the 90-minute score */
  fullGoalsFor?: number | null;
  fullGoalsAgainst?: number | null;
  /** penalties taken in play, scored or missed; null when the match has no events stored */
  penaltiesFor?: number | null;
  penaltiesAgainst?: number | null;
  /** goals the opponent put into its own net, counted for this team */
  ownGoalsFor?: number | null;
  /** the provider's goals prevented of this team's goalkeepers */
  goalsPreventedFor?: number | null;
  /** Prompt v2.0 (input `v20`), each undefined/null when unknown. Not shown: the fixture id. */
  fixtureId?: number;
  possessionFor?: number | null;
  cornersFor?: number | null;
  cornersAgainst?: number | null;
  yellowCardsFor?: number | null;
  yellowCardsAgainst?: number | null;
  /** minute of each red card; null = no match events stored */
  redCardMinutesFor?: Array<number | null> | null;
  redCardMinutesAgainst?: Array<number | null> | null;
  /** the market's main lines at kickoff: the team's own handicap line (−1.25 = it gave 1.25 goals) and the total */
  closingHandicapLine?: number | null;
  closingTotalLine?: number | null;
  /** both Elo ratings just before that match */
  teamEloBefore?: number | null;
  opponentEloBefore?: number | null;
}

/**
 * Prompt v2.0 (docs/adr/0020-hybrid-input-v20.md): context computed by the worker from stored data and rendered as
 * given. Every number is ours or the provider's, never the AI's.
 */
export interface HybridContextV20 {
  /** stage, neutral venue, derby, two-legged tie, head to head */
  matchContext: Record<string, unknown>;
  /** both teams' current Elo ratings (eloView) */
  elo: Record<string, unknown> | null;
  /** opening / 24 hours ago / now of the main lines (marketMovement) */
  marketMovement: Record<string, unknown> | null;
  /** API-Football's own prediction, a third party's formula */
  apiFootballPrediction: Record<string, unknown> | null;
  /** per team: season home/away record, table stakes, absences, starters' workload */
  home: Record<string, unknown>;
  away: Record<string, unknown>;
  /** season figures of injured players by player id (goals, assists, minutes, rating) */
  injuredPlayerFigures: Map<number, Record<string, unknown>>;
}

export interface TeamStanding {
  rank: number | null;
  tableSize: number | null;
  played: number | null;
  points: number | null;
  goalDiff: number | null;
}

/** A team's next scheduled fixture after the analysed one, in the competitions we track. */
export interface NextMatch {
  kickoffAt: string;
  competition: string;
  venue: 'HOME' | 'AWAY';
}

export interface HybridSource {
  fixture: { id: number; home: string; away: string; league: string; kickoffAt: Date };
  predictionAt: Date;
  publishRound: string;
  /** newest first, at most 10 each, all before the prediction time */
  recent: { home: TeamMatch[]; away: TeamMatch[] };
  standings: { home: TeamStanding | null; away: TeamStanding | null };
  /** `playerId` joins an injury to recent_starters; it is not shown to the AI */
  injuries: Array<{ team: 'HOME' | 'AWAY' | null; player: string | null; type: string | null; reason: string | null; playerId?: number | null }>;
  lineup: { home: string[]; away: string[] } | null;
  market: HybridMarket;
  /**
   * Prompt v1.7: each team's starts in its last stored lineups (regularStarters()), and the analysed match's competition
   * kind. Undefined = the input has no recent_starters and the injuries carry no starts.
   */
  regularStarters?: { kind: StartersCompetitionKind; home: RegularStarters; away: RegularStarters };
  /**
   * Each team's next fixture after this one (null = none found in the tracked competitions). Undefined = not looked up,
   * the input then has no next_match at all.
   */
  nextMatch?: { home: NextMatch | null; away: NextMatch | null };
  /**
   * Input v2 only (undefined = v1, the input is then unchanged). Whether the API reports injuries for this league at all:
   * an empty `injuries` list is only "nobody is out" when it does.
   */
  injuriesCoverage?: 'available' | 'unavailable_for_league';
  /** Input v2 only. How each recent match's opponent position was obtained: today's table, or rebuilt as of that match's date. */
  opponentRankBasis?: 'current_table' | 'as_of_results';
  /**
   * Prompt v1.5: add the expected-goals metrics (xG difference, npxG, shooting performance, xPTS, goals prevented)
   * to each recent match and each window. Undefined/false = the input is unchanged.
   */
  xgMetrics?: boolean;
  /** Prompt v2.0: the added context (undefined = the input is that of v1.9). */
  v20?: HybridContextV20;
}

const r =(x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const avg = (xs: number[]) => (xs.length ? r(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

const sum = (xs: number[]) => (xs.length ? r(xs.reduce((a, b) => a + b, 0)) : null);

function poissonPmf(lambda: number, maxGoals: number): number[] {
  const out: number[] = [];
  let p = Math.exp(-lambda);
  for (let k = 0; k <= maxGoals; k++) {
    out.push(p);
    p = (p * lambda) / (k + 1);
  }
  return out;
}

/**
 * Expected points of a team from one match's xG: its goals and the opponent's as independent Poisson counts with
 * means xgFor and xgAgainst, 3 points per win and 1 per draw. A model of ours (not a provider figure).
 */
export function expectedPoints(xgFor: number, xgAgainst: number, maxGoals = 20): number {
  const f = poissonPmf(Math.max(0, xgFor), maxGoals);
  const a = poissonPmf(Math.max(0, xgAgainst), maxGoals);
  let win = 0;
  let draw = 0;
  for (let i = 0; i <= maxGoals; i++)
    for (let j = 0; j <= maxGoals; j++) {
      if (i > j) win += f[i]! * a[j]!;
      else if (i === j) draw += f[i]! * a[j]!;
    }
  return 3 * win + draw;
}

/**
 * The expected-goals metrics of one match from the team's side (prompt v1.5), each null when an input is missing:
 *  - xg_difference: xG for minus xG against
 *  - npxg_for / npxg_against: xG minus PENALTY_XG per penalty taken in play
 *  - shooting_performance: goals from the team's own shots (full match, the opponent's own goals taken off) minus xG
 *  - xpts: expectedPoints() of the match, 90-minute (FT) matches only (xG of an extra-time match covers 120 minutes)
 *  - goals_prevented: the provider's figure for the team's goalkeepers
 */
export function expectedMetrics(m: TeamMatch) {
  const both = m.xgFor !== null && m.xgAgainst !== null;
  const np = (xg: number | null, pens: number | null | undefined) => (xg === null || pens == null ? null : r(Math.max(0, xg - PENALTY_XG * pens)));
  const ownShotGoals = m.fullGoalsFor != null && m.ownGoalsFor != null ? m.fullGoalsFor - m.ownGoalsFor : null;
  return {
    xg_difference: both ? r(m.xgFor! - m.xgAgainst!) : null,
    npxg_for: np(m.xgFor, m.penaltiesFor),
    npxg_against: np(m.xgAgainst, m.penaltiesAgainst),
    shooting_performance: m.xgFor !== null && ownShotGoals !== null ? r(ownShotGoals - m.xgFor) : null,
    xpts: both && m.status === 'FT' ? r(expectedPoints(m.xgFor!, m.xgAgainst!)) : null,
    goals_prevented: m.goalsPreventedFor ?? null,
  };
}

const points = (m: TeamMatch) => (m.goalsFor > m.goalsAgainst ? 3 : m.goalsFor === m.goalsAgainst ? 1 : 0);

/** The window figures of the expected-goals metrics, each with the number of matches it rests on. */
function metricsSummary(ms: readonly TeamMatch[]) {
  const rows = ms.map((m) => ({ m, x: expectedMetrics(m) }));
  const pick = (f: (x: ReturnType<typeof expectedMetrics>) => number | null) => rows.map((r) => f(r.x)).filter((v): v is number => v !== null);
  const withXpts = rows.filter((r) => r.x.xpts !== null);
  const npF = pick((x) => x.npxg_for);
  const sp = pick((x) => x.shooting_performance);
  const gp = pick((x) => x.goals_prevented);
  return {
    xg_difference_avg: avg(pick((x) => x.xg_difference)),
    npxg_for_avg: avg(npF),
    npxg_against_avg: avg(pick((x) => x.npxg_against)),
    npxg_matches: npF.length,
    shooting_performance_total: sum(sp),
    shooting_performance_matches: sp.length,
    xpts_avg: avg(withXpts.map((r) => r.x.xpts!)),
    points_avg_same_matches: avg(withXpts.map((r) => points(r.m))),
    xpts_matches: withXpts.length,
    goals_prevented_total: sum(gp),
    goals_prevented_matches: gp.length,
  };
}

/**
 * Prompt v1.8: how many matches' 90-minute total went over, landed exactly on, or stayed under `line` (the market's
 * main over/under line). `exactly` exists only on a whole line, where that total is a push; on a quarter line a total
 * next to the line counts on its side (3 goals is over 2.75, a half win).
 */
export function totalGoalsVsLine(ms: readonly TeamMatch[], line: number) {
  const totals = ms.map((m) => m.goalsFor + m.goalsAgainst);
  return {
    line,
    over: totals.filter((t) => t > line).length,
    ...(Number.isInteger(line) ? { exactly: totals.filter((t) => t === line).length } : {}),
    under: totals.filter((t) => t < line).length,
  };
}

/**
 * Prompt v2.0: one match's added figures. Against the market at kickoff: the line is the margin the market expected
 * (−1.25 = the team was expected to win by about 1.25), so goal difference + line above 0 = the team beat that
 * expectation, and the same with xG difference; for totals, goals (or xG) minus the closing total.
 */
export function matchExtras(m: TeamMatch) {
  const gd = m.goalsFor - m.goalsAgainst;
  const xgd = m.xgFor != null && m.xgAgainst != null ? m.xgFor - m.xgAgainst : null;
  const ah = m.closingHandicapLine ?? null;
  const tot = m.closingTotalLine ?? null;
  return {
    possession_pct: m.possessionFor ?? null,
    corners_for: m.cornersFor ?? null,
    corners_against: m.cornersAgainst ?? null,
    yellow_cards_for: m.yellowCardsFor ?? null,
    yellow_cards_against: m.yellowCardsAgainst ?? null,
    red_card_minutes_for: m.redCardMinutesFor ?? null,
    red_card_minutes_against: m.redCardMinutesAgainst ?? null,
    team_elo_before: m.teamEloBefore == null ? null : Math.round(m.teamEloBefore),
    opponent_elo_before: m.opponentEloBefore == null ? null : Math.round(m.opponentEloBefore),
    closing_handicap_line_for_team: ah,
    goal_diff_vs_closing_line: ah === null ? null : r(gd + ah),
    xg_diff_vs_closing_line: ah === null || xgd === null ? null : r(xgd + ah),
    closing_total_line: tot,
    total_goals_vs_closing_line: tot === null ? null : r(m.goalsFor + m.goalsAgainst - tot),
    xg_total_vs_closing_line: tot === null || m.xgFor == null || m.xgAgainst == null ? null : r(m.xgFor + m.xgAgainst - tot),
  };
}

/** Prompt v2.0: the window figures of matchExtras(), each with the number of matches it rests on. */
function extrasSummary(ms: readonly TeamMatch[]) {
  const xs = ms.map(matchExtras);
  const pick = (f: (x: ReturnType<typeof matchExtras>) => number | null) => xs.map(f).filter((v): v is number => v !== null);
  const known = (f: (x: ReturnType<typeof matchExtras>) => Array<number | null> | null) => xs.filter((x) => f(x) !== null);
  const gdLine = pick((x) => x.goal_diff_vs_closing_line);
  const totLine = pick((x) => x.total_goals_vs_closing_line);
  return {
    possession_avg: avg(pick((x) => x.possession_pct)),
    corners_for_avg: avg(pick((x) => x.corners_for)),
    corners_against_avg: avg(pick((x) => x.corners_against)),
    yellow_cards_for_avg: avg(pick((x) => x.yellow_cards_for)),
    matches_with_events: known((x) => x.red_card_minutes_for).length,
    matches_with_red_card_for: known((x) => x.red_card_minutes_for).filter((x) => x.red_card_minutes_for!.length > 0).length,
    matches_with_red_card_against: known((x) => x.red_card_minutes_against).filter((x) => x.red_card_minutes_against!.length > 0).length,
    opponent_elo_avg: (() => {
      const e = pick((x) => x.opponent_elo_before);
      return e.length ? Math.round(e.reduce((a, b) => a + b, 0) / e.length) : null;
    })(),
    vs_closing_market: {
      matches: gdLine.length,
      goal_diff_vs_closing_line_avg: avg(gdLine),
      xg_diff_vs_closing_line_avg: avg(pick((x) => x.xg_diff_vs_closing_line)),
      total_matches: totLine.length,
      total_goals_vs_closing_line_avg: avg(totLine),
      xg_total_vs_closing_line_avg: avg(pick((x) => x.xg_total_vs_closing_line)),
    },
  };
}

/** Averages over the matches that have the value, with how many had it. */
function summary(ms: readonly TeamMatch[], totalLine: number, xgMetrics = false, v20 = false) {
  const pick = (f: (m: TeamMatch) => number | null) => ms.map(f).filter((x): x is number => x !== null);
  const xgF = pick((m) => m.xgFor);
  const xgA = pick((m) => m.xgAgainst);
  const sotF = pick((m) => m.shotsOnTargetFor);
  const sotA = pick((m) => m.shotsOnTargetAgainst);
  return {
    matches: ms.length,
    wins: ms.filter((m) => m.goalsFor > m.goalsAgainst).length,
    draws: ms.filter((m) => m.goalsFor === m.goalsAgainst).length,
    losses: ms.filter((m) => m.goalsFor < m.goalsAgainst).length,
    goals_for_avg: avg(ms.map((m) => m.goalsFor)),
    goals_against_avg: avg(ms.map((m) => m.goalsAgainst)),
    // the line is a value, not only part of a key: the AI may then quote it (number guard)
    total_goals_vs_line: totalGoalsVsLine(ms, totalLine),
    xg_for_avg: avg(xgF),
    xg_against_avg: avg(xgA),
    xg_matches: xgF.length,
    shots_on_target_for_avg: avg(sotF),
    shots_on_target_against_avg: avg(sotA),
    shots_matches: sotF.length,
    ...(xgMetrics ? metricsSummary(ms) : {}),
    ...(v20 ? extrasSummary(ms) : {}),
  };
}

function team(name: string, ms: readonly TeamMatch[], venue: 'HOME' | 'AWAY', standing: TeamStanding | null, kickoffAt: Date, totalLine: number, next?: { match: NextMatch | null; from: Date }, xgMetrics = false, extra?: Record<string, unknown>) {
  const v20 = extra !== undefined;
  const last = ms[0];
  // v1.8: days counted to this match's kickoff, not to the decision time (a DAILY decision can come a day before it)
  const days = (iso: string) => (kickoffAt.getTime() - Date.parse(iso)) / 86_400_000;
  return {
    name,
    recent_matches: ms.map((m) => ({
      date_utc: m.kickoffAt.slice(0, 10),
      competition: m.competition,
      venue: m.venue,
      opponent: m.opponent,
      opponent_table_position: m.opponentRank === null ? null : `${m.opponentRank}/${m.opponentTableSize ?? '?'}`,
      score_for_against: `${m.goalsFor}-${m.goalsAgainst}`,
      xg_for: m.xgFor,
      xg_against: m.xgAgainst,
      shots_on_target_for: m.shotsOnTargetFor,
      shots_on_target_against: m.shotsOnTargetAgainst,
      ...(xgMetrics ? expectedMetrics(m) : {}),
      ...(v20 ? matchExtras(m) : {}),
    })),
    last_10: summary(ms.slice(0, 10), totalLine, xgMetrics, v20),
    last_5: summary(ms.slice(0, 5), totalLine, xgMetrics, v20),
    [venue === 'HOME' ? 'home_matches_in_last_10' : 'away_matches_in_last_10']: summary(ms.slice(0, 10).filter((m) => m.venue === venue), totalLine, xgMetrics, v20),
    rest_days_before_this_match: last ? r(days(last.kickoffAt), 1) : null,
    // the window is a value, not only part of a key: the AI may then quote it (number guard)
    recent_congestion: { days: 14, matches: ms.filter((m) => days(m.kickoffAt) <= 14).length },
    league_table: standing,
    ...(next
      ? {
          next_match: next.match
            ? {
                // computed here from the stored kickoff times, never by the AI
                days_after_this_match: r((Date.parse(next.match.kickoffAt) - next.from.getTime()) / 86_400_000, 1),
                date_utc: next.match.kickoffAt.slice(0, 10),
                competition: next.match.competition,
                venue: next.match.venue,
              }
            : null,
        }
      : {}),
    ...(extra ?? {}),
  };
}

const optionView = (o: HybridOption, home: string, away: string) => ({
  option: o.side,
  team_or_total: o.market === 'OVER_UNDER' ? o.selection : o.selection === 'HOME' ? home : away,
  line: o.line,
  odds_median: o.odds,
  market_probability_no_vig: o.marketProbability,
});

/** One team's recent_starters (prompt v1.7): dates and counts computed here from the stored lineups. */
function startersView(t: RegularStarters, kind: StartersCompetitionKind) {
  const cup = kind === 'DOMESTIC_CUP';
  return {
    lineups: t.of,
    from_date_utc: t.from ? t.from.toISOString().slice(0, 10) : null,
    to_date_utc: t.to ? t.to.toISOString().slice(0, 10) : null,
    ...(cup ? { previous_cup_round_date_utc: t.previousCupRound ? t.previousCupRound.kickoffAt.toISOString().slice(0, 10) : null } : {}),
    players: t.players.map((p) => ({ player: p.name, starts: p.starts, ...(cup ? { started_previous_cup_round: p.startedPreviousCupRound } : {}) })),
  };
}

export function buildHybridInput(src: HybridSource): Record<string, unknown> {
  const { fixture: fx, market: m } = src;
  const missing: string[] = [];
  const recentHome = src.recent.home.slice(0, 10);
  const recentAway = src.recent.away.slice(0, 10);
  if (recentHome.length < 10) missing.push(`${fx.home}: ${recentHome.length} of 10 recent matches`);
  if (recentAway.length < 10) missing.push(`${fx.away}: ${recentAway.length} of 10 recent matches`);
  const noXg = [...recentHome, ...recentAway].filter((x) => x.xgFor === null).length;
  if (noXg) missing.push(`no xG for ${noXg} recent matches`);
  if (src.opponentRankBasis === 'as_of_results') {
    const noRank = [...recentHome, ...recentAway].filter((x) => x.opponentRank === null).length;
    if (noRank) missing.push(`no opponent table position for ${noRank} recent matches (a cup, a split league, or the opponent had not played yet)`);
  }
  if (src.xgMetrics) {
    const recent = [...recentHome, ...recentAway];
    const noGp = recent.filter((x) => x.goalsPreventedFor == null).length;
    if (noGp) missing.push(`no goals prevented for ${noGp} recent matches`);
    const noPen = recent.filter((x) => x.xgFor !== null && x.penaltiesFor == null).length;
    if (noPen) missing.push(`no npxG for ${noPen} recent matches that have xG (no match events stored)`);
    const extraTime = recent.filter((x) => x.xgFor !== null && x.status !== undefined && x.status !== 'FT').length;
    if (extraTime) missing.push(`no xPTS for ${extraTime} recent matches that went to extra time`);
  }
  if (src.nextMatch) {
    if (!src.nextMatch.home) missing.push(`${fx.home}: no next fixture in the competitions we track`);
    if (!src.nextMatch.away) missing.push(`${fx.away}: no next fixture in the competitions we track`);
  }
  if (!src.lineup) missing.push('lineups not confirmed yet');
  const rs = src.regularStarters;
  if (rs) {
    if (rs.home.of < 3) missing.push(`${fx.home}: only ${rs.home.of} stored lineups for recent_starters`);
    if (rs.away.of < 3) missing.push(`${fx.away}: only ${rs.away.of} stored lineups for recent_starters`);
  }
  if (!src.standings.home || !src.standings.away) missing.push('league table not available for both teams');
  if (src.injuriesCoverage === 'unavailable_for_league') missing.push('this league provides no injury data: an empty injuries list does not mean nobody is out');
  // 18 Nov 2026 (owner): a league that reports injuries can still have none for this match yet (Brazil Serie A, first
  // round after the international break: 0 rows from the provider at 14:00, usually ~44 h before kickoff)
  else if (src.injuriesCoverage === 'available' && src.injuries.length === 0)
    missing.push('no injury report for this match from the data provider yet: an empty injuries list does not mean nobody is out');
  if (m.ah.status !== 'OK') missing.push(`no usable main Asian handicap line (${m.ah.status})`);
  if (m.ou.status !== 'OK') missing.push(`no usable main over/under line (${m.ou.status})`);
  const totalLine = m.ou.status === 'OK' && m.ou.line !== null ? m.ou.line : FALLBACK_TOTAL_LINE;
  const v = src.v20;
  if (v) {
    if (!v.elo) missing.push('no Elo rating for one or both teams');
    if (!v.marketMovement) missing.push('no market movement (no earlier main line stored)');
    if (!v.apiFootballPrediction) missing.push('no API-Football prediction stored');
    const noClose = [...recentHome, ...recentAway].filter((x) => x.closingHandicapLine == null).length;
    if (noClose) missing.push(`no closing market line for ${noClose} recent matches (kept from 2026-10-04, tracked leagues only)`);
  }

  return {
    match: { home: fx.home, away: fx.away, competition: fx.league, kickoff_utc: fx.kickoffAt.toISOString(), publish_round: src.publishRound },
    prediction_timestamp_utc: src.predictionAt.toISOString(),
    ...(v ? { match_context: v.matchContext, elo_ratings: v.elo } : {}),
    home_team: team(fx.home, recentHome, 'HOME', src.standings.home, fx.kickoffAt, totalLine, src.nextMatch && { match: src.nextMatch.home, from: fx.kickoffAt }, src.xgMetrics, v?.home),
    away_team: team(fx.away, recentAway, 'AWAY', src.standings.away, fx.kickoffAt, totalLine, src.nextMatch && { match: src.nextMatch.away, from: fx.kickoffAt }, src.xgMetrics, v?.away),
    injuries: src.injuries.map(({ playerId, ...i }) => {
      const season = v && playerId != null ? { season_figures: v.injuredPlayerFigures.get(playerId) ?? null } : {};
      if (!rs) return { ...i, ...season };
      const starters = i.team === 'HOME' ? rs.home : i.team === 'AWAY' ? rs.away : null;
      const p = starters && playerId != null ? starters.players.find((x) => x.playerId === playerId) : undefined;
      return { ...i, recent_starts: starters ? (p?.starts ?? 0) : null, recent_lineups: starters ? starters.of : null, ...season };
    }),
    confirmed_lineup: src.lineup,
    ...(rs
      ? {
          recent_starters: {
            // the window is a value, not only part of the text: the AI may then quote it (number guard)
            window_lineups: STARTERS_WINDOW,
            basis: "starts in each team's last window_lineups stored lineups before this match, any competition: a count of past matches, not the coming lineup",
            ...(rs.kind === 'DOMESTIC_CUP'
              ? { domestic_cup: 'this is a domestic cup, where teams often rotate: started_previous_cup_round marks who started the previous round of this cup this season (null when there was none stored)' }
              : {}),
            home: startersView(rs.home, rs.kind),
            away: startersView(rs.away, rs.kind),
          },
        }
      : {}),
    market: {
      asian_handicap: {
        status: m.ah.status,
        home_line: m.ah.line,
        favourite: m.ah.favourite === 'HOME' ? fx.home : m.ah.favourite === 'AWAY' ? fx.away : null,
        bookmakers: m.ah.nBookmakers,
        price_age_hours: m.ah.ageHours,
        options: m.ah.options.map((o) => optionView(o, fx.home, fx.away)),
      },
      over_under: {
        status: m.ou.status,
        line: m.ou.line,
        bookmakers: m.ou.nBookmakers,
        price_age_hours: m.ou.ageHours,
        options: m.ou.options.map((o) => optionView(o, fx.home, fx.away)),
      },
      match_odds_1x2_no_vig: m.x12,
      ...(v ? { movement: v.marketMovement } : {}),
    },
    ...(v ? { api_football_prediction: v.apiFootballPrediction } : {}),
    data_quality: {
      home_recent_matches: recentHome.length,
      away_recent_matches: recentAway.length,
      lineups_confirmed: Boolean(src.lineup),
      total_goals_vs_line:
        m.ou.status === 'OK' && m.ou.line !== null
          ? 'recent 90-minute totals counted against market.over_under.line: over, exactly (a whole line only, a push) and under'
          : `no usable main over/under line: recent 90-minute totals counted against ${FALLBACK_TOTAL_LINE}`,
      injuries_reported: src.injuries.length,
      recent_matches_scope: RECENT_MATCHES_SCOPE,
      ...(src.nextMatch ? { next_match_scope: 'competitions we track only: a missing next_match does not mean the team has no fixture' } : {}),
      ...(src.injuriesCoverage ? { injuries_coverage: src.injuriesCoverage } : {}),
      ...(src.opponentRankBasis ? { opponent_rank_basis: src.opponentRankBasis } : {}),
      ...(src.xgMetrics
        ? {
            expected_goals_metrics: {
              source: 'computed by us from the stored match statistics and events; only xG and goals_prevented come from the data provider',
              penalty_xg: PENALTY_XG,
              npxg: 'xG minus penalty_xg for each penalty taken in play (scored or missed)',
              shooting_performance: "goals from the team's own shots minus its xG, the opponent's own goals not counted; above 0 = scored more than its chances, below 0 = fewer",
              xpts: 'expected points from the two xG values (independent Poisson goals); 90-minute matches only',
              goals_prevented: "the provider's figure for the team's goalkeepers; above 0 = conceded fewer than the shots faced were expected to give",
            },
          }
        : {}),
      missing,
    },
  };
}

// ---------------------------------------------------------------- prompt and schema

/** Prompt v2.0: what each added value is and what it is for (docs/adr/0020-hybrid-input-v20.md). */
export const HYBRID_V20_GUIDE = `Added context (each value below is computed by us or given by a data provider; when a value is null it is unknown, never zero):

- match_context.stage, match_context.neutral_venue: the round of the competition and whether it is played at a neutral ground. At a neutral venue there is no home advantage: read the home/away labels as administrative only.
- match_context.derby: a named rivalry (null for most matches). A derby is often tighter and more physical than the two teams' gap suggests; treat it as a reason for caution, not as a direction.
- match_context.two_legged_tie: in a two-legged cup tie, which leg this is; in the second leg, the first leg's score, the aggregate before this match and home_margin_that_levels_aggregate (the home team's winning margin in this match that leaves the aggregate level; meaning spells it out). Use it to judge each team's needs: a team protecting a lead may sit back and a team chasing must attack, which changes both the margin and the total. A first leg is often cautious.
- match_context.head_to_head: the last stored meetings of these two teams, any competition, with the home team's wins, draws and losses. Few matches, often old and with different squads: weak evidence, only for colour or to break a near tie; never a main reason.
- elo_ratings: both teams' current Elo ratings from every stored result (team strength that moves with each result and the margin, weighting who the opponent was), their difference, and home_expected_score (the Elo expected score of the home team, home advantage included; 0.5 = even). Each recent match also carries team_elo_before and opponent_elo_before, and each window opponent_elo_avg: use them to judge how strong the opponents behind a form run really were, better than table positions in cups and split leagues. Ratings compare well within a league and between national teams; clubs of different countries are linked only through the continental matches we store, so treat a cross-country gap as rough. A rating resting on few rated matches is weak.
- table_context.zone and table_context.stakes: the team's zone in its table (title, Champions League, relegation and the like, as the provider names it), the nearest better zone above and worse zone below with the points between, the leader's gap and the league matches left. Use them to judge motivation late in a season: a team in a tight race has more to play for than one safe in mid-table. Early in a season every gap is small and stakes say little.
- table_context.season_home_record / table_context.season_away_record: the team's whole-season home and away record in this league (played, wins, draws, losses, goals). It rests on more matches than home_matches_in_last_10 or away_matches_in_last_10; weigh both.
- Each recent match: possession_pct, corners_for / corners_against and yellow_cards_for / yellow_cards_against describe how the team played (territory, pressure, discipline); weaker than xG and shots on target, use them as support only. red_card_minutes_for / red_card_minutes_against list the minute of each red card (empty = none; null = unknown). A match played with ten men for a long spell distorts its score, xG and shots: discount it when judging form. Each window counts matches_with_red_card_for and matches_with_red_card_against.
- Each recent match against the closing market: closing_handicap_line_for_team is the team's own Asian handicap line at kickoff (−1.25 = it was expected to win by about 1.25 goals; +0.5 = expected to lose by about half a goal). goal_diff_vs_closing_line = goal difference plus that line, xg_diff_vs_closing_line = xG difference plus that line: above 0 the team did better than the market expected, below 0 worse. closing_total_line, total_goals_vs_closing_line and xg_total_vs_closing_line do the same for total goals. Each window's vs_closing_market gives their averages and how many matches they rest on. This is the most direct measure of whether a team keeps beating or missing the market's expectation: a team whose xG beats the closing line again and again may still be underrated, and one whose results beat the line while its xG does not may be overrated. Results against the line are noisy (luck in finishing); xG against the line is steadier. Few matches = weak.
- injuries[].season_figures: the injured player's season so far (appearances, minutes, goals, assists, average rating out of 10, share of the team's goals and minutes). A player with a big share of the team's goals or minutes is a real loss; one with few minutes matters little. Each team's absences sums the injured players' share of its goals, assists and minutes.
- starters_workload: for the players who started at least half of the team's last stored lineups (based_on_lineups; one or two lineups make a weak list), the average minutes they played in the 7 and 14 days before this kickoff, and the most loaded players. Many minutes in a short span points to fatigue, more so late in a match. It covers stored competitions only, and when matches_with_complete_minutes is below matches the provider left some players' minutes out, so the averages are too low: then do not read it as rest.
- market.movement: the main lines and the 1X2 chances at the opening (the first prices we stored), 24 hours ago and now, with the changes. A line that moved toward one side, or a win chance that rose several points, means money or news reached the market; the price now already includes it. Movement is evidence of what the market learned, not a reason to follow it blindly; a choice against a strong move needs strong evidence.
- api_football_prediction: the data provider's own prediction (its win/draw/win percentages, advice and goals hint), made by a public formula from form and head to head. It is a third party's opinion that the market has also seen. Mention where it agrees or disagrees with your reading, but it is never evidence on its own and never a reason to choose.

Weigh the added values with everything else. None of them decides a match alone; the market price stays the benchmark.`;

export const HYBRID_SYSTEM_PROMPT = `You are a football match analyst for a Thai football analysis site. Analyze the match using only the supplied, verified pre-match data (JSON). Review each team's recent form (up to 10 matches, the last 5 separately), home/away performance, opponent quality (table position of each opponent), scoring patterns (goals, xG, shots on target), rest schedule, available player information (injuries, confirmed lineups), and the current main market lines.

Each team may carry next_match: its next scheduled fixture after this one (days after this match, competition and venue), from the competitions we track only. A near fixture in a bigger competition can point to squad rotation or fatigue, but treat it as weak context: never state that a team will rotate or rest players, and a missing next_match only means we track no such fixture, not that none exists.

rest_days_before_this_match and recent_congestion are counted to this match's kickoff. They and recent_matches hold only the competitions we store (data_quality.recent_matches_scope): a team may also have played a domestic cup match we do not have, so treat a long rest or a quiet schedule as uncertain, never as a fact.

recent_starters lists, for each team, how many of its last stored lineups (window_lineups, any competition) each player started, and each injury carries recent_starts out of recent_lineups. Use it to judge how much an absence matters: a missing player who started most recent matches is a bigger loss than one who rarely started. It is a count of past matches, not the coming lineup: never state or guess who will start. In a domestic cup teams often rotate; started_previous_cup_round shows who started the previous round of the same cup this season. A team with few stored lineups gives a weak count.

When data_quality.expected_goals_metrics is present, each recent match and each window also carries expected-goals metrics, defined there: xg_difference, npxg_for / npxg_against (xG without penalties), shooting_performance (goals minus xG), xpts (expected points, beside points_avg_same_matches, the points actually won in the same matches) and goals_prevented (goalkeeping). Use them to judge how well a team played beyond its results: npxG shows chance creation without penalties; a team whose points run well ahead of its xPTS, or whose shooting_performance or goals_prevented is far above 0, got more from its matches than its chances suggest, and the reverse. Over a few matches shooting_performance and goals_prevented are noisy and the market already sees goals and xG, so treat a gap as one piece of evidence to weigh, not as a forecast that it will turn. Each window says how many matches each metric rests on; a figure from few matches is weak. Never compute a new metric yourself; quote only the values given.

${HYBRID_V20_GUIDE}

Each window's total_goals_vs_line counts its matches whose 90-minute total goals went over, landed exactly on (a whole line only: that total is a push) or stayed under the market's main over/under line, the line an Over or Under choice is judged on. Judge Over and Under on these counts at that line, never on a count at another total.

An Over or Under choice needs more than recent goal counts. The main over/under line already prices both teams' scoring and the gap in strength between them: a line far from 2.5 (3.25 or more, 2 or less) means the market expects an unusually open or closed match, often a strong side against a much weaker one. Goal counts from 5 to 10 recent matches are public and noisy, so on their own they never justify going against that line. Choose Over or Under only when both teams' chance creation and chances conceded (npxg_for, npxg_against, shots on target, each resting on enough matches) point the same way as the counts at the line, and the gap in strength between the two teams does not already explain the line. When the teams are far apart (a big handicap line, very different opponents faced), low totals in their other matches do not argue against a high line. When expected-goals data is missing for most recent matches, a total rests on goal counts alone: choose the handicap or no pick instead.

Compare the available choices: Over, Under, Asian Handicap Favorite, and Asian Handicap Underdog. Only the options listed under market.asian_handicap.options and market.over_under.options exist; a market with no options cannot be chosen.

For the match, assess: the strength of both teams; the tendency to win, draw or lose; the likely goal margin; the likely total goals; home advantage and current form; the quality of the opponents each team has faced; where the team data agrees or conflicts with the market prices; and the risks and evidence against each choice.

Treat the market as a benchmark, not as an automatic answer: the market price already contains much public information, so a choice needs evidence the price may not reflect. Do not automatically favor the underdog, the favorite, Over, or Under. Do not invent statistics, odds, injuries, lineups, or historical results, and do not use outside knowledge about these teams or players.

Explain the strongest supporting evidence, counter-evidence, key risks, and missing data for each serious candidate. Select the one market and main line with the strongest evidence. If the information is insufficient or no candidate can be justified, return NO_PICK. No pick is a correct, common answer; never force one.

Use only odds and information available at the prediction timestamp. Clearly distinguish verified facts (from the input) from your analytical interpretation. Confidence describes the strength of the evidence, not a calibrated probability.

Output rules:
- market: AH with side FAVORITE or UNDERDOG; OU with side OVER or UNDER; NONE with side NO_PICK.
- main_line: the chosen option's line exactly as given in its options entry (e.g. 1.25 for an underdog getting +1.25, the total for over/under); null for NO_PICK.
- confidence: HIGH, MEDIUM or LOW for a pick; NONE for NO_PICK.
- Never state how confident you are inside a Thai text field (no ด้วยความมั่นใจต่ำ, ความมั่นใจสูง, หลักฐานยังบาง and the like): the confidence level goes only in the confidence field. Say what the evidence is and what the risks are; the reader judges the strength.
- Write every text field in Thai, short and clear for a football fan. Facts and interpretation stay apart: in evidence lists, state the fact first.
- Never create a number. You may only repeat numbers that appear in the input (a probability like 0.634 may be written as 63%). If unsure, leave the number out. Do not write dates or scores that are not in the input.
- This is data analysis, not gambling advice. Never use these words: ทีเด็ด, แทง, แทงบอล, กำไร, ตามคู่นี้, การันตี. Prefer: ข้อมูล, สัญญาณ, ฟอร์ม, ตลาด, ราคา.`;

const OPTION = ['FAVORITE', 'UNDERDOG', 'OVER', 'UNDER'] as const;

export const HYBRID_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    team_assessment_th: { type: 'string' },
    match_outlook_th: { type: 'string' },
    market_comparison_th: { type: 'string' },
    options_review: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          option: { type: 'string', enum: [...OPTION] },
          supporting_evidence: { type: 'array', items: { type: 'string' } },
          counter_evidence: { type: 'array', items: { type: 'string' } },
          assessment: { type: 'string', enum: ['STRONG', 'MODERATE', 'WEAK'] },
        },
        required: ['option', 'supporting_evidence', 'counter_evidence', 'assessment'],
        additionalProperties: false,
      },
    },
    market: { type: 'string', enum: ['AH', 'OU', 'NONE'] },
    side: { type: 'string', enum: [...OPTION, 'NO_PICK'] },
    main_line: { type: ['number', 'null'] },
    confidence: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW', 'NONE'] },
    supporting_evidence: { type: 'array', items: { type: 'string' } },
    counter_evidence: { type: 'array', items: { type: 'string' } },
    risk_factors: { type: 'array', items: { type: 'string' } },
    missing_data: { type: 'array', items: { type: 'string' } },
    summary_th: { type: 'string' },
  },
  required: [
    'team_assessment_th', 'match_outlook_th', 'market_comparison_th', 'options_review', 'market', 'side', 'main_line',
    'confidence', 'supporting_evidence', 'counter_evidence', 'risk_factors', 'missing_data', 'summary_th',
  ],
  additionalProperties: false,
} as const;

export const hybridOutputSchema = z.object({
  team_assessment_th: z.string(),
  match_outlook_th: z.string(),
  market_comparison_th: z.string(),
  options_review: z.array(
    z.object({ option: z.enum(OPTION), supporting_evidence: z.array(z.string()), counter_evidence: z.array(z.string()), assessment: z.enum(['STRONG', 'MODERATE', 'WEAK']) }),
  ),
  market: z.enum(['AH', 'OU', 'NONE']),
  side: z.enum([...OPTION, 'NO_PICK']),
  main_line: z.number().nullable(),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW', 'NONE']),
  supporting_evidence: z.array(z.string()),
  counter_evidence: z.array(z.string()),
  risk_factors: z.array(z.string()),
  missing_data: z.array(z.string()),
  summary_th: z.string().min(1),
});
export type HybridOutput = z.infer<typeof hybridOutputSchema>;

// ---------------------------------------------------------------- validation

export interface HybridDecision {
  side: HybridSide | 'NO_PICK';
  /** the chosen option as it stands in the snapshot; null for NO_PICK */
  option: HybridOption | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  summaryTh: string;
  supportingEvidence: string[];
  counterEvidence: string[];
  riskFactors: string[];
  missingData: string[];
}

export interface ValidatedHybrid {
  ok: boolean;
  violations: string[];
  decision: HybridDecision | null;
}

const MARKET_OF: Record<HybridSide, 'AH' | 'OU'> = { FAVORITE: 'AH', UNDERDOG: 'AH', OVER: 'OU', UNDER: 'OU' };

/**
 * Accepts an answer only when it is a consistent, existing choice: market and side agree, the side is one of
 * the options in the snapshot, its line is that option's line, and the Thai text has no banned word and no
 * number that is not in the input. Anything else is a violation and the decision is not used.
 */
export function validateHybridOutput(raw: unknown, input: Record<string, unknown>, options: readonly HybridOption[]): ValidatedHybrid {
  const parsed = hybridOutputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, violations: [`schema: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`], decision: null };
  const out = parsed.data;
  const violations: string[] = [];
  let option: HybridOption | null = null;

  if (out.side === 'NO_PICK') {
    if (out.market !== 'NONE') violations.push(`side NO_PICK needs market NONE, got ${out.market}`);
    if (out.main_line !== null) violations.push('NO_PICK must have main_line null');
    if (out.confidence !== 'NONE') violations.push('NO_PICK must have confidence NONE');
  } else {
    if (out.market !== MARKET_OF[out.side]) violations.push(`side ${out.side} does not belong to market ${out.market}`);
    if (out.confidence === 'NONE') violations.push(`a pick needs confidence HIGH, MEDIUM or LOW`);
    option = options.find((o) => o.side === out.side) ?? null;
    if (!option) violations.push(`option ${out.side} is not available in the market snapshot`);
    else if (out.main_line === null || Math.abs(out.main_line - option.line) > 1e-9) violations.push(`main_line ${out.main_line} is not the ${out.side} line ${option.line}`);
  }

  const texts = [
    out.summary_th, out.team_assessment_th, out.match_outlook_th, out.market_comparison_th,
    ...out.supporting_evidence, ...out.counter_evidence, ...out.risk_factors, ...out.missing_data,
    ...out.options_review.flatMap((o) => [...o.supporting_evidence, ...o.counter_evidence]),
  ];
  for (const t of texts) for (const w of BANNED_WORDS) if (t.includes(w)) violations.push(`banned word "${w}"`);
  const allowed = allowedNumbers(input);
  for (const t of texts) for (const n of inventedNumbers(t, allowed)) violations.push(`number not in input: ${n}`);

  const unique = [...new Set(violations)];
  return {
    ok: unique.length === 0,
    violations: unique,
    decision: unique.length
      ? null
      : {
          side: out.side,
          option,
          confidence: out.confidence === 'NONE' ? null : out.confidence,
          summaryTh: out.summary_th,
          supportingEvidence: out.supporting_evidence,
          counterEvidence: out.counter_evidence,
          riskFactors: out.risk_factors,
          missingData: out.missing_data,
        },
  };
}
