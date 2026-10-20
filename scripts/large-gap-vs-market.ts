/**
 * Research: when the model and the market disagree by a lot on the main Asian handicap line, who is right?
 * Read-only (no DB writes). Evidence for the edge cap of the pick rules (ADR 0006 addendum, ADR 0009).
 *
 *   npx tsx scripts/large-gap-vs-market.ts [--market AH | OU] [--league 39,140 | all] [--book PIN] [--phase early] [--refit-days 14]
 *
 * Method (walk-forward, no look-ahead):
 *  - Dixon-Coles (untuned settings) refit every `refit-days` on matches that kicked off before the match.
 *  - Market: football-data.co.uk's Asian handicap line for the match (their main line; O/U: their 2.5 line) at `book` / `phase`,
 *    both sides de-margined proportionally. The model prices the same line from its score matrix
 *    (quarter lines split, pushes left out: the pick rules' fair probability).
 *  - For the side the model rates above the market, by size of that gap: matches, mean model and market
 *    probability, the realised fair hit rate (win + half win / 2 over everything but pushes) and the mean
 *    return per unit at that side's price, with its standard error. Elo (walk-forward too) splits the
 *    large gaps into "Elo agrees" / "Elo disagrees", as the pick rules' agreement check does.
 */
import { parseArgs } from 'node:util';
import {
  computeElo,
  dcWalkForward,
  distributionFor,
  eloAgreement,
  eloOneXTwo,
  fairProbability,
  scoreMatrix,
  sortByTime,
  type DixonColesOptions,
  type MarketSelection,
} from '@fp/analysis';
import { createPgDb, Repository } from '@fp/database';
import { loadDotEnvFile, loadEnv } from '@fp/shared';

const { values } = parseArgs({
  options: {
    league: { type: 'string', default: 'all' },
    market: { type: 'string', default: 'AH' },
    book: { type: 'string', default: 'PIN' },
    phase: { type: 'string', default: 'early' },
    'refit-days': { type: 'string', default: '14' },
  },
});
const OU = values.market === 'OU';
const UNTUNED: DixonColesOptions = { priorStrength: 3, halfLifeDays: 240, xgWeight: 0.5 };
const BUCKETS = [0.03, 0.06, 0.09, 0.12, 0.15, 0.2, Infinity];

loadDotEnvFile();
const env = loadEnv();
const db = createPgDb(env.DATABASE_URL);
const repo = new Repository(db);

interface Obs {
  league: number;
  gap: number;
  model: number;
  market: number;
  /** fair hit: 1 win, 0.5 half win or half loss counted as half, null push */
  up: number;
  down: number;
  ret: number;
  elo: boolean | null;
}

async function quotes(leagueId: number) {
  const rows = (
    await db.query<{ fixture_id: string; market: string; selection: string; line: string | null; odds: string }>(
      `select o.fixture_id, o.market, o.selection, o.line, o.odds from external_odds o join fixtures f on f.id = o.fixture_id
        where f.league_id = $1 and o.bookmaker = $2 and o.phase = $3 and o.market in ('ASIAN_HANDICAP','OVER_UNDER','MATCH_WINNER')`,
      [leagueId, values.book, values.phase],
    )
  ).rows;
  const by = new Map<number, Record<string, { line: number | null; odds: number }>>();
  for (const r of rows) {
    const m = by.get(Number(r.fixture_id)) ?? {};
    by.set(Number(r.fixture_id), m);
    m[`${r.market}|${r.selection}`] = { line: r.line == null ? null : Number(r.line), odds: Number(r.odds) };
  }
  return by;
}

async function runLeague(leagueId: number): Promise<Obs[]> {
  const matches = sortByTime(await repo.finishedMatches(leagueId));
  if (matches.length < 300) return [];
  const q = await quotes(leagueId);
  if (q.size < 100) return [];
  const warmup = Math.min(150, Math.floor(matches.length * 0.25));
  const preds = dcWalkForward(matches, { warmupMatches: warmup, refitEveryDays: Number(values['refit-days']), dixonColes: UNTUNED });
  const out: Obs[] = [];
  let elo = null as ReturnType<typeof computeElo> | null;
  let eloAt = -Infinity;
  for (let k = 0; k < preds.length; k++) {
    const m = matches[warmup + k]!;
    const o = q.get(m.fixtureId);
    const h = OU ? o?.['OVER_UNDER|OVER'] : o?.['ASIAN_HANDICAP|HOME'];
    const a = OU ? o?.['OVER_UNDER|UNDER'] : o?.['ASIAN_HANDICAP|AWAY'];
    if (!h || !a || h.line === null || !(h.odds > 1) || !(a.odds > 1)) continue;
    const sum = 1 / h.odds + 1 / a.odds;
    if (sum < 1 || sum > 1.25) continue;
    const p = preds[k]!;
    const matrix = scoreMatrix(p.lambda, p.mu, p.rho);
    const sel = (x: { sel: string; line: number }) =>
      (OU ? { market: 'OVER_UNDER', selection: x.sel, line: x.line } : { market: 'ASIAN_HANDICAP', selection: x.sel, line: x.line }) as MarketSelection;
    const sides = [
      { sel: OU ? 'OVER' : 'HOME', line: h.line, odds: h.odds, market: 1 / h.odds / sum },
      { sel: OU ? 'UNDER' : 'AWAY', line: OU || h.line === 0 ? h.line : -h.line, odds: a.odds, market: 1 / a.odds / sum },
    ].map((s) => {
      const dist = distributionFor(matrix, sel(s));
      return { ...s, dist, model: fairProbability(dist) };
    });
    const s = sides.sort((x, y) => y.model - y.market - (x.model - x.market))[0]!;
    const gap = s.model - s.market;
    if (gap < BUCKETS[0]!) continue;
    const own = distributionFor(
      // the real result as a one-cell matrix, settled by the same rule
      Array.from({ length: Math.max(m.homeGoals, m.awayGoals) + 1 }, (_, i) =>
        Array.from({ length: Math.max(m.homeGoals, m.awayGoals) + 1 }, (_, j) => (i === m.homeGoals && j === m.awayGoals ? 1 : 0)),
      ),
      sel(s),
    );
    // Elo as of kickoff (refit with DC's cadence), against the 1X2 market of the same book and phase
    if (!elo || m.kickoffAt.getTime() - eloAt >= Number(values['refit-days']) * 86_400_000) {
      elo = computeElo(matches, m.kickoffAt);
      eloAt = m.kickoffAt.getTime();
    }
    const mw = ['HOME', 'DRAW', 'AWAY'].map((x) => o?.[`MATCH_WINNER|${x}`]?.odds ?? 0);
    let agree: boolean | null = null;
    if (!OU && mw.every((x) => x > 1)) {
      const inv = mw.map((x) => 1 / x);
      const t = inv.reduce((u, v) => u + v, 0);
      const e = eloOneXTwo(elo, m.homeTeamId, m.awayTeamId);
      agree = eloAgreement('ASIAN_HANDICAP', s.sel as 'HOME' | 'AWAY', { home: e.home, draw: e.draw, away: e.away }, { HOME: inv[0]! / t, DRAW: inv[1]! / t, AWAY: inv[2]! / t }, s.market);
    }
    out.push({
      league: leagueId,
      gap,
      model: s.model,
      market: s.market,
      up: own.win + own.halfWin / 2,
      down: own.loss + own.halfLoss / 2,
      ret: own.win * (s.odds - 1) + (own.halfWin * (s.odds - 1)) / 2 - own.halfLoss / 2 - own.loss,
      elo: agree,
    });
  }
  return out;
}

function summarise(label: string, xs: Obs[]) {
  const n = xs.length;
  if (!n) return { bucket: label, n: 0 };
  const mean = (f: (o: Obs) => number) => xs.reduce((a, o) => a + f(o), 0) / n;
  const up = xs.reduce((a, o) => a + o.up, 0);
  const down = xs.reduce((a, o) => a + o.down, 0);
  const r = mean((o) => o.ret);
  const sd = Math.sqrt(xs.reduce((a, o) => a + (o.ret - r) ** 2, 0) / Math.max(1, n - 1));
  const pct = (v: number) => +(v * 100).toFixed(1);
  return {
    bucket: label,
    n,
    model: pct(mean((o) => o.model)),
    market: pct(mean((o) => o.market)),
    actual: up + down > 0 ? pct(up / (up + down)) : NaN,
    'return%': pct(r),
    'se%': pct(sd / Math.sqrt(n)),
  };
}

const leagues = values.league === 'all' ? env.TRACKED_LEAGUES : values.league!.split(',').map(Number);
const all: Obs[] = [];
for (const l of leagues) {
  const t = Date.now();
  const xs = await runLeague(l);
  all.push(...xs);
  console.error(`league ${l}: ${xs.length} matches with a gap >= 3 points (${((Date.now() - t) / 1000).toFixed(0)}s)`);
}
console.log(`\n${OU ? 'Over/under 2.5' : 'Asian handicap main line'}, ${values.book} ${values.phase}, side the model rates above the market, walk-forward Dixon-Coles (untuned)`);
console.table(BUCKETS.slice(0, -1).map((lo, i) => summarise(`${(lo * 100).toFixed(0)}–${BUCKETS[i + 1] === Infinity ? '∞' : (BUCKETS[i + 1]! * 100).toFixed(0)}`, all.filter((o) => o.gap >= lo && o.gap < BUCKETS[i + 1]!))));
console.log('\nGap above 12 points, by Elo agreement');
console.table([true, false, null].map((e) => summarise(`elo ${e}`, all.filter((o) => o.gap > 0.12 && o.elo === e))));
console.log(`\nleagues: ${new Set(all.map((o) => o.league)).size}, observations: ${all.length}`);
process.exit(0);
