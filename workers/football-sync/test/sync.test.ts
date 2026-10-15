/**
 * End-to-end: fake API-Football -> real job code -> PGlite (real Postgres) with all migrations.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repository, trackedLeagueSeasons, type JobContext } from '@fp/database';
import { ApiFootball, ApiFootballClient } from '@fp/football';
import { createLogger, type Env } from '@fp/shared';
import { createTestDb } from '../../../packages/database/test/helpers.js';
import detail from '../../../packages/football/test/fixtures/fixture-detail.json' with { type: 'json' };
import { pruneStorage, syncApiPredictions, syncFinishedDetails, syncFixtures, syncLeagues, syncResults, syncTeams } from '../src/jobs.js';
import { syncOdds } from '../../odds-sync/src/jobs.js';

const future = new Date(Date.now() + 2 * 86_400_000).toISOString();

const upcomingFixture = {
  ...detail,
  fixture: { ...detail.fixture, id: 2002, date: future, status: { long: 'Not Started', short: 'NS', elapsed: null } },
  goals: { home: null, away: null },
  score: { halftime: { home: null, away: null }, fulltime: { home: null, away: null }, extratime: { home: null, away: null }, penalty: { home: null, away: null } },
  teams: { home: { id: 42, name: 'Arsenal', logo: null, winner: null }, away: { id: 99, name: 'Brand New FC', logo: null, winner: null } },
};
const { events: _e, lineups: _l, statistics: _s, players: _p, ...finishedListItem } = detail;

const oddsQuote = { update: '2026-10-06T10:00:00+00:00', home: '1.95' };

const routes: Record<string, (p: URLSearchParams) => unknown[]> = {
  '/leagues': () => [
    {
      league: { id: 39, name: 'Premier League', type: 'League', logo: null },
      country: { name: 'England', code: 'GB', flag: null },
      seasons: [{ year: 2026, start: '2026-08-15', end: '2027-05-23', current: true, coverage: { odds: true } }],
    },
  ],
  '/teams': () => [
    { team: { id: 40, name: 'Liverpool', code: 'LIV', country: 'England', founded: 1892, national: false, logo: null }, venue: { id: 550, name: 'Anfield', address: null, city: 'Liverpool', capacity: 61276, surface: 'grass', image: null } },
    { team: { id: 42, name: 'Arsenal', code: 'ARS', country: 'England', founded: 1886, national: false, logo: null }, venue: { id: 494, name: 'Emirates Stadium', address: null, city: 'London', capacity: 60383, surface: 'grass', image: null } },
  ],
  '/fixtures': (p) => (p.get('ids') ? [detail] : [finishedListItem, upcomingFixture]),
  '/predictions': () => [
    { predictions: { winner: { id: 42, name: 'Arsenal', comment: null }, win_or_draw: true, under_over: null, goals: { home: '-2.5', away: '-1.5' }, advice: 'x', percent: { home: '50%', draw: '30%', away: '20%' } } },
  ],
  '/odds': () => [
    {
      league: { id: 39, season: 2026 },
      fixture: { id: 2002 },
      update: oddsQuote.update,
      bookmakers: [{ id: 8, name: 'Bet365', bets: [{ id: 4, name: 'Asian Handicap', values: [{ value: 'Home -0.75', odd: oddsQuote.home },{ value: 'Away -0.75', odd: '1.95' }] }] }],
    },
    { league: { id: 39, season: 2026 }, fixture: { id: 777777 }, update: '2026-10-06T10:00:00+00:00', bookmakers: [] }, // unknown fixture
  ],
};

const fakeFetch = (async (input: URL | RequestInfo) => {
  const url = new URL(String(input));
  const handler = routes[url.pathname];
  const response = handler ? handler(url.searchParams) : [];
  return new Response(JSON.stringify({ get: url.pathname, parameters: {}, errors: [], results: response.length, paging: { current: 1, total: 1 }, response }), { status: 200 });
}) as typeof fetch;

let ctx: JobContext;
let db: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
  db = await createTestDb();
  const repo = new Repository(db);
  const client = new ApiFootballClient({ apiKey: 'test', fetchImpl: fakeFetch, requestsPerMinute: 1000, onRawResponse: (r) => repo.insertRawResponse(r) });
  const env: Env = {
    API_FOOTBALL_KEY: 'test',
    API_FOOTBALL_BASE_URL: 'https://v3.football.api-sports.io',
    API_FOOTBALL_RPM: 1000,
    DATABASE_URL: 'pglite',
    TRACKED_LEAGUES: [39],
    SEASON: 2026,
    ODDS_MARKETS: ['MATCH_WINNER', 'ASIAN_HANDICAP', 'OVER_UNDER'],
    ODDS_BOOKMAKERS: [],
    LOG_LEVEL: 'error',
  };
  ctx = { env, db, repo, client, api: new ApiFootball(client), log: createLogger('error') };
}, 60_000);

afterAll(async () => {
  await db?.close();
});

const one = async (sql: string) => (await db.query<Record<string, unknown>>(sql)).rows[0]!;

describe('sync pipeline', () => {
  it('leagues -> teams -> fixtures (with stubs for unknown teams)', async () => {
    await syncLeagues(ctx);
    await syncTeams(ctx);
    await syncFixtures(ctx);
    expect(Number((await one(`select count(*) n from fixtures`)).n)).toBe(2);
    expect((await one(`select name from teams where id = 99`)).name).toBe('Brand New FC');
    expect((await one(`select is_tracked from leagues where id = 39`)).is_tracked).toBe(true);
    expect((await one(`select slug from fixtures where id = 1001`)).slug).toBe('liverpool-vs-arsenal-2026-09-18');
  });

  it('re-running is idempotent', async () => {
    await syncFixtures(ctx);
    expect(Number((await one(`select count(*) n from fixtures`)).n)).toBe(2);
  });

  it('details: events, stats incl. xG, lineups, player stats', async () => {
    await syncFinishedDetails(ctx);
    expect(Number((await one(`select count(*) n from fixture_events where fixture_id = 1001`)).n)).toBe(2);
    expect(Number((await one(`select value_num from fixture_statistics where fixture_id = 1001 and type = 'expected_goals'`)).value_num)).toBe(1.87);
    expect(Number((await one(`select count(*) n from fixture_lineup_players where fixture_id = 1001`)).n)).toBe(2);
    expect((await one(`select details_synced_at from fixtures where id = 1001`)).details_synced_at).not.toBeNull();
    // second run: nothing left to fetch
    const before = ctx.client.requestCount;
    await syncFinishedDetails(ctx);
    expect(ctx.client.requestCount).toBe(before);
  });

  it('details filters by league and season', async () => {
    await db.query(`update fixtures set details_synced_at = null where id = 1001`);
    expect(await ctx.repo.fixturesNeedingDetails([39], 10, [2025])).toEqual([]);
    expect(await ctx.repo.fixturesNeedingDetails([40], 10)).toEqual([]);
    expect(await ctx.repo.fixturesNeedingDetails([39], 10, [2026])).toEqual([1001]);
    await syncFinishedDetails(ctx, { leagues: [39], seasons: [2026] });
    expect(await ctx.repo.fixturesNeedingDetails([39], 10)).toEqual([]);
  });

  it('api predictions are snapshotted and not re-fetched within the gap', async () => {
    await syncApiPredictions(ctx);
    await syncApiPredictions(ctx);
    expect(Number((await one(`select count(*) n from api_predictions where fixture_id = 2002`)).n)).toBe(1);
    expect(Number((await one(`select percent_home from api_predictions`)).percent_home)).toBe(50);
  });

  it('odds: stores history, de-duplicates unchanged updates, skips unknown fixtures', async () => {
    await syncOdds(ctx);
    await syncOdds(ctx);
    expect(Number((await one(`select count(*) n from odds_history`)).n)).toBe(2);
    const away = await one(`select line, home_line, raw_response_id from odds_history where raw_value = 'Away -0.75'`);
    expect(Number(away.line)).toBe(0.75);
    expect(Number(away.home_line)).toBe(-0.75);
    expect(away.raw_response_id).not.toBeNull();
  });

  it('odds: an unchanged price is re-stored only as a 6-hourly heartbeat, a changed price at once', async () => {
    const count = async () => Number((await one(`select count(*) n from odds_history where fixture_id = 2002`)).n);
    const before = await count();
    oddsQuote.update = '2026-10-06T15:00:00+00:00'; // same prices, new API timestamp, 5h after the stored one
    await syncOdds(ctx);
    expect(await count()).toBe(before);
    oddsQuote.update = '2026-10-06T16:00:00+00:00'; // 6h: re-store so the quote still counts as fresh
    await syncOdds(ctx);
    expect(await count()).toBe(before + 2);
    oddsQuote.update = '2026-10-06T16:30:00+00:00';
    oddsQuote.home = '1.90'; // only the side that moved is stored
    await syncOdds(ctx);
    expect(await count()).toBe(before + 3);
    const latest = await one(`select odds from odds_history where raw_value = 'Home -0.75' order by source_updated_at desc limit 1`);
    expect(Number(latest.odds)).toBe(1.9);
  });

  it('results: refreshes a kicked-off match that is not final yet, leaves future matches alone', async () => {
    await db.query(`update fixtures set status_short = '2H', ft_home = null, ft_away = null, details_synced_at = null where id = 1001`);
    const before = ctx.client.requestCount;
    await syncResults(ctx, { days: 3650 });
    expect(ctx.client.requestCount - before).toBe(1);
    const f = await one(`select status_short, ft_home, details_synced_at from fixtures where id = 1001`);
    expect(f.status_short).toBe('FT');
    expect(f.ft_home).not.toBeNull();
    expect(f.details_synced_at).not.toBeNull();
    expect((await one(`select status_short from fixtures where id = 2002`)).status_short).toBe('NS');
    // nothing left to refresh
    await syncResults(ctx, { days: 3650 });
    expect(ctx.client.requestCount - before).toBe(1);
  });

  it('records every run and every raw response', async () => {
    const runs = await one(`select count(*) n, count(*) filter (where status <> 'SUCCESS') bad from sync_runs`);
    expect(Number(runs.n)).toBeGreaterThan(5);
    expect(Number(runs.bad)).toBe(0);
    expect(Number((await one(`select count(*) n from api_raw_responses`)).n)).toBe(ctx.client.requestCount);
  });

  it('prune: drops old raw responses, keeps recent ones and the data that referenced them', async () => {
    const total = Number((await one(`select count(*) n from api_raw_responses`)).n);
    const odds = Number((await one(`select count(*) n from odds_history`)).n);
    // age every raw row that odds_history points at, plus one more
    await db.query(`update api_raw_responses set fetched_at = now() - interval '30 days'
                    where id in (select raw_response_id from odds_history) or id = (select min(id) from api_raw_responses)`);
    const old = Number((await one(`select count(*) n from api_raw_responses where fetched_at < now() - interval '3 days'`)).n);

    expect(await pruneStorage(ctx, { vacuum: true })).toBe(old);
    expect(Number((await one(`select count(*) n from api_raw_responses`)).n)).toBe(total - old);
    expect(Number((await one(`select count(*) n from odds_history`)).n)).toBe(odds);
    expect(await pruneStorage(ctx)).toBe(0);
  });

  it('prune: odds snapshots are kept for good, however old the match', async () => {
    const odds = Number((await one(`select count(*) n from odds_history where fixture_id = 2002`)).n);
    expect(odds).toBeGreaterThan(0);

    await db.query(`update fixtures set kickoff_at = now() - interval '60 days' where id = 2002`);
    expect(await pruneStorage(ctx)).toBe(0);
    expect(Number((await one(`select count(*) n from odds_history where fixture_id = 2002`)).n)).toBe(odds);
    await expect(db.query(`delete from odds_history where fixture_id = 2002`)).rejects.toThrow(/append-only/);
  });

  it('each league syncs its own current season, env SEASON only as fallback', async () => {
    await db.query(`insert into leagues (id, name) values (253, 'MLS') on conflict do nothing`);
    await db.query(`insert into league_seasons (league_id, season, is_current) values (253, 2025, false), (253, 2027, true)`);
    expect(await trackedLeagueSeasons(ctx, [39, 253, 98])).toEqual([
      { league: 39, season: 2026 },
      { league: 253, season: 2027 },
      { league: 98, season: 2026 },
    ]);
  });
});
