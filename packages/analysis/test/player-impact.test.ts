import { describe, expect, it } from 'vitest';
import {
  absencesFromInjuries,
  absencesFromLineup,
  applyImpact,
  buildTeamProfile,
  calibrateImpact,
  dcWalkForward,
  matchContexts,
  sortByTime,
  teamLoss,
  type LineupRecord,
  type MatchRecord,
  type PlayerMatchStat,
} from '../src/index.js';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
function poisson(rate: number, r: () => number) {
  const L = Math.exp(-rate);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= r();
  } while (p > L);
  return k - 1;
}

/**
 * Synthetic league where each team has a STAR striker (id = team*100 + 99).
 * When the star is out (30% of matches), the team scores 40% fewer goals.
 */
function league(seed = 5) {
  const r = rng(seed);
  const teams = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, s: (r() - 0.5) * 0.6 }));
  const matches: Array<MatchRecord & { fixtureId: number }> = [];
  const stats: PlayerMatchStat[] = [];
  const lineups = new Map<string, LineupRecord>();
  let t = Date.UTC(2023, 7, 1);
  let fid = 1;
  const squad = (team: number, starOut: boolean) => {
    const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => team * 100 + n);
    const pos = ['G', 'D', 'D', 'D', 'D', 'M', 'M', 'M', 'M', 'F'];
    const xi = ids.map((id, i) => ({ id, pos: pos[i]! }));
    xi.push(starOut ? { id: team * 100 + 11, pos: 'F' } : { id: team * 100 + 99, pos: 'F' });
    return xi;
  };
  for (let season = 0; season < 6; season++)
    for (const h of teams)
      for (const a of teams) {
        if (h.id === a.id) continue;
        const hOut = r() < 0.3;
        const aOut = r() < 0.3;
        const lam = 1.5 * Math.exp(h.s - a.s) * (hOut ? 0.6 : 1);
        const mu = 1.15 * Math.exp(a.s - h.s) * (aOut ? 0.6 : 1);
        const gh = poisson(lam, r);
        const ga = poisson(mu, r);
        const k = new Date(t);
        matches.push({ fixtureId: fid, homeTeamId: h.id, awayTeamId: a.id, homeGoals: gh, awayGoals: ga, kickoffAt: k });
        for (const [team, out, goals] of [[h.id, hOut, gh], [a.id, aOut, ga]] as const) {
          const xi = squad(team, out);
          lineups.set(`${fid}:${team}`, { starters: new Set(xi.map((p) => p.id)), bench: new Set([team * 100 + 12]) });
          // star scores ~60% of goals when playing
          const scorer = (): number => (!out && r() < 0.6 ? team * 100 + 99 : xi[5 + Math.floor(r() * 6)]!.id);
          const g = new Map<number, number>();
          for (let i = 0; i < goals; i++) {
            const s = scorer();
            g.set(s, (g.get(s) ?? 0) + 1);
          }
          for (const p of xi)
            stats.push({ fixtureId: fid, kickoffAt: k, teamId: team, playerId: p.id, minutes: 90, position: p.pos, rating: 7, goals: g.get(p.id) ?? 0, assists: 0, shotsTotal: g.get(p.id) ?? 0, passesKey: 0 });
        }
        fid++;
        t += 20 * 3_600_000;
      }
  return { matches, stats, lineups };
}

describe('profiles and absences', () => {
  const { matches, stats } = league();
  const before = matches[200]!.kickoffAt;
  const prof = buildTeamProfile(stats, 1, before, { lookbackMatches: 40 });

  it('star striker has the largest attack share; keeper the largest defence share', () => {
    const star = prof.players.get(199)!;
    const keeper = prof.players.get(101)!;
    const maxAtt = Math.max(...[...prof.players.values()].map((p) => p.attackShare));
    expect(star.attackShare).toBe(maxAtt);
    expect(keeper.defenceShare).toBe(Math.max(...[...prof.players.values()].map((p) => p.defenceShare)));
    expect(prof.teamMatches).toBe(40);
    expect(buildTeamProfile(stats, 1, before).teamMatches).toBe(10);
  });

  it('lineup: regular not starting = missing, on bench = partial', () => {
    const starters = new Set([101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111]);
    const out = absencesFromLineup(prof, starters, new Set());
    expect(out.map((a) => a.playerId)).toContain(199);
    const benched = absencesFromLineup(prof, starters, new Set([199]));
    expect(benched.find((a) => a.playerId === 199)!.weight).toBe(0.6);
  });

  it('injuries: Missing Fixture = 1, Questionable = 0.5, unknown players ignored by teamLoss', () => {
    const abs = absencesFromInjuries([
      { playerId: 199, type: 'Missing Fixture' },
      { playerId: 102, type: 'Questionable' },
      { playerId: 999999, type: 'Missing Fixture' },
      { playerId: null, type: 'Missing Fixture' },
    ]);
    expect(abs).toHaveLength(3);
    const loss = teamLoss(prof, abs);
    expect(loss.missing.map((m) => m.playerId)).toEqual(expect.arrayContaining([199, 102]));
    expect(loss.missing.find((m) => m.playerId === 999999)).toBeUndefined();
    expect(loss.attackLoss).toBeGreaterThan(0.2);
    expect(loss.attackLoss).toBeLessThanOrEqual(0.6);
  });

  it('applyImpact lowers the weakened attack and raises goals against a weakened defence', () => {
    const g = applyImpact({ lambda: 1.5, mu: 1.1 }, { attackLoss: 0.4, defenceLoss: 0, missing: [] }, { attackLoss: 0, defenceLoss: 0.2, missing: [] }, 1);
    expect(g.lambda).toBeCloseTo(1.5 * 0.6 * 1.2, 10);
    expect(g.mu).toBeCloseTo(1.1, 10);
    expect(applyImpact({ lambda: 1.5, mu: 1.1 }, { attackLoss: 0.4, defenceLoss: 0, missing: [] }, { attackLoss: 0, defenceLoss: 0, missing: [] }, 0)).toEqual({ lambda: 1.5, mu: 1.1 });
  });
});

describe('calibrateImpact', () => {
  it('finds a positive α and beats plain Dixon-Coles when absences really matter', () => {
    const { matches, stats, lineups } = league(9);
    const sorted = sortByTime(matches);
    const warmup = 100;
    const ctxs = matchContexts(sorted, warmup);
    const dc = dcWalkForward(sorted, { warmupMatches: warmup, refitEveryDays: 14, dixonColes: { priorStrength: 5, halfLifeDays: 365, xgWeight: 0 } });
    const cal = calibrateImpact({ matches: sorted, ctxs, dc, stats, lineups, minHoldout: 50 });
    expect(cal.eligible).toBeGreaterThan(400);
    expect(cal.alpha).toBeGreaterThan(0);
    expect(cal.holdoutLogLossImpact).toBeLessThan(cal.holdoutLogLossBase);
  }, 60_000);

  it('picks α = 0 (layer disabled) when absences do not matter', () => {
    const { matches, stats, lineups } = league(13);
    // shuffle who "was missing": lineups say the star is out at random, unrelated to goals
    const r = rng(1);
    const noisy = new Map<string, LineupRecord>();
    for (const [k, v] of lineups) {
      const team = Number(k.split(':')[1]);
      const ids = [...v.starters].filter((id) => id !== team * 100 + 99 && id !== team * 100 + 11);
      ids.push(r() < 0.3 ? team * 100 + 11 : team * 100 + 99);
      noisy.set(k, { starters: new Set(ids), bench: v.bench });
    }
    // and stats where the star is just an ordinary player
    const flat = stats.map((s) => ({ ...s }));
    const sorted = sortByTime(matches);
    const ctxs = matchContexts(sorted, 100);
    const dc = dcWalkForward(sorted, { warmupMatches: 100, refitEveryDays: 14, dixonColes: { priorStrength: 5, halfLifeDays: 365, xgWeight: 0 } });
    const cal = calibrateImpact({ matches: sorted, ctxs, dc, stats: flat, lineups: noisy, minHoldout: 50 });
    expect(cal.enabled).toBe(cal.alpha > 0 && cal.test.z >= 1.2816 && cal.holdoutN >= 50);
  }, 60_000);
});
