/**
 * Hybrid input v2 step 1 (audit gaps G1 and G2), on Postgres (PGlite, all migrations):
 *  - the opponent's position next to a recent match is rebuilt from results before that match, not read from today's
 *    standings; a cup, or a league whose standings hold several groups, gets null instead of a wrong number
 *  - injury coverage: a league that reported injuries recently is "available", one that never did is "unavailable"
 *  - the default (v1) input path still reads today's standings, unchanged
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repository, type JobContext } from '@fp/database';
import { createTestDb } from '../../../packages/database/test/helpers.js';
import { injuriesCoverage, withOpponentRanksAsOf } from '../src/hybrid-input-v2.js';

let db: Awaited<ReturnType<typeof createTestDb>>;
let ctx: Pick<JobContext, 'repo'>;
const q = async (sql: string) => db.query(sql);

beforeAll(async () => {
  db = await createTestDb();
  ctx = { repo: new Repository(db) };
  await q(`insert into leagues (id, name, type) values (39, 'Premier League', 'League'), (140, 'Some Cup', 'Cup'), (61, 'Grouped League', 'League'), (62, 'Alias League', 'League')`);
  await q(`insert into teams (id, name) values (1, 'Focus FC'), (2, 'Two'), (3, 'Three'), (4, 'Four')`);
  // league 39: before 10-08 team 2 beat 3 (1-0) and 3 beat 4 (3-0); team 1 lost 0-2 to 2 on 10-08 and then drew with 3 on 10-15
  await q(`insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short, goals_home, goals_away, ft_home, ft_away, slug) values
    (1, 39, 2026, '2026-10-01T15:00:00Z', 2, 3, 'FT', 1, 0, 1, 0, 'f1'),
    (2, 39, 2026, '2026-10-02T15:00:00Z', 3, 4, 'FT', 3, 0, 3, 0, 'f2'),
    (3, 39, 2026, '2026-10-08T15:00:00Z', 1, 2, 'FT', 0, 2, 0, 2, 'f3'),
    (4, 39, 2026, '2026-10-15T15:00:00Z', 1, 3, 'FT', 1, 1, 1, 1, 'f4'),
    (5, 140, 2026, '2026-10-10T15:00:00Z', 1, 2, 'FT', 2, 0, 2, 0, 'f5'),
    (6, 61, 2026, '2026-10-03T15:00:00Z', 1, 2, 'FT', 1, 0, 1, 0, 'f6'),
    (7, 39, 2026, '2026-10-25T15:00:00Z', 2, 4, 'FT', 5, 0, 5, 0, 'f7'), -- after the matches we look at: must never leak in
    (8, 62, 2026, '2026-10-04T15:00:00Z', 2, 3, 'FT', 1, 0, 1, 0, 'f8'),
    (9, 62, 2026, '2026-10-12T15:00:00Z', 1, 2, 'FT', 0, 1, 0, 1, 'f9')`);
  // today's tables (deliberately different from the as-of ones)
  await q(`insert into standings (league_id, season, group_name, team_id, rank, points) values
    (39, 2026, '', 2, 9, 12), (39, 2026, '', 3, 7, 10),
    (140, 2026, '', 2, 3, 6),
    (61, 2026, 'East', 2, 1, 6), (61, 2026, 'West', 3, 1, 6),
    (62, 2026, 'Alias League', 2, 4, 6), (62, 2026, 'Alias League', 3, 5, 0), (62, 2026, 'Alias Name', 2, 4, 6), (62, 2026, 'Alias Name', 3, 5, 0)`);
  await q(`insert into injuries (fixture_id, league_id, season, team_id, player_id, player_name, type, reason, fixture_date, first_seen_at) values
    (4, 39, 2026, 1, 11, 'A', 'Missing Fixture', 'Knee Injury', '2026-10-15T15:00:00Z', '2026-10-10T08:00:00Z')`);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('withOpponentRanksAsOf (G2)', () => {
  it('rebuilds the opponent position as of each match date, ignoring today\'s table and later results', async () => {
    const recent = await ctx.repo.teamRecentMatches(1, new Date('2026-10-20T00:00:00Z'), 10);
    // today's table is what the v1 path reads: ranks 9 and 7, not the position on the day
    expect(recent.find((r) => r.kickoffAt.startsWith('2026-10-08'))!.opponentRank).toBe(9);
    expect(recent.find((r) => r.kickoffAt.startsWith('2026-10-15'))!.opponentRank).toBe(7);

    const asOf = await withOpponentRanksAsOf(ctx, recent);
    const on = (day: string) => asOf.find((r) => r.kickoffAt.startsWith(day))!;
    // 10-08, opponent team 2: results before that day are 2-3 (1-0) and 3-4 (3-0): 3 (3 pts, +2) leads 2 (3 pts, +1) -> 2nd of 3
    expect([on('2026-10-08').opponentRank, on('2026-10-08').opponentTableSize]).toEqual([2, 3]);
    // 10-15, opponent team 3, after team 2 also beat team 1: 2 (6) · 3 (3, +2) · 1 (0, -2) · 4 (0, -3) -> 3 is 2nd of 4
    expect([on('2026-10-15').opponentRank, on('2026-10-15').opponentTableSize]).toEqual([2, 4]);
  });

  it('gives null, not today\'s rank, for a cup and for a league whose standings hold several groups', async () => {
    const recent = await ctx.repo.teamRecentMatches(1, new Date('2026-10-20T00:00:00Z'), 10);
    const asOf = await withOpponentRanksAsOf(ctx, recent);
    expect(recent.find((r) => r.kickoffAt.startsWith('2026-10-10'))!.opponentRank).toBe(3); // v1: the cup's stored rank
    expect(asOf.find((r) => r.kickoffAt.startsWith('2026-10-10'))!.opponentRank).toBeNull(); // cup
    expect(asOf.find((r) => r.kickoffAt.startsWith('2026-10-03'))!.opponentRank).toBeNull(); // two groups
    expect(asOf.find((r) => r.kickoffAt.startsWith('2026-10-10'))!.opponentTableSize).toBeNull();
  });

  it('treats a full table repeated under two names (La Liga in the API) as one table, not as groups', async () => {
    const recent = await ctx.repo.teamRecentMatches(1, new Date('2026-10-20T00:00:00Z'), 10);
    const asOf = await withOpponentRanksAsOf(ctx, recent);
    // league 62 on 10-12, opponent team 2: before that day only 2-3 (1-0) -> team 2 is 1st of 2, today's stored rank is 4
    expect(recent.find((r) => r.kickoffAt.startsWith('2026-10-12'))!.opponentRank).toBe(4);
    expect([asOf.find((r) => r.kickoffAt.startsWith('2026-10-12'))!.opponentRank, asOf.find((r) => r.kickoffAt.startsWith('2026-10-12'))!.opponentTableSize]).toEqual([1, 2]);
  });

  it('does not change anything else about a match', async () => {
    const recent = await ctx.repo.teamRecentMatches(1, new Date('2026-10-20T00:00:00Z'), 10);
    const asOf = await withOpponentRanksAsOf(ctx, recent);
    const strip = (r: (typeof recent)[number]) => ({ ...r, opponentRank: 0, opponentTableSize: 0 });
    expect(asOf.map(strip)).toEqual(recent.map(strip));
  });

  it('gives null for an opponent that had not played before the match', async () => {
    const recent = await ctx.repo.teamRecentMatches(1, new Date('2026-10-02T00:00:00Z'), 10); // nothing before 10-02
    expect(await withOpponentRanksAsOf(ctx, recent)).toEqual([]);
    const early = await ctx.repo.teamRecentMatches(1, new Date('2026-10-04T00:00:00Z'), 10); // only the 10-03 grouped-league match
    expect((await withOpponentRanksAsOf(ctx, early))[0]!.opponentRank).toBeNull();
  });
});

describe('injuriesCoverage (G1)', () => {
  it('is available when the league reported injuries in the last 30 days before the decision time', async () => {
    expect(await injuriesCoverage(ctx, 39, new Date('2026-10-20T00:00:00Z'))).toBe('available');
  });
  it('is unavailable for a league that never reported any', async () => {
    expect(await injuriesCoverage(ctx, 140, new Date('2026-10-20T00:00:00Z'))).toBe('unavailable_for_league');
    expect(await injuriesCoverage(ctx, 61, new Date('2026-10-20T00:00:00Z'))).toBe('unavailable_for_league');
  });
  it('uses only what had been seen by the decision time (as-of), and forgets rows older than 30 days', async () => {
    expect(await injuriesCoverage(ctx, 39, new Date('2026-10-05T00:00:00Z'))).toBe('unavailable_for_league'); // first seen 10-10
    expect(await injuriesCoverage(ctx, 39, new Date('2026-11-20T00:00:00Z'))).toBe('unavailable_for_league'); // 41 days later
  });
});
