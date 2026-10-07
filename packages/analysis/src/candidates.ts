/**
 * Phase 5 — Candidate Generator + rule-based Decision.
 *
 * For one fixture: compare model probabilities (Probability Engine) with the
 * bookmaker consensus (no-vig), evaluate EVERY offered selection, apply the
 * decision rules, rank what passes, and pick at most ONE — or NO_CLEAR_SIGNAL.
 *
 * Deterministic and reproducible: same inputs + same rules version = same output.
 * The AI layer (Phase 6) may only explain or downgrade this decision, never invent numbers.
 */
import { expectedValue, type OutcomeDistribution } from './settlement.js';

export type MarketCode = 'MATCH_WINNER' | 'ASIAN_HANDICAP' | 'OVER_UNDER';

export interface ModelPrice {
  market: MarketCode;
  selection: string;
  line: number | null;
  probability: number;
  distribution?: OutcomeDistribution | null;
}

export interface OddsQuote {
  bookmakerId: number;
  market: MarketCode;
  selection: string;
  line: number | null;
  /** AH line from home perspective (groups both sides of the same handicap) */
  homeLine: number | null;
  odds: number;
  updatedAt: Date;
}

export interface MarketGate {
  enabled: boolean;
  /** paired-test z of this market on the tuning holdout */
  z: number;
}

export interface CandidateInput {
  fixtureId: number;
  kickoffAt: Date;
  now: Date;
  model: ModelPrice[];
  elo1x2?: { home: number; draw: number; away: number } | null;
  quotes: OddsQuote[];
  gates: Partial<Record<MarketCode, MarketGate>>;
  teamData: { homeWeightedMatches: number; awayWeightedMatches: number };
  /**
   * Largest team attack/defence loss from missing players that the model prices did NOT
   * account for (Player Impact layer off or not trusted). Big unmodelled absences = no signal.
   */
  unmodelledLoss?: number;
}

export interface DecisionRules {
  version: string;
  minEdge: number;
  maxEdge: number;
  minEv: number;
  minBookmakers: number;
  maxOddsAgeHours: number;
  minOdds: number;
  maxOdds: number;
  minTeamWeightedMatches: number;
  minMinutesBeforeKickoff: number;
  strongZ: number;
  strongEdge: number;
  mediumEdge: number;
  maxUnmodelledLoss: number;
}

export const DEFAULT_RULES: DecisionRules = {
  version: 'rules-v0.2',
  minEdge: 0.03,
  maxEdge: 0.15,
  minEv: 0.02,
  minBookmakers: 2,
  maxOddsAgeHours: 12,
  minOdds: 1.3,
  maxOdds: 6,
  minTeamWeightedMatches: 8,
  minMinutesBeforeKickoff: 15,
  strongZ: 1.96,
  strongEdge: 0.06,
  mediumEdge: 0.045,
  maxUnmodelledLoss: 0.25,
};

export type SignalStrength = 'STRONG' | 'MEDIUM' | 'LEAN';

export type RejectReason =
  | 'TOO_CLOSE_TO_KICKOFF'
  | 'LOW_TEAM_DATA'
  | 'MAJOR_ABSENCE_UNMODELLED'
  | 'MARKET_GATED_OFF'
  | 'NO_MODEL_PRICE'
  | 'THIN_MARKET'
  | 'ODDS_OUT_OF_RANGE'
  | 'EDGE_BELOW_MIN'
  | 'EV_BELOW_MIN'
  | 'EDGE_TOO_LARGE';

export interface Candidate {
  market: MarketCode;
  selection: string;
  line: number | null;
  nBookmakers: number;
  /** median price across fresh bookmakers (conservative reference price) */
  odds: number;
  bestOdds: number;
  bestBookmakerId: number;
  marketProbability: number;
  modelProbability: number | null;
  edge: number | null;
  ev: number | null;
  /** 🤝 does Elo agree with the direction of the edge? null = not applicable */
  agreement: boolean | null;
  gateZ: number | null;
  supportScore: number;
  strength: SignalStrength | null;
  passed: boolean;
  rejectReasons: RejectReason[];
  distribution: OutcomeDistribution | null;
  oddsUpdatedAt: string;
}

export interface Decision {
  rulesVersion: string;
  outcome: 'SIGNAL' | 'NO_CLEAR_SIGNAL';
  pick: Candidate | null;
  /** passed candidates first (by supportScore), then rejected ones */
  candidates: Candidate[];
  summary: { evaluated: number; passed: number; rejectReasons: Partial<Record<RejectReason, number>> };
}

/** Accepted range for sum(1/odds) of one bookmaker's complete market. */
export const MIN_BOOK_SUM = 1.0;
export const MAX_BOOK_SUM = 1.25;

const STRENGTH_ORDER: SignalStrength[] = ['LEAN', 'MEDIUM', 'STRONG'];

export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Proportional no-vig. */
export function noVig(odds: readonly number[]): number[] {
  const inv = odds.map((o) => 1 / o);
  const sum = inv.reduce((a, b) => a + b, 0);
  return inv.map((p) => p / sum);
}

const q4 = (x: number | null) => (x === null ? null : Math.round(x * 4) / 4);
const lineKey = (x: number | null) => (x === null ? '' : String(q4(x)));

interface Book {
  market: MarketCode;
  key: string;
  sides: Array<{ selection: string; line: number | null }>;
}

function bookOf(q: OddsQuote): { key: string; book: Book } | null {
  if (q.market === 'MATCH_WINNER') {
    return { key: 'MW', book: { market: q.market, key: 'MW', sides: [{ selection: 'HOME', line: null }, { selection: 'DRAW', line: null }, { selection: 'AWAY', line: null }] } };
  }
  if (q.market === 'ASIAN_HANDICAP' && q.homeLine !== null) {
    const h = q4(q.homeLine)!;
    const key = `AH|${h}`;
    return { key, book: { market: q.market, key, sides: [{ selection: 'HOME', line: h }, { selection: 'AWAY', line: h === 0 ? 0 : -h }] } };
  }
  if (q.market === 'OVER_UNDER' && q.line !== null) {
    const l = q4(q.line)!;
    const key = `OU|${l}`;
    return { key, book: { market: q.market, key, sides: [{ selection: 'OVER', line: l }, { selection: 'UNDER', line: l }] } };
  }
  return null;
}

const sideKey = (selection: string, line: number | null) => `${selection}|${lineKey(line)}`;

/** Consensus per book: for each bookmaker with ALL sides fresh -> no-vig; then median across bookmakers. */
export function consensus(quotes: readonly OddsQuote[], now: Date, maxAgeHours: number) {
  const maxAgeMs = maxAgeHours * 3_600_000;
  const books = new Map<string, Book>();
  // book -> bookmaker -> side -> quote
  const byBook = new Map<string, Map<number, Map<string, OddsQuote>>>();
  for (const q of quotes) {
    if (now.getTime() - q.updatedAt.getTime() > maxAgeMs) continue;
    const b = bookOf(q);
    if (!b) continue;
    books.set(b.key, b.book);
    const bm = byBook.get(b.key) ?? new Map<number, Map<string, OddsQuote>>();
    byBook.set(b.key, bm);
    const sides = bm.get(q.bookmakerId) ?? new Map<string, OddsQuote>();
    bm.set(q.bookmakerId, sides);
    const k = sideKey(q.selection, q4(q.line));
    const prev = sides.get(k);
    if (!prev || prev.updatedAt < q.updatedAt) sides.set(k, q);
  }

  const out: Array<{
    market: MarketCode;
    selection: string;
    line: number | null;
    nBookmakers: number;
    marketProbability: number;
    medianOdds: number;
    bestOdds: number;
    bestBookmakerId: number;
    updatedAt: Date;
    allSides: Record<string, number>;
  }> = [];

  for (const [key, book] of books) {
    const perBookmaker = byBook.get(key)!;
    const probs: Record<string, number[]> = {};
    const prices: Record<string, Array<{ odds: number; bk: number; at: Date }>> = {};
    for (const [bk, sides] of perBookmaker) {
      const qs = book.sides.map((s) => sides.get(sideKey(s.selection, s.line)));
      if (qs.some((x) => !x || !(x.odds > 1))) continue;
      // sanity: a real book has a small positive margin. Sum of 1/odds < 1 (or absurdly high)
      // means the sides are not actually the same market -> never trust it.
      const book1 = qs.reduce((acc, x) => acc + 1 / x!.odds, 0);
      if (book1 < MIN_BOOK_SUM || book1 > MAX_BOOK_SUM) continue;
      const nv = noVig(qs.map((x) => x!.odds));
      book.sides.forEach((s, i) => {
        const k = sideKey(s.selection, s.line);
        (probs[k] ??= []).push(nv[i]!);
        (prices[k] ??= []).push({ odds: qs[i]!.odds, bk, at: qs[i]!.updatedAt });
      });
    }
    const keys = book.sides.map((s) => sideKey(s.selection, s.line));
    if (!probs[keys[0]!]?.length) continue;
    const med = keys.map((k) => median(probs[k]!));
    const sum = med.reduce((a, b) => a + b, 0);
    const allSides = Object.fromEntries(book.sides.map((s, i) => [s.selection, med[i]! / sum]));
    book.sides.forEach((s, i) => {
      const k = keys[i]!;
      const ps = prices[k]!;
      const best = ps.reduce((a, b) => (b.odds > a.odds ? b : a));
      out.push({
        market: book.market,
        selection: s.selection,
        line: s.line,
        nBookmakers: ps.length,
        marketProbability: med[i]! / sum,
        medianOdds: median(ps.map((p) => p.odds)),
        bestOdds: best.odds,
        bestBookmakerId: best.bk,
        updatedAt: new Date(Math.max(...ps.map((p) => p.at.getTime()))),
        allSides,
      });
    });
  }
  return out;
}

export function generateCandidates(input: CandidateInput, rules: DecisionRules = DEFAULT_RULES): Decision {
  const fixtureReasons: RejectReason[] = [];
  if (input.kickoffAt.getTime() - input.now.getTime() < rules.minMinutesBeforeKickoff * 60_000) fixtureReasons.push('TOO_CLOSE_TO_KICKOFF');
  if (Math.min(input.teamData.homeWeightedMatches, input.teamData.awayWeightedMatches) < rules.minTeamWeightedMatches) fixtureReasons.push('LOW_TEAM_DATA');
  if ((input.unmodelledLoss ?? 0) >= rules.maxUnmodelledLoss) fixtureReasons.push('MAJOR_ABSENCE_UNMODELLED');

  const cons = consensus(input.quotes, input.now, rules.maxOddsAgeHours);
  const mw = cons.find((c) => c.market === 'MATCH_WINNER')?.allSides ?? null;
  const minData = Math.min(input.teamData.homeWeightedMatches, input.teamData.awayWeightedMatches);

  const candidates: Candidate[] = cons.map((c) => {
    const reasons: RejectReason[] = [...fixtureReasons];
    const gate = input.gates[c.market];
    if (!gate?.enabled) reasons.push('MARKET_GATED_OFF');

    const mp = input.model.find((m) => m.market === c.market && m.selection === c.selection && lineKey(m.line) === lineKey(c.line));
    if (!mp) reasons.push('NO_MODEL_PRICE');
    if (c.nBookmakers < rules.minBookmakers) reasons.push('THIN_MARKET');
    if (c.medianOdds < rules.minOdds || c.medianOdds > rules.maxOdds) reasons.push('ODDS_OUT_OF_RANGE');

    let edge: number | null = null;
    let ev: number | null = null;
    let dist: OutcomeDistribution | null = null;
    if (mp) {
      edge = mp.probability - c.marketProbability;
      dist = mp.distribution ?? { win: mp.probability, halfWin: 0, push: 0, halfLoss: 0, loss: 1 - mp.probability };
      ev = expectedValue(dist, c.medianOdds);
      if (edge < rules.minEdge) reasons.push('EDGE_BELOW_MIN');
      if (edge > rules.maxEdge) reasons.push('EDGE_TOO_LARGE');
      if (ev < rules.minEv) reasons.push('EV_BELOW_MIN');
    }

    const agreement = eloAgreement(c.market, c.selection, input.elo1x2 ?? null, mw, c.marketProbability);
    const passed = reasons.length === 0;
    const gateZ = gate?.z ?? null;

    let strength: SignalStrength | null = null;
    let supportScore = 0;
    if (passed && edge !== null) {
      const raw: SignalStrength = edge >= rules.strongEdge && agreement !== false ? 'STRONG' : edge >= rules.mediumEdge ? 'MEDIUM' : 'LEAN';
      const cap: SignalStrength = (gateZ ?? 0) >= rules.strongZ ? 'STRONG' : 'LEAN';
      strength = STRENGTH_ORDER[Math.min(STRENGTH_ORDER.indexOf(raw), STRENGTH_ORDER.indexOf(cap))]!;
      const zFactor = Math.min(1, (gateZ ?? 0) / rules.strongZ);
      const agreeFactor = agreement === true ? 1 : agreement === null ? 0.9 : 0.7;
      const dataFactor = Math.min(1, minData / 15);
      supportScore = round(edge * 100 * zFactor * agreeFactor * dataFactor, 4);
    }

    return {
      market: c.market,
      selection: c.selection,
      line: c.line,
      nBookmakers: c.nBookmakers,
      odds: round(c.medianOdds, 3),
      bestOdds: c.bestOdds,
      bestBookmakerId: c.bestBookmakerId,
      marketProbability: round(c.marketProbability, 5),
      modelProbability: mp ? round(mp.probability, 5) : null,
      edge: edge === null ? null : round(edge, 5),
      ev: ev === null ? null : round(ev, 5),
      agreement,
      gateZ,
      supportScore,
      strength,
      passed,
      rejectReasons: reasons,
      distribution: dist,
      oddsUpdatedAt: c.updatedAt.toISOString(),
    };
  });

  candidates.sort((a, b) => Number(b.passed) - Number(a.passed) || b.supportScore - a.supportScore || (b.edge ?? -1) - (a.edge ?? -1));
  const pick = candidates[0]?.passed ? candidates[0] : null;

  const counts: Partial<Record<RejectReason, number>> = {};
  for (const c of candidates) for (const r of c.rejectReasons) counts[r] = (counts[r] ?? 0) + 1;

  return {
    rulesVersion: rules.version,
    outcome: pick ? 'SIGNAL' : 'NO_CLEAR_SIGNAL',
    pick,
    candidates,
    summary: { evaluated: candidates.length, passed: candidates.filter((c) => c.passed).length, rejectReasons: counts },
  };
}

/**
 * 🤝 Model agreement with Elo (independent model).
 *  - 1X2: Elo prob of the selection is above the market's.
 *  - AH:  Elo rates the selected side stronger than the 1X2 market does.
 *  - O/U: Elo has no goals model -> null.
 */
export function eloAgreement(
  market: MarketCode,
  selection: string,
  elo: { home: number; draw: number; away: number } | null,
  mw: Record<string, number> | null,
  marketProbability: number,
): boolean | null {
  if (!elo) return null;
  if (market === 'MATCH_WINNER') {
    const p = selection === 'HOME' ? elo.home : selection === 'DRAW' ? elo.draw : elo.away;
    return p > marketProbability;
  }
  if (market === 'ASIAN_HANDICAP') {
    if (!mw || mw.HOME === undefined || mw.AWAY === undefined) return null;
    const eloDiff = elo.home - elo.away;
    const mktDiff = mw.HOME - mw.AWAY;
    return selection === 'HOME' ? eloDiff > mktDiff : eloDiff < mktDiff;
  }
  return null;
}

function round(x: number, d: number) {
  return Math.round(x * 10 ** d) / 10 ** d;
}
