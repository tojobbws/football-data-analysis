import { describe, expect, it } from 'vitest';
import {
  fixtureSlug,
  parseNumeric,
  slugify,
  statKey,
  toApiPredictionRow,
  toEventRows,
  toFixturePlayerStatRows,
  toFixtureRow,
  toLineupRows,
  toStatisticRows,
  toVenueStubFromFixture,
  validId,
  type FixtureItem,
} from '../src/index.js';
import detail from './fixtures/fixture-detail.json' with { type: 'json' };

const fixture = detail as unknown as FixtureItem;

describe('helpers', () => {
  it('slugify', () => {
    expect(slugify('Brighton & Hove Albion')).toBe('brighton-and-hove-albion');
    expect(slugify('Atlético Madrid')).toBe('atletico-madrid');
    expect(slugify('  Bayern München ')).toBe('bayern-munchen');
  });
  it('fixtureSlug includes the date', () => {
    expect(fixtureSlug('Liverpool', 'Arsenal', '2026-09-18T16:30:00.000Z')).toBe('liverpool-vs-arsenal-2026-09-18');
  });
  it('parseNumeric', () => {
    expect(parseNumeric('55%')).toBe(55);
    expect(parseNumeric('1.87')).toBe(1.87);
    expect(parseNumeric(6)).toBe(6);
    expect(parseNumeric(null)).toBeNull();
    expect(parseNumeric('n/a')).toBeNull();
  });
  it('statKey', () => {
    expect(statKey('Shots on Goal')).toBe('shots_on_goal');
    expect(statKey('Passes %')).toBe('passes_pct');
    expect(statKey('expected_goals')).toBe('expected_goals');
  });
});

describe('fixture mappers', () => {
  it('toFixtureRow', () => {
    const row = toFixtureRow(fixture);
    expect(row).toMatchObject({
      id: 1001,
      league_id: 39,
      season: 2026,
      kickoff_at: '2026-09-18T16:30:00.000Z',
      home_team_id: 40,
      away_team_id: 42,
      status_short: 'FT',
      ft_home: 2,
      ft_away: 1,
      slug: 'liverpool-vs-arsenal-2026-09-18',
    });
    expect(row).not.toHaveProperty('raw');
  });

  it('keeps stoppage-time minutes (45+2) and null outside them', () => {
    const stoppage = { ...fixture, fixture: { ...fixture.fixture, status: { long: 'First Half', short: '1H', elapsed: 45, extra: 2 } } } as FixtureItem;
    expect(toFixtureRow(stoppage)).toMatchObject({ elapsed: 45, elapsed_extra: 2 });
    expect(toFixtureRow(fixture).elapsed_extra).toBeNull();
  });

  it('treats venue id 0 as unknown (null), not a foreign key', () => {
    const noVenue = { ...fixture, fixture: { ...fixture.fixture, venue: { id: 0, name: null, city: null } } } as FixtureItem;
    expect(toFixtureRow(noVenue).venue_id).toBeNull();
    expect(toVenueStubFromFixture(noVenue)).toBeNull();
    expect(validId(0)).toBeNull();
    expect(validId(null)).toBeNull();
    expect(validId(550)).toBe(550);
  });

  it('toEventRows keeps order', () => {
    const rows = toEventRows(fixture);
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(rows[1]).toMatchObject({ team_id: 42, player_name: 'B. Saka', assist_id: 1 });
  });

  it('toStatisticRows parses % and xG', () => {
    const rows = toStatisticRows(fixture);
    const by = Object.fromEntries(rows.map((r) => [r.type, r]));
    expect(by['ball_possession']).toMatchObject({ value_num: 55, value_text: '55%' });
    expect(by['expected_goals']).toMatchObject({ value_num: 1.87 });
    expect(by['red_cards']).toMatchObject({ value_num: null, value_text: null });
  });

  it('toLineupRows splits starters and subs', () => {
    const { lineups, players } = toLineupRows(fixture);
    expect(lineups[0]).toMatchObject({ team_id: 40, formation: '4-3-3', coach_name: 'A. Slot' });
    expect(players.map((p) => p.is_starter)).toEqual([true, false]);
  });

  it('toFixturePlayerStatRows', () => {
    const rows = toFixturePlayerStatRows(fixture);
    expect(rows[0]).toMatchObject({ player_id: 306, rating: 8.1, goals: 1, shots_on: 2, passes_key: 3 });
  });

  it('toApiPredictionRow parses percentages', () => {
    const row = toApiPredictionRow(
      1001,
      {
        predictions: {
          winner: { id: 40, name: 'Liverpool', comment: 'Win or draw' },
          win_or_draw: true,
          under_over: '-3.5',
          goals: { home: '-2.5', away: '-1.5' },
          advice: 'Double chance : Liverpool or draw',
          percent: { home: '50%', draw: '30%', away: '20%' },
        },
      },
      7,
    );
    expect(row).toMatchObject({ percent_home: 50, percent_draw: 30, percent_away: 20, winner_team_id: 40, raw_response_id: 7 });
  });
});
