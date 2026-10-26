/**
 * Audit 2026-10-26 (A-01, A-02, A-04): would each league's markets pass a gate against the MARKET instead of
 * against league base rates? Report only: it reads model_configs but never changes `enabled`
 * (docs/audit-remediation-plan.md, decision D2). Read-only (no DB writes).
 *
 *   npx tsx scripts/market-gate-report.ts [--league 39,140 | all] [--book PIN] [--phase early|close|both]
 *                                         [--burn-in-days 365] [--refit-days 7]
 *
 * Same target on both sides:
 *  - 1X2: three-way Brier of the model's 1X2 against the market's de-margined 1X2.
 *  - Asian handicap: the market's own line (football-data keeps one, the main line), home side, fair target
 *    (half results weigh ½, pushes out), so quarter lines are scored as they settle.
 *  - Over/under: football-data only keeps the 2.5 line, so this is O/U 2.5 only; other totals lines are not
 *    measured here.
 * The model is the untuned walk-forward Dixon-Coles of scripts/market-rows.ts, so no tuning choice was made on
 * the matches it is scored on. Intervals are 95% and clustered by football day; Holm adjusts the per-league
 * tests of each phase together.
 * "Edge 3–12" rows: the sides a pick rule could choose (model 3 to 12 points above the market), with what the
 * model said, what the market said and what happened.
 */
import { parseArgs } from 'node:util';
import { benchmarkVerdict, clusteredMean, clusterSums, holmAdjust, pairedComparison, twoSidedP, type BenchmarkVerdict, type PairedRow } from '@fp/analysis';
import { createPgDb, Repository } from '@fp/database';
import { loadDotEnvFile, loadEnv } from '@fp/shared';
import { leaguesWithOdds, MARKETS, marketRows, type Market, type OneX2Row, type Phase, type SideRow } from './market-rows.js';

const { values } = parseArgs({
  options: {
    league: { type: 'string', default: 'all' },
    book: { type: 'string', default: 'PIN' },
    phase: { type: 'string', default: 'both' },
    'burn-in-days': { type: 'string', default: '365' },
    'refit-days': { type: 'string', default: '7' },
  },
});
const book = values.book!;
const phases = (values.phase === 'both' ? ['early', 'close'] : [values.phase!]) as Phase[];
const EDGE = { min: 0.03, max: 0.12 };

loadDotEnvFile();
const env = loadEnv();
const db = createPgDb(env.DATABASE_URL);
const repo = new Repository(db);

const wanted = values.league === 'all' ? null : values.league!.split(',').map(Number);
const leagues = await leaguesWithOdds(db, book, wanted);

// the production gate today: SIDES gates AH (and 1X2 through the ensemble), TOTALS gates O/U
const gates = new Map<string, boolean>();
for (const r of (await db.query<{ league_id: number; purpose: string; enabled: boolean }>(`select league_id, purpose, enabled from model_configs_latest`)).rows)
  gates.set(`${r.league_id}|${r.purpose}`, r.enabled);
const gateOf = (league: number, market: Market) =>
  gates.get(`${league}|${market === 'OVER_UNDER' ? 'TOTALS' : market === 'MATCH_WINNER' ? 'ENSEMBLE' : 'SIDES'}`);

const sides: SideRow[] = [];
const oneX2: OneX2Row[] = [];
for (const l of leagues) {
  const r = await marketRows(db, repo, l.id, { book, phases, burnInDays: Number(values['burn-in-days']), refitDays: Number(values['refit-days']) });
  sides.push(...r.sides);
  oneX2.push(...r.oneX2);
  console.error(`done ${l.country} ${l.name}`);
}
await db.close();

/** Scored rows of one league (or all) and market: 1X2 three-way, AH / O/U the first side only (the second is its complement). */
function paired(phase: Phase, market: Market, leagueId?: number): PairedRow[] {
  if (market === 'MATCH_WINNER')
    return oneX2.filter((r) => r.phase === phase && (leagueId === undefined || r.leagueId === leagueId)).map((r) => ({ cluster: r.cluster, weight: 1, model: r.model, market: r.market }));
  return sides
    .filter((r) => r.phase === phase && r.market === market && r.first && (leagueId === undefined || r.leagueId === leagueId))
    .map((r) => ({ cluster: r.cluster, weight: r.weight, model: (r.p - r.y) ** 2, market: (r.q - r.y) ** 2 }));
}

const f4 = (v: number | null) => (v === null ? '-' : +v.toFixed(4));
const ci = (lo: number | null, hi: number | null) => (lo === null || hi === null ? '-' : `${lo >= 0 ? '+' : ''}${lo.toFixed(4)} .. ${hi >= 0 ? '+' : ''}${hi.toFixed(4)}`);
const SHORT: Record<Market, string> = { MATCH_WINNER: '1X2', ASIAN_HANDICAP: 'AH main', OVER_UNDER: 'O/U 2.5' };

console.log(`# market gate report · book ${book} · model untuned Dixon-Coles walk-forward · burn-in ${values['burn-in-days']} days · ${new Date().toISOString().slice(0, 10)}`);
console.log('diff = model Brier − market Brier (below 0 = model better). 95% CI clustered by football day. Holm across all league × market tests of a phase.');
console.log(`verdict floors: ≥ 100 rows and ≥ 20 football days, else INSUFFICIENT_EVIDENCE.\n`);

for (const ph of phases) {
  const tests = leagues
    .flatMap((league) => MARKETS.map((market) => ({ league, market, rows: paired(ph, market, league.id) })))
    .filter((t) => t.rows.length > 0)
    .map((t) => ({ ...t, cmp: pairedComparison(t.rows) }));
  const adjusted = holmAdjust(tests.map((t) => twoSidedP(t.cmp.diff)));
  const tally: Record<string, Record<BenchmarkVerdict, number>> = {};
  const table = tests.map((t, i) => {
    const verdict = benchmarkVerdict(t.cmp.diff, { pAdjusted: adjusted[i] });
    const g = gateOf(t.league.id, t.market);
    (tally[SHORT[t.market]] ??= { MODEL_BETTER: 0, MARKET_BETTER: 0, NO_CLEAR_DIFFERENCE: 0, INSUFFICIENT_EVIDENCE: 0 })[verdict]++;
    return {
      league: `${t.league.country} ${t.league.name}`.slice(0, 34),
      market: SHORT[t.market],
      n: t.cmp.diff.n,
      days: t.cmp.diff.clusters,
      model: f4(t.cmp.model.mean),
      market_: f4(t.cmp.market.mean),
      diff: f4(t.cmp.diff.mean),
      'diff 95% CI': ci(t.cmp.diff.lo, t.cmp.diff.hi),
      'p Holm': adjusted[i] === null ? '-' : +adjusted[i]!.toFixed(3),
      verdict,
      'gate today': g === undefined ? '-' : g ? 'ON' : 'off',
    };
  });
  console.log(`== phase ${ph}: per league ==`);
  console.table(table);
  console.log(`verdicts by market (${ph}):`);
  console.table(tally);

  console.log(`== phase ${ph}: pooled (all leagues) ==`);
  console.table(
    MARKETS.map((mk) => {
      const c = pairedComparison(paired(ph, mk));
      return { market: SHORT[mk], n: c.diff.n, days: c.diff.clusters, model: f4(c.model.mean), market_: f4(c.market.mean), diff: f4(c.diff.mean), 'diff 95% CI': ci(c.diff.lo, c.diff.hi), verdict: benchmarkVerdict(c.diff) };
    }),
  );

  console.log(`== phase ${ph}: sides with the model ${EDGE.min * 100}–${EDGE.max * 100} points above the market (what a pick rule can choose) ==`);
  console.table(
    (['ASIAN_HANDICAP', 'OVER_UNDER'] as const).map((mk) => {
      const rows = sides.filter((r) => r.phase === ph && r.market === mk && r.p - r.q >= EDGE.min && r.p - r.q <= EDGE.max);
      const mean = (v: (r: SideRow) => number) => clusteredMean(clusterSums(rows.map((r) => ({ cluster: r.cluster, weight: r.weight, value: v(r) }))));
      const hit = mean((r) => r.y);
      const cmp = pairedComparison(rows.map((r) => ({ cluster: r.cluster, weight: r.weight, model: (r.p - r.y) ** 2, market: (r.q - r.y) ** 2 })));
      return {
        market: SHORT[mk],
        sides: hit.n,
        days: hit.clusters,
        'model said': f4(mean((r) => r.p).mean),
        'market said': f4(mean((r) => r.q).mean),
        happened: f4(hit.mean),
        'happened 95% CI': ci(hit.lo, hit.hi),
        'Brier diff': f4(cmp.diff.mean),
        'diff 95% CI': ci(cmp.diff.lo, cmp.diff.hi),
      };
    }),
  );
  console.log('');
}
