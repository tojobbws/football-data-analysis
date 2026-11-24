/**
 * Research, READ-ONLY (ADR 0022): A/B replay of Hybrid AI v2.2-panel against production v2.1.1 on the same stored
 * DAILY inputs. Writes NOTHING to the database and publishes nothing: answers go to reports/hybrid-v22-panel/.
 *
 *   npx tsx scripts/research/hybrid-v22-panel-replay.ts --dry-run                       # no API call, no cost
 *   npx tsx scripts/research/hybrid-v22-panel-replay.ts --limit 60 --seed 22 --budget 5  # PAID: asks OpenAI
 *   npx tsx scripts/research/hybrid-v22-panel-replay.ts --report-only                   # no call: report from the cache
 *
 * Options: --from YYYY-MM-DD (football day, default 2026-11-16 = v2.1.1 live) · --to YYYY-MM-DD · --limit N (0 = all)
 *   · --seed S (the sample is a seeded shuffle, so a rerun takes the same fixtures) · --arms control,panel
 *   · --model (default OPENAI_HYBRID_MODEL / OPENAI_MODEL; per lens OPENAI_PANEL_<ROLE>_MODEL) · --budget USD (hard cap)
 *   · --workers N (decisions at a time) · --prices in,cached,out ($ per 1M tokens)
 *
 * Inputs: the latest DAILY hybrid_decisions row of each fixture that kicked off before now, stored under
 * hybrid-ai-v2.0 or hybrid-ai-v2.1.1. A v2.1.1 input is used as stored; a v2.0 input goes through
 * prepareHybridInputV211 (the cut-off check and the totals with counts), exactly as production would build it.
 * Both arms get the byte-identical input and the same market options (hybridInputOptions of the stored input).
 *   control  v2.1.1: HYBRID_SYSTEM_PROMPT_V211, HYBRID_VOTES identical calls
 *   panel    v2.2-panel: HYBRID_SYSTEM_PROMPT_V22_PANEL, one call per lens (metrics, context, defender)
 * Both arms run the production code: askOnce (validateHybridOutputV211, retryFeedbackV21, HYBRID_MAX_ATTEMPTS) and
 * combineVotes (HYBRID_MAJORITY), all answers of a decision in parallel.
 *
 * Report per arm: INVALID rate, number-guard rejections, NO_PICK rate, side distribution, 3/3 vs 2/3, CLV against
 * market_closing (closing no-vig probability minus the decision's, same market, selection and line; a closing main
 * line that moved is counted apart, in or against the pick's favour), overall and by 3/3 vs 2/3, cached-token share,
 * estimated USD and p50/p95 latency per call and per decision. Small samples: read the CLV with its n.
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  createOpenAIHybridDeciderV21,
  createOpenAIHybridPanelDecider,
  HYBRID_PROMPT_VERSION,
  HYBRID_PROMPT_VERSION_V211,
  HYBRID_SYSTEM_PROMPT_V211,
  HYBRID_SYSTEM_PROMPT_V22_PANEL,
  HYBRID_VOTES,
  PANEL_ROLES,
  panelUserMessage,
  prepareHybridInputV211,
  userMessage,
  type HybridDecider,
  type PanelRole,
  type RankerResult,
} from '@fp/ai';
import { hybridInputOptions, type HybridOption } from '@fp/analysis';
import { createPgDb } from '@fp/database';
import { loadDotEnvFile, loadEnv } from '@fp/shared';
import { askOnce, combineVotes, panelOpenAIModel, panelReasoningEffort, type Answer, type HybridVersion } from '../../workers/analysis/src/hybrid-job.js';

const { values } = parseArgs({
  options: {
    from: { type: 'string', default: '2026-11-16' },
    to: { type: 'string' },
    limit: { type: 'string', default: '60' },
    seed: { type: 'string', default: '22' },
    arms: { type: 'string', default: 'control,panel' },
    model: { type: 'string' },
    budget: { type: 'string', default: '5' },
    workers: { type: 'string', default: '2' },
    prices: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'report-only': { type: 'boolean', default: false },
  },
});
const DRY = values['dry-run']!;
const REPORT_ONLY = values['report-only']!;
const DIR = 'reports/hybrid-v22-panel';
const BUDGET = Number(values.budget);
type Arm = 'control' | 'panel';
const ARMS = values.arms!.split(',').map((a) => a.trim()) as Arm[];
for (const a of ARMS) if (a !== 'control' && a !== 'panel') throw new Error(`unknown arm ${a}`);

loadDotEnvFile();
const env = loadEnv();
const MODEL = values.model ?? env.OPENAI_HYBRID_MODEL ?? env.OPENAI_MODEL;
if (!MODEL) throw new Error('no model: pass --model or set OPENAI_HYBRID_MODEL / OPENAI_MODEL');
const lensModel = (role: PanelRole) => (values.model ? values.model : panelOpenAIModel(env, role)!);
// $ per 1M tokens. gpt-6-luna as read on the OpenAI pricing page on 16 Nov 2026 (scripts/research/hybrid-v21-replay.ts);
// any other model needs --prices, else the estimate is labelled as luna prices.
const KNOWN_PRICES: Record<string, { input: number; cached: number; output: number }> = { 'gpt-6-luna': { input: 0.1, cached: 0.01, output: 0.5 } };
const PRICE = values.prices
  ? (([input, cached, output]) => ({ input: input!, cached: cached!, output: output! }))(values.prices.split(',').map(Number))
  : (KNOWN_PRICES[MODEL] ?? KNOWN_PRICES['gpt-6-luna']!);
const priceNote = values.prices ? 'from --prices' : KNOWN_PRICES[MODEL] ? `${MODEL} list price` : `UNKNOWN for ${MODEL}: gpt-6-luna prices used, pass --prices`;
if (!DRY && !REPORT_ONLY && !env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is needed (or use --dry-run / --report-only)');

const db = createPgDb(env.DATABASE_URL!, { max: 2 });

// ---------------------------------------------------------------- the sample (read-only)
interface Decision {
  id: number;
  fixtureId: number;
  match: string;
  storedPrompt: string;
  input: Record<string, unknown>;
  inputSha: string;
  options: HybridOption[];
  live: { status: string; side: string | null };
}
// football day d = [d 10:00, d+1 10:00) Thai = [d 03:00Z, d+1 03:00Z)
const fromTs = `${values.from}T03:00:00Z`;
const toTs = values.to ? new Date(Date.parse(`${values.to}T03:00:00Z`) + 86_400_000).toISOString() : new Date().toISOString();
const { rows } = await db.query<Record<string, any>>(
  `select d.id, d.fixture_id, d.prompt_version, d.input, d.status, d.side, th.name || ' v ' || ta.name match
     from (select distinct on (h.fixture_id) h.* from hybrid_decisions h
            where h.publish_round = 'DAILY' and h.input is not null and h.engine_version = 'hybrid-ai-v1'
            order by h.fixture_id, h.decided_at desc, h.id desc) d
     join fixtures f on f.id = d.fixture_id
     join teams th on th.id = f.home_team_id join teams ta on ta.id = f.away_team_id
    where d.prompt_version = any($3::text[]) and f.kickoff_at >= $1::timestamptz and f.kickoff_at < least($2::timestamptz, now())
    order by d.id`,
  [fromTs, toTs, [HYBRID_PROMPT_VERSION, HYBRID_PROMPT_VERSION_V211]],
);
const sha = (x: unknown) => createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
/** mulberry32: a seeded, portable shuffle, so --seed picks the same fixtures every run */
function shuffled<T>(xs: readonly T[], seed: number): T[] {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
const all: Decision[] = rows
  .map((r) => {
    const stored = r.input as Record<string, unknown>;
    // a v2.1.1 input is already prepared; a v2.0 input is prepared the way production builds v2.1.1
    const input = r.prompt_version === HYBRID_PROMPT_VERSION_V211 ? stored : prepareHybridInputV211(stored).input;
    return { id: Number(r.id), fixtureId: Number(r.fixture_id), match: String(r.match), storedPrompt: String(r.prompt_version), input, inputSha: sha(input), options: hybridInputOptions(stored as never), live: { status: String(r.status), side: (r.side as string) ?? null } };
  })
  .filter((d) => d.options.length > 0);
const limit = Number(values.limit);
const sample = shuffled(all, Number(values.seed)).slice(0, limit > 0 ? limit : undefined).sort((a, b) => a.id - b.id);
console.log(`${all.length} stored DAILY inputs (${values.from} → ${values.to ?? 'now'}, v2.0 ${all.filter((d) => d.storedPrompt === HYBRID_PROMPT_VERSION).length}, v2.1.1 ${all.filter((d) => d.storedPrompt === HYBRID_PROMPT_VERSION_V211).length}) · sample ${sample.length} (seed ${values.seed}) · arms ${ARMS.join(',')} · model ${MODEL}`);

// ---------------------------------------------------------------- dry run: the caching invariant and a cost bound, no call
if (DRY) {
  const marker = '\n\n[PANEL ROLE]\n';
  let broken = 0;
  let prefixChars = 0;
  let roleChars = 0;
  for (const d of sample) {
    const prefix = userMessage(d.input);
    const msgs = PANEL_ROLES.map((r) => panelUserMessage(d.input, r));
    if (new Set(msgs.map((m) => m.split(marker)[0])).size !== 1 || msgs.some((m) => !m.startsWith(prefix + marker))) broken++;
    prefixChars += prefix.length;
    roleChars += msgs.reduce((s, m) => s + m.length - prefix.length, 0) / msgs.length;
  }
  const n = sample.length || 1;
  // ~3 characters per token for this JSON-heavy mix (the v2.1 replay's estimate); output ~1.5k tokens a call
  const inTok = (HYBRID_SYSTEM_PROMPT_V22_PANEL.length + prefixChars / n + roleChars / n) / 3;
  const outTok = 1500;
  const calls = sample.length * (ARMS.includes('control') ? HYBRID_VOTES : 0) + sample.length * (ARMS.includes('panel') ? PANEL_ROLES.length : 0);
  const callUsd = (cachedShare: number) => ((inTok * (1 - cachedShare) * PRICE.input + inTok * cachedShare * PRICE.cached + outTok * PRICE.output) / 1e6);
  console.table(sample.slice(0, 15).map((d) => ({ id: d.id, match: d.match, stored: d.storedPrompt, options: d.options.map((o) => `${o.side} ${o.line}`).join(' · '), live: d.live.status === 'OK' ? d.live.side : d.live.status })));
  if (sample.length > 15) console.log(`… and ${sample.length - 15} more`);
  console.log(`prompt-caching invariant: instructions identical across lenses (one constant) · user prefix identical in ${sample.length - broken}/${sample.length} inputs${broken ? '  <-- BROKEN' : ''}`);
  console.log(`size: system ${HYBRID_SYSTEM_PROMPT_V22_PANEL.length} chars (v2.1.1 ${HYBRID_SYSTEM_PROMPT_V211.length}) · match data ~${Math.round(prefixChars / n)} chars · role section ~${Math.round(roleChars / n)} chars · ~${Math.round(inTok)} input tokens a call`);
  console.log(`estimate (${priceNote}): ${calls} first calls, up to ${calls * 2} with retries · $${(calls * callUsd(0.5)).toFixed(2)} at 50% cached … $${(calls * 2 * callUsd(0)).toFixed(2)} worst case (no cache, every call retried) · budget cap $${BUDGET}`);
  await db.close();
  process.exit(0);
}

// ---------------------------------------------------------------- calls: budget cap and a raw log of every call
await mkdir(DIR, { recursive: true });
const spent = { usd: 0, calls: 0, errors: 0 };
let stop: string | null = null;
const costOf = (u: Record<string, unknown> | null | undefined) => {
  const input = Number(u?.input_tokens ?? 0);
  const cached = Number((u?.input_tokens_details as { cached_tokens?: number } | undefined)?.cached_tokens ?? 0);
  const output = Number(u?.output_tokens ?? 0);
  return ((input - cached) * PRICE.input + cached * PRICE.cached + output * PRICE.output) / 1e6;
};
const IN_FLIGHT_RESERVE = 0.01;
let inFlight = 0;

/** the decider with the budget check before each call and a raw line after it (usage of every call, retries included) */
function logged(arm: Arm, d: Decision, voter: string, inner: HybridDecider): HybridDecider {
  const run = async (kind: 'decide' | 'retry', fn: () => Promise<RankerResult>) => {
    if (stop || spent.usd + (inFlight + 1) * IN_FLIGHT_RESERVE > BUDGET) {
      stop ??= 'budget cap';
      throw new Error('budget cap reached: no call made');
    }
    inFlight++;
    const t0 = Date.now();
    try {
      const res = await fn();
      spent.calls++;
      spent.usd += costOf(res.usage);
      await appendFile(`${DIR}/raw-${arm}.jsonl`, JSON.stringify({ arm, id: d.id, voter, kind, latencyMs: Date.now() - t0, model: res.model, usage: res.usage, stopReason: res.stopReason, refusal: res.refusal }) + '\n');
      return res;
    } catch (err) {
      spent.errors++;
      if (/no credits|insufficient_quota|401|invalid api key/i.test(String(err))) stop = String(err).slice(0, 200);
      await appendFile(`${DIR}/errors.log`, `${new Date().toISOString()} ${arm} ${d.id} ${voter} ${kind}: ${String(err).slice(0, 400)}\n`);
      throw err;
    } finally {
      inFlight--;
    }
  };
  return {
    decide: (input) => run('decide', () => inner.decide(input)),
    retry: (input, previous, feedback) => run('retry', () => inner.retry!(input, previous, feedback)),
  };
}

interface Rec {
  arm: Arm;
  id: number;
  fixtureId: number;
  inputSha: string;
  status: string;
  side: string | null;
  market: string | null;
  selection: string | null;
  line: number | null;
  marketProbability: number | null;
  agree: number;
  votes: Array<Record<string, unknown>>;
  violations: string[];
  wallMs: number;
}

async function decide(arm: Arm, d: Decision): Promise<Rec | null> {
  const version: HybridVersion = arm === 'panel' ? 'v2.2-panel' : 'v2.1.1';
  const voters: Array<{ role?: PanelRole; decider: HybridDecider }> =
    arm === 'panel'
      ? PANEL_ROLES.map((role) => {
          const effort = panelReasoningEffort(env, role);
          return { role, decider: logged(arm, d, role, createOpenAIHybridPanelDecider({ apiKey: env.OPENAI_API_KEY!, model: lensModel(role), role, timeoutMs: 150_000, ...(effort ? { reasoningEffort: effort } : {}) })) };
        })
      : Array.from({ length: HYBRID_VOTES }, (_, i) => ({ decider: logged(arm, d, `answer${i + 1}`, createOpenAIHybridDeciderV21({ apiKey: env.OPENAI_API_KEY!, model: MODEL!, system: HYBRID_SYSTEM_PROMPT_V211, timeoutMs: 150_000 })) }));
  const t0 = Date.now();
  const answers = await Promise.all(
    voters.map(async (v): Promise<Answer> => {
      const a = await askOnce(v.decider, d.input, d.options, version);
      return v.role ? { ...a, role: v.role, model: lensModel(v.role) } : a;
    }),
  );
  const wallMs = Date.now() - t0;
  // an API failure (budget cap included) is not a result: not cached, asked again on the next run
  if (answers.some((a) => a.failure)) return null;
  const row = combineVotes(answers);
  const votes = row.votes as Array<Record<string, unknown>>;
  return {
    arm, id: d.id, fixtureId: d.fixtureId, inputSha: d.inputSha,
    status: String(row.status),
    side: (row.side as string) ?? null,
    market: (row.market as string) ?? null,
    selection: (row.selection as string) ?? null,
    line: row.line == null ? null : Number(row.line),
    marketProbability: row.market_probability == null ? null : Number(row.market_probability),
    agree: row.side ? votes.filter((v) => v.side === row.side).length : 0,
    votes,
    violations: row.violations as string[],
    wallMs,
  };
}

// ---------------------------------------------------------------- run (cached per arm and decision; a rerun resumes)
const CACHE = `${DIR}/decisions.jsonl`;
const done = new Map<string, Rec>();
try {
  for (const l of (await readFile(CACHE, 'utf8')).split('\n')) if (l.trim()) {
    const r = JSON.parse(l) as Rec;
    done.set(`${r.arm}|${r.id}`, r);
  }
} catch { /* first run */ }

if (!REPORT_ONLY) {
  const todo = sample.flatMap((d) => ARMS.filter((arm) => !done.has(`${arm}|${d.id}`)).map((arm) => ({ arm, d })));
  console.log(`${todo.length} decision-runs to do · budget $${BUDGET} · ${values.workers} workers · prices ${priceNote}`);
  let next = 0;
  let finished = 0;
  await Promise.all(
    Array.from({ length: Number(values.workers) }, async () => {
      while (!stop && next < todo.length) {
        const { arm, d } = todo[next++]!;
        const rec = await decide(arm, d);
        if (rec) {
          done.set(`${arm}|${d.id}`, rec);
          await appendFile(CACHE, JSON.stringify(rec) + '\n');
        }
        if (++finished % 10 === 0) console.log(`  ${finished}/${todo.length} · $${spent.usd.toFixed(3)} · errors ${spent.errors}`);
      }
    }),
  );
  console.log(`this run: ${spent.calls} calls · $${spent.usd.toFixed(3)} · errors ${spent.errors}${stop ? ` · STOPPED: ${stop}` : ''}`);
}

// ---------------------------------------------------------------- CLV against market_closing (read-only)
interface Closing { market: string; selection: string; line: number | null; marketProbability: number }
const closing = new Map<number, Closing[]>();
const ids = [...new Set(sample.map((d) => d.fixtureId))];
if (ids.length) {
  const res = await db.query<Record<string, any>>('select fixture_id, market, selection, line, market_probability from market_closing where fixture_id = any($1::bigint[])', [ids]);
  for (const r of res.rows) {
    const list = closing.get(Number(r.fixture_id)) ?? [];
    list.push({ market: String(r.market), selection: String(r.selection), line: r.line == null ? null : Number(r.line), marketProbability: Number(r.market_probability) });
    closing.set(Number(r.fixture_id), list);
  }
}
/** same line: closing no-vig probability minus ours (probability points); a moved line: whether it moved our way */
function clvOf(r: Rec): { kind: 'same'; clv: number } | { kind: 'moved'; favourable: boolean } | { kind: 'none' } {
  if (!r.market || !r.selection || r.line == null || r.marketProbability == null) return { kind: 'none' };
  const c = closing.get(r.fixtureId)?.find((x) => x.market === r.market && x.selection === r.selection);
  if (!c || c.line == null) return { kind: 'none' };
  if (Math.abs(c.line - r.line) < 1e-6) return { kind: 'same', clv: c.marketProbability - r.marketProbability };
  // AH line from the selection's side: a lower closing line means the market made our side stronger; O/U: Over gains when the line rises
  const favourable = r.market === 'ASIAN_HANDICAP' ? c.line < r.line : r.selection === 'OVER' ? c.line > r.line : c.line < r.line;
  return { kind: 'moved', favourable };
}
function clvBlock(rs: Rec[]) {
  const xs = rs.map(clvOf);
  const same = xs.filter((x): x is { kind: 'same'; clv: number } => x.kind === 'same').map((x) => x.clv);
  const moved = xs.filter((x): x is { kind: 'moved'; favourable: boolean } => x.kind === 'moved');
  const mean = same.length ? same.reduce((a, b) => a + b, 0) / same.length : null;
  const sd = same.length > 1 ? Math.sqrt(same.reduce((a, b) => a + (b - mean!) ** 2, 0) / (same.length - 1)) : null;
  return {
    picks: rs.length,
    sameLineN: same.length,
    clvMeanPp: mean === null ? null : +(100 * mean).toFixed(2),
    clv95Pp: mean === null || sd === null ? null : [+(100 * (mean - (1.96 * sd) / Math.sqrt(same.length))).toFixed(2), +(100 * (mean + (1.96 * sd) / Math.sqrt(same.length))).toFixed(2)],
    positiveShare: same.length ? +(same.filter((x) => x > 0).length / same.length).toFixed(3) : null,
    lineMovedFavourable: moved.filter((m) => m.favourable).length,
    lineMovedAgainst: moved.filter((m) => !m.favourable).length,
    noClosing: xs.filter((x) => x.kind === 'none').length,
  };
}

// ---------------------------------------------------------------- report
const pct = (a: number, n: number) => (n ? `${a} (${((100 * a) / n).toFixed(1)}%)` : '0');
const quant = (xs: number[], q: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]! : null);
async function rawCalls(arm: Arm) {
  try {
    const text = await readFile(`${DIR}/raw-${arm}.jsonl`, 'utf8');
    const sampled = new Set(sample.map((d) => d.id));
    return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as { id: number; voter: string; kind: string; latencyMs: number; usage: Record<string, unknown> }).filter((r) => sampled.has(r.id));
  } catch {
    return [];
  }
}

const summary: Record<string, unknown> = { generatedAt: new Date().toISOString(), model: MODEL, prices: PRICE, priceNote, from: values.from, to: values.to ?? null, seed: values.seed, sample: sample.length, arms: {} };
const table: Array<Record<string, unknown>> = [];
// compare the arms on the decisions both have answered
const common = sample.filter((d) => ARMS.every((arm) => done.has(`${arm}|${d.id}`)));
for (const arm of ARMS) {
  const rs = common.map((d) => done.get(`${arm}|${d.id}`)!);
  const n = rs.length;
  const sides: Record<string, number> = {};
  for (const r of rs) {
    const k = r.status === 'OK' ? r.side ?? 'NO_PICK' : r.status;
    sides[k] = (sides[k] ?? 0) + 1;
  }
  const picks = rs.filter((r) => r.status === 'OK' && r.side && r.side !== 'NO_PICK');
  const unanimous = picks.filter((r) => r.agree === 3);
  const two = picks.filter((r) => r.agree === 2);
  const noPicks = rs.filter((r) => r.status === 'OK' && r.side === 'NO_PICK');
  const allVotes = rs.flatMap((r) => r.votes);
  const rejected = rs.flatMap((r) => r.violations);
  const attempts = allVotes.reduce((s, v) => s + Number(v.attempts ?? 0), 0);
  // one line per rejected attempt reason; count the attempts the number guard rejected (one or more numbers)
  const numberAttempts = rs.reduce((s, r) => s + new Set(r.violations.filter((v) => v.includes('number not in input')).map((v) => v.replace(/: number not in input.*$/, ''))).size, 0);
  const calls = await rawCalls(arm);
  const inTok = calls.reduce((s, c) => s + Number(c.usage?.input_tokens ?? 0), 0);
  const cachedTok = calls.reduce((s, c) => s + Number((c.usage?.input_tokens_details as { cached_tokens?: number } | undefined)?.cached_tokens ?? 0), 0);
  const usd = calls.reduce((s, c) => s + costOf(c.usage), 0);
  const byRole = arm === 'panel' ? Object.fromEntries(PANEL_ROLES.map((role) => {
    const vs = rs.map((r) => r.votes.find((v) => v.role === role)).filter(Boolean) as Array<Record<string, unknown>>;
    const ok = vs.filter((v) => v.status === 'OK');
    return [role, { answers: vs.length, invalid: vs.filter((v) => v.status !== 'OK').length, noPick: ok.filter((v) => v.side === 'NO_PICK').length, picks: ok.filter((v) => v.side && v.side !== 'NO_PICK').length }];
  })) : null;
  const stats = {
    decisions: n,
    invalid: rs.filter((r) => r.status !== 'OK').length,
    invalidAnswers: allVotes.filter((v) => v.status !== 'OK').length,
    answers: allVotes.length,
    attempts,
    numberGuardRejectedAttempts: numberAttempts,
    averageCountRejections: rejected.filter((v) => v.includes('average without match count')).length,
    bannedWordRejections: rejected.filter((v) => v.includes('banned word')).length,
    noPick: noPicks.length,
    noPickUnanimous: noPicks.filter((r) => r.agree === 3).length,
    picks: picks.length,
    picks3of3: unanimous.length,
    picks2of3: two.length,
    sides,
    byRole,
    clv: { all: clvBlock(picks), '3/3': clvBlock(unanimous), '2/3': clvBlock(two) },
    tokens: { calls: calls.length, input: inTok, cached: cachedTok, cachedShare: inTok ? +(cachedTok / inTok).toFixed(3) : null, output: calls.reduce((s, c) => s + Number(c.usage?.output_tokens ?? 0), 0) },
    usd: +usd.toFixed(4),
    usdPerDecision: n ? +(usd / n).toFixed(4) : null,
    latencyMs: { callP50: quant(calls.map((c) => c.latencyMs), 0.5), callP95: quant(calls.map((c) => c.latencyMs), 0.95), decisionP50: quant(rs.map((r) => r.wallMs), 0.5), decisionP95: quant(rs.map((r) => r.wallMs), 0.95) },
  };
  (summary.arms as Record<string, unknown>)[arm] = stats;
  table.push({
    arm,
    decisions: n,
    INVALID: pct(stats.invalid, n),
    'number guard (attempts)': pct(numberAttempts, attempts),
    NO_PICK: pct(stats.noPick, n),
    picks: pct(stats.picks, n),
    '3/3': stats.picks3of3,
    '2/3': stats.picks2of3,
    'CLV pp (n)': stats.clv.all.clvMeanPp === null ? '-' : `${stats.clv.all.clvMeanPp} (${stats.clv.all.sameLineN})`,
    'CLV 3/3': stats.clv['3/3'].clvMeanPp ?? '-',
    'CLV 2/3': stats.clv['2/3'].clvMeanPp ?? '-',
    cached: stats.tokens.cachedShare ?? '-',
    usd: stats.usd,
    'p50/p95 decision s': stats.latencyMs.decisionP50 === null ? '-' : `${(stats.latencyMs.decisionP50 / 1000).toFixed(1)}/${(stats.latencyMs.decisionP95! / 1000).toFixed(1)}`,
  });
}
// how often the arms agree on the same decision
if (ARMS.length === 2) {
  const same = common.filter((d) => {
    const [a, b] = ARMS.map((arm) => done.get(`${arm}|${d.id}`)!);
    return a!.status === b!.status && a!.side === b!.side;
  }).length;
  summary.agreement = { same, of: common.length };
}
console.log(`\n${common.length} decisions answered by every arm (of ${sample.length} sampled)`);
console.table(table);
for (const arm of ARMS) {
  const s = (summary.arms as Record<string, any>)[arm];
  console.log(`${arm}: sides ${JSON.stringify(s.sides)} · CLV ${JSON.stringify(s.clv.all)}${s.byRole ? ` · lenses ${JSON.stringify(s.byRole)}` : ''}`);
}
if (summary.agreement) console.log(`same decision in both arms: ${(summary.agreement as { same: number }).same}/${common.length}`);
console.log(`prices: ${priceNote}`);
await writeFile(`${DIR}/summary.json`, JSON.stringify(summary, null, 2));
await db.close();
