import { describe, expect, it } from 'vitest';
import {
  buildReason,
  closingMarket,
  DEFAULT_RULES,
  distributionFor,
  generateCandidates,
  mainLines,
  noVig,
  priceSelection,
  readMainLines,
  settle,
  SHADOW_RULES,
  type CandidateInput,
  type ModelPrice,
  type OddsQuote,
} from '../src/index.js';

/**
 * rules-v0.6 judges the pick on the market's main line only. The quotes below are the real
 * per-bookmaker Asian handicap prices of Liverpool–Villarreal (fixture 1635688, odds_history,
 * 2026-10-20 08:21Z): the main line is Liverpool -1.25 (2.045 / 1.805 at the median, 6 bookmakers),
 * while -1.5 has the most bookmakers (8) and -2.5 is where v0.5 published its pick.
 */
const NOW = new Date('2026-10-20T09:13:00Z');
const KO = new Date('2026-10-20T19:00:00Z');
const AT = new Date('2026-10-20T08:21:00Z');

const BOOKS: Record<string, Array<[number, number, number]>> = {
  '-1': [[2, 1.79, 2.03], [4, 1.79, 2.11], [5, 1.83, 2.05], [8, 1.75, 2.05], [11, 1.79, 2.03], [32, 1.8, 2.05], [36, 1.69, 2.01]],
  '-1.25': [[2, 2.02, 1.76], [4, 2.07, 1.85], [5, 2.09, 1.79], [8, 2.02, 1.82], [11, 2.12, 1.84], [36, 1.94, 1.74]],
  '-1.5': [[2, 2.25, 1.6], [3, 2.25, 1.57], [4, 2.31, 1.67], [5, 2.29, 1.65], [8, 2.2, 1.65], [11, 2.37, 1.68], [32, 2.32, 1.65], [36, 2.19, 1.58]],
  '-2.5': [[2, 3.75, 1.21], [3, 4.0, 1.2], [8, 3.8, 1.25], [11, 3.75, 1.21]],
};

function ah(homeLine: number, at = AT, books = BOOKS[String(homeLine)]!): OddsQuote[] {
  return books.flatMap(([bk, home, away]) => [
    { bookmakerId: bk, market: 'ASIAN_HANDICAP' as const, selection: 'HOME', line: homeLine, homeLine, odds: home, updatedAt: at },
    { bookmakerId: bk, market: 'ASIAN_HANDICAP' as const, selection: 'AWAY', line: -homeLine, homeLine, odds: away, updatedAt: at },
  ]);
}

const LINES = [-1, -1.25, -1.5, -2.5];
const liverpool = (at = AT) => LINES.flatMap((l) => ah(l, at));

/** Score matrix [home goals][away goals] from a few scores; everything else 0. */
function matrix(scores: Record<string, number>): number[][] {
  const m = Array.from({ length: 6 }, () => Array<number>(6).fill(0));
  for (const [s, p] of Object.entries(scores)) {
    const [h, a] = s.split('-').map(Number);
    m[h!]![a!] = p;
  }
  return m;
}

/** Model prices for both sides of every quoted line, all from one score matrix. */
function modelFrom(m: number[][]): ModelPrice[] {
  return LINES.flatMap((l) => [
    priceSelection(m, { market: 'ASIAN_HANDICAP', selection: 'HOME', line: l }),
    priceSelection(m, { market: 'ASIAN_HANDICAP', selection: 'AWAY', line: -l }),
  ]);
}

/**
 * Most likely score 1-0, but the model also sees many wins by 3+:
 * margin <= 0: 30%, 1 goal: 24%, 2 goals: 12%, 3+: 34%.
 * -1.25 Liverpool: fair 0.523 vs market 0.468 (+5.4); -2.5: 0.34 vs 0.243 (+9.7, the larger gap).
 */
const WIDE = matrix({ '0-0': 0.12, '0-1': 0.1, '1-1': 0.08, '1-0': 0.15, '2-1': 0.09, '2-0': 0.12, '3-0': 0.14, '4-1': 0.1, '4-0': 0.1 });

/**
 * The 2026-10-20 case: the model is far above the market on the main line (+18 points, past the
 * 12-point cap), while -2.5 lands just under the cap. margin <= 0: 20%, 1: 22%, 2: 23%, 3+: 35%.
 */
const FAR = matrix({ '0-0': 0.1, '1-1': 0.1, '2-1': 0.12, '1-0': 0.1, '2-0': 0.23, '3-0': 0.2, '4-0': 0.15 });

function input(over: Partial<CandidateInput> = {}): CandidateInput {
  return {
    fixtureId: 1635688,
    kickoffAt: KO,
    now: NOW,
    model: modelFrom(WIDE),
    elo1x2: null,
    quotes: liverpool(),
    gates: { ASIAN_HANDICAP: { enabled: true, z: 2.5 }, OVER_UNDER: { enabled: true, z: 2.5 } },
    teamData: { homeWeightedMatches: 30, awayWeightedMatches: 30 },
    ...over,
  };
}

const V05 = { ...DEFAULT_RULES, version: 'rules-v0.5', mainLineOnly: false };
const label = (c: { selection: string; line: number | null } | null) => (c ? `${c.selection} ${c.line}` : null);

describe('main line', () => {
  it('is the line closest to 50/50 among lines with 3+ complete bookmakers, not the line with the most bookmakers', () => {
    const ml = mainLines(liverpool(), NOW, DEFAULT_RULES).ASIAN_HANDICAP;
    expect(ml).toMatchObject({ status: 'OK', source: 'CONSENSUS_CLOSEST_TO_EVEN', line: -1.25, nBookmakers: 6, incompleteBookmakers: 0 });
    expect(ml.odds!.first).toBeCloseTo(2.045, 3);
    expect(ml.odds!.second).toBeCloseTo(1.805, 3);
    expect(ml.firstProbability!).toBeCloseTo(0.4688, 4);
    expect(ml.updatedAt).toBe(AT.toISOString());
    // -1.5 has 8 bookmakers, more than any other line
    expect(BOOKS['-1.5']!.length).toBeGreaterThan(BOOKS['-1.25']!.length);
  });

  it('the closing market keeps the same main line', () => {
    const rows = closingMarket(liverpool(), KO).filter((r) => r.market === 'ASIAN_HANDICAP');
    expect(rows.map((r) => `${r.selection} ${r.line}`).sort()).toEqual(['AWAY 1.25', 'HOME -1.25']);
  });

  it('a bookmaker with one side only, or with sides that are not one market, is left out and counted', () => {
    const half = liverpool()
      // bookmaker 2 quotes only Liverpool's side of -1.25
      .filter((q) => !(q.bookmakerId === 2 && q.homeLine === -1.25 && q.selection === 'AWAY'))
      // bookmaker 5's away price belongs to another market: 1/2.09 + 1/4.5 < 1
      .map((q) => (q.bookmakerId === 5 && q.homeLine === -1.25 && q.selection === 'AWAY' ? { ...q, odds: 4.5 } : q));
    const ml = mainLines(half, NOW, DEFAULT_RULES).ASIAN_HANDICAP;
    expect(ml).toMatchObject({ status: 'OK', line: -1.25, nBookmakers: 4, incompleteBookmakers: 2 });
  });

  it('too few complete bookmakers on every line: no main line, never a guess', () => {
    const two = LINES.flatMap((l) => ah(l, AT, BOOKS[String(l)]!.slice(0, 2)));
    const ml = mainLines(two, NOW, DEFAULT_RULES).ASIAN_HANDICAP;
    expect(ml.status).toBe('TOO_FEW_BOOKMAKERS');
    const d = generateCandidates(input({ quotes: two }));
    expect(d.pick).toBeNull();
    expect(d.decisionReason).toBe('MAIN_LINE_UNAVAILABLE');
    expect(d.candidates.filter((c) => c.market === 'ASIAN_HANDICAP').every((c) => c.rejectReasons.includes('MAIN_LINE_UNAVAILABLE'))).toBe(true);
  });

  it('no quotes at all: NO_QUOTES', () => {
    expect(mainLines([], NOW, DEFAULT_RULES)).toMatchObject({ ASIAN_HANDICAP: { status: 'NO_QUOTES', line: null }, OVER_UNDER: { status: 'NO_QUOTES', line: null } });
  });
});

describe('rules-v0.6 picks on the main line only', () => {
  it('main line -1.25 while -2.5 shows the larger model-market gap: v0.6 judges -1.25, v0.5 took -2.5', () => {
    const old = generateCandidates(input(), V05);
    expect(label(old.pick)).toBe('HOME -2.5');

    const d = generateCandidates(input());
    expect(d.rulesVersion).toBe('rules-v0.6');
    expect(d.decisionReason).toBe('SIGNAL_ON_MAIN_LINE');
    expect(label(d.pick)).toBe('HOME -1.25');
    expect(d.pick!.onMainLine).toBe(true);
    expect(d.pick!.odds).toBeCloseTo(2.045, 3);
    const far = d.candidates.find((c) => c.selection === 'HOME' && c.line === -2.5)!;
    expect(far.edge!).toBeGreaterThan(d.pick!.edge!);
    expect(far.onMainLine).toBe(false);
    expect(far.rejectReasons).toEqual(['NOT_MAIN_LINE']);
    // both sides of the main line are judged, nothing else can pass
    expect(d.candidates.filter((c) => c.onMainLine).map(label).sort()).toEqual(['AWAY 1.25', 'HOME -1.25']);
    expect(d.candidates.filter((c) => c.passed).every((c) => c.onMainLine)).toBe(true);
  });

  it('2026-10-20: main line past the edge cap -> no qualified signal, never the far line that fits under it', () => {
    const model = modelFrom(FAR);
    const old = generateCandidates(input({ model }), V05);
    expect(label(old.pick)).toBe('HOME -2.5');

    const d = generateCandidates(input({ model }));
    expect(d.outcome).toBe('NO_CLEAR_SIGNAL');
    expect(d.decisionReason).toBe('NO_QUALIFIED_SIGNAL');
    const main = d.candidates.find((c) => c.selection === 'HOME' && c.line === -1.25)!;
    expect(main.edge!).toBeGreaterThan(DEFAULT_RULES.maxEdge);
    expect(main.rejectReasons).toEqual(['EDGE_TOO_LARGE']);
    // the reasons count the main line only, so the published fog explains the real cause
    expect(d.summary.rejectReasons.EDGE_TOO_LARGE).toBe(1);
    expect(d.summary.rejectReasons.NOT_MAIN_LINE).toBeUndefined();
    expect(d.summary.notMainLine).toBe(6);
    // the fog names the main line's own reason, not the opposite side's or a far line's
    expect(d.fogReasons).toEqual([{ market: 'ASIAN_HANDICAP', reason: 'EDGE_TOO_LARGE' }, { market: 'OVER_UNDER', reason: 'MAIN_LINE_UNAVAILABLE' }]);
    const fog = buildReason({ kind: 'NO_CLEAR_SIGNAL', round: 'EARLY', home: 'Liverpool', away: 'Villarreal', rejectReasons: d.summary.rejectReasons, fogReasons: d.fogReasons });
    expect(fog).toContain('เหตุผลหลัก: แฮนดิแคปเส้นหลัก: โมเดลกับตลาดต่างกันมากผิดปกติ');
    expect(fog).toContain('สูง/ต่ำเส้นหลัก: ยังไม่มีเส้นหลักของตลาดที่เชื่อถือได้');
    // a pick or rules without main lines leave no fog reasons
    expect(generateCandidates(input()).fogReasons).toEqual([]);
    expect(generateCandidates(input({ model }), V05).fogReasons).toEqual([]);
  });

  it('a stale main line is not replaced by a fresh far line', () => {
    const old = new Date(NOW.getTime() - (DEFAULT_RULES.maxOddsAgeHours + 1) * 3_600_000);
    // -1, -1.25 and -1.5 went stale; only -2.5 is fresh, with 4 bookmakers
    const quotes = [...ah(-1, old), ...ah(-1.25, old), ...ah(-1.5, old), ...ah(-2.5)];
    const ml = mainLines(quotes, NOW, DEFAULT_RULES).ASIAN_HANDICAP;
    expect(ml).toMatchObject({ status: 'UNBALANCED', line: -2.5 });
    const d = generateCandidates(input({ quotes }));
    expect(d.pick).toBeNull();
    expect(d.decisionReason).toBe('MAIN_LINE_UNAVAILABLE');
    expect(d.candidates.find((c) => c.line === -2.5 && c.selection === 'HOME')!.rejectReasons).toContain('MAIN_LINE_UNAVAILABLE');

    // every line stale: the main line is known but too old to use
    const allOld = mainLines(liverpool(old), NOW, DEFAULT_RULES).ASIAN_HANDICAP;
    expect(allOld).toMatchObject({ status: 'STALE', line: -1.25 });
    expect(generateCandidates(input({ quotes: liverpool(old) })).pick).toBeNull();
  });

  it('the shadow rules stay frozen on every offered line (ADR 0003)', () => {
    expect(SHADOW_RULES.mainLineOnly).toBe(false);
    const d = generateCandidates(input({ model: modelFrom(FAR) }), SHADOW_RULES);
    expect(d.candidates.some((c) => c.rejectReasons.includes('NOT_MAIN_LINE'))).toBe(false);
    // the main line is still recorded, for measuring later
    expect(d.mainLines.ASIAN_HANDICAP.line).toBe(-1.25);
  });

  it('no reliable EV: the main line is not picked, and the text claims no value', () => {
    // margin <= 0: 33%, 1 goal: 24%, 2+: 43% -> fair 0.484 vs 0.468: edge +1.6 and EV below 2%
    const thin = modelFrom(matrix({ '0-0': 0.18, '1-1': 0.15, '1-0': 0.24, '2-0': 0.25, '3-0': 0.18 }));
    const d = generateCandidates(input({ model: thin }));
    const main = d.candidates.find((c) => c.selection === 'HOME' && c.line === -1.25)!;
    expect(main.ev!).toBeLessThan(DEFAULT_RULES.minEv);
    expect(main.rejectReasons).toEqual(expect.arrayContaining(['EDGE_BELOW_MIN', 'EV_BELOW_MIN']));
    expect(d.pick).toBeNull();
    const fog = buildReason({ kind: 'NO_CLEAR_SIGNAL', round: 'EARLY', home: 'Liverpool', away: 'Villarreal', rejectReasons: d.summary.rejectReasons });
    expect(fog).not.toMatch(/value|คุ้มค่า(?!เชิงสถิติไม่พอ)|กำไร/i);
  });

  it('the published reason says the pick is on the main line', () => {
    const d = generateCandidates(input());
    const text = buildReason({
      kind: 'SIGNAL',
      round: 'EARLY',
      home: 'Liverpool',
      away: 'Villarreal',
      pick: { label: 'Liverpool -1.25', modelProbability: d.pick!.modelProbability!, marketProbability: d.pick!.marketProbability, odds: d.pick!.odds, nBookmakers: d.pick!.nBookmakers, strength: d.pick!.strength, agreement: null, gateZ: 2.5, modelSource: 'DC', onMainLine: d.pick!.onMainLine },
    });
    expect(text).toContain('✓ เส้นหลักของตลาด · อ้างอิงราคาจาก 6 เจ้า (ราคากลาง');
    expect(text).not.toMatch(/value|กำไร|ฟันธง/i);
  });
});

describe('Liverpool -1.25 settles as half -1 and half -1.5', () => {
  const home = { market: 'ASIAN_HANDICAP' as const, selection: 'HOME' as const, line: -1.25 };
  const away = { market: 'ASIAN_HANDICAP' as const, selection: 'AWAY' as const, line: 1.25 };

  it('a 2-0 win is a full win', () => {
    expect(settle(home, 2, 0)).toBe('WIN');
    expect(settle(home, 3, 1)).toBe('WIN');
    expect(settle(away, 2, 0)).toBe('LOSS');
  });

  it('a one-goal win is a half loss', () => {
    expect(settle(home, 1, 0)).toBe('HALF_LOSS');
    expect(settle(home, 3, 2)).toBe('HALF_LOSS');
    expect(settle(away, 1, 0)).toBe('HALF_WIN');
  });

  it('a draw or a defeat is a full loss', () => {
    expect(settle(home, 1, 1)).toBe('LOSS');
    expect(settle(home, 0, 1)).toBe('LOSS');
    expect(settle(away, 0, 0)).toBe('WIN');
  });

  it('the model chance counts every goal difference, half of it at -1 and half at -1.5', () => {
    const d = distributionFor(WIDE, home);
    // margin 2+ = 46% win, margin 1 = 24% half loss, margin <= 0 = 30% loss
    expect(d.win).toBeCloseTo(0.46, 10);
    expect(d.halfLoss).toBeCloseTo(0.24, 10);
    expect(d.loss).toBeCloseTo(0.3, 10);
    expect(d.halfWin + d.push).toBe(0);
    // fair chance: a half loss weighs half, exactly what splitting the stake over -1 and -1.5 gives
    const atMinus1 = distributionFor(WIDE, { ...home, line: -1 });
    const atMinus15 = distributionFor(WIDE, { ...home, line: -1.5 });
    const ev = (x: typeof d, o: number) => x.win * (o - 1) + (x.halfWin * (o - 1)) / 2 - x.halfLoss / 2 - x.loss;
    const evSplit = (atMinus1.win * 1.045 - atMinus1.loss + atMinus15.win * 1.045 - atMinus15.loss) / 2;
    expect(ev(d, 2.045)).toBeCloseTo(evSplit, 10);
  });

  it('the most likely score and the pick can differ, for a reason in the distribution and the price', () => {
    const d = generateCandidates(input());
    // the model's single most likely score is 1-0, a half loss for Liverpool -1.25 ...
    const top = WIDE.flatMap((row, h) => row.map((p, a) => ({ h, a, p }))).sort((x, y) => y.p - x.p)[0]!;
    expect(`${top.h}-${top.a}`).toBe('1-0');
    expect(settle(home, top.h, top.a)).toBe('HALF_LOSS');
    // ... yet the pick is Liverpool -1.25: 46% of the matrix is a 2+ goal win, priced by the market at 46.8% fair
    expect(label(d.pick)).toBe('HOME -1.25');
    expect(d.pick!.distribution!.win).toBeCloseTo(0.46, 10);
    expect(d.pick!.marketProbability).toBeCloseTo(noVig([2.045, 1.805])[0]!, 2);
    expect(d.pick!.ev!).toBeGreaterThan(DEFAULT_RULES.minEv);
  });
});

describe('what the site reads is what the engine used', () => {
  it('readMainLines returns the stored main lines unchanged and drops anything malformed', () => {
    const d = generateCandidates(input());
    // the candidates job stores Object.values(d.mainLines) (plus the judged sides) in analysis_runs.summary
    const stored = JSON.parse(JSON.stringify({ mainLines: Object.values(d.mainLines).map((m) => ({ ...m, sides: [] })) }));
    const read = readMainLines(stored);
    expect(read.ASIAN_HANDICAP).toMatchObject({ status: 'OK', line: d.mainLines.ASIAN_HANDICAP.line, nBookmakers: 6, odds: d.mainLines.ASIAN_HANDICAP.odds, updatedAt: AT.toISOString() });
    expect(read.ASIAN_HANDICAP!.line).toBe(d.pick!.line);
    expect(read.OVER_UNDER).toMatchObject({ status: 'NO_QUOTES' });
    expect(readMainLines(null)).toEqual({});
    expect(readMainLines({ mainLines: [{ market: 'ASIAN_HANDICAP', status: 'OK', line: 'x' }] })).toEqual({});
  });
});
