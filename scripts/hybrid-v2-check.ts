/** Read-only: the Hybrid AI input v1 vs v2 for upcoming fixtures (rank basis, injury coverage, extra time). No AI call, nothing written. */
import { createPgDb, Repository, type JobContext } from '@fp/database';
import { addHours, loadDotEnvFile, loadEnv } from '@fp/shared';
import { collectHybridInput } from '../workers/analysis/src/hybrid-job.js';

loadDotEnvFile();
const env = loadEnv();
const db = createPgDb(env.DATABASE_URL!, { max: 2 });
const ctx = { env, db, repo: new Repository(db) } as unknown as JobContext;
const now = new Date();
const fixtures = (await ctx.repo.fixturesForCandidates(env.TRACKED_LEAGUES, now.toISOString(), addHours(now, 30).toISOString())).slice(0, 40);
type Team = { recent_matches: Array<{ opponent: string; date_utc: string; opponent_table_position: string | null }> };
type In = { home_team: Team; away_team: Team; data_quality: { injuries_coverage?: string; opponent_rank_basis?: string; missing: string[] } };
let t1 = 0, t2 = 0, n = 0, rank1 = 0, rank2 = 0, matches = 0, diffShown = 0;
const cov = new Map<string, string>();
for (const f of fixtures) {
  let a = Date.now();
  const v1 = (await collectHybridInput(ctx, f, 'EARLY', now)).input as unknown as In;
  t1 += Date.now() - a;
  a = Date.now();
  const r2 = await collectHybridInput(ctx, f, 'EARLY', now, { inputV2: true });
  t2 += Date.now() - a;
  const v2 = r2.input as unknown as In;
  n++;
  cov.set(r2.header.league, v2.data_quality.injuries_coverage ?? '?');
  for (const side of ['home_team', 'away_team'] as const)
    v1[side].recent_matches.forEach((m, i) => {
      const m2 = v2[side].recent_matches[i]!;
      matches++;
      if (m.opponent_table_position) rank1++;
      if (m2.opponent_table_position) rank2++;
      if (diffShown < 6 && m.opponent_table_position && m2.opponent_table_position && m.opponent_table_position !== m2.opponent_table_position) {
        diffShown++;
        console.log(`${r2.header.league}: ${m.date_utc} vs ${m.opponent}: v1 (today's table) ${m.opponent_table_position} -> v2 (that day) ${m2.opponent_table_position}`);
      }
    });
}
console.log(`\nfixtures ${n} · avg input build: v1 ${(t1 / n).toFixed(0)} ms, v2 ${(t2 / n).toFixed(0)} ms`);
console.log(`recent matches ${matches} · with an opponent position: v1 ${rank1} (${((100 * rank1) / matches).toFixed(0)}%), v2 ${rank2} (${((100 * rank2) / matches).toFixed(0)}%)`);
console.log('injury coverage by league:', JSON.stringify([...cov.entries()].sort()));
await db.close();
