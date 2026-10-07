import type { Repository } from '@fp/database';
import {
  slugify,
  toEventRows,
  toFixturePlayerStatRows,
  toFixtureRow,
  toLineupRows,
  toStatisticRows,
  toTeamStub,
  toVenueStubFromFixture,
  type FixtureItem,
} from '@fp/football';

/**
 * Persist fixtures (+ their detail arrays when present).
 * Creates league/team/venue stubs first so FKs never fail for cup/new teams.
 */
export async function persistFixtures(repo: Repository, items: FixtureItem[], opts: { withDetails: boolean }): Promise<number> {
  if (!items.length) return 0;
  let written = 0;

  const leagues = new Map<number, Record<string, unknown>>();
  for (const it of items) {
    leagues.set(it.league.id, {
      id: it.league.id,
      name: it.league.name,
      country: it.league.country,
      logo_url: it.league.logo,
      flag_url: it.league.flag,
      slug: slugify(`${it.league.country ?? ''} ${it.league.name}`) || String(it.league.id),
    });
  }
  await repo.insertLeagueStubs([...leagues.values()]);

  const teams = items.flatMap((it) => [toTeamStub(it.teams.home), toTeamStub(it.teams.away)]);
  const venues = items.map(toVenueStubFromFixture).filter((v): v is Record<string, unknown> => v !== null);
  await repo.insertVenueStubs(venues);
  await repo.insertTeamStubs(teams);
  written += await repo.upsertFixtures(items.map(toFixtureRow));

  if (opts.withDetails) {
    for (const it of items) {
      const { lineups, players } = toLineupRows(it);
      written += await repo.replaceFixtureDetails(it.fixture.id, {
        events: toEventRows(it),
        statistics: toStatisticRows(it),
        lineups,
        lineupPlayers: players,
        playerStats: toFixturePlayerStatRows(it),
      });
    }
  }
  return written;
}
