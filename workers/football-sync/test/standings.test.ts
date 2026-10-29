/**
 * Standings sync (audit gap G7): the table is keyed by group name, so a group the API renames used to stay behind as a
 * stale table beside the live one (La Liga on 2026-10-12, K League and the Champions League after it). Now a group the
 * latest response no longer contains is removed, whole groups only, and never on an empty response.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repository, type JobContext } from '@fp/database';
import { ApiFootball, ApiFootballClient } from '@fp/football';
import { createLogger, type Env } from '@fp/shared';
import { createTestDb } from '../../../packages/database/test/helpers.js';
import { syncStandings } from '../src/jobs.js';

type Row = { rank: number; id: number | null; name: string; group: string; points: number };
let response: Row[][] = [];
const standing = (r: Row) => ({ rank: r.rank, team: { id: r.id, name: r.name }, points: r.points, goalsDiff: 0, group: r.group, form: null, all: { played: 10 } });

const fakeFetch = (async (input: URL | RequestInfo) => {
  const url = new URL(String(input));
  const data = url.pathname === '/standings' ? (response.length ? [{ league: { id: 140, season: 2026, name: 'La Liga', standings: response.map((g) => g.map(standing)) } }] : []) : [];
  return new Response(JSON.stringify({ get: url.pathname, parameters: {}, errors: [], results: data.length, paging: { current: 1, total: 1 }, response: data }), { status: 200 });
}) as typeof fetch;

let db: Awaited<ReturnType<typeof createTestDb>>;
let ctx: JobContext;
const groups = async () => (await db.query<{ group_name: string; n: string }>(`select group_name, count(*) n from standings where league_id = 140 and season = 2026 group by 1 order by 1`)).rows.map((r) => `${r.group_name}:${r.n}`);

beforeAll(async () => {
  db = await createTestDb();
  const repo = new Repository(db);
  const client = new ApiFootballClient({ apiKey: 'test', fetchImpl: fakeFetch, requestsPerMinute: 1000 });
  const env: Env = {
    API_FOOTBALL_KEY: 'test',
    API_FOOTBALL_BASE_URL: 'https://v3.football.api-sports.io',
    API_FOOTBALL_RPM: 1000,
    DATABASE_URL: 'pglite',
    TRACKED_LEAGUES: [140],
    SEASON: 2026,
    ODDS_MARKETS: ['MATCH_WINNER'],
    ODDS_BOOKMAKERS: [],
    LOG_LEVEL: 'error',
  };
  ctx = { env, db, repo, client, api: new ApiFootball(client), log: createLogger('error') };
  await db.query(`insert into leagues (id, name, type) values (140, 'La Liga', 'League')`);
  await db.query(`insert into league_seasons (league_id, season, is_current) values (140, 2026, true)`);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

const table = (group: string): Row[] => [
  { rank: 1, id: 1, name: 'Barcelona', group, points: 27 },
  { rank: 2, id: 2, name: 'Atletico', group, points: 25 },
];

describe('syncStandings: a renamed group does not leave a stale table behind', () => {
  it('keeps one table when the API sends the same group name', async () => {
    response = [table('La Liga')];
    await syncStandings(ctx);
    await syncStandings(ctx);
    expect(await groups()).toEqual(['La Liga:2']);
  });

  it('removes the old group when the API sends the same table under a new name', async () => {
    response = [table('Primera División')];
    await syncStandings(ctx);
    expect(await groups()).toEqual(['Primera División:2']);
  });

  it('keeps every group the API still sends (a league played in groups)', async () => {
    response = [table('East'), table('West').map((r) => ({ ...r, id: r.id! + 10 }))];
    await syncStandings(ctx);
    expect(await groups()).toEqual(['East:2', 'West:2']);
  });

  it('removes nothing when the API sends nothing (an empty or failed response must not wipe a table)', async () => {
    response = [];
    await syncStandings(ctx);
    expect(await groups()).toEqual(['East:2', 'West:2']);
  });

  it('counts a group made only of team-less rows as still sent, and keeps its previous rows', async () => {
    response = [table('East'), [{ rank: 1, id: null, name: 'No Id FC', group: 'West', points: 9 }]];
    await syncStandings(ctx);
    expect(await groups()).toEqual(['East:2', 'West:2']);
  });

  it('leaves other leagues and seasons alone', async () => {
    await db.query(`insert into leagues (id, name, type) values (39, 'Premier League', 'League')`);
    await db.query(`insert into standings (league_id, season, group_name, team_id, rank, points) values (39, 2026, 'Premier League', 40, 1, 3)`);
    await db.query(`insert into standings (league_id, season, group_name, team_id, rank, points) values (140, 2025, 'Old Season', 1, 1, 90)`);
    response = [table('Primera División')];
    await syncStandings(ctx);
    expect(await groups()).toEqual(['Primera División:2']);
    const others = (await db.query<{ n: string }>(`select count(*) n from standings where (league_id = 39 and season = 2026) or (league_id = 140 and season = 2025)`)).rows[0]!.n;
    expect(Number(others)).toBe(2);
  });
});
