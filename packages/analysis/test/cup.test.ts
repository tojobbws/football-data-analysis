import { describe, expect, it } from 'vitest';
import {
  buildTies,
  goalDiffPmf,
  parseRound,
  priceSelection,
  qualificationProbability,
  resolveTie,
  ruleFor,
  scoreMatrix,
  stageLabelTh,
  type CompetitionRule,
  type LegInput,
  type TieFixture,
} from '../src/index.js';

const rule = (over: Partial<CompetitionRule> = {}): CompetitionRule => ({
  leagueId: 2, fromSeason: 2021, stage: 'ROUND_OF_16', legs: 2, awayGoals: false, extraTime: true, penalties: true, neutralVenue: false, ...over,
});
const RULES: CompetitionRule[] = [
  rule(),
  rule({ stage: 'QUARTER_FINAL' }),
  rule({ stage: 'FINAL', legs: 1, neutralVenue: true }),
  rule({ stage: 'LEAGUE_PHASE', legs: 1 }),
  rule({ stage: 'ROUND_OF_16', fromSeason: 2030, penalties: false }), // a later change of the rules
];

describe('parseRound', () => {
  it.each([
    ['1st Qualifying Round', 'QUALIFYING_1', null],
    ['3rd Qualifying Round', 'QUALIFYING_3', null],
    ['Preliminary Round', 'PRELIMINARY', null],
    ['Play-offs', 'PLAYOFF', null],
    ['Playoff round', 'PLAYOFF', null],
    ['Play-offs A/B', 'PLAYOFF', null],
    ['Knockout Round Play-offs', 'KNOCKOUT_PLAYOFF', null],
    ['Round of 32', 'ROUND_OF_32', null],
    ['Round of 16', 'ROUND_OF_16', null],
    ['Quarter-finals', 'QUARTER_FINAL', null],
    ['Semi-finals', 'SEMI_FINAL', null],
    ['Final', 'FINAL', null],
    ['League Stage - 3', 'LEAGUE_PHASE', 3],
    ['League A - 5', 'LEAGUE_PHASE', 5],
    ['Group C - 6', 'GROUP', 6],
    ['Regular Season - 12', 'REGULAR_SEASON', 12],
    ['Something New', 'OTHER', null],
    ['', 'OTHER', null],
  ])('%s -> %s', (round, stage, matchday) => {
    expect(parseRound(round)).toEqual({ stage, matchday });
  });

  it('does not mistake the qualifying play-offs for the knockout play-offs', () => {
    expect(parseRound('Play-offs').stage).not.toBe(parseRound('Knockout Round Play-offs').stage);
  });

  it('labels in Thai and falls back to the provider text', () => {
    expect(stageLabelTh('Round of 16')).toBe('รอบ 16 ทีม');
    expect(stageLabelTh('League Stage - 3')).toBe('ลีกเฟส นัดที่ 3');
    expect(stageLabelTh('2nd Qualifying Round')).toBe('รอบคัดเลือกรอบที่ 2');
    expect(stageLabelTh('Mystery Cup Round')).toBe('Mystery Cup Round');
  });
});

describe('ruleFor', () => {
  it('uses the latest rule not after the season, and none for an unknown competition', () => {
    expect(ruleFor(RULES, 2, 2025, 'ROUND_OF_16')!.penalties).toBe(true);
    expect(ruleFor(RULES, 2, 2031, 'ROUND_OF_16')!.penalties).toBe(false);
    expect(ruleFor(RULES, 2, 2020, 'ROUND_OF_16')).toBeNull();
    expect(ruleFor(RULES, 999, 2025, 'ROUND_OF_16')).toBeNull();
    expect(ruleFor(RULES, 2, 2025, 'SEMI_FINAL')).toBeNull();
  });
});

let id = 0;
const fx = (round: string, homeId: number, awayId: number, day: number, status = 'NS', ft: [number, number] | null = null, extra: Partial<TieFixture> = {}): TieFixture => ({
  id: ++id, leagueId: 2, season: 2026, round, kickoffAt: new Date(Date.UTC(2027, 2, day)), homeId, awayId, status, ft, et: null, pen: null, ...extra,
});

describe('buildTies', () => {
  it('pairs the two legs whichever way round, sorts them, and sums the 90-minute aggregate by team', () => {
    const second = fx('Round of 16', 20, 10, 17, 'FT', [1, 1]); // listed before the first leg on purpose
    const first = fx('Round of 16', 10, 20, 10, 'FT', [3, 0]);
    const [tie] = buildTies([second, first], RULES);
    expect(tie!.teamA).toBe(10);
    expect(tie!.teamB).toBe(20);
    expect(tie!.legs.map((l) => l.id)).toEqual([first.id, second.id]);
    expect(tie!.aggregate).toEqual({ a: 4, b: 1 });
    expect(tie!.status).toBe('COMPLETE');
  });

  it('knows which leg is next and when the second leg is not scheduled yet', () => {
    expect(buildTies([fx('Round of 16', 1, 2, 10), fx('Round of 16', 2, 1, 17)], RULES)[0]!.status).toBe('FIRST_LEG_NEXT');
    expect(buildTies([fx('Round of 16', 3, 4, 10, 'FT', [0, 0]), fx('Round of 16', 4, 3, 17)], RULES)[0]!.status).toBe('SECOND_LEG_NEXT');
    expect(buildTies([fx('Round of 16', 5, 6, 10, 'FT', [2, 1])], RULES)[0]!.status).toBe('SECOND_LEG_NOT_SCHEDULED');
    expect(buildTies([fx('Round of 16', 7, 8, 10, 'FT', [2, 1]), fx('Round of 16', 8, 7, 17, '2H')], RULES)[0]!.status).toBe('IN_PROGRESS');
  });

  it('keeps ties of different stages, seasons and competitions apart, and ignores single-match stages', () => {
    const ties = buildTies(
      [
        fx('Round of 16', 1, 2, 10), fx('Round of 16', 2, 1, 17),
        fx('Quarter-finals', 1, 2, 24), fx('Quarter-finals', 2, 1, 31),
        fx('Final', 1, 2, 31), fx('League Stage - 1', 1, 2, 1),
        fx('Round of 16', 1, 2, 11, 'NS', null, { season: 2025 }),
        fx('Round of 16', 1, 2, 12, 'NS', null, { leagueId: 3 }),
        fx('Mystery Round', 1, 2, 5),
      ],
      RULES,
    );
    expect(ties.map((t) => `${t.leagueId}/${t.season}/${t.stage}/${t.legs.length}`).sort()).toEqual(['2/2025/ROUND_OF_16/1', '2/2026/QUARTER_FINAL/2', '2/2026/ROUND_OF_16/2']); // the 2025 fixture is its own tie; league 3 has no rule; the final, league phase and unknown round are not ties
  });

  it('a postponed leg is not "in progress"', () => {
    expect(buildTies([fx('Round of 16', 1, 2, 10, 'FT', [1, 0]), fx('Round of 16', 2, 1, 17, 'PST')], RULES)[0]!.status).toBe('SECOND_LEG_NEXT');
  });
});

describe('resolveTie', () => {
  const finished = (extra: Partial<TieFixture> = {}, first: [number, number] = [1, 0], second: [number, number] = [1, 0]) =>
    buildTies([fx('Round of 16', 10, 20, 10, 'FT', first), fx('Round of 16', 20, 10, 17, 'FT', second, extra)], RULES)[0]!;

  it('goes to the better aggregate, away goals do not count', () => {
    // A (10) wins 1-0 at home, loses 1-0 away... level; here A wins 2-0 then loses 1-0 away
    expect(resolveTie(finished({}, [2, 0], [1, 0]))).toEqual({ winner: 10, decidedBy: 'AGGREGATE' });
    expect(resolveTie(finished({}, [0, 1], [0, 0]))).toEqual({ winner: 20, decidedBy: 'AGGREGATE' });
  });

  it('level on aggregate: extra time of the second leg decides, mapped to the right team', () => {
    // 1-0 then 1-0 for the other side: level. Team 10 is away in the second leg and scores 1 in extra time
    expect(resolveTie(finished({ status: 'AET', et: [0, 1] }, [1, 0], [1, 0]))).toEqual({ winner: 10, decidedBy: 'EXTRA_TIME' });
    expect(resolveTie(finished({ status: 'AET', et: [1, 0] }, [1, 0], [1, 0]))).toEqual({ winner: 20, decidedBy: 'EXTRA_TIME' });
  });

  it('still level after extra time: penalties decide', () => {
    expect(resolveTie(finished({ status: 'PEN', et: [0, 0], pen: [4, 5] }, [1, 0], [1, 0]))).toEqual({ winner: 10, decidedBy: 'PENALTIES' });
  });

  it('an unfinished tie has no winner', () => {
    expect(resolveTie(buildTies([fx('Round of 16', 1, 2, 10, 'FT', [1, 0]), fx('Round of 16', 2, 1, 17)], RULES)[0]!)).toEqual({ winner: null, decidedBy: 'UNDECIDED' });
  });
});

const even = scoreMatrix(1.4, 1.4, -0.05);
const leg = (homeId: number, awayId: number, over: Partial<LegInput> = {}): LegInput => ({ homeId, awayId, played: null, matrix: even, ...over });
const R = { awayGoals: false, extraTime: true, penalties: true };

describe('qualificationProbability', () => {
  const q = (legs: [LegInput, LegInput], r = R) => qualificationProbability({ teamA: 1, teamB: 2, legs, rule: r });

  it('two identical teams, nothing played: 50/50 and a proper distribution', () => {
    const r = q([leg(1, 2), leg(2, 1)]);
    if (!r.available) throw new Error('unavailable');
    expect(r.pA).toBeCloseTo(0.5, 6);
    expect(r.pA + r.pB).toBeCloseTo(1, 9);
    expect(r.pExtraTime).toBeGreaterThan(0.1);
    expect(r.pPenalties).toBeGreaterThan(0);
    expect(r.pPenalties).toBeLessThan(r.pExtraTime);
    expect(r.assumptions.join(' ')).toContain('50/50');
  });

  it('a big first-leg win makes the team a heavy favourite; the same score the other way, an underdog', () => {
    const up = q([leg(1, 2, { played: [3, 0], matrix: null }), leg(2, 1)]);
    const down = q([leg(1, 2, { played: [0, 3], matrix: null }), leg(2, 1)]);
    if (!up.available || !down.available) throw new Error('unavailable');
    expect(up.pA).toBeGreaterThan(0.9);
    expect(down.pA).toBeLessThan(0.1);
    expect(up.pA).toBeCloseTo(down.pB, 9);
  });

  it('reads the second leg from the right side: when team A is away, a strong home side hurts it', () => {
    const homeStrong = scoreMatrix(2.4, 0.7, -0.05);
    const homeWeak = scoreMatrix(0.7, 2.4, -0.05);
    const a = q([leg(1, 2, { played: [0, 0], matrix: null }), leg(2, 1, { matrix: homeStrong })]);
    const b = q([leg(1, 2, { played: [0, 0], matrix: null }), leg(2, 1, { matrix: homeWeak })]);
    if (!a.available || !b.available) throw new Error('unavailable');
    expect(a.pA).toBeLessThan(0.3);
    expect(b.pA).toBeGreaterThan(0.7);
  });

  it('is not the 90-minute win chance of the match being played', () => {
    // A lost the first leg 0-2 at home; second leg at B: A winning 90 minutes is far likelier than going through
    const second = leg(2, 1, { matrix: scoreMatrix(1.2, 1.5, -0.05) });
    const r = q([leg(1, 2, { played: [0, 2], matrix: null }), second]);
    if (!r.available) throw new Error('unavailable');
    const win90 = priceSelection(second.matrix as number[][], { market: 'MATCH_WINNER', selection: 'AWAY' }).probability;
    expect(win90).toBeGreaterThan(0.3);
    expect(r.pA).toBeLessThan(win90 - 0.1);
  });

  it('level-on-aggregate chance equals the direct sum over the two matrices', () => {
    const m1 = scoreMatrix(1.5, 1.0, -0.05);
    const m2 = scoreMatrix(1.1, 1.3, -0.05);
    const r = q([leg(1, 2, { matrix: m1 }), leg(2, 1, { matrix: m2 })]);
    if (!r.available) throw new Error('unavailable');
    let level = 0;
    for (let h1 = 0; h1 < m1.length; h1++)
      for (let a1 = 0; a1 < m1.length; a1++)
        for (let h2 = 0; h2 < m2.length; h2++)
          for (let a2 = 0; a2 < m2.length; a2++) if (h1 + a2 === a1 + h2) level += m1[h1]![a1]! * m2[h2]![a2]!;
    expect(r.pExtraTime).toBeCloseTo(level, 9);
  });

  it('only penalties, or only extra time, change what is priced', () => {
    const both = q([leg(1, 2), leg(2, 1)]);
    const pensOnly = q([leg(1, 2), leg(2, 1)], { awayGoals: false, extraTime: false, penalties: true });
    if (!both.available || !pensOnly.available) throw new Error('unavailable');
    expect(pensOnly.pExtraTime).toBe(0);
    expect(pensOnly.pPenalties).toBeGreaterThan(both.pPenalties);
    expect(pensOnly.pA).toBeCloseTo(0.5, 6);
  });

  it('says why it cannot price instead of inventing a number', () => {
    expect(q([leg(1, 2), leg(2, 1)], { ...R, awayGoals: true })).toEqual({ available: false, reason: 'AWAY_GOALS_NOT_MODELLED' });
    expect(q([leg(1, 2), leg(2, 1)], { awayGoals: false, extraTime: false, penalties: false })).toEqual({ available: false, reason: 'NO_TIEBREAK_RULE' });
    expect(q([leg(1, 2, { matrix: null }), leg(2, 1)])).toEqual({ available: false, reason: 'MATRIX_MISSING' });
    expect(q([leg(1, 2, { played: [1, 0], matrix: null }), leg(2, 1, { matrix: null })])).toEqual({ available: false, reason: 'MATRIX_MISSING' });
    expect(q([leg(1, 2, { played: [1, 0], matrix: null }), leg(2, 1, { played: [1, 1], matrix: null })])).toEqual({ available: false, reason: 'TIE_FINISHED' });
    expect(q([leg(1, 2), leg(1, 2)])).toEqual({ available: false, reason: 'LEG_TEAMS_MISMATCH' });
    expect(q([leg(1, 3), leg(3, 1)])).toEqual({ available: false, reason: 'LEG_TEAMS_MISMATCH' });
  });

  it('goalDiffPmf sums to 1', () => {
    expect([...goalDiffPmf(even).values()].reduce((s, p) => s + p, 0)).toBeCloseTo(1, 9);
  });
});
