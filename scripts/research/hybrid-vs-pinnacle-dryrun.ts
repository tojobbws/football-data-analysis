/**
 * Research, read-only (no DB writes): does Pinnacle's price tell which Hybrid AI picks hold up?
 *
 *   npx tsx scripts/research/hybrid-vs-pinnacle-dryrun.ts [--version hybrid-ai-v1]
 *
 * For every settled published Hybrid AI pick (analysis_predictions, kind SIGNAL), on the pick's own market + line:
 *  - pin0  = Pinnacle no-vig probability of the picked side, last quote stored at or before the pick was published
 *  - soft0 = the same from every other bookmaker (mean), same moment
 *  - pinC  = Pinnacle, last quote stored before kickoff (our "close"; snapshots are 2-6h apart, so not the true close)
 * Then splits the picks by three filters and compares how each group did:
 *  A  Pinnacle agrees at decision time   pin0 >= 0.5            (known at decision time)
 *  B  Pinnacle rates it above soft books pin0 - soft0 > 0       (known at decision time)
 *  C  Pinnacle moved toward the pick     pinC - pin0 > 0        (known only near kickoff: a late-round filter)
 * Per group: picks, W/HW/P/HL/L, stake-weighted win share, net units at the published odds, and Pinnacle's own
 * expectation for those picks (mean pin0) so luck vs signal can be told apart.
 */
import { parseArgs } from 'node:util';
import { createPgDb } from '@fp/database';
import { loadDotEnvFile, loadEnv } from '@fp/shared';

const { values } = parseArgs({ options: { version: { type: 'string', default: 'hybrid-ai-v1' } } });
const PIN = 4;
const SETTLED = ['WIN', 'HALF_WIN', 'PUSH', 'HALF_LOSS', 'LOSS'] as const;
type Status = (typeof SETTLED)[number];

loadDotEnvFile();
const db = createPgDb(loadEnv().DATABASE_URL);

interface Pick {
  id: number;
  fixtureId: number;
  market: string;
  selection: string;
  line: number;
  odds: number;
  publishedAt: Date;
  kickoff: Date;
  status: Status;
  round: string;
}
const picks: Pick[] = (
  await db.query<{
    id: string;
    fixture_id: string;
    market: string;
    selection: string;
    line: string;
    odds_at_publish: string;
    published_at: Date;
    kickoff_at: Date;
    status: Status;
    publish_round: string;
  }>(
    `select p.id, p.fixture_id, p.market, p.selection, p.line, p.odds_at_publish, p.published_at, f.kickoff_at, p.status, p.publish_round
       from analysis_predictions p join fixtures f on f.id = p.fixture_id
      where p.decision_rule_version = $1 and p.kind = 'SIGNAL' and p.status = any($2)
      order by f.kickoff_at`,
    [values.version, SETTLED],
  )
).rows.map((r) => ({
  id: Number(r.id),
  fixtureId: Number(r.fixture_id),
  market: r.market,
  selection: r.selection,
  line: Number(r.line),
  odds: Number(r.odds_at_publish),
  publishedAt: new Date(r.published_at),
  kickoff: new Date(r.kickoff_at),
  status: r.status,
  round: r.publish_round,
}));

// both sides of each pick's own line, every bookmaker, every stored snapshot
const quotes = (
  await db.query<{ pid: string; bookmaker_id: number; selection: string; line: string; odds: string; collected_at: Date }>(
    `select p.id pid, o.bookmaker_id, o.selection, o.line, o.odds, o.collected_at
       from analysis_predictions p
       join odds_history o on o.fixture_id = p.fixture_id and o.market = p.market and abs(o.line) = abs(p.line)
      where p.decision_rule_version = $1 and p.kind = 'SIGNAL' and p.status = any($2)`,
    [values.version, SETTLED],
  )
).rows;
const byPick = new Map<number, typeof quotes>();
for (const q of quotes) {
  const k = Number(q.pid);
  (byPick.get(k) ?? byPick.set(k, []).get(k)!).push(q);
}

const OPP: Record<string, string> = { HOME: 'AWAY', AWAY: 'HOME', OVER: 'UNDER', UNDER: 'OVER' };
/** no-vig probability of the picked side for one bookmaker at time t (last stored quote of each side at or before t) */
function bookProb(p: Pick, rows: typeof quotes, book: number, t: Date, strict: boolean): number | null {
  const sideLine = (sel: string) => (p.market === 'ASIAN_HANDICAP' && sel !== p.selection ? -p.line : p.line);
  const last = (sel: string) => {
    let best: (typeof quotes)[number] | null = null;
    for (const q of rows) {
      if (q.bookmaker_id !== book || q.selection !== sel || Number(q.line) !== sideLine(sel)) continue;
      const c = new Date(q.collected_at).getTime();
      if (strict ? c >= t.getTime() : c > t.getTime()) continue;
      if (!best || c > new Date(best.collected_at).getTime()) best = q;
    }
    return best ? Number(best.odds) : null;
  };
  const a = last(p.selection);
  const b = last(OPP[p.selection]!);
  if (!(a! > 1) || !(b! > 1)) return null;
  return 1 / a! / (1 / a! + 1 / b!);
}

interface Row extends Pick {
  pin0: number | null;
  soft0: number | null;
  pinC: number | null;
}
const rows: Row[] = picks.map((p) => {
  const qs = byPick.get(p.id) ?? [];
  const others = [...new Set(qs.map((q) => q.bookmaker_id))].filter((b) => b !== PIN);
  const soft = others.map((b) => bookProb(p, qs, b, p.publishedAt, false)).filter((x): x is number => x != null);
  return {
    ...p,
    pin0: bookProb(p, qs, PIN, p.publishedAt, false),
    soft0: soft.length >= 2 ? soft.reduce((a, b) => a + b, 0) / soft.length : null,
    pinC: bookProb(p, qs, PIN, p.kickoff, true),
  };
});

const units = (r: Pick) =>
  ({ WIN: r.odds - 1, HALF_WIN: (r.odds - 1) / 2, PUSH: 0, HALF_LOSS: -0.5, LOSS: -1 })[r.status];
function summarize(name: string, set: Row[]) {
  const c = (s: Status) => set.filter((r) => r.status === s).length;
  const won = c('WIN') + 0.5 * c('HALF_WIN');
  const lost = c('LOSS') + 0.5 * c('HALF_LOSS');
  const u = set.map(units);
  const mu = u.reduce((a, b) => a + b, 0) / Math.max(1, u.length);
  const sd = Math.sqrt(u.reduce((a, b) => a + (b - mu) ** 2, 0) / Math.max(1, u.length - 1));
  const pins = set.map((r) => r.pin0).filter((x): x is number => x != null);
  return {
    group: name,
    n: set.length,
    'W/HW/P/HL/L': `${c('WIN')}/${c('HALF_WIN')}/${c('PUSH')}/${c('HALF_LOSS')}/${c('LOSS')}`,
    'win share': won + lost ? `${((100 * won) / (won + lost)).toFixed(1)}%` : '—',
    'Pinnacle expected': pins.length ? `${((100 * pins.reduce((a, b) => a + b, 0)) / pins.length).toFixed(1)}%` : '—',
    'net units': +u.reduce((a, b) => a + b, 0).toFixed(2),
    'units/pick': +mu.toFixed(3),
    '±95%': set.length > 1 ? +((1.96 * sd) / Math.sqrt(set.length)).toFixed(3) : NaN,
  };
}
const split = (title: string, ok: (r: Row) => boolean | null) => {
  const known = rows.filter((r) => ok(r) !== null);
  console.log(`\n${title}  (known for ${known.length}/${rows.length} picks)`);
  console.table([summarize('yes', known.filter((r) => ok(r) === true)), summarize('no', known.filter((r) => ok(r) === false))]);
};

console.log(`Hybrid AI (${values.version}) settled published picks: ${rows.length}, kickoffs ${rows[0]?.kickoff.toISOString().slice(0, 10)} → ${rows.at(-1)?.kickoff.toISOString().slice(0, 10)}`);
console.table([summarize('all picks', rows)]);
const withPin = rows.filter((r) => r.pin0 != null && r.pinC != null);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const moves = withPin.map((r) => r.pinC! - r.pin0!);
const sdm = Math.sqrt(mean(moves.map((m) => (m - mean(moves)) ** 2)) * (moves.length / Math.max(1, moves.length - 1)));
console.log(
  `Pinnacle move toward the pick, publish → last pre-kickoff snapshot: mean ${(100 * mean(moves)).toFixed(2)} pts ` +
    `(±${((196 * sdm) / Math.sqrt(moves.length)).toFixed(2)}), toward ${moves.filter((m) => m > 0.002).length} · flat ${moves.filter((m) => Math.abs(m) <= 0.002).length} · against ${moves.filter((m) => m < -0.002).length}, n=${moves.length}`,
);

split('A · Pinnacle agrees at decision time (pin0 ≥ 50%)', (r) => (r.pin0 == null ? null : r.pin0 >= 0.5));
split('B · Pinnacle rates the side above the soft books (pin0 > soft0)', (r) => (r.pin0 == null || r.soft0 == null ? null : r.pin0 > r.soft0));
split('C · Pinnacle moved toward the pick before kickoff (pinC > pin0 + 0.2pt)', (r) => (r.pin0 == null || r.pinC == null ? null : r.pinC > r.pin0 + 0.002));
split('A+B · both known at decision time', (r) => (r.pin0 == null || r.soft0 == null ? null : r.pin0 >= 0.5 && r.pin0 > r.soft0));

const byMarket = (m: string) => rows.filter((r) => r.market === m);
console.log('\nBy market');
console.table([summarize('ASIAN_HANDICAP', byMarket('ASIAN_HANDICAP')), summarize('OVER_UNDER', byMarket('OVER_UNDER'))]);
process.exit(0);
