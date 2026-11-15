/**
 * One-off, 15 Nov 2026, prompt hybrid-ai-v1.9 (ADR 0019 amendment 2). The owner asked the AI to choose again for
 * every match of the pick day under the new prompt. analysis_predictions forbids update and delete, so each match gets
 * one more round through the existing rules: a match with only its DAILY round gets EARLY (more than 3 hours to
 * kickoff); a match whose EARLY round came from v1.8 gets PREMATCH, the round a prompt change earns (ADR 0013).
 * The featured list of the day is locked once chosen: it keeps its matches, and the site shows each one's latest round.
 *
 *   npx tsx scripts/oneoff-repick-v19-2026-11-15.ts --dry   # list the matches, writes nothing
 *   npx tsx scripts/oneoff-repick-v19-2026-11-15.ts
 */
import { HYBRID_PROMPT_VERSION } from '@fp/ai';
import { createJobContext } from '@fp/database';
import { loadDotEnvFile } from '@fp/shared';
import { hybridJob } from '../workers/analysis/src/hybrid-job.js';
import { publishJob } from '../workers/analysis/src/publish-job.js';

// the nine matches of pick day 2026-11-15 (all national-team matches)
const FIXTURES = [1528979, 1528980, 1528981, 1528982, 1528983, 1528984, 1528985, 1545616, 1644696];

loadDotEnvFile();
if ((HYBRID_PROMPT_VERSION as string) !== 'hybrid-ai-v1.9') throw new Error(`this checkout has ${HYBRID_PROMPT_VERSION}, not hybrid-ai-v1.9`);
const ctx = createJobContext();
const all = ctx.repo.fixturesForCandidates.bind(ctx.repo);
ctx.repo.fixturesForCandidates = async (...a: Parameters<typeof all>) => (await all(...a)).filter((f) => FIXTURES.includes(f.id));

const fx = await ctx.repo.fixturesForCandidates(ctx.env.TRACKED_LEAGUES, new Date().toISOString(), new Date(Date.now() + 24 * 3_600_000).toISOString());
console.table(fx.map((f) => ({ id: f.id, league: f.leagueId, kickoff: f.kickoffAt.toISOString(), hoursAhead: ((f.kickoffAt.getTime() - Date.now()) / 3_600_000).toFixed(1) })));
if (!process.argv.includes('--dry')) {
  const opts = { engine: 'hybrid' as const, schedule: 'rounds' as const, sameFootballDay: false };
  await hybridJob(ctx, { ...opts, budgetMinutes: 20, concurrency: 3 });
  await publishJob(ctx, opts);
}
await ctx.db.close();
