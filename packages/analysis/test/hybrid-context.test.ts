import { describe, expect, it } from 'vitest';
import { eloBook, eloView, HYBRID_ELO, marketMovement, tableStakes, tieSituation, type StakesTableRow, type Tie } from '../src/index.js';

const d = (s: string) => new Date(s);

describe('eloBook (Hybrid AI input v2.0)', () => {
  const results = [
    { id: 2, kickoffAt: d('2026-01-08T00:00:00Z'), homeTeamId: 1, awayTeamId: 3, homeGoals: 0, awayGoals: 0 },
    { id: 1, kickoffAt: d('2026-01-01T00:00:00Z'), homeTeamId: 1, awayTeamId: 2, homeGoals: 3, awayGoals: 0 },
  ];
  const book = eloBook(results);

  it('records both ratings before each match, oldest first', () => {
    expect(book.before.get(1)).toEqual({ home: HYBRID_ELO.initial, away: HYBRID_ELO.initial });
    // team 1 won 3-0 first, so it went into the second match above the start
    expect(book.before.get(2)!.home).toBeGreaterThan(HYBRID_ELO.initial);
    expect(book.before.get(2)!.away).toBe(HYBRID_ELO.initial);
  });

  it('keeps the rating sum and counts the matches each rating rests on', () => {
    const sum = [...book.current.values()].reduce((s, t) => s + t.rating, 0);
    expect(sum).toBeCloseTo(3 * HYBRID_ELO.initial, 6);
    expect(book.current.get(1)!.games).toBe(2);
    expect(book.through).toEqual(d('2026-01-08T00:00:00Z'));
  });

  it('drops home advantage at a neutral venue', () => {
    const home = eloView(book, 2, 3, false)!;
    const neutral = eloView(book, 2, 3, true)!;
    expect(home.home_advantage_points).toBe(HYBRID_ELO.homeAdvantage);
    expect(neutral.home_advantage_points).toBe(0);
    expect(home.home_expected_score).toBeGreaterThan(neutral.home_expected_score);
    expect(eloView(book, 1, 99, false)).toBeNull();
  });
});

describe('tableStakes', () => {
  const row = (teamId: number, rank: number, points: number, zone: string | null): StakesTableRow => ({ teamId, group: '', rank, points, played: 10, zone });
  const table = [
    row(1, 1, 25, 'Champions League'),
    row(2, 2, 22, 'Champions League'),
    row(3, 3, 20, 'Europa League'),
    row(4, 4, 15, null),
    row(5, 5, 14, 'Relegation'),
  ];

  it('names the nearest better and worse zone with the points between', () => {
    expect(tableStakes(table, 4, 6)).toMatchObject({
      rank: 4,
      zone: null,
      league_matches_left_including_this: 6,
      points_available: 18,
      points_behind_leader: 10,
      zone_above: { zone: 'Europa League', its_lowest_rank: 3, points_behind: 5 },
      zone_below: { zone: 'Relegation', its_highest_rank: 5, points_ahead: 1 },
    });
  });

  it('gives the leader its lead over second, and nothing above it', () => {
    const s = tableStakes(table, 1, null)!;
    expect(s).toMatchObject({ points_ahead_of_second: 3 });
    expect(s.zone_above).toBeNull();
    expect(s.zone_below).toMatchObject({ zone: 'Europa League', points_ahead: 5 });
    expect(tableStakes(table, 42, 1)).toBeNull();
  });
});

describe('tieSituation', () => {
  const leg = (id: number, homeId: number, awayId: number, ft: [number, number] | null, status: string) => ({
    id, leagueId: 2, season: 2026, round: 'Round of 16', kickoffAt: d(`2026-03-0${id}T20:00:00Z`), homeId, awayId, status, ft, et: null, pen: null,
  });
  const tie = (agg: { a: number; b: number }, first: [number, number]): Tie => ({
    key: 'k', leagueId: 2, season: 2026, stage: 'ROUND_OF_16',
    rule: { leagueId: 2, fromSeason: 2021, stage: 'ROUND_OF_16', legs: 2, awayGoals: false, extraTime: true, penalties: true, neutralVenue: false },
    teamA: 10, teamB: 20, legs: [leg(1, 10, 20, first, 'FT'), leg(2, 20, 10, null, 'NS')], aggregate: agg, status: 'SECOND_LEG_NEXT',
  });
  const names = { home: 'B', away: 'A' };

  it('second leg: the home side trailing by two must win by more than two', () => {
    const s = tieSituation(tie({ a: 3, b: 1 }, [3, 1]), 2, 20, names)!;
    expect(s).toMatchObject({ leg: 2, aggregate_before_this_match: { B: 1, A: 3 }, home_margin_that_levels_aggregate: 2 });
    expect(s.first_leg).toEqual({ home_team: 'A', score_home_away: '3-1' });
    expect(s.meaning).toContain('more than 2');
  });

  it('second leg: a home side leading goes through with a draw', () => {
    const s = tieSituation(tie({ a: 0, b: 1 }, [0, 1]), 2, 20, names)!;
    expect(s.home_margin_that_levels_aggregate).toBe(-1);
    expect(s.meaning).toContain('with a draw');
  });

  it('first leg: says who hosts the return', () => {
    const s = tieSituation(tie({ a: 0, b: 0 }, [0, 0]), 1, 10, { home: 'A', away: 'B' })!;
    expect(s).toMatchObject({ leg: 1, second_leg_home_team: 'B' });
    expect(tieSituation(tie({ a: 0, b: 0 }, [0, 0]), 99, 10, names)).toBeNull();
  });
});

describe('marketMovement', () => {
  const moment = (line: number, home: number) => ({
    as_of_utc: '2026-11-15T00:00:00Z', hours_before_kickoff: 10, handicap_home_line: line, handicap_home_probability_no_vig: 0.5,
    total_line: 2.5, over_probability_no_vig: 0.5, match_odds_no_vig: { home, draw: 0.25, away: 0.75 - home },
  });

  it('gives line changes and win-chance changes in points', () => {
    const m = marketMovement(moment(-0.5, 0.45), null, moment(-0.75, 0.5));
    expect(m.since_opening).toEqual({ handicap_home_line_change: -0.25, total_line_change: 0, home_win_chance_change_points: 5, away_win_chance_change_points: -5 });
    expect(m.since_day_ago).toBeNull();
  });
});
