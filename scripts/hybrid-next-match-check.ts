/** Read-only check: the next_match block of the Hybrid AI input for upcoming fixtures. No AI call, nothing written. */
import { createPgDb, Repository, type JobContext } from '@fp/database';
import { addHours, loadDotEnvFile, loadEnv } from '@fp/shared';
import { collectHybridInput } from '../workers/analysis/src/hybrid-job.js';

loadDotEnvFile();
const env = loadEnv();
const db = createPgDb(env.DATABASE_URL!, { max: 2 });
const ctx = { env, db, repo: new Repository(db) } as unknown as JobContext;
const now = new Date();
const fixtures = (await ctx.repo.fixturesForCandidates(env.TRACKED_LEAGUES, now.toISOString(), addHours(now, 30).toISOString())).slice(0, 40);
let shown = 0;
const stats = { fixtures: 0, homeNext: 0, awayNext: 0, bothMissing: 0 };
for (const f of fixtures) {
  const { header, input } = await collectHybridInput(ctx, f, 'EARLY', now);
  const i = input as { home_team: { next_match: Record<string, unknown> | null }; away_team: { next_match: Record<string, unknown> | null }; data_quality: { missing: string[] } };
  stats.fixtures++;
  if (i.home_team.next_match) stats.homeNext++;
  if (i.away_team.next_match) stats.awayNext++;
  if (!i.home_team.next_match && !i.away_team.next_match) stats.bothMissing++;
  if (shown < 6 && (i.home_team.next_match || i.away_team.next_match)) {
    shown++;
    console.log(`\n${header.home} vs ${header.away} (${header.league}) kickoff ${f.kickoffAt.toISOString()}`);
    console.log('  home next:', JSON.stringify(i.home_team.next_match), '\n  away next:', JSON.stringify(i.away_team.next_match));
    console.log('  missing:', JSON.stringify(i.data_quality.missing.filter((m) => m.includes('next fixture'))));
  }
}
console.log('\n', JSON.stringify(stats));
await db.close();
