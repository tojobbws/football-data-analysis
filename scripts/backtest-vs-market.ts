/**
 * Research: how does the model's walk-forward probability compare with a bookmaker's closing price?
 * Reads external_odds (scripts/import-football-data.ts). Read-only (no DB writes).
 *
 *   npx tsx scripts/backtest-vs-market.ts [--league 39,40 | all] [--book PIN] [--burn-in-days 365] [--refit-days 7]
 *
 * The model is the untuned-league Dixon-Coles the site uses (refit every --refit-days, only matches before kickoff).
 * A league is evaluated from its first stored fixture + --burn-in-days, so the model has a year of results first.
 * Compared on the market's own closing line: 1X2, Asian handicap (main line), over/under 2.5
 * (only the markets a league's files have). Market probability = closing odds with the margin removed proportionally.
 * Betting rows use the closing odds, which nobody can bet at in practice; they show whether the model's
 * disagreement with the closing price was right, not what a bettor would have made.
 */
import { parseArgs } from 'node:util';
import {
  expectedGoals,
  fitDixonColes,
  logLoss3,
  outcomeIndex,
  pairedTest,
  priceSelection,
  scoreMatrix,
  settle,
  sortByTime,
  type DixonColesModel,
  type DixonColesOptions,
  type MarketSelection,
  type Outcome,
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
// same defaults computeProbabilities uses for an untuned league
const dcOpts: DixonColesOptions = { halfLifeDays: 365, priorStrength: 8, xgWeight: 0.5 };

loadDotEnvFile();
const env = loadEnv();
const db = createPgDb(env.DATABASE_URL);
const repo = new Repository(db);

interface Side { selection: string; line: number | null; odds: number }
interface Row3 { model: Probs3; market: Probs3; outcome: 0 | 1 | 2 }
interface RowSide { p: number; q: number; y: number }
interface Bet { edge: number; profit: number; won: boolean }
type MarketKey = 'MATCH_WINNER' | 'ASIAN_HANDICAP' | 'OVER_UNDER';
interface Result {
  oneX2: Row3[];
  ah: RowSide[];
  ou: RowSide[];
  bets: Record<MarketKey, Bet[]>;
}

/** Closing odds -> probabilities with the margin removed proportionally. */
function noVig(sides: Side[]): number[] {
  const inv = sides.map((s) => 1 / s.odds);
  const total = inv.reduce((a, b) => a + b, 0);
  return inv.map((x) => x / total);
}
const profit = (o: Outcome, odds: number) => ({ WIN: odds - 1, HALF_WIN: (odds - 1) / 2, PUSH: 0, HALF_LOSS: -0.5, LOSS: -1 })[o];
// stake-equivalent result of a side, for Brier on lines that can push or half-settle (push rows are skipped)
const score = (o: Outcome) => ({ WIN: 1, HALF_WIN: 0.75, HALF_LOSS: 0.25, LOSS: 0, PUSH: NaN })[o];
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const emptyResult = (): Result => ({ oneX2: [], ah: [], ou: [], bets: { MATCH_WINNER: [], ASIAN_HANDICAP: [], OVER_UNDER: [] } });

async function runLeague(leagueId: number): Promise<{ result: Result; from: Date | null }> {
  const result = emptyResult();
  const matches = sortByTime(await repo.finishedMatches(leagueId));
  if (matches.length === 0) return { result, from: null };
  const from = new Date(matches[0]!.kickoffAt.getTime() + burnInMs);
  const rows = (
    await db.query<{ fixture_id: string; market: string; selection: string; line: string | null; odds: string }>(
      `select o.fixture_id, o.market, o.selection, o.line, o.odds from external_odds o
         join fixtures f on f.id = o.fixture_id
        where f.league_id = $1 and o.bookmaker = $2 and o.phase = 'close'`,
      [leagueId, book],
    )
  ).rows;
  const closing = new Map<number, Map<string, Side[]>>();
  for (const r of rows) {
    const fx = closing.get(Number(r.fixture_id)) ?? new Map<string, Side[]>();
    closing.set(Number(r.fixture_id), fx);
    const sides = fx.get(r.market) ?? [];
    fx.set(r.market, sides);
    sides.push({ selection: r.selection, line: r.line === null ? null : Number(r.line), odds: Number(r.odds) });
  }

  let model: DixonColesModel | null = null;
  let lastFit = -Infinity;
  for (const m of matches) {
    if (m.kickoffAt < from) continue;
    const fx = closing.get(m.fixtureId);
    if (!fx) continue;
    const t = m.kickoffAt.getTime();
    if (!model || t - lastFit >= refitMs) {
      model = fitDixonColes(matches, m.kickoffAt, dcOpts, model ?? undefined);
      lastFit = t;
    }
    const g = expectedGoals(model, m.homeTeamId, m.awayTeamId);
    const mx = scoreMatrix(g.lambda, g.mu, model.rho);
    const addBets = (market: MarketKey, items: Array<{ sel: MarketSelection; p: number; q: number; odds: number }>) => {
      const best = items.reduce((a, b) => (b.p - b.q > a.p - a.q ? b : a));
      const o = settle(best.sel, m.homeGoals, m.awayGoals);
      result.bets[market].push({ edge: best.p - best.q, profit: profit(o, best.odds), won: o === 'WIN' || o === 'HALF_WIN' });
    };

    const x = fx.get('MATCH_WINNER');
    if (x && x.length === 3) {
      const sel = ['HOME', 'DRAW', 'AWAY'] as const;
      const sorted = sel.map((s) => x.find((r) => r.selection === s)!);
      const q = noVig(sorted);
      const p = sel.map((s) => priceSelection(mx, { market: 'MATCH_WINNER', selection: s }).probability);
      result.oneX2.push({ model: p as unknown as Probs3, market: q as unknown as Probs3, outcome: outcomeIndex(m.homeGoals, m.awayGoals) });
      addBets('MATCH_WINNER', sel.map((s, k) => ({ sel: { market: 'MATCH_WINNER', selection: s }, p: p[k]!, q: q[k]!, odds: sorted[k]!.odds })));
    }

    const ah = fx.get('ASIAN_HANDICAP');
    const home = ah?.find((r) => r.selection === 'HOME');
    const away = ah?.find((r) => r.selection === 'AWAY');
    if (home && away && home.line !== null && away.line !== null) {
      const q = noVig([home, away]);
      const sels: MarketSelection[] = [
        { market: 'ASIAN_HANDICAP', selection: 'HOME', line: home.line },
        { market: 'ASIAN_HANDICAP', selection: 'AWAY', line: away.line },
      ];
      const p = sels.map((s) => priceSelection(mx, s).probability);
      sels.forEach((s, k) => result.ah.push({ p: p[k]!, q: q[k]!, y: score(settle(s, m.homeGoals, m.awayGoals)) }));
      addBets('ASIAN_HANDICAP', sels.map((s, k) => ({ sel: s, p: p[k]!, q: q[k]!, odds: (k === 0 ? home : away).odds })));
    }

    const ou = fx.get('OVER_UNDER');
    const over = ou?.find((r) => r.selection === 'OVER');
    const under = ou?.find((r) => r.selection === 'UNDER');
    if (over && under && over.line === 2.5) {
      const q = noVig([over, under]);
      const sels: MarketSelection[] = [
        { market: 'OVER_UNDER', selection: 'OVER', line: 2.5 },
        { market: 'OVER_UNDER', selection: 'UNDER', line: 2.5 },
      ];
      const p = sels.map((s) => priceSelection(mx, s).probability);
      sels.forEach((s, k) => result.ou.push({ p: p[k]!, q: q[k]!, y: score(settle(s, m.homeGoals, m.awayGoals)) }));
      addBets('OVER_UNDER', sels.map((s, k) => ({ sel: s, p: p[k]!, q: q[k]!, odds: (k === 0 ? over : under).odds })));
    }
  }
  return { result, from };
}

const sideBrier = (rows: RowSide[]) => {
  const r = rows.filter((x) => !Number.isNaN(x.y));
  const mk = r.map((x) => (x.q - x.y) ** 2);
  const md = r.map((x) => (x.p - x.y) ** 2);
  const t = pairedTest(md, mk);
  return { n: r.length / 2, market: mean(mk), model: mean(md), saved: t.meanImprovement, z: t.z };
};
const x2Stats = (rows: Row3[]) => {
  const mk = rows.map((r) => logLoss3(r.market, r.outcome));
  const md = rows.map((r) => logLoss3(r.model, r.outcome));
  const t = pairedTest(md, mk);
  return { n: rows.length, market: mean(mk), model: mean(md), saved: t.meanImprovement, z: t.z };
};
const f = (v: number, d = 4) => +v.toFixed(d);

// leagues to run: those with external odds for this bookmaker
const wanted = values.league === 'all' ? null : values.league!.split(',').map(Number);
const leagues = (
  await db.query<{ id: number; name: string; country: string }>(
    `select l.id, l.name, l.country from leagues l
      where exists (select 1 from external_odds o join fixtures f on f.id = o.fixture_id where f.league_id = l.id and o.bookmaker = $1)
      order by l.id`,
    [book],
  )
).rows.filter((l) => !wanted || wanted.includes(l.id));

const pooled = emptyResult();
const perLeague: Array<Record<string, string | number>> = [];
for (const l of leagues) {
  const { result, from } = await runLeague(l.id);
  pooled.oneX2.push(...result.oneX2);
  pooled.ah.push(...result.ah);
  pooled.ou.push(...result.ou);
  for (const k of Object.keys(pooled.bets) as MarketKey[]) pooled.bets[k].push(...result.bets[k]);
  const a = result.oneX2.length ? x2Stats(result.oneX2) : null;
  const h = result.ah.length ? sideBrier(result.ah) : null;
  const o = result.ou.length ? sideBrier(result.ou) : null;
  perLeague.push({
    league: `${l.country} ${l.name}`,
    from: from ? from.toISOString().slice(0, 10) : '-',
    '1x2 n': a?.n ?? 0,
    '1x2 market': a ? f(a.market) : '-',
    '1x2 model': a ? f(a.model) : '-',
    '1x2 saved': a ? f(a.saved) : '-',
    '1x2 z': a ? f(a.z, 2) : '-',
    'ah n': h?.n ?? 0,
    'ah z': h ? f(h.z, 2) : '-',
    'ou n': o?.n ?? 0,
    'ou z': o ? f(o.z, 2) : '-',
  });
  console.error(`done ${l.country} ${l.name}`);
}
await db.close();

console.log(`book ${book}, model = untuned Dixon-Coles, evaluated from first fixture + ${values['burn-in-days']} days\n`);
console.log('== per league (saved = log loss per match the model saves vs the market; z > 0 model better, z < 0 market better) ==');
console.table(perLeague);

const all = x2Stats(pooled.oneX2);
console.log(`\n== pooled 1X2: ${all.n} matches in ${leagues.length} leagues ==`);
console.table([
  { who: 'market', logLoss: f(all.market) },
  { who: 'model', logLoss: f(all.model) },
]);
console.log(`model vs market log loss saved per match: ${f(all.saved)} (z ${f(all.z, 2)}; negative = market better)`);
const blend = pooled.oneX2.map((r) => logLoss3(r.model.map((v, k) => (v + r.market[k]!) / 2) as unknown as Probs3, r.outcome));
console.log(`50/50 blend log loss: ${f(mean(blend))} (market ${f(all.market)})`);

for (const [name, rows] of [['Asian handicap (main line)', pooled.ah], ['Over/under 2.5', pooled.ou]] as const) {
  if (rows.length === 0) continue;
  const s = sideBrier(rows);
  console.log(`\n== pooled ${name}: ${s.n} matches (pushes skipped; Brier lower is better) ==`);
  console.table([
    { who: 'market', brier: f(s.market) },
    { who: 'model', brier: f(s.model) },
  ]);
  console.log(`model vs market Brier saved per side: ${f(s.saved)} (z ${f(s.z, 2)}; negative = market better)`);
}

console.log('\n== pooled: bet the side the model likes most, at closing odds (profit per 1 staked) ==');
const table: Array<Record<string, string | number>> = [];
for (const market of ['MATCH_WINNER', 'ASIAN_HANDICAP', 'OVER_UNDER'] as const) {
  for (const min of [0, 0.02, 0.04, 0.06]) {
    const b = pooled.bets[market].filter((x) => x.edge >= min);
    if (b.length === 0) continue;
    const roi = mean(b.map((x) => x.profit));
    const sd = Math.sqrt(mean(b.map((x) => (x.profit - roi) ** 2)));
    table.push({ market, 'edge >=': min, bets: b.length, 'win%': f(mean(b.map((x) => (x.won ? 1 : 0))) * 100, 1), roi: f(roi), 'roi +-1se': f(sd / Math.sqrt(b.length)) });
  }
}
console.table(table);
console.log('(a market with ~2.5% margin loses about -0.025 per bet when it is right on average; roi has to beat that and its +-se)');
