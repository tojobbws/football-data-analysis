/**
 * Research: does per-league tuning of Dixon-Coles actually move it toward the market, measured honestly?
 * Read-only (no DB writes). Reads finished fixtures and the closing 1X2 from external_odds.
 *
 *   npx tsx scripts/walk-forward-vs-market.ts [--league 135,128 | all] [--book PIN] [--folds 3] [--test-share 0.45] [--refit-days 14]
 *
 * Method (rolling origin, no look-ahead anywhere):
 *  - Every prediction is walk-forward: the Dixon-Coles refit only knows matches that kicked off before it.
 *  - The last `test-share` of the priced matches is cut into `folds` consecutive blocks. For each block the
 *    settings are chosen by 1X2 log loss on every evaluated match BEFORE the block starts, then scored on the
 *    block. So the choice never sees the matches it is scored on.
 *  - Scored against the market (closing price, proportional de-vig) on the same matches, with a paired z
 *    (z > 0 candidate better, z < 0 market better). Holm correction across leagues for the per-league tests.
 *  - "production" = the SIDES settings in model_configs today, scored only on matches after the share of the
 *    league its tuner could have used to choose them (the first 70% of what existed when it ran).
 *  - Underdog lean: for the home/away side the market rates lower, mean(model p - market p), and in the
 *    matches where the model rates that side 3+ points above the market, how often it actually won.
 */
import { parseArgs } from 'node:util';
import {
  DEFAULT_GRID,
  dcWalkForward,
  logLoss3,
  matchContexts,
  pairedTest,
  sortByTime,
  type DixonColesOptions,
  type MatchContext,
  type Probs3,
} from '@fp/analysis';
import { createPgDb, Repository } from '@fp/database';
import { loadDotEnvFile, loadEnv } from '@fp/shared';

const { values } = parseArgs({
  options: {
    league: { type: 'string', default: 'all' },
    book: { type: 'string', default: 'PIN' },
    folds: { type: 'string', default: '3' },
    'test-share': { type: 'string', default: '0.45' },
    'refit-days': { type: 'string', default: '14' },
  },
});
const book = values.book!;
const nFolds = Number(values.folds);
const testShare = Number(values['test-share']);
const refitDays = Number(values['refit-days']);
const UNTUNED: DixonColesOptions = { priorStrength: 3, halfLifeDays: 240, xgWeight: 0.5 };
const PROD_TUNE_SHARE = 0.7; // tuneLeague's default holdoutShare 0.3
const LEAN_EDGE = 0.03; // the pick rules' minEdge

loadDotEnvFile();
const env = loadEnv();
const db = createPgDb(env.DATABASE_URL);
const repo = new Repository(db);

const SEL = ['HOME', 'DRAW', 'AWAY'] as const;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const f = (v: number, d = 4) => (Number.isFinite(v) ? +v.toFixed(d) : NaN);

interface Row {
  league: number;
  fold: number;
  kickoffAt: Date;
  outcome: 0 | 1 | 2;
  market: Probs3;
  tuned: Probs3;
  untuned: Probs3;
  /** null when the match is inside the production tuner's own tuning share */
  production: Probs3 | null;
  /** settings the fold chose (for the report) */
  choice: string;
}

/** Holm step-down: which of the one-sided p-values survive at level alpha. */
function holm(ps: number[], alpha = 0.1): boolean[] {
  const order = ps.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const keep = ps.map(() => false);
  for (let k = 0; k < order.length; k++) {
    if (order[k]!.p > alpha / (order.length - k)) break;
    keep[order[k]!.i] = true;
  }
  return keep;
}
/** one-sided p-value of z (candidate better) */
const pOf = (z: number) => 0.5 * erfc(z / Math.SQRT2);
function erfc(x: number): number {
  const t = 1 / (1 + 0.5 * Math.abs(x));
  const y = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? y : 2 - y;
}

async function closing1x2(leagueId: number): Promise<Map<number, Probs3>> {
  const rows = (
    await db.query<{ fixture_id: string; selection: string; odds: string }>(
      `select o.fixture_id, o.selection, o.odds from external_odds o
         join fixtures f on f.id = o.fixture_id
        where f.league_id = $1 and o.bookmaker = $2 and o.phase = 'close' and o.market = 'MATCH_WINNER'`,
      [leagueId, book],
    )
  ).rows;
  const by = new Map<number, Map<string, number>>();
  for (const r of rows) {
    const m = by.get(Number(r.fixture_id)) ?? new Map<string, number>();
    by.set(Number(r.fixture_id), m);
    m.set(r.selection, Number(r.odds));
  }
  const out = new Map<number, Probs3>();
  for (const [id, q] of by) {
    if (SEL.some((s) => !(q.get(s)! > 1))) continue;
    const inv = SEL.map((s) => 1 / q.get(s)!);
    const tot = inv.reduce((a, b) => a + b, 0);
    out.set(id, inv.map((x) => x / tot) as unknown as Probs3);
  }
  return out;
}

async function productionParams(leagueId: number): Promise<{ params: DixonColesOptions; tunedAt: Date } | null> {
  const r = (
    await db.query<{ params: DixonColesOptions; tuned_at: Date }>(
      `select params, tuned_at from model_configs where league_id = $1 and purpose = 'SIDES' order by tuned_at desc limit 1`,
      [leagueId],
    )
  ).rows[0];
  return r ? { params: r.params, tunedAt: new Date(r.tuned_at) } : null;
}

async function runLeague(leagueId: number): Promise<Row[]> {
  const matches = sortByTime(await repo.finishedMatches(leagueId));
  if (matches.length < 300) return [];
  const warmup = Math.min(150, Math.floor(matches.length * 0.25));
  const ctxs = matchContexts(matches, warmup);
  const market = await closing1x2(leagueId);
  const priced = ctxs.map((c, k) => ({ c, k, q: market.get(matches[c.index]!.fixtureId) })).filter((x) => x.q);
  if (priced.length < 150) return [];

  // test region: the last share of the priced matches, cut into consecutive folds
  const testStart = Math.floor(priced.length * (1 - testShare));
  const foldOf = (j: number) => Math.min(nFolds - 1, Math.floor(((j - testStart) * nFolds) / (priced.length - testStart)));

  const xgShare = matches.filter((m) => m.homeXg != null && m.awayXg != null).length / matches.length;
  const grid: DixonColesOptions[] = [];
  for (const priorStrength of DEFAULT_GRID.priorStrength)
    for (const halfLifeDays of DEFAULT_GRID.halfLifeDays)
      for (const xgWeight of xgShare < 0.15 ? [0] : DEFAULT_GRID.xgWeight) grid.push({ priorStrength, halfLifeDays, xgWeight });

  const run = (o: DixonColesOptions) => dcWalkForward(matches, { warmupMatches: warmup, refitEveryDays: refitDays, dixonColes: o }).map((p) => p.oneXTwo);
  const gridPreds = grid.map(run);
  const untuned = run(UNTUNED);
  const prod = await productionParams(leagueId);
  const prodPreds = prod ? run(prod.params) : null;
  // the production tuner chose its settings on the first 70% of the matches it saw
  const prodSeen = prod ? ctxs.filter((c) => c.kickoffAt < prod.tunedAt).length : 0;
  const prodCut = Math.floor(prodSeen * PROD_TUNE_SHARE);

  const loss = (preds: Probs3[], ks: number[]) => mean(ks.map((k) => logLoss3(preds[k]!, (ctxs[k] as MatchContext).outcome)));
  const out: Row[] = [];
  for (let fold = 0; fold < nFolds; fold++) {
    const block = priced.filter((_, j) => j >= testStart && foldOf(j) === fold);
    if (!block.length) continue;
    const start = block[0]!.c.kickoffAt.getTime();
    const before = ctxs.map((c, k) => (c.kickoffAt.getTime() < start ? k : -1)).filter((k) => k >= 0);
    let best = 0;
    let bestLoss = Infinity;
    gridPreds.forEach((p, g) => {
      const l = loss(p, before);
      if (l < bestLoss) {
        bestLoss = l;
        best = g;
      }
    });
    const o = grid[best]!;
    for (const x of block)
      out.push({
        league: leagueId,
        fold,
        kickoffAt: x.c.kickoffAt,
        outcome: x.c.outcome,
        market: x.q!,
        tuned: gridPreds[best]![x.k]!,
        untuned: untuned[x.k]!,
        production: prodPreds && x.k >= prodCut ? prodPreds[x.k]! : null,
        choice: `prior ${o.priorStrength} · half-life ${o.halfLifeDays} · xG ${o.xgWeight}`,
      });
  }
  return out;
}

type Cand = { name: string; p: (r: Row) => Probs3 | null };
const CANDS: Cand[] = [
  { name: 'tuned (rolling)', p: (r) => r.tuned },
  { name: 'untuned v0.1', p: (r) => r.untuned },
  { name: 'production config', p: (r) => r.production },
];

function vsMarket(c: Cand, rs: Row[]) {
  const rows = rs.filter((r) => c.p(r));
  const cl = rows.map((r) => logLoss3(c.p(r)!, r.outcome));
  const ml = rows.map((r) => logLoss3(r.market, r.outcome));
  const t = pairedTest(cl, ml);
  return { n: rows.length, logLoss: mean(cl), market: mean(ml), z: t.z, ci: [-t.meanImprovement - 1.96 * t.se, -t.meanImprovement + 1.96 * t.se] };
}

/** The home/away side the market rates lower: model minus market, and how the model's leans on it ended. */
function underdog(c: Cand, rs: Row[]) {
  const rows = rs.filter((r) => c.p(r));
  const diffs: number[] = [];
  const lean = { n: 0, won: 0, model: 0, market: 0 };
  for (const r of rows) {
    const k = r.market[0] < r.market[2] ? 0 : 2;
    const m = c.p(r)![k]!;
    diffs.push(m - r.market[k]!);
    if (m - r.market[k]! >= LEAN_EDGE) {
      lean.n++;
      lean.won += Number(r.outcome === k);
      lean.model += m;
      lean.market += r.market[k]!;
    }
  }
  return {
    meanLean: mean(diffs),
    leanN: lean.n,
    leanShare: lean.n / Math.max(1, rows.length),
    won: lean.won / Math.max(1, lean.n),
    modelSaid: lean.model / Math.max(1, lean.n),
    marketSaid: lean.market / Math.max(1, lean.n),
  };
}

const wanted = values.league === 'all' ? null : values.league!.split(',').map(Number);
const leagues = (
  await db.query<{ id: number; name: string; country: string }>(
    `select l.id, l.name, l.country from leagues l
      where exists (select 1 from external_odds o join fixtures f on f.id = o.fixture_id where f.league_id = l.id and o.bookmaker = $1 and o.market = 'MATCH_WINNER')
      order by l.id`,
    [book],
  )
).rows.filter((l) => !wanted || wanted.includes(l.id));

const rows: Row[] = [];
const names = new Map<number, string>();
for (const l of leagues) {
  const t0 = Date.now();
  const rs = await runLeague(l.id);
  rows.push(...rs);
  names.set(l.id, `${l.name} (${l.country})`);
  console.error(`done ${l.country} ${l.name}: ${rs.length} test matches, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
await db.close();

console.log(`book ${book} closing 1X2 · ${rows.length} test matches in ${new Set(rows.map((r) => r.league)).size} leagues · ${nFolds} rolling folds over the last ${testShare * 100}% · refit every ${refitDays} days\n`);

console.log('== pooled 1X2 log loss vs the market (lower is better; z < 0 = market better) ==');
console.table(
  CANDS.map((c) => {
    const v = vsMarket(c, rows);
    return { candidate: c.name, matches: v.n, logLoss: f(v.logLoss), market: f(v.market), 'vs market': f(v.logLoss - v.market), z: f(v.z, 2), 'diff 95% CI': `${f(v.ci[0]!)} .. ${f(v.ci[1]!)}` };
  }),
);

console.log('\n== tuned vs untuned on the same matches (z > 0 = tuning helped) ==');
{
  const t = pairedTest(
    rows.map((r) => logLoss3(r.tuned, r.outcome)),
    rows.map((r) => logLoss3(r.untuned, r.outcome)),
  );
  console.log(`matches ${rows.length} · mean improvement ${f(t.meanImprovement)} · z ${f(t.z, 2)}`);
}

console.log(`\n== underdog lean (side the market rates lower; lean = model at least ${LEAN_EDGE * 100} points above the market) ==`);
console.table(
  CANDS.map((c) => {
    const u = underdog(c, rows);
    return {
      candidate: c.name,
      'mean model - market': f(u.meanLean),
      'lean matches': u.leanN,
      'lean share': f(u.leanShare, 3),
      'lean: won': f(u.won, 3),
      'lean: model said': f(u.modelSaid, 3),
      'lean: market said': f(u.marketSaid, 3),
    };
  }),
);

console.log('\n== per league (Holm across leagues at 10%, one-sided) ==');
const per = [...names.keys()]
  .map((id) => {
    const rs = rows.filter((r) => r.league === id);
    if (!rs.length) return null;
    const tm = vsMarket(CANDS[0]!, rs);
    const tu = pairedTest(
      rs.map((r) => logLoss3(r.tuned, r.outcome)),
      rs.map((r) => logLoss3(r.untuned, r.outcome)),
    );
    const u = underdog(CANDS[0]!, rs);
    const uu = underdog(CANDS[1]!, rs);
    return { id, rs, tm, tu, u, uu };
  })
  .filter((x) => x != null);
const keepMarket = holm(per.map((x) => pOf(x.tm.z)));
const keepTune = holm(per.map((x) => pOf(x.tu.z)));
console.table(
  per.map((x, i) => ({
    league: names.get(x.id),
    matches: x.rs.length,
    'tuned - market': f(x.tm.logLoss - x.tm.market),
    'z vs market': f(x.tm.z, 2),
    'beats market (Holm)': keepMarket[i] ? 'yes' : 'no',
    'z tuned vs untuned': f(x.tu.z, 2),
    'tuning helps (Holm)': keepTune[i] ? 'yes' : 'no',
    'dog lean tuned': f(x.u.meanLean),
    'dog lean untuned': f(x.uu.meanLean),
    'last choice': x.rs[x.rs.length - 1]!.choice,
  })),
);
