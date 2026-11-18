/**
 * Decisions v2 smoke test on stored past inputs (stage 3, .scratch/decisions-v2/spec.md). Never writes to the DB.
 *
 *   npx tsx scripts/decisions-v2-smoke.ts --ids 746,760          hybrid_decisions ids (DAILY rows)
 *   npx tsx scripts/decisions-v2-smoke.ts --day 2026-11-09 --limit 3
 *
 * Calls OpenAI Decisions once per fixture on exactly the stored DAILY input, runs the v2 engine and prints the view,
 * every option's distribution, EV and reasons, and the factor evidence. Raw records go to reports/decisions-v2/smoke.jsonl.
 * These matches are finished, so this checks the mechanics only: it is not evidence about results (spec §6).
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createDecisionsV2Client, DECISIONS_V2_PROMPT_VERSION, runDecisionsV2 } from '@fp/ai';
import { createPgDb } from '@fp/database';
import { loadDotEnvFile, loadEnv } from '@fp/shared';

const { values } = parseArgs({ options: { ids: { type: 'string' }, day: { type: 'string' }, limit: { type: 'string', default: '3' } } });
loadDotEnvFile();
const env = loadEnv();
if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is needed');
const db = createPgDb(env.DATABASE_URL!, { max: 1 });

const rows = values.ids
  ? (await db.query<{ id: string; input: Record<string, any> }>(`select id, input from hybrid_decisions where id = any($1::bigint[]) order by id`, [values.ids.split(',').map(Number)])).rows
  : (
      await db.query<{ id: string; input: Record<string, any> }>(
        `select distinct on (fixture_id) id, input from hybrid_decisions
          where publish_round = 'DAILY' and kickoff_at >= $1::timestamptz and kickoff_at < $1::timestamptz + interval '1 day'
          order by fixture_id, decided_at desc limit $2`,
        [`${values.day}T07:00:00Z`, Number(values.limit)],
      )
    ).rows;

const client = createDecisionsV2Client({ apiKey: env.OPENAI_API_KEY });
await mkdir('reports/decisions-v2', { recursive: true });
const f = (x: number, d = 3) => x.toFixed(d);
for (const r of rows) {
  const res = await runDecisionsV2(r.input, client);
  const m = r.input.match;
  console.log(`\n=== #${r.id} ${m.home} v ${m.away} (${m.competition}) — ${res.status}${res.note ? ` (${res.note})` : ''}`);
  if (res.fit) console.log(`market fit λ ${f(res.fit.lambdaHome, 2)}–${f(res.fit.lambdaAway, 2)} ρ ${f(res.fit.rho)} ok=${res.fit.ok}`);
  if (res.answers) {
    const show = (p: Record<string, number>) => Object.entries(p).map(([k, v]) => `${k} ${f(v, 2)}`).join(' ');
    console.log(`margin vs line: ${show(res.answers.view.margin as Record<string, number>)}`);
    console.log(`total vs line:  ${show(res.answers.view.total as Record<string, number>)}`);
    console.log(`data_sufficient ${res.answers.dataSufficient} lineup_uncertain ${res.answers.lineupUncertain} refusals ${res.answers.refusals.join(',') || '-'}`);
    console.log(`factors: ${res.answers.factors.map((x) => `${x.name} [${x.probabilities.map((p) => f(p, 2)).join(' ')}]`).join('  ')}`);
  }
  for (const c of res.decision?.candidates ?? []) {
    const d = c.distribution;
    const ev = res.evidence.find((e) => e.side === c.side);
    console.log(
      `  ${c.side.padEnd(8)} ${String(c.line).padStart(5)} @${c.odds}  mkt ${f(c.marketProbability)} → v2 ${f(c.fairProbability)}  W/HW/P/HL/L ${[d.win, d.halfWin, d.push, d.halfLoss, d.loss].map((x) => f(x, 2)).join('/')}  EV ${f(c.ev)} ±${f(c.evSd)}  ${c.reasons.join(',') || 'CHOSEN'}  +[${ev?.supporting.map((s) => s.factor).join(',') ?? ''}] −[${ev?.conflicting.map((s) => s.factor).join(',') ?? ''}]`,
    );
  }
  console.log(`→ ${res.decision?.side ?? '–'} ${res.decision?.noPickReasons.length ? `(${res.decision.noPickReasons.join(', ')})` : ''}  tokens in ${res.response?.usage.input_tokens ?? 0}`);
  await appendFile('reports/decisions-v2/smoke.jsonl', JSON.stringify({ hybridDecisionId: Number(r.id), promptVersion: DECISIONS_V2_PROMPT_VERSION, at: new Date().toISOString(), ...res }) + '\n');
}
await db.close();
