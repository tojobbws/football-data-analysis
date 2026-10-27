/**
 * Research 2026-10-27 (docs/research/underdog-bias-*.md): is Dixon-Coles flatter than the market because of
 * its settings, and does changing one setting make it better? Pure functions, no DB, never used by production.
 *
 * Every prediction is walk-forward: the model for a match is fitted on matches that kicked off at least
 * `leadDays` before it (so it never knows a result the early market price could not have known), refitted
 * every `refitDays`. Each config has its own fit; all configs score the same matches.
 */
import {
  brier3,
  clusteredMean,
  clusterSums,
  crossLeagueExpectedGoals,
  expectedGoals,
  fairTarget,
  fitCrossLeague,
  fitDixonColes,
  holmAdjust,
  logLoss3,
  mixScoreMatrices,
  outcomeIndex,
  pairedComparison,
  priceSelection,
  scoreMatrix,
  settle,
  sortByTime,
  twoSidedP,
  type ClusteredMean,
  type CrossLeagueModel,
  type DixonColesModel,
  type DixonColesOptions,
  type MatchRecord,
  type PairedComparison,
  type Probs3,
} from '@fp/analysis';
import { footballDay } from '@fp/shared';

export type Phase = 'early' | 'close';

/** Decimal odds of one bookmaker at one phase. AH: the home line and both prices; O/U: the 2.5 line. */
export interface Quote {
  x12?: readonly [number, number, number];
  ah?: { line: number; home: number; away: number };
  ou25?: { over: number; under: number };
}

export interface Config {
  id: string;
  /** M0 control, M1 prior, M2 half-life, M3 cups, M4 combined, REF reference */
  family: 'M0' | 'M1' | 'M2' | 'M3' | 'M4' | 'REF';
  label: string;
  dc: (leagueId: number) => DixonColesOptions;
}

export interface FixtureMatch extends MatchRecord {
  fixtureId: number;
}

/** One match, one phase, one config. AH and O/U are scored on the first side (HOME / OVER). */
export interface Row {
  config: string;
  fixtureId: number;
  leagueId: number;
  phase: Phase;
  day: string;
  kickoffAt: Date;
  /** fewer weighted matches of the two teams in the fit (how much data the model had) */
  minTeamMatches: number;
  /** q null = no market price for this match (cup results-only rows) */
  x12?: { p: Probs3; q: Probs3 | null; o: 0 | 1 | 2 };
  ah?: { line: number; p: number; q: number; y: 0 | 1; w: number };
  ou?: { p: number; q: number; y: 0 | 1; w: number };
}

export function noVig(odds: readonly number[]): number[] {
  const inv = odds.map((o) => 1 / o);
  const s = inv.reduce((a, b) => a + b, 0);
  return inv.map((x) => x / s);
}

/** Model probabilities of one match from its score matrix, scored against the market and the 90-minute result. */
export function scoreRow(
  base: Omit<Row, 'x12' | 'ah' | 'ou'>,
  mx: number[][],
  quote: Quote,
  result: { home: number; away: number },
): Row {
  const row: Row = { ...base };
  if (quote.x12 && quote.x12.every((o) => o > 1)) {
    const sel = ['HOME', 'DRAW', 'AWAY'] as const;
    row.x12 = {
      p: sel.map((s) => priceSelection(mx, { market: 'MATCH_WINNER', selection: s }).probability) as unknown as Probs3,
      q: noVig(quote.x12) as unknown as Probs3,
      o: outcomeIndex(result.home, result.away),
    };
  }
  if (quote.ah && quote.ah.home > 1 && quote.ah.away > 1) {
    const sel = { market: 'ASIAN_HANDICAP', selection: 'HOME', line: quote.ah.line } as const;
    const t = fairTarget(settle(sel, result.home, result.away));
    if (t) row.ah = { line: quote.ah.line, p: priceSelection(mx, sel).probability, q: noVig([quote.ah.home, quote.ah.away])[0]!, y: t.y, w: t.weight };
  }
  if (quote.ou25 && quote.ou25.over > 1 && quote.ou25.under > 1) {
    const sel = { market: 'OVER_UNDER', selection: 'OVER', line: 2.5 } as const;
    const t = fairTarget(settle(sel, result.home, result.away));
    if (t) row.ou = { p: priceSelection(mx, sel).probability, q: noVig([quote.ou25.over, quote.ou25.under])[0]!, y: t.y, w: t.weight };
  }
  return row;
}

/**
 * Walk-forward rows of one league for every config. A config refits when its last fit is `refitDays` old;
 * each fit sees only matches before `kickoff − leadDays`.
 */
export function walkForward(input: {
  leagueId: number;
  matches: readonly FixtureMatch[];
  quotes: ReadonlyMap<number, Partial<Record<Phase, Quote>>>;
  configs: readonly Config[];
  from: Date;
  refitDays: number;
  leadDays: number;
}): Row[] {
  const rows: Row[] = [];
  const matches = sortByTime(input.matches);
  const state = new Map<string, { model: DixonColesModel | null; fittedAt: number }>(input.configs.map((c) => [c.id, { model: null, fittedAt: -Infinity }]));
  for (const m of matches) {
    if (m.kickoffAt < input.from) continue;
    const q = input.quotes.get(m.fixtureId);
    if (!q) continue;
    const asOf = new Date(m.kickoffAt.getTime() - input.leadDays * 86_400_000);
    for (const c of input.configs) {
      const s = state.get(c.id)!;
      if (!s.model || asOf.getTime() - s.fittedAt >= input.refitDays * 86_400_000) {
        s.model = fitDixonColes(matches, asOf, c.dc(input.leagueId), s.model ?? undefined);
        s.fittedAt = asOf.getTime();
      }
      const g = expectedGoals(s.model, m.homeTeamId, m.awayTeamId);
      const mx = scoreMatrix(g.lambda, g.mu, s.model.rho);
      const minTeamMatches = Math.min(s.model.teamMatches.get(m.homeTeamId) ?? 0, s.model.teamMatches.get(m.awayTeamId) ?? 0);
      for (const phase of ['early', 'close'] as const) {
        const quote = q[phase];
        if (!quote) continue;
        const base = { config: c.id, fixtureId: m.fixtureId, leagueId: input.leagueId, phase, day: footballDay(m.kickoffAt).date, kickoffAt: m.kickoffAt, minTeamMatches };
        const row = scoreRow(base, mx, quote, { home: m.homeGoals, away: m.awayGoals });
        if (row.x12 || row.ah || row.ou) rows.push(row);
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------- losses

export type Metric = 'ah_brier' | 'ah_logloss' | 'x12_brier' | 'x12_logloss' | 'ou_brier' | 'ou_logloss';
const clip = (p: number) => Math.min(1 - 1e-12, Math.max(1e-12, p));

/** Loss of the model (`p`) or the market (`q`) on one row; null = the row has no such market. Weight = fair weight. */
export function loss(r: Row, metric: Metric, who: 'model' | 'market'): { v: number; w: number } | null {
  const pick = <T>(a: T, b: T) => (who === 'model' ? a : b);
  switch (metric) {
    case 'x12_brier':
      return r.x12 && (who === 'model' || r.x12.q) ? { v: brier3(pick(r.x12.p, r.x12.q!), r.x12.o), w: 1 } : null;
    case 'x12_logloss':
      return r.x12 && (who === 'model' || r.x12.q) ? { v: logLoss3(pick(r.x12.p, r.x12.q!), r.x12.o), w: 1 } : null;
    case 'ah_brier':
    case 'ou_brier': {
      const s = metric === 'ah_brier' ? r.ah : r.ou;
      return s ? { v: (pick(s.p, s.q) - s.y) ** 2, w: s.w } : null;
    }
    case 'ah_logloss':
    case 'ou_logloss': {
      const s = metric === 'ah_logloss' ? r.ah : r.ou;
      if (!s) return null;
      const p = clip(pick(s.p, s.q));
      return { v: -Math.log(s.y ? p : 1 - p), w: s.w };
    }
  }
}

const key = (r: Row) => `${r.fixtureId}|${r.phase}`;

/** Candidate minus control on the same matches (below 0 = candidate better), clustered by football day. */
export function versus(control: readonly Row[], candidate: readonly Row[], metric: Metric): PairedComparison {
  const ctl = new Map(control.map((r) => [key(r), r]));
  const rows = candidate.flatMap((r) => {
    const c = ctl.get(key(r));
    const a = loss(r, metric, 'model');
    const b = c && loss(c, metric, 'model');
    return a && b ? [{ cluster: r.day, weight: a.w, model: a.v, market: b.v }] : [];
  });
  return pairedComparison(rows);
}

/** Model minus market on the same rows. */
export function versusMarket(rows: readonly Row[], metric: Metric): PairedComparison {
  return pairedComparison(
    rows.flatMap((r) => {
      const a = loss(r, metric, 'model');
      const b = loss(r, metric, 'market');
      return a && b ? [{ cluster: r.day, weight: a.w, model: a.v, market: b.v }] : [];
    }),
  );
}

// ---------------------------------------------------------------- configs

export const PRIOR_GRID = [1, 3, 8, 20] as const;
export const HALF_LIFE_GRID = [120, 240, 365, 730, 1095] as const;

/**
 * M0 = each league's production SIDES settings (or the untuned default). M1 changes only priorStrength, M2 only
 * halfLifeDays, each on top of M0's per-league settings. Copies only: production objects are never written.
 */
export function buildConfigs(production: ReadonlyMap<number, DixonColesOptions>, fallback: DixonColesOptions): Config[] {
  const m0 = (league: number): DixonColesOptions => ({ ...(production.get(league) ?? fallback) });
  return [
    { id: 'M0', family: 'M0', label: 'production per-league settings', dc: m0 },
    { id: 'REF-default', family: 'REF', label: 'untuned default for every league', dc: () => ({ ...fallback }) },
    ...PRIOR_GRID.map((k): Config => ({ id: `M1-prior${k}`, family: 'M1', label: `M0 with priorStrength ${k}`, dc: (l) => ({ ...m0(l), priorStrength: k }) })),
    ...HALF_LIFE_GRID.map((h): Config => ({ id: `M2-hl${h}`, family: 'M2', label: `M0 with halfLifeDays ${h}`, dc: (l) => ({ ...m0(l), halfLifeDays: h }) })),
  ];
}

/** M4: M0 with every change that passed its own experiment. */
export function combinedConfig(production: ReadonlyMap<number, DixonColesOptions>, fallback: DixonColesOptions, changes: DixonColesOptions): Config {
  return { id: 'M4', family: 'M4', label: `M0 with ${JSON.stringify(changes)}`, dc: (l) => ({ ...(production.get(l) ?? fallback), ...changes }) };
}

// ---------------------------------------------------------------- holdout and selection

/** Development rows (before the cutoff day) and the final holdout (from it on). */
export function splitAt<T extends { day: string }>(rows: readonly T[], cutoff: string) {
  return { dev: rows.filter((r) => r.day < cutoff), holdout: rows.filter((r) => r.day >= cutoff) };
}

/** First football day of the final holdout: the last `share` of the distinct days that have a row. */
export function holdoutCutoff(days: Iterable<string>, share: number): string {
  const d = [...new Set(days)].sort();
  if (!d.length) throw new Error('no days');
  return d[Math.min(d.length - 1, Math.floor(d.length * (1 - share)))]!;
}

export interface CandidateResult {
  id: string;
  primary: PairedComparison;
  guard: PairedComparison;
  p: number | null;
  pHolm: number | null;
  passes: boolean;
}

/**
 * The rule fixed before any result was seen: within one experiment, a candidate passes on the development
 * rows when it beats the control on the primary metric with a Holm-adjusted p < alpha across the
 * experiment's candidates, and is not significantly worse on the guard metric (its interval's lower end ≤ 0).
 * The chosen one is the passing candidate with the lowest primary difference; none passing = no change.
 * Only development rows may be passed in; the caller keeps the holdout away from this function.
 */
export function selectCandidate(
  dev: readonly Row[],
  controlId: string,
  candidateIds: readonly string[],
  opts: { primary: Metric; guard: Metric; phase: Phase; alpha?: number },
): { results: CandidateResult[]; chosen: string | null } {
  const of = (id: string) => dev.filter((r) => r.config === id && r.phase === opts.phase);
  const control = of(controlId);
  const raw = candidateIds.map((id) => {
    const primary = versus(control, of(id), opts.primary);
    const guard = versus(control, of(id), opts.guard);
    return { id, primary, guard, p: twoSidedP(primary.diff) };
  });
  const adjusted = holmAdjust(raw.map((r) => r.p));
  const alpha = opts.alpha ?? 0.05;
  const results = raw.map((r, i) => {
    const pHolm = adjusted[i] ?? null;
    const better = (r.primary.diff.mean ?? 0) < 0 && pHolm !== null && pHolm < alpha;
    const guardOk = r.guard.diff.lo === null || r.guard.diff.lo <= 0;
    return { ...r, pHolm, passes: better && guardOk };
  });
  const passing = results.filter((r) => r.passes).sort((a, b) => a.primary.diff.mean! - b.primary.diff.mean!);
  return { results, chosen: passing[0]?.id ?? null };
}

// ---------------------------------------------------------------- calibration and sharpness

const logit = (p: number) => Math.log(clip(p) / (1 - clip(p)));

/** Stacked binary outcomes of the 1X2 (home, draw and away of each match); q null where no market price. */
export function x12Points(rows: readonly Row[]) {
  return rows.flatMap((r) => (r.x12 ? ([0, 1, 2] as const).map((k) => ({ cluster: r.day, p: r.x12!.p[k], q: r.x12!.q ? r.x12!.q[k] : null, y: r.x12!.o === k ? 1 : 0 })) : []));
}

/** Logistic calibration slope: y ~ a + b·logit(p) by IRLS. 1 = calibrated spread, < 1 = too extreme, > 1 = too flat. */
export function calibrationSlope(points: ReadonlyArray<{ p: number; y: number; w?: number }>): number | null {
  let a = 0;
  let b = 1;
  for (let it = 0; it < 50; it++) {
    let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;
    for (const pt of points) {
      const x = logit(pt.p);
      const w = pt.w ?? 1;
      const m = 1 / (1 + Math.exp(-(a + b * x)));
      const r = pt.y - m;
      const v = m * (1 - m) * w;
      g0 += w * r;
      g1 += w * r * x;
      h00 += v;
      h01 += v * x;
      h11 += v * x * x;
    }
    const det = h00 * h11 - h01 * h01;
    if (!(Math.abs(det) > 1e-12)) return null;
    const da = (h11 * g0 - h01 * g1) / det;
    const db = (h00 * g1 - h01 * g0) / det;
    a += da;
    b += db;
    if (Math.abs(da) + Math.abs(db) < 1e-10) break;
  }
  return b;
}

/** Slope of the model's log-odds on the market's: 1 = as sharp as the market, < 1 = flatter. */
export function sharpnessVsMarket(points: ReadonlyArray<{ p: number; q: number }>): number | null {
  const xs = points.map((pt) => logit(pt.q));
  const ys = points.map((pt) => logit(pt.p));
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
  const my = ys.reduce((s, y) => s + y, 0) / ys.length;
  const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  return sxx > 0 ? xs.reduce((s, x, i) => s + (x - mx) * (ys[i]! - my), 0) / sxx : null;
}

/** Expected calibration error over `bins` equal-width bins: Σ (n_b / N) · |mean p − share that happened|. */
export function ece(points: ReadonlyArray<{ p: number; y: number }>, bins = 10) {
  const b = Array.from({ length: bins }, () => ({ n: 0, p: 0, y: 0 }));
  for (const pt of points) {
    const i = Math.min(bins - 1, Math.floor(pt.p * bins));
    b[i]!.n++;
    b[i]!.p += pt.p;
    b[i]!.y += pt.y;
  }
  const n = points.length;
  return {
    ece: n ? b.reduce((s, x) => s + (x.n ? (x.n / n) * Math.abs(x.p / x.n - x.y / x.n) : 0), 0) : null,
    bins: b.map((x, i) => ({ from: i / bins, n: x.n, meanP: x.n ? x.p / x.n : null, happened: x.n ? x.y / x.n : null })),
  };
}

/** Deterministic PRNG (mulberry32), so a bootstrap gives the same interval on every run. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 95% percentile interval of `stat` over football days resampled with replacement. */
export function dayBootstrap<T extends { cluster: string }>(points: readonly T[], stat: (pts: T[]) => number | null, reps = 200, seed = 20261027) {
  const by = new Map<string, T[]>();
  for (const p of points) by.set(p.cluster, [...(by.get(p.cluster) ?? []), p]);
  const groups = [...by.values()];
  const r = rng(seed);
  const vals: number[] = [];
  for (let i = 0; i < reps; i++) {
    const sample: T[] = [];
    for (let g = 0; g < groups.length; g++) sample.push(...groups[Math.floor(r() * groups.length)]!);
    const v = stat(sample);
    if (v !== null && Number.isFinite(v)) vals.push(v);
  }
  vals.sort((a, b) => a - b);
  const at = (q: number) => (vals.length ? vals[Math.min(vals.length - 1, Math.floor(q * vals.length))]! : null);
  return { estimate: stat([...points]), lo: at(0.025), hi: at(0.975) };
}

// ---------------------------------------------------------------- favourite / underdog on the AH line

/**
 * The underdog side of an AH row: the side getting goals; at AH 0 the side the market's 1X2 rates lower
 * (null when there is no 1X2 to tell). Both sides of one line are complements for the model, the market and
 * the target, so the underdog's numbers follow from the HOME side's.
 */
export function underdogSide(r: Row): { p: number; q: number; y: 0 | 1; w: number } | null {
  if (!r.ah) return null;
  let homeDog: boolean;
  if (r.ah.line > 0) homeDog = true;
  else if (r.ah.line < 0) homeDog = false;
  else if (r.x12?.q && r.x12.q[0] !== r.x12.q[2]) homeDog = r.x12.q[0] < r.x12.q[2];
  else return null;
  const { p, q, y, w } = r.ah;
  return homeDog ? { p, q, y, w } : { p: 1 - p, q: 1 - q, y: (1 - y) as 0 | 1, w };
}

/** Underdog: model, market, what happened (fair hit) and the model's lean over the market, clustered by day. */
export function underdogStats(rows: readonly Row[]) {
  const d = rows.flatMap((r) => {
    const s = underdogSide(r);
    return s ? [{ r, s }] : [];
  });
  const m = (f: (x: (typeof d)[number]) => number, weighted = true): ClusteredMean =>
    clusteredMean(clusterSums(d.map((x) => ({ cluster: x.r.day, weight: weighted ? x.s.w : 1, value: f(x) }))));
  return { n: d.length, model: m((x) => x.s.p), market: m((x) => x.s.q), happened: m((x) => x.s.y), lean: m((x) => x.s.p - x.s.q, false) };
}

/**
 * Experiment C (cross-league cups): one walk-forward over a cup, the cup-only fit and the cross-league fit
 * refitted together, then mixed at each `cupOnly` weight (1 = cup only, 0 = cross-league only; production
 * uses 0.5). Every cup match is scored on its result; market fields only where `quotes` has a price
 * (the system's own closing consensus, phase 'close').
 */
export function walkForwardCup(input: {
  leagueId: number;
  matches: readonly FixtureMatch[];
  domestic: ReadonlyMap<number, readonly MatchRecord[]>;
  dc: DixonColesOptions;
  leaguePrior: number;
  blends: ReadonlyArray<{ id: string; cupOnly: number }>;
  quotes: ReadonlyMap<number, Quote>;
  from: Date;
  refitDays: number;
  leadDays: number;
}): Row[] {
  const rows: Row[] = [];
  const matches = sortByTime(input.matches);
  let alone: DixonColesModel | null = null;
  let cross: CrossLeagueModel | null = null;
  let fittedAt = -Infinity;
  for (const m of matches) {
    if (m.kickoffAt < input.from) continue;
    const asOf = new Date(m.kickoffAt.getTime() - input.leadDays * 86_400_000);
    if (!alone || !cross || asOf.getTime() - fittedAt >= input.refitDays * 86_400_000) {
      alone = fitDixonColes(matches, asOf, input.dc, alone ?? undefined);
      cross = fitCrossLeague(matches, input.domestic, asOf, { dixonColes: input.dc, leaguePrior: input.leaguePrior });
      fittedAt = asOf.getTime();
    }
    const ga = expectedGoals(alone, m.homeTeamId, m.awayTeamId);
    const gc = crossLeagueExpectedGoals(cross, m.homeTeamId, m.awayTeamId);
    const cupOnly = scoreMatrix(ga.lambda, ga.mu, alone.rho);
    const crossOnly = scoreMatrix(gc.lambda, gc.mu, alone.rho);
    const quote = input.quotes.get(m.fixtureId) ?? {};
    const minTeamMatches = Math.min(alone.teamMatches.get(m.homeTeamId) ?? 0, alone.teamMatches.get(m.awayTeamId) ?? 0);
    for (const b of input.blends) {
      const mx = mixScoreMatrices(cupOnly, crossOnly, b.cupOnly);
      const base = { config: b.id, fixtureId: m.fixtureId, leagueId: input.leagueId, phase: 'close' as const, day: footballDay(m.kickoffAt).date, kickoffAt: m.kickoffAt, minTeamMatches };
      const row = scoreRow(base, mx, quote, { home: m.homeGoals, away: m.awayGoals });
      if (!row.x12) {
        const sel = ['HOME', 'DRAW', 'AWAY'] as const;
        row.x12 = { p: sel.map((s) => priceSelection(mx, { market: 'MATCH_WINNER', selection: s }).probability) as unknown as Probs3, q: null, o: outcomeIndex(m.homeGoals, m.awayGoals) };
      }
      rows.push(row);
    }
  }
  return rows;
}

export const AH_BANDS: ReadonlyArray<{ name: string; test: (absLine: number) => boolean }> = [
  { name: 'AH 0', test: (x) => x === 0 },
  { name: 'AH 0.25–0.75', test: (x) => x >= 0.25 && x <= 0.75 },
  { name: 'AH 1–1.5', test: (x) => x >= 1 && x <= 1.5 },
  { name: 'AH 1.75+', test: (x) => x >= 1.75 },
];

export const DATA_BANDS: ReadonlyArray<{ name: string; test: (n: number) => boolean }> = [
  { name: '< 10', test: (n) => n < 10 },
  { name: '10–20', test: (n) => n >= 10 && n < 20 },
  { name: '20–40', test: (n) => n >= 20 && n < 40 },
  { name: '≥ 40', test: (n) => n >= 40 },
];
