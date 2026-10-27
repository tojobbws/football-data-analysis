/**
 * Research 2026-10-27: model sharpness experiments (docs/research/underdog-bias-experiments.md). Read-only: it reads
 * fixtures, model_configs, external_odds and market_closing and writes reports/sharpness-<date>.json and .txt.
 * Production settings, picks and data are never written.
 *
 *   npx tsx scripts/research/sharpness-experiment.ts [--book PIN] [--burn-in-days 365] [--refit-days 7]
 *        [--lead-days 3] [--holdout-share 0.2] [--league 39,140 | all] [--skip-cups]
 *
 * Plan fixed before the run (selection rule in `selectCandidate`):
 *  - M0 = production SIDES settings per league (model_configs_latest); M1 = M0 with one priorStrength for every
 *    league; M2 = M0 with one halfLifeDays; M3 = the cup mix weight (cups only); M4 = M0 with the M1 and M2
 *    changes that passed; REF = the untuned default.
 *  - Domestic leagues: walk-forward against Pinnacle (football-data), early and closing prices. The last 20% of
 *    football days with an AH price is the final holdout, read once after the choice is made on the rest.
 *  - Primary metric: AH main-line Brier on the fair target at the early price; guard: 1X2 log loss at the early
 *    price. A candidate passes on the development days when it beats M0 with Holm p < 0.05 across its
 *    experiment and is not significantly worse on the guard.
 *  - Cups: no historical market prices, so the mix weights are judged on results (1X2 log loss, guard 1X2
 *    Brier) with the same split; the system's own closing consensus (market_closing) is the market there.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { type DixonColesOptions } from '@fp/analysis';
import { createPgDb, Repository } from '@fp/database';
import { CROSS_LEAGUE_CUPS, loadDotEnvFile, loadEnv } from '@fp/shared';
import { DC_OPTS, leaguesWithOdds } from '../market-rows.js';
import {
  AH_BANDS,
  buildConfigs,
  calibrationSlope,
  combinedConfig,
  DATA_BANDS,
  dayBootstrap,
  ece,
  holdoutCutoff,
  selectCandidate,
  sharpnessVsMarket,
  splitAt,
  underdogStats,
  versus,
  versusMarket,
  walkForward,
  walkForwardCup,
  x12Points,
  type CandidateResult,
  type Config,
  type FixtureMatch,
  type Metric,
  type Phase,
  type Quote,
  type Row,
} from './sharpness.js';

const { values } = parseArgs({
  options: {
    book: { type: 'string', default: 'PIN' },
    'burn-in-days': { type: 'string', default: '365' },
    'refit-days': { type: 'string', default: '7' },
    'lead-days': { type: 'string', default: '3' },
    'holdout-share': { type: 'string', default: '0.2' },
    league: { type: 'string', default: 'all' },
    'skip-cups': { type: 'boolean', default: false },
  },
});
const opts = {
  book: values.book!,
  burnInDays: Number(values['burn-in-days']),
  refitDays: Number(values['refit-days']),
  leadDays: Number(values['lead-days']),
  holdoutShare: Number(values['holdout-share']),
};
const PRIMARY: Metric = 'ah_brier';
const GUARD: Metric = 'x12_logloss';
const METRICS: Metric[] = ['ah_brier', 'ah_logloss', 'x12_brier', 'x12_logloss', 'ou_brier', 'ou_logloss'];
const CUP_BLENDS = [
  { id: 'M3-mix0.5', cupOnly: 0.5 },
  { id: 'M3-cupOnly', cupOnly: 1 },
  { id: 'M3-mix0.25', cupOnly: 0.25 },
  { id: 'M3-crossOnly', cupOnly: 0 },
];
// jobs.ts CROSS_LEAGUE_PRIOR
const CROSS_LEAGUE_PRIOR = 4;

loadDotEnvFile();
const env = loadEnv();
const db = createPgDb(env.DATABASE_URL!, { max: 2 });
const repo = new Repository(db);
const started = Date.now();
const log = (msg: string) => console.error(`[${((Date.now() - started) / 1000).toFixed(0)}s] ${msg}`);

// ---------------------------------------------------------------- inputs
const prodRows = (
  await db.query<{ league_id: number; params: Record<string, unknown>; tuned_at: Date; enabled: boolean }>(
    `select league_id, params, tuned_at, enabled from model_configs_latest where purpose = 'SIDES'`,
  )
).rows;
const production = new Map<number, DixonColesOptions>(
  prodRows.map((r) => [
    r.league_id,
    Object.freeze({
      priorStrength: Number(r.params.priorStrength),
      halfLifeDays: Number(r.params.halfLifeDays),
      xgWeight: Number(r.params.xgWeight),
      redCardDiscount: Number(r.params.redCardDiscount ?? 0),
    }),
  ]),
);
const configs = buildConfigs(production, DC_OPTS);

const toMatches = (ms: Awaited<ReturnType<Repository['finishedMatches']>>): FixtureMatch[] =>
  ms.map((m) => ({ fixtureId: m.fixtureId, kickoffAt: m.kickoffAt, homeTeamId: m.homeTeamId, awayTeamId: m.awayTeamId, homeGoals: m.homeGoals, awayGoals: m.awayGoals, homeXg: m.homeXg, awayXg: m.awayXg, redCardMinute: m.redCardMinute }));

async function externalQuotes(leagueId: number) {
  const rows = (
    await db.query<{ fixture_id: string; phase: Phase; market: string; selection: string; line: string | null; odds: string }>(
      `select o.fixture_id, o.phase, o.market, o.selection, o.line, o.odds from external_odds o join fixtures f on f.id = o.fixture_id
        where f.league_id = $1 and o.bookmaker = $2`,
      [leagueId, opts.book],
    )
  ).rows;
  const by = new Map<number, Partial<Record<Phase, Record<string, { line: number | null; odds: number }>>>>();
  for (const r of rows) {
    const f = by.get(Number(r.fixture_id)) ?? {};
    by.set(Number(r.fixture_id), f);
    const ph = (f[r.phase] ??= {});
    ph[`${r.market}|${r.selection}`] = { line: r.line === null ? null : Number(r.line), odds: Number(r.odds) };
  }
  const out = new Map<number, Partial<Record<Phase, Quote>>>();
  for (const [fx, phases] of by) {
    const q: Partial<Record<Phase, Quote>> = {};
    for (const ph of ['early', 'close'] as const) {
      const s = phases[ph];
      if (!s) continue;
      const quote: Quote = {};
      const [h, d, a] = ['HOME', 'DRAW', 'AWAY'].map((x) => s[`MATCH_WINNER|${x}`]);
      if (h && d && a) quote.x12 = [h.odds, d.odds, a.odds];
      const ah = s['ASIAN_HANDICAP|HOME'];
      const aw = s['ASIAN_HANDICAP|AWAY'];
      if (ah && aw && ah.line !== null) quote.ah = { line: ah.line, home: ah.odds, away: aw.odds };
      const ov = s['OVER_UNDER|OVER'];
      const un = s['OVER_UNDER|UNDER'];
      if (ov && un && ov.line === 2.5 && un.line === 2.5) quote.ou25 = { over: ov.odds, under: un.odds };
      if (quote.x12 || quote.ah || quote.ou25) q[ph] = quote;
    }
    out.set(fx, q);
  }
  return out;
}

// ---------------------------------------------------------------- summaries
type Stat = { mean: number | null; lo: number | null; hi: number | null; n: number; clusters: number };
const st = (m: { mean: number | null; lo: number | null; hi: number | null; n: number; clusters: number }): Stat => ({ mean: m.mean, lo: m.lo, hi: m.hi, n: m.n, clusters: m.clusters });

function summary(rows: readonly Row[], control: readonly Row[] | null) {
  const out: Record<string, unknown> = { matches: new Set(rows.map((r) => r.fixtureId)).size, days: new Set(rows.map((r) => r.day)).size };
  for (const m of METRICS) {
    const vm = versusMarket(rows, m);
    out[m] = {
      model: st(vm.model),
      market: st(vm.market),
      vsMarket: st(vm.diff),
      ...(control ? { vsM0: st(versus(control, rows, m).diff) } : {}),
    };
  }
  const pts = x12Points(rows);
  out.calibrationSlope = dayBootstrap(pts, (p) => calibrationSlope(p));
  const withQ = pts.filter((p): p is typeof p & { q: number } => p.q !== null);
  out.sharpnessVsMarket = withQ.length ? dayBootstrap(withQ, (p) => sharpnessVsMarket(p)) : null;
  out.marketCalibrationSlope = withQ.length ? dayBootstrap(withQ, (p) => calibrationSlope(p.map((x) => ({ p: x.q, y: x.y })))) : null;
  const e = ece(pts);
  out.ece = e.ece;
  out.reliability = e.bins;
  out.marketEce = withQ.length ? ece(withQ.map((x) => ({ p: x.q, y: x.y }))).ece : null;
  const u = underdogStats(rows);
  out.underdog = { n: u.n, model: st(u.model), market: st(u.market), happened: st(u.happened), lean: st(u.lean) };
  // O/U 2.5 kept apart from the AH lean: over side
  const ou = rows.filter((r) => r.ou);
  out.over25 = {
    n: ou.length,
    model: ou.length ? ou.reduce((s, r) => s + r.ou!.p, 0) / ou.length : null,
    market: ou.length ? ou.reduce((s, r) => s + r.ou!.q, 0) / ou.length : null,
    happened: ou.length ? ou.reduce((s, r) => s + r.ou!.w * r.ou!.y, 0) / ou.reduce((s, r) => s + r.ou!.w, 0) : null,
  };
  return out;
}

function breakdowns(rows: readonly Row[], control: readonly Row[]) {
  const group = <K extends string>(name: (r: Row) => K | null) => {
    const by = new Map<K, Row[]>();
    for (const r of rows) {
      const k = name(r);
      if (k !== null) by.set(k, [...(by.get(k) ?? []), r]);
    }
    return Object.fromEntries(
      [...by].map(([k, rs]) => {
        const u = underdogStats(rs);
        return [k, { n: new Set(rs.map((r) => r.fixtureId)).size, ahVsM0: st(versus(control, rs, 'ah_brier').diff), ahVsMarket: st(versusMarket(rs, 'ah_brier').diff), x12LlVsMarket: st(versusMarket(rs, 'x12_logloss').diff), lean: st(u.lean), dogModel: u.model.mean, dogMarket: u.market.mean, dogHappened: st(u.happened) }];
      }),
    );
  };
  return {
    ahBand: group((r) => (r.ah ? (AH_BANDS.find((b) => b.test(Math.abs(r.ah!.line)))?.name ?? null) : null)),
    teamData: group((r) => DATA_BANDS.find((b) => b.test(r.minTeamMatches))?.name ?? null),
    league: group((r) => String(r.leagueId)),
  };
}

const fmt = (s: Stat | undefined | null, d = 4) => (!s || s.mean === null ? '—' : `${s.mean.toFixed(d)}${s.lo !== null ? ` [${s.lo.toFixed(d)}, ${s.hi!.toFixed(d)}]` : ''}`);
const lines: string[] = [];
const out = (s = '') => {
  lines.push(s);
  console.log(s);
};

// ---------------------------------------------------------------- domestic leagues (M0, M1, M2, M4, REF)
const leagues = (await leaguesWithOdds(db, opts.book, values.league === 'all' ? null : values.league!.split(',').map(Number))).filter((l) => !CROSS_LEAGUE_CUPS[l.id]);
const allRows: Row[] = [];
const matchesBy = new Map<number, FixtureMatch[]>();
const quotesBy = new Map<number, Map<number, Partial<Record<Phase, Quote>>>>();
for (const l of leagues) {
  const matches = toMatches(await repo.finishedMatches(l.id));
  if (!matches.length) continue;
  const quotes = await externalQuotes(l.id);
  matchesBy.set(l.id, matches);
  quotesBy.set(l.id, quotes);
  const from = new Date(matches[0]!.kickoffAt.getTime() + opts.burnInDays * 86_400_000);
  const rows = walkForward({ leagueId: l.id, matches, quotes, configs, from, refitDays: opts.refitDays, leadDays: opts.leadDays });
  allRows.push(...rows);
  log(`${l.name} (${l.id}): ${matches.length} matches, ${new Set(rows.map((r) => r.fixtureId)).size} scored`);
}
const of = (rows: readonly Row[], id: string, phase: Phase) => rows.filter((r) => r.config === id && r.phase === phase);
const cutoff = holdoutCutoff(allRows.filter((r) => r.config === 'M0' && r.phase === 'early' && r.ah).map((r) => r.day), opts.holdoutShare);
const { dev, holdout } = splitAt(allRows, cutoff);
const devDays = [...new Set(of(dev, 'M0', 'early').map((r) => r.day))].sort();

out(`Model sharpness experiments — ${new Date().toISOString()}`);
out(`book ${opts.book} · burn-in ${opts.burnInDays} d · refit every ${opts.refitDays} d · fit cut ${opts.leadDays} d before kickoff · holdout share ${opts.holdoutShare}`);
out(`leagues: ${leagues.map((l) => `${l.name} (${l.id})`).join(', ')}`);
out(`development: ${devDays[0]} .. ${devDays.at(-1)} · final holdout from ${cutoff}`);
out(`M0 production SIDES settings: ${JSON.stringify(Object.fromEntries([...production].filter(([l]) => matchesBy.has(l))))}`);
out();

const selections: Record<string, ReturnType<typeof selectCandidate>> = {};
const printSel = (name: string, s: ReturnType<typeof selectCandidate>) => {
  out(`== ${name}: development, early price, vs M0 (below 0 = candidate better) ==`);
  for (const r of s.results as CandidateResult[])
    out(`   ${r.id.padEnd(14)} AH Brier ${fmt(st(r.primary.diff), 5)}  p ${r.p?.toFixed(4) ?? '—'}  Holm ${r.pHolm?.toFixed(4) ?? '—'}  1X2 LL ${fmt(st(r.guard.diff), 5)}  ${r.passes ? 'PASS' : 'no'}`);
  out(`   chosen: ${s.chosen ?? 'none'}`);
  out();
};
for (const fam of ['M1', 'M2'] as const) {
  const ids = configs.filter((c) => c.family === fam).map((c) => c.id);
  selections[fam] = selectCandidate(dev, 'M0', ids, { primary: PRIMARY, guard: GUARD, phase: 'early' });
  printSel(fam === 'M1' ? 'M1 prior strength' : 'M2 half-life', selections[fam]!);
}

// M4: only the changes that passed
const changes: DixonColesOptions = {};
const chosenCfg = (id: string | null) => configs.find((c) => c.id === id);
if (selections.M1!.chosen) changes.priorStrength = chosenCfg(selections.M1!.chosen)!.dc(-1).priorStrength;
if (selections.M2!.chosen) changes.halfLifeDays = chosenCfg(selections.M2!.chosen)!.dc(-1).halfLifeDays;
let m4: Config | null = null;
if (changes.priorStrength !== undefined && changes.halfLifeDays !== undefined) {
  m4 = combinedConfig(production, DC_OPTS, changes);
  for (const l of leagues) {
    const matches = matchesBy.get(l.id);
    if (!matches) continue;
    const from = new Date(matches[0]!.kickoffAt.getTime() + opts.burnInDays * 86_400_000);
    allRows.push(...walkForward({ leagueId: l.id, matches, quotes: quotesBy.get(l.id)!, configs: [m4], from, refitDays: opts.refitDays, leadDays: opts.leadDays }));
  }
  const split = splitAt(allRows.filter((r) => r.config === 'M4'), cutoff);
  dev.push(...split.dev);
  holdout.push(...split.holdout);
  selections.M4 = selectCandidate(dev, 'M0', ['M4'], { primary: PRIMARY, guard: GUARD, phase: 'early' });
  printSel('M4 combined', selections.M4);
} else {
  out(`== M4 combined: not built (needs a passing M1 and M2; M1 ${selections.M1!.chosen ?? 'none'}, M2 ${selections.M2!.chosen ?? 'none'}) ==`);
  out();
}

// what goes to the holdout: M0, REF, each experiment's choice; with no choice its best development candidate, for direction only
const bestDev = (fam: string) => [...selections[fam]!.results].sort((a, b) => a.primary.diff.mean! - b.primary.diff.mean!)[0]!.id;
const toHoldout = [
  'M0',
  'REF-default',
  ...(['M1', 'M2', 'M4'] as const).filter((f) => selections[f]).map((f) => selections[f]!.chosen ?? bestDev(f)),
];
const result: Record<string, unknown> = {
  opts,
  cutoff,
  development: { from: devDays[0], to: devDays.at(-1) },
  production: Object.fromEntries(production),
  leagues,
  selections: Object.fromEntries(Object.entries(selections).map(([k, s]) => [k, { chosen: s.chosen, results: s.results.map((r) => ({ id: r.id, primary: st(r.primary.diff), guard: st(r.guard.diff), p: r.p, pHolm: r.pHolm, passes: r.passes })) }])),
  holdoutConfigs: toHoldout,
  domestic: {} as Record<string, unknown>,
};
const domestic = result.domestic as Record<string, unknown>;
for (const phase of ['early', 'close'] as const) {
  out(`== ${phase} price: development and final holdout (vs market: below 0 = model better) ==`);
  for (const [part, rows] of [['development', dev], ['holdout', holdout]] as const) {
    const ctl = of(rows, 'M0', phase);
    for (const id of part === 'development' ? configs.map((c) => c.id).concat(m4 ? ['M4'] : []) : toHoldout) {
      const rs = of(rows, id, phase);
      if (!rs.length) continue;
      const s = summary(rs, id === 'M0' ? null : ctl) as Record<string, any>;
      domestic[`${phase}|${part}|${id}`] = s;
      out(
        `   ${part.padEnd(11)} ${id.padEnd(14)} n ${String(s.matches).padStart(5)}  AH Brier ${fmt(s.ah_brier.model, 4)} vsMkt ${fmt(s.ah_brier.vsMarket, 4)}${s.ah_brier.vsM0 ? ` vsM0 ${fmt(s.ah_brier.vsM0, 5)}` : ''}  1X2 LL vsMkt ${fmt(s.x12_logloss.vsMarket, 4)}  slope ${s.calibrationSlope.estimate?.toFixed(3)}  sharp ${s.sharpnessVsMarket?.estimate?.toFixed(3) ?? '—'}  dog lean ${fmt(s.underdog.lean, 4)}`,
      );
    }
  }
  out();
}
// breakdowns on the holdout, early price
const hold = (id: string) => of(holdout, id, 'early');
result.breakdowns = Object.fromEntries(toHoldout.map((id) => [id, breakdowns(hold(id), hold('M0'))]));
out('== holdout breakdowns (early price): AH band / team data / league ==');
for (const id of toHoldout) {
  const b = (result.breakdowns as Record<string, ReturnType<typeof breakdowns>>)[id]!;
  out(`-- ${id}`);
  for (const [kind, groups] of Object.entries(b))
    for (const [k, g] of Object.entries(groups as Record<string, any>))
      out(`   ${kind.padEnd(8)} ${String(k).padEnd(14)} n ${String(g.n).padStart(4)}  AH vsM0 ${fmt(g.ahVsM0, 5)}  AH vsMkt ${fmt(g.ahVsMarket, 4)}  lean ${fmt(g.lean, 4)}  dog ${g.dogModel?.toFixed(3)}/${g.dogMarket?.toFixed(3)}/${fmt(g.dogHappened, 3)}`);
}
out();

// ---------------------------------------------------------------- cups (M3)
if (!values['skip-cups']) {
  out('== M3 cross-league cups: mix weight of the cup-only fit (production 0.5) ==');
  const cupRows: Row[] = [];
  const domesticCache = new Map<number, FixtureMatch[]>();
  const live = (
    await db.query<{ fixture_id: string; market: string; selection: string; line: string | null; market_probability: string }>(
      `select c.fixture_id, c.market, c.selection, c.line, c.market_probability from market_closing c join fixtures f on f.id = c.fixture_id
        where f.league_id = any($1::int[]) and c.market_probability is not null`,
      [[2, 3, 848]],
    )
  ).rows;
  const liveBy = new Map<number, Quote>();
  {
    const by = new Map<number, typeof live>();
    for (const r of live) by.set(Number(r.fixture_id), [...(by.get(Number(r.fixture_id)) ?? []), r]);
    // the closing consensus stores de-margined probabilities; 1/q as odds de-margins back to the same q
    for (const [fx, rs] of by) {
      const get = (m: string, s: string) => rs.find((r) => r.market === m && r.selection === s);
      const quote: Quote = {};
      const [h, d, a] = ['HOME', 'DRAW', 'AWAY'].map((s) => get('MATCH_WINNER', s));
      if (h && d && a) quote.x12 = [1 / Number(h.market_probability), 1 / Number(d.market_probability), 1 / Number(a.market_probability)];
      const ah = get('ASIAN_HANDICAP', 'HOME');
      const aw = get('ASIAN_HANDICAP', 'AWAY');
      if (ah && aw && ah.line !== null) quote.ah = { line: Number(ah.line), home: 1 / Number(ah.market_probability), away: 1 / Number(aw.market_probability) };
      const ov = get('OVER_UNDER', 'OVER');
      const un = get('OVER_UNDER', 'UNDER');
      if (ov && un && Number(ov.line) === 2.5) quote.ou25 = { over: 1 / Number(ov.market_probability), under: 1 / Number(un.market_probability) };
      liveBy.set(fx, quote);
    }
  }
  for (const cup of [2, 3, 848]) {
    const matches = toMatches(await repo.finishedMatches(cup));
    if (!matches.length) continue;
    const domesticMap = new Map<number, FixtureMatch[]>();
    for (const l of CROSS_LEAGUE_CUPS[cup]!) {
      if (!domesticCache.has(l)) domesticCache.set(l, toMatches(await repo.finishedMatches(l)));
      domesticMap.set(l, domesticCache.get(l)!);
    }
    const dc = production.get(cup) ?? DC_OPTS;
    const from = new Date(matches[0]!.kickoffAt.getTime() + opts.burnInDays * 86_400_000);
    const rows = walkForwardCup({ leagueId: cup, matches, domestic: domesticMap, dc, leaguePrior: CROSS_LEAGUE_PRIOR, blends: CUP_BLENDS, quotes: liveBy, from, refitDays: 14, leadDays: opts.leadDays });
    cupRows.push(...rows);
    log(`cup ${cup}: ${matches.length} matches, ${new Set(rows.map((r) => r.fixtureId)).size} scored`);
  }
  const cupCut = holdoutCutoff(cupRows.filter((r) => r.config === 'M3-mix0.5').map((r) => r.day), opts.holdoutShare);
  const cs = splitAt(cupRows, cupCut);
  const sel = selectCandidate(cs.dev, 'M3-mix0.5', CUP_BLENDS.slice(1).map((b) => b.id), { primary: 'x12_logloss', guard: 'x12_brier', phase: 'close' });
  out(`development before ${cupCut}, holdout from ${cupCut}; primary 1X2 log loss on results, guard 1X2 Brier`);
  for (const r of sel.results) out(`   ${r.id.padEnd(14)} 1X2 LL vs mix0.5 ${fmt(st(r.primary.diff), 5)}  Holm ${r.pHolm?.toFixed(4) ?? '—'}  Brier ${fmt(st(r.guard.diff), 5)}  ${r.passes ? 'PASS' : 'no'}`);
  out(`   chosen: ${sel.chosen ?? 'none'}`);
  const cupOut: Record<string, unknown> = { cutoff: cupCut, selection: { chosen: sel.chosen, results: sel.results.map((r) => ({ id: r.id, primary: st(r.primary.diff), guard: st(r.guard.diff), p: r.p, pHolm: r.pHolm, passes: r.passes })) } };
  for (const [part, rows] of [['development', cs.dev], ['holdout', cs.holdout]] as const) {
    const ctl = rows.filter((r) => r.config === 'M3-mix0.5');
    for (const b of CUP_BLENDS) {
      const rs = rows.filter((r) => r.config === b.id);
      const s = summary(rs, b.id === 'M3-mix0.5' ? null : ctl) as Record<string, any>;
      const x12 = versus(ctl, rs, 'x12_logloss');
      cupOut[`${part}|${b.id}`] = { ...s, x12LoglossVsMix: st(x12.diff), x12Logloss: st(x12.model) };
      out(`   ${part.padEnd(11)} ${b.id.padEnd(14)} n ${String(s.matches).padStart(4)}  1X2 LL ${fmt(st(x12.model), 4)}  vs mix0.5 ${fmt(st(x12.diff), 5)}  slope ${s.calibrationSlope.estimate?.toFixed(3)} [${s.calibrationSlope.lo?.toFixed(3)}, ${s.calibrationSlope.hi?.toFixed(3)}]`);
    }
  }
  // the live closing market (Oct 2026): every blend against the same matches
  const liveRows = cupRows.filter((r) => r.x12?.q);
  for (const b of CUP_BLENDS) {
    const rs = liveRows.filter((r) => r.config === b.id);
    const s = summary(rs, null) as Record<string, any>;
    cupOut[`live|${b.id}`] = s;
    out(`   live mkt    ${b.id.padEnd(14)} n ${String(s.matches).padStart(4)}  1X2 LL vsMkt ${fmt(s.x12_logloss.vsMarket, 4)}  AH Brier vsMkt ${fmt(s.ah_brier.vsMarket, 4)}  sharp ${s.sharpnessVsMarket?.estimate?.toFixed(3) ?? '—'}  dog lean ${fmt(s.underdog.lean, 4)}`);
  }
  result.cups = cupOut;
  out();
}

await db.close();
mkdirSync('reports', { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
writeFileSync(`reports/sharpness-${stamp}.json`, JSON.stringify(result, null, 1));
writeFileSync(`reports/sharpness-${stamp}.txt`, lines.join('\n') + '\n');
log('done');
