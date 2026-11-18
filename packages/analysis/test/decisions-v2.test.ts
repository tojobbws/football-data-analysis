import { describe, expect, it } from 'vitest';
import {
  clvPoints,
  decideV2,
  distributionFor,
  estimateOptions,
  factorLean,
  hybridInputFit,
  hybridInputOptions,
  hybridInputQuality,
  optionEvidence,
  expectedValue,
  fairProbability,
  fitMarketScoreModel,
  MARKET_VIEW,
  normaliseLevels,
  TOTAL_LEVELS,
  oddsDispersion,
  scoreMatrix,
  unitsFor,
  type MarketView,
  type HybridOption,
  type MarketQuality,
  type OddsQuote,
} from '../src/index.js';

const draw = (m: number[][]) => m.reduce((s, row, i) => s + row[i]!, 0);
const sum = (d: { win: number; halfWin: number; push: number; halfLoss: number; loss: number }) => d.win + d.halfWin + d.push + d.halfLoss + d.loss;

/** Market numbers of a known score model, so the fit has a right answer. */
function marketOf(lh: number, la: number, rho: number, ahHomeLine: number, ouLine: number) {
  const m = scoreMatrix(lh, la, rho, 12);
  return {
    ahHomeLine,
    ahHomeProbability: fairProbability(distributionFor(m, { market: 'ASIAN_HANDICAP', selection: 'HOME', line: ahHomeLine })),
    ouLine,
    overProbability: fairProbability(distributionFor(m, { market: 'OVER_UNDER', selection: 'OVER', line: ouLine })),
    drawProbability: draw(m),
  };
}

/** Four main-line options priced with a margin around the given fair chances. */
function options(mk: ReturnType<typeof marketOf>, margin = 0.05): HybridOption[] {
  const price = (p: number) => Math.round((1 / (p * (1 + margin / 2))) * 100) / 100;
  const homeFav = mk.ahHomeLine <= 0;
  return [
    { side: homeFav ? 'FAVORITE' : 'UNDERDOG', market: 'ASIAN_HANDICAP', selection: 'HOME', line: mk.ahHomeLine, odds: price(mk.ahHomeProbability), marketProbability: mk.ahHomeProbability },
    { side: homeFav ? 'UNDERDOG' : 'FAVORITE', market: 'ASIAN_HANDICAP', selection: 'AWAY', line: mk.ahHomeLine === 0 ? 0 : -mk.ahHomeLine, odds: price(1 - mk.ahHomeProbability), marketProbability: 1 - mk.ahHomeProbability },
    { side: 'OVER', market: 'OVER_UNDER', selection: 'OVER', line: mk.ouLine, odds: price(mk.overProbability), marketProbability: mk.overProbability },
    { side: 'UNDER', market: 'OVER_UNDER', selection: 'UNDER', line: mk.ouLine, odds: price(1 - mk.overProbability), marketProbability: 1 - mk.overProbability },
  ];
}

const GOOD: MarketQuality = { ASIAN_HANDICAP: { nBookmakers: 6, ageHours: 1 }, OVER_UNDER: { nBookmakers: 6, ageHours: 1 } };

describe('fitMarketScoreModel', () => {
  it('recovers the goal rates and ρ of a known score model from its AH, O/U and draw prices', () => {
    for (const [lh, la, rho, ah, ou] of [
      [1.7, 1.0, -0.08, -0.75, 2.5],
      [1.1, 1.3, 0, 0.25, 2.25],
      [2.6, 0.5, -0.05, -2, 3.25],
      [0.9, 0.8, 0.05, 0, 1.75],
    ] as const) {
      const fit = fitMarketScoreModel(marketOf(lh, la, rho, ah, ou));
      expect(fit.ok).toBe(true);
      expect(fit.lambdaHome).toBeCloseTo(lh, 2);
      expect(fit.lambdaAway).toBeCloseTo(la, 2);
      expect(fit.rho).toBeCloseTo(rho, 2);
      expect(Math.abs(fit.residual.draw!)).toBeLessThan(0.002);
    }
  });

  it('without a draw price ρ stays 0 and both main lines are still priced', () => {
    const { drawProbability: _, ...mk } = marketOf(1.5, 1.2, 0, -0.25, 2.5);
    const fit = fitMarketScoreModel(mk);
    expect(fit.rho).toBe(0);
    expect(fit.ok).toBe(true);
    expect(fit.residual.draw).toBeNull();
  });

  it('refuses probabilities that are not prices', () => {
    expect(() => fitMarketScoreModel({ ahHomeLine: 0, ahHomeProbability: 1.2, ouLine: 2.5, overProbability: 0.5 })).toThrow();
  });
});

describe('estimateOptions', () => {
  const mk = marketOf(1.6, 1.1, -0.06, -0.5, 2.75);
  const fit = fitMarketScoreModel(mk);
  const opts = options(mk);

  it('under the market view each option is priced at its market chance, and its EV is the margin', () => {
    const est = estimateOptions(fit, opts, MARKET_VIEW)!;
    for (const e of est) {
      expect(e.fairProbability).toBeCloseTo(e.marketProbability, 2);
      expect(e.ev).toBeLessThan(0);
      expect(e.evSd).toBe(0);
      expect(sum(e.distribution)).toBeCloseTo(1, 9);
    }
  });

  it('keeps every outcome: a quarter line has half results, a whole line has pushes', () => {
    const q = marketOf(1.4, 1.2, 0, -0.25, 2.25);
    const est = estimateOptions(fitMarketScoreModel(q), options(q), MARKET_VIEW)!;
    const fav = est.find((e) => e.side === 'FAVORITE')!;
    expect(fav.distribution.halfLoss).toBeGreaterThan(0.15); // home -0.25 loses half on a draw
    const w = marketOf(1.4, 1.2, 0, -1, 3);
    const estW = estimateOptions(fitMarketScoreModel(w), options(w), MARKET_VIEW)!;
    expect(estW.find((e) => e.side === 'OVER')!.distribution.push).toBeGreaterThan(0.1); // exactly 3 goals
    expect(estW.find((e) => e.side === 'FAVORITE')!.distribution.push).toBeGreaterThan(0.1); // won by exactly 1
  });

  it('favourite + underdog and over + under always add up (one score distribution)', () => {
    const view: MarketView = { margin: { AWAY_SLIGHTLY: 0.3, AS_MARKET: 0.4, HOME_SLIGHTLY: 0.3 }, total: { MORE_CLEARLY: 0.2, AS_MARKET: 0.8 } };
    const est = estimateOptions(fit, opts, view)!;
    const p = Object.fromEntries(est.map((e) => [e.side, e.fairProbability]));
    expect(p.FAVORITE! + p.UNDERDOG!).toBeCloseTo(1, 9);
    expect(p.OVER! + p.UNDER!).toBeCloseTo(1, 9);
  });

  it('a home-leaning margin and more goals help the home favourite and Over, and the uncertainty is reported', () => {
    const view: MarketView = { margin: { HOME_SLIGHTLY: 0.5, HOME_CLEARLY: 0.5 }, total: { MORE_SLIGHTLY: 1 } };
    const est = estimateOptions(fit, opts, view)!;
    const base = estimateOptions(fit, opts, MARKET_VIEW)!;
    const by = (xs: typeof est, s: string) => xs.find((e) => e.side === s)!;
    expect(by(est, 'FAVORITE').ev).toBeGreaterThan(by(base, 'FAVORITE').ev);
    expect(by(est, 'OVER').ev).toBeGreaterThan(by(base, 'OVER').ev);
    expect(by(est, 'UNDERDOG').ev).toBeLessThan(by(base, 'UNDERDOG').ev);
    expect(by(est, 'FAVORITE').evSd).toBeGreaterThan(0);
    // EV is the expected profit of the mixture distribution at the option's price
    const f = by(est, 'FAVORITE');
    expect(f.ev).toBeCloseTo(expectedValue(f.distribution, f.odds), 9);
  });

  it('rejects a view that is not a probability distribution', () => {
    expect(estimateOptions(fit, opts, { margin: { HOME_SLIGHTLY: 0.7 }, total: { AS_MARKET: 1 } })).toBeNull();
    expect(estimateOptions(fit, opts, { margin: { AS_MARKET: 1 }, total: { SOMETHING: 1 } as never })).toBeNull();
    expect(normaliseLevels(TOTAL_LEVELS, { FEWER_SLIGHTLY: 0.51, MORE_SLIGHTLY: 0.5 })).not.toBeNull(); // rounding within 0.05 is normalised
  });
});

describe('decideV2', () => {
  const mk = marketOf(1.5, 1.2, -0.05, -0.25, 2.5);
  const fit = fitMarketScoreModel(mk);
  const opts = options(mk);

  it('the market view never picks: the null model always says NO_PICK', () => {
    const d = decideV2(fit, estimateOptions(fit, opts, MARKET_VIEW)!, GOOD);
    expect(d.side).toBe('NO_PICK');
    expect(d.chosen).toBeNull();
    expect(d.noPickReasons).toContain('EV_BELOW_THRESHOLD');
    expect(d.candidates).toHaveLength(4);
  });

  it('a confident view with enough expected profit picks the best option and records why the rest were left', () => {
    const view: MarketView = { margin: { HOME_CLEARLY: 1 }, total: { AS_MARKET: 1 } };
    const d = decideV2(fit, estimateOptions(fit, opts, view)!, GOOD);
    expect(d.side).toBe('FAVORITE');
    expect(d.chosen!.ev).toBeGreaterThanOrEqual(0.03);
    expect(d.candidates.find((c) => c.side === 'UNDERDOG')!.reasons).toContain('EV_BELOW_THRESHOLD');
  });

  it('an unsure view with the same mean is not robust enough to pick', () => {
    const unsure: MarketView = { margin: { AWAY_CLEARLY: 0.35, HOME_CLEARLY: 0.65 }, total: { AS_MARKET: 1 } };
    const d = decideV2(fit, estimateOptions(fit, opts, unsure)!, GOOD);
    const fav = d.candidates.find((c) => c.side === 'FAVORITE')!;
    expect(fav.reasons).toContain('EV_NOT_ROBUST');
    expect(d.side).toBe('NO_PICK');
  });

  it('data gates win over expected profit: too few bookmakers, stale prices, a failed fit', () => {
    const view: MarketView = { margin: { HOME_CLEARLY: 1 }, total: { AS_MARKET: 1 } };
    const est = estimateOptions(fit, opts, view)!;
    expect(decideV2(fit, est, { ...GOOD, ASIAN_HANDICAP: { nBookmakers: 2, ageHours: 1 } }).candidates.find((c) => c.side === 'FAVORITE')!.reasons).toContain('TOO_FEW_BOOKMAKERS');
    expect(decideV2(fit, est, { ...GOOD, ASIAN_HANDICAP: { nBookmakers: 6, ageHours: 30 } }).candidates.find((c) => c.side === 'FAVORITE')!.reasons).toContain('STALE_PRICE');
    expect(decideV2({ ...fit, ok: false }, est, GOOD).side).toBe('NO_PICK');
  });

  it('only ever chooses one of the options it was given', () => {
    const view: MarketView = { margin: { AS_MARKET: 1 }, total: { MORE_CLEARLY: 1 } };
    const ou = opts.filter((o) => o.market === 'OVER_UNDER');
    const d = decideV2(fit, estimateOptions(fit, ou, view)!, GOOD);
    expect(['OVER', 'UNDER', 'NO_PICK']).toContain(d.side);
  });
});

describe('oddsDispersion', () => {
  const at = (h: number) => new Date(Date.UTC(2026, 10, 17, h));
  const q = (bk: number, sel: string, odds: number, upd: number, coll?: number): OddsQuote => ({
    bookmakerId: bk, market: 'ASIAN_HANDICAP', selection: sel, line: sel === 'HOME' ? -0.5 : 0.5, homeLine: -0.5, odds, updatedAt: at(upd), ...(coll != null ? { collectedAt: at(coll) } : {}),
  });

  it('uses each bookmaker’s latest price known at the decision time, never a later one', () => {
    const quotes = [q(1, 'HOME', 1.9, 5), q(1, 'AWAY', 1.95, 5), q(2, 'HOME', 1.85, 6), q(2, 'AWAY', 2.0, 6), q(3, 'HOME', 1.95, 6), q(3, 'AWAY', 1.9, 6),
      q(1, 'HOME', 1.5, 9), q(1, 'AWAY', 2.6, 9), // updated after 07:00
      q(3, 'HOME', 1.6, 6, 8), q(3, 'AWAY', 2.4, 6, 8)]; // stored after 07:00 (replay)
    const d = oddsDispersion(quotes, at(7), 'ASIAN_HANDICAP', 'HOME', -0.5);
    expect(d.nBookmakers).toBe(3);
    expect(d.minOdds).toBe(1.85);
    expect(d.maxOdds).toBe(1.95);
    expect(d.medianOdds).toBe(1.9);
    expect(d.marketProbability).toBeGreaterThan(0.4);
  });
});

describe('evaluation helpers', () => {
  it('units follow the settlement outcome at the decision price', () => {
    expect(unitsFor('WIN', 1.9)).toBeCloseTo(0.9);
    expect(unitsFor('HALF_WIN', 1.9)).toBeCloseTo(0.45);
    expect(unitsFor('PUSH', 1.9)).toBe(0);
    expect(unitsFor('HALF_LOSS', 1.9)).toBe(-0.5);
    expect(unitsFor('LOSS', 1.9)).toBe(-1);
  });
  it('CLV is the closing chance minus the decision chance, null when the line closed elsewhere', () => {
    expect(clvPoints(0.51, 0.535)).toBeCloseTo(0.025);
    expect(clvPoints(0.51, null)).toBeNull();
  });
});

describe('reading a stored Hybrid input and the evidence', () => {
  const input = {
    match: { home: 'Home FC', away: 'Away FC' },
    market: {
      asian_handicap: { home_line: -0.5, bookmakers: 5, price_age_hours: 2, options: [
        { option: 'FAVORITE', team_or_total: 'Home FC', line: -0.5, odds_median: 1.9, market_probability_no_vig: 0.51 },
        { option: 'UNDERDOG', team_or_total: 'Away FC', line: 0.5, odds_median: 1.98, market_probability_no_vig: 0.49 },
      ] },
      over_under: { line: 2.5, bookmakers: 3, price_age_hours: 2, options: [
        { option: 'OVER', team_or_total: 'OVER', line: 2.5, odds_median: 1.92, market_probability_no_vig: 0.5 },
        { option: 'UNDER', team_or_total: 'UNDER', line: 2.5, odds_median: 1.96, market_probability_no_vig: 0.5 },
      ] },
      match_odds_1x2_no_vig: { home: 0.45, draw: 0.26, away: 0.29 },
    },
  };

  it('takes the options, their quality and the market fit from the input exactly', () => {
    const opts = hybridInputOptions(input);
    expect(opts.map((o) => `${o.side}:${o.selection}:${o.line}@${o.odds}`)).toEqual(['FAVORITE:HOME:-0.5@1.9', 'UNDERDOG:AWAY:0.5@1.98', 'OVER:OVER:2.5@1.92', 'UNDER:UNDER:2.5@1.96']);
    expect(hybridInputQuality(input)).toMatchObject({ ASIAN_HANDICAP: { nBookmakers: 5, ageHours: 2 }, OVER_UNDER: { nBookmakers: 3, ageHours: 2 } });
    const fit = hybridInputFit(input)!;
    expect(fit.ok).toBe(true);
    expect(Math.abs(fit.residual.draw!)).toBeLessThan(0.002);
    expect(hybridInputFit({ ...input, market: { ...input.market, over_under: { options: [] } } })).toBeNull();
  });

  it('a data gate below the analyst’s sufficiency stops every option', () => {
    const fit = hybridInputFit(input)!;
    const est = estimateOptions(fit, hybridInputOptions(input), { margin: { HOME_CLEARLY: 1 }, total: { AS_MARKET: 1 } })!;
    expect(decideV2(fit, est, { ...hybridInputQuality(input), dataSufficient: 0.9 }).side).toBe('FAVORITE');
    const d = decideV2(fit, est, { ...hybridInputQuality(input), dataSufficient: 0.3 });
    expect(d.side).toBe('NO_PICK');
    expect(d.noPickReasons).toContain('DATA_INSUFFICIENT');
  });

  it('a factor supports the options it leans to and conflicts with the others', () => {
    const ev = optionEvidence(hybridInputOptions(input), [
      { name: 'performance', kind: 'TEAM', probabilities: [0, 0, 0.2, 0.6, 0.2] }, // lean +1.0 toward home
      { name: 'market_move', kind: 'TEAM', probabilities: [0, 0.3, 0.7, 0, 0] }, // −0.3 toward away
      { name: 'scoring_data', kind: 'GOALS', probabilities: [0, 0, 0.9, 0.1, 0] }, // +0.1: too small to count
    ]);
    expect(ev.find((e) => e.side === 'FAVORITE')).toEqual({ side: 'FAVORITE', supporting: [{ factor: 'performance', lean: 1 }], conflicting: [{ factor: 'market_move', lean: -0.3 }] });
    expect(ev.find((e) => e.side === 'UNDERDOG')).toEqual({ side: 'UNDERDOG', supporting: [{ factor: 'market_move', lean: -0.3 }], conflicting: [{ factor: 'performance', lean: 1 }] });
    expect(ev.find((e) => e.side === 'OVER')).toEqual({ side: 'OVER', supporting: [], conflicting: [] });
    expect(factorLean([0.5, 0, 0, 0, 0.5])).toBe(0);
  });
});
