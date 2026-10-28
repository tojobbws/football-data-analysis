/**
 * Popularity score of a match: how much readers are likely to care. It ORDERS what the site shows
 * (big matches, the Thai section) and nothing else: it never enters a probability, an edge, a pick or
 * the daily featured list (pinned by packages/shared/test/popularity.test.ts).
 *
 * Inputs come from the admin-editable registry (team_popularity, league_importance, rivalries),
 * keyed by API-Football ids, 0-100 each:
 *   teams = 0.65 * the bigger team + 0.35 * the smaller one   (one superclub is enough to lift a match)
 *   score = 0.7 * teams + 0.3 * league importance + derby bonus, clamped to 0-100
 */
export const DEFAULT_LEAGUE_IMPORTANCE = 30;
/** A match must reach this to be listed as a big match. */
export const BIG_MATCH_MIN_SCORE = 55;

export interface PopularityInput {
  homePopularity: number;
  awayPopularity: number;
  leagueImportance: number;
  /** 0-15, from the rivalries table; 0 when the pair is not a rivalry */
  derbyBonus: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function popularityScore(i: PopularityInput): number {
  const big = Math.max(i.homePopularity, i.awayPopularity);
  const small = Math.min(i.homePopularity, i.awayPopularity);
  const teams = 0.65 * big + 0.35 * small;
  return Math.round(clamp(0.7 * teams + 0.3 * i.leagueImportance + clamp(i.derbyBonus, 0, 15), 0, 100));
}

export interface TeamPopularityRow {
  team_id: number;
  /** 0 = every season; a real season overrides it for that season */
  season: number;
  popularity: number;
}
export interface LeagueImportanceRow {
  league_id: number;
  season: number;
  importance: number;
  is_thai: boolean;
}
export interface RivalryRow {
  team_a_id: number;
  team_b_id: number;
  name: string;
  weight: number;
}

export interface PopularityRegistry {
  teams: Map<string, number>;
  leagues: Map<string, { importance: number; isThai: boolean }>;
  rivalries: Map<string, { name: string; weight: number }>;
}

const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

export function buildRegistry(teams: readonly TeamPopularityRow[], leagues: readonly LeagueImportanceRow[], rivalries: readonly RivalryRow[]): PopularityRegistry {
  return {
    teams: new Map(teams.map((t) => [`${t.team_id}:${t.season}`, Number(t.popularity)])),
    leagues: new Map(leagues.map((l) => [`${l.league_id}:${l.season}`, { importance: Number(l.importance), isThai: l.is_thai }])),
    rivalries: new Map(rivalries.map((r) => [pairKey(r.team_a_id, r.team_b_id), { name: r.name, weight: Number(r.weight) }])),
  };
}

/** Season-specific row first, else the every-season row (season 0), else the fallback. */
function pick<T>(map: Map<string, T>, id: number, season: number | null | undefined): T | undefined {
  return (season != null ? map.get(`${id}:${season}`) : undefined) ?? map.get(`${id}:0`);
}

/** A league's importance (season row, else every-season row, else DEFAULT_LEAGUE_IMPORTANCE). Orders lists only. */
export function leagueImportance(reg: PopularityRegistry, leagueId: number, season?: number | null): number {
  return pick(reg.leagues, leagueId, season)?.importance ?? DEFAULT_LEAGUE_IMPORTANCE;
}

export interface RankableMatch {
  id: number;
  season?: number | null;
  leagueId: number;
  homeId: number;
  awayId: number;
}

export interface Ranked<T> {
  match: T;
  score: number;
  isThai: boolean;
  /** rivalry name when the pair is in the rivalries table */
  derby: string | null;
}

export function scoreMatch(m: RankableMatch, reg: PopularityRegistry): { score: number; isThai: boolean; derby: string | null } {
  const league = pick(reg.leagues, m.leagueId, m.season);
  const rivalry = reg.rivalries.get(pairKey(m.homeId, m.awayId));
  const score = popularityScore({
    homePopularity: pick(reg.teams, m.homeId, m.season) ?? 0,
    awayPopularity: pick(reg.teams, m.awayId, m.season) ?? 0,
    leagueImportance: league?.importance ?? DEFAULT_LEAGUE_IMPORTANCE,
    derbyBonus: rivalry?.weight ?? 0,
  });
  return { score, isThai: league?.isThai ?? false, derby: rivalry?.name ?? null };
}

/** Matches at or above `min`, most popular first (ties: earlier in the input list), at most `limit`. */
export function rankBigMatches<T extends RankableMatch>(matches: readonly T[], reg: PopularityRegistry, opts: { min?: number; limit?: number } = {}): Ranked<T>[] {
  const min = opts.min ?? BIG_MATCH_MIN_SCORE;
  return matches
    .map((match, i) => ({ match, i, ...scoreMatch(match, reg) }))
    .filter((r) => r.score >= min)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, opts.limit ?? 6)
    .map(({ match, score, isThai, derby }) => ({ match, score, isThai, derby }));
}

/** Matches in leagues flagged Thai in the registry, in the order given. */
export function thaiMatches<T extends RankableMatch>(matches: readonly T[], reg: PopularityRegistry): T[] {
  return matches.filter((m) => pick(reg.leagues, m.leagueId, m.season)?.isThai === true);
}
