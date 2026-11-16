/**
 * OpenAI Decisions shadow for one pick day (owner's request 16 Nov 2026: "วัดผลแค่คู่คืนนี้ ดูในหน้า admin ได้").
 * Never published: the published pick stays the Hybrid AI's. Nothing in production prompts, jobs or picks changes.
 *
 *   npx tsx scripts/decisions-shadow.ts --day 2026-11-16            call Decisions, then store (when the table exists)
 *   npx tsx scripts/decisions-shadow.ts --day 2026-11-16 --store    store the saved answers only (no API call)
 *
 * Input: for every fixture of the pick day (14:00 → 14:00 Thai) with a DAILY Hybrid AI decision, exactly the input that
 * decision stored (hybrid_decisions.input, written before kickoff by the DB trigger, same input_hash). Decisions reads
 * nothing newer, so a call made after kickoff still sees only the 14:00 data; called_at is kept and the admin page marks
 * those answers. Match results are not read here.
 * Config: decisions-bias-D-v1 of the dry-run (scripts/research/decisions-bias.ts): market-blind choice descriptions, one
 * predicate per option, the v2.0 guide without the v1.9 Over/Under paragraph. It was the closest of A/B/C/D/R to the
 * live choice mix (JSD 0.025 on 260 settled matches).
 * Answers are saved first to reports/decisions-shadow/<day>.jsonl (raw responses), then inserted into decisions_shadow
 * (migration 0061); a fixture already stored is skipped. Low concurrency (the key is shared with production), $0.10 cap.
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import OpenAI from 'openai';
import { HYBRID_SYSTEM_PROMPT, HYBRID_V20_GUIDE, isPersistentOpenAIError, userMessage } from '@fp/ai';
import type { HybridOption, HybridSide } from '@fp/analysis';
import { createPgDb } from '@fp/database';
import { loadDotEnvFile, loadEnv } from '@fp/shared';

const { values } = parseArgs({ options: { day: { type: 'string' }, store: { type: 'boolean', default: false }, budget: { type: 'string', default: '0.1' } } });
const DAY = values.day;
if (!DAY || !/^\d{4}-\d{2}-\d{2}$/.test(DAY)) throw new Error('--day YYYY-MM-DD (the pick day) is needed');
const CONFIG = 'decisions-bias-D-v1';
const MODEL = 'gpt-6-luna';
const FILE = `reports/decisions-shadow/${DAY}.jsonl`;
const PRICE = { input: 0.1, cached: 0.01, cacheWrite: 0.125 };

loadDotEnvFile();
const env = loadEnv();
const db = createPgDb(env.DATABASE_URL!, { max: 2 });
const from = `${DAY}T07:00:00Z`;
const to = new Date(Date.parse(from) + 86_400_000).toISOString();

// ---------------------------------------------------------------- the stored inputs of the day's DAILY decisions
const rows = (
  await db.query<{ id: string; fixture_id: string; input: Record<string, unknown>; input_hash: string; kickoff_at: Date }>(
    `select distinct on (d.fixture_id) d.id, d.fixture_id, d.input, d.input_hash, d.kickoff_at
       from hybrid_decisions d
      where d.engine_version = 'hybrid-ai-v1' and d.publish_round = 'DAILY' and d.kickoff_at >= $1 and d.kickoff_at < $2
      order by d.fixture_id, d.decided_at desc, d.id desc`,
    [from, to],
  )
).rows.sort((a, b) => new Date(a.kickoff_at).getTime() - new Date(b.kickoff_at).getTime());

function optionsOf(input: Record<string, unknown>): HybridOption[] {
  const m = input.market as Record<string, { options?: Array<Record<string, unknown>> }>;
  const home = (input.match as { home: string }).home;
  const out: HybridOption[] = [];
  for (const o of m.asian_handicap?.options ?? [])
    out.push({ side: o.option as HybridSide, market: 'ASIAN_HANDICAP', selection: o.team_or_total === home ? 'HOME' : 'AWAY', line: Number(o.line), odds: Number(o.odds_median), marketProbability: Number(o.market_probability_no_vig) });
  for (const o of m.over_under?.options ?? [])
    out.push({ side: o.option as HybridSide, market: 'OVER_UNDER', selection: String(o.team_or_total), line: Number(o.line), odds: Number(o.odds_median), marketProbability: Number(o.market_probability_no_vig) });
  return out;
}

// ---------------------------------------------------------------- config D, text as in the dry-run
const BASE_GUIDE = HYBRID_SYSTEM_PROMPT.split('\n\nOutput rules:')[0]!;
const OU_RULE_V19 = BASE_GUIDE.match(/An Over or Under choice needs more than recent goal counts\.[^\n]*\n\n/)?.[0];
if (!OU_RULE_V19) throw new Error('v1.9 Over/Under paragraph not found in the guide');
const guideFor = (input: Record<string, unknown>) => ('elo_ratings' in input ? BASE_GUIDE : BASE_GUIDE.replace(`${HYBRID_V20_GUIDE}\n\n`, '')).replace(OU_RULE_V19, '');
const sign = (x: number) => (x > 0 ? `+${x}` : String(x));
function describe(o: HybridOption, input: Record<string, unknown>, withMarket: boolean): string {
  const { home, away } = input.match as { home: string; away: string };
  const mkt = withMarket ? ` (market no-vig probability ${o.marketProbability})` : '';
  if (o.market === 'OVER_UNDER') return `${o.selection === 'OVER' ? 'Over' : 'Under'} ${o.line} total goals${mkt}`;
  return `Asian handicap ${o.side === 'FAVORITE' ? 'favourite' : 'underdog'}: ${o.selection === 'HOME' ? home : away} ${sign(o.line)}${mkt}`;
}
const PICK_INSTR =
  'As the analyst described above: which one choice has the strongest evidence that the market price may not reflect? Choose NO_PICK when the information is insufficient or no option can be justified; no pick is a correct, common answer. Do not automatically favour the underdog, the favourite, Over or Under.';
const NO_PICK_DESC = 'No choice: the evidence does not point clearly to any option beyond what the price already contains.';
const PRED_INSTR = (d: string) => `Using only the match data, estimate the chance that this option comes out ahead at its line on the 90-minute score (a win or a half win; a push does not count either way): ${d}.`;

function body(input: Record<string, unknown>): OpenAI.DecisionCreateParams {
  const opts = optionsOf(input);
  return {
    model: MODEL,
    input: [{ role: 'user', content: [{ type: 'input_text', text: guideFor(input) }, { type: 'input_text', text: userMessage(input) }] }],
    questions: [
      { type: 'choice', name: 'pick', instructions: PICK_INSTR, choices: [...opts.map((o) => ({ value: o.side, description: describe(o, input, false) })), { value: 'NO_PICK', description: NO_PICK_DESC }] },
      ...opts.map((o) => ({ type: 'predicate' as const, name: `wins_${o.side}`, instructions: PRED_INSTR(describe(o, input, true)) })),
    ],
  };
}

// ---------------------------------------------------------------- answers saved so far
const saved = new Map<number, Record<string, any>>();
try {
  for (const line of (await readFile(FILE, 'utf8')).split('\n')) if (line.trim()) { const r = JSON.parse(line); saved.set(Number(r.fixtureId), r); }
} catch {
  /* no file yet */
}

// ---------------------------------------------------------------- call
if (!values.store) {
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is needed');
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: 60_000, maxRetries: 2 });
  await mkdir('reports/decisions-shadow', { recursive: true });
  let usd = 0;
  const todo = rows.filter((r) => !saved.has(Number(r.fixture_id)) && optionsOf(r.input).length > 0);
  console.log(`pick day ${DAY}: ${rows.length} DAILY decisions, ${saved.size} answered before, ${todo.length} to ask`);
  const queue = [...todo];
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        if (usd > Number(values.budget)) return;
        const b = body(r.input);
        const calledAt = new Date();
        let res: Awaited<ReturnType<typeof client.decisions.create>>;
        try {
          res = await client.decisions.create(b);
        } catch (err) {
          console.error(`fixture ${r.fixture_id}: ${(err as Error).message}`);
          if (isPersistentOpenAIError(err)) throw err;
          continue;
        }
        const u = res.usage;
        const cached = u.input_tokens_details?.cached_tokens ?? 0;
        const write = u.input_tokens_details?.cache_write_tokens ?? 0;
        usd += ((u.input_tokens - cached - write) * PRICE.input + cached * PRICE.cached + write * PRICE.cacheWrite) / 1e6;
        const rec = {
          config: CONFIG, model: res.model ?? MODEL, fixtureId: Number(r.fixture_id), hybridDecisionId: Number(r.id), inputHash: r.input_hash,
          kickoffAt: new Date(r.kickoff_at).toISOString(), calledAt: calledAt.toISOString(), latencyMs: Date.now() - calledAt.getTime(),
          payloadSha256: createHash('sha256').update(JSON.stringify(b)).digest('hex'), questions: b.questions, response: res,
        };
        saved.set(rec.fixtureId, rec);
        await appendFile(FILE, JSON.stringify(rec) + '\n');
        const pick = res.answers.find((a) => a.name === 'pick');
        console.log(`fixture ${r.fixture_id} ${pick && pick.type === 'choice' ? pick.choice : '?'} (${rec.latencyMs} ms)`);
      }
    }),
  );
  console.log(`spent ≈ $${usd.toFixed(4)}`);
}

// ---------------------------------------------------------------- store
const exists = (await db.query<{ t: string | null }>(`select to_regclass('public.decisions_shadow')::text as t`)).rows[0]?.t;
if (!exists) {
  console.log('decisions_shadow does not exist yet (migration 0061): answers kept in', FILE);
} else {
  const done = new Set((await db.query<{ fixture_id: string }>('select fixture_id from decisions_shadow where config = $1', [CONFIG])).rows.map((r) => Number(r.fixture_id)));
  let n = 0;
  for (const r of rows) {
    const rec = saved.get(Number(r.fixture_id));
    if (!rec || done.has(rec.fixtureId)) continue;
    const pick = (rec.response.answers as Array<Record<string, any>>).find((a) => a.name === 'pick');
    const opts = optionsOf(r.input);
    const valid = new Set([...opts.map((o) => o.side), 'NO_PICK']);
    const side = pick?.type === 'choice' ? String(pick.choice) : null;
    const status = side == null ? 'ERROR' : valid.has(side) ? 'OK' : 'INVALID';
    const o = status === 'OK' ? opts.find((x) => x.side === side) : undefined;
    const probabilities = pick?.type === 'choice' ? Object.fromEntries((pick.probabilities as Array<{ value: string; probability: number }>).map((p) => [p.value, p.probability])) : null;
    const predicates = Object.fromEntries((rec.response.answers as Array<Record<string, any>>).filter((a) => a.type === 'predicate').map((a) => [String(a.name).replace(/^wins_/, ''), a.probability]));
    await db.query(
      `insert into decisions_shadow (fixture_id, hybrid_decision_id, input_hash, config, model, called_at, status, side, market, selection, line, odds,
                                     market_probability, choice_probability, confidence, probabilities, predicates, response, usage)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        rec.fixtureId, rec.hybridDecisionId, rec.inputHash, rec.config, rec.model, rec.calledAt, status, status === 'OK' ? side : null,
        o?.market ?? null, o?.selection ?? null, o?.line ?? null, o?.odds ?? null, o?.marketProbability ?? null,
        side && probabilities ? (probabilities[side] ?? null) : null, pick?.confidence ?? null,
        JSON.stringify(probabilities), JSON.stringify(predicates), JSON.stringify(rec.response), JSON.stringify(rec.response.usage),
      ],
    );
    n++;
  }
  console.log(`stored ${n} answers in decisions_shadow`);
}
await db.close();
