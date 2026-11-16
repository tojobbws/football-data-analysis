/**
 * Research, READ-ONLY: why Hybrid AI answers are rejected (INVALID). No database write, no AI call, no match result read.
 *
 *   npx tsx scripts/research/invalid-audit.ts [--out reports/invalid-audit]
 *
 * Source: every hybrid_decisions row of engine hybrid-ai-v1 (all prompt versions, all rounds).
 *  - each stored violation string ("answer i: attempt n: <reason>") is one rejected AI response; reasons are grouped
 *    by the check that raised them (packages/ai/src/hybrid.ts validateHybridOutput, packages/ai/src/guards.ts)
 *  - every number-guard rejection is traced against the row's stored input (exactly what the AI saw): a rounding of an
 *    input value, a number of the system prompt, a sum / difference / ratio of input values, a general constant, or untraced
 *  - the stored output of each INVALID row (its last answer) is re-validated with today's code for text context
 *  - impact: per fixture and round, whether the decision was delayed or lost, and an upper bound of recoverable decisions
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { allowedNumbers, HYBRID_SYSTEM_PROMPT, inventedNumbers, validateHybridOutput } from '@fp/ai';
import type { HybridOption, HybridSide } from '@fp/analysis';
import { createPgDb } from '@fp/database';
import { loadDotEnvFile, loadEnv } from '@fp/shared';

const { values } = parseArgs({ options: { out: { type: 'string', default: 'reports/invalid-audit' } } });
loadDotEnvFile();
const db = createPgDb(loadEnv().DATABASE_URL!, { max: 2 });

interface Row {
  id: number;
  fixtureId: number;
  round: string;
  prompt: string;
  status: string;
  attempts: number;
  violations: string[];
  votes: Array<{ status: string; side: string | null; attempts: number }> | null;
  output: Record<string, unknown> | null;
  input: Record<string, unknown>;
  decidedAt: Date;
  kickoff: Date;
  match: string;
}
const rows: Row[] = (
  await db.query<Record<string, unknown>>(
    `select d.id, d.fixture_id, d.publish_round, d.prompt_version, d.status, d.attempts, d.violations, d.votes, d.output, d.input,
            d.decided_at, f.kickoff_at, th.name || ' v ' || ta.name match
       from hybrid_decisions d join fixtures f on f.id = d.fixture_id
       join teams th on th.id = f.home_team_id join teams ta on ta.id = f.away_team_id
      where d.engine_version = 'hybrid-ai-v1' order by d.id`,
  )
).rows.map((r) => ({
  id: Number(r.id),
  fixtureId: Number(r.fixture_id),
  round: String(r.publish_round),
  prompt: String(r.prompt_version),
  status: String(r.status),
  attempts: Number(r.attempts),
  violations: (r.violations as string[]) ?? [],
  votes: (r.votes as Row['votes']) ?? null,
  output: (r.output as Record<string, unknown>) ?? null,
  input: r.input as Record<string, unknown>,
  decidedAt: new Date(r.decided_at as string),
  kickoff: new Date(r.kickoff_at as string),
  match: String(r.match),
}));

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

// ---------------------------------------------------------------- 1. parse every rejection
type Category = 'NUMBER_GUARD' | 'BANNED_WORD' | 'SCHEMA' | 'UNPARSEABLE' | 'REFUSAL' | 'MARKET_SIDE' | 'LINE' | 'OPTION_UNAVAILABLE' | 'NO_PICK_FIELDS' | 'CONFIDENCE' | 'API_ERROR';
const categoryOf = (reason: string): Category =>
  reason.startsWith('number not in input') ? 'NUMBER_GUARD'
  : reason.startsWith('banned word') ? 'BANNED_WORD'
  : reason.startsWith('schema:') ? 'SCHEMA'
  : reason.includes('unparseable output') ? 'UNPARSEABLE'
  : reason.startsWith('refusal') ? 'REFUSAL'
  : reason.includes('does not belong to market') ? 'MARKET_SIDE'
  : /main_line .* is not the/.test(reason) ? 'LINE'
  : reason.includes('is not available in the market snapshot') ? 'OPTION_UNAVAILABLE'
  : /NO_PICK (needs|must)/.test(reason) ? 'NO_PICK_FIELDS'
  : reason.includes('needs confidence') ? 'CONFIDENCE'
  : 'API_ERROR';
const WHERE: Record<Category, string> = {
  NUMBER_GUARD: 'packages/ai/src/hybrid.ts:732-733 → guards.ts inventedNumbers() :104-121, allowedNumbers() :76-94',
  BANNED_WORD: 'packages/ai/src/hybrid.ts:731 (BANNED_WORDS guards.ts:12)',
  SCHEMA: 'packages/ai/src/hybrid.ts:708-709 (hybridOutputSchema :661-677)',
  UNPARSEABLE: 'workers/analysis/src/hybrid-job.ts:193-196 (JSON.parse, packages/ai/src/openai.ts:45-49)',
  REFUSAL: 'workers/analysis/src/hybrid-job.ts:192',
  MARKET_SIDE: 'packages/ai/src/hybrid.ts:719',
  LINE: 'packages/ai/src/hybrid.ts:723',
  OPTION_UNAVAILABLE: 'packages/ai/src/hybrid.ts:721-722',
  NO_PICK_FIELDS: 'packages/ai/src/hybrid.ts:715-717',
  CONFIDENCE: 'packages/ai/src/hybrid.ts:720',
  API_ERROR: 'workers/analysis/src/hybrid-job.ts:187-190',
};

interface Rejection {
  rowId: number;
  answer: number;
  attempt: number;
  reasons: string[];
  categories: Set<Category>;
}
const rejections = new Map<string, Rejection>();
for (const r of rows)
  for (const v of r.violations) {
    const m = v.match(/^(?:answer (\d+): )?(?:attempt (\d+): )?(.*)$/s)!;
    const key = `${r.id}|${m[1] ?? 1}|${m[2] ?? 0}`;
    const x = rejections.get(key) ?? { rowId: r.id, answer: Number(m[1] ?? 1), attempt: Number(m[2] ?? 0), reasons: [], categories: new Set<Category>() };
    x.reasons.push(m[3]!);
    x.categories.add(categoryOf(m[3]!));
    rejections.set(key, x);
  }

// ---------------------------------------------------------------- 2. trace each number-guard rejection to the input
const PROMPT_NUMBERS = new Set([...HYBRID_SYSTEM_PROMPT.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0])));
const CONSTANTS = new Set([90, 45, 11, 100, 120]);
type Trace = 'THOUSANDS_SEPARATOR' | 'PROMPT_CONSTANT' | 'MATCH_TOTAL' | 'MATCH_DIFFERENCE' | 'WINDOW_TOTAL' | 'WINDOW_DIFFERENCE' | 'TWO_TEAM_SUM' | 'TWO_TEAM_DIFFERENCE' | 'NEAR_MISS' | 'FOOTBALL_CONSTANT' | 'UNTRACED';
const byRow = new Map(rows.map((r) => [r.id, r]));
const allowedCache = new Map<number, number[]>();
/** values of the summaries (windows, tables, Elo, market): the pool for sums and differences */
/**
 * Named derivations a football reader would make from the input (not every sum of any two numbers: with hundreds of
 * values almost any figure is some sum). Each is a value the AI could have computed itself, with its meaning.
 */
type Derived = { trace: Trace; detail: string; value: number };
const derivedCache = new Map<number, Derived[]>();
function derivations(input: Record<string, unknown>): Derived[] {
  const out: Derived[] = [];
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const add = (trace: Trace, detail: string, v: number | null) => v !== null && out.push({ trace, detail, value: Math.round(v * 1e6) / 1e6 });
  const teams = [['home', input.home_team], ['away', input.away_team]] as const;
  const windows = ['last_10', 'last_5', 'home_matches_in_last_10', 'away_matches_in_last_10'];
  const pairs: Array<[string, string]> = [['goals_for_avg', 'goals_against_avg'], ['xg_for_avg', 'xg_against_avg'], ['npxg_for_avg', 'npxg_against_avg'], ['shots_on_target_for_avg', 'shots_on_target_against_avg']];
  for (const [side, t] of teams) {
    const team = (t ?? {}) as Record<string, unknown>;
    for (const m of (team.recent_matches as Array<Record<string, unknown>>) ?? []) {
      const [gf, ga] = String(m.score_for_against ?? '').split('-').map(Number);
      if (Number.isFinite(gf) && Number.isFinite(ga)) add('MATCH_TOTAL', `${side} ${m.date_utc} goals ${gf}+${ga}`, gf! + ga!);
      const xf = num(m.xg_for), xa = num(m.xg_against);
      if (xf !== null && xa !== null) {
        add('MATCH_TOTAL', `${side} ${m.date_utc} xG ${xf}+${xa}`, xf + xa);
        add('MATCH_DIFFERENCE', `${side} ${m.date_utc} xG ${xf}−${xa}`, Math.abs(xf - xa));
      }
      const nf = num(m.npxg_for), na = num(m.npxg_against);
      if (nf !== null && na !== null) add('MATCH_TOTAL', `${side} ${m.date_utc} npxG ${nf}+${na}`, nf + na);
    }
    for (const w of windows) {
      const W = (team[w] ?? {}) as Record<string, unknown>;
      for (const [a, b] of pairs) {
        const x = num(W[a]), y = num(W[b]);
        if (x !== null && y !== null) {
          add('WINDOW_TOTAL', `${side}.${w} ${a}+${b}`, x + y);
          add('WINDOW_DIFFERENCE', `${side}.${w} ${a}−${b}`, Math.abs(x - y));
        }
      }
      const matches = num(W.matches);
      for (const k of ['goals_for_avg', 'goals_against_avg', 'xg_for_avg', 'xg_against_avg']) {
        const x = num(W[k]);
        if (x !== null && matches) add('WINDOW_TOTAL', `${side}.${w} ${k}×${matches}`, x * matches);
      }
    }
  }
  const H = (input.home_team ?? {}) as Record<string, Record<string, unknown>>;
  const A = (input.away_team ?? {}) as Record<string, Record<string, unknown>>;
  for (const w of ['last_10', 'last_5']) {
    for (const k of ['goals_for_avg', 'goals_against_avg', 'xg_for_avg', 'xg_against_avg', 'npxg_for_avg', 'npxg_against_avg', 'shots_on_target_for_avg', 'xpts_avg']) {
      const x = num(H[w]?.[k]), y = num(A[w]?.[k]);
      if (x !== null && y !== null) {
        add('TWO_TEAM_SUM', `home+away ${w}.${k}`, x + y);
        add('TWO_TEAM_DIFFERENCE', `home−away ${w}.${k}`, Math.abs(x - y));
      }
    }
    // expected goals of each side from its attack and the opponent's defence
    const hx = num(H[w]?.xg_for_avg), ax = num(A[w]?.xg_against_avg), axf = num(A[w]?.xg_for_avg), hxa = num(H[w]?.xg_against_avg);
    if (hx !== null && ax !== null) add('TWO_TEAM_SUM', `home xg_for + away xg_against ${w}`, hx + ax);
    if (axf !== null && hxa !== null) add('TWO_TEAM_SUM', `away xg_for + home xg_against ${w}`, axf + hxa);
  }
  const hv = num(H.home_matches_in_last_10?.goals_for_avg), av = num(A.away_matches_in_last_10?.goals_for_avg);
  if (hv !== null && av !== null) add('TWO_TEAM_SUM', 'home(home) + away(away) goals_for_avg', hv + av);
  for (const k of ['points', 'rank', 'goalDiff', 'played']) {
    const x = num(H.league_table?.[k]), y = num(A.league_table?.[k]);
    if (x !== null && y !== null) add('TWO_TEAM_DIFFERENCE', `league_table.${k}`, Math.abs(x - y));
  }
  const rh = num((H as unknown as Record<string, unknown>).rest_days_before_this_match), ra = num((A as unknown as Record<string, unknown>).rest_days_before_this_match);
  if (rh !== null && ra !== null) add('TWO_TEAM_DIFFERENCE', 'rest days', Math.abs(rh - ra));
  return out;
}
function trace(raw: string, input: Record<string, unknown>, rowId: number): { trace: Trace; detail: string } {
  const pct = raw.endsWith('%');
  const s = raw.replace('%', '');
  const n = Number(s.replace(',', '.'));
  const dec = s.split(/[.,]/)[1]?.length ?? 0;
  const tol = 0.5 * 10 ** -dec + 1e-9;
  // "1,474" read by the guard as 1.474 (comma as a decimal mark) while the input holds 1474 (an Elo rating)
  if (/^\d{1,3},\d{3}$/.test(s)) {
    const whole = Number(s.replace(',', ''));
    const allowedW = allowedCache.get(rowId) ?? allowedNumbers(input);
    allowedCache.set(rowId, allowedW);
    if (allowedW.some((a) => Math.abs(Math.abs(a) - whole) <= 0.5)) return { trace: 'THOUSANDS_SEPARATOR', detail: `${s} = ${whole}, in the input` };
  }
  if (!pct && PROMPT_NUMBERS.has(n)) return { trace: 'PROMPT_CONSTANT', detail: `${n} appears in the system prompt` };
  const ds = derivedCache.get(rowId) ?? derivations(input);
  derivedCache.set(rowId, ds);
  const hit = !pct ? ds.find((d) => Math.abs(d.value - n) <= tol) : undefined;
  if (hit) return { trace: hit.trace, detail: hit.detail };
  const allowed = allowedCache.get(rowId) ?? allowedNumbers(input);
  allowedCache.set(rowId, allowed);
  const near = allowed.map((a) => Math.abs(a)).reduce((best, a) => (Math.abs(a - n) < Math.abs(best - n) ? a : best), Infinity);
  // close to an input value but outside the guard's rounding tolerance: a mis-copied value
  if (!pct && Math.abs(near - n) <= Math.max(0.051, Math.abs(n) * 0.02)) return { trace: 'NEAR_MISS', detail: `nearest input value ${near}` };
  if (CONSTANTS.has(n)) return { trace: 'FOOTBALL_CONSTANT', detail: `${n}` };
  return { trace: 'UNTRACED', detail: `nearest input value ${near === Infinity ? '-' : near}` };
}
const numberHits: Array<{ rowId: number; prompt: string; raw: string; trace: Trace; detail: string }> = [];
for (const x of rejections.values())
  for (const reason of x.reasons) {
    const m = reason.match(/^number not in input: (.+)$/);
    if (!m) continue;
    const r = byRow.get(x.rowId)!;
    numberHits.push({ rowId: x.rowId, prompt: r.prompt, raw: m[1]!, ...trace(m[1]!, r.input, x.rowId) });
  }

// ---------------------------------------------------------------- 3. text context: re-validate the stored output of INVALID rows
const examples: Array<Record<string, unknown>> = [];
for (const r of rows.filter((x) => x.status !== 'OK' && x.output)) {
  const v = validateHybridOutput(r.output, r.input, optionsOf(r.input));
  const out = r.output as Record<string, unknown>;
  const texts: string[] = [
    out.summary_th, out.team_assessment_th, out.match_outlook_th, out.market_comparison_th,
    ...((out.supporting_evidence as string[]) ?? []), ...((out.counter_evidence as string[]) ?? []), ...((out.risk_factors as string[]) ?? []), ...((out.missing_data as string[]) ?? []),
    ...(((out.options_review as Array<{ supporting_evidence: string[]; counter_evidence: string[] }>) ?? []).flatMap((o) => [...o.supporting_evidence, ...o.counter_evidence])),
  ].filter((t): t is string => typeof t === 'string');
  const allowed = allowedNumbers(r.input);
  const snippets = texts.flatMap((t) =>
    inventedNumbers(t, allowed).map((n) => {
      const i = t.indexOf(n.replace('%', ''));
      return { number: n, ...trace(n, r.input, r.id), text: t.slice(Math.max(0, i - 90), i + 60) };
    }),
  );
  examples.push({ rowId: r.id, match: r.match, round: r.round, prompt: r.prompt, side: out.side, market: out.market, main_line: out.main_line, confidence: out.confidence, revalidatedToday: v.violations, snippets });
}

// ---------------------------------------------------------------- 4. impact per fixture and round
interface Impact { fixtureId: number; round: string; prompt: string; match: string; decisions: number; firstStatus: string; finalOk: boolean; delayMin: number | null }
const groups = new Map<string, Row[]>();
for (const r of rows) {
  const k = `${r.fixtureId}|${r.round}`;
  groups.set(k, [...(groups.get(k) ?? []), r]);
}
const impacts: Impact[] = [];
for (const rs of groups.values()) {
  if (!rs.some((r) => r.status !== 'OK')) continue;
  const firstOk = rs.find((r) => r.status === 'OK');
  impacts.push({
    fixtureId: rs[0]!.fixtureId,
    round: rs[0]!.round,
    prompt: rs[0]!.prompt,
    match: rs[0]!.match,
    decisions: rs.length,
    firstStatus: rs[0]!.status,
    finalOk: Boolean(firstOk),
    delayMin: firstOk ? Math.round((firstOk.decidedAt.getTime() - rs[0]!.decidedAt.getTime()) / 60_000) : null,
  });
}

// upper bound of recoverable INVALID decisions: the final attempt of every rejected answer failed only on number-guard
// hits traced to a rounding, a prompt constant or a football constant (the "format" false positives), and with those
// answers counted valid the row would have enough valid answers to reach or rule out a majority
// S1 guard parsing only (a thousands separator read as a decimal mark)
// S2 S1 + the derived figures the AI computed are given in the input (match / window totals and differences, two-team
//    sums and differences) or named in the prompt (prompt constants): the guard is unchanged, the number then exists
const S1: Trace[] = ['THOUSANDS_SEPARATOR'];
const S2: Trace[] = [...S1, 'PROMPT_CONSTANT', 'MATCH_TOTAL', 'MATCH_DIFFERENCE', 'WINDOW_TOTAL', 'WINDOW_DIFFERENCE', 'TWO_TEAM_SUM', 'TWO_TEAM_DIFFERENCE'];
const finalAttempt = (rowId: number, answer: number) => [...rejections.values()].filter((x) => x.rowId === rowId && x.answer === answer).sort((a, b) => b.attempt - a.attempt)[0];
const recoverable: Array<Record<string, unknown>> = [];
for (const r of rows.filter((x) => x.status === 'INVALID')) {
  const answers = r.votes ?? [{ status: 'INVALID', side: null, attempts: r.attempts }];
  const validNow = answers.filter((a) => a.status === 'OK').length;
  const under = (fix: Trace[]) => {
    let valid = validNow;
    answers.forEach((a, i) => {
      if (a.status !== 'INVALID') return;
      const f = finalAttempt(r.id, i + 1);
      if (!f) return;
      const nums = f.reasons.map((x) => x.match(/^number not in input: (.+)$/)?.[1]);
      if (nums.every((n) => n !== undefined && fix.includes(trace(n!, r.input, r.id).trace))) valid++;
    });
    return valid;
  };
  const why = answers.flatMap((a, i) => {
    const f = a.status === 'INVALID' ? finalAttempt(r.id, i + 1) : undefined;
    return f ? [`answer ${i + 1}: ${f.reasons.map((x) => { const n = x.match(/^number not in input: (.+)$/)?.[1]; return n ? `${n} [${trace(n, r.input, r.id).trace}]` : x; }).join('; ')}`] : [];
  });
  const need = r.votes ? 2 : 1;
  const s1 = under(S1);
  const s2 = under(S2);
  // "could decide" is an upper bound: enough valid answers to reach or rule out a majority; their agreement is unknown
  recoverable.push({ rowId: r.id, fixtureId: r.fixtureId, round: r.round, prompt: r.prompt, match: r.match, validNow, validS1: s1, validS2: s2, couldDecideS1: s1 >= need, couldDecideS2: s2 >= need, why });
}

// retries: re-asked on the same input with no feedback, does the second attempt repeat the rejection?
const retry = { answersRejectedFirst: 0, secondAlsoRejected: 0, sameNumberAgain: 0 };
for (const x of rejections.values()) {
  if (x.attempt !== 1) continue;
  const second = rejections.get(`${x.rowId}|${x.answer}|2`);
  const row = byRow.get(x.rowId)!;
  const answerAttempts = row.votes ? row.votes[x.answer - 1]?.attempts ?? 1 : row.attempts;
  if (answerAttempts < 2 && !second) continue; // no second attempt was made (e.g. the API stopped)
  retry.answersRejectedFirst++;
  if (second) {
    retry.secondAlsoRejected++;
    if (second.reasons.some((r) => x.reasons.includes(r))) retry.sameNumberAgain++;
  }
}

// ---------------------------------------------------------------- report
const responses = rows.reduce((s, r) => s + r.attempts, 0);
const count = <T extends string>(xs: T[]) => Object.entries(xs.reduce<Record<string, number>>((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {})).sort((a, b) => b[1] - a[1]);
const rej = [...rejections.values()];
const catCounts = count(rej.flatMap((x) => [...x.categories]));
const byPrompt = count(rows.map((r) => r.prompt));
const report = {
  rows: rows.length,
  rowsByStatus: count(rows.map((r) => r.status)),
  rowsByPrompt: byPrompt,
  aiResponses: responses,
  rejectedResponses: rej.length,
  rejectedByPrompt: count(rej.map((x) => byRow.get(x.rowId)!.prompt)),
  rejectionRateByPrompt: Object.fromEntries(byPrompt.map(([p]) => [p, `${rej.filter((x) => byRow.get(x.rowId)!.prompt === p).length}/${rows.filter((r) => r.prompt === p).reduce((s, r) => s + r.attempts, 0)}`])),
  categories: catCounts.map(([c, n]) => ({ category: c, rejectedResponses: n, where: WHERE[c as Category] })),
  numberHits: numberHits.length,
  numberTrace: count(numberHits.map((h) => h.trace)),
  numberTraceV20: count(numberHits.filter((h) => h.prompt === 'hybrid-ai-v2.0').map((h) => h.trace)),
  numberExamples: Object.fromEntries((['THOUSANDS_SEPARATOR', 'PROMPT_CONSTANT', 'MATCH_TOTAL', 'MATCH_DIFFERENCE', 'WINDOW_TOTAL', 'WINDOW_DIFFERENCE', 'TWO_TEAM_SUM', 'TWO_TEAM_DIFFERENCE', 'NEAR_MISS', 'FOOTBALL_CONSTANT', 'UNTRACED'] as Trace[]).map((t) => [t, numberHits.filter((h) => h.trace === t).slice(0, 8)])),
  impacts,
  impactSummary: {
    roundsWithInvalid: impacts.length,
    decidedLater: impacts.filter((i) => i.finalOk).length,
    neverDecided: impacts.filter((i) => !i.finalOk).length,
    delayMinutes: impacts.filter((i) => i.delayMin !== null).map((i) => i.delayMin),
  },
  okRowsWithRejectedAttempts: rows.filter((r) => r.status === 'OK' && r.violations.length).length,
  retry,
  recoverable,
  examples,
};
await mkdir(values.out!, { recursive: true });
await writeFile(`${values.out}/report.json`, JSON.stringify(report, null, 2));

console.log(`rows ${rows.length} · AI responses ${responses} · rejected responses ${rej.length} (${((100 * rej.length) / responses).toFixed(1)}%)`);
console.log('rows by status', report.rowsByStatus, '\nrejection rate by prompt', report.rejectionRateByPrompt);
console.table(report.categories);
console.log(`number-guard hits ${numberHits.length}`);
console.table(report.numberTrace.map(([t, n]) => ({ trace: t, hits: n, v20: report.numberTraceV20.find((x) => x[0] === t)?.[1] ?? 0 })));
for (const [t, xs] of Object.entries(report.numberExamples)) if (xs.length) console.log(t, xs.slice(0, 5).map((x) => `${x.raw} (${x.detail})`).join(' · '));
console.log('\nimpact', JSON.stringify(report.impactSummary));
console.table(impacts.map((i) => ({ fixture: i.fixtureId, match: i.match.slice(0, 34), round: i.round, prompt: i.prompt, decisions: i.decisions, finalOk: i.finalOk, delayMin: i.delayMin })));
console.log(`OK rows that needed a retry after a rejection: ${report.okRowsWithRejectedAttempts}`);
console.log('retry without feedback', JSON.stringify(retry));
console.table(recoverable.map((x) => ({ row: x.rowId, fixture: x.fixtureId, match: String(x.match).slice(0, 26), prompt: x.prompt, validNow: x.validNow, S1: x.validS1, S2: x.validS2, decideS1: x.couldDecideS1, decideS2: x.couldDecideS2 })));
for (const x of recoverable) console.log(x.rowId, (x.why as string[]).join(' | '));
await db.close();
