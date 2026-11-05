/**
 * Research, read-only (no AI calls, no DB writes): how biased is the Dixon-Coles voice the Hybrid AI is shown
 * (hybrid_decisions.input.legacy_statistical_model.option_probabilities), and what correction would fix it?
 *
 *   npx tsx scripts/research/dc-bias-in-hybrid-input.ts
 *
 * Per finished EARLY decision (latest per fixture), for the AH favourite and the Over option of the main lines:
 *   m  = market no-vig probability shown to the AI, d = DC probability shown to the AI,
 *   y  = settled result as stake weights (WIN 1×y1, HALF_WIN 0.5×y1, HALF_LOSS 0.5×y0, LOSS 1×y0, PUSH dropped).
 * Reports mean(d - m) and mean(y) - mean(m) per side, and fits, by weighted logistic regression with offset logit(m):
 *   logit P(y) = logit(m) + a + k * (logit(d) - logit(m))
 * k ≈ 0: DC adds nothing beyond the market (drop it); k ≈ 1: DC as is; 0 < k < 1: shrink DC toward the market by k.
 * The fit is checked out of sample with 5-fold cross-validation (log loss vs the market alone).
 */
import { settle } from '@fp/analysis';
import { createPgDb } from '@fp/database';
import { loadDotEnvFile, loadEnv } from '@fp/shared';

loadDotEnvFile();
const db = createPgDb(loadEnv().DATABASE_URL);
const rows = (
  await db.query<{ fixture_id: string; input: Record<string, any>; gh: number; ga: number }>(
    `select distinct on (d.fixture_id) d.fixture_id, d.input, coalesce(f.ft_home, f.goals_home) gh, coalesce(f.ft_away, f.goals_away) ga
       from hybrid_decisions d join fixtures f on f.id = d.fixture_id
      where d.engine_version = 'hybrid-ai-v1' and d.publish_round = 'EARLY' and d.status = 'OK'
        and f.status_short in ('FT','AET','PEN') and coalesce(f.ft_home, f.goals_home) is not null
      order by d.fixture_id, d.decided_at desc`,
  )
).rows;

interface Obs { side: 'FAVORITE' | 'OVER'; m: number; d: number; y: number; w: number }
const obs: Obs[] = [];
const logit = (p: number) => Math.log(p / (1 - p));
const sig = (z: number) => 1 / (1 + Math.exp(-z));
for (const r of rows) {
  const dc = r.input.legacy_statistical_model?.option_probabilities as Record<string, number> | undefined;
  if (!dc) continue;
  const home = r.input.match.home as string;
  const opts = [...(r.input.market.asian_handicap?.options ?? []), ...(r.input.market.over_under?.options ?? [])] as Array<Record<string, any>>;
  for (const side of ['FAVORITE', 'OVER'] as const) {
    const o = opts.find((x) => x.option === side);
    const d = dc[side];
    if (!o || d == null || !(d > 0 && d < 1)) continue;
    const sel = side === 'OVER'
      ? ({ market: 'OVER_UNDER', selection: 'OVER', line: Number(o.line) } as const)
      : ({ market: 'ASIAN_HANDICAP', selection: o.team_or_total === home ? 'HOME' : 'AWAY', line: Number(o.line) } as const);
    const out = settle(sel, r.gh, r.ga);
    const m = Number(o.market_probability_no_vig);
    const add = (y: number, w: number) => obs.push({ side, m, d, y, w });
    if (out === 'WIN') add(1, 1);
    else if (out === 'HALF_WIN') add(1, 0.5);
    else if (out === 'HALF_LOSS') add(0, 0.5);
    else if (out === 'LOSS') add(0, 1);
  }
}

/** weighted logistic with offset logit(m): params [a, k] */
function fit(o: Obs[]): [number, number] {
  let a = 0, k = 0;
  for (let it = 0; it < 50; it++) {
    let g0 = 0, g1 = 0, h00 = 1e-6, h01 = 0, h11 = 1e-6;
    for (const x of o) {
      const u = logit(x.d) - logit(x.m);
      const p = sig(logit(x.m) + a + k * u);
      const e = (p - x.y) * x.w, v = p * (1 - p) * x.w;
      g0 += e; g1 += e * u; h00 += v; h01 += v * u; h11 += v * u * u;
    }
    const det = h00 * h11 - h01 * h01;
    a -= (h11 * g0 - h01 * g1) / det;
    k -= (-h01 * g0 + h00 * g1) / det;
  }
  return [a, k];
}
const ll = (o: Obs[], p: (x: Obs) => number) => {
  const W = o.reduce((s, x) => s + x.w, 0);
  return o.reduce((s, x) => s - x.w * Math.log(x.y ? p(x) : 1 - p(x)), 0) / W;
};
const wmean = (o: Obs[], f: (x: Obs) => number) => o.reduce((s, x) => s + x.w * f(x), 0) / o.reduce((s, x) => s + x.w, 0);

for (const side of ['FAVORITE', 'OVER'] as const) {
  const o = obs.filter((x) => x.side === side);
  const [a, k] = fit(o);
  // 5-fold CV: market alone vs market + corrected DC vs raw DC
  let lm = 0, lc = 0, ld = 0, W = 0;
  for (let f = 0; f < 5; f++) {
    const test = o.filter((_, i) => i % 5 === f);
    const [fa, fk] = fit(o.filter((_, i) => i % 5 !== f));
    const w = test.reduce((s, x) => s + x.w, 0);
    lm += ll(test, (x) => x.m) * w;
    lc += ll(test, (x) => sig(logit(x.m) + fa + fk * (logit(x.d) - logit(x.m)))) * w;
    ld += ll(test, (x) => x.d) * w;
    W += w;
  }
  const label = side === 'FAVORITE' ? 'AH favourite (underdog = the other side)' : 'Over (Under = the other side)';
  console.log(`\n${label}: n=${o.length} (weight ${o.reduce((s, x) => s + x.w, 0)})`);
  console.log(`  market shown  mean ${(100 * wmean(o, (x) => x.m)).toFixed(1)}%   DC shown mean ${(100 * wmean(o, (x) => x.d)).toFixed(1)}%   actual ${(100 * wmean(o, (x) => x.y)).toFixed(1)}%`);
  console.log(`  DC - market: mean ${(100 * wmean(o, (x) => x.d - x.m)).toFixed(1)} pts, |gap| mean ${(100 * wmean(o, (x) => Math.abs(x.d - x.m))).toFixed(1)} pts`);
  console.log(`  fit: a=${a.toFixed(3)}  k=${k.toFixed(3)}  (k: 0 = DC adds nothing, 1 = DC as is)`);
  console.log(`  5-fold CV log loss: market ${(lm / W).toFixed(4)} · market+corrected DC ${(lc / W).toFixed(4)} · raw DC ${(ld / W).toFixed(4)}`);
}
process.exit(0);
