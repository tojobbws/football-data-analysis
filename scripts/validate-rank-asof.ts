/**
 * How close is the table rebuilt from results (tableAsOf) to the API's own current table? Read-only.
 *   npx tsx scripts/validate-rank-asof.ts
 */
import { tableAsOf } from '@fp/analysis';
import { createPgDb, Repository } from '@fp/database';
import { loadDotEnvFile, loadEnv } from '@fp/shared';

loadDotEnvFile();
const env = loadEnv();
const db = createPgDb(env.DATABASE_URL!, { max: 2 });
const repo = new Repository(db);
const seasons = (await db.query<{ league_id: number; season: number; name: string; type: string | null; groups: string }>(
  `select s.league_id, s.season, l.name, l.type, (select count(distinct teams) from (select array_agg(team_id order by team_id) teams from standings x where x.league_id = s.league_id and x.season = s.season group by x.group_name) g) groups from standings s join leagues l on l.id = s.league_id group by 1,2,3,4 order by l.name`,
)).rows;
const rows: Array<Record<string, unknown>> = [];
for (const s of seasons) {
  if (s.type !== 'League' || Number(s.groups) > 1) {
    rows.push({ league: s.name, season: s.season, status: s.type !== 'League' ? `skipped (type ${s.type})` : `skipped (${s.groups} different tables)` });
    continue;
  }
  const results = await repo.seasonResults(s.league_id, s.season, new Date(Date.now() + 86_400_000));
  const mine = new Map(tableAsOf(results, new Date(Date.now() + 86_400_000)).map((r) => [r.teamId, r]));
  const api = (await db.query<{ team_id: number; rank: number; played: number; points: number }>(`select team_id, rank, played, points from standings where league_id = $1 and season = $2`, [s.league_id, s.season])).rows;
  let exact = 0, within1 = 0, pointsEqual = 0, playedEqual = 0;
  for (const a of api) {
    const m = mine.get(a.team_id);
    if (!m) continue;
    if (m.rank === a.rank) exact++;
    if (Math.abs(m.rank - a.rank) <= 1) within1++;
    if (m.points === a.points) pointsEqual++;
    if (m.played === a.played) playedEqual++;
  }
  rows.push({ league: s.name, season: s.season, teams: api.length, exact_rank: exact, within_1: within1, points_equal: pointsEqual, played_equal: playedEqual });
}
console.table(rows);
const used = rows.filter((r) => r.teams) as Array<{ teams: number; exact_rank: number; within_1: number; points_equal: number; played_equal: number }>;
const sum = (k: 'teams' | 'exact_rank' | 'within_1' | 'points_equal' | 'played_equal') => used.reduce((s, r) => s + r[k], 0);
console.log(`teams ${sum('teams')} · exact rank ${((100 * sum('exact_rank')) / sum('teams')).toFixed(1)}% · within 1 place ${((100 * sum('within_1')) / sum('teams')).toFixed(1)}% · same points ${((100 * sum('points_equal')) / sum('teams')).toFixed(1)}% · same matches played ${((100 * sum('played_equal')) / sum('teams')).toFixed(1)}%`);
await db.close();
