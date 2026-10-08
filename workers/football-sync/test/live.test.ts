/**
 * Live-score gate: no API request while nothing is on; matches in play (or kicking off) are refreshed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repository, type JobContext } from '@fp/database';
import { ApiFootball, ApiFootballClient } from '@fp/football';
import { createLogger, type Env } from '@fp/shared';
import { createTestDb } from '../../../packages/database/test/helpers.js';
import detail from '../../../packages/football/test/fixtures/fixture-detail.json' with { type: 'json' };
import { syncLive, syncSupportLeagues } from '../src/jobs.js';

const now = new Date('2026-10-14T19:30:00Z');
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();

let ctx: JobContext;
let db: Awaited<ReturnType<typeof createTestDb>>;
const requested: string[] = [];

const fakeFetch = (async (input: URL | RequestInfo) => {
  const url = new URL(String(input));
  const ids = (url.searchParams.get('ids') ?? '').split('-').filter(Boolean).map(Number);
  requested.push(ids.join('-'));
  const response = ids.map((id) => ({
    ...detail,
    fixture: { ...detail.fixture, id, status: { long: 'Second Half', short: '2H', elapsed: 67 } },
    teams: { home: { id: 1000 + id, name: `Home ${id}`, logo: null, winner: null }, away: { id: 2000 + id, name: `Away ${id}`, logo: null, winner: null } },
    goals: { home: 2, away: 1 },
  }));
  return new Response(JSON.stringify({ get: url.pathname, parameters: {}, errors: [], results: response.length, paging: { current: 1, total: 1 }, response }), { status: 200 });
}) as typeof fetch;

async function fixture(id: number, kickoff: string, status: string, league = 39) {
  await db.query(
    `insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short, slug)
     values ($1, $2, 2026, $3, 40, 42, $4, $5)`,
    [id, league, kickoff, status, `m-${id}`],
  );
}

beforeAll(async () => {
  db = await createTestDb();
  await db.exec(`
    insert into leagues (id, name) values (39, 'Premier League'), (140, 'La Liga');
    insert into teams (id, name, slug) values (40, 'Liverpool', 'liverpool-40'), (42, 'Arsenal', 'arsenal-42');`);
  const repo = new Repository(db);
  const client = new ApiFootballClient({ apiKey: 'test', fetchImpl: fakeFetch, requestsPerMinute: 1000 });
  const env: Env = {
    API_FOOTBALL_KEY: 'test',
    API_FOOTBALL_BASE_URL: 'https://v3.football.api-sports.io',
    API_FOOTBALL_RPM: 1000,
    DATABASE_URL: 'pglite',
    TRACKED_LEAGUES: [39],
    SEASON: 2026,
    ODDS_MARKETS: [],
    ODDS_BOOKMAKERS: [],
    LOG_LEVEL: 'error',
  };
  ctx = { env, db, repo, client, api: new ApiFootball(client), log: createLogger('error') };
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('syncLive', () => {
  it('makes no API request and writes no sync run while nothing is on', async () => {
    await fixture(1, at(30), 'NS'); // kicks off later
    await fixture(2, at(-200), 'FT'); // finished
    await fixture(3, at(-60), 'PST'); // postponed
    await fixture(4, at(-30), '1H', 140); // untracked league
    expect(await syncLive(ctx, { now })).toBe(0);
    expect(requested).toEqual([]);
    expect((await db.query(`select count(*)::int n from sync_runs`)).rows[0]).toEqual({ n: 0 });
  });

  it('refreshes matches in play and those kicking off now, in one request', async () => {
    await fixture(10, at(-50), '1H');
    await fixture(11, at(0), 'NS'); // API has not flipped it to live yet
    await fixture(12, at(-240), 'ET'); // long match (delays/extra time) still live
    expect(await syncLive(ctx, { now })).toBeGreaterThan(0);
    expect(requested).toEqual(['12-10-11']);
    const rows = (await db.query<{ id: number; status_short: string; goals_home: number }>(`select id, status_short, goals_home from fixtures where id in (10, 11, 12) order by id`)).rows;
    expect(rows.map((r) => [Number(r.id), r.status_short, r.goals_home])).toEqual([[10, '2H', 2], [11, '2H', 2], [12, '2H', 2]]);
    expect(Number((await db.query<{ n: number }>(`select count(*) n from fixture_events where fixture_id = 10`)).rows[0]!.n)).toBeGreaterThan(0);
  });
});

describe('syncSupportLeagues', () => {
  it('fetches the last N results of untracked domestic leagues behind a tracked cross-league cup', async () => {
    const seen: string[] = [];
    const client = new ApiFootballClient({
      apiKey: 'test',
      requestsPerMinute: 1000,
      fetchImpl: (async (input: URL | RequestInfo) => {
        const u = new URL(String(input));
        seen.push(`${u.searchParams.get('league')}:${u.searchParams.get('last')}`);
        return new Response(JSON.stringify({ errors: [], results: 0, paging: { current: 1, total: 1 }, response: [] }));
      }) as typeof fetch,
    });
    const c2 = { ...ctx, client, api: new ApiFootball(client), env: { ...ctx.env, TRACKED_LEAGUES: [39, 1129, 296] } };
    await syncSupportLeagues(c2, { last: 25 });
    // 296 is tracked itself -> not fetched again; 39 is not a cross-league cup
    expect(seen.sort()).toEqual(['274:25', '278:25', '340:25', '368:25', '410:25', '588:25', '647:25', '765:25']);
  });
});
