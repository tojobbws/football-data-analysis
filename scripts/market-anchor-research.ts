/**
 * Research: a market-anchored model, and five ways to look for where the market may be wrong (2026-10-22).
 * Read-only (no DB writes). Writes the final fit to data/market-anchor-v0.1.json for scripts/reanalyze-today.ts.
 *
 *   npx tsx scripts/market-anchor-research.ts [--league 39,140 | all] [--refit-days 14] [--lambda 50]
 *
 * Observations: every match with football-data.co.uk's Pinnacle EARLY price on the main Asian handicap line
 * (and on O/U 2.5, the only total those files carry). Base = that price de-margined. Inputs per match
 * (packages/analysis/src/market-anchor.ts) come from matches before kickoff only (a team's finishing and season so far
 * from all its competitions), and Dixon-Coles is walk-forward.
 *
 *  1. CLV      does the side we lean to get a better price than Pinnacle's CLOSE (same line), or does the line move to it?
 *  2. Anchor   logit(p) = logit(market) + β·x, refit every 30 days on all earlier observations (pooled leagues),
 *              scored on the later ones against the market alone (paired z on log loss).
 *  3. Motive   "nothing to play for" (assumed zones: 6th and third from bottom) as an input; how often it occurs.
 *  4. Biases   the final fit's coefficients with z and Holm: home side, line size, quarter lines, season start, ...
 *  5. Price    the best price on the market (football-data MAX) against Pinnacle's fair price, model-free.
 * Returns are per unit at the stated price; MAX is the best price across bookmakers in the file and often
 * could not really be taken (stale quotes, limits), so treat it as an upper bound.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  AH_FEATURES,
  ahFeatures,
  anchorLosses,
  applyAnchor,
  dcWalkForward,
  distributionFor,
  fairProbability,
  fitAnchor,
  holm,
  isDead,
  leagueTable,
  logit,
  MARKET_ANCHOR_VERSION,
  OU_FEATURES,
  ouFeatures,
  pairedTest,
  pValue,
  restOf,
  seasonPlayed,
  scoreMatrix,
  settle,
  sortByTime,
  xgLuck,
  type AnchorFit,
  type AnchorMarket,
  type AnchorObservation,
  type DixonColesOptions,
  type MarketSelection,
  type MatchRecord,
  type MatchSituation,
} from '@fp/analysis';
import { createPgDb, Repository, type TeamMatchRow } from '@fp/database';
import { loadDotEnvFile, loadEnv } from '@fp/shared';

const { values } = parseArgs({
  options: {
    league: { type: 'string', default: 'all' },
    'refit-days': { type: 'string', default: '14' },
    lambda: { type: 'string', default: '50' },
  },
});
const UNTUNED: DixonColesOptions = { priorStrength: 3, halfLifeDays: 240, xgWeight: 0.5 };
const LAMBDA = Number(values.lambda);
const ANCHOR_REFIT_MS = 30 * 86_400_000;
const MIN_TRAIN = 2000;

loadDotEnvFile();
const env = loadEnv();
const db = createPgDb(env.DATABASE_URL);
const repo = new Repository(db);

interface Price {
  line: number;
  first: number;
  second: number;
}
interface Obs extends AnchorObservation {
  market: AnchorMarket;
  league: number;
  t: number;
  marketP: number;
  dcP: number | null;
  dead: number;
  early: Price;
  close: Price | null;
  max: Price | null;
  /** outcome of the second side (AWAY / UNDER) as a fair hit, for picks on that side */
  y2: number;
}

type Q = Record<string, { line: number | null; odds: number }>;
async function externalOdds(leagueId: number) {
  const rows = (
    await db.query<{ fixture_id: string; bookmaker: string; phase: string; market: string; selection: string; line: string | null; odds: string }>(
      `select o.fixture_id, o.bookmaker, o.phase, o.market, o.selection, o.line, o.odds from external_odds o join fixtures f on f.id = o.fixture_id
        where f.league_id = $1 and o.market in ('ASIAN_HANDICAP','OVER_UNDER') and o.bookmaker in ('PIN','MAX')`,
      [leagueId],
    )
  ).rows;
  const by = new Map<number, Q>();
  for (const r of rows) {
    const m = by.get(Number(r.fixture_id)) ?? {};
    by.set(Number(r.fixture_id), m);
    m[`${r.bookmaker}|${r.phase}|${r.market}|${r.selection}`] = { line: r.line == null ? null : Number(r.line), odds: Number(r.odds) };
  }
  return by;
}

function price(q: Q | undefined, key: string, market: AnchorMarket): Price | null {
  const [a, b] = market === 'ASIAN_HANDICAP' ? ['HOME', 'AWAY'] : ['OVER', 'UNDER'];
  const x = q?.[`${key}|${market}|${a}`];
  const y = q?.[`${key}|${market}|${b}`];
  if (!x || !y || x.line === null || !(x.odds > 1) || !(y.odds > 1)) return null;
  return { line: x.line, first: x.odds, second: y.odds };
}

const devig = (p: Price) => 1 / p.first / (1 / p.first + 1 / p.second);
const sane = (p: Price | null) => p !== null && 1 / p.first + 1 / p.second >= 1 && 1 / p.first + 1 / p.second <= 1.25;

function selOf(market: AnchorMarket, first: boolean, line: number): MarketSelection {
  return market === 'ASIAN_HANDICAP'
    ? { market, selection: first ? 'HOME' : 'AWAY', line: first || line === 0 ? line : -line }
    : { market, selection: first ? 'OVER' : 'UNDER', line };
}

function hit(market: AnchorMarket, first: boolean, line: number, h: number, a: number): { y: number; w: number } {
  const o = settle(selOf(market, first, line), h, a);
  if (o === 'WIN') return { y: 1, w: 1 };
  if (o === 'LOSS') return { y: 0, w: 1 };
  if (o === 'HALF_WIN') return { y: 1, w: 0.5 };
  if (o === 'HALF_LOSS') return { y: 0, w: 0.5 };
  return { y: 0, w: 0 };
}

/** Per team kickoffs in every competition we hold (rest days and congestion). */
async function schedules() {
  const rows = (
    await db.query<{ h: string; a: string; t: Date }>(
      `select home_team_id as h, away_team_id as a, kickoff_at as t from fixtures where status_short in ('FT','AET','PEN','NS','TBD','1H','HT','2H','ET','P','LIVE')`,
    )
  ).rows;
  const by = new Map<number, number[]>();
  for (const r of rows) for (const id of [Number(r.h), Number(r.a)]) (by.get(id) ?? by.set(id, []).get(id)!).push(new Date(r.t).getTime());
  for (const v of by.values()) v.sort((x, y) => x - y);
  return by;
}

async function seasons(leagueId: number) {
  const rows = (await db.query<{ id: string; season: number }>('select id, season from fixtures where league_id = $1', [leagueId])).rows;
  return new Map(rows.map((r) => [Number(r.id), r.season]));
}

async function runLeague(leagueId: number, sched: Map<number, number[]>, log: Map<number, TeamMatchRow[]>): Promise<Obs[]> {
  const matches = sortByTime(await repo.finishedMatches(leagueId));
  if (matches.length < 300) return [];
  const q = await externalOdds(leagueId);
  if (q.size < 100) return [];
  const season = await seasons(leagueId);
  const bySeason = new Map<number, MatchRecord[]>();
  for (const m of matches) {
    const s = season.get(m.fixtureId)!;
    (bySeason.get(s) ?? bySeason.set(s, []).get(s)!).push(m);
  }
  const warmup = Math.min(150, Math.floor(matches.length * 0.25));
  const preds = dcWalkForward(matches, { warmupMatches: warmup, refitEveryDays: Number(values['refit-days']), dixonColes: UNTUNED });
  const out: Obs[] = [];
  for (let k = 0; k < preds.length; k++) {
    const m = matches[warmup + k]!;
    const o = q.get(m.fixtureId);
    if (!o) continue;
    const seasonMatches = bySeason.get(season.get(m.fixtureId)!)!;
    const table = leagueTable(seasonMatches, m.kickoffAt);
    const team = (id: number) => ({
      luck: xgLuck(log.get(id) ?? [], id, m.kickoffAt),
      rest: restOf(sched.get(id) ?? [], m.kickoffAt),
      dead: isDead(table, id),
      seasonPlayed: seasonPlayed(log.get(id) ?? [], season.get(m.fixtureId)!, m.kickoffAt),
    });
    const s: MatchSituation = { home: team(m.homeTeamId), away: team(m.awayTeamId) };
    const p = preds[k]!;
    const matrix = scoreMatrix(p.lambda, p.mu, p.rho);
    for (const market of ['ASIAN_HANDICAP', 'OVER_UNDER'] as const) {
      const early = price(o, 'PIN|early', market);
      if (!sane(early)) continue;
      const marketP = devig(early!);
      const dcP = fairProbability(distributionFor(matrix, selOf(market, true, early!.line)));
      const x = market === 'ASIAN_HANDICAP' ? ahFeatures(s, early!.line, dcP, marketP) : ouFeatures(s, dcP, marketP);
      const r1 = hit(market, true, early!.line, m.homeGoals, m.awayGoals);
      const r2 = hit(market, false, early!.line, m.homeGoals, m.awayGoals);
      if (r1.w === 0) continue; // push: the bet is refunded, nothing to learn
      const close = price(o, 'PIN|close', market);
      const max = price(o, 'MAX|early', market);
      out.push({
        market,
        league: leagueId,
        t: m.kickoffAt.getTime(),
        offset: logit(marketP),
        x,
        y: r1.y,
        w: r1.w,
        y2: r2.y,
        marketP,
        dcP,
        dead: Number(s.home.dead) + Number(s.away.dead),
        early: early!,
        close: sane(close) ? close : null,
        // the best price across bookmakers can sum a little under 1, never far: far under 1 is a bad quote in the file
        max: max && max.line === early!.line && 1 / max.first + 1 / max.second >= 0.97 ? max : null,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

const pct = (v: number, d = 1) => (Number.isFinite(v) ? +(v * 100).toFixed(d) : NaN);
const meanOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const seOf = (xs: number[]) => {
  const m = meanOf(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1) / Math.max(1, xs.length));
};

interface Bet {
  o: Obs;
  first: boolean;
  /** our probability of the side, and the market's */
  p: number;
  m: number;
}

/** Return per unit at odds `odds` from the side's fair hit and stake weight. */
function ret(b: Bet, odds: number): number {
  const y = b.first ? b.o.y : b.o.y2;
  // w is the non-pushed share; a half result returns half the stake
  return b.o.w * (y ? odds - 1 : -1);
}

/** CLV at the same line: our early price against Pinnacle's de-margined close. Line moves count separately. */
function clv(b: Bet): { clv: number | null; move: number | null; moved: -1 | 0 | 1 } {
  const c = b.o.close;
  if (!c) return { clv: null, move: null, moved: 0 };
  const odds = b.first ? b.o.early.first : b.o.early.second;
  if (c.line === b.o.early.line) {
    const q = b.first ? devig(c) : 1 - devig(c);
    // move: how far the fair probability of our side rose from early to close (the margin left out)
    return { clv: odds * q - 1, move: q - b.m, moved: 0 };
  }
  // AH: a lower home line at the close = the market moved to the home side (O/U lines never move in these files)
  const towardHome = c.line < b.o.early.line;
  return { clv: null, move: null, moved: towardHome === b.first ? 1 : -1 };
}

function betTable(label: string, bets: Bet[]) {
  if (!bets.length) return { group: label, n: 0 };
  const r = bets.map((b) => ret(b, b.first ? b.o.early.first : b.o.early.second));
  const withMax = bets.filter((b) => b.o.max);
  const rMax = withMax.map((b) => ret(b, b.first ? b.o.max!.first : b.o.max!.second));
  const c = bets.map(clv);
  const same = c.filter((x) => x.clv !== null).map((x) => x.clv!);
  const move = c.filter((x) => x.move !== null).map((x) => x.move!);
  const moved = c.filter((x) => x.moved !== 0);
  const up = bets.reduce((a, b) => a + b.o.w * (b.first ? b.o.y : b.o.y2), 0);
  const all = bets.reduce((a, b) => a + b.o.w, 0);
  return {
    group: label,
    n: bets.length,
    ours: pct(meanOf(bets.map((b) => b.p))),
    market: pct(meanOf(bets.map((b) => b.m))),
    hit: pct(up / all),
    'ret PIN%': pct(meanOf(r)),
    'se%': pct(seOf(r)),
    'ret MAX%': pct(meanOf(rMax)),
    'CLV%': pct(meanOf(same), 2),
    'CLV se%': pct(seOf(same), 2),
    'n CLV': same.length,
    'move pts': pct(meanOf(move), 2),
    'move se': pct(seOf(move), 2),
    'line to us%': moved.length ? pct(moved.filter((x) => x.moved === 1).length / moved.length) : NaN,
    'n moved': moved.length,
  };
}

/** The side a probability set leans to, when it rates one side at least `edge` above the market. */
function leanBets(obs: Obs[], probs: number[], edge: number): Bet[] {
  const out: Bet[] = [];
  obs.forEach((o, i) => {
    const p = probs[i]!;
    if (p - o.marketP >= edge) out.push({ o, first: true, p, m: o.marketP });
    else if (o.marketP - p >= edge) out.push({ o, first: false, p: 1 - p, m: 1 - o.marketP });
  });
  return out;
}

function analyse(market: AnchorMarket, obs: Obs[]) {
  const features = market === 'ASIAN_HANDICAP' ? AH_FEATURES : OU_FEATURES;
  obs.sort((a, b) => a.t - b.t);
  const name = market === 'ASIAN_HANDICAP' ? 'Asian handicap, main line' : 'Over/under 2.5';
  console.log(`\n=================== ${name}: ${obs.length} observations, ${new Set(obs.map((o) => o.league)).size} leagues ===================`);

  // 2. walk-forward anchor
  const start = Math.max(MIN_TRAIN, Math.floor(obs.length * 0.3));
  const anchored: number[] = [];
  let fit: AnchorFit | null = null;
  let fitAt = -Infinity;
  for (let i = start; i < obs.length; i++) {
    if (!fit || obs[i]!.t - fitAt >= ANCHOR_REFIT_MS) {
      const train = obs.slice(0, i).filter((o) => o.t < obs[i]!.t);
      fit = fitAnchor(market, features, train, LAMBDA);
      fitAt = obs[i]!.t;
    }
    anchored.push(applyAnchor(fit, obs[i]!.marketP, obs[i]!.x));
  }
  const test = obs.slice(start);
  const lossMarket = anchorLosses(test, test.map((o) => o.marketP));
  const lossAnchor = anchorLosses(test, anchored);
  const withDc = test.filter((o) => o.dcP !== null);
  const lossDc = anchorLosses(withDc, withDc.map((o) => o.dcP!));
  const lossDcMarket = anchorLosses(withDc, withDc.map((o) => o.marketP));
  const t1 = pairedTest(lossAnchor, lossMarket);
  const t2 = pairedTest(lossDc, lossDcMarket);
  console.log(`\n[2] Walk-forward test ${new Date(test[0]!.t).toISOString().slice(0, 10)} → ${new Date(test.at(-1)!.t).toISOString().slice(0, 10)} (n=${test.length}), log loss per unit (paired z > 0 = better than the market)`);
  console.table([
    { model: 'market (PIN early)', logLoss: +meanOf(lossMarket).toFixed(5) },
    { model: 'market-anchored', logLoss: +meanOf(lossAnchor).toFixed(5), z: +t1.z.toFixed(2) },
    { model: 'Dixon-Coles alone', logLoss: +meanOf(lossDc).toFixed(5), z: +t2.z.toFixed(2) },
  ]);
  const shift = test.map((o, i) => Math.abs(anchored[i]! - o.marketP));
  console.log(`anchored vs market: mean |shift| ${pct(meanOf(shift), 2)} points, 95th percentile ${pct([...shift].sort((a, b) => a - b)[Math.floor(shift.length * 0.95)]!, 2)}`);

  // 1. + 2. leans and CLV
  console.log('\n[1+2] Side the model leans to by at least the edge (test period): hit, return at Pinnacle early / at the best price, CLV vs Pinnacle close');
  const rows = [];
  for (const e of [0.01, 0.02, 0.03]) rows.push(betTable(`anchored ≥${e * 100}`, leanBets(test, anchored, e)));
  const dcProbs = test.map((o) => o.dcP ?? o.marketP);
  for (const e of [0.03, 0.06, 0.12]) rows.push(betTable(`DC ≥${e * 100}`, leanBets(test, dcProbs, e)));
  console.table(rows);

  // 5. price only
  console.log('\n[5] Best price (MAX) against Pinnacle early fair, no model (test period): bet the side when MAX × fair − 1 ≥ threshold');
  const priceRows = [];
  for (const thr of [0, 0.02, 0.04]) {
    const bets: Bet[] = [];
    for (const o of test) {
      if (!o.max) continue;
      if (o.max.first * o.marketP - 1 >= thr) bets.push({ o, first: true, p: o.marketP, m: o.marketP });
      else if (o.max.second * (1 - o.marketP) - 1 >= thr) bets.push({ o, first: false, p: 1 - o.marketP, m: 1 - o.marketP });
    }
    priceRows.push(betTable(`MAX edge ≥${thr * 100}%`, bets));
  }
  console.table(priceRows);

  // 3. motivation
  const dead = obs.filter((o) => o.dead > 0);
  console.log(`\n[3] Matches with a team that has nothing left to play for: ${dead.length} of ${obs.length} (${pct(dead.length / obs.length)}%)`);
  if (dead.length) {
    const groups: Array<[string, Obs[]]> =
      market === 'ASIAN_HANDICAP'
        ? [
            ['only the home team has nothing to play for', dead.filter((o) => o.x[5]! < 0)],
            ['only the away team has nothing to play for', dead.filter((o) => o.x[5]! > 0)],
            ['both', dead.filter((o) => o.x[5] === 0)],
          ]
        : [['any', dead]];
    for (const [label, xs] of groups) {
      if (!xs.length) continue;
      const h = xs.reduce((a, o) => a + o.w * o.y, 0) / xs.reduce((a, o) => a + o.w, 0);
      console.log(`   ${label}: n=${xs.length}, ${market === 'ASIAN_HANDICAP' ? 'home side' : 'over'} hit ${pct(h)}% vs market ${pct(meanOf(xs.map((o) => o.marketP)))}%`);
    }
  }

  // 4. final fit on everything, coefficients with Holm
  const final = fitAnchor(market, features, obs, LAMBDA);
  const z = final.beta.map((b, j) => b / final.se[j]!);
  const keep = holm(z.map(pValue));
  console.log(`\n[4] Final fit on all ${obs.length} observations (λ=${LAMBDA}), β per standard deviation of the input (logit units), Holm across the inputs`);
  console.table(
    features.map((f, j) => ({ input: f, beta: +final.beta[j]!.toFixed(4), se: +final.se[j]!.toFixed(4), z: +z[j]!.toFixed(2), holm: keep[j] ? 'yes' : '' , mean: +final.mean[j]!.toFixed(3), sd: +final.sd[j]!.toFixed(3) })),
  );
  return {
    fit: final,
    test: { n: test.length, logLossMarket: meanOf(lossMarket), logLossAnchor: meanOf(lossAnchor), z: t1.z },
    significant: features.filter((_, j) => keep[j]),
  };
}

const leagues = values.league === 'all' ? env.TRACKED_LEAGUES : values.league!.split(',').map(Number);
const sched = await schedules();
const log = await repo.teamMatchLog();
const all: Obs[] = [];
for (const l of leagues) {
  const t = Date.now();
  const xs = await runLeague(l, sched, log);
  all.push(...xs);
  console.error(`league ${l}: ${xs.length} observations (${((Date.now() - t) / 1000).toFixed(0)}s)`);
}
const ah = analyse('ASIAN_HANDICAP', all.filter((o) => o.market === 'ASIAN_HANDICAP'));
const ou = analyse('OVER_UNDER', all.filter((o) => o.market === 'OVER_UNDER'));

mkdirSync('data', { recursive: true });
const file = `data/${MARKET_ANCHOR_VERSION}.json`;
writeFileSync(
  file,
  JSON.stringify(
    {
      version: MARKET_ANCHOR_VERSION,
      fittedAt: new Date().toISOString(),
      source: 'scripts/market-anchor-research.ts, football-data.co.uk Pinnacle early prices',
      lambda: LAMBDA,
      leagues: [...new Set(all.map((o) => o.league))],
      ASIAN_HANDICAP: { ...ah.fit, test: ah.test, significant: ah.significant },
      OVER_UNDER: { ...ou.fit, test: ou.test, significant: ou.significant },
    },
    null,
    2,
  ),
);
console.log(`\nfit written to ${file}`);
process.exit(0);
