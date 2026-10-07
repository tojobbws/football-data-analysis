import { fairProbability, settle, type MarketSelection, type OutcomeDistribution } from './settlement.js';

export interface MarketProbability {
  market: MarketSelection['market'];
  selection: string;
  line: number | null;
  /** Fair (push-excluded) probability — directly comparable to no-vig market probability */
  probability: number;
  distribution: OutcomeDistribution;
}

/** Outcome distribution of any selection, integrating the settlement rule over the score matrix. */
export function distributionFor(matrix: number[][], sel: MarketSelection): OutcomeDistribution {
  const d: OutcomeDistribution = { win: 0, halfWin: 0, push: 0, halfLoss: 0, loss: 0 };
  for (let i = 0; i < matrix.length; i++) {
    const row = matrix[i]!;
    for (let j = 0; j < row.length; j++) {
      const p = row[j]!;
      if (p === 0) continue;
      switch (settle(sel, i, j)) {
        case 'WIN':
          d.win += p;
          break;
        case 'HALF_WIN':
          d.halfWin += p;
          break;
        case 'PUSH':
          d.push += p;
          break;
        case 'HALF_LOSS':
          d.halfLoss += p;
          break;
        case 'LOSS':
          d.loss += p;
          break;
      }
    }
  }
  return d;
}

export function priceSelection(matrix: number[][], sel: MarketSelection): MarketProbability {
  const distribution = distributionFor(matrix, sel);
  return {
    market: sel.market,
    selection: sel.selection,
    line: 'line' in sel ? sel.line : null,
    probability: fairProbability(distribution),
    distribution,
  };
}

export const DEFAULT_OU_LINES = [1.5, 2.5, 3.5];
export const DEFAULT_AH_HOME_LINES = [-1, -0.5, 0, 0.5, 1];

/**
 * Price a full set of markets.
 * `ahHomeLines` are home-perspective lines; both sides are priced (Away line = -homeLine).
 */
export function priceMarkets(
  matrix: number[][],
  lines: { ou?: readonly number[]; ahHome?: readonly number[] } = {},
): MarketProbability[] {
  const out: MarketProbability[] = [];
  for (const s of ['HOME', 'DRAW', 'AWAY'] as const) out.push(priceSelection(matrix, { market: 'MATCH_WINNER', selection: s }));
  for (const l of uniq(lines.ou ?? DEFAULT_OU_LINES)) {
    out.push(priceSelection(matrix, { market: 'OVER_UNDER', selection: 'OVER', line: l }));
    out.push(priceSelection(matrix, { market: 'OVER_UNDER', selection: 'UNDER', line: l }));
  }
  for (const h of uniq(lines.ahHome ?? DEFAULT_AH_HOME_LINES)) {
    out.push(priceSelection(matrix, { market: 'ASIAN_HANDICAP', selection: 'HOME', line: h }));
    out.push(priceSelection(matrix, { market: 'ASIAN_HANDICAP', selection: 'AWAY', line: h === 0 ? 0 : -h }));
  }
  return out;
}

function uniq(xs: readonly number[]): number[] {
  return [...new Set(xs.map((x) => Math.round(x * 4) / 4))].sort((a, b) => a - b);
}
