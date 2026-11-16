/**
 * Research, dry-run: replay the settled DAILY Hybrid AI decisions through OpenAI's Decisions API
 * (POST /v1/decisions, gpt-6-luna) on the EXACT inputs the live engine saw (hybrid_decisions.input).
 * Writes NOTHING to the database. Every answer is cached, so a stopped run resumes.
 *
 *   npx tsx scripts/research/decisions-replay.ts [--runs 2] [--workers 6] [--limit 0] [--smoke]
 *        [--cache reports/decisions-replay/cache.jsonl] [--out reports/decisions-replay/summary.json] [--report-only]
 *
 * One request per match and run, two kinds of question on the same input:
 *   pick          choice among the options the live engine offered (FAVORITE / UNDERDOG / OVER / UNDER) and NO_PICK;
 *                 the API returns a probability for every choice and a confidence
 *   wins_<SIDE>   predicate per option: the chance it comes out ahead at its line on the 90-minute score,
 *                 compared with the market's no-vig probability of the same option (Brier score)
 * Guidance: the live system prompt of HYBRID_PROMPT_VERSION without its output rules (no text is written here);
 * the v2.0 guide only for inputs that carry v2.0 fields.
 *
 * Compared on the same fixtures: the live ×3 majority decision as published, the Decisions choice (run 1), the
 * Decisions choice by confidence band, and the predicates against the market.
 * Leak control: the stored input was built at decision time; the finished score is only read to settle. Kickoffs
 * (from 2026-11-06) are after the model's training data.
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import OpenAI from 'openai';
import { HYBRID_PROMPT_VERSION, HYBRID_SYSTEM_PROMPT, HYBRID_V20_GUIDE, userMessage } from '@fp/ai';
import { settle, type HybridOption, type HybridSide } from '@fp/analysis';
import { createPgDb } from '@fp/database';
import { loadDotEnvFile, loadEnv } from '@fp/shared';

const { values } = parseArgs({
  options: {
    runs: { type: 'string', default: '2' },
    workers: { type: 'string', default: '6' },
    limit: { type: 'string', default: '0' },
    cache: { type: 'string', default: 'reports/decisions-replay/cache.jsonl' },
    out: { type: 'string', default: 'reports/decisions-replay/summary.json' },
    'report-only': { type: 'boolean', default: false },
    smoke: { type: 'boolean', default: false },
  },
});
const RUNS = Number(values.runs);
const CACHE = values.cache!;
const MODEL = 'gpt-6-luna'; // the only model the Decisions API accepts
const VERSION = 'decisions-v1'; // bump on any change to the guidance or the questions

loadDotEnvFile();
const env = loadEnv();
if (!values['report-only'] && !env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is needed');
const db = createPgDb(env.DATABASE_URL!, { max: 4 });
const client = values['report-only'] ? null : new OpenAI({ apiKey: env.OPENAI_API_KEY!, timeout: 120_000, maxRetries: 2 });

// ---------------------------------------------------------------- the settled live DAILY decisions
interface Live {
  decisionId: number;
  fixtureId: number;
  match: string;
  kickoff: string;
  gh: number;
  ga: number;
  input: Record<string, unknown>;
  promptVersion: string;
  side: string;
  votes: string;
  confidence: string | null;
}
const limit = Number(values.limit);
const lives: Live[] = (
  await db.query<Record<string, unknown>>(
    `select distinct on (d.fixture_id) d.id, d.fixture_id, d.input, d.prompt_version, d.side, d.confidence, d.votes,
            th.name || ' v ' || ta.name match, f.kickoff_at,
            coalesce(f.ft_home, f.goals_home) gh, coalesce(f.ft_away, f.goals_away) ga
       from hybrid_decisions d join fixtures f on f.id = d.fixture_id
       join teams th on th.id = f.home_team_id join teams ta on ta.id = f.away_team_id
      where d.engine_version = 'hybrid-ai-v1' and d.engine_mode = 'hybrid' and d.publish_round = 'DAILY' and d.status = 'OK'
        and f.status_short in ('FT','AET','PEN') and coalesce(f.ft_home, f.goals_home) is not null
      order by d.fixture_id, d.decided_at desc`,
  )
).rows
  .map((r) => ({
    decisionId: Number(r.id),
    fixtureId: Number(r.fixture_id),
    match: String(r.match),
    kickoff: new Date(r.kickoff_at as string).toISOString(),
    gh: Number(r.gh),
    ga: Number(r.ga),
    input: r.input as Record<string, unknown>,
    promptVersion: String(r.prompt_version),
    side: String(r.side),
    votes: Array.isArray(r.votes) ? (r.votes as Array<{ side: string | null; status: string }>).map((v) => v.side ?? v.status).join(',') : '-',
    confidence: (r.confidence as string) ?? null,
  }))
  .filter((l) => optionsOf(l.input).length > 0)
  .sort((a, b) => a.kickoff.localeCompare(b.kickoff))
  .slice(0, limit > 0 ? limit : undefined);

/** the options exactly as the live engine offered them, rebuilt from the stored input */
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

// ---------------------------------------------------------------- the request
const BASE_GUIDE = HYBRID_SYSTEM_PROMPT.split('\n\nOutput rules:')[0]!;
const guideFor = (input: Record<string, unknown>) => ('elo_ratings' in input ? BASE_GUIDE : BASE_GUIDE.replace(`${HYBRID_V20_GUIDE}\n\n`, ''));

function describe(o: HybridOption, input: Record<string, unknown>): string {
  const { home, away } = input.match as { home: string; away: string };
  if (o.market === 'OVER_UNDER') return `${o.selection === 'OVER' ? 'Over' : 'Under'} ${o.line} total goals (market no-vig probability ${o.marketProbability})`;
  const team = o.selection === 'HOME' ? home : away;
  const line = o.line > 0 ? `+${o.line}` : String(o.line);
  return `Asian handicap ${o.side === 'FAVORITE' ? 'favourite' : 'underdog'}: ${team} ${line} (market no-vig probability ${o.marketProbability})`;
}

function questionsFor(input: Record<string, unknown>, options: HybridOption[]): OpenAI.DecisionCreateParams['questions'] {
  return [
    {
      type: 'choice',
      name: 'pick',
      instructions:
        'As the analyst described above: which one choice has the strongest evidence that the market price may not reflect? Choose NO_PICK when the information is insufficient or no option can be justified; no pick is a correct, common answer. Do not automatically favour the underdog, the favourite, Over or Under.',
      choices: [
        ...options.map((o) => ({ value: o.side, description: describe(o, input) })),
        { value: 'NO_PICK', description: 'No choice: the evidence does not point clearly to any option beyond what the price already contains.' },
      ],
    },
    ...options.map((o) => ({
      type: 'predicate' as const,
      name: `wins_${o.side}`,
      instructions: `Using only the match data, estimate the chance that this option comes out ahead at its line on the 90-minute score (a win or a half win; a push does not count either way): ${describe(o, input)}.`,
    })),
  ];
}

// ---------------------------------------------------------------- cached calls
interface Answer {
  status: 'OK' | 'REFUSED';
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  wins?: Record<string, number>;
  tokens: { input: number; cached: number; output: number };
}
const cache = new Map<string, Answer>();
try {
  for (const line of (await readFile(CACHE, 'utf8')).split('\n'))
    if (line.trim()) {
      const x = JSON.parse(line) as { key: string; answer: Answer };
      cache.set(x.key, x.answer);
    }
} catch {
  /* no cache yet */
}
await mkdir(dirname(CACHE), { recursive: true });

async function ask(live: Live): Promise<Answer> {
  const options = optionsOf(live.input);
  const res = await client!.decisions.create({
    model: MODEL,
    input: [{ role: 'user', content: [{ type: 'input_text', text: guideFor(live.input) }, { type: 'input_text', text: userMessage(live.input) }] }],
    questions: questionsFor(live.input, options),
  });
  const tokens = { input: res.usage.input_tokens, cached: res.usage.input_tokens_details?.cached_tokens ?? 0, output: res.usage.output_tokens };
  const pick = res.answers.find((a) => a.name === 'pick');
  if (!pick || pick.type !== 'choice') return { status: 'REFUSED', tokens };
  const wins: Record<string, number> = {};
  for (const a of res.answers) if (a.type === 'predicate' && a.name?.startsWith('wins_')) wins[a.name.slice(5)] = a.probability;
  return {
    status: 'OK',
    choice: String(pick.choice),
    confidence: pick.confidence,
    probabilities: Object.fromEntries(pick.probabilities.map((p) => [String(p.value), p.probability])),
    wins,
    tokens,
  };
}

if (values.smoke) {
  const live = lives[0]!;
  console.log(`smoke: ${live.match} (${live.promptVersion}), live ${live.side} [${live.votes}]`);
  console.log(JSON.stringify(await ask(live), null, 2));
  await db.close();
  process.exit(0);
}

const jobs = lives.flatMap((live) => Array.from({ length: RUNS }, (_, i) => ({ key: `${live.decisionId}|${VERSION}|R${i + 1}`, live })));
const todo = jobs.filter((j) => !cache.has(j.key));
console.log(`${lives.length} settled DAILY decisions · ${jobs.length} calls · ${jobs.length - todo.length} cached · ${todo.length} to run · ${VERSION} · ${MODEL}`);

if (!values['report-only'] && todo.length) {
  let next = 0;
  let done = 0;
  let stop = false;
  const started = Date.now();
  await Promise.all(
    Array.from({ length: Number(values.workers) }, async () => {
      while (!stop && next < todo.length) {
        const j = todo[next++]!;
        let answer: Answer;
        try {
          answer = await ask(j.live);
        } catch (err) {
          console.log(`  ERROR ${j.key}: ${String(err).slice(0, 200)}`);
          if (err instanceof OpenAI.RateLimitError && err.code === 'insufficient_quota') stop = true;
          if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.BadRequestError) stop = true;
          continue; // not cached: retried on the next run
        }
        cache.set(j.key, answer);
        await appendFile(CACHE, JSON.stringify({ key: j.key, answer }) + '\n');
        done++;
        if (done % 25 === 0 || done === todo.length) {
          const min = (Date.now() - started) / 60_000;
          console.log(`  ${done}/${todo.length} · ${min.toFixed(1)} min · ~${((min / done) * (todo.length - done)).toFixed(0)} min left`);
        }
      }
    }),
  );
}

// ---------------------------------------------------------------- settle and report
type Outcome = 'WIN' | 'HALF_WIN' | 'PUSH' | 'HALF_LOSS' | 'LOSS';
interface Settled {
  side: string;
  odds: number;
  expected: number;
  outcome: Outcome;
  profit: number;
}
const outcomeOf = (live: Live, o: HybridOption): Outcome =>
  settle(o.market === 'ASIAN_HANDICAP' ? { market: 'ASIAN_HANDICAP', selection: o.selection as 'HOME' | 'AWAY', line: o.line } : { market: 'OVER_UNDER', selection: o.selection as 'OVER' | 'UNDER', line: o.line }, live.gh, live.ga) as Outcome;
function settlePick(live: Live, side: string | null | undefined): Settled | null {
  const o = side && side !== 'NO_PICK' ? optionsOf(live.input).find((x) => x.side === side) : undefined;
  if (!o) return null;
  const outcome = outcomeOf(live, o);
  const profit = { WIN: o.odds - 1, HALF_WIN: (o.odds - 1) / 2, PUSH: 0, HALF_LOSS: -0.5, LOSS: -1 }[outcome];
  return { side: o.side, odds: o.odds, expected: o.marketProbability, outcome, profit };
}

function row(name: string, s: Settled[]) {
  const c = (o: Outcome) => s.filter((x) => x.outcome === o).length;
  const won = c('WIN') + 0.5 * c('HALF_WIN');
  const lost = c('LOSS') + 0.5 * c('HALF_LOSS');
  const u = s.map((x) => x.profit);
  const mu = u.reduce((a, b) => a + b, 0) / Math.max(1, u.length);
  const sd = Math.sqrt(u.reduce((a, b) => a + (b - mu) ** 2, 0) / Math.max(1, u.length - 1));
  const exp = s.reduce((a, x) => a + x.expected, 0) / Math.max(1, s.length);
  return {
    variant: name,
    picks: s.length,
    'fav/dog/over/under': ['FAVORITE', 'UNDERDOG', 'OVER', 'UNDER'].map((k) => s.filter((x) => x.side === k).length).join('/'),
    'W/HW/P/HL/L': `${c('WIN')}/${c('HALF_WIN')}/${c('PUSH')}/${c('HALF_LOSS')}/${c('LOSS')}`,
    'win share %': won + lost ? +((100 * won) / (won + lost)).toFixed(1) : null,
    'market exp. %': s.length ? +(100 * exp).toFixed(1) : null,
    units: +u.reduce((a, b) => a + b, 0).toFixed(2),
    'units/pick': +mu.toFixed(3),
    '±95%': s.length > 1 ? +((1.96 * sd) / Math.sqrt(s.length)).toFixed(3) : null,
  };
}

const R = (live: Live, i: number) => cache.get(`${live.decisionId}|${VERSION}|R${i}`);
const complete = lives.filter((l) => Array.from({ length: RUNS }, (_, i) => R(l, i + 1)).every((a) => a));
const variants: Record<string, Settled[]> = {};
const push = (name: string, s: Settled | null) => {
  variants[name] ??= [];
  if (s) variants[name]!.push(s);
};

// self-agreement and agreement with the live decision
let agreeRuns = 0;
let bothRuns = 0;
let maxProbGap = 0;
let agreeLive = 0;
let refused = 0;
const confusion = new Map<string, number>();
for (const live of complete) {
  const a1 = R(live, 1)!;
  if (a1.status !== 'OK') {
    refused++;
    continue;
  }
  const a2 = RUNS > 1 ? R(live, 2) : undefined;
  if (a2?.status === 'OK') {
    bothRuns++;
    if (a1.choice === a2.choice) agreeRuns++;
    for (const k of Object.keys(a1.probabilities ?? {})) maxProbGap = Math.max(maxProbGap, Math.abs((a1.probabilities![k] ?? 0) - (a2.probabilities![k] ?? 0)));
  }
  if (a1.choice === live.side) agreeLive++;
  const k = `${live.side} → ${a1.choice}`;
  confusion.set(k, (confusion.get(k) ?? 0) + 1);
}

// variants on the same fixtures
const ok = complete.filter((l) => R(l, 1)!.status === 'OK');
for (const live of ok) {
  const a = R(live, 1)!;
  push('live ×3 majority (published)', settlePick(live, live.side));
  push('Decisions choice (run 1)', settlePick(live, a.choice));
  if (live.side !== 'NO_PICK') push('Decisions on the live pick: same side', a.choice === live.side ? settlePick(live, live.side) : null);
  if (live.side !== 'NO_PICK') push('Decisions on the live pick: other answer', a.choice !== live.side ? settlePick(live, live.side) : null);
}
// the Decisions choices ranked by the choice's own probability: thirds
const dPicks = ok
  .map((live) => ({ live, a: R(live, 1)! }))
  .filter((x) => x.a.choice !== 'NO_PICK')
  .map((x) => ({ ...x, p: x.a.probabilities?.[x.a.choice!] ?? 0 }))
  .sort((a, b) => b.p - a.p);
const third = Math.ceil(dPicks.length / 3);
for (const [i, name] of ['Decisions top third by p(choice)', 'Decisions middle third', 'Decisions bottom third'].entries()) {
  const slice = dPicks.slice(i * third, (i + 1) * third);
  variants[name] = slice.map((x) => settlePick(x.live, x.a.choice)).filter((s): s is Settled => !!s);
}
const pRange = (i: number) => {
  const s = dPicks.slice(i * third, (i + 1) * third);
  return s.length ? `${s.at(-1)!.p.toFixed(2)}–${s[0]!.p.toFixed(2)}` : '-';
};

// predicates against the market: Brier on decided outcomes (push left out, a half counted as its side)
let n = 0;
let brierAi = 0;
let brierMkt = 0;
let sumAi = 0;
let sumMkt = 0;
let sumY = 0;
const edgeRows: Record<string, Settled[]> = { 'AI p − market p ≥ 0.05': [], 'AI p − market p ≥ 0.10': [] };
for (const live of ok) {
  const a = R(live, 1)!;
  const best: { o: HybridOption; edge: number } | null = optionsOf(live.input).reduce<{ o: HybridOption; edge: number } | null>((acc, o) => {
    const p = a.wins?.[o.side];
    if (p === undefined) return acc;
    const out = outcomeOf(live, o);
    if (out !== 'PUSH') {
      const y = out === 'WIN' || out === 'HALF_WIN' ? 1 : 0;
      n++;
      brierAi += (p - y) ** 2;
      brierMkt += (o.marketProbability - y) ** 2;
      sumAi += p;
      sumMkt += o.marketProbability;
      sumY += y;
    }
    const edge = p - o.marketProbability;
    return !acc || edge > acc.edge ? { o, edge } : acc;
  }, null);
  if (best && best.edge >= 0.05) edgeRows['AI p − market p ≥ 0.05']!.push(settlePick(live, best.o.side)!);
  if (best && best.edge >= 0.1) edgeRows['AI p − market p ≥ 0.10']!.push(settlePick(live, best.o.side)!);
}
Object.assign(variants, edgeRows);

const tokens = [...cache.values()].reduce((s, a) => ({ input: s.input + a.tokens.input, cached: s.cached + a.tokens.cached, output: s.output + a.tokens.output }), { input: 0, cached: 0, output: 0 });
const byVersion = Object.fromEntries([...new Set(ok.map((l) => l.promptVersion))].map((v) => [v, ok.filter((l) => l.promptVersion === v).length]));

console.log(`\nFixtures: ${complete.length} answered in every run of ${lives.length} · refused ${refused} · by live prompt ${JSON.stringify(byVersion)}`);
console.log(`Same choice run 1 vs run 2: ${agreeRuns}/${bothRuns} · largest probability gap between runs ${maxProbGap.toFixed(3)}`);
console.log(`Same choice as the live ×3 decision: ${agreeLive}/${ok.length}`);
console.log(`Probability bands of p(choice): top ${pRange(0)}, middle ${pRange(1)}, bottom ${pRange(2)}`);
console.log(`Predicates vs market (${n} option outcomes, push left out): Brier AI ${(brierAi / n).toFixed(4)} · market ${(brierMkt / n).toFixed(4)} · mean AI p ${(sumAi / n).toFixed(3)} · mean market p ${(sumMkt / n).toFixed(3)} · actual ${(sumY / n).toFixed(3)}`);
console.log(`Tokens: input ${tokens.input} (cached ${tokens.cached}) · output ${tokens.output} · cost ≈ $${((tokens.input - tokens.cached) * 0.1e-6 + tokens.cached * 0.01e-6).toFixed(3)}`);
console.log('\nLive ×3 → Decisions run 1:');
console.table([...confusion.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ 'live → decisions': k, fixtures: v })));
const table = Object.entries(variants).map(([k, v]) => row(k, v));
console.table(table);
await mkdir(dirname(values.out!), { recursive: true });
await writeFile(
  values.out!,
  JSON.stringify({ version: VERSION, model: MODEL, guidePrompt: HYBRID_PROMPT_VERSION, fixtures: lives.length, complete: complete.length, refused, byVersion, agreeRuns: [agreeRuns, bothRuns], maxProbGap, agreeLive: [agreeLive, ok.length], brier: { n, ai: brierAi / n, market: brierMkt / n, meanAi: sumAi / n, meanMarket: sumMkt / n, actual: sumY / n }, tokens, table, confusion: Object.fromEntries(confusion) }, null, 2),
);
await db.close();
