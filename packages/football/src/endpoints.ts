import { ApiFootballClient, type ApiResult } from './client.js';
import type {
  FixtureItem,
  InjuryItem,
  LeagueItem,
  OddsItem,
  PlayerItem,
  PredictionItem,
  StandingsItem,
  TeamItem,
} from './types.js';

/** Max fixture ids per `/fixtures?ids=` call (API limit). */
export const MAX_FIXTURE_IDS_PER_CALL = 20;

/**
 * Typed wrapper around API-Football v3 endpoints.
 * Only this module knows endpoint names/params — no API logic leaks into UI or workers.
 */
export class ApiFootball {
  constructor(readonly client: ApiFootballClient) {}

  status() {
    return this.client.get<unknown>('/status');
  }

  leagues(params: { id?: number; season?: number; current?: boolean; country?: string }) {
    return this.client.get<LeagueItem[]>('/leagues', params);
  }

  teams(params: { league: number; season: number }) {
    return this.client.get<TeamItem[]>('/teams', params);
  }

  /** Fixtures of a league season, a date range (`from`/`to` = YYYY-MM-DD), or the `last` N played of a league. */
  fixtures(params: { league?: number; team?: number; season?: number; from?: string; to?: string; date?: string; status?: string; timezone?: string; last?: number }) {
    return this.client.get<FixtureItem[]>('/fixtures', { timezone: 'UTC', ...params });
  }

  /**
   * Up to 20 fixtures in ONE call, each including events, lineups, statistics and players.
   * This is the most request-efficient way to get match details.
   */
  fixturesByIds(ids: readonly number[]): Promise<ApiResult<FixtureItem[]>> {
    if (ids.length === 0) throw new Error('fixturesByIds: ids is empty');
    if (ids.length > MAX_FIXTURE_IDS_PER_CALL) throw new Error(`fixturesByIds: max ${MAX_FIXTURE_IDS_PER_CALL} ids`);
    return this.client.get<FixtureItem[]>('/fixtures', { ids: ids.join('-'), timezone: 'UTC' });
  }

  headToHead(teamA: number, teamB: number, last = 10) {
    return this.client.get<FixtureItem[]>('/fixtures/headtohead', { h2h: `${teamA}-${teamB}`, last, timezone: 'UTC' });
  }

  injuries(params: { league?: number; season?: number; fixture?: number; date?: string; team?: number }) {
    return this.client.get<InjuryItem[]>('/injuries', { timezone: 'UTC', ...params });
  }

  standings(params: { league: number; season: number }) {
    return this.client.get<StandingsItem[]>('/standings', params);
  }

  predictions(fixture: number) {
    return this.client.get<PredictionItem[]>('/predictions', { fixture });
  }

  /** Paginated. */
  players(params: { league: number; season: number }, maxPages = 100) {
    return this.client.getAllPages<PlayerItem>('/players', params, maxPages);
  }

  /** Pre-match odds. Paginated. */
  odds(params: { league?: number; season?: number; fixture?: number; date?: string; bookmaker?: number; bet?: number }, maxPages = 50) {
    return this.client.getAllPages<OddsItem>('/odds', params, maxPages);
  }

  oddsBookmakers() {
    return this.client.get<Array<{ id: number; name: string }>>('/odds/bookmakers');
  }

  oddsBets() {
    return this.client.get<Array<{ id: number; name: string }>>('/odds/bets');
  }
}
