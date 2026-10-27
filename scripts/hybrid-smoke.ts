/**
 * Smoke test of the Hybrid AI on real data (docs/adr/0010-hybrid-ai-picks.md), before the engine is switched on.
 * Reads the database, calls the real AI, validates the answer as the job does, prints it. Writes NOTHING: no
 * decision, no pick. Each fixture costs one AI call per provider.
 *
 *   npx tsx scripts/hybrid-smoke.ts [--fixtures 2] [--provider claude|openai|both]
 */
import { parseArgs } from 'node:util';
import { createClaudeHybridDecider, createOpenAIHybridDecider, validateHybridOutput, type HybridDecider } from '@fp/ai';
import { createPgDb, Repository, type JobContext } from '@fp/database';
import { addHours, loadDotEnvFile, loadEnv } from '@fp/shared';
import { collectHybridInput } from '../workers/analysis/src/hybrid-job.js';

const { values } = parseArgs({ options: { fixtures: { type: 'string', default: '2' }, provider: { type: 'string', default: 'claude' } } });
loadDotEnvFile();
const env = loadEnv();
const db = createPgDb(env.DATABASE_URL!, { max: 2 });
const repo = new Repository(db);
const ctx = { env, db, repo } as unknown as JobContext;

const deciders: Array<[string, HybridDecider]> = [];
if (values.provider !== 'openai' && env.ANTHROPIC_API_KEY) deciders.push([`claude (${env.HYBRID_AI_MODEL ?? 'default'})`, createClaudeHybridDecider({ apiKey: env.ANTHROPIC_API_KEY, model: env.HYBRID_AI_MODEL })]);
if (values.provider !== 'claude' && env.OPENAI_API_KEY && env.OPENAI_MODEL) deciders.push([`openai (${env.OPENAI_MODEL})`, createOpenAIHybridDecider({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL })]);
if (!deciders.length) throw new Error('no AI key for the chosen provider');

const now = new Date();
const fixtures = (await repo.fixturesForCandidates(env.TRACKED_LEAGUES, addHours(now, 3).toISOString(), addHours(now, 48).toISOString())).slice(0, 60);
let done = 0;
for (const f of fixtures) {
  if (done >= Number(values.fixtures)) break;
  const { header, input, inputHash, options, legacy } = await collectHybridInput(ctx, f, 'EARLY', now);
  if (!options.length) continue;
  done++;
  console.log(`\n=== ${header.home} vs ${header.away} (${header.league}), kickoff ${f.kickoffAt.toISOString()} · input ${inputHash.slice(0, 12)}`);
  console.log(`options: ${options.map((o) => `${o.side} ${o.selection} ${o.line} @${o.odds} (${(o.marketProbability * 100).toFixed(1)}%)`).join(' · ')}`);
  console.log(`legacy rules: ${JSON.stringify((legacy as { outcome?: string; pick?: unknown } | null) ?? null)}`);
  for (const [name, d] of deciders) {
    const t = Date.now();
    try {
      const res = await d.decide(input);
      const v = res.output === null ? null : validateHybridOutput(res.output, input, options);
      const out = res.output as { side?: string; main_line?: number | null; confidence?: string; summary_th?: string } | null;
      console.log(`- ${name} → ${res.model}, ${((Date.now() - t) / 1000).toFixed(1)} s, usage ${JSON.stringify(res.usage)}`);
      console.log(`  answer: ${out ? `${out.side} ${out.main_line ?? ''} ${out.confidence}` : `none (stop ${res.stopReason}, refusal ${JSON.stringify(res.refusal)})`}`);
      console.log(`  valid: ${v ? (v.ok ? 'yes' : `NO — ${v.violations.join(' | ')}`) : 'no output'}`);
      if (out?.summary_th) console.log(`  summary: ${out.summary_th}`);
      // where a rejected number sits, to tell an invented figure from a harmless one
      for (const n of (v?.violations ?? []).flatMap((x) => x.match(/number not in input: ([0-9.,]+)/)?.[1] ?? [])) {
        const text = JSON.stringify(res.output);
        const i = text.indexOf(n);
        console.log(`  around ${n}: …${text.slice(Math.max(0, i - 80), i + 40)}…`);
      }
    } catch (err) {
      console.log(`- ${name} ERROR after ${((Date.now() - t) / 1000).toFixed(1)} s: ${String(err).slice(0, 300)}`);
    }
  }
}
if (!done) console.log('no fixture with a usable main line in the next 3–48 h');
await db.close();
