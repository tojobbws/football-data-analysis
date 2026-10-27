/**
 * Research 2026-10-27: why do the picks land on the underdog (the side getting the start) far more often than
 * on the favourite? Read-only (no DB writes). Writes reports/underdog-bias-<date>.txt and .json.
 *
 *   npx tsx scripts/underdog-bias-report.ts
 *
 * What it measures, all on finished matches, from what the system stored at the time (no later data):
 *  - Main-line AH evaluations: for each run before kickoff, both sides of the market's main AH line as the
 *    candidates stored them (rules-v0.6 runs: `factors.onMainLine`; older runs: the HOME line with 3+
 *    bookmakers whose no-vig price sits closest to 50/50, within 15 points, the same rule as `mainLines`).
 *    Favourite = the side giving goals; at AH 0 the side the 1X2 market rates higher.
 *  - One row per match = the last run before kickoff; lead-time rows = the last run inside each window.
 *  - Gate pass under rules-v0.6 gates, replayed from the stored edge, EV, odds and the other reject reasons.
 *  - Who is right: the fair target of each side (WIN 1, HALF_WIN ½ weight y=1, HALF_LOSS ½ weight y=0, LOSS 1,
 *    PUSH out) against the model's and the market's probability for it. 95% intervals clustered by football day.
 *  - 1X2 favourites by the market's price band: model, market and the share that won.
 *  - Published picks (one per match: the latest SIGNAL) and the locked rules-v0.4-shadow picks.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { clusteredMean, clusterSums, fairTarget, pairedComparison, settle, type ClusteredMean, type Outcome } from '@fp/analysis';
import { createPgDb } from '@fp/database';
import { footballDay, loadDotEnvFile, loadEnv } from '@fp/shared';

loadDotEnvFile();
const env = loadEnv();
const db = createPgDb(env.DATABASE_URL!, { max: 1 });

const V06 = { minEdge: 0.03, maxEdge: 0.12, minEv: 0.02, minOdds: 1.3, maxOdds: 6 };
/** reject reasons that are not the edge/EV/odds gates or the line choice */
const OTHER_REASONS = new Set(['MARKET_GATED_OFF', 'LOW_TEAM_DATA', 'TOO_CLOSE_TO_KICKOFF', 'MAJOR_ABSENCE_UNMODELLED', 'THIN_MARKET', 'NO_MODEL_PRICE']);

interface SideRow {
  run: string;
  fixture: number;
  version: string;
  at: Date;
  kickoff: Date;
  league: number;
  leagueName: string;
  home: number;
  away: number;
  selection: 'HOME' | 'AWAY';
  line: number;
  odds: number;
  mp: number;
  qp: number;
  edge: number;
  ev: number | null;
  /** Elo rates this side stronger than the 1X2 market does (ranking and STRONG use it) */
  agreement: boolean | null;
  reasons: string[];
  mwHome: number | null;
  mwAway: number | null;
}

const sides = (
  await db.query<{
    run_id: string; fixture_id: string; v: string; started_at: Date; kickoff_at: Date; league_id: number; league_name: string; gh: number; ga: number;
    selection: 'HOME' | 'AWAY'; line: string; odds: string; mp: string; qp: string; edge: string; ev: string | null; agr: string | null; rr: string[] | null; mw_home: string | null; mw_away: string | null;
  }>(`
  with runs as (
    select r.id, r.fixture_id, r.started_at, r.decision_rule_version v
      from analysis_runs r join fixtures f on f.id = r.fixture_id
     where r.started_at < f.kickoff_at and f.status_short in ('FT', 'AET', 'PEN') and coalesce(f.ft_home, f.goals_home) is not null
  ),
  ah as (
    select c.run_id, c.selection, c.line, c.odds, c.model_probability mp, c.market_probability qp, c.edge,
           c.factors->>'ev' ev, c.factors->>'agreement' agr, (c.factors->>'nBookmakers')::int nb, c.factors->>'onMainLine' oml, c.factors->'rejectReasons' rr
      from analysis_candidates c join runs on runs.id = c.run_id
     where c.market = 'ASIAN_HANDICAP' and c.model_probability is not null
  ),
  main as (
    select distinct on (run_id) run_id, line
      from ah
     where selection = 'HOME' and (oml = 'true' or (oml is null and nb >= 3 and abs(qp - 0.5) <= 0.15))
     order by run_id, abs(qp - 0.5), nb desc, abs(line)
  ),
  mw as (
    select c.run_id,
           max(c.market_probability) filter (where c.selection = 'HOME') h,
           max(c.market_probability) filter (where c.selection = 'AWAY') a
      from analysis_candidates c join main using (run_id)
     where c.market = 'MATCH_WINNER'
     group by c.run_id
  )
  select runs.id run_id, runs.fixture_id, runs.v, runs.started_at, f.kickoff_at, f.league_id, l.name league_name,
         coalesce(f.ft_home, f.goals_home) gh, coalesce(f.ft_away, f.goals_away) ga,
         ah.selection, ah.line, ah.odds, ah.mp, ah.qp, ah.edge, ah.ev, ah.agr, ah.rr, mw.h mw_home, mw.a mw_away
    from main
    join runs on runs.id = main.run_id
    join fixtures f on f.id = runs.fixture_id
    join leagues l on l.id = f.league_id
    join ah on ah.run_id = main.run_id
     and ((ah.selection = 'HOME' and ah.line = main.line) or (ah.selection = 'AWAY' and ah.line = -main.line))
    left join mw on mw.run_id = main.run_id`)
).rows.map(
  (r): SideRow => ({
    run: r.run_id, fixture: Number(r.fixture_id), version: r.v, at: new Date(r.started_at), kickoff: new Date(r.kickoff_at), league: r.league_id, leagueName: r.league_name,
    home: Number(r.gh), away: Number(r.ga), selection: r.selection, line: Number(r.line), odds: Number(r.odds), mp: Number(r.mp), qp: Number(r.qp), edge: Number(r.edge),
    ev: r.ev === null ? null : Number(r.ev), agreement: r.agr === null ? null : r.agr === 'true', reasons: r.rr ?? [], mwHome: r.mw_home === null ? null : Number(r.mw_home), mwAway: r.mw_away === null ? null : Number(r.mw_away),
  }),
);

/** One evaluation of the main line: favourite and underdog side. */
interface Pair {
  run: string;
  fixture: number;
  version: string;
  at: Date;
  kickoff: Date;
  league: string;
  /** |home line| */
  absLine: number;
  fav: SideRow;
  dog: SideRow;
  day: string;
}

const byRun = new Map<string, SideRow[]>();
for (const s of sides) byRun.set(s.run, [...(byRun.get(s.run) ?? []), s]);
let pkUnknown = 0;
const pairs: Pair[] = [];
for (const [run, rs] of byRun) {
  const h = rs.find((r) => r.selection === 'HOME');
  const a = rs.find((r) => r.selection === 'AWAY');
  if (!h || !a) continue;
  let favHome: boolean;
  if (h.line < 0) favHome = true;
  else if (h.line > 0) favHome = false;
  else if (h.mwHome !== null && h.mwAway !== null && h.mwHome !== h.mwAway) favHome = h.mwHome > h.mwAway;
  else {
    pkUnknown++;
    continue;
  }
  pairs.push({
    run, fixture: h.fixture, version: h.version, at: h.at, kickoff: h.kickoff, league: h.leagueName, absLine: Math.abs(h.line),
    fav: favHome ? h : a, dog: favHome ? a : h, day: footballDay(h.kickoff).date,
  });
}

const outcomeOf = (s: SideRow): Outcome => settle({ market: 'ASIAN_HANDICAP', selection: s.selection, line: s.line }, s.home, s.away);
const passV06 = (s: SideRow) =>
  s.edge >= V06.minEdge && s.edge <= V06.maxEdge && (s.ev ?? -1) >= V06.minEv && s.odds >= V06.minOdds && s.odds <= V06.maxOdds && !s.reasons.some((r) => OTHER_REASONS.has(r));

/** last evaluation per fixture, optionally only inside a window of hours before kickoff */
function lastPerFixture(ps: readonly Pair[], window?: [number, number]): Pair[] {
  const best = new Map<number, Pair>();
  for (const p of ps) {
    const h = (p.kickoff.getTime() - p.at.getTime()) / 3_600_000;
    if (window && (h < window[0] || h >= window[1])) continue;
    const b = best.get(p.fixture);
    if (!b || b.at < p.at) best.set(p.fixture, p);
  }
  return [...best.values()];
}

const mean = (rows: ReadonlyArray<{ cluster: string; weight?: number; value: number }>) => clusteredMean(clusterSums(rows));
const pct = (m: ClusteredMean | number | null, d = 1) => {
  const v = typeof m === 'number' || m === null ? m : m.mean;
  if (v === null) return '—';
  const s = `${(v * 100).toFixed(d)}%`;
  return typeof m === 'object' && m && m.lo !== null ? `${s} [${(m.lo! * 100).toFixed(d)}, ${(m.hi! * 100).toFixed(d)}]` : s;
};
const pts = (m: ClusteredMean) => (m.mean === null ? '—' : `${(m.mean * 100).toFixed(2)} pts` + (m.lo !== null ? ` [${(m.lo! * 100).toFixed(2)}, ${(m.hi! * 100).toFixed(2)}]` : ''));
const num = (m: ClusteredMean, d = 4) => (m.mean === null ? '—' : `${m.mean.toFixed(d)}` + (m.lo !== null ? ` [${m.lo!.toFixed(d)}, ${m.hi!.toFixed(d)}]` : ''));

const lines: string[] = [];
const out = (s = '') => lines.push(s);
const json: Record<string, unknown> = {};

/** Who is right about one side: fair hit vs the model's and the market's probability for it, and the scores. */
function sideStats(ps: readonly Pair[], which: 'fav' | 'dog') {
  const rows = ps.flatMap((p) => {
    const s = p[which];
    const t = fairTarget(outcomeOf(s));
    return t ? [{ p, s, t }] : [];
  });
  const hit = mean(rows.map((r) => ({ cluster: r.p.day, weight: r.t.weight, value: r.t.y })));
  const mp = mean(rows.map((r) => ({ cluster: r.p.day, weight: r.t.weight, value: r.s.mp })));
  const qp = mean(rows.map((r) => ({ cluster: r.p.day, weight: r.t.weight, value: r.s.qp })));
  const lean = mean(ps.map((p) => ({ cluster: p.day, value: p[which].mp - p[which].qp })));
  const brier = pairedComparison(rows.map((r) => ({ cluster: r.p.day, weight: r.t.weight, model: (r.s.mp - r.t.y) ** 2, market: (r.s.qp - r.t.y) ** 2 })));
  const ll = pairedComparison(
    rows.map((r) => ({
      cluster: r.p.day, weight: r.t.weight,
      model: -Math.log(Math.max(1e-12, r.t.y ? r.s.mp : 1 - r.s.mp)),
      market: -Math.log(Math.max(1e-12, r.t.y ? r.s.qp : 1 - r.s.qp)),
    })),
  );
  const outcomes: Record<string, number> = {};
  for (const p of ps) outcomes[outcomeOf(p[which])] = (outcomes[outcomeOf(p[which])] ?? 0) + 1;
  return { n: ps.length, decided: rows.length, days: new Set(ps.map((p) => p.day)).size, hit, mp, qp, lean, brier, ll, outcomes };
}

function block(title: string, ps: readonly Pair[]) {
  const dog = sideStats(ps, 'dog');
  const fav = sideStats(ps, 'fav');
  out(`-- ${title}: ${ps.length} matches, ${dog.days} football days`);
  out(`   underdog side: model ${pct(dog.mp)} · market ${pct(dog.qp)} · happened (fair hit) ${pct(dog.hit)}`);
  out(`   lean model−market on the underdog: ${pts(dog.lean)}`);
  out(`   Brier model ${num(dog.brier.model)} · market ${num(dog.brier.market)} · diff ${num(dog.brier.diff)} (below 0 = model better)`);
  out(`   log loss model ${num(dog.ll.model)} · market ${num(dog.ll.market)} · diff ${num(dog.ll.diff)}`);
  out(`   outcomes underdog ${JSON.stringify(dog.outcomes)} · favourite ${JSON.stringify(fav.outcomes)}`);
  return { dog, fav };
}

// ---------------------------------------------------------------- 1. candidates
const perMatch = lastPerFixture(pairs);
out(`Underdog bias report — ${new Date().toISOString()}`);
out(`main-line AH evaluations: ${pairs.length} runs, ${perMatch.length} finished matches; AH 0 with no 1X2 to tell the favourite: ${pkUnknown} runs (left out)`);
out();
out('== 1. Candidate distribution (one row per match = last run before kickoff) ==');
const count = (ps: readonly Pair[], f: (s: SideRow) => boolean) => ({ fav: ps.filter((p) => f(p.fav)).length, dog: ps.filter((p) => f(p.dog)).length });
const dist = {
  matches: perMatch.length,
  edgeAtLeast3: count(perMatch, (s) => s.edge >= 0.03),
  edge3to12: count(perMatch, (s) => s.edge >= 0.03 && s.edge <= 0.12),
  edgeAbove12: count(perMatch, (s) => s.edge > 0.12),
  passV06: count(perMatch, passV06),
  passV06AllRuns: count(pairs, passV06),
};
out(`   both sides of the main line are evaluated every run: ${perMatch.length} favourite and ${perMatch.length} underdog candidates`);
out(`   edge ≥ 3 pts:        favourite ${dist.edgeAtLeast3.fav} · underdog ${dist.edgeAtLeast3.dog}`);
out(`   edge 3–12 pts:       favourite ${dist.edge3to12.fav} · underdog ${dist.edge3to12.dog}`);
out(`   edge > 12 pts:       favourite ${dist.edgeAbove12.fav} · underdog ${dist.edgeAbove12.dog}`);
out(`   pass v0.6 gates:     favourite ${dist.passV06.fav} · underdog ${dist.passV06.dog}   (every run: ${dist.passV06AllRuns.fav} · ${dist.passV06AllRuns.dog})`);
json.distribution = dist;
// a sign error on one side would break these: both sides of one line must sum to 1 for the model and the market
const off = (f: (p: Pair) => number) => Math.max(...perMatch.map((p) => Math.abs(f(p) - 1)));
out(`   check: max |model fav + model dog − 1| = ${off((p) => p.fav.mp + p.dog.mp).toFixed(5)} · market ${off((p) => p.fav.qp + p.dog.qp).toFixed(5)}`);
const agree = (which: 'fav' | 'dog') => {
  const ps = perMatch.filter((p) => p[which].agreement !== null);
  return { n: ps.length, yes: ps.filter((p) => p[which].agreement).length };
};
const ag = { fav: agree('fav'), dog: agree('dog') };
out(`   Elo agrees with the side (ranking ×1.0 vs ×0.7, STRONG needs it): favourite ${ag.fav.yes}/${ag.fav.n} · underdog ${ag.dog.yes}/${ag.dog.n}`);
json.eloAgreement = ag;

// rules-v0.6 picks: on the main line of their own run, with model and market on that same line
const v06 = (
  await db.query<{ public_id: string; market: string; selection: string; line: string; mp: string; qp: string; c_line: string | null; c_mp: string | null; c_qp: string | null; main_line: string | null; main_status: string | null }>(`
  select p.public_id, p.market, p.selection, p.line, p.model_probability mp, p.market_probability qp,
         c.line c_line, c.model_probability c_mp, c.market_probability c_qp,
         (select (m->>'line') from jsonb_array_elements(r.summary->'mainLines') m where m->>'market' = p.market) main_line,
         (select (m->>'status') from jsonb_array_elements(r.summary->'mainLines') m where m->>'market' = p.market) main_status
    from analysis_predictions p
    join analysis_runs r on r.id = p.run_id
    left join analysis_candidates c on c.id = p.candidate_id
   where p.kind = 'SIGNAL' and p.decision_rule_version = 'rules-v0.6'`)
).rows;
const ownHomeLine = (r: (typeof v06)[number]) => (r.market === 'ASIAN_HANDICAP' && r.selection === 'AWAY' ? -Number(r.line) : Number(r.line));
const offMain = v06.filter((r) => r.main_status !== 'OK' || Number(r.main_line) !== ownHomeLine(r));
const mismatch = v06.filter((r) => r.c_line === null || Number(r.c_line) !== Number(r.line) || Number(r.c_mp) !== Number(r.mp) || Number(r.c_qp) !== Number(r.qp));
out(`   rules-v0.6 picks: ${v06.length}; off their run's main line ${offMain.length}; model/market not from the same line's candidate ${mismatch.length}`);
json.mainLineCheck = { picks: v06.length, offMain: offMain.map((r) => r.public_id), mismatch: mismatch.map((r) => r.public_id) };

// ---------------------------------------------------------------- 3. who is right
out();
out('== 3. Who is right on the main line (one row per match) ==');
json.overall = block('all matches', perMatch);
const absBands: Array<[string, (x: number) => boolean]> = [
  ['AH 0', (x) => x === 0],
  ['AH 0.25–0.75', (x) => x >= 0.25 && x <= 0.75],
  ['AH 1–1.5', (x) => x >= 1 && x <= 1.5],
  ['AH 1.75+', (x) => x >= 1.75],
];
json.byLine = absBands.map(([name, f]) => {
  const ps = perMatch.filter((p) => f(p.absLine));
  const { dog } = block(name, ps);
  return { band: name, n: ps.length, lean: dog.lean, mp: dog.mp.mean, qp: dog.qp.mean, hit: dog.hit };
});
const oddsBands: Array<[string, (x: number) => boolean]> = [
  ['underdog odds < 1.85', (x) => x < 1.85],
  ['underdog odds 1.85–1.99', (x) => x >= 1.85 && x < 2],
  ['underdog odds 2.00–2.14', (x) => x >= 2 && x < 2.15],
  ['underdog odds ≥ 2.15', (x) => x >= 2.15],
];
json.byOdds = oddsBands.map(([name, f]) => {
  const ps = perMatch.filter((p) => f(p.dog.odds));
  const { dog } = block(name, ps);
  return { band: name, n: ps.length, lean: dog.lean, hit: dog.hit };
});
const windows: Array<[string, [number, number]]> = [
  ['≥ 24 h before kickoff', [24, 1e9]],
  ['6–24 h', [6, 24]],
  ['1–6 h', [1, 6]],
  ['< 1 h', [0, 1]],
];
json.byLeadTime = windows.map(([name, w]) => {
  const ps = lastPerFixture(pairs, w);
  const { dog } = block(name, ps);
  return { window: name, n: ps.length, lean: dog.lean, hit: dog.hit, passDog: ps.filter((p) => passV06(p.dog)).length, passFav: ps.filter((p) => passV06(p.fav)).length };
});
const versions = [...new Set(perMatch.map((p) => p.version))].sort();
json.byRules = versions.map((v) => {
  const ps = perMatch.filter((p) => p.version === v);
  const { dog } = block(`decided under ${v}`, ps);
  return { version: v, n: ps.length, lean: dog.lean };
});
out();
out('-- by league (10 largest)');
const leagues = [...new Set(perMatch.map((p) => p.league))]
  .map((l) => ({ l, ps: perMatch.filter((p) => p.league === l) }))
  .sort((a, b) => b.ps.length - a.ps.length)
  .slice(0, 10);
json.byLeague = leagues.map(({ l, ps }) => {
  const d = sideStats(ps, 'dog');
  out(`   ${l.padEnd(28)} n=${String(ps.length).padStart(4)}  lean ${pts(d.lean)}  model ${pct(d.mp)} market ${pct(d.qp)} hit ${pct(d.hit)}`);
  return { league: l, n: ps.length, lean: d.lean, mp: d.mp.mean, qp: d.qp.mean, hit: d.hit };
});

out();
out('-- the sides a pick rule could choose (edge 3–12 pts), what each side said and what happened');
json.edgeSides = (['fav', 'dog'] as const).map((which) => {
  const ps = perMatch.filter((p) => p[which].edge >= 0.03 && p[which].edge <= 0.12);
  const s = sideStats(ps, which);
  out(`   ${which === 'fav' ? 'favourite' : 'underdog '} n=${ps.length}: model ${pct(s.mp)} · market ${pct(s.qp)} · happened ${pct(s.hit)} · Brier diff ${num(s.brier.diff)}`);
  return { side: which, n: ps.length, mp: s.mp.mean, qp: s.qp.mean, hit: s.hit, brierDiff: s.brier.diff };
});

// ---------------------------------------------------------------- 1X2 favourites
out();
out('== 1X2: the market favourite by its price (last run per match) ==');
const mw = (
  await db.query<{ fixture_id: string; kickoff_at: Date; sel: string; mp: string; qp: string; gh: number; ga: number }>(`
  with last as (
    select distinct on (r.fixture_id) r.id, r.fixture_id
      from analysis_runs r join fixtures f on f.id = r.fixture_id
     where r.started_at < f.kickoff_at and f.status_short in ('FT', 'AET', 'PEN') and coalesce(f.ft_home, f.goals_home) is not null
     order by r.fixture_id, r.started_at desc
  )
  select last.fixture_id, f.kickoff_at, c.selection sel, c.model_probability mp, c.market_probability qp,
         coalesce(f.ft_home, f.goals_home) gh, coalesce(f.ft_away, f.goals_away) ga
    from last join analysis_candidates c on c.run_id = last.id and c.market = 'MATCH_WINNER' and c.model_probability is not null
    join fixtures f on f.id = last.fixture_id`)
).rows;
const mwBy = new Map<string, typeof mw>();
for (const r of mw) mwBy.set(r.fixture_id, [...(mwBy.get(r.fixture_id) ?? []), r]);
const favRows = [...mwBy.values()].flatMap((rs) => {
  if (rs.length !== 3) return [];
  const top = rs.reduce((a, b) => (Number(b.qp) > Number(a.qp) ? b : a));
  if (top.sel === 'DRAW') return [];
  const won = (top.sel === 'HOME' ? top.gh > top.ga : top.ga > top.gh) ? 1 : 0;
  return [{ day: footballDay(new Date(top.kickoff_at)).date, mp: Number(top.mp), qp: Number(top.qp), won }];
});
const bands: Array<[string, number, number]> = [['< 45%', 0, 0.45], ['45–55%', 0.45, 0.55], ['55–65%', 0.55, 0.65], ['65–75%', 0.65, 0.75], ['≥ 75%', 0.75, 2]];
json.mwFavourites = bands.map(([name, lo, hi]) => {
  const rs = favRows.filter((r) => r.qp >= lo && r.qp < hi);
  const m = mean(rs.map((r) => ({ cluster: r.day, value: r.mp })));
  const q = mean(rs.map((r) => ({ cluster: r.day, value: r.qp })));
  const w = mean(rs.map((r) => ({ cluster: r.day, value: r.won })));
  out(`   market ${name.padEnd(7)} n=${String(rs.length).padStart(4)}  model ${pct(m)}  market ${pct(q)}  won ${pct(w)}`);
  return { band: name, n: rs.length, mp: m.mean, qp: q.mean, won: w };
});
// slope of the model's log-odds on the market's for the favourite: 1 = as sharp as the market, < 1 = flatter
const lg = (p: number) => Math.log(p / (1 - p));
const xs = favRows.map((r) => lg(r.qp));
const ys = favRows.map((r) => lg(r.mp));
const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
const my = ys.reduce((a, b) => a + b, 0) / ys.length;
const slope = xs.reduce((a, x, i) => a + (x - mx) * (ys[i]! - my), 0) / xs.reduce((a, x) => a + (x - mx) ** 2, 0);
out(`   slope of model log-odds on market log-odds (favourite win): ${slope.toFixed(3)} on ${favRows.length} matches (1 = as sharp as the market)`);
json.mwSlope = { slope, n: favRows.length };

// ---------------------------------------------------------------- published picks
out();
out('== Published picks (one per match: latest SIGNAL) ==');
const picks = (
  await db.query<{
    fixture_id: string; market: string; selection: string; line: string | null; status: string; model_probability: string; market_probability: string; clv: string | null;
    decision_rule_version: string; kickoff_at: Date; publish_round: string; odds_at_publish: string; mw_home: string | null; mw_away: string | null;
  }>(`
  select distinct on (p.fixture_id) p.fixture_id, p.market, p.selection, p.line, p.status, p.model_probability, p.market_probability, p.clv,
         p.decision_rule_version, p.kickoff_at, p.publish_round, p.odds_at_publish,
         (select max(c.market_probability) from analysis_candidates c where c.run_id = p.run_id and c.market = 'MATCH_WINNER' and c.selection = 'HOME') mw_home,
         (select max(c.market_probability) from analysis_candidates c where c.run_id = p.run_id and c.market = 'MATCH_WINNER' and c.selection = 'AWAY') mw_away
    from analysis_predictions p
   where p.kind = 'SIGNAL'
   order by p.fixture_id, p.published_at desc, p.id desc`)
).rows;
const pickSide = (p: (typeof picks)[number]) => {
  if (p.market === 'OVER_UNDER') return p.selection === 'OVER' ? 'over' : 'under';
  const own = Number(p.line);
  if (own < 0) return 'fav';
  if (own > 0) return 'dog';
  if (p.mw_home === null || p.mw_away === null) return 'pk?';
  const homeFav = Number(p.mw_home) > Number(p.mw_away);
  return (p.selection === 'HOME') === homeFav ? 'fav' : 'dog';
};
function pickBlock(title: string, ps: typeof picks) {
  const groups = ['fav', 'dog', 'pk?', 'over', 'under'];
  out(`-- ${title}`);
  const res: Record<string, unknown> = {};
  for (const g of groups) {
    const rs = ps.filter((p) => pickSide(p) === g);
    if (!rs.length) continue;
    const settled = rs.filter((p) => p.status !== 'PENDING');
    const outcomes: Record<string, number> = {};
    for (const p of settled) outcomes[p.status] = (outcomes[p.status] ?? 0) + 1;
    const day = (p: (typeof picks)[number]) => footballDay(new Date(p.kickoff_at)).date;
    const ft = settled.flatMap((p) => {
      const t = fairTarget(p.status as Outcome);
      return t ? [{ cluster: day(p), weight: t.weight, value: t.y, p }] : [];
    });
    const hit = mean(ft);
    const mp = mean(ft.map((r) => ({ ...r, value: Number(r.p.model_probability) })));
    const qp = mean(ft.map((r) => ({ ...r, value: Number(r.p.market_probability) })));
    const clv = mean(settled.filter((p) => p.clv !== null && p.status !== 'VOID').map((p) => ({ cluster: day(p), value: Number(p.clv) })));
    out(`   ${g.padEnd(6)} picks ${String(rs.length).padStart(3)} settled ${String(settled.length).padStart(3)}  model ${pct(mp)}  market ${pct(qp)}  fair hit ${pct(hit)}  CLV ${pct(clv, 2)}  ${JSON.stringify(outcomes)}`);
    res[g] = { picks: rs.length, settled: settled.length, outcomes, hit, mp: mp.mean, qp: qp.mean, clv };
  }
  return res;
}
json.picks = {
  all: pickBlock('all rules', picks),
  v06: pickBlock('rules-v0.6 (main line)', picks.filter((p) => p.decision_rule_version === 'rules-v0.6')),
  before: pickBlock('before rules-v0.6', picks.filter((p) => p.decision_rule_version !== 'rules-v0.6')),
};

// ---------------------------------------------------------------- shadow v0.4
out();
out('== rules-v0.4-shadow (bias taken off the edge; locked picks, never published) beside the real picks of the same round ==');
type Locked = { source: string; fixture_id: string; qp: string; market: string; selection: string; line: string; clv: string | null; kickoff_at: Date; gh: number | null; ga: number | null; status_short: string; publish_round: string };
const locked = (
  await db.query<Locked>(`
  select 'shadow' source, s.fixture_id, s.market_probability qp, s.market, s.selection, s.line, s.clv, f.kickoff_at, s.publish_round,
         coalesce(f.ft_home, f.goals_home) gh, coalesce(f.ft_away, f.goals_away) ga, f.status_short
    from shadow_decisions s join fixtures f on f.id = s.fixture_id
   where s.outcome = 'SIGNAL' and s.locked_at is not null and s.publish_round in ('EARLY', 'LINEUP')
  union all
  select 'real', p.fixture_id, p.market_probability, p.market, p.selection, p.line, p.clv, f.kickoff_at, p.publish_round,
         coalesce(f.ft_home, f.goals_home), coalesce(f.ft_away, f.goals_away), f.status_short
    from analysis_predictions p join fixtures f on f.id = p.fixture_id
   where p.kind = 'SIGNAL' and p.publish_round in ('EARLY', 'LINEUP')
     and f.kickoff_at >= (select min(evaluated_at) from shadow_decisions)`)
).rows;
// AH 0 left as its own group here: the shadow table keeps no 1X2 to tell the favourite
const lockedSide = (s: Locked) =>
  s.market === 'OVER_UNDER' ? (s.selection === 'OVER' ? 'over' : 'under') : Number(s.line) < 0 ? 'fav' : Number(s.line) > 0 ? 'dog' : 'AH 0';
const shadowRes: Record<string, unknown> = {};
for (const round of ['EARLY', 'LINEUP']) {
  for (const source of ['real', 'shadow']) {
    out(`-- ${source} ${round}`);
    for (const g of ['fav', 'dog', 'AH 0', 'over', 'under', 'all']) {
      const rs = locked.filter((s) => s.source === source && s.publish_round === round && (g === 'all' || lockedSide(s) === g));
      if (!rs.length) continue;
      const settled = rs.filter((s) => ['FT', 'AET', 'PEN'].includes(s.status_short) && s.gh !== null);
      const ft = settled.flatMap((s) => {
        const o = settle({ market: s.market as 'ASIAN_HANDICAP', selection: s.selection as 'HOME', line: Number(s.line) }, s.gh!, s.ga!);
        const t = fairTarget(o);
        return t ? [{ cluster: footballDay(new Date(s.kickoff_at)).date, weight: t.weight, value: t.y, qp: Number(s.qp) }] : [];
      });
      const hit = mean(ft);
      // what the market gave the same picks: hit above it is the only sign of value at these prices
      const qp = mean(ft.map((r) => ({ ...r, value: r.qp })));
      const clv = mean(settled.filter((s) => s.clv !== null).map((s) => ({ cluster: footballDay(new Date(s.kickoff_at)).date, value: Number(s.clv) })));
      out(`   ${g.padEnd(6)} picks ${String(rs.length).padStart(3)} settled ${String(settled.length).padStart(3)}  market ${pct(qp)}  fair hit ${pct(hit)}  CLV ${pct(clv, 2)} (n ${clv.n})`);
      shadowRes[`${source}|${round}|${g}`] = { picks: rs.length, settled: settled.length, qp: qp.mean, hit, clv };
    }
  }
}
json.shadow = shadowRes;

await db.close();
mkdirSync('reports', { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
writeFileSync(`reports/underdog-bias-${stamp}.txt`, lines.join('\n') + '\n');
writeFileSync(`reports/underdog-bias-${stamp}.json`, JSON.stringify(json, null, 1));
console.log(lines.join('\n'));
