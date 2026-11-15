/**
 * Hybrid AI input v2.0 (docs/adr/0020-hybrid-input-v20.md): the owner's list of added context, every value read or
 * computed here from stored data, as of the decision time `now`. No API call.
 *
 *  - Elo ratings of both teams and of every recent opponent (eloBook over every stored result, one per run)
 *  - market movement: the main lines at the opening (first quotes we stored), 24 hours ago and now
 *  - stage, neutral venue (competition_rules), derby (rivalries), two-legged tie and aggregate, head to head
 *  - table zone and stakes, season home/away record
 *  - injured players' season figures and each team's share of goals and minutes missing
 *  - starters' workload: minutes in the 7 and 14 days before kickoff
 *  - API-Football's own prediction
 * The per-match figures (possession, corners, cards, red-card minutes, closing lines) come with teamRecentMatches.
 */
import {
  buildTies,
  eloBook,
  eloView,
  hybridMarket,
  marketMoment,
  marketMovement,
  parseRound,
  ruleFor,
  tableStakes,
  tieSituation,
  type CompetitionRule,
  type EloBook,
  type HybridMarket,
  type RegularStarters,
  type Stage,
  type TieFixture,
} from '@fp/analysis';
import type { HybridContextV20 } from '@fp/ai';
import type { JobContext } from '@fp/database';
import type { RecentMatch } from './hybrid-input-v2.js';

type Ctx = Pick<JobContext, 'repo'>;
type Header = NonNullable<Awaited<ReturnType<JobContext['repo']['fixtureHeader']>>>;
type Standing = NonNullable<ReturnType<Awaited<ReturnType<JobContext['repo']['standingsForTeams']>>['get']>>;

const DAY = 86_400_000;
const r = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

// one Elo book per decision time: a run decides every match at the same `now`
let eloCache: { key: string; book: Promise<EloBook> } | null = null;
export function eloFor(ctx: Ctx, now: Date): Promise<EloBook> {
  const key = now.toISOString();
  if (eloCache?.key !== key) eloCache = { key, book: ctx.repo.allResultsForElo(now).then(eloBook) };
  return eloCache.book;
}

/** Each recent match with both Elo ratings just before it. */
export function withElo(matches: readonly RecentMatch[], book: EloBook): RecentMatch[] {
  return matches.map((m) => {
    const b = book.before.get(m.fixtureId);
    return b ? { ...m, teamEloBefore: m.venue === 'HOME' ? b.home : b.away, opponentEloBefore: m.venue === 'HOME' ? b.away : b.home } : m;
  });
}

const record = (v: Standing['home']) => (v ? { played: v.played, wins: v.win, draws: v.draw, losses: v.lose, goals_for: v.goalsFor, goals_against: v.goalsAgainst } : null);

/** The injured players' season figures and the share of the team's goals, assists and minutes they hold. */
function absences(figures: Awaited<ReturnType<JobContext['repo']['playerSeasonFigures']>>, injuredIds: number[], season: number) {
  const total = (k: 'goals' | 'assists' | 'minutes') => figures.reduce((s, p) => s + p[k], 0);
  const team = { goals: total('goals'), assists: total('assists'), minutes: total('minutes') };
  const share = (n: number, of: number) => (of > 0 ? r(n / of, 3) : null);
  const byId = new Map<number, Record<string, unknown>>();
  const out = injuredIds.map((id) => figures.find((p) => p.playerId === id)).filter((p): p is NonNullable<typeof p> => p !== undefined);
  for (const p of out)
    byId.set(p.playerId, {
      season,
      appearances: p.appearances,
      minutes: p.minutes,
      goals: p.goals,
      assists: p.assists,
      average_rating: p.rating === null ? null : r(p.rating, 2),
      share_of_team_goals: share(p.goals, team.goals),
      share_of_team_minutes: share(p.minutes, team.minutes),
    });
  const sum = (k: 'goals' | 'assists' | 'minutes') => out.reduce((s, p) => s + p[k], 0);
  return {
    byId,
    view: {
      season,
      injured_players_with_figures: out.length,
      team_goals: team.goals,
      missing_goals: sum('goals'),
      missing_goals_share: share(sum('goals'), team.goals),
      missing_assists: sum('assists'),
      missing_assists_share: share(sum('assists'), team.assists),
      missing_minutes_share: share(sum('minutes'), team.minutes),
    },
  };
}

/** Minutes of the regular starters (started at least half of the stored lineups) in the 7 and 14 days before kickoff. */
async function workload(ctx: Ctx, teamId: number, rs: RegularStarters, kickoffAt: Date, now: Date) {
  const regular = rs.players.filter((p) => rs.of > 0 && p.starts * 2 >= rs.of);
  if (!regular.length) return null;
  const ids = regular.map((p) => p.playerId);
  const from7 = new Date(kickoffAt.getTime() - 7 * DAY);
  const from14 = new Date(kickoffAt.getTime() - 14 * DAY);
  const [m7, m14, played] = await Promise.all([
    ctx.repo.playerMinutesBetween(teamId, ids, from7, now),
    ctx.repo.playerMinutesBetween(teamId, ids, from14, now),
    ctx.repo.teamMatchesWithMinutes(teamId, from14, now),
  ]);
  const avg = (m: Map<number, number>) => r(ids.reduce((s, id) => s + (m.get(id) ?? 0), 0) / ids.length, 0);
  // a match whose player minutes the provider left incomplete (fewer than 11 players) makes the averages too low
  const complete = (from: Date) => {
    const ms = played.filter((m) => m.kickoffAt >= from);
    return { matches: ms.length, matches_with_complete_minutes: ms.filter((m) => m.playersWithMinutes >= 11).length };
  };
  return {
    // the windows are values, not only part of a key: the AI may then quote them (number guard)
    windows_days: [7, 14],
    based_on_lineups: rs.of,
    regular_starters: ids.length,
    last_7_days: complete(from7),
    last_14_days: complete(from14),
    avg_minutes_last_7_days: avg(m7),
    avg_minutes_last_14_days: avg(m14),
    most_loaded: regular
      .map((p) => ({ player: p.name, minutes_last_14_days: m14.get(p.playerId) ?? 0 }))
      .sort((a, b) => b.minutes_last_14_days - a.minutes_last_14_days)
      .slice(0, 3),
  };
}

async function movement(ctx: Ctx, fixtureId: number, kickoffAt: Date, now: Date, current: HybridMarket) {
  const first = await ctx.repo.firstQuoteAt(fixtureId);
  if (!first) return null;
  // the first stored batch: quotes of one sync run arrive within minutes
  const openAt = new Date(first.getTime() + 30 * 60_000);
  if (openAt >= now) return null;
  const at = async (t: Date) => marketMoment(hybridMarket(await ctx.repo.latestQuotes(fixtureId, t), t), kickoffAt);
  const dayAgoAt = new Date(now.getTime() - DAY);
  const [opening, dayAgo] = await Promise.all([at(openAt), dayAgoAt > openAt ? at(dayAgoAt) : Promise.resolve(null)]);
  return marketMovement(opening, dayAgo, marketMoment(current, kickoffAt));
}

async function twoLegged(ctx: Ctx, h: Header, rules: CompetitionRule[], stage: Stage) {
  const rule = ruleFor(rules, h.leagueId, h.season, stage);
  if (!rule || rule.legs < 2) return null;
  const rows = await ctx.repo.cupFixtureRows([h.leagueId], new Date(h.kickoffAt.getTime() - 90 * DAY), new Date(h.kickoffAt.getTime() + 90 * DAY));
  const finished = (s: string) => ['FT', 'AET', 'PEN'].includes(s);
  const pair = (a: number | null, b: number | null): [number, number] | null => (a == null || b == null ? null : [Number(a), Number(b)]);
  const fixtures: TieFixture[] = rows.map((x) => ({
    id: Number(x.id),
    leagueId: Number(x.league_id),
    season: Number(x.season),
    round: x.round,
    kickoffAt: new Date(x.kickoff_at),
    homeId: Number(x.home_team_id),
    awayId: Number(x.away_team_id),
    status: x.status_short,
    ft: finished(x.status_short) ? pair(x.ft_home, x.ft_away) : null,
    et: finished(x.status_short) ? pair(x.et_home, x.et_away) : null,
    pen: finished(x.status_short) ? pair(x.pen_home, x.pen_away) : null,
  }));
  const tie = buildTies(fixtures, rules).find((t) => t.legs.some((l) => l.id === h.id));
  return tie ? tieSituation(tie, h.id, h.homeTeamId, { home: h.home, away: h.away }) : null;
}

export interface V20Inputs {
  header: Header;
  now: Date;
  market: HybridMarket;
  standings: Map<number, Standing>;
  injuries: ReadonlyArray<Record<string, unknown>>;
  regularStarters: { home: RegularStarters; away: RegularStarters };
}

export async function collectV20(ctx: Ctx, x: V20Inputs): Promise<HybridContextV20> {
  const { header: h, now } = x;
  const book = await eloFor(ctx, now);
  const rules: CompetitionRule[] = (await ctx.repo.competitionRuleRows()).map((row) => ({
    leagueId: Number(row.league_id),
    fromSeason: Number(row.from_season),
    stage: row.stage as Stage,
    legs: Number(row.legs),
    awayGoals: row.away_goals,
    extraTime: row.extra_time,
    penalties: row.penalties,
    neutralVenue: row.neutral_venue,
  }));
  const { stage } = parseRound(h.round);
  const rule = ruleFor(rules, h.leagueId, h.season, stage);
  const neutral = rule ? rule.neutralVenue : h.leagueType === 'League' ? false : null;

  const injured = (team: number) => x.injuries.filter((i) => Number(i.team_id) === team && i.player_id != null).map((i) => Number(i.player_id));
  const [h2h, derby, apiPred, tie, move, table, left, figHome, figAway, loadHome, loadAway] = await Promise.all([
    ctx.repo.headToHead(h.homeTeamId, h.awayTeamId, now, 5),
    ctx.repo.rivalry(h.homeTeamId, h.awayTeamId),
    ctx.repo.latestApiPrediction(h.id),
    twoLegged(ctx, h, rules, stage),
    movement(ctx, h.id, h.kickoffAt, now, x.market),
    ctx.repo.leagueTable(h.leagueId, h.season),
    ctx.repo.leagueMatchesLeft(h.leagueId, h.season, [h.homeTeamId, h.awayTeamId], h.kickoffAt),
    ctx.repo.playerSeasonFigures(h.homeTeamId, h.season, now),
    ctx.repo.playerSeasonFigures(h.awayTeamId, h.season, now),
    workload(ctx, h.homeTeamId, x.regularStarters.home, h.kickoffAt, now),
    workload(ctx, h.awayTeamId, x.regularStarters.away, h.kickoffAt, now),
  ]);

  const absHome = absences(figHome, injured(h.homeTeamId), h.season);
  const absAway = absences(figAway, injured(h.awayTeamId), h.season);
  const injuredPlayerFigures = new Map([...absHome.byId, ...absAway.byId]);

  const h2hRows = h2h.map((m) => ({ date_utc: m.kickoffAt.slice(0, 10), home: m.home, away: m.away, score: `${m.homeGoals}-${m.awayGoals}` }));
  const forHome = h2h.map((m) => (m.home === h.home ? m.homeGoals - m.awayGoals : m.awayGoals - m.homeGoals));

  const teamExtra = (teamId: number, abs: ReturnType<typeof absences>, load: Awaited<ReturnType<typeof workload>>) => {
    const s = x.standings.get(teamId);
    const stakes = tableStakes(table, teamId, left.get(teamId) ?? null);
    return {
      table_context: s || stakes ? { zone: s?.zone ?? null, stakes, season_home_record: record(s?.home ?? null), season_away_record: record(s?.away ?? null) } : null,
      absences: abs.view,
      starters_workload: load,
    };
  };

  // the provider's percentages are strings like "45.00"; collected before the decision only
  const api =
    apiPred && new Date(apiPred.collected_at as string) <= now
      ? {
          collected_at_utc: new Date(apiPred.collected_at as string).toISOString(),
          percent_home: apiPred.percent_home == null ? null : Number(apiPred.percent_home),
          percent_draw: apiPred.percent_draw == null ? null : Number(apiPred.percent_draw),
          percent_away: apiPred.percent_away == null ? null : Number(apiPred.percent_away),
          predicted_winner: apiPred.winner_team_id == null ? null : Number(apiPred.winner_team_id) === h.homeTeamId ? h.home : Number(apiPred.winner_team_id) === h.awayTeamId ? h.away : null,
          advice: apiPred.advice == null ? null : String(apiPred.advice),
          goals_hint_under_over: apiPred.under_over == null ? null : String(apiPred.under_over),
        }
      : null;

  return {
    matchContext: {
      round: h.round,
      stage,
      neutral_venue: neutral,
      derby: derby ? derby.name : null,
      two_legged_tie: tie,
      head_to_head: {
        matches: h2hRows.length,
        home_team_wins: forHome.filter((d) => d > 0).length,
        draws: forHome.filter((d) => d === 0).length,
        home_team_losses: forHome.filter((d) => d < 0).length,
        meetings: h2hRows,
      },
    },
    elo: eloView(book, h.homeTeamId, h.awayTeamId, neutral === true),
    marketMovement: move,
    apiFootballPrediction: api,
    home: teamExtra(h.homeTeamId, absHome, loadHome),
    away: teamExtra(h.awayTeamId, absAway, loadAway),
    injuredPlayerFigures,
  };
}
