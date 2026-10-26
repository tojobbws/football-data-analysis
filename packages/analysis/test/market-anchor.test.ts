import { describe, expect, it } from 'vitest';
import {
  ahFeatures,
  applyAnchor,
  fitAnchor,
  holm,
  isDead,
  leagueTable,
  logit,
  restOf,
  sigmoid,
  xgLuck,
  type AnchorObservation,
  type MatchRecord,
  type MatchSituation,
} from '../src/index.js';

const day = (d: number) => new Date(Date.UTC(2026, 0, 1) + d * 86_400_000);
const m = (d: number, h: number, a: number, gh: number, ga: number, xh: number | null = null, xa: number | null = null): MatchRecord => ({
  homeTeamId: h,
  awayTeamId: a,
  homeGoals: gh,
  awayGoals: ga,
  kickoffAt: day(d),
  homeXg: xh,
  awayXg: xa,
});

describe('market anchor inputs', () => {
  it('xgLuck averages goals minus xG over the recent matches before kickoff only', () => {
    const ms = [m(1, 1, 2, 3, 0, 1, 1), m(5, 3, 1, 1, 2, 2, 0.5), m(9, 1, 4, 5, 0, 1, 1)];
    const l = xgLuck(ms, 1, day(9));
    expect(l.matches).toBe(2);
    expect(l.scored).toBeCloseTo((3 - 1 + (2 - 0.5)) / 2);
    expect(l.conceded).toBeCloseTo((0 - 1 + (1 - 2)) / 2);
  });

  it('restOf counts days since the previous match and matches in the last 14 days', () => {
    const r = restOf([day(1), day(8), day(12), day(15)].map((d) => d.getTime()), day(15));
    expect(r.days).toBeCloseTo(3);
    expect(r.last14).toBe(3);
    expect(restOf([], day(15)).days).toBe(14);
  });

  it('isDead only late in the season, for a mid-table team out of reach of both zones', () => {
    // 12 teams, 22 rounds: give every team 20 games played with spread-out points
    const table = Array.from({ length: 12 }, (_, i) => ({ teamId: i + 1, points: 60 - i * 5, played: 20, goalDiff: 0 }));
    // 8th: 25 pts, can reach 31 < 6th's 35; 10th (first relegation place) has 15, can reach 21 < 25
    expect(isDead(table, 8)).toBe(true);
    expect(isDead(table, 6)).toBe(false);
    expect(isDead(table, 10)).toBe(false);
    expect(isDead(table.map((r) => ({ ...r, played: 5 })), 8)).toBe(false);
  });

  it('leagueTable ranks by points then goal difference', () => {
    const t = leagueTable([m(1, 1, 2, 2, 0), m(2, 3, 1, 1, 1), m(3, 2, 3, 0, 3)], day(10));
    expect(t.map((r) => r.teamId)).toEqual([3, 1, 2]);
    expect(t[0]!.points).toBe(4);
  });

  it('ahFeatures: quarter lines and the DC gap in logit units', () => {
    const team = { luck: { scored: 0, conceded: 0, matches: 0 }, rest: { days: 7, last14: 2 }, dead: false, seasonPlayed: 10 };
    const s: MatchSituation = { home: team, away: team };
    const x = ahFeatures(s, -0.75, 0.6, 0.5);
    expect(x[0]).toBe(1);
    expect(x[1]).toBeCloseTo(logit(0.6));
    expect(x[7]).toBe(1);
    expect(ahFeatures(s, -1, null, 0.5)[7]).toBe(0);
    expect(ahFeatures(s, -1, null, 0.5)[1]).toBe(0);
  });
});

describe('fitAnchor', () => {
  it('recovers a real effect and leaves the market alone when there is none', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const obs: AnchorObservation[] = [];
    for (let i = 0; i < 6000; i++) {
      const market = 0.35 + 0.3 * rnd();
      const signal = rnd() * 2 - 1;
      const noise = rnd() * 2 - 1;
      const p = sigmoid(logit(market) + 0.4 * signal);
      obs.push({ offset: logit(market), x: [1, signal, noise], y: rnd() < p ? 1 : 0, w: 1 });
    }
    const fit = fitAnchor('ASIAN_HANDICAP', ['BIAS', 'SIGNAL', 'NOISE'], obs, 1);
    expect(fit.beta[1]! / fit.sd[1]!).toBeCloseTo(0.4, 1);
    expect(Math.abs(fit.beta[2]! / fit.se[2]!)).toBeLessThan(3);
    // all-zero layer = the market
    expect(applyAnchor({ beta: [0, 0, 0], mean: fit.mean, sd: fit.sd }, 0.42, [1, 0.5, 0.5])).toBeCloseTo(0.42);
  });

  it('holm keeps only what survives the family correction', () => {
    expect(holm([0.001, 0.03, 0.04])).toEqual([true, false, false]);
    expect(holm([0.001, 0.012, 0.02])).toEqual([true, true, true]);
  });
});
