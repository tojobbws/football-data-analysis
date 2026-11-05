/**
 * Research, dry-run: replay the Hybrid AI on the EXACT inputs it saw live (hybrid_decisions.input), A/B style.
 * Writes NOTHING to the database. Calls the live model (OPENAI_MODEL); every answer is cached so a stopped run resumes.
 *
 *   npx tsx scripts/research/hybrid-replay.ts [--runs-a 3] [--runs-b 2] [--workers 6] [--limit 0]
 *        [--cache reports/hybrid-replay/cache.jsonl] [--out reports/hybrid-replay/summary.json] [--report-only]
 *
 * Variants (current prompt, HYBRID_PROMPT_VERSION):
 *   A1..An  the stored input unchanged                  -> A1 vs A2 agreement = the AI's own noise
 *   B1..Bn  the stored input without legacy_statistical_model (the Dixon-Coles voice that leans to underdogs / unders)
 *   A-maj   pick only when at least 2 of A1..A3 give the same option   (self-consistency)
 *   A-all   pick only when A1..A3 all give the same option
 *   B-maj   same, on B1..B2(..B3): with 2 runs it needs both to agree
 * Reference: the live decision as stored (earlier prompt versions), and the rules' legacy pick.
 *
 * Leak control: the stored input was built at decision time from data known then (it is the live input). The finished
 * score is only read to settle. Kickoffs are after the model's training data.
 * Measures per variant: picks, W/HW/P/HL/L, stake-weighted win share vs the market's no-vig expectation for the same
 * picks, net units at the median price, units/pick ±95%, CLV vs the stored closing odds.
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { createOpenAIHybridDecider, HYBRID_MAX_ATTEMPTS, HYBRID_PROMPT_VERSION, validateHybridOutput } from '@fp/ai';
import { closingLineValue, settle, type HybridOption, type HybridSide } from '@fp/analysis';
import { createPgDb, Repository } from '@fp/database';
import { loadDotEnvFile, loadEnv } from '@fp/shared';

const { values } = parseArgs({
  options: {
    'runs-a': { type: 'string', default: '3' },
    'runs-b': { type: 'string', default: '2' },
    workers: { type: 'string', default: '6' },
    limit: { type: 'string', default: '0' },
    cache: { type: 'string', default: 'reports/hybrid-replay/cache.jsonl' },
    out: { type: 'string', default: 'reports/hybrid-replay/summary.json' },
    'report-only': { type: 'boolean', default: false },
  },
});
const RUNS_A = Number(values['runs-a']);
const RUNS_B = Number(values['runs-b']);
const CACHE = values.cache!;

loadDotEnvFile();
const env = loadEnv();
if (!values['report-only'] && (!env.OPENAI_API_KEY || !env.OPENAI_MODEL)) throw new Error('OPENAI_API_KEY and OPENAI_MODEL are needed');
const db = createPgDb(env.DATABASE_URL!, { max: 6 });
const repo = new Repository(db);
const decider = values['report-only'] ? null : createOpenAIHybridDecider({ apiKey: env.OPENAI_API_KEY!, model: env.OPENAI_MODEL! });

// ---------------------------------------------------------------- the stored live decisions
interface Live {
  decisionId: number;
  fixtureId: number;
  league: string;
  match: string;
  gh: number;
  ga: number;
  input: Record<string, unknown>;
  promptVersion: string;
  side: string;
  market: string | null;
  selection: string | null;
  line: number | null;
  odds: number | null;
  legacy: { pick?: { market: string; selection: string; line: number; odds: number } | null } | null;
}
const limit = Number(values.limit);
const lives: Live[] = (
  await db.query<Record<string, unknown>>(
    `select distinct on (d.fixture_id) d.id, d.fixture_id, d.input, d.prompt_version, d.side, d.market, d.selection, d.line, d.odds, d.legacy,
            l.name league, th.name || ' v ' || ta.name match,
            coalesce(f.ft_home, f.goals_home) gh, coalesce(f.ft_away, f.goals_away) ga
       from hybrid_decisions d join fixtures f on f.id = d.fixture_id
       join leagues l on l.id = f.league_id join teams th on th.id = f.home_team_id join teams ta on ta.id = f.away_team_id
      where d.engine_version = 'hybrid-ai-v1' and d.publish_round = 'EARLY' and d.status = 'OK'
        and f.status_short in ('FT','AET','PEN') and coalesce(f.ft_home, f.goals_home) is not null
      order by d.fixture_id, d.decided_at desc`,
  )
).rows
  .map((r) => ({
    decisionId: Number(r.id),
    fixtureId: Number(r.fixture_id),
    league: String(r.league),
    match: String(r.match),
    gh: Number(r.gh),
    ga: Number(r.ga),
    input: r.input as Record<string, unknown>,
    promptVersion: String(r.prompt_version),
    side: String(r.side),
    market: (r.market as string) ?? null,
    selection: (r.selection as string) ?? null,
    line: r.line == null ? null : Number(r.line),
    odds: r.odds == null ? null : Number(r.odds),
    legacy: r.legacy as Live['legacy'],
  }))
  .sort((a, b) => a.fixtureId - b.fixtureId)
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
const withoutDc = (input: Record<string, unknown>) => ({ ...input, legacy_statistical_model: null });

// ---------------------------------------------------------------- cached AI calls
interface Answer {
  status: 'OK' | 'INVALID' | 'ERROR';
  side?: string;
  confidence?: string | null;
  violations?: string[];
  tokens: number;
}
const cache = new Map<string, Answer>();
try {
  for (const line of (await readFile(CACHE, 'utf8')).split('\n')) if (line.trim()) {
    const x = JSON.parse(line) as { key: string; answer: Answer };
    cache.set(x.key, x.answer);
  }
} catch {
  /* no cache yet */
}
await mkdir(dirname(CACHE), { recursive: true });

async function decide(input: Record<string, unknown>, options: HybridOption[]): Promise<Answer> {
  const violations: string[] = [];
  let tokens = 0;
  for (let attempt = 1; attempt <= HYBRID_MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await decider!.decide(input);
    } catch (err) {
      return { status: 'ERROR', violations: [String(err).slice(0, 200)], tokens };
    }
    const u = res.usage as { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
    tokens += (u.input_tokens ?? u.prompt_tokens ?? 0) + (u.output_tokens ?? u.completion_tokens ?? 0);
    if (res.refusal || res.output === null) {
      violations.push(`attempt ${attempt}: ${res.refusal ? 'refusal' : 'unparseable'}`);
      if (res.refusal) break;
      continue;
    }
    const v = validateHybridOutput(res.output, input, options);
    if (!v.ok || !v.decision) {
      violations.push(...v.violations.map((x) => `attempt ${attempt}: ${x}`));
      continue;
    }
    return { status: 'OK', side: v.decision.side, confidence: v.decision.confidence, tokens };
  }
  return { status: 'INVALID', violations, tokens };
}

const jobs: Array<{ key: string; live: Live; variant: 'A' | 'B' }> = [];
for (const live of lives) {
  for (let i = 1; i <= RUNS_A; i++) jobs.push({ key: `${live.decisionId}|${HYBRID_PROMPT_VERSION}|A${i}`, live, variant: 'A' });
  for (let i = 1; i <= RUNS_B; i++) jobs.push({ key: `${live.decisionId}|${HYBRID_PROMPT_VERSION}|B${i}`, live, variant: 'B' });
}
const todo = jobs.filter((j) => !cache.has(j.key));
console.log(`${lives.length} live EARLY decisions · ${jobs.length} replay calls · ${jobs.length - todo.length} cached · ${todo.length} to run · prompt ${HYBRID_PROMPT_VERSION} · model ${env.OPENAI_MODEL}`);

if (!values['report-only'] && todo.length) {
  let next = 0;
  let done = 0;
  const started = Date.now();
  await Promise.all(
    Array.from({ length: Number(values.workers) }, async () => {
      while (next < todo.length) {
        const j = todo[next++]!;
        const input = j.variant === 'A' ? j.live.input : withoutDc(j.live.input);
        const answer = await decide(input, optionsOf(j.live.input));
        if (answer.status === 'ERROR') {
          console.log(`  ERROR ${j.key}: ${answer.violations?.[0]}`);
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
  fixtureId: number;
  side: string;
  market: string;
  selection: string;
  line: number;
  odds: number;
  expected: number;
  outcome: Outcome;
  profit: number;
  clv: number | null;
}
const clvCache = new Map<string, number | null>();
async function settlePick(live: Live, o: { side: string; market: string; selection: string; line: number; odds: number; expected: number }): Promise<Settled> {
  const sel = o.market === 'ASIAN_HANDICAP' ? ({ market: 'ASIAN_HANDICAP', selection: o.selection as 'HOME' | 'AWAY', line: o.line } as const) : ({ market: 'OVER_UNDER', selection: o.selection as 'OVER' | 'UNDER', line: o.line } as const);
  const outcome = settle(sel, live.gh, live.ga) as Outcome;
  const profit = { WIN: o.odds - 1, HALF_WIN: (o.odds - 1) / 2, PUSH: 0, HALF_LOSS: -0.5, LOSS: -1 }[outcome];
  const k = `${live.fixtureId}|${o.market}|${o.selection}|${o.line}|${o.odds}`;
  if (!clvCache.has(k)) clvCache.set(k, closingLineValue(o.odds, await repo.closingOdds(live.fixtureId, o.market, o.selection, o.line))?.clv ?? null);
  return { fixtureId: live.fixtureId, ...o, outcome, profit, clv: clvCache.get(k)! };
}
const pickOf = (live: Live, side: string | undefined) => (side && side !== 'NO_PICK' ? optionsOf(live.input).find((o) => o.side === side) ?? null : null);

/** the option chosen by at least `need` of the runs (NO_PICK counts as an answer), else null */
function vote(answers: Array<Answer | undefined>, need: number): string | null {
  const counts = new Map<string, number>();
  for (const a of answers) if (a?.status === 'OK' && a.side) counts.set(a.side, (counts.get(a.side) ?? 0) + 1);
  for (const [side, n] of counts) if (n >= need) return side;
  return null;
}

const variants: Record<string, Settled[]> = {};
const add = async (name: string, live: Live, side: string | null | undefined) => {
  variants[name] ??= [];
  const o = pickOf(live, side ?? undefined);
  if (o) variants[name]!.push(await settlePick(live, { side: o.side, market: o.market, selection: o.selection, line: o.line, odds: o.odds, expected: o.marketProbability }));
};
const answered: Record<string, number> = {};
let agreeA12 = 0;
let agreeA1B1 = 0;
let bothA12 = 0;
let bothA1B1 = 0;
for (const live of lives) {
  const A = Array.from({ length: RUNS_A }, (_, i) => cache.get(`${live.decisionId}|${HYBRID_PROMPT_VERSION}|A${i + 1}`));
  const B = Array.from({ length: RUNS_B }, (_, i) => cache.get(`${live.decisionId}|${HYBRID_PROMPT_VERSION}|B${i + 1}`));
  // compare on the same fixtures only: skip a fixture until every run of it is answered
  if (!A.every((a) => a) || !B.every((b) => b)) continue;
  // live, as published (its own stored option)
  variants['live (as published)'] ??= [];
  if (live.side !== 'NO_PICK' && live.market && live.odds) {
    const o = optionsOf(live.input).find((x) => x.side === live.side);
    variants['live (as published)']!.push(await settlePick(live, { side: live.side, market: live.market, selection: live.selection!, line: live.line!, odds: live.odds, expected: o?.marketProbability ?? 0.5 }));
  }
  variants['rules-v0.6 (legacy)'] ??= [];
  const lp = live.legacy?.pick;
  if (lp) variants['rules-v0.6 (legacy)']!.push(await settlePick(live, { side: '-', market: lp.market, selection: lp.selection, line: Number(lp.line), odds: Number(lp.odds), expected: 0.5 }));
  for (const [i, a] of A.entries()) if (a) { answered[`A${i + 1}`] = (answered[`A${i + 1}`] ?? 0) + 1; await add(`A${i + 1}`, live, a.status === 'OK' ? a.side : null); }
  for (const [i, b] of B.entries()) if (b) { answered[`B${i + 1}`] = (answered[`B${i + 1}`] ?? 0) + 1; await add(`B${i + 1}`, live, b.status === 'OK' ? b.side : null); }
  if (A.every((a) => a)) {
    await add('A-maj (≥2 of 3)', live, vote(A, 2));
    await add('A-all (3 of 3)', live, vote(A, RUNS_A));
  }
  if (B.every((b) => b)) await add(`B-all (${RUNS_B} of ${RUNS_B})`, live, vote(B, RUNS_B));
  if (A[0]?.status === 'OK' && A[1]?.status === 'OK') { bothA12++; if (A[0].side === A[1].side) agreeA12++; }
  if (A[0]?.status === 'OK' && B[0]?.status === 'OK') { bothA1B1++; if (A[0].side === B[0].side) agreeA1B1++; }
}

function row(name: string, s: Settled[]) {
  const c = (o: Outcome) => s.filter((x) => x.outcome === o).length;
  const won = c('WIN') + 0.5 * c('HALF_WIN');
  const lost = c('LOSS') + 0.5 * c('HALF_LOSS');
  const u = s.map((x) => x.profit);
  const mu = u.reduce((a, b) => a + b, 0) / Math.max(1, u.length);
  const sd = Math.sqrt(u.reduce((a, b) => a + (b - mu) ** 2, 0) / Math.max(1, u.length - 1));
  const exp = s.reduce((a, x) => a + x.expected, 0) / Math.max(1, s.length);
  const clv = s.map((x) => x.clv).filter((x): x is number => x != null);
  const sides = ['FAVORITE', 'UNDERDOG', 'OVER', 'UNDER'].map((k) => s.filter((x) => x.side === k).length).join('/');
  return {
    variant: name,
    picks: s.length,
    'fav/dog/over/under': sides,
    'W/HW/P/HL/L': `${c('WIN')}/${c('HALF_WIN')}/${c('PUSH')}/${c('HALF_LOSS')}/${c('LOSS')}`,
    'win share': won + lost ? +((100 * won) / (won + lost)).toFixed(1) : null,
    'market exp.': name.startsWith('rules') ? null : +(100 * exp).toFixed(1),
    units: +u.reduce((a, b) => a + b, 0).toFixed(2),
    'units/pick': +mu.toFixed(3),
    '±95%': s.length > 1 ? +((1.96 * sd) / Math.sqrt(s.length)).toFixed(3) : null,
    'CLV mean %': clv.length ? +((100 * clv.reduce((a, b) => a + b, 0)) / clv.length).toFixed(2) : null,
  };
}
const table = Object.entries(variants).map(([k, v]) => row(k, v));
console.log(`\nAnswered per run: ${JSON.stringify(answered)}  (of ${lives.length} fixtures)`);
console.log(`Same answer A1 vs A2 (AI noise): ${agreeA12}/${bothA12} · A1 vs B1 (DC removed): ${agreeA1B1}/${bothA1B1}`);
console.table(table);
await mkdir(dirname(values.out!), { recursive: true });
await writeFile(values.out!, JSON.stringify({ prompt: HYBRID_PROMPT_VERSION, model: env.OPENAI_MODEL, fixtures: lives.length, answered, agreeA12: [agreeA12, bothA12], agreeA1B1: [agreeA1B1, bothA1B1], table, variants }, null, 2));
await db.close();
