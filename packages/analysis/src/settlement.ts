/**
 * Settlement rules (shared by the Probability Engine and the future Settlement Engine,
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
