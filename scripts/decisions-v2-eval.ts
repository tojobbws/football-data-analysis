/**
 * Decisions v2 evaluation pipeline (read-only: no DB writes, no API calls). .scratch/decisions-v2/
 *
 *   npx tsx scripts/decisions-v2-eval.ts                 # report to stdout
 *   npx tsx scripts/decisions-v2-eval.ts --json out.json # also every row, for the dashboard
 *
 * Every system is judged on the same snapshot and the same settlement: the stored DAILY Hybrid AI input of each
 * fixture (hybrid_decisions.input, written before kickoff, input_hash), its main-line options and their median prices,
 * settled on the 90-minute score by `settle`. Systems:
 *   - HYBRID ×3      the published DAILY decision (latest DAILY row of the fixture)
 *   - D v1 replay    Decisions config decisions-v1 (A) on 260 settled inputs (reports/decisions-replay/cache.jsonl, R1)
 *   - D config D     Decisions config D dry-run on the same inputs (reports/decisions-bias/results.jsonl, set hist)
 *   - D shadow       config D live shadow (reports/decisions-shadow/*.jsonl)
 *   - MARKET         the market reference model (decisions-v2 fit): the null model, which never picks
 * Per system: picks, NO_PICK, INVALID, units and ROI at the snapshot price, fair hit rate against the market's
 * expectation, CLV in probability points against the closing consensus of the same side at the same line (the last
 * pre-kickoff quotes; never an input), each with a 95% interval clustered by football day (06:00 Thai), and splits by
 * market, favourite/underdog, odds band and competition type. Per-option probabilities (D v1 predicates) are scored
 * against the market with fair Brier and log loss on every option, picked or not.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  clusteredMean,
  clusterSums,
  clvPoints,
  consensus,
  estimateOptions,
  fairBrier,
  fairLogLoss,
  fairTarget,
  fitMarketScoreModel,
  MARKET_VIEW,
  oddsBand,
  settle,
  unitsFor,
  type HybridOption,
  type HybridSide,
  type Outcome,
} from '@fp/analysis';
import { createPgDb, Repository } from '@fp/database';
import { loadDotEnvFile, loadEnv, NATIONAL_TEAM_COMPETITIONS } from '@fp/shared';

const { values } = parseArgs({ options: { json: { type: 'string' } } });
loadDotEnvFile();
const env = loadEnv();
const db = createPgDb(env.DATABASE_URL!, { max: 2 });
const repo = new Repository(db);

// ---------------------------------------------------------------- answers of the Decisions runs, by hybrid decision id
const lines = async (f: string) => {
  try {
    return (await readFile(f, 'utf8')).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const replay = new Map<number, { choice: string; wins: Record<string, number> }>();
for (const r of await lines('reports/decisions-replay/cache.jsonl')) {
  const [id, , run] = String(r.key).split('|');
  if (run === 'R1' && r.answer?.status === 'OK') replay.set(Number(id), { choice: r.answer.choice, wins: r.answer.wins });
}
const configD = new Map<number, string>();
for (const r of await lines('reports/decisions-bias/results.jsonl')) if (r.exp === 'D' && r.set === 'hist') configD.set(Number(r.decisionId), r.invalid ? 'INVALID' : r.cat);
const shadow = new Map<number, { choice: string; wins: Record<string, number>; afterKickoff: boolean }>();
for (const day of ['2026-11-16', '2026-11-17'])
  for (const r of await lines(`reports/decisions-shadow/${day}.jsonl`)) {
    const pick = r.response.answers.find((a: { name: string }) => a.name === 'pick');
    const wins = Object.fromEntries(r.response.answers.filter((a: { type: string }) => a.type === 'predicate').map((a: { name: string; probability: number }) => [a.name.replace('wins_', ''), a.probability]));
    shadow.set(Number(r.hybridDecisionId), { choice: pick?.choice ?? 'ERROR', wins, afterKickoff: Date.parse(r.calledAt) >= Date.parse(r.kickoffAt) });
  }

// ---------------------------------------------------------------- the snapshots
const { rows } = await db.query<{
  id: string; fixture_id: string; input: Record<string, any>; prompt_version: string; status: string; side: string | null;
  kickoff_at: Date; league_id: number; league: string; status_short: string; gh: number | null; ga: number | null;
}>(`select distinct on (h.fixture_id) h.id, h.fixture_id, h.input, h.prompt_version, h.status, h.side, h.kickoff_at,
          f.league_id, l.name league, f.status_short, coalesce(f.ft_home, f.goals_home) gh, coalesce(f.ft_away, f.goals_away) ga
     from hybrid_decisions h join fixtures f on f.id = h.fixture_id join leagues l on l.id = f.league_id
    where h.engine_version = 'hybrid-ai-v1' and h.publish_round = 'DAILY' and h.engine_mode = 'hybrid'
    order by h.fixture_id, h.decided_at desc, h.id desc`);

function optionsOf(input: Record<string, any>): HybridOption[] {
  const out: HybridOption[] = [];
  for (const o of input.market?.asian_handicap?.options ?? [])
    out.push({ side: o.option, market: 'ASIAN_HANDICAP', selection: o.team_or_total === input.match.home ? 'HOME' : 'AWAY', line: Number(o.line), odds: Number(o.odds_median), marketProbability: Number(o.market_probability_no_vig) });
  for (const o of input.market?.over_under?.options ?? [])
    out.push({ side: o.option, market: 'OVER_UNDER', selection: String(o.team_or_total), line: Number(o.line), odds: Number(o.odds_median), marketProbability: Number(o.market_probability_no_vig) });
  return out;
}
const footballDay = (d: Date) => new Date(d.getTime() + 7 * 3_600_000 - 6 * 3_600_000).toISOString().slice(0, 10);

interface OptionRow { side: HybridSide; market: string; odds: number; mp: number; fitP: number | null; outcome: Outcome | null; closeMp: number | null }
interface Row { decisionId: number; fixtureId: number; day: string; league: string; national: boolean; prompt: string; options: OptionRow[]; fitOk: boolean | null; choices: Record<string, string | null>; wins: Record<string, Record<string, number> | null> }
const out: Row[] = [];
let fitFail = 0;
for (const r of rows) {
  if (!['FT', 'AET', 'PEN'].includes(r.status_short) || r.gh == null || r.ga == null) continue;
  const opts = optionsOf(r.input);
  if (!opts.length) continue;
  const closing = consensus(await repo.closingQuotes(Number(r.fixture_id)), new Date(r.kickoff_at), Infinity);
  const homeAh = opts.find((o) => o.market === 'ASIAN_HANDICAP' && o.selection === 'HOME');
  const ov = opts.find((o) => o.side === 'OVER');
  const x12 = r.input.market?.match_odds_1x2_no_vig;
  let fitP: Map<string, number> | null = null;
  let fitOk: boolean | null = null;
  if (homeAh && ov) {
    const fit = fitMarketScoreModel({ ahHomeLine: homeAh.line, ahHomeProbability: homeAh.marketProbability, ouLine: ov.line, overProbability: ov.marketProbability, drawProbability: x12?.draw ?? null });
    fitOk = fit.ok;
    if (!fit.ok) fitFail++;
    fitP = new Map(estimateOptions(fit, opts, MARKET_VIEW)!.map((e) => [e.side, e.fairProbability]));
  }
  const id = Number(r.id);
  const sh = shadow.get(id);
  out.push({
    decisionId: id,
    fixtureId: Number(r.fixture_id),
    day: footballDay(new Date(r.kickoff_at)),
    league: r.league,
    national: NATIONAL_TEAM_COMPETITIONS.includes(r.league_id),
    prompt: r.prompt_version,
    fitOk,
    options: opts.map((o) => {
      const c = closing.find((x) => x.market === o.market && x.selection === o.selection && x.line != null && Math.abs(x.line - o.line) < 1e-6);
      return { side: o.side, market: o.market, odds: o.odds, mp: o.marketProbability, fitP: fitP?.get(o.side) ?? null, outcome: settle({ market: o.market, selection: o.selection, line: o.line } as never, r.gh!, r.ga!), closeMp: c ? c.marketProbability : null };
    }),
    choices: {
      'HYBRID ×3': r.status === 'OK' ? r.side : 'INVALID',
      'D v1 replay': replay.get(id)?.choice ?? null,
      'D config D (dry-run)': configD.get(id) ?? null,
      'D config D (live shadow)': sh?.choice ?? null,
      MARKET: 'NO_PICK',
    },
    wins: { 'D v1 replay': replay.get(id)?.wins ?? null, 'D config D (live shadow)': sh?.wins ?? null },
  });
}

// ---------------------------------------------------------------- report
const f = (x: number | null | undefined, d = 3) => (x == null ? '   –' : x.toFixed(d));
const ci = (m: ReturnType<typeof clusteredMean>, d = 3) => (m.mean == null ? '–' : `${f(m.mean, d)} [${f(m.lo, d)}, ${f(m.hi, d)}]`);
function systemSummary(name: string, subset: Row[]) {
  const asked = subset.filter((r) => r.choices[name] != null);
  const picks = asked.flatMap((r) => {
    const o = r.options.find((x) => x.side === r.choices[name]);
    return o ? [{ r, o }] : [];
  });
  const invalid = asked.filter((r) => r.choices[name] === 'INVALID' || r.choices[name] === 'ERROR').length;
  const noPick = asked.filter((r) => r.choices[name] === 'NO_PICK').length;
  const units = clusteredMean(clusterSums(picks.map(({ r, o }) => ({ cluster: r.day, value: unitsFor(o.outcome!, o.odds) }))));
  const clv = clusteredMean(clusterSums(picks.filter(({ o }) => o.closeMp != null).map(({ r, o }) => ({ cluster: r.day, value: clvPoints(o.mp, o.closeMp)! }))));
  const hits = picks.map(({ r, o }) => ({ r, o, t: fairTarget(o.outcome) })).filter((x) => x.t);
  const hit = clusteredMean(clusterSums(hits.map((x) => ({ cluster: x.r.day, weight: x.t!.weight, value: x.t!.y }))));
  const exp = hits.reduce((s, x) => s + x.t!.weight * x.o.mp, 0) / Math.max(1e-9, hits.reduce((s, x) => s + x.t!.weight, 0));
  const total = picks.reduce((s, { o }) => s + unitsFor(o.outcome!, o.odds), 0);
  return { name, asked: asked.length, picks: picks.length, noPick, invalid, total, units, clv, hit, exp, picksList: picks };
}

function printSystems(title: string, subset: Row[]) {
  console.log(`\n=== ${title} (${subset.length} settled fixtures, ${new Set(subset.map((r) => r.day)).size} football days)`);
  console.log('system                    asked picks pick% NO_PICK INVALID  units   ROI/pick [95% CI]          fair hit vs mkt     CLV pp [95% CI]          CLV n');
  for (const name of ['HYBRID ×3', 'D v1 replay', 'D config D (dry-run)', 'D config D (live shadow)', 'MARKET']) {
    const s = systemSummary(name, subset);
    if (!s.asked) continue;
    console.log(
      `${name.padEnd(25)} ${String(s.asked).padStart(5)} ${String(s.picks).padStart(5)} ${(100 * s.picks / s.asked).toFixed(0).padStart(4)}% ${String(s.noPick).padStart(7)} ${String(s.invalid).padStart(7)} ${s.total.toFixed(2).padStart(6)}   ${ci(s.units).padEnd(26)} ${s.picks ? `${f(s.hit.mean)} vs ${f(s.exp)}` : "      –        "}   ${s.clv.mean == null ? '–' : `${(100 * s.clv.mean).toFixed(2)} [${(100 * s.clv.lo!).toFixed(2)}, ${(100 * s.clv.hi!).toFixed(2)}]`.padEnd(24)} ${s.clv.n}`,
    );
  }
}

function printSplits(name: string, subset: Row[]) {
  const s = systemSummary(name, subset);
  const groups = new Map<string, typeof s.picksList>();
  for (const p of s.picksList) {
    const keys = [`market:${p.o.market}`, `side:${p.o.side}`, `odds:${oddsBand(p.o.odds)}`, `comp:${p.r.national ? 'national' : 'club'}`];
    for (const k of keys) groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  console.log(`\n--- ${name}: splits (units per pick, 95% CI clustered by day)`);
  for (const [k, ps] of [...groups].sort()) {
    const u = clusteredMean(clusterSums(ps.map(({ r, o }) => ({ cluster: r.day, value: unitsFor(o.outcome!, o.odds) }))));
    console.log(`  ${k.padEnd(28)} n=${String(ps.length).padStart(3)}  ${ci(u)}`);
  }
}

function printProbabilityScores(name: string, subset: Row[]) {
  const pairs: Array<{ day: string; p: number; m: number; t: NonNullable<ReturnType<typeof fairTarget>> }> = [];
  let sumFavDog: number[] = [];
  for (const r of subset) {
    const w = r.wins[name];
    if (!w) continue;
    if (w.FAVORITE != null && w.UNDERDOG != null) sumFavDog.push(w.FAVORITE + w.UNDERDOG);
    for (const o of r.options) {
      const t = fairTarget(o.outcome);
      if (!t || w[o.side] == null) continue;
      pairs.push({ day: r.day, p: Math.min(0.999, Math.max(0.001, w[o.side]!)), m: o.mp, t });
    }
  }
  if (!pairs.length) return;
  const diff = (loss: (p: number, t: (typeof pairs)[0]['t']) => number) =>
    clusteredMean(clusterSums(pairs.map((x) => ({ cluster: x.day, weight: x.t.weight, value: loss(x.p, x.t) - loss(x.m, x.t) }))), 1.959964);
  const mean = (k: 'p' | 'm') => pairs.reduce((s, x) => s + x[k], 0) / pairs.length;
  sumFavDog = sumFavDog.sort((a, b) => a - b);
  console.log(`\n--- ${name}: per-option probabilities, every option (n=${pairs.length}); model − market, below 0 = model better`);
  console.log(`  Brier diff ${ci(diff(fairBrier), 4)}   log-loss diff ${ci(diff(fairLogLoss), 4)}   mean p ${mean('p').toFixed(3)} vs market ${mean('m').toFixed(3)}`);
  console.log(`  fav + dog chance: median ${sumFavDog[sumFavDog.length >> 1]?.toFixed(2)} (must be 1.00 on a half line), min ${sumFavDog[0]?.toFixed(2)}`);
}

console.log(`Decisions v2 evaluation — ${new Date().toISOString()}`);
console.log(`market fit: ${out.filter((r) => r.fitOk).length} ok, ${fitFail} outside ${'±0.002'}, ${out.filter((r) => r.fitOk == null).length} without both main lines`);
const fitErr = out.flatMap((r) => r.options.filter((o) => o.fitP != null).map((o) => Math.abs(o.fitP! - o.mp)));
console.log(`market fit |model − consensus| on the main lines: max ${Math.max(...fitErr).toFixed(4)}`);
printSystems('All settled DAILY snapshots', out);
const replayed = out.filter((r) => r.choices['D v1 replay'] != null);
printSystems('Same 260-fixture set as the dry-runs (paired)', replayed);
printSystems('Live shadow nights 16–17 Nov (paired)', out.filter((r) => r.choices['D config D (live shadow)'] != null));
for (const n of ['HYBRID ×3', 'D v1 replay', 'D config D (dry-run)']) printSplits(n, replayed);
printProbabilityScores('D v1 replay', out);
printProbabilityScores('D config D (live shadow)', out);
if (values.json) await writeFile(values.json, JSON.stringify(out));
await db.close();
