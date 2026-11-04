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
import type { HybridMarket, HybridOption, HybridSide } from '@fp/analysis';
import { BANNED_WORDS, allowedNumbers, inventedNumbers } from './guards.js';

export const HYBRID_ENGINE_VERSION = 'hybrid-ai-v1';
// v1.1 (2026-10-27): the 14-day window is a value in the input (the AI quoted it and the number guard refused it)
// v1.2 (2026-10-30): each team carries next_match, its next scheduled fixture in a tracked competition (rotation context)
// v1.3 (2026-10-30): input v2 on: each opponent's table position as of its match date (null for a cup or split league),
//   and whether the league reports injuries at all (docs/research/hybrid-input-audit-2026-10-29.md, gaps G1 and G2)
// v1.4 (2026-10-30): the Thai text no longer states the confidence level (it is the `confidence` field, shown in admin only)
// v1.5 (2026-11-04): expected-goals metrics per match and per window: xG difference, npxG, shooting performance,
//   xPTS and goals prevented (input flag `xgMetrics`; computed here, see expectedMetrics())
export const HYBRID_PROMPT_VERSION = 'hybrid-ai-v1.5';
/**
 * The provider's xG of one penalty: API-Football's xG counts penalties at exactly this value (a team whose only shot
 * was a penalty has xG 0.79; checked on the stored matches 2026-11-04). npxG takes it off once per penalty taken.
 */
export const PENALTY_XG = 0.79;
/** The pick decision matters more than prose: Sonnet by default, HYBRID_AI_MODEL overrides it. */
export const HYBRID_AI_MODEL = 'claude-sonnet-5-5';
/** Answers that fail validation are asked again this many times in total before the decision fails safely. */
export const HYBRID_MAX_ATTEMPTS = 2;

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
  injuries: Array<{ team: 'HOME' | 'AWAY' | null; player: string | null; type: string | null; reason: string | null }>;
  lineup: { home: string[]; away: string[] } | null;
  market: HybridMarket;
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
  /** legacy Dixon-Coles probability of each option's selection and line, and its 1X2; context only */
  legacy: { options: Partial<Record<HybridSide, number>>; x12: { home: number; draw: number; away: number } | null } | null;
}

const r = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
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

/** Averages over the matches that have the value, with how many had it. */
function summary(ms: readonly TeamMatch[], xgMetrics = false) {
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
    total_goals_over: { line: 2.5, matches: ms.filter((m) => m.goalsFor + m.goalsAgainst > 2.5).length },
    xg_for_avg: avg(xgF),
    xg_against_avg: avg(xgA),
    xg_matches: xgF.length,
    shots_on_target_for_avg: avg(sotF),
    shots_on_target_against_avg: avg(sotA),
    shots_matches: sotF.length,
    ...(xgMetrics ? metricsSummary(ms) : {}),
  };
}

function team(name: string, ms: readonly TeamMatch[], venue: 'HOME' | 'AWAY', standing: TeamStanding | null, at: Date, next?: { match: NextMatch | null; from: Date }, xgMetrics = false) {
  const last = ms[0];
  const days = (iso: string) => (at.getTime() - Date.parse(iso)) / 86_400_000;
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
    })),
    last_10: summary(ms.slice(0, 10), xgMetrics),
    last_5: summary(ms.slice(0, 5), xgMetrics),
    [venue === 'HOME' ? 'home_matches_in_last_10' : 'away_matches_in_last_10']: summary(ms.slice(0, 10).filter((m) => m.venue === venue), xgMetrics),
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
  };
}

const optionView = (o: HybridOption, home: string, away: string) => ({
  option: o.side,
  team_or_total: o.market === 'OVER_UNDER' ? o.selection : o.selection === 'HOME' ? home : away,
  line: o.line,
  odds_median: o.odds,
  market_probability_no_vig: o.marketProbability,
});

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
  if (!src.standings.home || !src.standings.away) missing.push('league table not available for both teams');
  if (src.injuriesCoverage === 'unavailable_for_league') missing.push('this league provides no injury data: an empty injuries list does not mean nobody is out');
  if (m.ah.status !== 'OK') missing.push(`no usable main Asian handicap line (${m.ah.status})`);
  if (m.ou.status !== 'OK') missing.push(`no usable main over/under line (${m.ou.status})`);

  return {
    match: { home: fx.home, away: fx.away, competition: fx.league, kickoff_utc: fx.kickoffAt.toISOString(), publish_round: src.publishRound },
    prediction_timestamp_utc: src.predictionAt.toISOString(),
    home_team: team(fx.home, recentHome, 'HOME', src.standings.home, src.predictionAt, src.nextMatch && { match: src.nextMatch.home, from: fx.kickoffAt }, src.xgMetrics),
    away_team: team(fx.away, recentAway, 'AWAY', src.standings.away, src.predictionAt, src.nextMatch && { match: src.nextMatch.away, from: fx.kickoffAt }, src.xgMetrics),
    injuries: src.injuries,
    confirmed_lineup: src.lineup,
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
    },
    legacy_statistical_model: src.legacy
      ? {
          note: 'Dixon-Coles goal model. Measured on past seasons it rates underdogs and unders higher than both the market and the results; one weak voice, not a verdict.',
          option_probabilities: src.legacy.options,
          match_odds_1x2: src.legacy.x12,
        }
      : null,
    data_quality: {
      home_recent_matches: recentHome.length,
      away_recent_matches: recentAway.length,
      lineups_confirmed: Boolean(src.lineup),
      injuries_reported: src.injuries.length,
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

export const HYBRID_SYSTEM_PROMPT = `You are a football match analyst for a Thai football analysis site. Analyze the match using only the supplied, verified pre-match data (JSON). Review each team's recent form (up to 10 matches, the last 5 separately), home/away performance, opponent quality (table position of each opponent), scoring patterns (goals, xG, shots on target), rest schedule, available player information (injuries, confirmed lineups), and the current main market lines.

Each team may carry next_match: its next scheduled fixture after this one (days after this match, competition and venue), from the competitions we track only. A near fixture in a bigger competition can point to squad rotation or fatigue, but treat it as weak context: never state that a team will rotate or rest players, and a missing next_match only means we track no such fixture, not that none exists.

When data_quality.expected_goals_metrics is present, each recent match and each window also carries expected-goals metrics, defined there: xg_difference, npxg_for / npxg_against (xG without penalties), shooting_performance (goals minus xG), xpts (expected points, beside points_avg_same_matches, the points actually won in the same matches) and goals_prevented (goalkeeping). Use them to judge how well a team played beyond its results: npxG shows chance creation without penalties; a team whose points run well ahead of its xPTS, or whose shooting_performance or goals_prevented is far above 0, got more from its matches than its chances suggest, and the reverse. Over a few matches shooting_performance and goals_prevented are noisy and the market already sees goals and xG, so treat a gap as one piece of evidence to weigh, not as a forecast that it will turn. Each window says how many matches each metric rests on; a figure from few matches is weak. Never compute a new metric yourself; quote only the values given.

Compare the available choices: Over, Under, Asian Handicap Favorite, and Asian Handicap Underdog. Only the options listed under market.asian_handicap.options and market.over_under.options exist; a market with no options cannot be chosen.

For the match, assess: the strength of both teams; the tendency to win, draw or lose; the likely goal margin; the likely total goals; home advantage and current form; the quality of the opponents each team has faced; where the team data agrees or conflicts with the market prices; and the risks and evidence against each choice.

Treat the market as a benchmark, not as an automatic answer: the market price already contains much public information, so a choice needs evidence the price may not reflect. Do not automatically favor the underdog, the favorite, Over, or Under. legacy_statistical_model is one weak voice with a known lean; do not follow it by default. Do not invent statistics, odds, injuries, lineups, or historical results, and do not use outside knowledge about these teams or players.

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
