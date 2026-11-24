/**
 * Gemini Decision replay (owner, 2026-11-24): Gemini answers the Hybrid AI v2.1.1 prompt once on the stored DAILY
 * input of each fixture of past football days (10:00 → 10:00 Thai), exactly as the live shadow does
 * (gemini-decision-job), so its accuracy can be read on settled matches without waiting.
 *
 * Read-only on the database: answers go to reports/gemini-replay/cache.jsonl (one line per fixture; a rerun skips
 * fixtures already answered, so an interrupted run resumes). The call is made after the match, but the input is the
 * one stored before kickoff and the request has no search tool, so Gemini sees nothing the Hybrid AI did not.
 *
 *   npx tsx scripts/gemini-replay.ts --from 2026-11-21 --to 2026-11-22   # ask Gemini (costs Gemini API credit)
 *   npx tsx scripts/gemini-replay.ts --from 2026-11-21 --to 2026-11-22 --report   # no calls: settle and compare
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createGeminiHybridDeciderV21, GEMINI_DECISION_MODEL, HYBRID_PROMPT_VERSION_V211 } from '@fp/ai';
import { hybridInputOptions, settle, type MarketSelection } from '@fp/analysis';
import { createPgDb } from '@fp/database';
import { loadDotEnvFile, loadEnv } from '@fp/shared';
import { askOnce, statusOf } from '../workers/analysis/src/hybrid-job.js';

const { values } = parseArgs({ options: { from: { type: 'string' }, to: { type: 'string' }, report: { type: 'boolean' }, concurrency: { type: 'string' } } });
if (!values.from || !values.to) throw new Error('--from and --to (football days, YYYY-MM-DD) are required');
loadDotEnvFile();
const env = loadEnv();
const db = createPgDb(env.DATABASE_URL!, { max: 2 });
const model = env.GEMINI_DECISION_MODEL ?? GEMINI_DECISION_MODEL;
const DIR = 'reports/gemini-replay';
const CACHE = `${DIR}/cache.jsonl`;

// football day d = [d 10:00, d+1 10:00) Thai = [d 03:00Z, d+1 03:00Z)
const fromTs = `${values.from}T03:00:00Z`;
const toTs = new Date(Date.parse(`${values.to}T03:00:00Z`) + 86_400_000).toISOString();
const { rows } = await db.query<any>(
  `select d.id, d.fixture_id, d.input, d.input_hash, d.status ai_status, d.side ai_side, d.market ai_market, d.selection ai_selection,
          d.line ai_line, d.odds ai_odds, f.kickoff_at, f.status_short, coalesce(f.ft_home, f.goals_home) gh, coalesce(f.ft_away, f.goals_away) ga,
          to_char((f.kickoff_at at time zone 'Asia/Bangkok') - interval '10 hours', 'YYYY-MM-DD') fday,
          th.name home, ta.name away, l.name league
     from (select distinct on (h.fixture_id) h.* from hybrid_decisions h
            where h.publish_round = 'DAILY' and h.input is not null
            order by h.fixture_id, h.decided_at desc, h.id desc) d
     join fixtures f on f.id = d.fixture_id
     join teams th on th.id = f.home_team_id join teams ta on ta.id = f.away_team_id
     join leagues l on l.id = f.league_id
    where d.prompt_version = $3 and f.kickoff_at >= $1::timestamptz and f.kickoff_at < $2::timestamptz
    order by f.kickoff_at, d.fixture_id`,
  [fromTs, toTs, HYBRID_PROMPT_VERSION_V211],
);

const cache = new Map<number, any>();
try {
  for (const l of (await readFile(CACHE, 'utf8')).split('\n')) if (l.trim()) { const r = JSON.parse(l); if (r.model === model) cache.set(r.fixtureId, r); }
} catch { /* first run */ }

if (!values.report) {
  if (!env.GEMINI_API_KEY) throw new Error('no GEMINI_API_KEY');
  const decider = createGeminiHybridDeciderV21({ apiKey: env.GEMINI_API_KEY, model });
  await mkdir(DIR, { recursive: true });
  const queue = rows.filter((r) => !cache.has(Number(r.fixture_id)));
  console.log(`${rows.length} fixtures, ${queue.length} to ask (${model})`);
  let done = 0;
  let stop: string | null = null;
  await Promise.all(
    Array.from({ length: Number(values.concurrency ?? 6) }, async () => {
      for (let r = queue.shift(); r && !stop; r = queue.shift()) {
        const options = hybridInputOptions(r.input);
        if (!options.length) continue;
        const calledAt = new Date().toISOString();
        const a = await askOnce(decider, r.input, options, 'v2.1.1');
        const status = statusOf(a);
        if (status === 'ERROR') {
          console.warn(`ERROR ${r.fixture_id}: ${(a.failure ?? '').slice(0, 200)}`);
          if (a.persistent) stop = a.failure;
          continue;
        }
        const d = status === 'OK' ? a.result!.decision! : null;
        const o = d?.option ?? null;
        const line = {
          fixtureId: Number(r.fixture_id), hybridDecisionId: Number(r.id), inputHash: r.input_hash, model, calledAt, status,
          side: d?.side ?? null, market: o?.market ?? null, selection: o?.selection ?? null, line: o?.line ?? null, odds: o?.odds ?? null,
          confidence: d?.confidence ?? null, attempts: a.attempts, feedbackRetries: a.feedbackRetries ?? 0, latencyMs: a.latencyMs ?? null,
          violations: a.violations, refusal: a.res?.refusal ?? null, output: a.res?.output ?? null, usage: a.res?.usage ?? null,
        };
        await appendFile(CACHE, JSON.stringify(line) + '\n');
        cache.set(line.fixtureId, line);
        done++;
        if (done % 10 === 0) console.log(`${done} answered`);
      }
    }),
  );
  console.log(`answered ${done}${stop ? ` · stopped: ${stop}` : ''}`);
}

// ---------------------------------------------------------------- report: settle both on the same prices
const FIN = ['FT', 'AET', 'PEN'];
type Bet = { market: string; selection: string; line: number; odds: number } | null;
const bet = (ok: boolean, side: string | null, m: string | null, s: string | null, l: any, o: any): Bet =>
  ok && side && side !== 'NO_PICK' && m && s && l != null ? { market: m, selection: s, line: Number(l), odds: Number(o) } : null;
const res = (r: any, b: Bet) => {
  if (!b || !FIN.includes(r.status_short) || r.gh == null || r.ga == null) return null;
  const st = settle({ market: b.market, selection: b.selection, line: b.line } as MarketSelection, r.gh, r.ga);
  return { st, units: ({ WIN: b.odds - 1, HALF_WIN: (b.odds - 1) / 2, PUSH: 0, HALF_LOSS: -0.5, LOSS: -1 } as Record<string, number>)[st] ?? 0 };
};
const same = (a: Bet, b: Bet) => (a && b ? a.market === b.market && a.selection === b.selection && a.line === b.line : !a && !b);
function tally(list: Array<{ b: Bet; r: ReturnType<typeof res> }>) {
  const t = { picks: 0, settled: 0, win: 0, halfWin: 0, push: 0, halfLoss: 0, loss: 0, units: 0 };
  for (const { b, r } of list) {
    if (!b) continue;
    t.picks++;
    if (!r) continue;
    t.settled++;
    t.units += r.units;
    if (r.st === 'WIN') t.win++; else if (r.st === 'HALF_WIN') t.halfWin++; else if (r.st === 'PUSH') t.push++; else if (r.st === 'HALF_LOSS') t.halfLoss++; else t.loss++;
  }
  const decided = t.win + t.halfWin + t.halfLoss + t.loss;
  return { ...t, units: +t.units.toFixed(2), roi: t.settled ? `${((t.units / t.settled) * 100).toFixed(1)}%` : '-', winShare: decided ? `${(((t.win + t.halfWin / 2) / (decided - t.halfWin / 2 - t.halfLoss / 2)) * 100).toFixed(1)}%` : '-' };
}
const L = rows
  .filter((r) => cache.has(Number(r.fixture_id)))
  .map((r) => {
    const c = cache.get(Number(r.fixture_id));
    const g = bet(c.status === 'OK', c.side, c.market, c.selection, c.line, c.odds);
    const a = bet(r.ai_status === 'OK', r.ai_side, r.ai_market, r.ai_selection, r.ai_line, r.ai_odds);
    return { r, c, g, a, gr: res(r, g), ar: res(r, a) };
  });
const block = (name: string, ls: typeof L) => {
  console.log(`\n== ${name}: ${ls.length} fixtures, finished ${ls.filter((l) => FIN.includes(l.r.status_short)).length}`);
  const status: Record<string, number> = {};
  for (const l of ls) { const k = l.c.status === 'OK' ? l.c.side : l.c.status; status[k] = (status[k] ?? 0) + 1; }
  const ai: Record<string, number> = {};
  for (const l of ls) { const k = l.r.ai_status === 'OK' ? l.r.ai_side : l.r.ai_status; ai[k] = (ai[k] ?? 0) + 1; }
  console.log('Gemini answers', status, '\nHybrid answers', ai);
  console.table({ Gemini: tally(ls.map((l) => ({ b: l.g, r: l.gr }))), Hybrid: tally(ls.map((l) => ({ b: l.a, r: l.ar }))) });
  const both = ls.filter((l) => l.c.status === 'OK' && l.r.ai_status === 'OK');
  const bothBets = both.filter((l) => l.g && l.a);
  console.log(`agree ${both.filter((l) => same(l.g, l.a)).length}/${both.length} · both picked ${bothBets.length}, same bet ${bothBets.filter((l) => same(l.g, l.a)).length}, same market opposite ${bothBets.filter((l) => l.g!.market === l.a!.market && l.g!.line === l.a!.line && !same(l.g, l.a)).length}`);
  const split = (who: 'g' | 'a') => {
    const m: Record<string, Array<{ b: Bet; r: ReturnType<typeof res> }>> = {};
    for (const l of ls) { const b = l[who]; if (!b) continue; const side = who === 'g' ? l.c.side : l.r.ai_side; (m[side] ??= []).push({ b, r: who === 'g' ? l.gr : l.ar }); }
    return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, tally(v)]));
  };
  console.log('Gemini by side'); console.table(split('g'));
  console.log('Hybrid by side'); console.table(split('a'));
  const only = (pred: (l: (typeof L)[number]) => boolean) => ls.filter(pred);
  const gOnly = only((l) => !!l.g && !l.a), aOnly = only((l) => !l.g && !!l.a), diff = only((l) => !!l.g && !!l.a && !same(l.g, l.a)), sameB = only((l) => !!l.g && !!l.a && same(l.g, l.a));
  const u = (xs: typeof L, k: 'gr' | 'ar') => xs.reduce((s, l) => s + (l[k]?.units ?? 0), 0).toFixed(2);
  console.log(`same bet ${sameB.length}: ${u(sameB, 'gr')} · Gemini only ${gOnly.length}: ${u(gOnly, 'gr')} · Hybrid only ${aOnly.length}: ${u(aOnly, 'ar')} · different bets ${diff.length}: Gemini ${u(diff, 'gr')} vs Hybrid ${u(diff, 'ar')}`);
};
for (const day of [...new Set(rows.map((r) => r.fday))]) block(`football day ${day}`, L.filter((l) => l.r.fday === day));
block(`all ${values.from} → ${values.to}`, L);
const inv = L.filter((l) => l.c.status !== 'OK');
console.log(`\nINVALID ${inv.length}, feedback retries ${L.reduce((s, l) => s + (l.c.feedbackRetries ?? 0), 0)}`);
const tok = L.reduce((s, l) => { const u = l.c.usage ?? {}; s.prompt += u.promptTokenCount ?? 0; s.out += u.candidatesTokenCount ?? 0; s.thoughts += u.thoughtsTokenCount ?? 0; return s; }, { prompt: 0, out: 0, thoughts: 0 });
console.log('tokens', tok);
process.exit(0);
