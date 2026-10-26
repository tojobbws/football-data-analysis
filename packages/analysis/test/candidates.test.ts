import { describe, expect, it } from 'vitest';
import { biasFor, closingMarket, consensus, DEFAULT_RULES, eloAgreement, generateCandidates, noVig, type CandidateInput, type OddsQuote } from '../src/index.js';

const NOW = new Date('2026-10-17T10:00:00Z');
const KO = new Date('2026-10-18T16:30:00Z');
const fresh = new Date(NOW.getTime() - 3_600_000);

function q(bk: number, market: OddsQuote['market'], selection: string, line: number | null, homeLine: number | null, odds: number, at = fresh): OddsQuote {
  return { bookmakerId: bk, market, selection, line, homeLine, odds, updatedAt: at };
}

/** Three bookmakers (enough for a main line), AH home -0.5 at ~evens, 1X2, O/U 2.5 */
function quotes(at = fresh): OddsQuote[] {
  return ([
    q(1, 'MATCH_WINNER', 'HOME', null, null, 2.0),
    q(1, 'MATCH_WINNER', 'DRAW', null, null, 3.5),
    q(1, 'MATCH_WINNER', 'AWAY', null, null, 4.0),
    q(2, 'MATCH_WINNER', 'HOME', null, null, 2.05),
    q(2, 'MATCH_WINNER', 'DRAW', null, null, 3.4),
    q(2, 'MATCH_WINNER', 'AWAY', null, null, 3.9),
    q(3, 'MATCH_WINNER', 'HOME', null, null, 2.02),
    q(3, 'MATCH_WINNER', 'DRAW', null, null, 3.45),
    q(3, 'MATCH_WINNER', 'AWAY', null, null, 3.95),
    q(1, 'ASIAN_HANDICAP', 'HOME', -0.5, -0.5, 1.95),
    q(1, 'ASIAN_HANDICAP', 'AWAY', 0.5, -0.5, 1.95),
    q(2, 'ASIAN_HANDICAP', 'HOME', -0.5, -0.5, 1.97),
    q(2, 'ASIAN_HANDICAP', 'AWAY', 0.5, -0.5, 1.93),
    q(3, 'ASIAN_HANDICAP', 'HOME', -0.5, -0.5, 1.96),
    q(3, 'ASIAN_HANDICAP', 'AWAY', 0.5, -0.5, 1.94),
    q(1, 'OVER_UNDER', 'OVER', 2.5, null, 1.9),
    q(1, 'OVER_UNDER', 'UNDER', 2.5, null, 2.0),
    q(2, 'OVER_UNDER', 'OVER', 2.5, null, 1.92),
    q(2, 'OVER_UNDER', 'UNDER', 2.5, null, 1.98),
    q(3, 'OVER_UNDER', 'OVER', 2.5, null, 1.91),
    q(3, 'OVER_UNDER', 'UNDER', 2.5, null, 1.99),
  ] as OddsQuote[]).map((x) => ({ ...x, updatedAt: at }));
}

function input(over: Partial<CandidateInput> = {}): CandidateInput {
  return {
    fixtureId: 1,
    kickoffAt: KO,
    now: NOW,
    model: [
      { market: 'MATCH_WINNER', selection: 'HOME', line: null, probability: 0.5 },
      { market: 'MATCH_WINNER', selection: 'DRAW', line: null, probability: 0.27 },
      { market: 'MATCH_WINNER', selection: 'AWAY', line: null, probability: 0.23 },
      // AH home -0.5 == home win: model 0.50 vs market ~0.49 (no edge)
      { market: 'ASIAN_HANDICAP', selection: 'HOME', line: -0.5, probability: 0.5 },
      { market: 'ASIAN_HANDICAP', selection: 'AWAY', line: 0.5, probability: 0.5 },
      // big edge on UNDER 2.5
      { market: 'OVER_UNDER', selection: 'OVER', line: 2.5, probability: 0.43 },
      { market: 'OVER_UNDER', selection: 'UNDER', line: 2.5, probability: 0.57 },
    ],
    elo1x2: { home: 0.48, draw: 0.27, away: 0.25 },
    quotes: quotes(),
    gates: { MATCH_WINNER: { enabled: true, z: 2.5 }, ASIAN_HANDICAP: { enabled: true, z: 2.5 }, OVER_UNDER: { enabled: true, z: 3.0 } },
    teamData: { homeWeightedMatches: 30, awayWeightedMatches: 28 },
    ...over,
  };
}

describe('noVig / consensus', () => {
  it('removes margin', () => {
    const p = noVig([1.95, 1.95]);
    expect(p[0]).toBeCloseTo(0.5, 10);
  });
  it('builds per-book median consensus with best price', () => {
    const c = consensus(quotes(), NOW, 12);
    const under = c.find((x) => x.market === 'OVER_UNDER' && x.selection === 'UNDER')!;
    expect(under.nBookmakers).toBe(3);
    expect(under.bestOdds).toBe(2.0);
    expect(under.medianOdds).toBeCloseTo(1.99, 10);
    const sum = c.filter((x) => x.market === 'MATCH_WINNER').reduce((s, x) => s + x.marketProbability, 0);
    expect(sum).toBeCloseTo(1, 10);
    const awayAh = c.find((x) => x.market === 'ASIAN_HANDICAP' && x.selection === 'AWAY')!;
    expect(awayAh.line).toBe(0.5);
  });
  it('rejects books that are not a real two-way market (sum of 1/odds < 1)', () => {
    // mis-paired AH sides (e.g. wrong line convention) look like free money -> must be ignored
    const bad = [
      q(1, 'ASIAN_HANDICAP', 'HOME', -0.5, -0.5, 1.78),
      q(1, 'ASIAN_HANDICAP', 'AWAY', 0.5, -0.5, 4.5),
      q(2, 'ASIAN_HANDICAP', 'HOME', -0.5, -0.5, 1.8),
      q(2, 'ASIAN_HANDICAP', 'AWAY', 0.5, -0.5, 4.4),
    ];
    expect(consensus(bad, NOW, 12)).toHaveLength(0);
  });

  it('ignores stale quotes and incomplete bookmakers', () => {
    const stale = new Date(NOW.getTime() - 24 * 3_600_000);
    const qs = [q(1, 'OVER_UNDER', 'OVER', 2.5, null, 1.9, stale), q(1, 'OVER_UNDER', 'UNDER', 2.5, null, 2.0, stale), q(2, 'OVER_UNDER', 'OVER', 2.5, null, 1.9)];
    expect(consensus(qs, NOW, 12)).toHaveLength(0);
  });

  it('point in time: quotes from after `now`, or stored after it, are not known yet (audit A-08)', () => {
    const later = new Date(NOW.getTime() + 60_000);
    const known = consensus(quotes(), NOW, 12);
    // a later quote of bookmaker 1 at a very different price, by source time and by storage time
    const bySource = [...quotes(), ...quotes(later).filter((x) => x.bookmakerId === 1).map((x) => ({ ...x, odds: x.odds * 1.5 }))];
    const byStorage = [...quotes(), ...quotes().filter((x) => x.bookmakerId === 1).map((x) => ({ ...x, odds: x.odds * 1.5, updatedAt: new Date(NOW.getTime() - 60_000), collectedAt: later }))];
    expect(consensus(bySource, NOW, 12)).toEqual(known);
    expect(consensus(byStorage, NOW, 12)).toEqual(known);
    // the same decision a minute later sees them
    expect(consensus(bySource, later, 12)).not.toEqual(consensus(quotes(), later, 12));
    expect(generateCandidates(input({ quotes: bySource }))).toEqual(generateCandidates(input()));
  });
});

describe('generateCandidates', () => {
  it('evaluates every offered selection and picks the best passing one', () => {
    const d = generateCandidates(input());
    expect(d.summary.evaluated).toBe(7);
    expect(d.outcome).toBe('SIGNAL');
    expect(d.pick).toMatchObject({ market: 'OVER_UNDER', selection: 'UNDER', line: 2.5, passed: true });
    expect(d.pick!.edge!).toBeGreaterThan(0.05);
    expect(d.pick!.agreement).toBeNull(); // Elo has no goals model
    // edge ~0.08 >= strongEdge, gate z 3.0, agreement unknown (not contradicted) -> STRONG
    expect(d.pick!.strength).toBe('STRONG');
    const ahHome = d.candidates.find((c) => c.market === 'ASIAN_HANDICAP' && c.selection === 'HOME')!;
    expect(ahHome.rejectReasons).toContain('EDGE_BELOW_MIN');
  });

  it('takes the usual model lean off before measuring the edge (shadow rules)', () => {
    const modelBias = { 'OVER_UNDER|UNDER|2.5': 0.06, 'OVER_UNDER|OVER|2.5': -0.06 };
    const d = generateCandidates(input(), { ...DEFAULT_RULES, version: 'shadow-test', modelBias });
    const under = d.candidates.find((c) => c.market === 'OVER_UNDER' && c.selection === 'UNDER')!;
    expect(under.bias).toBe(0.06);
    expect(under.modelProbability).toBe(0.57); // raw model probability is kept
    expect(under.edge!).toBeLessThan(0.03);
    expect(under.rejectReasons).toContain('EDGE_BELOW_MIN');
    expect(d.outcome).toBe('NO_CLEAR_SIGNAL');
    // no table -> no correction
    expect(generateCandidates(input()).candidates.every((c) => c.bias === 0)).toBe(true);
  });

  it('biasFor falls back to the nearest measured line, 0 when never measured', () => {
    const t = { 'ASIAN_HANDICAP|AWAY|1': 0.05, 'ASIAN_HANDICAP|AWAY|2': 0.09 };
    expect(biasFor(t, 'ASIAN_HANDICAP', 'AWAY', 1)).toBe(0.05);
    expect(biasFor(t, 'ASIAN_HANDICAP', 'AWAY', 3.5)).toBe(0.09);
    expect(biasFor(t, 'ASIAN_HANDICAP', 'HOME', 1)).toBe(0);
    expect(biasFor(t, 'MATCH_WINNER', 'HOME', null)).toBe(0);
  });

  it('returns NO_CLEAR_SIGNAL when the market is gated off', () => {
    const d = generateCandidates(input({ gates: { MATCH_WINNER: { enabled: true, z: 2 }, ASIAN_HANDICAP: { enabled: true, z: 2 }, OVER_UNDER: { enabled: false, z: 0.5 } } }));
    expect(d.outcome).toBe('NO_CLEAR_SIGNAL');
    expect(d.pick).toBeNull();
    expect(d.summary.rejectReasons.MARKET_GATED_OFF).toBe(2);
  });

  it('caps strength at LEAN when the market gate is only marginal (z < 1.96)', () => {
    const d = generateCandidates(input({ gates: { OVER_UNDER: { enabled: true, z: 1.3 }, MATCH_WINNER: { enabled: true, z: 2 }, ASIAN_HANDICAP: { enabled: true, z: 2 } } }));
    expect(d.pick?.strength).toBe('LEAN');
  });

  it('rejects suspiciously large edges (model probably missing news)', () => {
    const m = input().model.map((x) => (x.market === 'OVER_UNDER' && x.selection === 'UNDER' ? { ...x, probability: 0.75 } : x));
    const d = generateCandidates(input({ model: m }));
    const under = d.candidates.find((c) => c.market === 'OVER_UNDER' && c.selection === 'UNDER')!;
    expect(under.rejectReasons).toContain('EDGE_TOO_LARGE');
  });

  it('fixture-level guards: too close to kickoff, low team data', () => {
    const lateNow = new Date(KO.getTime() - 5 * 60_000);
    const late = generateCandidates(input({ now: lateNow, quotes: quotes(new Date(lateNow.getTime() - 600_000)) }));
    expect(late.summary.evaluated).toBe(7);
    expect(late.outcome).toBe('NO_CLEAR_SIGNAL');
    expect(late.summary.rejectReasons.TOO_CLOSE_TO_KICKOFF).toBe(late.summary.evaluated);
    const thin = generateCandidates(input({ teamData: { homeWeightedMatches: 3, awayWeightedMatches: 30 } }));
    expect(thin.outcome).toBe('NO_CLEAR_SIGNAL');
  });

  it('blocks signals when big absences are not modelled', () => {
    const d = generateCandidates(input({ unmodelledLoss: 0.3 }));
    expect(d.outcome).toBe('NO_CLEAR_SIGNAL');
    expect(d.summary.rejectReasons.MAJOR_ABSENCE_UNMODELLED).toBe(d.summary.evaluated);
    expect(generateCandidates(input({ unmodelledLoss: 0.1 })).outcome).toBe('SIGNAL');
  });

  describe('the pick is priced on its own line only (Al Diriyah–Al Riyadh, AH 0 beside a ±1 main line)', () => {
    // model: AH 0 for the away side, the fair chance with the draw (push) left out
    const ah0 = { market: 'ASIAN_HANDICAP' as const, selection: 'AWAY', line: 0, probability: 0.30287, distribution: { win: 0.2167, halfWin: 0, push: 0.2845, halfLoss: 0, loss: 0.4988 } };
    const onlyPlusOne = [
      ...quotes().filter((x) => x.market === 'MATCH_WINNER'),
      q(1, 'ASIAN_HANDICAP', 'HOME', -1, -1, 1.93),
      q(1, 'ASIAN_HANDICAP', 'AWAY', 1, -1, 1.8),
      q(2, 'ASIAN_HANDICAP', 'HOME', -1, -1, 1.95),
      q(2, 'ASIAN_HANDICAP', 'AWAY', 1, -1, 1.82),
    ];

    it('no AH 0 quotes: no AH 0 candidate at all, never a price borrowed from AH +1 or the 1X2', () => {
      const d = generateCandidates(input({ quotes: onlyPlusOne, model: [...input().model, ah0] }));
      expect(d.candidates.find((c) => c.market === 'ASIAN_HANDICAP' && c.line === 0)).toBeUndefined();
      // the +1 line is offered but the model has no price for it: rejected, not matched to the 0 line
      expect(d.candidates.find((c) => c.market === 'ASIAN_HANDICAP' && c.selection === 'AWAY' && c.line === 1)!.rejectReasons).toContain('NO_MODEL_PRICE');
    });

    it('with AH 0 quotes the edge compares like with like: both chances leave the draw out', () => {
      const withZero = [...onlyPlusOne, q(1, 'ASIAN_HANDICAP', 'HOME', 0, 0, 1.17), q(1, 'ASIAN_HANDICAP', 'AWAY', 0, 0, 4.5), q(2, 'ASIAN_HANDICAP', 'HOME', 0, 0, 1.19), q(2, 'ASIAN_HANDICAP', 'AWAY', 0, 0, 4.45)];
      const d = generateCandidates(input({ quotes: withZero, model: [...input().model, ah0] }));
      const c = d.candidates.find((x) => x.market === 'ASIAN_HANDICAP' && x.selection === 'AWAY' && x.line === 0)!;
      // market: the AH 0 pair with the margin out, median over the two books (not 1 / 1X2 away odds)
      const pair = (h: number, a: number) => noVig([h, a])[1]!;
      expect(c.marketProbability).toBeCloseTo((pair(1.17, 4.5) + pair(1.19, 4.45)) / 2, 4);
      expect(c.odds).toBeCloseTo(4.475, 3);
      expect(c.edge).toBeCloseTo(0.30287 - c.marketProbability, 4);
      // EV from the full distribution at the same line's price: the draw returns the stake
      expect(c.ev).toBeCloseTo(0.2167 * (4.475 - 1) - 0.4988, 4);
    });

    it('stale AH 0 quotes drop out instead of standing in as the reference price', () => {
      const old = new Date(NOW.getTime() - (DEFAULT_RULES.maxOddsAgeHours + 1) * 3_600_000);
      const staleZero = [...onlyPlusOne, q(1, 'ASIAN_HANDICAP', 'HOME', 0, 0, 1.17, old), q(1, 'ASIAN_HANDICAP', 'AWAY', 0, 0, 4.5, old), q(2, 'ASIAN_HANDICAP', 'HOME', 0, 0, 1.19, old), q(2, 'ASIAN_HANDICAP', 'AWAY', 0, 0, 4.45, old)];
      const d = generateCandidates(input({ quotes: staleZero, model: [...input().model, ah0] }));
      expect(d.candidates.find((c) => c.market === 'ASIAN_HANDICAP' && c.line === 0)).toBeUndefined();
    });
  });

  it('requires at least 2 bookmakers', () => {
    const d = generateCandidates(input({ quotes: quotes().filter((x) => x.bookmakerId === 1) }));
    expect(d.summary.rejectReasons.THIN_MARKET).toBe(d.summary.evaluated);
  });

  it('missing model price for an offered line is rejected, not guessed', () => {
    const extra = [...quotes(), q(1, 'OVER_UNDER', 'OVER', 3.5, null, 3.0), q(1, 'OVER_UNDER', 'UNDER', 3.5, null, 1.4), q(2, 'OVER_UNDER', 'OVER', 3.5, null, 3.1), q(2, 'OVER_UNDER', 'UNDER', 3.5, null, 1.38)];
    const d = generateCandidates(input({ quotes: extra }));
    const o35 = d.candidates.find((c) => c.market === 'OVER_UNDER' && c.line === 3.5 && c.selection === 'OVER')!;
    expect(o35.rejectReasons).toContain('NO_MODEL_PRICE');
    expect(o35.edge).toBeNull();
  });

  it('never picks 1X2, even with the largest edge: the next passing AH/OU selection is the pick', () => {
    // home win: model 0.58 vs market ~0.49 -> the biggest edge on the board, still under the edge cap
    const m = input().model.map((x) => (x.market === 'MATCH_WINNER' && x.selection === 'HOME' ? { ...x, probability: 0.58 } : x));
    const d = generateCandidates(input({ model: m }));
    const home = d.candidates.find((c) => c.market === 'MATCH_WINNER' && c.selection === 'HOME')!;
    expect(home.edge!).toBeGreaterThan(d.pick!.edge!);
    expect(home.passed).toBe(false);
    expect(home.rejectReasons).toEqual(['MARKET_NOT_PICKABLE']);
    expect(d.pick).toMatchObject({ market: 'OVER_UNDER', selection: 'UNDER' });
    expect(d.summary.rejectReasons.MARKET_NOT_PICKABLE).toBe(3);
  });

  it('is deterministic', () => {
    expect(generateCandidates(input())).toEqual(generateCandidates(input()));
    expect(DEFAULT_RULES.version).toBe('rules-v0.6');
  });
});

describe('eloAgreement', () => {
  const elo = { home: 0.55, draw: 0.25, away: 0.2 };
  it('1X2 compares Elo with market', () => {
    expect(eloAgreement('MATCH_WINNER', 'HOME', elo, null, 0.5)).toBe(true);
    expect(eloAgreement('MATCH_WINNER', 'AWAY', elo, null, 0.3)).toBe(false);
  });
  it('AH compares strength difference with the 1X2 market', () => {
    const mw = { HOME: 0.45, DRAW: 0.27, AWAY: 0.28 };
    expect(eloAgreement('ASIAN_HANDICAP', 'HOME', elo, mw, 0.5)).toBe(true);
    expect(eloAgreement('ASIAN_HANDICAP', 'AWAY', elo, mw, 0.5)).toBe(false);
    expect(eloAgreement('ASIAN_HANDICAP', 'HOME', elo, null, 0.5)).toBeNull();
    expect(eloAgreement('OVER_UNDER', 'OVER', elo, mw, 0.5)).toBeNull();
  });
});

describe('closingMarket', () => {
  it('keeps the 1X2 and the main AH and O/U line (sides closest to 50/50)', () => {
    const qs = [
      ...quotes(),
      // a second AH line and O/U line, further from evens
      q(1, 'ASIAN_HANDICAP', 'HOME', -1, -1, 2.6),
      q(1, 'ASIAN_HANDICAP', 'AWAY', 1, -1, 1.5),
      q(2, 'ASIAN_HANDICAP', 'HOME', -1, -1, 2.55),
      q(2, 'ASIAN_HANDICAP', 'AWAY', 1, -1, 1.52),
      q(1, 'OVER_UNDER', 'OVER', 3.5, null, 3.2),
      q(1, 'OVER_UNDER', 'UNDER', 3.5, null, 1.33),
      q(2, 'OVER_UNDER', 'OVER', 3.5, null, 3.1),
      q(2, 'OVER_UNDER', 'UNDER', 3.5, null, 1.35),
    ];
    const rows = closingMarket(qs.map((x) => ({ ...x, updatedAt: new Date(KO.getTime() - 3_600_000) })), KO);
    expect(rows.map((r) => `${r.market}|${r.selection}|${r.line}`).sort()).toEqual([
      'ASIAN_HANDICAP|AWAY|0.5',
      'ASIAN_HANDICAP|HOME|-0.5',
      'MATCH_WINNER|AWAY|null',
      'MATCH_WINNER|DRAW|null',
      'MATCH_WINNER|HOME|null',
      'OVER_UNDER|OVER|2.5',
      'OVER_UNDER|UNDER|2.5',
    ]);
    const home = rows.find((r) => r.market === 'ASIAN_HANDICAP' && r.selection === 'HOME')!;
    expect(home.nBookmakers).toBe(3);
    expect(home.marketProbability).toBeGreaterThan(0.49);
    expect(home.marketProbability).toBeLessThan(0.51);
  });

  it('uses only quotes from the 24 hours before kickoff', () => {
    expect(closingMarket(quotes(new Date(KO.getTime() - 30 * 3_600_000)), KO)).toEqual([]);
    expect(closingMarket(quotes(new Date(KO.getTime() - 3_600_000)), KO)).toHaveLength(7);
  });
});
