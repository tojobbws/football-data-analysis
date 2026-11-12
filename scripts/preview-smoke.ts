/**
 * Smoke test of the match preview prompt on real data, before a prompt change goes live.
 * Reads the database, calls the real AI with the input the preview job would build, validates the answer as
 * the job does, prints the write-up. Writes NOTHING. Each fixture costs one AI call.
 *
 *   npx tsx scripts/preview-smoke.ts [--fixtures 2] [--hours 24] [--fixture <id>] [--json]
 *
 * --fixture picks one match within the window; --json also prints the raw answer as one JSON line.
 */
import { parseArgs } from 'node:util';
import { createClaudePreviewWriter, createOpenAIPreviewWriter, validatePreviewOutput } from '@fp/ai';
import { assessDataSupport } from '@fp/analysis';
import { createPgDb, Repository, type JobContext } from '@fp/database';
import { addHours, loadDotEnvFile, loadEnv } from '@fp/shared';
import { collectFacts, previewWriterInput } from '../workers/analysis/src/preview-job.js';

const { values } = parseArgs({
  options: { fixtures: { type: 'string', default: '2' }, hours: { type: 'string', default: '24' }, fixture: { type: 'string' }, json: { type: 'boolean', default: false } },
});
loadDotEnvFile();
const env = loadEnv();
const db = createPgDb(env.DATABASE_URL!, { max: 2 });
const repo = new Repository(db);
const ctx = { env, db, repo } as unknown as JobContext;

// the job's choice: OpenAI when its key and model are set, else Claude
const writer =
  env.OPENAI_API_KEY && env.OPENAI_MODEL
    ? createOpenAIPreviewWriter({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL })
    : env.ANTHROPIC_API_KEY
      ? createClaudePreviewWriter({ apiKey: env.ANTHROPIC_API_KEY })
      : null;
if (!writer) throw new Error('no AI key');

const now = new Date();
const inWindow = await repo.fixturesForCandidates(env.TRACKED_LEAGUES, addHours(now, 1).toISOString(), addHours(now, Number(values.hours)).toISOString());
const fixtures = (values.fixture ? inWindow.filter((f) => String(f.id) === values.fixture) : inWindow).slice(0, Number(values.fixtures));
for (const f of fixtures) {
  const { facts, bands } = await collectFacts(ctx, f, 'EARLY');
  const support = assessDataSupport(facts);
  const { input } = previewWriterInput(facts, bands, support);
  console.log(`\n=== ${facts.fixture.home} vs ${facts.fixture.away} (${facts.fixture.league}), kickoff ${f.kickoffAt.toISOString()} · data ${support.level}`);
  const t = Date.now();
  try {
    const res = await writer.write(input);
    console.log(`model ${res.model}, ${((Date.now() - t) / 1000).toFixed(1)} s, usage ${JSON.stringify(res.usage)}`);
    if (res.output === null) {
      console.log(`no output (stop ${res.stopReason}, refusal ${JSON.stringify(res.refusal)})`);
      continue;
    }
    const v = validatePreviewOutput(res.output, input);
    console.log(`valid: ${v.ok ? 'yes' : `NO — ${v.violations.join(' | ')}`}`);
    const o = res.output as Record<string, unknown>;
    const keys = ['headline_th', 'overview_th', 'home_th', 'away_th', 'analysis_th', 'summary_th'];
    for (const k of keys) console.log(`\n[${k}] ${String(o[k] ?? '')}`);
    const total = keys.reduce((n, k) => n + String(o[k] ?? '').length, 0);
    console.log(`\n${total} characters`);
    if (values.json) console.log(`JSON ${JSON.stringify(res.output)}`);
  } catch (err) {
    console.log(`ERROR after ${((Date.now() - t) / 1000).toFixed(1)} s: ${String(err).slice(0, 300)}`);
  }
}
if (!fixtures.length) console.log('no fixture in the window');
await db.close();
