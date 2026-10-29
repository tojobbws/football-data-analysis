/**
 * League table as it stood before a date, rebuilt from finished match results.
 *
 * The `standings` table only holds the current table, so the opponent's position at the date of a past match
 * (what the Hybrid AI is told next to every recent match) has to be recomputed from results. This is an
 * approximation of the official table: points (3/1/0), then goal difference, then goals scored, then team id for a
 * stable order. Competition-specific tie-breakers (head to head, fair play, deductions) are not applied, and the
 * caller must only use it for a single-table league.
 */

export interface TableMatch {
  kickoffAt: Date;
  homeTeamId: number;
  awayTeamId: number;
  goalsHome: number;
  goalsAway: number;
}

export interface ResultsTableRow {
  teamId: number;
  rank: number;
  played: number;
  points: number;
  goalDiff: number;
  goalsFor: number;
}

/** The table from the matches that kicked off strictly before `asOf`; teams with no match yet are not in it. */
export function tableAsOf(matches: readonly TableMatch[], asOf: Date): ResultsTableRow[] {
  const rows = new Map<number, Omit<ResultsTableRow, 'rank'>>();
  const row = (teamId: number) => {
    let r = rows.get(teamId);
    if (!r) rows.set(teamId, (r = { teamId, played: 0, points: 0, goalDiff: 0, goalsFor: 0 }));
    return r;
  };
  for (const m of matches) {
    if (m.kickoffAt.getTime() >= asOf.getTime()) continue;
    const h = row(m.homeTeamId);
    const a = row(m.awayTeamId);
    h.played++;
    a.played++;
    h.goalsFor += m.goalsHome;
    a.goalsFor += m.goalsAway;
    h.goalDiff += m.goalsHome - m.goalsAway;
    a.goalDiff += m.goalsAway - m.goalsHome;
    if (m.goalsHome > m.goalsAway) h.points += 3;
    else if (m.goalsHome < m.goalsAway) a.points += 3;
    else {
      h.points += 1;
      a.points += 1;
    }
  }
  return [...rows.values()]
    .sort((x, y) => y.points - x.points || y.goalDiff - x.goalDiff || y.goalsFor - x.goalsFor || x.teamId - y.teamId)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

/** A team's position and the table size before `asOf`; null when the team has not played yet. */
export function rankAsOf(matches: readonly TableMatch[], asOf: Date, teamId: number): { rank: number; tableSize: number; played: number } | null {
  const table = tableAsOf(matches, asOf);
  const r = table.find((x) => x.teamId === teamId);
  return r ? { rank: r.rank, tableSize: table.length, played: r.played } : null;
}
