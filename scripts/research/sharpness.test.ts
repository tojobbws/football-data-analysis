/**
 * The research harness of docs/research/underdog-bias-*.md: probabilities stay valid, both sides of a line are
 * complements, the model and the market are scored on the same line and the same matches, no fit sees a
 * result from after its cut, the holdout never reaches the selection, runs repeat exactly, and building the
 * candidates never touches the production settings.
 */
import { describe, expect, it } from 'vitest';
import { fairTarget, priceSelection, scoreMatrix, settle } from '@fp/analysis';
import {
  buildConfigs,
  calibrationSlope,
  combinedConfig,
  ece,
  holdoutCutoff,
  rng,
  scoreRow,
  selectCandidate,
  sharpnessVsMarket,
  splitAt,
  underdogSide,
  walkForward,
  type Config,
  type FixtureMatch,
  type Quote,
  type Row,
} from './sharpness.js';

/** Two seasons of a 10-team league, every pair home and away each season, scores drawn from fixed strengths. */
function league(seed = 7): FixtureMatch[] {
  const r = rng(seed);
  const strength = Array.from({ length: 10 }, (_, i) => 0.6 + i * 0.1);
  const pois = (rate: number) => {
    let k = 0;
    let p = Math.exp(-rate);
    let s = p;
    const u = r();
    while (u > s && k < 10) {
      k++;
      p *= rate / k;
      s += p;
    }
    return k;
  };
  const out: FixtureMatch[] = [];
  let id = 1;
  const start = Date.UTC(2024, 7, 1);
  for (let season = 0; season < 2; season++)
    for (let round = 0; round < 18; round++)
      for (let h = 0; h < 10; h++) {
        const a = (h + 1 + (round % 9)) % 10;
        if (a === h || (round >= 9) === h < a) continue;
        out.push({
          fixtureId: id++,
          homeTeamId: h + 1,
          awayTeamId: a + 1,
          homeGoals: pois(1.4 * strength[h]! / strength[a]!),
          awayGoals: pois(1.1 * strength[a]! / strength[h]!),
          kickoffAt: new Date(start + (season * 300 + round * 7) * 86_400_000 + h * 3_600_000),
        });
      }
  return out;
}

const quote: Quote = { x12: [2.1, 3.4, 3.6], ah: { line: -0.25, home: 1.95, away: 1.95 }, ou25: { over: 1.9, under: 2.0 } };
const quotesFor = (ms: readonly FixtureMatch[]) => new Map(ms.map((m) => [m.fixtureId, { early: quote, close: quote }]));
const configs: Config[] = [
  { id: 'A', family: 'M0', label: 'a', dc: () => ({ priorStrength: 8, halfLifeDays: 365, xgWeight: 0 }) },
  { id: 'B', family: 'M1', label: 'b', dc: () => ({ priorStrength: 1, halfLifeDays: 365, xgWeight: 0 }) },
];
const run = (ms: readonly FixtureMatch[], cfgs = configs) =>
  walkForward({ leagueId: 1, matches: ms, quotes: quotesFor(ms), configs: cfgs, from: new Date(Date.UTC(2025, 4, 1)), refitDays: 7, leadDays: 3 });

describe('probabilities', () => {
  const mx = scoreMatrix(1.7, 0.9, -0.05);
  it('stay in [0, 1] and both sides of every AH and O/U line sum to 1, quarter lines included', () => {
    for (const h of [-2, -1.75, -1.25, -0.75, -0.25, 0, 0.25, 0.5, 1, 1.5]) {
      const home = priceSelection(mx, { market: 'ASIAN_HANDICAP', selection: 'HOME', line: h }).probability;
      const away = priceSelection(mx, { market: 'ASIAN_HANDICAP', selection: 'AWAY', line: h === 0 ? 0 : -h }).probability;
      expect(home).toBeGreaterThanOrEqual(0);
      expect(home).toBeLessThanOrEqual(1);
      expect(home + away).toBeCloseTo(1, 10);
    }
    for (const l of [1.5, 2.25, 2.5, 3]) {
      const over = priceSelection(mx, { market: 'OVER_UNDER', selection: 'OVER', line: l }).probability;
      const under = priceSelection(mx, { market: 'OVER_UNDER', selection: 'UNDER', line: l }).probability;
      expect(over + under).toBeCloseTo(1, 10);
    }
  });

  it('settles quarter lines and pushes as the system does (half results weigh ½, a push is left out)', () => {
    expect(settle({ market: 'ASIAN_HANDICAP', selection: 'HOME', line: -0.25 }, 1, 1)).toBe('HALF_LOSS');
    expect(settle({ market: 'ASIAN_HANDICAP', selection: 'AWAY', line: 0.25 }, 1, 1)).toBe('HALF_WIN');
    expect(settle({ market: 'ASIAN_HANDICAP', selection: 'HOME', line: -1 }, 2, 1)).toBe('PUSH');
    expect(settle({ market: 'ASIAN_HANDICAP', selection: 'HOME', line: -1.25 }, 2, 1)).toBe('HALF_LOSS');
    expect(fairTarget('HALF_LOSS')).toEqual({ weight: 0.5, y: 0 });
    expect(fairTarget('PUSH')).toBeNull();
  });
});

describe('scoreRow', () => {
  const mx = scoreMatrix(1.5, 1.0, 0);
  const base = { config: 'A', fixtureId: 1, leagueId: 1, phase: 'early' as const, day: '2025-01-01', kickoffAt: new Date(), minTeamMatches: 20 };
  it('prices the model on the market’s own AH line', () => {
    const row = scoreRow(base, mx, { ah: { line: -0.75, home: 2.0, away: 1.9 } }, { home: 2, away: 0 });
    expect(row.ah!.line).toBe(-0.75);
    expect(row.ah!.p).toBeCloseTo(priceSelection(mx, { market: 'ASIAN_HANDICAP', selection: 'HOME', line: -0.75 }).probability, 12);
    expect(row.ah!.q).toBeCloseTo((1 / 2.0) / (1 / 2.0 + 1 / 1.9), 12);
  });
  it('leaves a push out of the AH score', () => {
    expect(scoreRow(base, mx, { ah: { line: -1, home: 2.0, away: 1.9 } }, { home: 2, away: 1 }).ah).toBeUndefined();
  });
  it('turns the HOME side into the underdog side by complement', () => {
    const row: Row = { ...base, ah: { line: -0.5, p: 0.55, q: 0.5, y: 1, w: 1 } };
    expect(underdogSide(row)).toEqual({ p: 0.44999999999999996, q: 0.5, y: 0, w: 1 });
    expect(underdogSide({ ...base, ah: { line: 0.5, p: 0.55, q: 0.5, y: 1, w: 1 } })).toEqual({ p: 0.55, q: 0.5, y: 1, w: 1 });
    // AH 0: the side the market's 1X2 rates lower, none when there is no 1X2
    expect(underdogSide({ ...base, ah: { line: 0, p: 0.6, q: 0.5, y: 1, w: 1 } })).toBeNull();
    expect(underdogSide({ ...base, x12: { p: [0.5, 0.3, 0.2], q: [0.45, 0.3, 0.25], o: 0 }, ah: { line: 0, p: 0.6, q: 0.5, y: 1, w: 1 } })!.p).toBeCloseTo(0.4, 12);
  });
});

describe('walkForward', () => {
  const ms = league();
  it('scores the same matches for every config', () => {
    const rows = run(ms);
    const keys = (id: string) => rows.filter((r) => r.config === id).map((r) => `${r.fixtureId}|${r.phase}|${Boolean(r.ah)}|${Boolean(r.ou)}`).sort();
    expect(keys('A').length).toBeGreaterThan(50);
    expect(keys('B')).toEqual(keys('A'));
  });

  it('never uses a result from after kickoff − leadDays', () => {
    const rows = run(ms).filter((r) => r.config === 'A');
    const target = rows.at(-1)!;
    const kickoff = target.kickoffAt.getTime();
    // a match inside the 3-day lead window, and the target itself: rewriting their scores changes nothing
    const changed = ms.map((m) => (m.kickoffAt.getTime() > kickoff - 3 * 86_400_000 ? { ...m, homeGoals: 9, awayGoals: 0 } : m));
    const after = run(changed).filter((r) => r.config === 'A' && r.fixtureId === target.fixtureId && r.phase === target.phase)[0]!;
    expect(after.x12!.p).toEqual(target.x12!.p);
    // a result well before the cut does change the prediction (the test can tell)
    const early = ms.map((m, i) => (i === 100 ? { ...m, homeGoals: 9, awayGoals: 0 } : m));
    const moved = run(early).filter((r) => r.config === 'A' && r.fixtureId === target.fixtureId && r.phase === target.phase)[0]!;
    expect(moved.x12!.p).not.toEqual(target.x12!.p);
  });

  it('repeats exactly on the same data and settings', () => {
    expect(run(ms)).toEqual(run(ms));
  });
});

describe('holdout and selection', () => {
  it('keeps every holdout day out of the development rows', () => {
    const rows = run(league()).filter((r) => r.config === 'A');
    const cutoff = holdoutCutoff(rows.map((r) => r.day), 0.2);
    const { dev, holdout } = splitAt(rows, cutoff);
    expect(dev.length + holdout.length).toBe(rows.length);
    expect(dev.every((r) => r.day < cutoff)).toBe(true);
    expect(holdout.every((r) => r.day >= cutoff)).toBe(true);
    expect(holdout.length).toBeGreaterThan(0);
  });

  it('chooses nothing when no candidate beats the control after Holm', () => {
    const rows = run(league());
    const { dev } = splitAt(rows, holdoutCutoff(rows.map((r) => r.day), 0.2));
    const same = selectCandidate(dev, 'A', ['A'], { primary: 'ah_brier', guard: 'x12_logloss', phase: 'early' });
    expect(same.chosen).toBeNull();
    expect(same.results[0]!.primary.diff.mean).toBe(0);
  });

  it('chooses a candidate that is clearly better on every match and no worse on the guard', () => {
    const day = (i: number) => `2025-01-${String(1 + (i % 28)).padStart(2, '0')}`;
    const mk = (config: string, p: number, i: number): Row => ({
      config, fixtureId: i, leagueId: 1, phase: 'early', day: day(i), kickoffAt: new Date(), minTeamMatches: 20,
      x12: { p: [0.45, 0.3, 0.25], q: [0.45, 0.3, 0.25], o: 0 },
      ah: { line: -0.5, p, q: 0.5, y: 1, w: 1 },
    });
    const dev = Array.from({ length: 300 }, (_, i) => [mk('C', 0.5, i), mk('good', 0.6 + (i % 3) * 0.01, i), mk('bad', 0.4, i)]).flat();
    const s = selectCandidate(dev, 'C', ['good', 'bad'], { primary: 'ah_brier', guard: 'x12_logloss', phase: 'early' });
    expect(s.chosen).toBe('good');
    expect(s.results.find((r) => r.id === 'bad')!.passes).toBe(false);
  });
});

describe('configs', () => {
  it('M0 is the production setting per league; candidates change one setting and never write production', () => {
    const prod = new Map([[39, Object.freeze({ priorStrength: 3, halfLifeDays: 730, xgWeight: 0.5 })]]);
    const fallback = Object.freeze({ priorStrength: 8, halfLifeDays: 365, xgWeight: 0.5, redCardDiscount: 0 });
    const cfgs = buildConfigs(prod, fallback);
    const by = (id: string) => cfgs.find((c) => c.id === id)!;
    expect(by('M0').dc(39)).toEqual(prod.get(39));
    expect(by('M0').dc(999)).toEqual(fallback);
    expect(by('M1-prior1').dc(39)).toEqual({ priorStrength: 1, halfLifeDays: 730, xgWeight: 0.5 });
    expect(by('M2-hl240').dc(39)).toEqual({ priorStrength: 3, halfLifeDays: 240, xgWeight: 0.5 });
    expect(combinedConfig(prod, fallback, { priorStrength: 1, halfLifeDays: 240 }).dc(39)).toEqual({ priorStrength: 1, halfLifeDays: 240, xgWeight: 0.5 });
    // frozen inputs: any write would have thrown
    expect(prod.get(39)).toEqual({ priorStrength: 3, halfLifeDays: 730, xgWeight: 0.5 });
  });
});

describe('calibration measures', () => {
  const r = rng(1);
  const pts = Array.from({ length: 20000 }, () => {
    const p = 0.05 + 0.9 * r();
    return { cluster: 'd', p, q: p, y: r() < p ? 1 : 0 };
  });
  it('a calibrated forecast has slope ≈ 1; one squeezed toward 50% has slope > 1', () => {
    expect(calibrationSlope(pts)!).toBeCloseTo(1, 1);
    const flat = pts.map((x) => ({ ...x, p: 0.5 + (x.p - 0.5) * 0.6 }));
    expect(calibrationSlope(flat)!).toBeGreaterThan(1.4);
  });
  it('a forecast equal to the market has relative sharpness 1, a flatter one below 1', () => {
    expect(sharpnessVsMarket(pts)!).toBeCloseTo(1, 10);
    expect(sharpnessVsMarket(pts.map((x) => ({ ...x, p: 0.5 + (x.p - 0.5) * 0.6 })))!).toBeLessThan(0.8);
  });
  it('ECE is small for a calibrated forecast', () => {
    expect(ece(pts).ece!).toBeLessThan(0.02);
  });
});
