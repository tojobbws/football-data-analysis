/**
 * One-off, 15 Nov 2026 (ADR 0019 amendment). The DAILY round of four national-team matches went out as a no-pick
 * because the AI's handicap choice was shadow then. analysis_predictions forbids update and delete, so this adds an
 * EARLY round to those four only: the Hybrid AI decides them afresh now (three answers, as every run), the publish
 * job writes the round with the national shadow withdrawn, then the pick day's featured list is chosen.
 * The DAILY rows stay in the record. EARLY needs more than 3 hours to kickoff: run before 18:00 Thai.
 *
 *   npx tsx scripts/oneoff-national-early-2026-11-15.ts --dry   # list what it would decide, writes nothing
 *   npx tsx scripts/oneoff-national-early-2026-11-15.ts
 */
import { createJobContext } from '@fp/database';
import { loadDotEnvFile } from '@fp/shared';
import { featuredOnceJob } from '../workers/analysis/src/featured-once-job.js';
import { hybridJob } from '../workers/analysis/src/hybrid-job.js';
import { hybridShadowReason, publishJob } from '../workers/analysis/src/publish-job.js';

// Cyprus–Montenegro, Belarus–Albania, France–Türkiye (UNL), Panama–Curaçao (CONCACAF NL)
const FIXTURES = [1528979, 1528980, 1528982, 1644696];

loadDotEnvFile();
const ctx = createJobContext();
if (hybridShadowReason('ASIAN_HANDICAP') !== null) throw new Error('this checkout still has the national shadow: use branch national-picks-back');

const all = ctx.repo.fixturesForCandidates.bind(ctx.repo);
ctx.repo.fixturesForCandidates = async (...a: Parameters<typeof all>) => (await all(...a)).filter((f) => FIXTURES.includes(f.id));

const fx = await ctx.repo.fixturesForCandidates(ctx.env.TRACKED_LEAGUES, new Date().toISOString(), new Date(Date.now() + 24 * 3_600_000).toISOString());
console.table(fx.map((f) => ({ id: f.id, league: f.leagueId, kickoff: f.kickoffAt.toISOString(), hoursAhead: ((f.kickoffAt.getTime() - Date.now()) / 3_600_000).toFixed(1) })));
if (process.argv.includes('--dry')) {
  await ctx.db.close();
  process.exit(0);
}

const opts = { engine: 'hybrid' as const, schedule: 'rounds' as const, sameFootballDay: false };
await hybridJob(ctx, { ...opts, budgetMinutes: 15 });
await publishJob(ctx, opts);

ctx.repo.fixturesForCandidates = all; // the featured list looks at the whole pick day
await featuredOnceJob(ctx);
const { rows } = await ctx.db.query<Record<string, unknown>>(
  `select fixture_id, phase, rank, version from featured_selections where football_date = '2026-11-15' order by rank nulls last`,
);
console.table(rows);
await ctx.db.close();
