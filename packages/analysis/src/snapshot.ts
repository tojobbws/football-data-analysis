/**
 * Scoreline matrix kept with a model snapshot. 1X2, Asian handicap, over/under and expected goals
 * are all priced from it with the same functions the picks use (priceSelection), so a stored
 * snapshot can be re-read years later without re-fitting anything.
 */
/** Same size the pricing uses (scoreMatrix default), so a stored matrix prices exactly what was priced. */
export const SNAPSHOT_MAX_GOALS = 10;

/** Crop to 0..maxGoals goals per team, renormalise to sum 1, round (keeps the stored JSON small). */
export function cropMatrix(matrix: readonly (readonly number[])[], maxGoals = SNAPSHOT_MAX_GOALS, digits = 6): number[][] {
  const cropped = matrix.slice(0, maxGoals + 1).map((row) => row.slice(0, maxGoals + 1));
  const total = cropped.reduce((s, row) => s + row.reduce((a, b) => a + b, 0), 0);
  if (!(total > 0)) throw new Error('scoreline matrix has no probability mass');
  const k = 10 ** digits;
  return cropped.map((row) => row.map((p) => Math.round((p / total) * k) / k));
}

/** The single exact score with the highest probability. */
export function mostLikelyScore(matrix: readonly (readonly number[])[]): { home: number; away: number; probability: number } {
  let best = { home: 0, away: 0, probability: -1 };
  matrix.forEach((row, i) =>
    row.forEach((p, j) => {
      if (p > best.probability) best = { home: i, away: j, probability: p };
    }),
  );
  return best;
}
