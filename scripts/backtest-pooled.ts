/**
 * Research: does the cross-league model (cup + its teams' domestic leagues) predict the cup better
 * than fitting the cup alone? Walk-forward, no look-ahead. Read-only (no DB writes).
 *
 *   npx tsx scripts/backtest-pooled.ts [--cup 1129] [--warmup 20] [--league-prior 4]
 *
 * Models compared on the same cup matches (1X2 log loss, paired z-test):
 *   base    cup base rates            alone   Dixon-Coles on cup matches only (what other leagues use)
 *   pooled  one DC over everything    cross   fitCrossLeague (two-level)       blend   50/50 alone + cross (production)
 */
import { parseArgs } from 'node:util';
import {
  baseRates,
  crossLeagueExpectedGoals,
  expectedGoals,
  fitCrossLeague,
  fitDixonColes,
  logLoss3,
  mixScoreMatrices,
  outcomeIndex,
  pairedTest,
  priceSelection,
  rps3,
  scoreMatrix,
  sortByTime,
  type DixonColesOptions,
  type MatchRecord,
  type Probs3,
} from '@fp/analysis';
import { createPgDb, Repository } from '@fp/database';
import { CROSS_LEAGUE_CUPS, loadDotEnvFile, loadEnv } from '@fp/shared';

const { values } = parseArgs({
  options: {
    cup: { type: 'string', default: '1129' },
    warmup: { type: 'string', default: '20' },
    'league-prior': { type: 'string', default: '4' },
  },
});
const cup = Number(values.cup);
const domestic = CROSS_LEAGUE_CUPS[cup];
if (!domestic) throw new Error(`league ${cup} is not in CROSS_LEAGUE_CUPS`);
const warmup = Number(values.warmup);
const leaguePrior = Number(values['league-prior']);
// same defaults computeProbabilities uses for an untuned league
const dcOpts: DixonColesOptions = { halfLifeDays: 365, priorStrength: 8, xgWeight: 0.5 };

loadDotEnvFile();
const env = loadEnv();
const db = createPgDb(env.DATABASE_URL);
const repo = new Repository(db);
const cupMatches = sortByTime(await repo.finishedMatches(cup));
const dom = new Map<number, MatchRecord[]>();
for (const l of domestic) dom.set(l, await repo.finishedMatches(l));
await db.close();
const pooled = sortByTime([...cupMatches, ...[...dom.values()].flat()]);
console.log(`cup ${cup}: ${cupMatches.length} finished; domestic ${domestic.join(',')}: ${pooled.length - cupMatches.length} finished`);

const oneXTwo = (mx: number[][]): Probs3 => {
  const p = (selection: 'HOME' | 'DRAW' | 'AWAY') => priceSelection(mx, { market: 'MATCH_WINNER', selection }).probability;
  return [p('HOME'), p('DRAW'), p('AWAY')];
};

type K = 'base' | 'alone' | 'pooled' | 'cross' | 'blend';
const rows: Array<Record<K, Probs3> & { outcome: 0 | 1 | 2 }> = [];
for (let i = warmup; i < cupMatches.length; i++) {
  const m = cupMatches[i]!;
  const alone = fitDixonColes(cupMatches, m.kickoffAt, dcOpts);
  const ga = expectedGoals(alone, m.homeTeamId, m.awayTeamId);
  const aloneMx = scoreMatrix(ga.lambda, ga.mu, alone.rho);
  const pool = fitDixonColes(pooled, m.kickoffAt, dcOpts);
  const gp = expectedGoals(pool, m.homeTeamId, m.awayTeamId);
  const cross = fitCrossLeague(cupMatches, dom, m.kickoffAt, { dixonColes: dcOpts, leaguePrior });
  const gc = crossLeagueExpectedGoals(cross, m.homeTeamId, m.awayTeamId);
  const crossMx = scoreMatrix(gc.lambda, gc.mu, alone.rho);
  rows.push({
    base: baseRates(cupMatches.filter((x) => x.kickoffAt < m.kickoffAt)).p,
    alone: oneXTwo(aloneMx),
    pooled: oneXTwo(scoreMatrix(gp.lambda, gp.mu, pool.rho)),
    cross: oneXTwo(crossMx),
    blend: oneXTwo(mixScoreMatrices(aloneMx, crossMx, 0.5)),
    outcome: outcomeIndex(m.homeGoals, m.awayGoals),
  });
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const ll = (k: K) => rows.map((r) => logLoss3(r[k], r.outcome));
const pick = (p: Probs3) => (p[0] >= p[1] && p[0] >= p[2] ? 0 : p[2] >= p[1] ? 2 : 1);
console.log(`\nevaluated ${rows.length} cup matches (after ${warmup} warm-up)`);
console.table(
  (['base', 'alone', 'pooled', 'cross', 'blend'] as const).map((k) => ({
    model: k,
    logLoss: +mean(ll(k)).toFixed(4),
    rps: +mean(rows.map((r) => rps3(r[k], r.outcome))).toFixed(4),
    accuracy: +mean(rows.map((r) => (pick(r[k]) === r.outcome ? 1 : 0))).toFixed(3),
  })),
);
for (const k of ['pooled', 'cross', 'blend'] as const) {
  const b = pairedTest(ll(k), ll('base'));
  const a = pairedTest(ll(k), ll('alone'));
  console.log(`${k.padEnd(6)} vs base: ${b.meanImprovement.toFixed(4)} (z ${b.z.toFixed(2)})   vs alone: ${a.meanImprovement.toFixed(4)} (z ${a.z.toFixed(2)})`);
}
console.log('(improvement = logloss/match saved; z > 1.28 = better with ~90% confidence, one-sided)');
