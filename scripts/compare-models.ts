/**
 * Research: which 1X2 model (or mix) is worth keeping, with the bookmaker's closing price as the reference?
 * Reads external_odds (scripts/import-football-data.ts). Read-only (no DB writes).
 *
 *   npx tsx scripts/compare-models.ts [--league 39,40 | all] [--book PIN] [--burn-in-days 365] [--refit-days 7]
 *
 * Every number is walk-forward: the Dixon-Coles refit and the Elo ratings only know matches that kicked off
 * before the match being scored. Candidates are scored on the same matches (those with a closing 1X2 price),
 * by log loss, with a paired z against the market (z > 0 candidate better, z < 0 market better).
 * Not covered: dc-impact (needs lineups), tuned per-league parameters, the real ensemble weight per league.
 */
import { parseArgs } from 'node:util';
import {
  eloWalkForward,
  fitDixonColes,
  expectedGoals,
  logLoss3,
  matchContexts,
  outcomeIndex,
  pairedTest,
  priceSelection,
  scoreMatrix,
  sortByTime,
  type DixonColesModel,
  type DixonColesOptions,
  type Probs3,
} from '@fp/analysis';
import { createPgDb, Repository } from '@fp/database';
import { loadDotEnvFile, loadEnv } from '@fp/shared';

const { values } = parseArgs({
  options: {
    league: { type: 'string', default: 'all' },
    book: { type: 'string', default: 'PIN' },
    'burn-in-days': { type: 'string', default: '365' },
    'refit-days': { type: 'string', default: '7' },
  },
});
const book = values.book!;
const burnInMs = Number(values['burn-in-days']) * 86_400_000;
const refitMs = Number(values['refit-days']) * 86_400_000;
const dcOpts: DixonColesOptions = { halfLifeDays: 365, priorStrength: 8, xgWeight: 0.5 };

loadDotEnvFile();
const env = loadEnv();
const db = createPgDb(env.DATABASE_URL);
const repo = new Repository(db);

const SEL = ['HOME', 'DRAW', 'AWAY'] as const;
const mix = (a: Probs3, b: Probs3, w: number): Probs3 => [0, 1, 2].map((k) => w * a[k]! + (1 - w) * b[k]!) as unknown as Probs3;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const f = (v: number, d = 4) => +v.toFixed(d);

interface Row {
  league: number;
  outcome: 0 | 1 | 2;
  market: Probs3;
  dc: Probs3;
  elo: Probs3;
}

const CANDIDATES: Array<{ name: string; p: (r: Row) => Probs3 }> = [
  { name: 'market (reference)', p: (r) => r.market },
  { name: 'Dixon-Coles', p: (r) => r.dc },
  { name: 'Elo', p: (r) => r.elo },
  { name: 'DC + Elo 50/50', p: (r) => mix(r.dc, r.elo, 0.5) },
  { name: 'DC + Elo 70/30', p: (r) => mix(r.dc, r.elo, 0.7) },
  { name: 'market 90 + DC 10', p: (r) => mix(r.market, r.dc, 0.9) },
  { name: 'market 75 + DC 25', p: (r) => mix(r.market, r.dc, 0.75) },
  { name: 'market 50 + DC 50', p: (r) => mix(r.market, r.dc, 0.5) },
  { name: 'market 90 + Elo 10', p: (r) => mix(r.market, r.elo, 0.9) },
  { name: 'market 75 + (DC+Elo 50/50) 25', p: (r) => mix(r.market, mix(r.dc, r.elo, 0.5), 0.75) },
];

async function runLeague(leagueId: number): Promise<Row[]> {
  const matches = sortByTime(await repo.finishedMatches(leagueId));
  if (matches.length === 0) return [];
  const from = new Date(matches[0]!.kickoffAt.getTime() + burnInMs);
  const ctxs = matchContexts(matches, 0); // warm-up 0: ctxs[i] is matches[i]
  const eloP = eloWalkForward(matches, ctxs);
  const priced = (
    await db.query<{ fixture_id: string; selection: string; odds: string }>(
      `select o.fixture_id, o.selection, o.odds from external_odds o
         join fixtures f on f.id = o.fixture_id
        where f.league_id = $1 and o.bookmaker = $2 and o.phase = 'close' and o.market = 'MATCH_WINNER'`,
      [leagueId, book],
    )
  ).rows;
  const closing = new Map<number, Map<string, number>>();
  for (const r of priced) {
    const m = closing.get(Number(r.fixture_id)) ?? new Map<string, number>();
    closing.set(Number(r.fixture_id), m);
    m.set(r.selection, Number(r.odds));
  }

  const out: Row[] = [];
  let model: DixonColesModel | null = null;
  let lastFit = -Infinity;
  matches.forEach((m, i) => {
    if (m.kickoffAt < from) return;
    const q = closing.get(m.fixtureId);
    if (!q || SEL.some((s) => !q.has(s))) return;
    const t = m.kickoffAt.getTime();
    if (!model || t - lastFit >= refitMs) {
      model = fitDixonColes(matches, m.kickoffAt, dcOpts, model ?? undefined);
      lastFit = t;
    }
    const g = expectedGoals(model, m.homeTeamId, m.awayTeamId);
    const mx = scoreMatrix(g.lambda, g.mu, model.rho);
    const inv = SEL.map((s) => 1 / q.get(s)!);
    const tot = inv.reduce((a, b) => a + b, 0);
    out.push({
      league: leagueId,
      outcome: outcomeIndex(m.homeGoals, m.awayGoals),
      market: inv.map((x) => x / tot) as unknown as Probs3,
      dc: SEL.map((s) => priceSelection(mx, { market: 'MATCH_WINNER', selection: s }).probability) as unknown as Probs3,
      elo: eloP[i]!,
    });
  });
  return out;
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
for (const l of leagues) {
  rows.push(...(await runLeague(l.id)));
  console.error(`done ${l.country} ${l.name}`);
}
await db.close();

const loss = (c: (typeof CANDIDATES)[number], rs: Row[]) => rs.map((r) => logLoss3(c.p(r), r.outcome));
const ref = loss(CANDIDATES[0]!, rows);
console.log(`book ${book}, ${rows.length} matches in ${leagues.length} leagues, walk-forward, evaluated from first fixture + ${values['burn-in-days']} days\n`);
console.log('== pooled 1X2 log loss (lower is better); z > 0 candidate beats the market, z < 0 market is better ==');
console.table(
  CANDIDATES.map((c) => {
    const l = loss(c, rows);
    const t = pairedTest(l, ref);
    const perLeague = leagues.map((lg) => {
      const rs = rows.filter((r) => r.league === lg.id);
      return rs.length ? mean(loss(c, rs)) - mean(loss(CANDIDATES[0]!, rs)) : NaN;
    });
    return {
      candidate: c.name,
      logLoss: f(mean(l)),
      'vs market': f(mean(l) - mean(ref)),
      z: f(t.z, 2),
      'leagues better than market': c === CANDIDATES[0] ? '-' : `${perLeague.filter((d) => d < 0).length}/${perLeague.filter((d) => !Number.isNaN(d)).length}`,
    };
  }),
);
