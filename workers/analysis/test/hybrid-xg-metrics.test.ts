/**
 * Hybrid prompt v1.5, on Postgres (PGlite, all migrations): teamRecentMatches carries the inputs of the
 * expected-goals metrics from the stored data:
 *  - the full-match score (extra time included) and the match status
 *  - penalties taken in play, scored or missed, from each side; shootout kicks are not penalties
 *  - own goals, filed under the team they count for
 *  - the team's goals prevented
 *  - null penalties and own goals when the match has no events stored (unknown, not zero)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repository } from '@fp/database';
import { buildHybridInput, expectedMetrics } from '@fp/ai';
import { createTestDb } from '../../../packages/database/test/helpers.js';

let db: Awaited<ReturnType<typeof createTestDb>>;
let repo: Repository;
const q = async (sql: string) => db.query(sql);

beforeAll(async () => {
  db = await createTestDb();
  repo = new Repository(db);
  await q(`insert into leagues (id, name, type) values (39, 'Premier League', 'League'), (45, 'FA Cup', 'Cup')`);
  await q(`insert into teams (id, name) values (1, 'Focus FC'), (2, 'Two'), (3, 'Three')`);
  await q(`insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short, goals_home, goals_away, ft_home, ft_away, slug) values
    (1, 39, 2026, '2026-10-04T15:00:00Z', 1, 2, 'FT', 2, 1, 2, 1, 'f1'),
    (2, 45, 2026, '2026-10-08T19:00:00Z', 3, 1, 'PEN', 2, 2, 1, 1, 'f2'),
    (3, 39, 2026, '2026-10-12T15:00:00Z', 2, 1, 'FT', 0, 0, 0, 0, 'f3')`);
  await q(`insert into fixture_statistics (fixture_id, team_id, type, value_num) values
    (1, 1, 'expected_goals', 1.9), (1, 2, 'expected_goals', 1.1), (1, 1, 'goals_prevented', 0.35), (1, 2, 'goals_prevented', -0.2),
    (2, 3, 'expected_goals', 1.6), (2, 1, 'expected_goals', 2.4),
    (3, 2, 'expected_goals', 0.8), (3, 1, 'expected_goals', 0.5)`);
  // match 1: Focus scores a penalty and gets an own goal from Two (filed under Focus); Two misses a penalty and scores once
  // match 2 (cup, extra time and a shootout): Focus scores a penalty in play; the shootout kicks do not count
  // match 3: no events stored
  await q(`insert into fixture_events (fixture_id, seq, elapsed, team_id, type, detail, comments) values
    (1, 1, 20, 1, 'Goal', 'Penalty', null), (1, 2, 40, 2, 'Goal', 'Missed Penalty', null), (1, 3, 55, 1, 'Goal', 'Own Goal', null),
    (1, 4, 70, 2, 'Goal', 'Normal Goal', null), (1, 5, 80, 1, 'Card', 'Yellow Card', null),
    (2, 1, 30, 1, 'Goal', 'Penalty', null), (2, 2, 60, 3, 'Goal', 'Normal Goal', null), (2, 3, 100, 3, 'Goal', 'Normal Goal', null),
    (2, 4, 110, 1, 'Goal', 'Normal Goal', null),
    (2, 5, 120, 1, 'Goal', 'Penalty', 'Penalty Shootout'), (2, 6, 120, 3, 'Goal', 'Missed Penalty', 'Penalty Shootout'), (2, 7, 120, 1, 'Goal', 'Missed Penalty', 'Penalty Shootout')`);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('teamRecentMatches: the inputs of the expected-goals metrics', () => {
  it('reads penalties in play, own goals, goals prevented and the full-match score from each side', async () => {
    const recent = await repo.teamRecentMatches(1, new Date('2026-10-20T00:00:00Z'), 10);
    const on = (day: string) => recent.find((r) => r.kickoffAt.startsWith(day))!;
    expect(on('2026-10-04')).toMatchObject({ status: 'FT', fullGoalsFor: 2, fullGoalsAgainst: 1, penaltiesFor: 1, penaltiesAgainst: 1, ownGoalsFor: 1, goalsPreventedFor: 0.35 });
    // the cup tie: 90-minute score 1-1, 2-2 after extra time; the shootout's kicks are not penalties
    expect(on('2026-10-08')).toMatchObject({ status: 'PEN', goalsFor: 1, goalsAgainst: 1, fullGoalsFor: 2, fullGoalsAgainst: 2, penaltiesFor: 1, penaltiesAgainst: 0, ownGoalsFor: 0, goalsPreventedFor: null });
    // no events stored: unknown, not zero
    expect(on('2026-10-12')).toMatchObject({ penaltiesFor: null, penaltiesAgainst: null, ownGoalsFor: null });
  });

  it('gives the metrics: npxG off the penalty, shooting performance without the own goal, no xPTS after extra time', async () => {
    const recent = await repo.teamRecentMatches(1, new Date('2026-10-20T00:00:00Z'), 10);
    const on = (day: string) => expectedMetrics(recent.find((r) => r.kickoffAt.startsWith(day))!);
    // 1.9 - 0.79 = 1.11; Two's missed penalty is off its xG: 1.1 - 0.79 = 0.31; goals from own shots 2 - 1 own goal = 1, minus xG 1.9
    expect(on('2026-10-04')).toMatchObject({ xg_difference: 0.8, npxg_for: 1.11, npxg_against: 0.31, shooting_performance: -0.9, goals_prevented: 0.35 });
    expect(on('2026-10-04').xpts).toBeGreaterThan(1.5);
    // xG covers the 120 minutes: 2 goals after extra time minus 2.4; no xPTS
    expect(on('2026-10-08')).toMatchObject({ shooting_performance: -0.4, xpts: null, npxg_for: 1.61 });
    expect(on('2026-10-12')).toMatchObject({ xg_difference: -0.3, npxg_for: null, shooting_performance: null });
  });

  it('the stored rows build an input the AI reads (with the flag)', async () => {
    const recent = await repo.teamRecentMatches(1, new Date('2026-10-20T00:00:00Z'), 10);
    const input = buildHybridInput({
      fixture: { id: 99, home: 'Focus FC', away: 'Two', league: 'Premier League', kickoffAt: new Date('2026-10-20T15:00:00Z') },
      predictionAt: new Date('2026-10-20T08:00:00Z'),
      publishRound: 'EARLY',
      recent: { home: recent, away: [] },
      standings: { home: null, away: null },
      injuries: [],
      lineup: null,
      market: { ah: { status: 'NO_QUOTES', line: null, favourite: null, nBookmakers: 0, ageHours: null, options: [] }, ou: { status: 'NO_QUOTES', line: null, nBookmakers: 0, ageHours: null, options: [] }, x12: null } as never,
      xgMetrics: true,
    }) as { home_team: { last_10: Record<string, number | null> }; data_quality: { missing: string[] } };
    expect(input.home_team.last_10).toMatchObject({ npxg_matches: 2, shooting_performance_matches: 2, xpts_matches: 2, goals_prevented_matches: 1, goals_prevented_total: 0.35 });
    expect(input.data_quality.missing).toContain('no npxG for 1 recent matches that have xG (no match events stored)');
    expect(input.data_quality.missing).toContain('no xPTS for 1 recent matches that went to extra time');
  });
});
