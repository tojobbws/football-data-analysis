/**
 * Research, DRY-RUN ONLY (ADR 0021): replay Hybrid AI v2.1 against the locked v2.0 pipeline on the stored inputs of
 *   G1  the 16 decisions that ended INVALID
 *   G2  the 82 decisions that ended OK only after a rejected attempt (retry cases)
 * from the audit of 16 Nov 2026. Writes NOTHING to the database, publishes nothing, reads no match result.
 *
 *   npx tsx scripts/research/hybrid-v21-replay.ts [--arms control,v21] [--groups G1,G2] [--limit 0] [--budget 3]
 *        [--workers 2] [--tpm 400000] [--smoke] [--report-only]
 *
 * Arms, on the same stored input and the same market candidates (options rebuilt from the stored input):
 *   control  production v2.0 as it is: HYBRID_SYSTEM_PROMPT, the stored input, a retry re-asks the same request
 *   v21      HYBRID_SYSTEM_PROMPT_V21, withAggregatesV21(stored input), a retry sends the located violations
 * Both: gpt-6-luna, HYBRID_VOTES answers, HYBRID_MAX_ATTEMPTS attempts each, validateHybridOutput (the number guard
 * with the thousands-separator fix), the majority rule of combineVotes. Inputs older than v2.0 get the prompt without
 * the v2.0 guide in both arms (as in the earlier replays).
 * Output: reports/hybrid-v21/{raw-<arm>.jsonl, answers.jsonl, summary.json}.
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import OpenAI from 'openai';
import {
  allowedNumbers,
  buildHybridSystemPromptV21,
  buildHybridSystemPromptV211,
  prepareHybridInputV211,
  validateHybridOutputV211,
  createOpenAIHybridDeciderV21,
  createOpenAIStructuredCall,
  HYBRID_MAX_ATTEMPTS,
  HYBRID_OUTPUT_SCHEMA,
  HYBRID_SYSTEM_PROMPT,
  HYBRID_V20_GUIDE,
  HYBRID_VOTES,
  locateViolations,
  majorityVote,
  retryFeedbackV21,
  validateHybridOutput,
  withAggregatesV21,
  type LocatedViolation,
  type RankerResult,
} from '@fp/ai';
import type { HybridOption, HybridSide } from '@fp/analysis';
import { createPgDb } from '@fp/database';
import { loadDotEnvFile, loadEnv } from '@fp/shared';

const { values } = parseArgs({
  options: {
    arms: { type: 'string', default: 'control,v21' },
    groups: { type: 'string', default: 'G1,G2' },
    limit: { type: 'string', default: '0' },
    budget: { type: 'string', default: '3' },
    workers: { type: 'string', default: '2' },
    tpm: { type: 'string', default: '400000' },
    smoke: { type: 'boolean', default: false },
    'report-only': { type: 'boolean', default: false },
  },
});
const DIR = 'reports/hybrid-v21';
const MODEL = 'gpt-6-luna';
const BUDGET = Number(values.budget);
const TPM = Number(values.tpm);
// $ per 1M tokens, gpt-6-luna (OpenAI pricing page as read on 16 Nov 2026: input 0.10, cached input 0.01, output 0.50)
const PRICE = { input: 0.1, cached: 0.01, output: 0.5 };

loadDotEnvFile();
const env = loadEnv();
if (!values['report-only'] && !env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is needed');
const db = createPgDb(env.DATABASE_URL!, { max: 2 });

// ---------------------------------------------------------------- the two groups of the audit
interface Decision {
  group: 'G1' | 'G2';
  rowId: number;
  fixtureId: number;
  match: string;
  prompt: string;
  input: Record<string, unknown>;
  inputHash: string;
  liveStatus: string;
  liveSide: string | null;
  liveAttempts: number;
}
const groups = values.groups!.split(',');
const decisions: Decision[] = (
  await db.query<Record<string, unknown>>(
    `select d.id, d.fixture_id, d.prompt_version, d.status, d.side, d.attempts, d.input, d.input_hash, th.name || ' v ' || ta.name match
       from hybrid_decisions d join fixtures f on f.id = d.fixture_id
       join teams th on th.id = f.home_team_id join teams ta on ta.id = f.away_team_id
      where d.engine_version = 'hybrid-ai-v1' and (d.status <> 'OK' or jsonb_array_length(d.violations) > 0)
      order by d.id`,
  )
).rows
  .map((r) => ({
    group: (String(r.status) === 'OK' ? 'G2' : 'G1') as Decision['group'],
    rowId: Number(r.id),
    fixtureId: Number(r.fixture_id),
    match: String(r.match),
    prompt: String(r.prompt_version),
    input: r.input as Record<string, unknown>,
    inputHash: String(r.input_hash),
    liveStatus: String(r.status),
    liveSide: (r.side as string) ?? null,
    liveAttempts: Number(r.attempts),
  }))
  .filter((d) => groups.includes(d.group))
  .slice(0, Number(values.limit) > 0 ? Number(values.limit) : undefined);

function optionsOf(input: Record<string, unknown>): HybridOption[] {
  const m = (input.market ?? {}) as Record<string, { options?: Array<Record<string, unknown>> }>;
  const home = (input.match as { home: string }).home;
  const out: HybridOption[] = [];
  for (const o of m.asian_handicap?.options ?? [])
    out.push({ side: o.option as HybridSide, market: 'ASIAN_HANDICAP', selection: o.team_or_total === home ? 'HOME' : 'AWAY', line: Number(o.line), odds: Number(o.odds_median), marketProbability: Number(o.market_probability_no_vig) });
  for (const o of m.over_under?.options ?? [])
    out.push({ side: o.option as HybridSide, market: 'OVER_UNDER', selection: String(o.team_or_total), line: Number(o.line), odds: Number(o.odds_median), marketProbability: Number(o.market_probability_no_vig) });
  return out;
}

// ---------------------------------------------------------------- arms
const controlPrompt = (input: Record<string, unknown>) => ('elo_ratings' in input ? HYBRID_SYSTEM_PROMPT : HYBRID_SYSTEM_PROMPT.replace(`${HYBRID_V20_GUIDE}\n\n`, ''));
// v211 = the production v2.1.1 path: the cut-off check, the totals with counts, the v2.1.1 prompt and validator
const armInput = (arm: string, d: Decision) => (arm.startsWith('v211') ? prepareHybridInputV211(d.input).input : arm === 'v21' ? withAggregatesV21(d.input) : d.input);
const armPrompt = (arm: string, d: Decision) => (arm.startsWith('v211') ? buildHybridSystemPromptV211(controlPrompt(d.input)) : arm === 'v21' ? buildHybridSystemPromptV21(controlPrompt(d.input)) : controlPrompt(d.input));
const sha = (x: unknown) => createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');

// ---------------------------------------------------------------- calls: TPM limiter, budget, raw log
const spent = { usd: 0, calls: 0, errors: 0, rateLimited: 0 };
const window: Array<{ t: number; tokens: number }> = [];
let stop = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function throttle(estimate: number) {
  for (;;) {
    const now = Date.now();
    while (window.length && now - window[0]!.t > 60_000) window.shift();
    if (window.reduce((s, w) => s + w.tokens, 0) + estimate <= TPM) return void window.push({ t: now, tokens: estimate });
    await sleep(500);
  }
}
const costOf = (u: Record<string, unknown>) => {
  const input = Number(u.input_tokens ?? 0);
  const cached = Number((u.input_tokens_details as { cached_tokens?: number } | undefined)?.cached_tokens ?? 0);
  const output = Number(u.output_tokens ?? 0);
  return ((input - cached) * PRICE.input + cached * PRICE.cached + output * PRICE.output) / 1e6;
};
// the cap keeps a reserve for every call in flight (budget stop leaves no overshoot)
const IN_FLIGHT_RESERVE = 0.01;
let inFlight = 0;

async function guarded(arm: string, d: Decision, answer: number, attempt: number, kind: 'ask' | 'retry', fn: () => Promise<RankerResult>, payload: unknown) {
  if (stop || spent.usd + (inFlight + 1) * IN_FLIGHT_RESERVE > BUDGET) {
    stop = true;
    throw new Error('budget cap');
  }
  inFlight++;
  try {
    for (let tryNo = 1; ; tryNo++) {
      await throttle(Math.ceil(JSON.stringify(payload).length / 3) + 4000);
      const t0 = Date.now();
      try {
        const res = await fn();
        const ms = Date.now() - t0;
        spent.calls++;
        spent.usd += costOf(res.usage ?? {});
        await appendFile(`${DIR}/raw-${arm}.jsonl`, JSON.stringify({ arm, group: d.group, rowId: d.rowId, answer, attempt, kind, latencyMs: ms, usage: res.usage, model: res.model, stopReason: res.stopReason, refusal: res.refusal, output: res.output }) + '\n');
        return { res, ms };
      } catch (err) {
        // "429 You have no credits remaining" comes without code insufficient_quota: stop the run, never retry it
        const noCredit = err instanceof OpenAI.RateLimitError && (err.code === 'insufficient_quota' || /no credits|quota/i.test(String(err.message)));
        if (noCredit) stop = true;
        const is429 = err instanceof OpenAI.RateLimitError && !noCredit;
        if (is429) spent.rateLimited++;
        await appendFile(`${DIR}/errors.log`, `${new Date().toISOString()} ${arm} ${d.rowId} a${answer} t${attempt}: ${String(err).slice(0, 400)}
`);
        if ((is429 || err instanceof OpenAI.APIConnectionTimeoutError || err instanceof OpenAI.InternalServerError) && tryNo < 3) {
          await sleep(2000 * 2 ** tryNo);
          continue;
        }
        spent.errors++;
        if (err instanceof OpenAI.AuthenticationError || (err instanceof OpenAI.RateLimitError && err.code === 'insufficient_quota')) stop = true;
        throw err;
      }
    }
  } finally {
    inFlight--;
  }
}

interface Attempt { attempt: number; kind: 'ask' | 'retry'; status: 'OK' | 'INVALID' | 'REFUSED' | 'UNPARSEABLE'; side: string | null; violations: LocatedViolation[]; latencyMs: number; feedback?: string }
interface AnswerRec { arm: string; group: string; rowId: number; answer: number; attempts: Attempt[]; final: 'OK' | 'INVALID' | 'REFUSED' | 'ERROR'; side: string | null; output: unknown; inputSha256: string; storedInputHash: string; promptSha256: string }

const control = (system: string) => createOpenAIStructuredCall({ apiKey: env.OPENAI_API_KEY!, model: MODEL, system, schemaName: 'hybrid_decision', schema: HYBRID_OUTPUT_SCHEMA as unknown as Record<string, unknown> });

async function answerOnce(arm: string, d: Decision, answer: number): Promise<AnswerRec> {
  const input = armInput(arm, d);
  const options = optionsOf(d.input); // the original market candidates, unchanged
  const system = armPrompt(arm, d);
  const v21 = arm === 'v21' || arm.startsWith('v211') ? createOpenAIHybridDeciderV21({ apiKey: env.OPENAI_API_KEY!, model: MODEL, system, timeoutMs: 150_000 }) : null;
  const ask = v21 ? null : control(system);
  const rec: AnswerRec = { arm, group: d.group, rowId: d.rowId, answer, attempts: [], final: 'INVALID', side: null, output: null, inputSha256: sha(input), storedInputHash: d.inputHash, promptSha256: sha(system) };
  let previous: unknown = null;
  let feedback: string | null = null;
  for (let attempt = 1; attempt <= HYBRID_MAX_ATTEMPTS; attempt++) {
    const kind = v21 && feedback && previous ? 'retry' : 'ask';
    let r: { res: RankerResult; ms: number };
    try {
      r = await guarded(arm, d, answer, attempt, kind, () => (v21 ? (kind === 'retry' ? v21.retry(input, previous, feedback!) : v21.decide(input)) : ask!(input)), input);
    } catch (err) {
      rec.final = 'ERROR';
      rec.attempts.push({ attempt, kind, status: 'INVALID', side: null, violations: [{ kind: 'OTHER', value: String(err).slice(0, 160), field: null, excerpt: null }], latencyMs: 0 });
      return rec;
    }
    if (r.res.refusal) {
      rec.attempts.push({ attempt, kind, status: 'REFUSED', side: null, violations: [], latencyMs: r.ms });
      rec.final = 'REFUSED';
      return rec;
    }
    if (r.res.output === null) {
      rec.attempts.push({ attempt, kind, status: 'UNPARSEABLE', side: null, violations: [], latencyMs: r.ms });
      feedback = null;
      continue;
    }
    const v = arm.startsWith('v211') ? validateHybridOutputV211(r.res.output, input, options) : validateHybridOutput(r.res.output, input, options);
    if (v.ok && v.decision) {
      rec.attempts.push({ attempt, kind, status: 'OK', side: v.decision.side, violations: [], latencyMs: r.ms, ...(kind === 'retry' ? { feedback: feedback! } : {}) });
      return { ...rec, final: 'OK', side: v.decision.side, output: r.res.output };
    }
    const located = locateViolations(r.res.output, input, options, { averageCounts: arm.startsWith('v211') });
    rec.attempts.push({ attempt, kind, status: 'INVALID', side: null, violations: located, latencyMs: r.ms, ...(kind === 'retry' ? { feedback: feedback! } : {}) });
    rec.output = r.res.output;
    previous = r.res.output;
    feedback = retryFeedbackV21(located);
  }
  return rec;
}

/** combineVotes' rule: the side at least HYBRID_MAJORITY valid answers gave; all valid and no majority: NO_PICK; else INVALID */
function decide(answers: AnswerRec[]): string {
  const sides = answers.map((a) => (a.final === 'OK' ? a.side : null));
  const tally = majorityVote(sides);
  if (tally) return tally.side!;
  if (sides.every((s) => s)) return 'NO_PICK';
  return 'INVALID';
}

// ---------------------------------------------------------------- run (cached per arm, decision, answer)
await mkdir(DIR, { recursive: true });
const ANSWERS = `${DIR}/answers.jsonl`;
const done = new Map<string, AnswerRec>();
try {
  for (const l of (await readFile(ANSWERS, 'utf8')).split('\n')) if (l.trim()) {
    const a = JSON.parse(l) as AnswerRec;
    done.set(`${a.arm}|${a.rowId}|${a.answer}`, a);
  }
} catch { /* first run */ }
const arms = values.arms!.split(',');

if (values.smoke) {
  const d = decisions.find((x) => x.group === 'G1' && x.prompt === 'hybrid-ai-v2.0') ?? decisions[0]!;
  for (const arm of arms) {
    const a = await answerOnce(arm, d, 1);
    console.log(arm, d.match, a.final, a.side, JSON.stringify(a.attempts.map((x) => ({ attempt: x.attempt, kind: x.kind, status: x.status, v: x.violations.map((v) => `${v.kind}:${v.value}@${v.field}`) }))));
  }
  console.log(`smoke: ${spent.calls} calls · $${spent.usd.toFixed(4)}`);
  await db.close();
  process.exit(0);
}

if (!values['report-only']) {
  const todo = decisions.flatMap((d) => arms.filter((arm) => Array.from({ length: HYBRID_VOTES }, (_, i) => done.has(`${arm}|${d.rowId}|${i + 1}`)).some((x) => !x)).map((arm) => ({ arm, d })));
  console.log(`${decisions.length} decisions (G1 ${decisions.filter((d) => d.group === 'G1').length}, G2 ${decisions.filter((d) => d.group === 'G2').length}) · arms ${arms.join(',')} · ${todo.length} decision-runs to do · budget $${BUDGET} · ${TPM} TPM · ${values.workers} workers`);
  let next = 0;
  let finished = 0;
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: Number(values.workers) }, async () => {
      while (!stop && next < todo.length) {
        const { arm, d } = todo[next++]!;
        const answers = await Promise.all(
          Array.from({ length: HYBRID_VOTES }, async (_, i) => done.get(`${arm}|${d.rowId}|${i + 1}`) ?? answerOnce(arm, d, i + 1)),
        );
        for (const a of answers) {
          if (a.final === 'ERROR' || done.has(`${a.arm}|${a.rowId}|${a.answer}`)) continue;
          done.set(`${a.arm}|${a.rowId}|${a.answer}`, a);
          await appendFile(ANSWERS, JSON.stringify(a) + '\n');
        }
        if (++finished % 10 === 0) console.log(`  ${finished}/${todo.length} · ${((Date.now() - t0) / 60_000).toFixed(1)} min · $${spent.usd.toFixed(3)} · 429 ${spent.rateLimited} · errors ${spent.errors}`);
      }
    }),
  );
  if (stop) console.log(`STOPPED: budget cap or the API refused · spent this run $${spent.usd.toFixed(3)}`);
}

// ---------------------------------------------------------------- derived numbers (for "passed the guard but at risk")
function derivedValues(input: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const add = (v: number) => { out.add(v.toFixed(2)); out.add(v.toFixed(1)); };
  for (const key of ['home_team', 'away_team']) {
    const t = (input[key] ?? {}) as Record<string, unknown>;
    for (const m of (t.recent_matches as Array<Record<string, unknown>>) ?? []) {
      const [gf, ga] = String(m.score_for_against ?? '').split('-').map(Number);
      if (Number.isFinite(gf) && Number.isFinite(ga) && gf! + ga! > 3) add(gf! + ga!);
      if (n(m.xg_for) !== null && n(m.xg_against) !== null) { add(n(m.xg_for)! + n(m.xg_against)!); add(Math.abs(n(m.xg_for)! - n(m.xg_against)!)); }
    }
    for (const w of ['last_10', 'last_5', 'home_matches_in_last_10', 'away_matches_in_last_10']) {
      const W = (t[w] ?? {}) as Record<string, unknown>;
      for (const [a, b] of [['goals_for_avg', 'goals_against_avg'], ['xg_for_avg', 'xg_against_avg'], ['npxg_for_avg', 'npxg_against_avg']]) {
        if (n(W[a!]) !== null && n(W[b!]) !== null) { add(n(W[a!])! + n(W[b!])!); add(Math.abs(n(W[a!])! - n(W[b!])!)); }
      }
    }
  }
  return out;
}
const exactIn = (input: Record<string, unknown>) => new Set(allowedNumbers(input).map((x) => Math.abs(x).toString()));

// ---------------------------------------------------------------- report
const CATS = ['FAVORITE', 'UNDERDOG', 'OVER', 'UNDER', 'NO_PICK', 'INVALID'];
const fmt = (d: Record<string, number>, n: number) => Object.fromEntries(CATS.map((c) => [c, `${d[c] ?? 0} (${n ? ((100 * (d[c] ?? 0)) / n).toFixed(1) : '0.0'}%)`]));
const pct = (xs: number[], q: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]! : null);
const rawStats = async (arm: string) => {
  let text = '';
  try { text = await readFile(`${DIR}/raw-${arm}.jsonl`, 'utf8'); } catch { return null; }
  const rows = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as { group: string; latencyMs: number; usage: Record<string, unknown> });
  const by = (g?: string) => {
    const xs = rows.filter((r) => !g || r.group === g);
    const tok = (k: string) => xs.reduce((s, r) => s + Number(r.usage?.[k] ?? 0), 0);
    const cached = xs.reduce((s, r) => s + Number((r.usage?.input_tokens_details as { cached_tokens?: number } | undefined)?.cached_tokens ?? 0), 0);
    const reasoning = xs.reduce((s, r) => s + Number((r.usage?.output_tokens_details as { reasoning_tokens?: number } | undefined)?.reasoning_tokens ?? 0), 0);
    return { calls: xs.length, usd: +xs.reduce((s, r) => s + costOf(r.usage ?? {}), 0).toFixed(4), inputTokens: tok('input_tokens'), cachedTokens: cached, outputTokens: tok('output_tokens'), reasoningTokens: reasoning, latencyMs: { p50: pct(xs.map((r) => r.latencyMs), 0.5), p95: pct(xs.map((r) => r.latencyMs), 0.95), max: Math.max(0, ...xs.map((r) => r.latencyMs)) } };
  };
  return { all: by(), G1: by('G1'), G2: by('G2') };
};

const summary: Record<string, unknown> = { model: MODEL, prices: PRICE, generatedAt: new Date().toISOString(), groups: {} };
for (const g of ['G1', 'G2'] as const) {
  const ds = decisions.filter((d) => d.group === g);
  if (!ds.length) continue;
  const liveDist: Record<string, number> = {};
  for (const d of ds) { const k = d.liveStatus === 'OK' ? d.liveSide ?? 'NO_PICK' : 'INVALID'; liveDist[k] = (liveDist[k] ?? 0) + 1; }
  const rows: Array<Record<string, unknown>> = [{ arm: 'live (as recorded)', decisions: ds.length, ...fmt(liveDist, ds.length), 'attempts/decision': +(ds.reduce((s, d) => s + d.liveAttempts, 0) / ds.length).toFixed(2) }];
  const per: Record<string, unknown> = { live: liveDist };
  for (const arm of arms) {
    const complete = ds.filter((d) => Array.from({ length: HYBRID_VOTES }, (_, i) => done.has(`${arm}|${d.rowId}|${i + 1}`)).every(Boolean));
    const dist: Record<string, number> = {};
    let attempts = 0, rejectedAttempts = 0, numberRejected = 0, inventedNumbersCount = 0, bannedWords = 0, otherViolations = 0, averageViolations = 0;
    let firstRejected = 0, retryFixed = 0, sameNumberAgain = 0, sameAsLive = 0;
    let derivedPassed = 0, derivedQuotedAggregate = 0, derivedCoincidental = 0, numbersInValidTexts = 0;
    const examples: string[] = [];
    for (const d of complete) {
      const answers = Array.from({ length: HYBRID_VOTES }, (_, i) => done.get(`${arm}|${d.rowId}|${i + 1}`)!);
      const decision = decide(answers);
      dist[decision] = (dist[decision] ?? 0) + 1;
      if (d.liveStatus === 'OK' && decision === (d.liveSide ?? 'NO_PICK')) sameAsLive++;
      const derived = derivedValues(d.input);
      const exactOriginal = exactIn(d.input);
      const armIn = armInput(arm, d);
      const exactArm = exactIn(armIn);
      for (const a of answers) {
        attempts += a.attempts.length;
        for (const t of a.attempts) {
          if (t.status === 'INVALID' || t.status === 'UNPARSEABLE') rejectedAttempts++;
          const nums = t.violations.filter((v) => v.kind === 'NUMBER_NOT_IN_INPUT');
          if (nums.length) numberRejected++;
          inventedNumbersCount += nums.length;
          bannedWords += t.violations.filter((v) => v.kind === 'BANNED_WORD').length;
          otherViolations += t.violations.filter((v) => v.kind === 'OTHER').length;
          averageViolations += t.violations.filter((v) => v.kind === 'AVERAGE_WITHOUT_COUNT').length;
          if (nums.length && examples.length < 6) examples.push(`${d.match} a${a.answer} t${t.attempt}: ${nums.map((v) => `${v.value} @${v.field} ${v.excerpt}`).join(' | ')}`);
        }
        const [t1, t2] = a.attempts;
        if (t1 && t1.status !== 'OK' && t2) {
          firstRejected++;
          if (t2.status === 'OK') retryFixed++;
          else if (t2.violations.some((v) => t1.violations.some((w) => w.kind === v.kind && w.value === v.value))) sameNumberAgain++;
        }
        // numbers in a valid answer that look like the AI's own arithmetic (a sum or gap of input values that is not
        // itself in the stored input): in v21 they should be quoted aggregates; anywhere else they passed by coincidence
        if (a.final === 'OK' && a.output) {
          const texts = JSON.stringify(a.output).match(/"[^"]*[฀-๿][^"]*"/g) ?? [];
          for (const t of texts) for (const m of t.matchAll(/\d+\.\d+/g)) {
            numbersInValidTexts++;
            const v = Number(m[0]);
            if (derived.has(v.toFixed(2)) || derived.has(v.toFixed(1))) {
              if (exactOriginal.has(String(v))) continue; // the value itself is in the stored input too
              derivedPassed++;
              if ((arm === 'v21' || arm.startsWith('v211')) && exactArm.has(String(v))) derivedQuotedAggregate++;
              else derivedCoincidental++;
            }
          }
        }
      }
    }
    const n = complete.length;
    rows.push({ arm, decisions: `${n}/${ds.length}`, ...fmt(dist, n), 'attempts/decision': n ? +(attempts / n).toFixed(2) : null });
    per[arm] = {
      decisions: n,
      distribution: dist,
      invalidDecisions: dist.INVALID ?? 0,
      sameAsLive: g === 'G2' ? `${sameAsLive}/${n}` : null,
      attempts,
      attemptsPerDecision: n ? attempts / n : null,
      rejectedAttempts,
      rejectionRate: attempts ? rejectedAttempts / attempts : null,
      numberGuardRejectedAttempts: numberRejected,
      numberGuardRejectionRate: attempts ? numberRejected / attempts : null,
      inventedNumbers: inventedNumbersCount,
      bannedWords,
      otherViolations,
      averageViolations,
      retry: { answersRejectedFirst: firstRejected, fixedOnRetry: retryFixed, successRate: firstRejected ? retryFixed / firstRejected : null, sameViolationAgain: sameNumberAgain },
      atRisk: { numbersInValidTexts, derivedLookingPassed: derivedPassed, quotedAggregate: derivedQuotedAggregate, coincidental: derivedCoincidental },
      examples,
    };
  }
  (summary.groups as Record<string, unknown>)[g] = per;
  console.log(`\n=== ${g} (${ds.length} decisions) ===`);
  console.table(rows);
  for (const arm of arms) {
    const x = per[arm] as Record<string, any>;
    if (!x) continue;
    console.log(`${arm}: INVALID ${x.invalidDecisions}/${x.decisions} · rejected attempts ${x.rejectedAttempts}/${x.attempts} (${(100 * (x.rejectionRate ?? 0)).toFixed(1)}%) · number guard ${x.numberGuardRejectedAttempts}/${x.attempts} (${(100 * (x.numberGuardRejectionRate ?? 0)).toFixed(1)}%) · invented numbers ${x.inventedNumbers} · banned ${x.bannedWords} · average-without-count ${x.averageViolations} · other ${x.otherViolations}`);
    console.log(`   retry: ${x.retry.fixedOnRetry}/${x.retry.answersRejectedFirst} fixed (${x.retry.successRate === null ? '-' : (100 * x.retry.successRate).toFixed(0) + '%'}), same violation again ${x.retry.sameViolationAgain} · same as live ${x.sameAsLive ?? '-'} · at risk: ${JSON.stringify(x.atRisk)}`);
    for (const e of x.examples.slice(0, 3)) console.log(`   e.g. ${e.slice(0, 220)}`);
  }
}
const cost: Record<string, unknown> = {};
for (const arm of arms) cost[arm] = await rawStats(arm);
summary.cost = cost;
console.log('\nCost and latency (all calls in raw-<arm>.jsonl):');
console.table(Object.entries(cost).flatMap(([arm, s]) => (s ? (['G1', 'G2'] as const).map((g) => ({ arm, group: g, ...(s as any)[g], latencyMs: undefined, p50: (s as any)[g].latencyMs.p50, p95: (s as any)[g].latencyMs.p95 })) : [])));
console.log(`total $${Object.values(cost).reduce((s: number, x: any) => s + (x?.all.usd ?? 0), 0).toFixed(3)} · this run: ${spent.calls} calls · 429 ${spent.rateLimited} · errors ${spent.errors}`);
await writeFile(`${DIR}/summary.json`, JSON.stringify(summary, null, 2));
await db.close();
