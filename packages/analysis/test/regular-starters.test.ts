import { describe, expect, it } from 'vitest';
import { isRegularStarter, regularStarters, type StartersLineup } from '../src/index.js';

const day = (d: number) => new Date(Date.UTC(2026, 10, d, 15));
/** a lineup of players `ids` (plus fillers 900+ to reach 11 when asked) */
const lineup = (fixtureId: number, d: number, ids: number[], leagueId = 39, season = 2026): StartersLineup => ({
  fixtureId,
  kickoffAt: day(d),
  leagueId,
  season,
  starters: ids.map((id) => ({ playerId: id, name: `P${id}` })),
});
const xi = (...base: number[]) => [...base, ...Array.from({ length: 11 - base.length }, (_, i) => 900 + i)];
const league = { leagueId: 39, season: 2026, kind: 'LEAGUE' as const };

describe('regular starters', () => {
  it('counts starts over the last 5 stored lineups only, newest first, most starts first', () => {
    const history = [
      lineup(1, 1, xi(1, 2)), // the sixth lineup back: outside the window
      lineup(2, 4, xi(1, 3)),
      lineup(3, 8, xi(1, 3)),
      lineup(4, 11, xi(1, 3)),
      lineup(5, 15, xi(1, 4)),
      lineup(6, 18, xi(1, 4)),
    ];
    const r = regularStarters(history, league);
    expect(r.of).toBe(5);
    expect(r.from).toEqual(day(4));
    expect(r.to).toEqual(day(18));
    expect(r.previousCupRound).toBeNull();
    const by = new Map(r.players.map((p) => [p.playerId, p]));
    expect(by.get(1)).toMatchObject({ starts: 5, startedPreviousCupRound: null, lastStartAt: day(18) });
    expect(by.get(3)!.starts).toBe(3);
    expect(by.get(4)!.starts).toBe(2);
    expect(by.has(2)).toBe(false); // only started outside the window
    expect(r.players[0]!.playerId).toBe(1); // fillers started all 5 too; ties break by recency, then name (P1 before P900)
    expect(r.players.slice(0, 10).every((p) => p.starts === 5)).toBe(true);
  });

  it('leaves out lineups with fewer than 11 starters (as the measurement did)', () => {
    const r = regularStarters([lineup(1, 1, xi(1)), lineup(2, 2, [1, 2, 3])], league);
    expect(r.of).toBe(1);
    expect(r.players.find((p) => p.playerId === 2)).toBeUndefined();
  });

  it('a domestic cup also marks who started the previous round of the same cup this season', () => {
    const history = [
      lineup(10, 1, xi(20, 21), 48, 2025), // last season's round of the same cup: not this one
      lineup(11, 3, xi(30, 31), 48), // this season's previous round
      lineup(12, 6, xi(1, 2)),
      lineup(13, 9, xi(1, 2)),
    ];
    const r = regularStarters(history, { leagueId: 48, season: 2026, kind: 'DOMESTIC_CUP' });
    expect(r.previousCupRound).toEqual({ fixtureId: 11, kickoffAt: day(3) });
    const by = new Map(r.players.map((p) => [p.playerId, p]));
    expect(by.get(30)).toMatchObject({ starts: 1, startedPreviousCupRound: true });
    expect(by.get(1)).toMatchObject({ starts: 2, startedPreviousCupRound: false });
    expect(by.get(20)).toMatchObject({ starts: 1, startedPreviousCupRound: false }); // last season's round of the cup does not count
  });

  it('a previous cup round outside the window still lists its starters, with no starts counted', () => {
    const history = [lineup(1, 1, xi(30), 48), ...[2, 3, 4, 5, 6].map((d) => lineup(10 + d, d, xi(1)))];
    const r = regularStarters(history, { leagueId: 48, season: 2026, kind: 'DOMESTIC_CUP' });
    expect(r.of).toBe(5);
    expect(r.players.find((p) => p.playerId === 30)).toMatchObject({ starts: 0, startedPreviousCupRound: true, lastStartAt: null });
  });

  it('no previous round: a domestic cup falls back to the last 5 alone', () => {
    const r = regularStarters([lineup(1, 1, xi(1))], { leagueId: 48, season: 2026, kind: 'DOMESTIC_CUP' });
    expect(r.previousCupRound).toBeNull();
    expect(r.players[0]!.startedPreviousCupRound).toBeNull();
  });

  it('no lineups: nothing to say', () => {
    expect(regularStarters([], league)).toEqual({ of: 0, from: null, to: null, previousCupRound: null, players: [] });
  });

  it('a regular starter started at least 80% of at least 3 lineups', () => {
    expect(isRegularStarter({ starts: 4 }, 5)).toBe(true);
    expect(isRegularStarter({ starts: 3 }, 5)).toBe(false);
    expect(isRegularStarter({ starts: 3 }, 3)).toBe(true);
    expect(isRegularStarter({ starts: 2 }, 2)).toBe(false); // too few lineups to say
  });
});
