/**
 * Hybrid AI input v2, step 1 (docs/research/hybrid-input-audit-2026-10-29.md, gaps G1 and G2). Nothing here runs in
 * production until the hybrid job is told to use it; the default input is unchanged.
 *
 *  G1  `injuriesCoverage`: does the API report injuries for this league at all (any row first seen in the last 30
 *      days). 12 of the 26 leagues checked give no injury data, so an empty list there is not "nobody is out".
 *  G2  `withOpponentRanksAsOf`: the opponent's position next to each recent match is rebuilt from that season's
 *      results before the match date. The stored `standings` row is today's table, which is wrong for a match played
 *      months ago and leaks later results into a backtest. Only for a single-table league (type League, one distinct
 *      standings table); everything else gets null, never today's rank.
 */
import { rankAsOf, type TableMatch } from '@fp/analysis';
import type { JobContext } from '@fp/database';

export type RecentMatch = Awaited<ReturnType<JobContext['repo']['teamRecentMatches']>>[number];

export async function injuriesCoverage(ctx: Pick<JobContext, 'repo'>, leagueId: number, asOf: Date): Promise<'available' | 'unavailable_for_league'> {
  return (await ctx.repo.injuryRowsRecently(leagueId, asOf)) > 0 ? 'available' : 'unavailable_for_league';
}

/** Recent matches with each opponent's position as of the match date (null when it cannot be rebuilt reliably). */
export async function withOpponentRanksAsOf(ctx: Pick<JobContext, 'repo'>, matches: readonly RecentMatch[]): Promise<RecentMatch[]> {
  const results = new Map<string, Promise<TableMatch[] | null>>();
  const tableFor = (m: RecentMatch, before: Date) => {
    const key = `${m.leagueId}:${m.season}`;
    let p = results.get(key);
    if (!p) {
      p =
        m.leagueType === 'League'
          ? ctx.repo.standingsDistinctTables(m.leagueId, m.season).then((tables) => (tables > 1 ? null : ctx.repo.seasonResults(m.leagueId, m.season, before)))
          : Promise.resolve(null);
      results.set(key, p);
    }
    return p;
  };
  // one season fetch per league season, up to the newest match of the list (every earlier match is a subset of it)
  const newest = new Date(Math.max(0, ...matches.map((m) => Date.parse(m.kickoffAt))));
  return Promise.all(
    matches.map(async (m) => {
      const table = await tableFor(m, newest);
      const rank = table ? rankAsOf(table, new Date(m.kickoffAt), m.opponentId) : null;
      return { ...m, opponentRank: rank ? rank.rank : null, opponentTableSize: rank ? rank.tableSize : null };
    }),
  );
}
