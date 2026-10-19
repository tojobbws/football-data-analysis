import { BIG_MATCH_MIN_SCORE, rankBigMatches, thaiMatches, type PopularityRegistry, type RankableMatch } from '@fp/shared/popularity';
import type { MatchRow } from './queries';

interface Item extends RankableMatch {
  row: MatchRow;
}

const items = (matches: MatchRow[]): Item[] =>
  matches.map((row) => ({ id: row.id, season: row.season, leagueId: row.league.id, homeId: row.home.id, awayId: row.away.id, row }));

export interface BigMatch {
  match: MatchRow;
  derby: string | null;
}

/** The day's big matches (most popular first). Order only: nothing here reads or changes a probability or a pick. */
export function bigMatchesOf(matches: MatchRow[], reg: PopularityRegistry, limit = 6): BigMatch[] {
  return rankBigMatches(items(matches), reg, { min: BIG_MATCH_MIN_SCORE, limit }).map((r) => ({ match: r.match.row, derby: r.derby }));
}

/** The day's matches in leagues the registry flags as Thai, in kickoff order as given. */
export function thaiMatchesOf(matches: MatchRow[], reg: PopularityRegistry): MatchRow[] {
  return thaiMatches(items(matches), reg).map((i) => i.row);
}
