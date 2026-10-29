import type { JobBudget } from './budget.js';
import type { OddsRow, RawResponseRecord } from '@fp/football';
import { LIVE_STATUSES } from '@fp/shared';
import type { Db, Queryable } from './db.js';
import { insertReturning, insertRows, toParam, writeRows, type Row } from './upsert.js';

/** An unchanged odds quote is stored again only this often (see insertOddsHistory). */
export const ODDS_HEARTBEAT_HOURS = 6;
/** No job runs this long (the longest, tune, took 38 minutes): a RUNNING row older than this was killed. */
export const STALE_RUN_MINUTES = 120;

export interface FinishedMatchRow {
  fixtureId: number;
  kickoffAt: Date;
  homeTeamId: number;
  awayTeamId: number;
  homeGoals: number;
  awayGoals: number;
  homeXg: number | null;
  awayXg: number | null;
  /** Minute of the first red card (either team) within 90'; null = none, or events not synced. */
  redCardMinute: number | null;
  /** Events were synced for this match (so a null redCardMinute really means "no red card"). */
  eventsKnown: boolean;
}

export type TeamMatchRow = Omit<FinishedMatchRow, 'fixtureId' | 'redCardMinute' | 'eventsKnown'> & { season: number };

export interface PlayerStatRow {
  fixtureId: number;
  kickoffAt: Date;
  teamId: number;
  playerId: number;
  minutes: number | null;
  position: string | null;
  rating: number | null;
  goals: number | null;
  assists: number | null;
  shotsTotal: number | null;
  passesKey: number | null;
}

export interface ModelConfigInput {
  leagueId: number;
  purpose: 'SIDES' | 'TOTALS' | 'ELO' | 'ENSEMBLE' | 'IMPACT';
  modelVersionId: string;
  params: Record<string, unknown>;
  metrics: Record<string, unknown>;
  enabled: boolean;
  matchesEvaluated: number;
}

export interface ModelConfig extends ModelConfigInput {
  id: number;
  tunedAt: Date;
}

interface OutcomeDistributionRow {
  win: number;
  halfWin: number;
  push: number;
  halfLoss: number;
  loss: number;
}

function parseJson(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') return JSON.parse(v) as Record<string, unknown>;
  return (v ?? {}) as Record<string, unknown>;
}

/** jsonb column as-is (arrays stay arrays, SQL null stays null). */
function jsonOrNull(v: unknown): unknown {
  return typeof v === 'string' ? JSON.parse(v) : (v ?? null);
}

/**
 * Data-access layer. Workers call these; no SQL elsewhere.
 * Writes are idempotent (safe to re-run any sync job).
 */
export class Repository {
  constructor(readonly db: Db) {}

  // ---------- audit ----------
  async insertRawResponse(rec: RawResponseRecord): Promise<number> {
    const id = await insertReturning<string | number>(this.db, 'api_raw_responses', {
      source: rec.source,
      endpoint: rec.endpoint,
      params: rec.params,
      http_status: rec.httpStatus,
      results: rec.results,
      errors: rec.errors,
      response: rec.response,
      fetched_at: rec.fetchedAt,
    });
    return Number(id);
  }

  /** Delete raw audit rows older than N days (raw_response_id elsewhere is a plain reference). Batched to keep locks short. */
  async pruneRawResponses(olderThanDays: number, batchSize = 500): Promise<number> {
    let total = 0;
    for (;;) {
      const { rows } = await this.db.query<{ n: string | number }>(
        `with doomed as (
           select id from api_raw_responses where fetched_at < now() - make_interval(days => $1) limit $2
         ), gone as (delete from api_raw_responses r using doomed d where r.id = d.id returning 1)
         select count(*) as n from gone`,
        [olderThanDays, batchSize],
      );
      const n = Number(rows[0]?.n ?? 0);
      total += n;
      if (n < batchSize) return total;
    }
  }

  /** Give the freed space back to the OS (plain DELETE only marks it reusable). Locks the table briefly. */
  async vacuumRawResponses(): Promise<void> {
    await this.db.exec('vacuum full api_raw_responses');
  }

  async databaseSizeBytes(): Promise<number> {
    const { rows } = await this.db.query<{ b: string | number }>(`select pg_database_size(current_database()) as b`);
    return Number(rows[0]?.b ?? 0);
  }

  async startSyncRun(job: string, params: Record<string, unknown>): Promise<number> {
    await this.abandonStaleRuns(job);
    return Number(await insertReturning<string | number>(this.db, 'sync_runs', { job, params }));
  }

  /**
   * A run still RUNNING long after it started was killed (a job timeout) and will never finish itself:
   * close it as FAILED so monitoring does not read it as in progress (audit A-11). Returns how many.
   */
  async abandonStaleRuns(job: string, olderThanMinutes = STALE_RUN_MINUTES): Promise<number> {
    const { rows } = await this.db.query<{ id: string | number }>(
      `update sync_runs set status = 'FAILED', finished_at = now(),
              error = 'abandoned: no finish recorded within ' || $2::int || ' minutes (process stopped, e.g. a job timeout)'
        where job = $1 and status = 'RUNNING' and started_at < now() - make_interval(mins => $2::int)
        returning id`,
      [job, olderThanMinutes],
    );
    return rows.length;
  }

  async finishSyncRun(
    id: number,
    r: { status: 'SUCCESS' | 'FAILED'; requestsUsed: number; itemsWritten: number; error?: string; requestsRejected?: number; dailyRemaining?: number | null },
  ) {
    try {
      await this.db.query(
        `update sync_runs set status = $2, requests_used = $3, items_written = $4, error = $5, requests_rejected = $6, api_daily_remaining = $7, finished_at = now() where id = $1`,
        [id, r.status, r.requestsUsed, r.itemsWritten, r.error ?? null, r.requestsRejected ?? 0, r.dailyRemaining ?? null],
      );
    } catch {
      // before migration 0039 the two new columns do not exist: keep finishing runs the old way
      await this.db.query(
        `update sync_runs set status = $2, requests_used = $3, items_written = $4, error = $5, finished_at = now() where id = $1`,
        [id, r.status, r.requestsUsed, r.itemsWritten, r.error ?? null],
      );
    }
  }

  /** Today's use against this job's budget group; null when the budget tables are not there yet (before migration 0039). */
  async apiBudgetFor(job: string): Promise<JobBudget | null> {
    try {
      const { rows } = await this.db.query<{ group_name: string; used: number; daily_cap: number; enforced: boolean }>(
        `select group_name, used, daily_cap, enforced from fp_api_usage_today()
          where group_name = coalesce((select group_name from api_job_groups where job = $1), 'sync')`,
        [job],
      );
      const r = rows[0];
      return r ? { group: r.group_name, used: Number(r.used), cap: Number(r.daily_cap), enforced: r.enforced } : null;
    } catch {
      return null;
    }
  }

  /** A job skipped for its budget. One row per job per 15 minutes, so a 30-second poll does not fill the table. */
  async recordBudgetSkip(job: string, params: Record<string, unknown>): Promise<boolean> {
    const recent = await this.db.query(
      `select 1 from sync_runs where job = $1 and params->>'skipped' = 'budget' and started_at > now() - interval '15 minutes' limit 1`,
      [job],
    );
    if (recent.rows.length) return false;
    const id = await this.startSyncRun(job, { ...params, skipped: 'budget' });
    await this.finishSyncRun(id, { status: 'SUCCESS', requestsUsed: 0, itemsWritten: 0 });
    return true;
  }

  // ---------- reference data ----------
  upsertLeagues(rows: Row[]) {
    return writeRows(this.db, 'leagues', rows, { conflict: ['id'], touch: 'synced_at' });
  }
  insertLeagueStubs(rows: Row[]) {
    return writeRows(this.db, 'leagues', rows, { conflict: ['id'], update: 'nothing' });
  }
  upsertLeagueSeasons(rows: Row[]) {
    return writeRows(this.db, 'league_seasons', rows, { conflict: ['league_id', 'season'], touch: 'synced_at' });
  }
  /** league -> its current season (league_seasons.is_current, from `sync:leagues`). */
  async currentSeasons(leagueIds: number[]): Promise<Map<number, number>> {
    const res = await this.db.query<{ league_id: string | number; season: string | number }>(
      'select league_id, max(season) as season from league_seasons where is_current and league_id = any($1::int[]) group by league_id',
      [leagueIds],
    );
    return new Map(res.rows.map((r) => [Number(r.league_id), Number(r.season)]));
  }
  upsertVenues(rows: Row[]) {
    return writeRows(this.db, 'venues', rows, { conflict: ['id'], touch: 'synced_at' });
  }
  /** Insert venues only if unknown (fixture-derived stubs must not overwrite full rows). */
  insertVenueStubs(rows: Row[]) {
    return writeRows(this.db, 'venues', rows, { conflict: ['id'], update: 'nothing' });
  }
  upsertTeams(rows: Row[]) {
    return writeRows(this.db, 'teams', rows, { conflict: ['id'], touch: 'synced_at' });
  }
  insertTeamStubs(rows: Row[]) {
    return writeRows(this.db, 'teams', rows, { conflict: ['id'], update: 'nothing' });
  }
  upsertTeamSeasons(rows: Row[]) {
    return writeRows(this.db, 'team_seasons', rows, { conflict: ['team_id', 'league_id', 'season'], update: 'nothing' });
  }
  upsertPlayers(rows: Row[]) {
    return writeRows(this.db, 'players', rows, { conflict: ['id'], touch: 'synced_at' });
  }
  upsertPlayerSeasonStats(rows: Row[]) {
    return writeRows(this.db, 'player_season_stats', rows, {
      conflict: ['player_id', 'team_id', 'league_id', 'season'],
      touch: 'synced_at',
    });
  }

  // ---------- fixtures ----------
  upsertFixtures(rows: Row[]) {
    return writeRows(this.db, 'fixtures', rows, { conflict: ['id'], touch: 'synced_at' });
  }

  /** Replace all detail data of one fixture atomically (events/stats/lineups/players). */
  async replaceFixtureDetails(
    fixtureId: number,
    d: { events: Row[]; statistics: Row[]; lineups: Row[]; lineupPlayers: Row[]; playerStats: Row[] },
  ): Promise<number> {
    return this.db.transaction(async (tx: Queryable) => {
      let n = 0;
      // only replace a section if the API returned data for it (never wipe with empty)
      if (d.events.length) {
        await tx.query('delete from fixture_events where fixture_id = $1', [fixtureId]);
        n += await writeRows(tx, 'fixture_events', d.events, { conflict: ['fixture_id', 'seq'] });
      }
      if (d.statistics.length) {
        n += await writeRows(tx, 'fixture_statistics', d.statistics, { conflict: ['fixture_id', 'team_id', 'type'], touch: 'synced_at' });
      }
      if (d.lineups.length) {
        await tx.query('delete from fixture_lineup_players where fixture_id = $1', [fixtureId]);
        n += await writeRows(tx, 'fixture_lineups', d.lineups, { conflict: ['fixture_id', 'team_id'], touch: 'synced_at' });
        if (d.lineupPlayers.length) {
          // no natural key -> plain insert after delete
          n += await insertRows(tx, 'fixture_lineup_players', d.lineupPlayers);
        }
      }
      if (d.playerStats.length) {
        n += await writeRows(tx, 'fixture_player_stats', d.playerStats, { conflict: ['fixture_id', 'player_id'], touch: 'synced_at' });
      }
      return n;
    });
  }

  async markFixtureDetailsSynced(ids: number[]) {
    if (!ids.length) return;
    await this.db.query('update fixtures set details_synced_at = now() where id = any($1::bigint[])', [ids]);
  }

  upsertInjuries(rows: Row[]) {
    return writeRows(this.db, 'injuries', rows, { conflict: ['fixture_id', 'player_id'], update: ['type', 'reason', 'raw'], touch: 'synced_at' });
  }

  upsertStandings(rows: Row[]) {
    return writeRows(this.db, 'standings', rows, { conflict: ['league_id', 'season', 'group_name', 'team_id'], touch: 'synced_at' });
  }

  /**
   * Drops the groups of a league season that the latest API response no longer contains. The upsert key includes the group
   * name, so when the API renames a group (La Liga: 'La Liga' to 'Primera División') the old rows would stay for good, never
   * refreshed, beside the live table. Whole groups only, never single teams, and never with an empty `keep` (an empty or
   * failed response must not wipe a table). Returns the rows removed.
   */
  async pruneStandingGroups(leagueId: number, season: number, keep: string[]): Promise<number> {
    if (!keep.length) return 0;
    const res = await this.db.query<{ n: string | number }>(
      `with gone as (delete from standings where league_id = $1 and season = $2 and not (group_name = any($3::text[])) returning 1)
       select count(*) as n from gone`,
      [leagueId, season, keep],
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  async insertApiPrediction(row: Row): Promise<number> {
    await insertReturning(this.db, 'api_predictions', row);
    return 1;
  }

  // ---------- odds ----------
  upsertBookmakers(rows: Array<{ id: number; name: string }>) {
    return writeRows(this.db, 'bookmakers', rows, { conflict: ['id'], touch: 'synced_at' });
  }

  /** Append-only. Same (fixture, bookmaker, bet, value, update-time) is skipped. Returns rows actually inserted. */
  /**
   * Append quotes, skipping one whose price equals the last stored price for that selection unless
   * that was stored ODDS_HEARTBEAT_HOURS ago or more (pick selection drops quotes older than 12 h).
   */
  async insertOddsHistory(rows: OddsRow[], rawResponseId: number | null) {
    if (!rows.length) return 0;
    const { rows: last } = await this.db.query<{ k: string; odds: string | number; at: string | Date }>(
      `select distinct on (fixture_id, bookmaker_id, api_bet_id, raw_value)
              concat_ws('|', fixture_id, bookmaker_id, api_bet_id, raw_value) as k, odds, source_updated_at as at
         from odds_history
        where fixture_id = any($1::bigint[]) and bookmaker_id = any($2::int[])
        order by fixture_id, bookmaker_id, api_bet_id, raw_value, source_updated_at desc`,
      [[...new Set(rows.map((r) => r.fixtureId))], [...new Set(rows.map((r) => r.bookmakerId))]],
    );
    const stored = new Map(last.map((r) => [r.k, { odds: Number(r.odds), at: new Date(r.at).getTime() }]));
    const fresh = rows.filter((r) => {
      const prev = stored.get([r.fixtureId, r.bookmakerId, r.apiBetId, r.rawValue].join('|'));
      return !prev || prev.odds !== r.odds || Date.parse(r.sourceUpdatedAt) - prev.at >= ODDS_HEARTBEAT_HOURS * 3_600_000;
    });
    return writeRows(
      this.db,
      'odds_history',
      fresh.map((r) => ({
        fixture_id: r.fixtureId,
        bookmaker_id: r.bookmakerId,
        market: r.market,
        api_bet_id: r.apiBetId,
        api_bet_name: r.apiBetName,
        selection: r.selection,
        line: r.line,
        home_line: r.homeLine,
        raw_value: r.rawValue,
        odds: r.odds,
        source_updated_at: r.sourceUpdatedAt,
        raw_response_id: rawResponseId,
      })),
      { conflict: ['fixture_id', 'bookmaker_id', 'api_bet_id', 'raw_value', 'source_updated_at'], update: 'nothing' },
    );
  }

  // ---------- read queries for workers ----------
  async existingFixtureIds(ids: number[]): Promise<Set<number>> {
    if (!ids.length) return new Set();
    const res = await this.db.query<{ id: string | number }>('select id from fixtures where id = any($1::bigint[])', [ids]);
    return new Set(res.rows.map((r) => Number(r.id)));
  }

  /** Finished fixtures whose details are missing or were synced before full time (+ a buffer). */
  async fixturesNeedingDetails(leagueIds: number[], limit = 200, seasons?: number[]): Promise<number[]> {
    const res = await this.db.query<{ id: string | number }>(
      `select id from fixtures
        where league_id = any($1::int[])
          and ($3::int[] is null or season = any($3::int[]))
          and status_short in ('FT','AET','PEN')
          and (details_synced_at is null or details_synced_at < kickoff_at + interval '3 hours')
        order by kickoff_at desc
        limit $2`,
      [leagueIds, limit, seasons?.length ? seasons : null],
    );
    return res.rows.map((r) => Number(r.id));
  }

  async upcomingFixtures(leagueIds: number[], fromIso: string, toIso: string): Promise<Array<{ id: number; kickoff_at: string; league_id: number }>> {
    const res = await this.db.query<{ id: string | number; kickoff_at: string | Date; league_id: number }>(
      `select id, kickoff_at, league_id from fixtures
        where league_id = any($1::int[]) and status_short in ('NS','TBD')
          and kickoff_at >= $2 and kickoff_at <= $3
        order by kickoff_at`,
      [leagueIds, fromIso, toIso],
    );
    return res.rows.map((r) => ({ id: Number(r.id), kickoff_at: new Date(r.kickoff_at).toISOString(), league_id: r.league_id }));
  }

  // ---------- probability engine ----------

  /** Finished matches of a league (all seasons in DB) with 90-min score, xG and first red card when available. */
  async finishedMatches(leagueId: number): Promise<FinishedMatchRow[]> {
    const res = await this.db.query<Record<string, unknown>>(
      `select f.id, f.kickoff_at, f.home_team_id, f.away_team_id,
              coalesce(f.ft_home, f.goals_home) as gh,
              coalesce(f.ft_away, f.goals_away) as ga,
              xh.value_num as xg_home, xa.value_num as xg_away,
              (select min(e.elapsed) from fixture_events e
                where e.fixture_id = f.id and e.type = 'Card' and e.elapsed <= 90
                  and lower(e.detail) in ('red card', 'second yellow card')) as red_minute,
              exists (select 1 from fixture_events e where e.fixture_id = f.id) as events_known
         from fixtures f
         left join fixture_statistics xh on xh.fixture_id = f.id and xh.team_id = f.home_team_id and xh.type = 'expected_goals'
         left join fixture_statistics xa on xa.fixture_id = f.id and xa.team_id = f.away_team_id and xa.type = 'expected_goals'
        where f.league_id = $1
          and f.status_short in ('FT','AET','PEN')
          and coalesce(f.ft_home, f.goals_home) is not null
          and coalesce(f.ft_away, f.goals_away) is not null
        order by f.kickoff_at`,
      [leagueId],
    );
    return res.rows.map((r) => ({
      fixtureId: Number(r.id),
      kickoffAt: new Date(r.kickoff_at as string),
      homeTeamId: Number(r.home_team_id),
      awayTeamId: Number(r.away_team_id),
      homeGoals: Number(r.gh),
      awayGoals: Number(r.ga),
      homeXg: r.xg_home == null ? null : Number(r.xg_home),
      awayXg: r.xg_away == null ? null : Number(r.xg_away),
      redCardMinute: r.red_minute == null ? null : Number(r.red_minute),
      eventsKnown: Boolean(r.events_known),
    }));
  }

  /**
   * Every finished match in every competition we hold, per team, oldest first: score, xG when known,
   * and the season. The market-anchored model reads a team's recent finishing and its season so far
   * from all of its matches, not only those of the competition it plays in today.
   */
  async teamMatchLog(): Promise<Map<number, TeamMatchRow[]>> {
    const res = await this.db.query<Record<string, unknown>>(
      `select f.kickoff_at, f.season, f.home_team_id, f.away_team_id,
              coalesce(f.ft_home, f.goals_home) as gh, coalesce(f.ft_away, f.goals_away) as ga,
              xh.value_num as xg_home, xa.value_num as xg_away
         from fixtures f
         left join fixture_statistics xh on xh.fixture_id = f.id and xh.team_id = f.home_team_id and xh.type = 'expected_goals'
         left join fixture_statistics xa on xa.fixture_id = f.id and xa.team_id = f.away_team_id and xa.type = 'expected_goals'
        where f.status_short in ('FT','AET','PEN')
          and coalesce(f.ft_home, f.goals_home) is not null and coalesce(f.ft_away, f.goals_away) is not null
        order by f.kickoff_at`,
    );
    const out = new Map<number, TeamMatchRow[]>();
    for (const r of res.rows) {
      const m = {
        kickoffAt: new Date(r.kickoff_at as string),
        season: Number(r.season),
        homeTeamId: Number(r.home_team_id),
        awayTeamId: Number(r.away_team_id),
        homeGoals: Number(r.gh),
        awayGoals: Number(r.ga),
        homeXg: r.xg_home == null ? null : Number(r.xg_home),
        awayXg: r.xg_away == null ? null : Number(r.xg_away),
      };
      for (const id of [m.homeTeamId, m.awayTeamId]) (out.get(id) ?? out.set(id, []).get(id)!).push(m);
    }
    return out;
  }

  async upcomingFixturesWithTeams(leagueId: number, fromIso: string, toIso: string) {
    const res = await this.db.query<Record<string, unknown>>(
      `select id, kickoff_at, home_team_id, away_team_id from fixtures
        where league_id = $1 and status_short in ('NS','TBD') and kickoff_at >= $2 and kickoff_at <= $3
        order by kickoff_at`,
      [leagueId, fromIso, toIso],
    );
    return res.rows.map((r) => ({
      id: Number(r.id),
      kickoffAt: new Date(r.kickoff_at as string),
      homeTeamId: Number(r.home_team_id),
      awayTeamId: Number(r.away_team_id),
    }));
  }

  /** Lines the market actually offers for this fixture (so we price what can be compared). */
  async offeredLines(fixtureId: number): Promise<{ ahHome: number[]; ou: number[] }> {
    const res = await this.db.query<{ market: string; v: string | number }>(
      `select distinct market, case when market = 'ASIAN_HANDICAP' then home_line else line end as v
         from odds_history
        where fixture_id = $1 and market in ('ASIAN_HANDICAP','OVER_UNDER')
          and (case when market = 'ASIAN_HANDICAP' then home_line else line end) is not null`,
      [fixtureId],
    );
    return {
      ahHome: res.rows.filter((r) => r.market === 'ASIAN_HANDICAP').map((r) => Number(r.v)),
      ou: res.rows.filter((r) => r.market === 'OVER_UNDER').map((r) => Number(r.v)),
    };
  }

  ensureModelVersion(id: string, description: string, params: Record<string, unknown>) {
    return writeRows(this.db, 'model_versions', [{ id, description, params }], { conflict: ['id'], update: 'nothing' });
  }

  async lastProbabilityAt(fixtureId: number, modelVersionId: string): Promise<Date | null> {
    const res = await this.db.query<{ t: string | Date | null }>(
      'select max(computed_at) as t from probability_predictions where fixture_id = $1 and model_version_id = $2',
      [fixtureId, modelVersionId],
    );
    const t = res.rows[0]?.t;
    return t ? new Date(t) : null;
  }

  /** Insert-only. */
  insertProbabilityPredictions(rows: Row[]) {
    return writeRows(this.db, 'probability_predictions', rows, {
      conflict: ['fixture_id', 'model_version_id', 'computed_at', 'market', 'selection', 'line'],
      update: 'nothing',
    });
  }

  /** Insert-only per (fixture, model version, computed_at, source); a re-run of the same instant changes nothing. */
  insertScorelineSnapshot(row: Row) {
    return writeRows(this.db, 'scoreline_snapshots', [row], {
      conflict: ['fixture_id', 'model_version_id', 'computed_at', 'source'],
      update: 'nothing',
    });
  }

  // ---------- cup ties and qualification (slice 04) ----------
  async competitionRuleRows() {
    try {
      const { rows } = await this.db.query<{ league_id: number; from_season: number; stage: string; legs: number; away_goals: boolean; extra_time: boolean; penalties: boolean; neutral_venue: boolean }>(
        'select league_id, from_season, stage, legs, away_goals, extra_time, penalties, neutral_venue from competition_rules',
      );
      return rows;
    } catch {
      return []; // before migration 0040 there are no rules: nothing to forecast, and the hourly run goes on
    }
  }

  /** Fixtures of the given competitions kicking off in [from, to), with 90-minute / extra-time / shoot-out goals. */
  async cupFixtureRows(leagueIds: number[], from: Date, to: Date) {
    const { rows } = await this.db.query<{
      id: number; league_id: number; season: number; round: string | null; kickoff_at: Date; home_team_id: number; away_team_id: number; status_short: string;
      ft_home: number | null; ft_away: number | null; et_home: number | null; et_away: number | null; pen_home: number | null; pen_away: number | null;
    }>(
      `select id, league_id, season, round, kickoff_at, home_team_id, away_team_id, status_short, ft_home, ft_away, et_home, et_away, pen_home, pen_away
         from fixtures where league_id = any($1::int[]) and kickoff_at >= $2 and kickoff_at < $3 order by kickoff_at`,
      [leagueIds, from.toISOString(), to.toISOString()],
    );
    return rows;
  }

  /** The sides scoreline matrix (1X2 / handicap) of the last live run before `before`, or null. */
  async latestSidesMatrix(fixtureId: number, before: Date, modelVersion: string): Promise<number[][] | null> {
    const { rows } = await this.db.query<{ sides_matrix: number[][] }>(
      `select sides_matrix from scoreline_snapshots where fixture_id = $1 and model_version_id = $2 and source = 'live' and computed_at < $3 order by computed_at desc limit 1`,
      [fixtureId, modelVersion, before.toISOString()],
    );
    return rows[0]?.sides_matrix ?? null;
  }

  /** The totals scoreline matrix (over/under) of the live run at `computedAt`, or null when that run kept none. */
  async totalsMatrixAt(fixtureId: number, modelVersion: string, computedAt: Date): Promise<number[][] | null> {
    const { rows } = await this.db.query<{ totals_matrix: number[][] }>(
      `select totals_matrix from scoreline_snapshots where fixture_id = $1 and model_version_id = $2 and source = 'live' and computed_at = $3 limit 1`,
      [fixtureId, modelVersion, computedAt.toISOString()],
    );
    return rows[0]?.totals_matrix ?? null;
  }

  async lastQualificationAt(fixtureId: number): Promise<Date | null> {
    const { rows } = await this.db.query<{ t: Date }>('select max(computed_at) as t from qualification_snapshots where fixture_id = $1', [fixtureId]);
    return rows[0]?.t ? new Date(rows[0].t) : null;
  }

  /** Insert-only per (fixture, model version, computed_at, source). */
  insertQualificationSnapshot(row: Row) {
    return writeRows(this.db, 'qualification_snapshots', [row], { conflict: ['fixture_id', 'model_version_id', 'computed_at', 'source'], update: 'nothing' });
  }

  async insertModelConfigs(rows: ModelConfigInput[]): Promise<number> {
    let n = 0;
    for (const r of rows) {
      await insertReturning(this.db, 'model_configs', {
        league_id: r.leagueId,
        purpose: r.purpose,
        model_version_id: r.modelVersionId,
        params: r.params,
        metrics: r.metrics,
        enabled: r.enabled,
        matches_evaluated: r.matchesEvaluated,
      });
      n++;
    }
    return n;
  }

  /** Active (latest) config per purpose for a league; `asOf` (a replay): the configs that were active then. */
  async latestModelConfigs(leagueId: number, asOf?: Date): Promise<Partial<Record<ModelConfigInput['purpose'], ModelConfig>>> {
    const res = await this.db.query<Record<string, unknown>>(
      asOf
        ? `select distinct on (purpose) id, purpose, model_version_id, params, metrics, enabled, matches_evaluated, tuned_at
             from model_configs where league_id = $1 and tuned_at <= $2
            order by purpose, tuned_at desc, id desc`
        : 'select id, purpose, model_version_id, params, metrics, enabled, matches_evaluated, tuned_at from model_configs_latest where league_id = $1',
      asOf ? [leagueId, asOf.toISOString()] : [leagueId],
    );
    const out: Partial<Record<ModelConfigInput['purpose'], ModelConfig>> = {};
    for (const r of res.rows) {
      const purpose = r.purpose as ModelConfigInput['purpose'];
      out[purpose] = {
        id: Number(r.id),
        leagueId,
        purpose,
        modelVersionId: String(r.model_version_id),
        params: parseJson(r.params),
        metrics: parseJson(r.metrics),
        enabled: Boolean(r.enabled),
        matchesEvaluated: Number(r.matches_evaluated),
        tunedAt: new Date(r.tuned_at as string),
      };
    }
    return out;
  }

  // ---------- player impact ----------

  private mapPlayerStat(r: Record<string, unknown>): PlayerStatRow {
    const n = (v: unknown) => (v == null ? null : Number(v));
    return {
      fixtureId: Number(r.fixture_id),
      kickoffAt: new Date(r.kickoff_at as string),
      teamId: Number(r.team_id),
      playerId: Number(r.player_id),
      minutes: n(r.minutes),
      position: (r.position as string | null) ?? null,
      rating: n(r.rating),
      goals: n(r.goals),
      assists: n(r.assists),
      shotsTotal: n(r.shots_total),
      passesKey: n(r.passes_key),
    };
  }

  private static readonly PLAYER_STAT_COLS = `s.fixture_id, f.kickoff_at, s.team_id, s.player_id, s.minutes, s.position, s.rating,
              s.goals, s.assists, s.shots_total, s.passes_key`;

  /** Player match stats of the given teams (any competition) in the window before `before`. */
  async playerStatsForTeams(teamIds: number[], before: Date, days = 400): Promise<PlayerStatRow[]> {
    const res = await this.db.query<Record<string, unknown>>(
      `select ${Repository.PLAYER_STAT_COLS}
         from fixture_player_stats s join fixtures f on f.id = s.fixture_id
        where s.team_id = any($1::int[]) and f.kickoff_at < $2 and f.kickoff_at >= $2::timestamptz - make_interval(days => $3)`,
      [teamIds, before.toISOString(), days],
    );
    return res.rows.map((r) => this.mapPlayerStat(r));
  }

  /** All player match stats for fixtures of a league (for calibration). */
  async playerStatsForLeague(leagueId: number): Promise<PlayerStatRow[]> {
    const res = await this.db.query<Record<string, unknown>>(
      `select ${Repository.PLAYER_STAT_COLS}
         from fixture_player_stats s join fixtures f on f.id = s.fixture_id
        where f.league_id = $1`,
      [leagueId],
    );
    return res.rows.map((r) => this.mapPlayerStat(r));
  }

  private async lineupsWhere(where: string, param: number): Promise<Map<string, { starters: Set<number>; bench: Set<number> }>> {
    const res = await this.db.query<{ fixture_id: string | number; team_id: number; player_id: number | null; is_starter: boolean }>(
      `select lp.fixture_id, lp.team_id, lp.player_id, lp.is_starter
         from fixture_lineup_players lp join fixtures f on f.id = lp.fixture_id
        where ${where} = $1 and lp.player_id is not null`,
      [param],
    );
    const out = new Map<string, { starters: Set<number>; bench: Set<number> }>();
    for (const r of res.rows) {
      const k = `${Number(r.fixture_id)}:${Number(r.team_id)}`;
      const e = out.get(k) ?? { starters: new Set<number>(), bench: new Set<number>() };
      (r.is_starter ? e.starters : e.bench).add(Number(r.player_id));
      out.set(k, e);
    }
    return out;
  }

  /** key = `${fixtureId}:${teamId}` */
  lineupsForLeague(leagueId: number) {
    return this.lineupsWhere('f.league_id', leagueId);
  }

  lineupsForFixture(fixtureId: number) {
    return this.lineupsWhere('f.id', fixtureId);
  }

  /**
   * Whether API-Football reports injuries for a fixture's league season (league_seasons.coverage.injuries).
   * null when the season or its coverage was never synced: unknown, so callers keep using the injuries list.
   */
  async injuriesCovered(fixtureId: number): Promise<boolean | null> {
    const res = await this.db.query<{ injuries: boolean | null }>(
      `select (s.coverage->>'injuries')::boolean as injuries
         from fixtures f join league_seasons s on s.league_id = f.league_id and s.season = f.season
        where f.id = $1`,
      [fixtureId],
    );
    return res.rows[0]?.injuries ?? null;
  }

  async injuriesForFixture(fixtureId: number) {
    const res = await this.db.query<{ team_id: number | null; player_id: number | null; type: string | null }>(
      'select team_id, player_id, type from injuries where fixture_id = $1',
      [fixtureId],
    );
    return res.rows.map((r) => ({ teamId: r.team_id == null ? null : Number(r.team_id), playerId: r.player_id == null ? null : Number(r.player_id), type: r.type }));
  }

  async playerNames(ids: number[]): Promise<Map<number, string>> {
    if (!ids.length) return new Map();
    const res = await this.db.query<{ id: number; name: string }>(
      `select id, name from players where id = any($1::int[])
       union
       select distinct on (player_id) player_id as id, player_name as name from fixture_lineup_players
        where player_id = any($1::int[]) and player_name is not null`,
      [ids],
    );
    return new Map(res.rows.map((r) => [Number(r.id), r.name]));
  }

  // ---------- settlement ----------

  /**
   * Fixtures whose result we still need: kicked off > 105 min ago, not final/void yet,
   * within the last `days` — plus any fixture that still has a PENDING analysis.
   */
  /**
   * Live-score gate: matches in play, or kicking off within a minute (status still NS until the
   * API flips it). Pure DB check, so polling it costs no API requests while nothing is on.
   */
  async liveWindowFixtureIds(leagueIds: number[], now: Date, limit = 100): Promise<number[]> {
    const res = await this.db.query<{ id: string | number }>(
      `select id from fixtures f
        where f.league_id = any($1::int[])
          and f.status_short not in ('FT','AET','PEN','PST','CANC','ABD','AWD','WO')
          and f.kickoff_at <= $2::timestamptz + interval '1 minute'
          and (f.kickoff_at > $2::timestamptz - interval '3 hours'
               or (f.status_short = any($3::text[]) and f.kickoff_at > $2::timestamptz - interval '6 hours'))
        order by f.kickoff_at, f.id
        limit $4`,
      [leagueIds, now.toISOString(), [...LIVE_STATUSES], limit],
    );
    return res.rows.map((r) => Number(r.id));
  }

  async fixturesAwaitingResult(leagueIds: number[], now: Date, days = 14, limit = 400): Promise<number[]> {
    const res = await this.db.query<{ id: string | number }>(
      `select id from fixtures f
        where f.kickoff_at < $2::timestamptz - interval '105 minutes'
          and f.status_short not in ('FT','AET','PEN','CANC','ABD','AWD','WO')
          and ((f.league_id = any($1::int[]) and f.kickoff_at > $2::timestamptz - make_interval(days => $3))
               or exists (select 1 from analysis_predictions p where p.fixture_id = f.id and p.status = 'PENDING'))
        order by f.kickoff_at
        limit $4`,
      [leagueIds, now.toISOString(), days, limit],
    );
    return res.rows.map((r) => Number(r.id));
  }

  /** PENDING analyses whose (published) kickoff has passed, with the fixture's current state. */
  async pendingSettlements(now: Date) {
    const res = await this.db.query<Record<string, unknown>>(
      `select p.id, p.public_id, p.fixture_id, p.market, p.selection, p.line, p.kickoff_at, p.odds_at_publish,
              f.status_short, f.kickoff_at as fixture_kickoff_at, f.synced_at,
              coalesce(f.ft_home, f.goals_home) as gh, coalesce(f.ft_away, f.goals_away) as ga
         from analysis_predictions p join fixtures f on f.id = p.fixture_id
        where p.status = 'PENDING' and p.kickoff_at < $1
        order by p.kickoff_at, p.id`,
      [now.toISOString()],
    );
    const num = (v: unknown) => (v == null ? null : Number(v));
    return res.rows.map((r) => ({
      id: Number(r.id),
      publicId: String(r.public_id),
      fixtureId: Number(r.fixture_id),
      market: r.market == null ? null : String(r.market),
      selection: r.selection == null ? null : String(r.selection),
      line: num(r.line),
      kickoffAt: new Date(r.kickoff_at as string),
      oddsAtPublish: num(r.odds_at_publish),
      fixture: {
        statusShort: String(r.status_short),
        kickoffAt: new Date(r.fixture_kickoff_at as string),
        home: num(r.gh),
        away: num(r.ga),
        syncedAt: new Date(r.synced_at as string),
      },
    }));
  }

  /** Each bookmaker's last pre-kickoff odds for one selection (see view odds_closing). */
  async closingOdds(fixtureId: number, market: string, selection: string, line: number | null): Promise<number[]> {
    const res = await this.db.query<{ closing_odds: string | number }>(
      `select closing_odds from odds_closing
        where fixture_id = $1 and market = $2 and selection = $3 and line is not distinct from $4::numeric`,
      [fixtureId, market, selection, line],
    );
    return res.rows.map((r) => Number(r.closing_odds));
  }

  /**
   * Write the final status once (DB trigger rejects a second settlement and sets settled_at).
   * Returns false if the row was no longer PENDING (settled by a concurrent run).
   */
  async settlePrediction(id: number, s: { status: string; resultScore: string; closingOdds: number | null; clv: number | null }): Promise<boolean> {
    const res = await this.db.query<{ id: string | number }>(
      `update analysis_predictions
          set status = $2, result_score = $3,
              closing_odds = coalesce(closing_odds, $4::numeric), clv = coalesce(clv, $5::numeric)
        where id = $1 and status = 'PENDING'
        returning id`,
      [id, s.status, s.resultScore, s.closingOdds, s.clv],
    );
    return res.rows.length > 0;
  }

  // ---------- AI shadow ranking (Phase 6b) ----------

  /** Published analyses still before kickoff (with a margin) that have no shadow ranking yet. */
  async publishedAwaitingShadow(now: Date, marginMinutes = 5, limit = 50) {
    const res = await this.db.query<Record<string, unknown>>(
      `select p.id, p.fixture_id, p.publish_round, p.kind, p.market, p.selection, p.line,
              s.form_snapshot, s.xg_snapshot, s.injury_snapshot, s.lineup_snapshot, s.api_prediction_snapshot,
              s.model_snapshot, s.candidates_snapshot,
              f.kickoff_at, f.home_team_id, f.away_team_id, th.name as home, ta.name as away, l.name as league
         from analysis_predictions p
         join analysis_snapshots s on s.analysis_prediction_id = p.id
         join fixtures f on f.id = p.fixture_id
         join teams th on th.id = f.home_team_id
         join teams ta on ta.id = f.away_team_id
         join leagues l on l.id = f.league_id
        where p.kickoff_at > $1::timestamptz + make_interval(mins => $2)
          and not exists (select 1 from ai_shadow_rankings a where a.analysis_prediction_id = p.id)
          -- the shadow ranking is a second opinion on the rules' pick, not on the Hybrid AI's own (ADR 0010)
          and coalesce(p.decision_rule_version, '') not like 'hybrid-%'
        order by p.kickoff_at, p.id
        limit $3`,
      [now.toISOString(), marginMinutes, limit],
    );
    return res.rows.map((r) => ({
      predictionId: Number(r.id),
      publishRound: String(r.publish_round),
      rules: { kind: String(r.kind), market: r.market == null ? null : String(r.market), selection: r.selection == null ? null : String(r.selection), line: r.line == null ? null : Number(r.line) },
      fixture: {
        home: String(r.home),
        away: String(r.away),
        league: String(r.league),
        kickoffAt: new Date(r.kickoff_at as string),
        homeTeamId: Number(r.home_team_id),
        awayTeamId: Number(r.away_team_id),
      },
      snapshot: {
        form_snapshot: jsonOrNull(r.form_snapshot),
        xg_snapshot: jsonOrNull(r.xg_snapshot),
        injury_snapshot: jsonOrNull(r.injury_snapshot),
        lineup_snapshot: jsonOrNull(r.lineup_snapshot),
        api_prediction_snapshot: jsonOrNull(r.api_prediction_snapshot),
        model_snapshot: jsonOrNull(r.model_snapshot),
        candidates_snapshot: jsonOrNull(r.candidates_snapshot),
      },
    }));
  }

  /** Insert-only; the DB trigger rejects it at/after kickoff. */
  async insertShadowRanking(row: Row): Promise<number> {
    return Number(await insertReturning(this.db, 'ai_shadow_rankings', row));
  }

  /** AI picks not settled yet whose kickoff has passed, with the fixture's current state. */
  async pendingShadowSettlements(now: Date) {
    const res = await this.db.query<Record<string, unknown>>(
      `select a.id, a.fixture_id, a.pick_market, a.pick_selection, a.pick_line, a.pick_odds, a.kickoff_at,
              f.status_short, f.kickoff_at as fixture_kickoff_at, f.synced_at,
              coalesce(f.ft_home, f.goals_home) as gh, coalesce(f.ft_away, f.goals_away) as ga
         from ai_shadow_rankings a join fixtures f on f.id = a.fixture_id
        where a.ai_status is null and a.pick_market is not null and a.kickoff_at < $1
        order by a.kickoff_at, a.id`,
      [now.toISOString()],
    );
    const num = (v: unknown) => (v == null ? null : Number(v));
    return res.rows.map((r) => ({
      id: Number(r.id),
      fixtureId: Number(r.fixture_id),
      market: String(r.pick_market),
      selection: String(r.pick_selection),
      line: num(r.pick_line),
      odds: num(r.pick_odds),
      kickoffAt: new Date(r.kickoff_at as string),
      fixture: {
        statusShort: String(r.status_short),
        kickoffAt: new Date(r.fixture_kickoff_at as string),
        home: num(r.gh),
        away: num(r.ga),
        syncedAt: new Date(r.synced_at as string),
      },
    }));
  }

  async settleShadow(id: number, s: { status: string; resultScore: string; closingOdds: number | null; clv: number | null }): Promise<boolean> {
    const res = await this.db.query<{ id: string | number }>(
      `update ai_shadow_rankings
          set ai_status = $2, ai_result_score = $3, ai_closing_odds = $4::numeric, ai_clv = $5::numeric
        where id = $1 and ai_status is null
        returning id`,
      [id, s.status, s.resultScore, s.closingOdds, s.clv],
    );
    return res.rows.length > 0;
  }

  // ---------- publish ----------

  async publication(fixtureId: number, round: string): Promise<{ kind: string; publishedAt: Date; rulesVersion: string | null } | null> {
    const res = await this.db.query<{ kind: string; published_at: string | Date; decision_rule_version: string | null }>(
      'select kind, published_at, decision_rule_version from analysis_predictions where fixture_id = $1 and publish_round = $2',
      [fixtureId, round],
    );
    const r = res.rows[0];
    return r ? { kind: String(r.kind), publishedAt: new Date(r.published_at), rulesVersion: r.decision_rule_version ?? null } : null;
  }

  /** When the league's pick gates (sides / totals) were last tuned. */
  async gateTunedAt(leagueId: number): Promise<Date | null> {
    const res = await this.db.query<{ t: string | Date | null }>(`select max(tuned_at) as t from model_configs_latest where league_id = $1 and purpose in ('SIDES','TOTALS')`, [leagueId]);
    const t = res.rows[0]?.t;
    return t ? new Date(t) : null;
  }

  async isPublished(fixtureId: number, round: string): Promise<boolean> {
    const res = await this.db.query('select 1 from analysis_predictions where fixture_id = $1 and publish_round = $2', [fixtureId, round]);
    return res.rows.length > 0;
  }

  async latestRun(fixtureId: number, rulesVersion: string) {
    const res = await this.db.query<Record<string, unknown>>(
      `select id, outcome, started_at, summary, inputs, model_version_id, decision_rule_version
         from analysis_runs where fixture_id = $1 and decision_rule_version = $2
        order by started_at desc, id desc limit 1`,
      [fixtureId, rulesVersion],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: String(r.id),
      outcome: String(r.outcome) as 'SIGNAL' | 'NO_CLEAR_SIGNAL',
      startedAt: new Date(r.started_at as string),
      summary: parseJson(r.summary),
      inputs: parseJson(r.inputs),
      modelVersionId: r.model_version_id == null ? null : String(r.model_version_id),
      rulesVersion: String(r.decision_rule_version),
    };
  }

  async runCandidates(runId: string) {
    const res = await this.db.query<Record<string, unknown>>(
      `select id, market, selection, line, odds, model_probability, market_probability, edge, support_score, rank, factors
         from analysis_candidates where run_id = $1 order by rank nulls last, support_score desc`,
      [runId],
    );
    return res.rows.map((r) => ({
      id: Number(r.id),
      market: String(r.market),
      selection: String(r.selection),
      line: r.line == null ? null : Number(r.line),
      odds: r.odds == null ? null : Number(r.odds),
      modelProbability: Number(r.model_probability),
      marketProbability: r.market_probability == null ? null : Number(r.market_probability),
      edge: r.edge == null ? null : Number(r.edge),
      rank: r.rank == null ? null : Number(r.rank),
      factors: parseJson(r.factors),
    }));
  }

  async fixtureHeader(fixtureId: number) {
    const res = await this.db.query<Record<string, unknown>>(
      `select f.id, f.league_id, f.season, f.round, f.kickoff_at, f.home_team_id, f.away_team_id, th.name as home, ta.name as away,
              l.name as league, l.type as league_type, l.country as league_country
         from fixtures f join teams th on th.id = f.home_team_id join teams ta on ta.id = f.away_team_id
         join leagues l on l.id = f.league_id where f.id = $1`,
      [fixtureId],
    );
    const r = res.rows[0];
    return r
      ? {
          id: Number(r.id),
          leagueId: Number(r.league_id),
          season: Number(r.season),
          round: r.round == null ? null : String(r.round),
          kickoffAt: new Date(r.kickoff_at as string),
          homeTeamId: Number(r.home_team_id),
          awayTeamId: Number(r.away_team_id),
          home: String(r.home),
          away: String(r.away),
          league: String(r.league),
          leagueType: r.league_type == null ? null : String(r.league_type),
          leagueCountry: r.league_country == null ? null : String(r.league_country),
        }
      : null;
  }

  /** When the confirmed lineup was stored (null = no lineup row). */
  async lineupSyncedAt(fixtureId: number): Promise<Date | null> {
    const res = await this.db.query<{ t: string | Date | null }>('select max(synced_at) as t from fixture_lineups where fixture_id = $1', [fixtureId]);
    const t = res.rows[0]?.t;
    return t ? new Date(t) : null;
  }

  /** Last n finished results of a team before a date (for the snapshot). */
  async teamForm(teamId: number, before: Date, n = 5) {
    const res = await this.db.query<Record<string, unknown>>(
      `select f.id, f.kickoff_at, f.home_team_id, f.away_team_id, th.name as home_name, ta.name as away_name,
              coalesce(f.ft_home, f.goals_home) as gh, coalesce(f.ft_away, f.goals_away) as ga,
              xh.value_num as xg_home, xa.value_num as xg_away
         from fixtures f
         join teams th on th.id = f.home_team_id
         join teams ta on ta.id = f.away_team_id
         left join fixture_statistics xh on xh.fixture_id = f.id and xh.team_id = f.home_team_id and xh.type = 'expected_goals'
         left join fixture_statistics xa on xa.fixture_id = f.id and xa.team_id = f.away_team_id and xa.type = 'expected_goals'
        where (f.home_team_id = $1 or f.away_team_id = $1) and f.status_short in ('FT','AET','PEN') and f.kickoff_at < $2
        order by f.kickoff_at desc limit $3`,
      [teamId, before.toISOString(), n],
    );
    return res.rows.map((r) => {
      const home = Number(r.home_team_id) === teamId;
      const gf = Number(home ? r.gh : r.ga);
      const ga = Number(home ? r.ga : r.gh);
      const xf = home ? r.xg_home : r.xg_away;
      const xa = home ? r.xg_away : r.xg_home;
      return {
        fixtureId: Number(r.id),
        kickoffAt: new Date(r.kickoff_at as string).toISOString(),
        venue: home ? 'H' : 'A',
        opponent: String(home ? r.away_name : r.home_name),
        goalsFor: gf,
        goalsAgainst: ga,
        result: gf > ga ? 'W' : gf < ga ? 'L' : 'D',
        xgFor: xf == null ? null : Number(xf),
        xgAgainst: xa == null ? null : Number(xa),
      };
    });
  }

  /**
   * The Hybrid AI's form data (ADR 0010): a team's last n finished matches before `before`, any competition,
   * from its side: score, xG and shots, and the opponent's position in that competition's table (the table as
   * synced now; null when the competition has none).
   */
  async teamRecentMatches(teamId: number, before: Date, n = 10) {
    const res = await this.db.query<Record<string, unknown>>(
      `select f.kickoff_at, f.home_team_id, l.name as competition, th.name as home_name, ta.name as away_name,
              coalesce(f.ft_home, f.goals_home) as gh, coalesce(f.ft_away, f.goals_away) as ga,
              max(s.value_num) filter (where s.type = 'expected_goals' and s.team_id = f.home_team_id) as xg_h,
              max(s.value_num) filter (where s.type = 'expected_goals' and s.team_id = f.away_team_id) as xg_a,
              max(s.value_num) filter (where s.type = 'shots_on_goal' and s.team_id = f.home_team_id) as sot_h,
              max(s.value_num) filter (where s.type = 'shots_on_goal' and s.team_id = f.away_team_id) as sot_a,
              max(s.value_num) filter (where s.type = 'total_shots' and s.team_id = f.home_team_id) as sh_h,
              max(s.value_num) filter (where s.type = 'total_shots' and s.team_id = f.away_team_id) as sh_a,
              (select st.rank from standings st where st.league_id = f.league_id and st.season = f.season
                  and st.team_id = case when f.home_team_id = $1 then f.away_team_id else f.home_team_id end limit 1) as opp_rank,
              (select count(*) from standings st where st.league_id = f.league_id and st.season = f.season
                  and st.group_name = (select g.group_name from standings g where g.league_id = f.league_id and g.season = f.season
                                         and g.team_id = case when f.home_team_id = $1 then f.away_team_id else f.home_team_id end limit 1)) as table_size
         from fixtures f
         join leagues l on l.id = f.league_id
         join teams th on th.id = f.home_team_id
         join teams ta on ta.id = f.away_team_id
         left join fixture_statistics s on s.fixture_id = f.id and s.type in ('expected_goals', 'shots_on_goal', 'total_shots')
        where (f.home_team_id = $1 or f.away_team_id = $1) and f.status_short in ('FT','AET','PEN') and f.kickoff_at < $2
          and coalesce(f.ft_home, f.goals_home) is not null
        group by f.id, l.name, th.name, ta.name
        order by f.kickoff_at desc limit $3`,
      [teamId, before.toISOString(), n],
    );
    const num = (v: unknown) => (v == null ? null : Number(v));
    return res.rows.map((r) => {
      const home = Number(r.home_team_id) === teamId;
      const rank = num(r.opp_rank);
      return {
        kickoffAt: new Date(r.kickoff_at as string).toISOString(),
        competition: String(r.competition),
        venue: (home ? 'HOME' : 'AWAY') as 'HOME' | 'AWAY',
        opponent: String(home ? r.away_name : r.home_name),
        opponentRank: rank,
        opponentTableSize: rank === null ? null : num(r.table_size),
        goalsFor: Number(home ? r.gh : r.ga),
        goalsAgainst: Number(home ? r.ga : r.gh),
        xgFor: num(home ? r.xg_h : r.xg_a),
        xgAgainst: num(home ? r.xg_a : r.xg_h),
        shotsOnTargetFor: num(home ? r.sot_h : r.sot_a),
        shotsOnTargetAgainst: num(home ? r.sot_a : r.sot_h),
        shotsFor: num(home ? r.sh_h : r.sh_a),
        shotsAgainst: num(home ? r.sh_a : r.sh_h),
      };
    });
  }

  // ---------- Hybrid AI decisions (ADR 0010) ----------

  /** Insert-only; the DB rejects a row at or after kickoff. */
  async insertHybridDecision(row: Row): Promise<number> {
    return Number(await insertReturning(this.db, 'hybrid_decisions', row));
  }

  /** The latest valid decision of a round under an engine version, or null. */
  async latestHybridDecision(fixtureId: number, round: string, engineVersion: string) {
    const res = await this.db.query<Record<string, unknown>>(
      `select id, decided_at, engine_mode, engine_version, prompt_version, model, input, input_hash, output, side, market, selection, line, odds,
              market_probability, confidence, summary_th, legacy
         from hybrid_decisions
        where fixture_id = $1 and publish_round = $2 and engine_version = $3 and status = 'OK'
        order by decided_at desc, id desc limit 1`,
      [fixtureId, round, engineVersion],
    );
    const r = res.rows[0];
    if (!r) return null;
    const num = (v: unknown) => (v == null ? null : Number(v));
    return {
      id: Number(r.id),
      decidedAt: new Date(r.decided_at as string),
      mode: String(r.engine_mode),
      engineVersion: String(r.engine_version),
      promptVersion: String(r.prompt_version),
      model: r.model == null ? null : String(r.model),
      input: parseJson(r.input) as Record<string, unknown>,
      inputHash: String(r.input_hash),
      output: parseJson(r.output),
      side: String(r.side),
      market: r.market == null ? null : String(r.market),
      selection: r.selection == null ? null : String(r.selection),
      line: num(r.line),
      odds: num(r.odds),
      marketProbability: num(r.market_probability),
      confidence: r.confidence == null ? null : String(r.confidence),
      summaryTh: r.summary_th == null ? null : String(r.summary_th),
      legacy: parseJson(r.legacy),
    };
  }

  async latestApiPrediction(fixtureId: number) {
    const res = await this.db.query<Record<string, unknown>>(
      `select collected_at, percent_home, percent_draw, percent_away, advice, under_over, winner_team_id
         from api_predictions where fixture_id = $1 order by collected_at desc limit 1`,
      [fixtureId],
    );
    return res.rows[0] ?? null;
  }

  async lineupPlayers(fixtureId: number) {
    const res = await this.db.query<Record<string, unknown>>(
      'select team_id, player_id, player_name, number, position, is_starter from fixture_lineup_players where fixture_id = $1 order by team_id, is_starter desc',
      [fixtureId],
    );
    return res.rows;
  }

  async injuriesDetailed(fixtureId: number) {
    const res = await this.db.query<Record<string, unknown>>(
      'select team_id, player_id, player_name, type, reason from injuries where fixture_id = $1',
      [fixtureId],
    );
    return res.rows;
  }

  /** Opening / current odds for one selection (consensus of first & last quotes per bookmaker). */
  async selectionMovement(fixtureId: number, market: string, selection: string, line: number | null) {
    const res = await this.db.query<{ opening: string; current: string; books: string }>(
      `select percentile_cont(0.5) within group (order by opening_odds) as opening,
              percentile_cont(0.5) within group (order by current_odds) as current,
              count(*) as books
         from odds_movement
        where fixture_id = $1 and market = $2 and selection = $3 and line is not distinct from $4::numeric`,
      [fixtureId, market, selection, line],
    );
    const r = res.rows[0];
    return r && r.opening != null && Number(r.books) > 0 ? { opening: Number(r.opening), current: Number(r.current), bookmakers: Number(r.books) } : null;
  }

  /** Publish prediction + snapshot atomically. DB triggers enforce pre-kickoff, immutability, hash chain. */
  async publishPrediction(prediction: Row, snapshot: Row): Promise<{ id: number; publicId: string; recordHash: string }> {
    return this.db.transaction(async (tx) => {
      const cols = Object.keys(prediction);
      const res = await tx.query<{ id: string; public_id: string; record_hash: string }>(
        `insert into analysis_predictions (${cols.map((c) => `"${c}"`).join(', ')})
         values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning id, public_id, record_hash`,
        cols.map((c) => toParam(prediction[c])),
      );
      const p = res.rows[0]!;
      await insertRows(tx, 'analysis_snapshots', [{ ...snapshot, analysis_prediction_id: p.id }]);
      return { id: Number(p.id), publicId: p.public_id, recordHash: p.record_hash };
    });
  }

  // ---------- 🔎 match previews ----------

  async standingsForTeams(leagueId: number, season: number, teamIds: number[]) {
    const res = await this.db.query<Record<string, unknown>>(
      `select team_id, rank, points, played, win, draw, lose, goals_for, goals_against, goals_diff, description, home, away, teams
         from (select s.*, count(*) over (partition by group_name) as teams from standings s where league_id = $1 and season = $2) s
        where team_id = any($3::int[])`,
      [leagueId, season, teamIds],
    );
    const num = (v: unknown) => (v == null ? null : Number(v));
    const venue = (v: unknown) => {
      const j = parseJson(v) as { played?: number; win?: number; draw?: number; lose?: number; goals?: { for?: number; against?: number } } | null;
      return j && Number(j.played) > 0
        ? { played: num(j.played), win: num(j.win), draw: num(j.draw), lose: num(j.lose), goalsFor: num(j.goals?.for), goalsAgainst: num(j.goals?.against) }
        : null;
    };
    return new Map(
      res.rows.map((r) => [
        Number(r.team_id),
        {
          rank: num(r.rank),
          points: num(r.points),
          played: num(r.played),
          win: num(r.win),
          draw: num(r.draw),
          lose: num(r.lose),
          goalsFor: num(r.goals_for),
          goalsAgainst: num(r.goals_against),
          goalDiff: num(r.goals_diff),
          zone: r.description == null ? null : String(r.description),
          teams: num(r.teams),
          home: venue(r.home),
          away: venue(r.away),
        },
      ]),
    );
  }

  /** Venue (name, city) and referee of a fixture. The referee is the name only ("Name, Country" -> "Name"). */
  async fixtureVenueReferee(fixtureId: number) {
    const res = await this.db.query<Record<string, unknown>>(
      'select f.referee, v.name, v.city from fixtures f left join venues v on v.id = f.venue_id where f.id = $1',
      [fixtureId],
    );
    const r = res.rows[0];
    const referee = r?.referee == null ? '' : String(r.referee).split(',')[0]!.trim();
    return {
      venue: r?.name == null ? null : { name: String(r.name), city: r.city == null ? null : String(r.city) },
      referee: referee || null,
    };
  }

  /** Competition, shots on target and possession of one team in the given fixtures (its recent form). */
  async formDetails(teamId: number, fixtureIds: number[]) {
    const res = await this.db.query<Record<string, unknown>>(
      `select f.id, l.name as competition, sot.value_num as shots_on_target, pos.value_num as possession
         from fixtures f
         join leagues l on l.id = f.league_id
         left join fixture_statistics sot on sot.fixture_id = f.id and sot.team_id = $1 and sot.type = 'shots_on_goal'
         left join fixture_statistics pos on pos.fixture_id = f.id and pos.team_id = $1 and pos.type = 'ball_possession'
        where f.id = any($2::bigint[])`,
      [teamId, fixtureIds],
    );
    return new Map(
      res.rows.map((r) => [
        Number(r.id),
        {
          competition: String(r.competition),
          shotsOnTarget: r.shots_on_target == null ? null : Number(r.shots_on_target),
          possession: r.possession == null ? null : Number(r.possession),
        },
      ]),
    );
  }

  /** A team's top players this season by goals + assists, over every synced competition before a date. */
  async teamKeyPlayers(teamId: number, season: number, before: Date, n = 3) {
    const res = await this.db.query<Record<string, unknown>>(
      `with s as (
         select ps.player_id, coalesce(sum(ps.goals), 0) as goals, coalesce(sum(ps.assists), 0) as assists,
                count(*) filter (where coalesce(ps.minutes, 0) > 0) as appearances
           from fixture_player_stats ps join fixtures f on f.id = ps.fixture_id
          where ps.team_id = $1 and f.season = $2 and f.kickoff_at < $3 and f.status_short in ('FT','AET','PEN')
          group by ps.player_id
         having coalesce(sum(ps.goals), 0) + coalesce(sum(ps.assists), 0) > 0
          order by coalesce(sum(ps.goals), 0) + coalesce(sum(ps.assists), 0) desc, coalesce(sum(ps.goals), 0) desc, ps.player_id
          limit $4)
       select s.*, coalesce(p.name, (select lp.player_name from fixture_lineup_players lp where lp.player_id = s.player_id limit 1)) as name
         from s left join players p on p.id = s.player_id
        order by s.goals + s.assists desc, s.goals desc, s.appearances desc, s.player_id`,
      [teamId, season, before.toISOString(), n],
    );
    return res.rows
      .filter((r) => r.name != null)
      .map((r) => ({ playerId: Number(r.player_id), name: String(r.name), goals: Number(r.goals), assists: Number(r.assists), appearances: Number(r.appearances) }));
  }

  /** Formation and coach per team once the lineup is out. */
  async lineupTeams(fixtureId: number) {
    const res = await this.db.query<Record<string, unknown>>('select team_id, formation, coach_name from fixture_lineups where fixture_id = $1', [fixtureId]);
    return new Map(
      res.rows.map((r) => [Number(r.team_id), { formation: r.formation == null ? null : String(r.formation), coach: r.coach_name == null ? null : String(r.coach_name) }]),
    );
  }

  /** Last n finished meetings of two teams before a date (any competition). */
  async headToHead(teamA: number, teamB: number, before: Date, n = 5) {
    const res = await this.db.query<Record<string, unknown>>(
      `select f.kickoff_at, th.name as home, ta.name as away, coalesce(f.ft_home, f.goals_home) as gh, coalesce(f.ft_away, f.goals_away) as ga
         from fixtures f join teams th on th.id = f.home_team_id join teams ta on ta.id = f.away_team_id
        where ((f.home_team_id = $1 and f.away_team_id = $2) or (f.home_team_id = $2 and f.away_team_id = $1))
          and f.status_short in ('FT','AET','PEN') and f.kickoff_at < $3
        order by f.kickoff_at desc limit $4`,
      [teamA, teamB, before.toISOString(), n],
    );
    return res.rows.map((r) => ({ kickoffAt: new Date(r.kickoff_at as string).toISOString(), home: String(r.home), away: String(r.away), homeGoals: Number(r.gh), awayGoals: Number(r.ga) }));
  }

  /** How many previews exist for a stage and whether one of them carries AI text that passed the guards. */
  /** Attempts so far for (fixture, stage); with `version`, only rows written by that version count. */
  async previewAttempts(fixtureId: number, stage: string, version?: string): Promise<{ attempts: number; aiOk: boolean }> {
    const res = await this.db.query<{ attempts: string; ai_ok: boolean }>(
      `select count(*) as attempts, coalesce(bool_or(ai_status = 'OK'), false) as ai_ok from match_previews
        where fixture_id = $1 and stage = $2 and ($3::text is null or version = $3)`,
      [fixtureId, stage, version ?? null],
    );
    return { attempts: Number(res.rows[0]?.attempts ?? 0), aiOk: Boolean(res.rows[0]?.ai_ok) };
  }

  /** Insert-only; the DB trigger rejects it at/after kickoff. */
  async insertMatchPreview(row: Row): Promise<number> {
    return Number(await insertReturning(this.db, 'match_previews', row));
  }

  // ---------- Game Compass note (pick_th) ----------

  /**
   * Published picks (SIGNAL, any round) still more than `minMinutes` before kickoff, with their note
   * attempts so far: the job writes one note per pick and retries a failed AI attempt once.
   * With `promptVersion`, only notes written by that prompt count (a refresh rewrites older ones).
   */
  async picksForNotes(now: Date, minMinutes = 5, promptVersion?: string) {
    const res = await this.db.query<Record<string, unknown>>(
      `select p.id, p.fixture_id, p.publish_round, p.market, p.selection, p.line, p.model_probability, p.market_probability,
              p.signal_strength, f.kickoff_at, f.league_id, f.home_team_id, f.away_team_id,
              count(e.id) as attempts, coalesce(bool_or(e.ai_status = 'OK'), false) as ai_ok
         from analysis_predictions p
         join fixtures f on f.id = p.fixture_id
         left join pick_explanations e on e.analysis_prediction_id = p.id and ($3::text is null or e.prompt_version = $3)
        where p.kind = 'SIGNAL' and f.kickoff_at > $1::timestamptz + make_interval(mins => $2)
          -- a Hybrid AI pick carries the AI's own explanation (ADR 0010)
          and coalesce(p.decision_rule_version, '') not like 'hybrid-%'
        group by p.id, f.id
        order by f.kickoff_at, p.id`,
      [now.toISOString(), minMinutes, promptVersion ?? null],
    );
    const num = (v: unknown) => (v == null ? null : Number(v));
    return res.rows.map((r) => ({
      predictionId: Number(r.id),
      publishRound: String(r.publish_round),
      market: r.market == null ? null : String(r.market),
      selection: r.selection == null ? null : String(r.selection),
      line: num(r.line),
      modelProbability: num(r.model_probability),
      marketProbability: num(r.market_probability),
      signalStrength: r.signal_strength == null ? null : String(r.signal_strength),
      fixture: { id: Number(r.fixture_id), leagueId: Number(r.league_id), kickoffAt: new Date(r.kickoff_at as string), homeTeamId: Number(r.home_team_id), awayTeamId: Number(r.away_team_id) },
      attempts: Number(r.attempts),
      aiOk: Boolean(r.ai_ok),
    }));
  }

  /** Insert-only; the DB trigger rejects it at/after kickoff. */
  async insertPickExplanation(row: Row): Promise<number> {
    return Number(await insertReturning(this.db, 'pick_explanations', row));
  }

  // ---------- candidate generator ----------

  async fixturesForCandidates(leagueIds: number[], fromIso: string, toIso: string) {
    const res = await this.db.query<Record<string, unknown>>(
      `select id, league_id, kickoff_at, home_team_id, away_team_id from fixtures
        where league_id = any($1::int[]) and status_short in ('NS','TBD') and kickoff_at > $2 and kickoff_at <= $3
        order by kickoff_at`,
      [leagueIds, fromIso, toIso],
    );
    return res.rows.map((r) => ({
      id: Number(r.id),
      leagueId: Number(r.league_id),
      kickoffAt: new Date(r.kickoff_at as string),
      homeTeamId: Number(r.home_team_id),
      awayTeamId: Number(r.away_team_id),
    }));
  }

  /**
   * All rows of the latest Probability Engine run for a fixture (per model version).
   * `asOf` (a replay): the latest run computed at or before that moment.
   */
  async latestProbabilities(fixtureId: number, primaryVersion: string, asOf?: Date) {
    const res = await this.db.query<Record<string, unknown>>(
      `with last as (
         select max(computed_at) as t from probability_predictions
          where fixture_id = $1 and model_version_id = $2 and ($3::timestamptz is null or computed_at <= $3)
       )
       select p.model_version_id, p.market, p.selection, p.line, p.probability, p.inputs, p.computed_at
         from probability_predictions p, last
        where p.fixture_id = $1 and p.computed_at = last.t`,
      [fixtureId, primaryVersion, asOf?.toISOString() ?? null],
    );
    return res.rows.map((r) => ({
      modelVersionId: String(r.model_version_id),
      market: String(r.market),
      selection: String(r.selection),
      line: r.line == null ? null : Number(r.line),
      probability: Number(r.probability),
      inputs: r.inputs == null ? null : parseJson(r.inputs),
      computedAt: new Date(r.computed_at as string),
    }));
  }

  /**
   * Latest quote per (bookmaker, bet, value) for a fixture.
   * `asOf` (a replay, audit A-08): only quotes this system had stored by then (collected_at) and whose source
   * time is not later, so a price fetched after the decision never leaks into it, even when the bookmaker
   * set it earlier. Without `asOf` nothing is filtered (the live decision runs at the real now).
   */
  async latestQuotes(fixtureId: number, asOf?: Date) {
    const res = await this.db.query<Record<string, unknown>>(
      `select distinct on (bookmaker_id, api_bet_id, raw_value)
              bookmaker_id, market, selection, line, home_line, odds, source_updated_at, collected_at
         from odds_history
        where fixture_id = $1 and market in ('MATCH_WINNER','ASIAN_HANDICAP','OVER_UNDER')
          and ($2::timestamptz is null or (collected_at <= $2 and source_updated_at <= $2))
        order by bookmaker_id, api_bet_id, raw_value, source_updated_at desc, collected_at desc`,
      [fixtureId, asOf?.toISOString() ?? null],
    );
    return res.rows.map((r) => ({
      bookmakerId: Number(r.bookmaker_id),
      market: String(r.market) as 'MATCH_WINNER' | 'ASIAN_HANDICAP' | 'OVER_UNDER',
      selection: String(r.selection),
      line: r.line == null ? null : Number(r.line),
      homeLine: r.home_line == null ? null : Number(r.home_line),
      odds: Number(r.odds),
      updatedAt: new Date(r.source_updated_at as string),
      // only a replay carries it: live, the DB clock (collected_at) and the worker clock (now) may differ by a little
      ...(asOf ? { collectedAt: new Date(r.collected_at as string) } : {}),
    }));
  }

  /** Matches that kicked off in the last 8 days, still have odds snapshots, and have no closing market yet. */
  async fixturesNeedingClosing(): Promise<Array<{ id: number; kickoffAt: Date }>> {
    const res = await this.db.query<{ id: string | number; kickoff_at: string | Date }>(
      `select f.id, f.kickoff_at from fixtures f
        where f.kickoff_at < now() and f.kickoff_at > now() - interval '8 days'
          and exists (select 1 from odds_history o where o.fixture_id = f.id)
          and not exists (select 1 from market_closing c where c.fixture_id = f.id)
        order by f.kickoff_at`,
    );
    return res.rows.map((r) => ({ id: Number(r.id), kickoffAt: new Date(r.kickoff_at) }));
  }

  /** Last quote per (bookmaker, bet, value) before kickoff. */
  async closingQuotes(fixtureId: number) {
    const res = await this.db.query<Record<string, unknown>>(
      `select distinct on (o.bookmaker_id, o.api_bet_id, o.raw_value)
              o.bookmaker_id, o.market, o.selection, o.line, o.home_line, o.odds, o.source_updated_at
         from odds_history o join fixtures f on f.id = o.fixture_id
        where o.fixture_id = $1 and o.source_updated_at < f.kickoff_at and o.market in ('MATCH_WINNER','ASIAN_HANDICAP','OVER_UNDER')
        order by o.bookmaker_id, o.api_bet_id, o.raw_value, o.source_updated_at desc`,
      [fixtureId],
    );
    return res.rows.map((r) => ({
      bookmakerId: Number(r.bookmaker_id),
      market: String(r.market) as 'MATCH_WINNER' | 'ASIAN_HANDICAP' | 'OVER_UNDER',
      selection: String(r.selection),
      line: r.line == null ? null : Number(r.line),
      homeLine: r.home_line == null ? null : Number(r.home_line),
      odds: Number(r.odds),
      updatedAt: new Date(r.source_updated_at as string),
    }));
  }

  /** Model probabilities of the last candidates run that started before kickoff. */
  async preKickoffCandidates(fixtureId: number) {
    const res = await this.db.query<Record<string, unknown>>(
      `with run as (
         select r.id from analysis_runs r join fixtures f on f.id = r.fixture_id
          where r.fixture_id = $1 and r.started_at < f.kickoff_at
          order by r.started_at desc limit 1
       )
       select c.run_id, c.market, c.selection, c.line, c.model_probability
         from analysis_candidates c join run on run.id = c.run_id
        where c.model_probability is not null`,
      [fixtureId],
    );
    return res.rows.map((r) => ({
      runId: String(r.run_id),
      market: String(r.market),
      selection: String(r.selection),
      line: r.line == null ? null : Number(r.line),
      probability: Number(r.model_probability),
    }));
  }

  /** The latest evaluation of a shadow rules version (one LATEST row per match, overwritten each time). */
  upsertShadowDecision(row: Row) {
    return writeRows(this.db, 'shadow_decisions', [{ ...row, publish_round: 'LATEST' }], { conflict: ['fixture_id', 'rules_version', 'publish_round'], update: 'all' });
  }

  async latestShadowEvaluation(fixtureId: number, rulesVersion: string): Promise<Date | null> {
    const res = await this.db.query<{ evaluated_at: string | Date }>(
      `select evaluated_at from shadow_decisions where fixture_id = $1 and rules_version = $2 and publish_round = 'LATEST'`,
      [fixtureId, rulesVersion],
    );
    const t = res.rows[0]?.evaluated_at;
    return t ? new Date(t) : null;
  }

  /** Lock the LATEST shadow evaluation as the shadow pick of a publish round (once; DB trigger keeps it). */
  async lockShadowDecision(fixtureId: number, rulesVersion: string, round: string): Promise<boolean> {
    const res = await this.db.query<{ fixture_id: string | number }>(
      `insert into shadow_decisions (fixture_id, rules_version, publish_round, locked_at, evaluated_at, outcome, market, selection, line, odds,
                                     model_probability, bias, market_probability, edge, strength, passed)
       select fixture_id, rules_version, $3, now(), evaluated_at, outcome, market, selection, line, odds,
              model_probability, bias, market_probability, edge, strength, passed
         from shadow_decisions where fixture_id = $1 and rules_version = $2 and publish_round = 'LATEST'
       on conflict do nothing returning fixture_id`,
      [fixtureId, rulesVersion, round],
    );
    return res.rows.length > 0;
  }

  async isShadowLocked(fixtureId: number, rulesVersion: string, round: string): Promise<boolean> {
    const res = await this.db.query('select 1 from shadow_decisions where fixture_id = $1 and rules_version = $2 and publish_round = $3', [fixtureId, rulesVersion, round]);
    return res.rows.length > 0;
  }

  /** Locked shadow picks of matches that kicked off in the last 8 days and have no closing odds yet. */
  async shadowPicksNeedingClosing() {
    const res = await this.db.query<Record<string, unknown>>(
      `select s.fixture_id, s.rules_version, s.publish_round, s.market, s.selection, s.line, s.odds
         from shadow_decisions s join fixtures f on f.id = s.fixture_id
        where s.publish_round <> 'LATEST' and s.outcome = 'SIGNAL' and s.closing_odds is null
          and f.kickoff_at < now() and f.kickoff_at > now() - interval '8 days'`,
    );
    return res.rows.map((r) => ({
      fixtureId: Number(r.fixture_id),
      rulesVersion: String(r.rules_version),
      round: String(r.publish_round),
      market: String(r.market),
      selection: String(r.selection),
      line: r.line == null ? null : Number(r.line),
      odds: r.odds == null ? null : Number(r.odds),
    }));
  }

  async setShadowClosing(fixtureId: number, rulesVersion: string, round: string, closingOdds: number, clv: number | null) {
    await this.db.query(
      `update shadow_decisions set closing_odds = $4, clv = $5 where fixture_id = $1 and rules_version = $2 and publish_round = $3`,
      [fixtureId, rulesVersion, round, closingOdds, clv],
    );
  }

  /** Locked shadow decisions of matches that have kicked off, with the match state needed to settle them. */
  async shadowDecisionsToReview(rulesVersion: string) {
    const res = await this.db.query<Record<string, unknown>>(
      `select s.*, f.kickoff_at, f.status_short, f.ft_home, f.ft_away, f.goals_home, f.goals_away, f.synced_at
         from shadow_decisions s join fixtures f on f.id = s.fixture_id
        where s.rules_version = $1 and s.publish_round <> 'LATEST' and f.kickoff_at < now()
        order by f.kickoff_at`,
      [rulesVersion],
    );
    return res.rows;
  }

  /** Published picks of matches that kicked off since `since` (to set beside a shadow rules version). */
  async publishedPicksSince(since: Date) {
    const res = await this.db.query<Record<string, unknown>>(
      `select p.publish_round, p.market, p.selection, p.line, p.status, p.clv, f.league_id from analysis_predictions p join fixtures f on f.id = p.fixture_id
        where p.kind = 'SIGNAL' and f.kickoff_at >= $1 and f.kickoff_at < now()`,
      [since.toISOString()],
    );
    return res.rows.map((r) => ({
      round: String(r.publish_round),
      market: String(r.market),
      selection: String(r.selection),
      line: r.line == null ? null : Number(r.line),
      status: String(r.status),
      clv: r.clv == null ? null : Number(r.clv),
      leagueId: Number(r.league_id),
    }));
  }

  /** Write-once: a match's closing market is never changed. */
  insertMarketClosing(rows: Row[]) {
    return writeRows(this.db, 'market_closing', rows, { conflict: ['fixture_id', 'market', 'selection'], update: 'nothing' });
  }

  async lastAnalysisRun(fixtureId: number, rulesVersion: string): Promise<{ inputs: Record<string, unknown>; startedAt: Date } | null> {
    const res = await this.db.query<{ inputs: unknown; started_at: string | Date }>(
      `select inputs, started_at from analysis_runs where fixture_id = $1 and decision_rule_version = $2 order by started_at desc, id desc limit 1`,
      [fixtureId, rulesVersion],
    );
    const r = res.rows[0];
    return r ? { inputs: r.inputs == null ? {} : parseJson(r.inputs), startedAt: new Date(r.started_at) } : null;
  }

  /** Writes the run and ALL evaluated candidates atomically. Returns run id. */
  async insertAnalysisRun(run: Row, candidates: Row[]): Promise<string> {
    return this.db.transaction(async (tx) => {
      const id = await insertReturning<string>(tx, 'analysis_runs', run);
      if (candidates.length) await insertRows(tx, 'analysis_candidates', candidates.map((c) => ({ ...c, run_id: id })));
      return id;
    });
  }

  async lastApiPredictionAt(fixtureId: number): Promise<Date | null> {
    const res = await this.db.query<{ t: string | Date | null }>('select max(collected_at) as t from api_predictions where fixture_id = $1', [fixtureId]);
    const t = res.rows[0]?.t;
    return t ? new Date(t) : null;
  }

  // ---------- daily featured list (ADR 0004) ----------

  /** Matches of a football day with their latest published prediction (LINEUP over EARLY) and its support score. */
  async featuredDayMatches(leagueIds: number[], from: string, to: string) {
    const res = await this.db.query<Record<string, unknown>>(
      `select f.id as fixture_id, f.league_id, f.kickoff_at, p.id as prediction_id, p.publish_round, p.kind, p.model_distribution, p.market, p.model_probability, p.market_probability, c.support_score
         from fixtures f
         left join lateral (
           select id, publish_round, kind, model_distribution, candidate_id, market, model_probability, market_probability from analysis_predictions
            where fixture_id = f.id order by (publish_round = 'LINEUP') desc, published_at desc limit 1
         ) p on true
         left join analysis_candidates c on c.id = p.candidate_id
        where f.league_id = any($1::int[]) and f.kickoff_at >= $2 and f.kickoff_at < $3
        order by f.kickoff_at, f.id`,
      [leagueIds, from, to],
    );
    return res.rows.map((r) => ({
      fixtureId: Number(r.fixture_id),
      leagueId: Number(r.league_id),
      kickoffAt: new Date(r.kickoff_at as string),
      predictionId: r.prediction_id == null ? null : Number(r.prediction_id),
      round: r.publish_round == null ? null : String(r.publish_round),
      kind: r.kind == null ? null : String(r.kind),
      market: r.market == null ? null : String(r.market),
      modelProbability: r.model_probability == null ? null : Number(r.model_probability),
      marketProbability: r.market_probability == null ? null : Number(r.market_probability),
      distribution: r.model_distribution == null ? null : (parseJson(r.model_distribution) as unknown as OutcomeDistributionRow),
      supportScore: r.support_score == null ? null : Number(r.support_score),
    }));
  }

  /** Every locked row of a list version, with the outcome of its prediction (read, never copied). */
  async featuredLocked(version: string) {
    const res = await this.db.query<Record<string, unknown>>(
      `select fs.football_date::text as football_date, fs.phase, f.kickoff_at, p.status, p.clv
         from featured_selections fs join fixtures f on f.id = fs.fixture_id
         left join analysis_predictions p on p.id = fs.prediction_id
        where fs.version = $1 and fs.locked_at is not null`,
      [version],
    );
    return res.rows.map((r) => ({
      footballDate: String(r.football_date),
      phase: String(r.phase),
      kickoffAt: new Date(r.kickoff_at as string),
      status: r.status == null ? null : String(r.status),
      clv: r.clv == null ? null : Number(r.clv),
    }));
  }

  async featuredRows(footballDate: string, version: string) {
    const res = await this.db.query<Record<string, unknown>>(
      'select fixture_id, league_id, phase, rank, locked_at from featured_selections where football_date = $1 and version = $2',
      [footballDate, version],
    );
    return res.rows.map((r) => ({
      fixtureId: Number(r.fixture_id),
      leagueId: Number(r.league_id),
      phase: String(r.phase) as 'RESERVED' | 'CONFIRMED' | 'DROPPED' | 'SKIPPED',
      rank: r.rank == null ? null : Number(r.rank),
      locked: r.locked_at != null,
    }));
  }

  /** Current reservation of a match not locked yet (rank null = reserved earlier, outside the list now). */
  async reserveFeatured(row: { footballDate: string; version: string; fixtureId: number; leagueId: number; rank: number | null; predictionId: number | null; supportScore: number | null; fairProbability: number | null }) {
    await this.db.query(
      `insert into featured_selections (football_date, version, fixture_id, league_id, phase, rank, prediction_id, support_score, fair_probability, first_reserved_at, first_rank)
       values ($1, $2, $3, $4, 'RESERVED', $5, $6, $7, $8, now(), $5)
       on conflict (football_date, version, fixture_id) do update
         set rank = excluded.rank, updated_at = now(),
             prediction_id = coalesce(excluded.prediction_id, featured_selections.prediction_id),
             support_score = coalesce(excluded.support_score, featured_selections.support_score),
             fair_probability = coalesce(excluded.fair_probability, featured_selections.fair_probability)`,
      [row.footballDate, row.version, row.fixtureId, row.leagueId, row.rank, row.predictionId, row.supportScore, row.fairProbability],
    );
  }

  async lockFeatured(row: { footballDate: string; version: string; fixtureId: number; leagueId: number; phase: 'CONFIRMED' | 'DROPPED' | 'SKIPPED'; rank: number | null; predictionId: number | null; supportScore: number | null; fairProbability: number | null }) {
    await this.db.query(
      `insert into featured_selections (football_date, version, fixture_id, league_id, phase, rank, prediction_id, support_score, fair_probability, locked_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       on conflict (football_date, version, fixture_id) do update
         set phase = excluded.phase, rank = excluded.rank, prediction_id = excluded.prediction_id,
             support_score = excluded.support_score, fair_probability = excluded.fair_probability,
             locked_at = excluded.locked_at, updated_at = now()`,
      [row.footballDate, row.version, row.fixtureId, row.leagueId, row.phase, row.rank, row.predictionId, row.supportScore, row.fairProbability],
    );
  }

}
