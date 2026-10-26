/**
 * Phase 5 — Candidate Generator + rule-based Decision.
 *
 * For one fixture: compare model probabilities (Probability Engine) with the
 * bookmaker consensus (no-vig), evaluate EVERY offered selection, apply the
 * decision rules, rank what passes, and pick at most ONE — or NO_CLEAR_SIGNAL.
 * Since rules-v0.6 only the market's main AH and O/U line can be picked (ADR 0008); the other
 * lines are still evaluated and stored, rejected as NOT_MAIN_LINE.
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
  /**
   * When this system stored the quote (odds_history.collected_at). Set it in a replay: a quote stored after
   * the decision time was not known then, even when its source time is earlier. Leave it out for the
   * closing market, whose last pre-kickoff price is often stored a little after kickoff.
   */
  collectedAt?: Date;
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

/** Markets the Game Compass may pick from. 1X2 is still priced and shown as supporting analysis, never picked. */
export const PICK_MARKETS: readonly MarketCode[] = ['ASIAN_HANDICAP', 'OVER_UNDER'];

export interface DecisionRules {
  version: string;
  pickMarkets: readonly MarketCode[];
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
  /** v0.6: only the main AH / O/U line may be picked; false = every offered line (v0.5, shadow rules) */
  mainLineOnly: boolean;
  /** bookmakers quoting both sides of a line, fresh and sane, before it can be the main line */
  minMainLineBookmakers: number;
  /** a balanced line whose sides sit further than this from 50/50 is not trusted as the main line */
  maxMainLineOffEven: number;
  /**
   * Shadow rules only: the model's usual lean against the market per selection and line
   * (`MARKET|SELECTION|line`, probability points), taken off the model probability before the
   * edge is measured, so only disagreements beyond the usual one count. Absent = no correction.
   */
  modelBias?: Readonly<Record<string, number>>;
}

export const DEFAULT_RULES: DecisionRules = {
  // v0.6 (ADR 0008): the pick sits on the main line only. Under v0.5 the edge cap pushed the pick
  // onto whichever far line still fell under it (Liverpool -2.5 beside a -1.25 main line, 2026-10-20)
  version: 'rules-v0.6',
  pickMarkets: PICK_MARKETS,
  minEdge: 0.03,
  // 0.15 in v0.3/v0.4: picks 12+ points above the market hit 38.9% (n=18) against 58.3% at 6–9 (n=12), ADR 0006
  maxEdge: 0.12,
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
  mainLineOnly: true,
  minMainLineBookmakers: 3,
  maxMainLineOffEven: 0.15,
};

export type SignalStrength = 'STRONG' | 'MEDIUM' | 'LEAN';

export type RejectReason =
  | 'TOO_CLOSE_TO_KICKOFF'
  | 'LOW_TEAM_DATA'
  | 'MAJOR_ABSENCE_UNMODELLED'
  | 'MARKET_NOT_PICKABLE'
  | 'MARKET_GATED_OFF'
  | 'NO_MODEL_PRICE'
  | 'THIN_MARKET'
  | 'ODDS_OUT_OF_RANGE'
  | 'EDGE_BELOW_MIN'
  | 'EV_BELOW_MIN'
  | 'EDGE_TOO_LARGE'
  | 'MAIN_LINE_UNAVAILABLE'
  | 'NOT_MAIN_LINE';

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
  /** usual model-vs-market lean taken off before the edge (shadow rules); 0 = none */
  bias: number;
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
  /** on its market's main line; null for 1X2 */
  onMainLine: boolean | null;
}

/**
 * Why the decision came out as it did:
 *  SIGNAL_ON_MAIN_LINE   - a pick on the main line (v0.6)
 *  SIGNAL                - a pick under rules that may use any line (v0.5, shadow rules)
 *  MAIN_LINE_UNAVAILABLE - no pick market had a main line to judge
 *  NO_QUALIFIED_SIGNAL   - nothing passed the rules
 */
export type DecisionReason = 'SIGNAL_ON_MAIN_LINE' | 'SIGNAL' | 'MAIN_LINE_UNAVAILABLE' | 'NO_QUALIFIED_SIGNAL';

export interface Decision {
  rulesVersion: string;
  outcome: 'SIGNAL' | 'NO_CLEAR_SIGNAL';
  decisionReason: DecisionReason;
  pick: Candidate | null;
  /** passed candidates first (by supportScore), then rejected ones */
  candidates: Candidate[];
  /** the main AH and O/U line of this evaluation */
  mainLines: Record<MainLineMarket, MainLine>;
  /**
   * Main-line rules without a pick: why, per pick market (the main-line side closest to passing),
   * after the reasons that hold for the whole fixture (market null). Empty otherwise.
   */
  fogReasons: Array<{ market: MainLineMarket | null; reason: RejectReason }>;
  /** under main-line rules, rejectReasons count only main-line (and 1X2) candidates: why the main line failed */
  summary: { evaluated: number; passed: number; notMainLine: number; rejectReasons: Partial<Record<RejectReason, number>> };
}

export type MainLineMarket = 'ASIAN_HANDICAP' | 'OVER_UNDER';

/**
 * OK                 - usable
 * NO_QUOTES          - no line has a bookmaker quoting both sides
 * TOO_FEW_BOOKMAKERS - no line has `minMainLineBookmakers` bookmakers quoting both sides
 * STALE              - such a line exists only among quotes older than `maxOddsAgeHours`
 * UNBALANCED         - the most balanced line is still far from 50/50: not a main line
 */
export type MainLineStatus = 'OK' | 'NO_QUOTES' | 'TOO_FEW_BOOKMAKERS' | 'STALE' | 'UNBALANCED';

export interface MainLine {
  market: MainLineMarket;
  status: MainLineStatus;
  /**
   * API-Football marks no main line on pre-match odds, so it is derived: the line whose two sides,
   * de-margined per bookmaker and taken at the median, sit closest to 50/50.
   */
  source: 'CONSENSUS_CLOSEST_TO_EVEN';
  /** AH: the home team's line; O/U: the total. Set for every status but NO_QUOTES, usable only when OK */
  line: number | null;
  /** bookmakers quoting both sides of the line */
  nBookmakers: number;
  /** bookmakers with a quote on the line that was left out (one side missing, or the sides don't form a market) */
  incompleteBookmakers: number;
  /** no-vig probability of HOME (AH) or OVER (O/U) */
  firstProbability: number | null;
  /** median price of HOME / AWAY or OVER / UNDER */
  odds: { first: number; second: number } | null;
  updatedAt: string | null;
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
    // point in time: nothing from after `now` (audit A-08)
    if (q.updatedAt.getTime() > now.getTime() || (q.collectedAt && q.collectedAt.getTime() > now.getTime())) continue;
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
    /** bookmakers on this book left out: a side missing or not priced, or the sides don't form a market */
    incompleteBookmakers: number;
  }> = [];

  for (const [key, book] of books) {
    const perBookmaker = byBook.get(key)!;
    const probs: Record<string, number[]> = {};
    const prices: Record<string, Array<{ odds: number; bk: number; at: Date }>> = {};
    let incomplete = 0;
    for (const [bk, sides] of perBookmaker) {
      const qs = book.sides.map((s) => sides.get(sideKey(s.selection, s.line)));
      if (qs.some((x) => !x || !(x.odds > 1))) {
        incomplete++;
        continue;
      }
      // sanity: a real book has a small positive margin. Sum of 1/odds < 1 (or absurdly high)
      // means the sides are not actually the same market -> never trust it.
      const book1 = qs.reduce((acc, x) => acc + 1 / x!.odds, 0);
      if (book1 < MIN_BOOK_SUM || book1 > MAX_BOOK_SUM) {
        incomplete++;
        continue;
      }
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
        incompleteBookmakers: incomplete,
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
  const mains = mainLines(input.quotes, input.now, rules);

  const candidates: Candidate[] = cons.map((c) => {
    const reasons: RejectReason[] = [...fixtureReasons];
    if (!rules.pickMarkets.includes(c.market)) reasons.push('MARKET_NOT_PICKABLE');
    const gate = input.gates[c.market];
    if (!gate?.enabled) reasons.push('MARKET_GATED_OFF');
    const main = c.market === 'MATCH_WINNER' ? null : mains[c.market];
    const onMainLine = main ? main.status === 'OK' && isOnLine(c.market, c.selection, c.line, main.line) : null;
    if (rules.mainLineOnly && main) {
      // a far line never stands in for a missing or stale main line
      if (main.status !== 'OK') reasons.push('MAIN_LINE_UNAVAILABLE');
      else if (!onMainLine) reasons.push('NOT_MAIN_LINE');
    }

    const mp = input.model.find((m) => m.market === c.market && m.selection === c.selection && lineKey(m.line) === lineKey(c.line));
    if (!mp) reasons.push('NO_MODEL_PRICE');
    if (c.nBookmakers < rules.minBookmakers) reasons.push('THIN_MARKET');
    if (c.medianOdds < rules.minOdds || c.medianOdds > rules.maxOdds) reasons.push('ODDS_OUT_OF_RANGE');

    let edge: number | null = null;
    let ev: number | null = null;
    let dist: OutcomeDistribution | null = null;
    const bias = rules.modelBias ? biasFor(rules.modelBias, c.market, c.selection, c.line) : 0;
    if (mp) {
      edge = mp.probability - bias - c.marketProbability;
      dist = mp.distribution ?? { win: mp.probability, halfWin: 0, push: 0, halfLoss: 0, loss: 1 - mp.probability };
      if (bias) dist = shiftDistribution(dist, bias);
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
      bias: round(bias, 5),
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
      onMainLine,
    };
  });

  candidates.sort((a, b) => Number(b.passed) - Number(a.passed) || b.supportScore - a.supportScore || (b.edge ?? -1) - (a.edge ?? -1));
  const pick = candidates[0]?.passed ? candidates[0] : null;

  // the far lines' reasons would drown out why the main line itself failed
  const counted = candidates.filter((c) => !c.rejectReasons.includes('NOT_MAIN_LINE'));
  const counts: Partial<Record<RejectReason, number>> = {};
  for (const c of counted) for (const r of c.rejectReasons) counts[r] = (counts[r] ?? 0) + 1;

  const pickMains = rules.pickMarkets.filter((m): m is MainLineMarket => m !== 'MATCH_WINNER').map((m) => mains[m]);
  const decisionReason: DecisionReason = pick
    ? rules.mainLineOnly
      ? 'SIGNAL_ON_MAIN_LINE'
      : 'SIGNAL'
    : rules.mainLineOnly && pickMains.length && pickMains.every((m) => m.status !== 'OK')
      ? 'MAIN_LINE_UNAVAILABLE'
      : 'NO_QUALIFIED_SIGNAL';

  const fogReasons: Decision['fogReasons'] = [];
  if (!pick && rules.mainLineOnly) {
    for (const reason of fixtureReasons) fogReasons.push({ market: null, reason });
    for (const m of rules.pickMarkets) {
      if (m === 'MATCH_WINNER') continue;
      if (mains[m].status !== 'OK') {
        fogReasons.push({ market: m, reason: 'MAIN_LINE_UNAVAILABLE' });
        continue;
      }
      // candidates are sorted by edge among the rejected, so the first is the side closest to passing
      const side = candidates.find((c) => c.market === m && c.onMainLine);
      const reason = side?.rejectReasons.find((r) => !fixtureReasons.includes(r));
      if (reason) fogReasons.push({ market: m, reason });
    }
  }

  return {
    rulesVersion: rules.version,
    outcome: pick ? 'SIGNAL' : 'NO_CLEAR_SIGNAL',
    decisionReason,
    pick,
    candidates,
    mainLines: mains,
    fogReasons,
    summary: {
      evaluated: candidates.length,
      passed: candidates.filter((c) => c.passed).length,
      notMainLine: candidates.length - counted.length,
      rejectReasons: counts,
    },
  };
}

/** AH: the side at L pairs with the other side at -L, so HOME -1.25 and AWAY +1.25 are both on home line -1.25. */
function isOnLine(market: MarketCode, selection: string, line: number | null, mainLine: number | null): boolean {
  if (line === null || mainLine === null) return false;
  const own = market === 'ASIAN_HANDICAP' && selection === 'AWAY' ? (line === 0 ? 0 : -line) : line;
  return lineKey(own) === lineKey(mainLine);
}

type ConsensusRow = ReturnType<typeof consensus>[number];

/** Both sides of each line of a market: AH keyed by the home line, O/U by the total. */
function linePairs(cons: readonly ConsensusRow[], market: MainLineMarket) {
  const [first, second] = market === 'ASIAN_HANDICAP' ? ['HOME', 'AWAY'] : ['OVER', 'UNDER'];
  const pairs: Array<{ line: number; first: ConsensusRow; second: ConsensusRow }> = [];
  for (const a of cons.filter((c) => c.market === market && c.selection === first && c.line !== null)) {
    const other = market === 'ASIAN_HANDICAP' ? (a.line === 0 ? 0 : -a.line!) : a.line;
    const b = cons.find((c) => c.market === market && c.selection === second && lineKey(c.line) === lineKey(other));
    if (b) pairs.push({ line: a.line!, first: a, second: b });
  }
  return pairs;
}

/**
 * The line whose sides sit closest to 50/50 among lines with at least `minBookmakers` bookmakers;
 * ties go to the line with more bookmakers, then the smaller line, so the choice is deterministic.
 */
function balancedLine<T extends { line: number; first: ConsensusRow }>(pairs: readonly T[], minBookmakers: number): T | null {
  const off = (p: T) => Math.abs(p.first.marketProbability - 0.5);
  return (
    pairs
      .filter((p) => p.first.nBookmakers >= minBookmakers)
      .sort((a, b) => off(a) - off(b) || b.first.nBookmakers - a.first.nBookmakers || Math.abs(a.line) - Math.abs(b.line))[0] ?? null
  );
}

/**
 * The market's main AH and O/U line from fresh quotes. Only fresh quotes can define it: a bookmaker
 * that stopped quoting a line after the market moved keeps its old quote as its latest one. When no
 * fresh line qualifies the status says why, and the decision rules pick nothing on that market.
 */
export function mainLines(quotes: readonly OddsQuote[], now: Date, rules: Pick<DecisionRules, 'maxOddsAgeHours' | 'minMainLineBookmakers' | 'maxMainLineOffEven'>): Record<MainLineMarket, MainLine> {
  const fresh = consensus(quotes, now, rules.maxOddsAgeHours);
  const all = consensus(quotes, now, Infinity);
  const one = (market: MainLineMarket): MainLine => {
    const of = (p: { line: number; first: ConsensusRow; second: ConsensusRow } | null, status: MainLineStatus): MainLine => ({
      market,
      status,
      source: 'CONSENSUS_CLOSEST_TO_EVEN',
      line: p?.line ?? null,
      nBookmakers: p?.first.nBookmakers ?? 0,
      incompleteBookmakers: p?.first.incompleteBookmakers ?? 0,
      firstProbability: p ? round(p.first.marketProbability, 5) : null,
      odds: p ? { first: round(p.first.medianOdds, 3), second: round(p.second.medianOdds, 3) } : null,
      updatedAt: p ? new Date(Math.max(p.first.updatedAt.getTime(), p.second.updatedAt.getTime())).toISOString() : null,
    });
    const freshPairs = linePairs(fresh, market);
    const best = balancedLine(freshPairs, rules.minMainLineBookmakers);
    if (best) return of(best, Math.abs(best.first.marketProbability - 0.5) > rules.maxMainLineOffEven ? 'UNBALANCED' : 'OK');
    const allPairs = linePairs(all, market);
    const older = balancedLine(allPairs, rules.minMainLineBookmakers);
    if (older) return of(older, 'STALE');
    const thin = balancedLine(freshPairs, 1) ?? balancedLine(allPairs, 1);
    return thin ? of(thin, 'TOO_FEW_BOOKMAKERS') : of(null, 'NO_QUOTES');
  };
  return { ASIAN_HANDICAP: one('ASIAN_HANDICAP'), OVER_UNDER: one('OVER_UNDER') };
}

const MAIN_LINE_STATUSES: readonly MainLineStatus[] = ['OK', 'NO_QUOTES', 'TOO_FEW_BOOKMAKERS', 'STALE', 'UNBALANCED'];

/**
 * The main lines stored in a run's summary (`analysis_runs.summary.mainLines`), as the site reads
 * them back: the exact line and prices the decision used. Malformed entries are dropped, not repaired.
 */
export function readMainLines(summary: unknown): Partial<Record<MainLineMarket, MainLine>> {
  const list = (summary as { mainLines?: unknown } | null)?.mainLines;
  const out: Partial<Record<MainLineMarket, MainLine>> = {};
  if (!Array.isArray(list)) return out;
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  for (const m of list as Array<Record<string, unknown>>) {
    if (m?.market !== 'ASIAN_HANDICAP' && m?.market !== 'OVER_UNDER') continue;
    const status = m.status as MainLineStatus;
    if (!MAIN_LINE_STATUSES.includes(status)) continue;
    const line = num(m.line);
    if (m.line != null && line === null) continue;
    const odds = m.odds as { first?: unknown; second?: unknown } | null;
    const first = num(odds?.first);
    const second = num(odds?.second);
    if (status === 'OK' && (line === null || first === null || second === null)) continue;
    out[m.market] = {
      market: m.market,
      status,
      source: 'CONSENSUS_CLOSEST_TO_EVEN',
      line,
      nBookmakers: num(m.nBookmakers) ?? 0,
      incompleteBookmakers: num(m.incompleteBookmakers) ?? 0,
      firstProbability: num(m.firstProbability),
      odds: first !== null && second !== null ? { first, second } : null,
      updatedAt: typeof m.updatedAt === 'string' ? m.updatedAt : null,
    };
  }
  return out;
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

/**
 * The model's usual lean against the market for a selection and line; the nearest measured line
 * stands in beyond the measured range, 0 for a market or selection never measured.
 */
export function biasFor(table: Readonly<Record<string, number>>, market: MarketCode, selection: string, line: number | null): number {
  const exact = table[`${market}|${selection}|${lineKey(line)}`];
  if (exact !== undefined) return exact;
  if (line === null) return 0;
  let best: { d: number; v: number } | null = null;
  for (const [k, v] of Object.entries(table)) {
    const [m, sel, l] = k.split('|');
    if (m !== market || sel !== selection || l === '') continue;
    const d = Math.abs(Number(l) - line);
    if (!best || d < best.d) best = { d, v };
  }
  return best?.v ?? 0;
}

/** Move `by` probability from win to loss (or back when negative), keeping every outcome in [0, 1]. */
function shiftDistribution(d: OutcomeDistribution, by: number): OutcomeDistribution {
  const move = by > 0 ? Math.min(by, d.win) : -Math.min(-by, d.loss);
  return { ...d, win: d.win - move, loss: d.loss + move };
}

/** How long before kickoff a quote may be and still count as the closing market. */
export const CLOSING_MAX_AGE_HOURS = 24;

/**
 * The market at kickoff, compactly: the 1X2 and, for Asian handicap and over/under, only the main
 * line (the one whose sides are closest to 50/50, same choice as `mainLines` but from any number of
 * bookmakers, since this is a record, not a pick). Quotes from kickoff onwards are ignored.
 */
export function closingMarket(quotes: readonly OddsQuote[], kickoffAt: Date) {
  const cons = consensus(
    quotes.filter((q) => q.updatedAt < kickoffAt),
    kickoffAt,
    CLOSING_MAX_AGE_HOURS,
  );
  const main = (market: MainLineMarket) => {
    const p = balancedLine(linePairs(cons, market), 1);
    return p ? [p.first, p.second] : [];
  };
  return [...cons.filter((c) => c.market === 'MATCH_WINNER'), ...main('ASIAN_HANDICAP'), ...main('OVER_UNDER')];
}
