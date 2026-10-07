/**
 * Settlement rules (shared by the Probability Engine and the Settlement Engine,
 * so "what counts as a win" is defined in exactly one place).
 */

export type Outcome = 'WIN' | 'HALF_WIN' | 'PUSH' | 'HALF_LOSS' | 'LOSS';

export interface OutcomeDistribution {
  win: number;
  halfWin: number;
  push: number;
  halfLoss: number;
  loss: number;
}

function single(value: number): 'WIN' | 'PUSH' | 'LOSS' {
  if (value > 1e-9) return 'WIN';
  if (value < -1e-9) return 'LOSS';
  return 'PUSH';
}

/** True for lines like -0.25, 0.75, 2.25 (stake is split over two half-lines). */
export function isQuarterLine(line: number): boolean {
  const frac = Math.abs(line * 4) % 2;
  return Math.abs(frac - 1) < 1e-9;
}

/**
 * Asian settlement of `margin + line`.
 *  - AH:    margin = selected team goals - opponent goals, line = selection line (e.g. -0.75)
 *  - Over:  margin = total goals, line = -L
 *  - Under: margin = -total goals, line = +L
 * Quarter lines are split into line ± 0.25 with half stake each.
 */
export function settleAsian(margin: number, line: number): Outcome {
  if (!isQuarterLine(line)) return single(margin + line);
  const a = single(margin + line - 0.25);
  const b = single(margin + line + 0.25);
  if (a === b) return a;
  const pair = [a, b].sort().join('+');
  if (pair === 'PUSH+WIN') return 'HALF_WIN';
  if (pair === 'LOSS+PUSH') return 'HALF_LOSS';
  throw new Error(`impossible quarter-line split ${a}/${b}`);
}

export type MarketSelection =
  | { market: 'MATCH_WINNER'; selection: 'HOME' | 'DRAW' | 'AWAY' }
  | { market: 'ASIAN_HANDICAP'; selection: 'HOME' | 'AWAY'; line: number }
  | { market: 'OVER_UNDER'; selection: 'OVER' | 'UNDER'; line: number };

/** Settle a selection from a 90-minute score. */
export function settle(sel: MarketSelection, home: number, away: number): Outcome {
  switch (sel.market) {
    case 'MATCH_WINNER': {
      const actual = home > away ? 'HOME' : home < away ? 'AWAY' : 'DRAW';
      return actual === sel.selection ? 'WIN' : 'LOSS';
    }
    case 'ASIAN_HANDICAP': {
      const margin = sel.selection === 'HOME' ? home - away : away - home;
      return settleAsian(margin, sel.line);
    }
    case 'OVER_UNDER': {
      const total = home + away;
      return sel.selection === 'OVER' ? settleAsian(total, -sel.line) : settleAsian(-total, sel.line);
    }
  }
}

/**
 * Probability that makes the bet fair (EV = 0), comparable to a no-vig market probability.
 * fair odds o: W(o-1) + HW(o-1)/2 - HL/2 - L = 0  ->  p = 1/o = (W + HW/2) / (W + HW/2 + L + HL/2)
 * Pushes drop out, exactly like they do in the market price.
 */
export function fairProbability(d: OutcomeDistribution): number {
  const up = d.win + d.halfWin / 2;
  const down = d.loss + d.halfLoss / 2;
  return up + down > 0 ? up / (up + down) : 0;
}

/** Expected profit per 1 unit stake at decimal odds `odds`. */
export function expectedValue(d: OutcomeDistribution, odds: number): number {
  return d.win * (odds - 1) + d.halfWin * (odds - 1) / 2 - d.halfLoss / 2 - d.loss;
}

// ---------------------------------------------------------------------------
// Settlement Engine (Phase 7): when and how a published analysis is closed
// ---------------------------------------------------------------------------

export const SETTLEMENT_VERSION = 'settlement-v0.1';
export const FINISHED_STATUSES: readonly string[] = ['FT', 'AET', 'PEN'];
export const VOID_STATUSES: readonly string[] = ['CANC', 'ABD', 'AWD', 'WO'];
/** Not played within this many hours of the kickoff we analysed -> VOID (the analysis was for that date). */
export const VOID_AFTER_HOURS = 48;

export interface PendingAnalysis {
  market: string | null;
  selection: string | null;
  line: number | null;
  /** kickoff the analysis was published for (copied at publish time) */
  kickoffAt: Date;
}

export interface FixtureState {
  statusShort: string;
  kickoffAt: Date;
  /** 90-minute score (extra time and penalties never count) */
  home: number | null;
  away: number | null;
  /** when this fixture row was last refreshed from the API */
  syncedAt: Date;
}

export type SettlementDecision =
  | { action: 'SETTLE'; status: Outcome; score: string }
  | { action: 'VOID'; reason: string }
  | { action: 'WAIT'; reason: string };

/**
 * Decide what to do with a PENDING analysis. Never guesses: anything unclear is WAIT.
 *  - finished at the analysed date  -> settle on the 90-minute score
 *  - cancelled / abandoned / awarded -> VOID
 *  - played (or still unplayed) more than 48h after the analysed kickoff -> VOID,
 *    but "still unplayed" only counts if the fixture data is fresh (a stale sync must never void).
 */
export function decideSettlement(p: PendingAnalysis, f: FixtureState, now: Date): SettlementDecision {
  const windowMs = VOID_AFTER_HOURS * 3_600_000;
  if (VOID_STATUSES.includes(f.statusShort)) return { action: 'VOID', reason: f.statusShort };
  const moved = f.kickoffAt.getTime() - p.kickoffAt.getTime() > windowMs;

  if (FINISHED_STATUSES.includes(f.statusShort)) {
    if (moved) return { action: 'VOID', reason: 'RESCHEDULED' };
    if (f.home === null || f.away === null) return { action: 'WAIT', reason: 'finished without a 90-minute score' };
    const sel = toMarketSelection(p);
    if (!sel) return { action: 'WAIT', reason: `cannot settle market ${p.market}/${p.selection}` };
    return { action: 'SETTLE', status: settle(sel, f.home, f.away), score: `${f.home}-${f.away}` };
  }

  const deadline = p.kickoffAt.getTime() + windowMs;
  if (now.getTime() > deadline && f.syncedAt.getTime() > deadline) return { action: 'VOID', reason: moved ? 'RESCHEDULED' : `NOT_PLAYED_${f.statusShort}` };
  return { action: 'WAIT', reason: `fixture status ${f.statusShort}` };
}

function toMarketSelection(p: PendingAnalysis): MarketSelection | null {
  if (p.market === 'MATCH_WINNER' && (p.selection === 'HOME' || p.selection === 'DRAW' || p.selection === 'AWAY'))
    return { market: 'MATCH_WINNER', selection: p.selection };
  if (p.line === null) return null;
  if (p.market === 'ASIAN_HANDICAP' && (p.selection === 'HOME' || p.selection === 'AWAY')) return { market: 'ASIAN_HANDICAP', selection: p.selection, line: p.line };
  if (p.market === 'OVER_UNDER' && (p.selection === 'OVER' || p.selection === 'UNDER')) return { market: 'OVER_UNDER', selection: p.selection, line: p.line };
  return null;
}

/** Bookmakers needed for a closing price (same rule as the market price in the Candidate Generator). */
export const MIN_CLOSING_BOOKMAKERS = 2;

/**
 * Closing line value: did the price we published beat the market's last price before kickoff?
 * closing = median of each bookmaker's last pre-kickoff odds for the same selection and line.
 * clv = odds_at_publish / closing - 1  (> 0 = the market moved toward our selection).
 */
export function closingLineValue(oddsAtPublish: number | null, closing: readonly number[]): { closingOdds: number; clv: number | null } | null {
  const xs = closing.filter((x) => Number.isFinite(x) && x > 1).sort((a, b) => a - b);
  if (xs.length < MIN_CLOSING_BOOKMAKERS) return null;
  const mid = xs.length / 2;
  const median = xs.length % 2 ? xs[Math.floor(mid)]! : (xs[mid - 1]! + xs[mid]!) / 2;
  const closingOdds = Math.round(median * 1000) / 1000;
  const clv = oddsAtPublish !== null && oddsAtPublish > 1 ? Math.round((oddsAtPublish / closingOdds - 1) * 1e5) / 1e5 : null;
  return { closingOdds, clv };
}
