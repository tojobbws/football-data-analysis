/**
 * Smoke test of Hybrid AI v2.1.1 on live data through the production functions (ADR 0021), before and after deploy.
 * Builds the inputs of the coming fixtures with collectHybridInput(version v2.1.1) exactly as the hybrid job does,
 * checks them (cut-off warnings, the totals and their counts), and asks the real AI one answer per fixture with the
 * v2.1.1 decider and validator (a feedback retry when rejected). Writes NOTHING: no decision, no pick.
 *
 *   npx tsx scripts/hybrid-v211-smoke.ts [--fixtures 2] [--no-ai]
 */
import { parseArgs } from 'node:util';
import { createOpenAIHybridDeciderV21, HYBRID_MAX_ATTEMPTS, HYBRID_SYSTEM_PROMPT_V211, locateViolations, retryFeedbackV21, validateHybridOutputV211 } from '@fp/ai';
import { createPgDb, Repository, type JobContext } from '@fp/database';
import { addHours, loadDotEnvFile, loadEnv } from '@fp/shared';
import { collectHybridInput, hybridOpenAIModel, hybridPromptVersion, hybridVersion } from '../workers/analysis/src/hybrid-job.js';

const { values } = parseArgs({ options: { fixtures: { type: 'string', default: '2' }, 'no-ai': { type: 'boolean', default: false } } });
loadDotEnvFile();
const env = loadEnv();
const db = createPgDb(env.DATABASE_URL!, { max: 2 });
const repo = new Repository(db);
const ctx = { env, db, repo, log: { info: () => {}, warn: console.warn, error: console.error, debug: () => {} } } as unknown as JobContext;
const version = hybridVersion(env);
console.log(`HYBRID_VERSION in this environment: ${env.HYBRID_VERSION ?? '(unset)'} → ${version} → ${hybridPromptVersion(version)}`);

const now = new Date();
const fixtures = (await repo.fixturesForCandidates(env.TRACKED_LEAGUES, addHours(now, 3).toISOString(), addHours(now, 48).toISOString())).slice(0, 80);
const model = hybridOpenAIModel(env)!;
const decider = createOpenAIHybridDeciderV21({ apiKey: env.OPENAI_API_KEY!, model, system: HYBRID_SYSTEM_PROMPT_V211 });
let done = 0;
for (const f of fixtures) {
  if (done >= Number(values.fixtures)) break;
  const { header, input, inputHash, options, cutoffWarnings } = await collectHybridInput(ctx, f, 'DAILY', now, { inputV2: true, v20: true, version: 'v2.1.1' });
  if (!options.length) continue;
  done++;
  const H = (input.home_team as Record<string, any>).last_10;
  console.log(`\n=== ${header.home} vs ${header.away} (${header.league}) · kickoff ${f.kickoffAt.toISOString()} · input ${inputHash.slice(0, 12)} · ${JSON.stringify(input).length} chars`);
  console.log(`cutoff warnings: ${JSON.stringify(cutoffWarnings)} · data_quality.cutoff_warnings ${JSON.stringify((input.data_quality as any).cutoff_warnings)}`);
  console.log(`home last_10: matches ${H.matches} goals_matches ${H.goals_matches} goals_total_avg ${H.goals_total_avg} · xg_for_matches ${H.xg_for_matches} xg_total_matches ${H.xg_total_matches} xg_total_avg ${H.xg_total_avg}`);
  console.log(`first recent match: ${JSON.stringify((input.home_team as any).recent_matches[0], ['date_utc', 'score_for_against', 'goals_total', 'xg_for', 'xg_against', 'xg_total'])}`);
  if (values['no-ai']) continue;
  let previous: unknown = null;
  let feedback: string | null = null;
  for (let attempt = 1; attempt <= HYBRID_MAX_ATTEMPTS; attempt++) {
    const t = Date.now();
    const res = feedback ? await decider.retry(input, previous, feedback) : await decider.decide(input);
    const v = validateHybridOutputV211(res.output, input, options);
    const out = res.output as Record<string, any> | null;
    console.log(`attempt ${attempt}${feedback ? ' (feedback retry)' : ''}: ${((Date.now() - t) / 1000).toFixed(1)} s · ${res.model} · ${v.ok ? `OK → ${v.decision!.side} ${v.decision!.confidence ?? ''}` : `REJECTED ${v.violations.join('; ')}`}`);
    if (out) console.log(`  summary_th: ${out.summary_th}`);
    if (v.ok) break;
    previous = res.output;
    feedback = retryFeedbackV21(locateViolations(res.output, input, options, { averageCounts: true }));
  }
}
await db.close();
