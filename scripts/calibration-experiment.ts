/**
 * Audit 2026-10-26, step 6: can a calibration or a market blend make the model's AH / O/U probabilities better
 * out of sample, and does anything reach the market? Read-only; nothing here feeds the site or the pick rules.
 *
 *   npx tsx scripts/calibration-experiment.ts [--league 39,140 | all] [--book PIN] [--phase early|close|both]
 *
 * Rows: scripts/market-rows.ts (walk-forward untuned Dixon-Coles beside the market's de-margined price on the
 * market's own line; AH main line, O/U 2.5), home / over side, fair target (half results weigh ½, pushes out).
 * Methods, each keeping p(side) + p(other side) = 1 so one side scores the line:
 *   model        the raw model
 *   market       the market
 *   blend        w·model + (1 − w)·market
 *   logit blend  σ(w·logit model + (1 − w)·logit market)
 *   temperature  σ(b·logit model)  (b < 1 = the model is over-confident)
 * Every parameter is chosen by weighted Brier on earlier rows only:
 *   walk-forward  each calendar month from the 7th on is scored with parameters fitted on all months before it
 *   final holdout the latest 20% of match days, scored ONCE with parameters fitted on everything before it
 * Pre-set rule (docs/audit-remediation-plan.md): a method counts as better than X only when the 95% interval
 * (clustered by football day) of its Brier minus X's is below 0 on the final holdout.
 */
import { parseArgs } from 'node:util';
import { benchmarkVerdict, clusteredMean, clusterSums, pairedComparison, type ClusteredMean } from '@fp/analysis';
import { createPgDb, Repository } from '@fp/database';
import { loadDotEnvFile, loadEnv } from '@fp/shared';
import { leaguesWithOdds, marketRows, type Phase, type SideRow } from './market-rows.js';

const { values } = parseArgs({
  options: {
    league: { type: 'string', default: 'all' },
    book: { type: 'string', default: 'PIN' },
    phase: { type: 'string', default: 'both' },
  },
});
const phases = (values.phase === 'both' ? ['early', 'close'] : [values.phase!]) as Phase[];
const HOLDOUT_SHARE = 0.2;
const FIRST_SCORED_MONTH = 6; // months of rows before the walk-forward scores anything
const EDGE = { min: 0.03, max: 0.12 };

loadDotEnvFile();
const env = loadEnv();
const db = createPgDb(env.DATABASE_URL);
const repo = new Repository(db);
const leagues = await leaguesWithOdds(db, values.book!, values.league === 'all' ? null : values.league!.split(',').map(Number));
const all: SideRow[] = [];
for (const l of leagues) {
  all.push(...(await marketRows(db, repo, l.id, { book: values.book!, phases, burnInDays: 365, refitDays: 7 })).sides);
  console.error(`done ${l.country} ${l.name}`);
}
await db.close();

const logit = (p: number) => Math.log(Math.max(1e-9, p) / Math.max(1e-9, 1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
type Method = { name: string; grid: number[]; apply: (r: SideRow, k: number) => number };
const steps = (a: number, b: number, s: number) => Array.from({ length: Math.round((b - a) / s) + 1 }, (_, i) => +(a + i * s).toFixed(4));
const METHODS: Method[] = [
  { name: 'model', grid: [0], apply: (r) => r.p },
  { name: 'market', grid: [0], apply: (r) => r.q },
  { name: 'blend', grid: steps(0, 1, 0.05), apply: (r, w) => w * r.p + (1 - w) * r.q },
  { name: 'logit blend', grid: steps(0, 1, 0.05), apply: (r, w) => sigmoid(w * logit(r.p) + (1 - w) * logit(r.q)) },
  { name: 'temperature', grid: steps(0.2, 1.5, 0.05), apply: (r, b) => sigmoid(b * logit(r.p)) },
];
const brier = (rows: readonly SideRow[], f: (r: SideRow) => number) => rows.reduce((a, r) => a + r.weight * (f(r) - r.y) ** 2, 0) / Math.max(1e-12, rows.reduce((a, r) => a + r.weight, 0));
const fit = (m: Method, rows: readonly SideRow[]) => m.grid.reduce((best, k) => (brier(rows, (r) => m.apply(r, k)) < brier(rows, (r) => m.apply(r, best)) ? k : best), m.grid[0]!);
const month = (r: SideRow) => r.cluster.slice(0, 7);

const f4 = (v: number | null) => (v === null ? '-' : +v.toFixed(4));
const ci = (m: ClusteredMean) => (m.lo === null || m.hi === null ? '-' : `${m.lo >= 0 ? '+' : ''}${m.lo.toFixed(4)} .. ${m.hi >= 0 ? '+' : ''}${m.hi.toFixed(4)}`);

console.log(`# calibration / market blend experiment · book ${values.book} · ${new Date().toISOString().slice(0, 10)}`);
console.log('Brier on the fair target (lower is better); diff = method − reference, 95% CI clustered by football day.\n');

for (const phase of phases)
  for (const market of ['ASIAN_HANDICAP', 'OVER_UNDER'] as const) {
    const rows = all.filter((r) => r.phase === phase && r.market === market && r.first).sort((a, b) => a.kickoffAt.getTime() - b.kickoffAt.getTime());
    if (rows.length < 200) continue;
    const days = [...new Set(rows.map((r) => r.cluster))].sort();
    const holdFrom = days[Math.floor(days.length * (1 - HOLDOUT_SHARE))]!;
    const pre = rows.filter((r) => r.cluster < holdFrom);
    const hold = rows.filter((r) => r.cluster >= holdFrom);
    const months = [...new Set(pre.map(month))].sort();

    // walk-forward over the months before the holdout: per method, the score of each row with parameters fitted before its month
    const wf = new Map<string, Array<{ r: SideRow; p: number }>>(METHODS.map((m) => [m.name, []]));
    const chosen = new Map<string, number[]>(METHODS.map((m) => [m.name, []]));
    for (const mo of months.slice(FIRST_SCORED_MONTH)) {
      const train = pre.filter((r) => month(r) < mo);
      const test = pre.filter((r) => month(r) === mo);
      for (const m of METHODS) {
        const k = fit(m, train);
        chosen.get(m.name)!.push(k);
        wf.get(m.name)!.push(...test.map((r) => ({ r, p: m.apply(r, k) })));
      }
    }
    // final holdout: one fit on everything before it, scored once
    const final = new Map(METHODS.map((m) => [m.name, { k: fit(m, pre), rows: [] as Array<{ r: SideRow; p: number }> }]));
    for (const m of METHODS) final.get(m.name)!.rows.push(...hold.map((r) => ({ r, p: m.apply(r, final.get(m.name)!.k) })));

    const score = (xs: Array<{ r: SideRow; p: number }>) => clusteredMean(clusterSums(xs.map((x) => ({ cluster: x.r.cluster, weight: x.r.weight, value: (x.p - x.r.y) ** 2 }))));
    const versus = (a: Array<{ r: SideRow; p: number }>, b: Array<{ r: SideRow; p: number }>) =>
      pairedComparison(a.map((x, i) => ({ cluster: x.r.cluster, weight: x.r.weight, model: (x.p - x.r.y) ** 2, market: (b[i]!.p - x.r.y) ** 2 }))).diff;

    const label = market === 'ASIAN_HANDICAP' ? 'AH main line (home side)' : 'O/U 2.5 (over side)';
    console.log(`== ${phase} · ${label} · ${rows.length} rows · walk-forward ${months.length - FIRST_SCORED_MONTH} months to ${holdFrom} · final holdout ${hold.length} rows from ${holdFrom} ==`);
    console.table(
      METHODS.map((m) => {
        const w = wf.get(m.name)!;
        const fin = final.get(m.name)!;
        const vsMarket = versus(fin.rows, final.get('market')!.rows);
        const vsModel = versus(fin.rows, final.get('model')!.rows);
        const ks = chosen.get(m.name)!;
        return {
          method: m.name,
          'param (final)': m.grid.length > 1 ? fin.k : '-',
          'param range (wf)': m.grid.length > 1 && ks.length ? `${Math.min(...ks)}–${Math.max(...ks)}` : '-',
          'Brier wf': f4(score(w).mean),
          'Brier holdout': f4(score(fin.rows).mean),
          'vs market (holdout)': f4(vsMarket.mean),
          'vs market 95% CI': ci(vsMarket),
          // a blend fitted to w = 0 is the market itself: floating-point noise is not a difference
          verdict: m.name === 'market' ? '-' : Math.abs(vsMarket.mean ?? 1) < 1e-6 && (vsMarket.hi ?? 1) - (vsMarket.lo ?? 0) < 1e-6 ? 'SAME_AS_MARKET' : benchmarkVerdict(vsMarket),
          'vs raw model (holdout)': f4(vsModel.mean),
          'vs model 95% CI': ci(vsModel),
        };
      }),
    );

    // what a pick rule would see on the holdout: sides (both) the RAW model rates 3–12 points above the market
    const holdBoth = all.filter((r) => r.phase === phase && r.market === market && r.cluster >= holdFrom && r.p - r.q >= EDGE.min && r.p - r.q <= EDGE.max);
    const mean = (v: (r: SideRow) => number) => clusteredMean(clusterSums(holdBoth.map((r) => ({ cluster: r.cluster, weight: r.weight, value: v(r) }))));
    const wBlend = final.get('blend')!.k;
    const happened = mean((r) => r.y);
    console.log(
      `holdout sides with raw edge ${EDGE.min * 100}–${EDGE.max * 100} pts: n ${happened.n} · raw model ${f4(mean((r) => r.p).mean)} · blend (w ${wBlend}) ${f4(mean((r) => wBlend * r.p + (1 - wBlend) * r.q).mean)} · market ${f4(mean((r) => r.q).mean)} · happened ${f4(happened.mean)} (${ci(happened)})\n`,
    );
  }
