/**
 * Research, DRY-RUN ONLY: selection bias of OpenAI Decisions (gpt-6-luna) as a replacement for the ×3 vote.
 * Nothing is written to the database; production prompts, jobs and publishing are untouched. Separate process,
 * own token-rate limiter (well under the org's 2M TPM shared with production), hard budget cap.
 *
 *   npx tsx scripts/research/decisions-bias.ts [--exp A,B,C] [--set hist,v20] [--limit 0] [--budget 1]
 *        [--tpm 500000] [--workers 3] [--smoke] [--report-only]
 *
 * Datasets (identical snapshots for every experiment, the stored hybrid_decisions.input with its original
 * prediction_timestamp_utc; nothing after it is read, match results are NOT read at all):
 *   hist  the 260 settled DAILY decisions (prompt v1.6–v1.8) of the earlier replay
 *   v20   the DAILY decisions of prompt v2.0 with a live choice (status OK)
 * Experiments (configs frozen in CONFIGS; their text is hashed and saved):
 *   A  baseline: decisions-v1 unchanged (one choice + one predicate per option, descriptions carry the market's
 *      no-vig probability)
 *   B  market-blind choice descriptions: as A, the choice descriptions name the option only (team and line);
 *      the market stays in the evidence JSON
 *   C  separate markets: request 1 asks AH (FAVORITE / UNDERDOG / NO_PICK) and O/U (OVER / UNDER / NO_PICK)
 *      as two independent choices; request 2 passes both evaluations to the final choice among the valid options
 * Output: reports/decisions-bias/{configs,raw}/…, summary.json; distribution vs live, Jensen-Shannon divergence,
 * invalids, tokens, cost, latency, rate-limit retries.
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import OpenAI from 'openai';
import { HYBRID_SYSTEM_PROMPT, HYBRID_V20_GUIDE, userMessage } from '@fp/ai';
import type { HybridOption, HybridSide } from '@fp/analysis';
import { createPgDb } from '@fp/database';
import { loadDotEnvFile, loadEnv } from '@fp/shared';

const { values } = parseArgs({
  options: {
    exp: { type: 'string', default: 'A,B,C' },
    set: { type: 'string', default: 'hist,v20' },
    limit: { type: 'string', default: '0' },
    budget: { type: 'string', default: '1' },
    tpm: { type: 'string', default: '500000' },
    workers: { type: 'string', default: '3' },
    smoke: { type: 'boolean', default: false },
    'report-only': { type: 'boolean', default: false },
  },
});
const DIR = 'reports/decisions-bias';
const MODEL = 'gpt-6-luna';
const BUDGET = Number(values.budget);
const TPM = Number(values.tpm);
const TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 4;
// $ per 1M tokens (Decisions guide: uncached input $0.10, output free; cache rates of gpt-6-luna)
const PRICE = { input: 0.1, cached: 0.01, cacheWrite: 0.125 };

loadDotEnvFile();
const env = loadEnv();
if (!values['report-only'] && !env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is needed');
const db = createPgDb(env.DATABASE_URL!, { max: 2 });
const client = values['report-only'] ? null : new OpenAI({ apiKey: env.OPENAI_API_KEY!, timeout: TIMEOUT_MS, maxRetries: 0 });

// ---------------------------------------------------------------- datasets
type Cat = 'FAVORITE' | 'UNDERDOG' | 'OVER' | 'UNDER' | 'NO_PICK' | 'INVALID';
const CATS: Cat[] = ['FAVORITE', 'UNDERDOG', 'OVER', 'UNDER', 'NO_PICK', 'INVALID'];
interface Snap {
  set: 'hist' | 'v20';
  decisionId: number;
  fixtureId: number;
  match: string;
  promptVersion: string;
  input: Record<string, unknown>;
  inputHash: string;
  liveSide: Cat;
}
const sets = values.set!.split(',');
const rows = (
  await db.query<Record<string, unknown>>(
    `select distinct on (d.fixture_id) d.id, d.fixture_id, d.input, d.input_hash, d.prompt_version, d.side, d.status,
            th.name || ' v ' || ta.name match, f.status_short
       from hybrid_decisions d join fixtures f on f.id = d.fixture_id
       join teams th on th.id = f.home_team_id join teams ta on ta.id = f.away_team_id
      where d.engine_version = 'hybrid-ai-v1' and d.engine_mode = 'hybrid' and d.publish_round = 'DAILY' and d.status = 'OK'
      order by d.fixture_id, d.decided_at desc`,
  )
).rows;
// hist: exactly the 260 of the earlier replay (prompt < v2.0, finished) — the finished status selects the set only,
// no score is read; v20: every live v2.0 choice
const snaps: Snap[] = rows
  .map((r) => ({
    set: (String(r.prompt_version) === 'hybrid-ai-v2.0' ? 'v20' : 'hist') as Snap['set'],
    finished: ['FT', 'AET', 'PEN'].includes(String(r.status_short)),
    decisionId: Number(r.id),
    fixtureId: Number(r.fixture_id),
    match: String(r.match),
    promptVersion: String(r.prompt_version),
    input: r.input as Record<string, unknown>,
    inputHash: String(r.input_hash),
    liveSide: String(r.side) as Cat,
  }))
  .filter((s) => (s.set === 'hist' ? s.finished : true) && optionsOf(s.input).length > 0 && sets.includes(s.set))
  .sort((a, b) => a.decisionId - b.decisionId)
  .slice(0, Number(values.limit) > 0 ? Number(values.limit) : undefined)
  .map(({ finished: _f, ...s }) => s);

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

// ---------------------------------------------------------------- frozen experiment configs
const BASE_GUIDE = HYBRID_SYSTEM_PROMPT.split('\n\nOutput rules:')[0]!;
// experiment D (diagnostic only): the guide without the v1.9 Over/Under paragraph (ADR 0019 amendment 2)
const OU_RULE_V19 = BASE_GUIDE.match(/An Over or Under choice needs more than recent goal counts\.[^\n]*\n\n/)?.[0];
if (!OU_RULE_V19) throw new Error('v1.9 Over/Under paragraph not found in the guide');
// experiment R: the owner's rewritten O/U rule (2026-11-16) in place of the v1.9 paragraph, text exactly as given
const OU_RULE_R1 = `### O/U Evidence and Selection Rule

Evaluate the Over/Under market independently from the Asian Handicap market.

Over/Under selections must be supported by relevant goal-scoring evidence, including available xG and/or npxG trends from both teams. Consider recent performance, home/away context, opponent strength, and the consistency of the evidence.

- Select **OVER** when the combined evidence supports a higher-than-market goal expectation.
- Select **UNDER** when the combined evidence supports a lower-than-market goal expectation.
- Select **NO_PICK** when the available evidence is insufficient, inconsistent, or does not establish a meaningful advantage over the market.

The absence of sufficient Over/Under evidence does NOT imply that an Asian Handicap selection is preferable.

Evaluate Asian Handicap and Over/Under independently. Compare only valid market options provided in the input, and select the option with the strongest evidence. If no option has sufficient support, choose NO_PICK.

Do not force an Over/Under selection to meet a target distribution or to increase the number of published picks.

`;
const guideFor = (input: Record<string, unknown>, exp = 'A') => {
  const g = 'elo_ratings' in input ? BASE_GUIDE : BASE_GUIDE.replace(`${HYBRID_V20_GUIDE}\n\n`, '');
  return exp === 'D' ? g.replace(OU_RULE_V19, '') : exp === 'R' ? g.replace(OU_RULE_V19, OU_RULE_R1) : g;
};
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
const AH_INSTR =
  'As the analyst described above, considering the Asian handicap market only: does either side at the main line have evidence that the market price may not reflect? Choose NO_PICK when the information is insufficient or neither side can be justified; no pick is a correct, common answer. Do not automatically favour the underdog or the favourite.';
const OU_INSTR =
  'As the analyst described above, considering the over/under market only: does Over or Under at the main line have evidence that the market price may not reflect? Choose NO_PICK when the information is insufficient or neither can be justified; no pick is a correct, common answer. Do not automatically favour Over or Under.';
const FINAL_INSTR =
  'As the analyst described above, and weighing the two separate market evaluations given: which one choice has the strongest evidence that the market price may not reflect? Either market may be chosen, or neither. Choose NO_PICK when the information is insufficient or no option can be justified; no pick is a correct, common answer. Do not automatically favour the underdog, the favourite, Over or Under.';
const PRED_INSTR = (d: string) => `Using only the match data, estimate the chance that this option comes out ahead at its line on the 90-minute score (a win or a half win; a push does not count either way): ${d}.`;

type Questions = OpenAI.DecisionCreateParams['questions'];
const predicates = (s: Snap): Questions => optionsOf(s.input).map((o) => ({ type: 'predicate' as const, name: `wins_${o.side}`, instructions: PRED_INSTR(describe(o, s.input, true)) }));
const pickQuestion = (s: Snap, withMarket: boolean, instructions = PICK_INSTR): Questions[number] => ({
  type: 'choice',
  name: 'pick',
  instructions,
  choices: [...optionsOf(s.input).map((o) => ({ value: o.side, description: describe(o, s.input, withMarket) })), { value: 'NO_PICK', description: NO_PICK_DESC }],
});
const marketQuestion = (s: Snap, market: 'ASIAN_HANDICAP' | 'OVER_UNDER'): Questions[number] | null => {
  const opts = optionsOf(s.input).filter((o) => o.market === market);
  if (!opts.length) return null;
  return {
    type: 'choice',
    name: market === 'ASIAN_HANDICAP' ? 'ah' : 'ou',
    instructions: market === 'ASIAN_HANDICAP' ? AH_INSTR : OU_INSTR,
    choices: [...opts.map((o) => ({ value: o.side, description: describe(o, s.input, true) })), { value: 'NO_PICK', description: NO_PICK_DESC }],
  };
};
const evaluationsText = (ev: Record<string, Record<string, number>>) => {
  const line = (name: string, label: string) => {
    const p = ev[name];
    if (!p) return `${label}: no options in this market (no usable main line).`;
    return `${label}: ${Object.entries(p).map(([k, v]) => `${k} ${v}`).join(', ')}`;
  };
  return `Separate market evaluations from an earlier step (probability that each choice has the strongest evidence within its own market; each market was judged alone):\n${line('ah', 'Asian handicap')}\n${line('ou', 'Over/under')}`;
};

interface Config {
  id: string;
  description: string;
  requests: number;
}
const CONFIGS: Record<string, Config> = {
  A: { id: 'decisions-bias-A-v1', description: 'baseline decisions-v1: choice among valid options + NO_PICK with market no-vig probability in each description; one predicate per option', requests: 1 },
  B: { id: 'decisions-bias-B-v1', description: 'as A, choice descriptions market-blind (option, team, line only); predicates as A; market data stays in the evidence JSON', requests: 1 },
  C: { id: 'decisions-bias-C-v1', description: 'request 1: AH choice (FAVORITE/UNDERDOG/NO_PICK) and O/U choice (OVER/UNDER/NO_PICK) judged separately, + predicates as A; request 2: both evaluations passed as text, final choice among valid options + NO_PICK (descriptions as A)', requests: 2 },
  D: { id: 'decisions-bias-D-v1', description: 'DIAGNOSTIC: as B (market-blind choice descriptions, predicates as A), the guide without the v1.9 Over/Under paragraph; not a production candidate', requests: 1 },
  R: { id: 'decisions-bias-R-v1', description: "as B (market-blind choice descriptions, predicates as A), the v1.9 Over/Under paragraph replaced by the owner's rewritten O/U rule (OU_RULE_R1, 2026-11-16)", requests: 1 },
};
const configText = {
  guideSha256: createHash('sha256').update(BASE_GUIDE).digest('hex'),
  ouRuleV19Sha256: createHash('sha256').update(OU_RULE_V19).digest('hex'),
  ouRuleR1Sha256: createHash('sha256').update(OU_RULE_R1).digest('hex'),
  v20GuideSha256: createHash('sha256').update(HYBRID_V20_GUIDE).digest('hex'),
  PICK_INSTR, NO_PICK_DESC, AH_INSTR, OU_INSTR, FINAL_INSTR, PRED_INSTR: PRED_INSTR('<option>'),
  model: MODEL, sampling: 'none exposed by the Decisions API (no temperature/seed parameters)',
};

// ---------------------------------------------------------------- calls: token-rate limiter, budget, retries, raw log
interface Usage { input: number; cached: number; cacheWrite: number; output: number }
const spent = { usd: 0, calls: 0, retries429: 0, errors: 0, tokens: { input: 0, cached: 0, cacheWrite: 0, output: 0 } as Usage };
const latencies: Record<string, number[]> = {};
const window: Array<{ t: number; tokens: number }> = [];
let budgetHit = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const costOf = (u: Usage) => ((u.input - u.cached - u.cacheWrite) * PRICE.input + u.cached * PRICE.cached + u.cacheWrite * PRICE.cacheWrite) / 1e6;

async function throttle(estimate: number) {
  for (;;) {
    const now = Date.now();
    while (window.length && now - window[0]!.t > 60_000) window.shift();
    if (window.reduce((s, w) => s + w.tokens, 0) + estimate <= TPM) {
      window.push({ t: now, tokens: estimate });
      return;
    }
    await sleep(500);
  }
}

async function call(exp: string, s: Snap, step: string, body: OpenAI.DecisionCreateParams) {
  const payload = JSON.stringify(body);
  const estimate = Math.ceil(payload.length / 3);
  // projected cost of this call at the uncached rate keeps the cap hard
  if (spent.usd + (estimate * PRICE.input) / 1e6 > BUDGET) {
    budgetHit = true;
    throw new Error('budget cap');
  }
  for (let attempt = 1; ; attempt++) {
    await throttle(estimate);
    const t0 = Date.now();
    try {
      const res = await client!.decisions.create(body);
      const ms = Date.now() - t0;
      (latencies[exp] ??= []).push(ms);
      const u: Usage = { input: res.usage.input_tokens, cached: res.usage.input_tokens_details?.cached_tokens ?? 0, cacheWrite: res.usage.input_tokens_details?.cache_write_tokens ?? 0, output: res.usage.output_tokens };
      spent.calls++;
      spent.usd += costOf(u);
      for (const k of Object.keys(u) as Array<keyof Usage>) spent.tokens[k] += u[k];
      await appendFile(`${DIR}/raw/${exp}.jsonl`, JSON.stringify({ config: CONFIGS[exp]!.id, set: s.set, decisionId: s.decisionId, fixtureId: s.fixtureId, step, attempt, latencyMs: ms, storedInputHash: s.inputHash, payloadSha256: createHash('sha256').update(payload).digest('hex'), questions: body.questions, response: res }) + '\n');
      return res;
    } catch (err) {
      const is429 = err instanceof OpenAI.RateLimitError && err.code !== 'insufficient_quota';
      const transient = is429 || err instanceof OpenAI.APIConnectionTimeoutError || err instanceof OpenAI.InternalServerError || err instanceof OpenAI.APIConnectionError;
      if (is429) spent.retries429++;
      if (!transient || attempt >= MAX_ATTEMPTS) {
        spent.errors++;
        throw err;
      }
      await sleep(1000 * 2 ** attempt);
    }
  }
}

const userInput = (s: Snap, exp: string, extra?: string): OpenAI.DecisionCreateParams['input'] => [
  { role: 'user', content: [{ type: 'input_text', text: guideFor(s.input, exp) }, { type: 'input_text', text: userMessage(s.input) }, ...(extra ? [{ type: 'input_text' as const, text: extra }] : [])] },
];
type Res = Awaited<ReturnType<typeof call>>;
const choiceOf = (res: Res, name: string) => {
  const a = res.answers.find((x) => x.name === name);
  return a && a.type === 'choice' ? { choice: String(a.choice), confidence: a.confidence, p: Object.fromEntries(a.probabilities.map((x) => [String(x.value), x.probability])) } : null;
};

interface Result {
  exp: string;
  set: Snap['set'];
  decisionId: number;
  cat: Cat;
  invalid: null | 'REFUSED' | 'NOT_A_CANDIDATE' | 'ERROR';
  p: Record<string, number> | null;
  confidence: number | null;
  steps?: Record<string, unknown>;
}

async function runOne(exp: string, s: Snap): Promise<Result> {
  const valid = new Set([...optionsOf(s.input).map((o) => o.side), 'NO_PICK']);
  const fin = (c: ReturnType<typeof choiceOf>, steps?: Record<string, unknown>): Result => {
    if (!c) return { exp, set: s.set, decisionId: s.decisionId, cat: 'INVALID', invalid: 'REFUSED', p: null, confidence: null, steps };
    if (!valid.has(c.choice)) return { exp, set: s.set, decisionId: s.decisionId, cat: 'INVALID', invalid: 'NOT_A_CANDIDATE', p: c.p, confidence: c.confidence, steps };
    return { exp, set: s.set, decisionId: s.decisionId, cat: c.choice as Cat, invalid: null, p: c.p, confidence: c.confidence, steps };
  };
  if (exp === 'A' || exp === 'B' || exp === 'D' || exp === 'R') {
    const res = await call(exp, s, 'final', { model: MODEL, input: userInput(s, exp), questions: [pickQuestion(s, exp === 'A'), ...predicates(s)] });
    return fin(choiceOf(res, 'pick'));
  }
  // C
  const qs = [marketQuestion(s, 'ASIAN_HANDICAP'), marketQuestion(s, 'OVER_UNDER')].filter((q): q is NonNullable<typeof q> => q !== null);
  const r1 = await call(exp, s, 'markets', { model: MODEL, input: userInput(s, exp), questions: [...qs, ...predicates(s)] });
  const ev: Record<string, Record<string, number>> = {};
  const steps: Record<string, unknown> = {};
  for (const name of ['ah', 'ou']) {
    const c = choiceOf(r1, name);
    if (c) {
      ev[name] = c.p;
      steps[name] = c.choice;
    } else if (qs.some((q) => q.name === name)) steps[name] = 'REFUSED';
  }
  const r2 = await call(exp, s, 'final', { model: MODEL, input: userInput(s, exp, evaluationsText(ev)), questions: [pickQuestion(s, true, FINAL_INSTR)] });
  return fin(choiceOf(r2, 'pick'), steps);
}

// ---------------------------------------------------------------- run (cached per config + decision)
await mkdir(`${DIR}/raw`, { recursive: true });
await mkdir(`${DIR}/configs`, { recursive: true });
const RESULTS = `${DIR}/results.jsonl`;
const results = new Map<string, Result>();
try {
  for (const l of (await readFile(RESULTS, 'utf8')).split('\n')) if (l.trim()) {
    const r = JSON.parse(l) as Result & { config: string };
    results.set(`${r.config}|${r.decisionId}`, r);
  }
} catch { /* first run */ }
const exps = values.exp!.split(',');
// every call ever made is in raw/<exp>.jsonl: cost, tokens and latency are counted from there (a resumed run
// keeps the budget of the earlier ones)
async function rawStats() {
  const out: Record<string, { calls: number; usd: number; tokens: Usage; latency: number[]; retried: number }> = {};
  for (const e of Object.keys(CONFIGS)) {
    let text = '';
    try { text = await readFile(`${DIR}/raw/${e}.jsonl`, 'utf8'); } catch { continue; }
    const s = (out[e] = { calls: 0, usd: 0, tokens: { input: 0, cached: 0, cacheWrite: 0, output: 0 }, latency: [] as number[], retried: 0 });
    for (const l of text.split('\n')) if (l.trim()) {
      const x = JSON.parse(l) as { latencyMs: number; attempt: number; response: { usage: { input_tokens: number; output_tokens: number; input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } } } };
      const u: Usage = { input: x.response.usage.input_tokens, cached: x.response.usage.input_tokens_details?.cached_tokens ?? 0, cacheWrite: x.response.usage.input_tokens_details?.cache_write_tokens ?? 0, output: x.response.usage.output_tokens };
      s.calls++;
      s.usd += costOf(u);
      for (const k of Object.keys(u) as Array<keyof Usage>) s.tokens[k] += u[k];
      s.latency.push(x.latencyMs);
      if (x.attempt > 1) s.retried++;
    }
  }
  return out;
}
spent.usd = Object.values(await rawStats()).reduce((a, s) => a + s.usd, 0);
for (const e of exps) await writeFile(`${DIR}/configs/${CONFIGS[e]!.id}.json`, JSON.stringify({ ...CONFIGS[e], ...configText }, null, 2));

if (values.smoke) {
  const s = snaps.find((x) => x.set === 'v20') ?? snaps[0]!;
  for (const e of exps) console.log(e, s.match, JSON.stringify(await runOne(e, s)));
  console.log(`smoke: ${spent.calls} calls · $${spent.usd.toFixed(4)} · tokens ${JSON.stringify(spent.tokens)}`);
  await db.close();
  process.exit(0);
}

if (!values['report-only']) {
  // snapshot by snapshot (v20 first), every experiment on it: a budget stop leaves all experiments on the same matches
  const order = [...snaps.filter((s) => s.set === "v20"), ...snaps.filter((s) => s.set === "hist")];
  const todo = order.flatMap((s) => exps.filter((e) => !results.has(`${CONFIGS[e]!.id}|${s.decisionId}`)).map((e) => ({ e, s })));
  console.log(`${snaps.length} snapshots (${snaps.filter((s) => s.set === 'hist').length} hist, ${snaps.filter((s) => s.set === 'v20').length} v20) · experiments ${exps.join(',')} · ${todo.length} to run · budget $${BUDGET} · ${TPM} TPM · ${values.workers} workers`);
  const started = Date.now();
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Number(values.workers) }, async () => {
      while (!budgetHit && next < todo.length) {
        const { e, s } = todo[next++]!;
        let r: Result;
        try {
          r = await runOne(e, s);
        } catch (err) {
          if (budgetHit) break;
          console.log(`  ERROR ${e} ${s.decisionId}: ${String(err).slice(0, 160)}`);
          r = { exp: e, set: s.set, decisionId: s.decisionId, cat: 'INVALID', invalid: 'ERROR', p: null, confidence: null };
          if (err instanceof OpenAI.AuthenticationError || (err instanceof OpenAI.RateLimitError && err.code === 'insufficient_quota')) budgetHit = true;
        }
        if (r.invalid !== 'ERROR') {
          results.set(`${CONFIGS[e]!.id}|${s.decisionId}`, r);
          await appendFile(RESULTS, JSON.stringify({ ...r, config: CONFIGS[e]!.id }) + '\n');
        }
        if (++done % 50 === 0) console.log(`  ${done}/${todo.length} · ${((Date.now() - started) / 60_000).toFixed(1)} min · $${spent.usd.toFixed(3)}`);
      }
    }),
  );
  if (budgetHit) console.log(`STOPPED: budget cap $${BUDGET} reached or the API refused (spent $${spent.usd.toFixed(3)})`);
}

// ---------------------------------------------------------------- report
const dist = (cats: Cat[]) => Object.fromEntries(CATS.map((c) => [c, cats.filter((x) => x === c).length])) as Record<Cat, number>;
function jsd(p: Record<string, number>, q: Record<string, number>): number {
  const keys = [...new Set([...Object.keys(p), ...Object.keys(q)])];
  const np = Object.values(p).reduce((a, b) => a + b, 0) || 1;
  const nq = Object.values(q).reduce((a, b) => a + b, 0) || 1;
  const kl = (a: number[], m: number[]) => a.reduce((s, x, i) => (x > 0 ? s + x * Math.log2(x / m[i]!) : s), 0);
  const P = keys.map((k) => (p[k] ?? 0) / np);
  const Q = keys.map((k) => (q[k] ?? 0) / nq);
  const M = P.map((x, i) => (x + Q[i]!) / 2);
  return 0.5 * kl(P, M) + 0.5 * kl(Q, M);
}
const fmt = (d: Record<string, number>) => {
  const n = Object.values(d).reduce((a, b) => a + b, 0);
  return Object.fromEntries(Object.entries(d).map(([k, v]) => [k, `${v} (${n ? ((100 * v) / n).toFixed(1) : '0.0'}%)`]));
};
const pct = (xs: number[], q: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]! : null);

const summary: Record<string, unknown> = { generatedAt: new Date().toISOString(), configs: Object.fromEntries(exps.map((e) => [e, CONFIGS[e]!.id])), sets: {} };
for (const set of ['hist', 'v20'] as const) {
  const ss = snaps.filter((s) => s.set === set);
  if (!ss.length) continue;
  const live = dist(ss.map((s) => s.liveSide));
  const liveM = { AH: live.FAVORITE + live.UNDERDOG, OU: live.OVER + live.UNDER, NONE: live.NO_PICK, INVALID: 0 };
  const table: Array<Record<string, unknown>> = [{ source: 'live ×3', n: ss.length, ...fmt(live), 'AH/OU/NONE': `${liveM.AH}/${liveM.OU}/${liveM.NONE}`, JSD: '-', 'JSD market': '-' }];
  const per: Record<string, unknown> = { live };
  for (const e of exps) {
    const rs = ss.map((s) => results.get(`${CONFIGS[e]!.id}|${s.decisionId}`));
    const answered = rs.filter((r): r is Result => !!r);
    const d = dist(answered.map((r) => r.cat));
    const m = { AH: d.FAVORITE + d.UNDERDOG, OU: d.OVER + d.UNDER, NONE: d.NO_PICK, INVALID: d.INVALID };
    table.push({ source: e, n: `${answered.length}/${ss.length}`, ...fmt(d), 'AH/OU/NONE': `${m.AH}/${m.OU}/${m.NONE}`, JSD: +jsd(d, live).toFixed(4), 'JSD market': +jsd(m, liveM).toFixed(4) });
    const sameAsLive = answered.filter((r) => r.cat === ss.find((s) => s.decisionId === r.decisionId)!.liveSide).length;
    const invalid = { refused: answered.filter((r) => r.invalid === 'REFUSED').length, notACandidate: answered.filter((r) => r.invalid === 'NOT_A_CANDIDATE').length, missing: ss.length - answered.length };
    // diagnostics: mean probability per option, and the favourite share by handicap size (no results read)
    const meanP = Object.fromEntries(['FAVORITE', 'UNDERDOG', 'OVER', 'UNDER', 'NO_PICK'].map((k) => [k, +(answered.reduce((a, r) => a + (r.p?.[k] ?? 0), 0) / Math.max(1, answered.length)).toFixed(3)]));
    const ouAvailable = answered.filter((r) => optionsOf(ss.find((s) => s.decisionId === r.decisionId)!.input).some((o) => o.market === 'OVER_UNDER'));
    const maxOu = Math.max(0, ...answered.map((r) => Math.max(r.p?.OVER ?? 0, r.p?.UNDER ?? 0)));
    const byLine: Record<string, string> = {};
    for (const [label, lo, hi] of [['|line| ≤ 0.5', 0, 0.5], ['0.75–1.25', 0.75, 1.25], ['≥ 1.5', 1.5, 99]] as const) {
      const xs = answered.filter((r) => {
        const fav = optionsOf(ss.find((s) => s.decisionId === r.decisionId)!.input).find((o) => o.side === 'FAVORITE');
        return fav && Math.abs(fav.line) >= lo && Math.abs(fav.line) <= hi;
      });
      byLine[label] = `${xs.filter((r) => r.cat === 'FAVORITE').length}/${xs.length} favourite`;
    }
    const stepC = e === 'C' ? { ah: dist(answered.map((r) => (r.steps?.ah as Cat) ?? 'INVALID')), ou: dist(answered.map((r) => (r.steps?.ou as Cat) ?? 'INVALID')) } : undefined;
    per[e] = { dist: d, market: m, jsd: jsd(d, live), jsdMarket: jsd(m, liveM), sameAsLive, invalid, meanP, ouAvailable: ouAvailable.length, maxOuProbability: maxOu, favouriteByLine: byLine, stepC };
  }
  (summary.sets as Record<string, unknown>)[set] = per;
  console.log(`\n=== ${set} (${ss.length} matches) ===`);
  console.table(table);
  for (const e of exps) {
    const x = per[e] as Record<string, unknown>;
    console.log(`${e}: same as live ${x.sameAsLive}/${ss.length} · invalid ${JSON.stringify(x.invalid)} · mean p ${JSON.stringify(x.meanP)} · O/U offered ${x.ouAvailable} · max p(O/U) ${(x.maxOuProbability as number).toFixed(2)} · favourite by line ${JSON.stringify(x.favouriteByLine)}`);
    if (x.stepC) console.log(`   C step 1: AH ${JSON.stringify(fmt((x.stepC as { ah: Record<string, number> }).ah))} · OU ${JSON.stringify(fmt((x.stepC as { ou: Record<string, number> }).ou))}`);
  }
}
const all = await rawStats();
const perExp = Object.fromEntries(
  Object.entries(all).map(([e, s]) => [e, { calls: s.calls, usd: +s.usd.toFixed(4), tokens: s.tokens, retriedCalls: s.retried, latencyMs: { p50: pct(s.latency, 0.5), p95: pct(s.latency, 0.95), max: Math.max(...s.latency) } }]),
);
summary.cost = { perExperiment: perExp, totalUsd: +Object.values(all).reduce((a, s) => a + s.usd, 0).toFixed(4), prices: PRICE };
summary.thisRun = { calls: spent.calls, retries429: spent.retries429, errors: spent.errors, latencyMs: Object.fromEntries(Object.entries(latencies).map(([e, xs]) => [e, { p50: pct(xs, 0.5), p95: pct(xs, 0.95) }])), tpmLimit: TPM, workers: Number(values.workers), budget: BUDGET, budgetHit };
console.log('\nCost, tokens and latency per experiment (all calls in raw/):');
console.table(Object.entries(perExp).map(([e, x]) => ({ exp: e, calls: x.calls, usd: x.usd, input: x.tokens.input, cached: x.tokens.cached, cacheWrite: x.tokens.cacheWrite, output: x.tokens.output, retried: x.retriedCalls, p50: x.latencyMs.p50, p95: x.latencyMs.p95, max: x.latencyMs.max })));
console.log(`This run: ${spent.calls} calls · 429 retries ${spent.retries429} · errors ${spent.errors} · total spent $${(summary.cost as { totalUsd: number }).totalUsd}`);
await writeFile(`${DIR}/summary.json`, JSON.stringify(summary, null, 2));
await db.close();
