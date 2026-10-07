/** Scoring rules for probabilistic forecasts (lower = better). */

export type Probs3 = readonly [number, number, number];

/** outcome index: 0 = home, 1 = draw, 2 = away */
export function logLoss3(p: Probs3, outcome: 0 | 1 | 2): number {
  return -Math.log(Math.max(1e-12, p[outcome]));
}

/** Multi-class Brier score (0..2). */
export function brier3(p: Probs3, outcome: 0 | 1 | 2): number {
  return p.reduce((s, pi, i) => s + (pi - (i === outcome ? 1 : 0)) ** 2, 0);
}

/** Ranked Probability Score — respects the ordering home > draw > away (0..1). */
export function rps3(p: Probs3, outcome: 0 | 1 | 2): number {
  const o = [0, 0, 0];
  o[outcome] = 1;
  let cp = 0;
  let co = 0;
  let s = 0;
  for (let i = 0; i < 2; i++) {
    cp += p[i]!;
    co += o[i]!;
    s += (cp - co) ** 2;
  }
  return s / 2;
}

export function brierBinary(p: number, happened: boolean): number {
  return (p - (happened ? 1 : 0)) ** 2;
}

export function outcomeIndex(home: number, away: number): 0 | 1 | 2 {
  return home > away ? 0 : home === away ? 1 : 2;
}

export interface CalibrationBucket {
  from: number;
  to: number;
  n: number;
  avgPredicted: number;
  observed: number;
}

/** Reliability table: when we say ~p, how often does it happen? */
export function calibration(pairs: ReadonlyArray<{ p: number; happened: boolean }>, buckets = 10): CalibrationBucket[] {
  const out: CalibrationBucket[] = [];
  for (let b = 0; b < buckets; b++) {
    const from = b / buckets;
    const to = (b + 1) / buckets;
    const inB = pairs.filter((x) => x.p >= from && (b === buckets - 1 ? x.p <= to : x.p < to));
    if (!inB.length) continue;
    out.push({
      from,
      to,
      n: inB.length,
      avgPredicted: inB.reduce((s, x) => s + x.p, 0) / inB.length,
      observed: inB.filter((x) => x.happened).length / inB.length,
    });
  }
  return out;
}
