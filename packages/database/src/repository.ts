import type { OddsRow, RawResponseRecord } from '@fp/football';
import { LIVE_STATUSES } from '@fp/shared';
import type { Db, Queryable } from './db.js';
import { insertReturning, insertRows, toParam, writeRows, type Row } from './upsert.js';

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

  /** Delete raw audit rows older than N days (FKs unlink via on delete set null). Batched to keep locks short. */
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
    return Number(await insertReturning<string | number>(this.db, 'sync_runs', { job, params }));
  }

  async finishSyncRun(id: number, r: { status: 'SUCCESS' | 'FAILED'; requestsUsed: number; itemsWritten: number; error?: string }) {
    await this.db.query(
      `update sync_runs set status = $2, requests_used = $3, items_written = $4, error = $5, finished_at = now() where id = $1`,
      [id, r.status, r.requestsUsed, r.itemsWritten, r.error ?? null],
    );
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

  async insertApiPrediction(row: Row): Promise<number> {
    await insertReturning(this.db, 'api_predictions', row);
    return 1;
  }

  // ---------- odds ----------
  upsertBookmakers(rows: Array<{ id: number; name: string }>) {
    return writeRows(this.db, 'bookmakers', rows, { conflict: ['id'], touch: 'synced_at' });
  }

  /** Append-only. Same (fixture, bookmaker, bet, value, update-time) is skipped. Returns rows actually inserted. */
  insertOddsHistory(rows: OddsRow[], rawResponseId: number | null) {
    return writeRows(
      this.db,
      'odds_history',
      rows.map((r) => ({
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

  /** Active (latest) config per purpose for a league. */
  async latestModelConfigs(leagueId: number): Promise<Partial<Record<ModelConfigInput['purpose'], ModelConfig>>> {
    const res = await this.db.query<Record<string, unknown>>(
      'select id, purpose, model_version_id, params, metrics, enabled, matches_evaluated, tuned_at from model_configs_latest where league_id = $1',
      [leagueId],
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
      `select team_id, rank, points, played, win, draw, lose, goals_for, goals_against
         from standings where league_id = $1 and season = $2 and team_id = any($3::int[])`,
      [leagueId, season, teamIds],
    );
    const num = (v: unknown) => (v == null ? null : Number(v));
    return new Map(
      res.rows.map((r) => [
        Number(r.team_id),
        { rank: num(r.rank), points: num(r.points), played: num(r.played), win: num(r.win), draw: num(r.draw), lose: num(r.lose), goalsFor: num(r.goals_for), goalsAgainst: num(r.goals_against) },
      ]),
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

  async hasPreview(fixtureId: number, stage: string): Promise<boolean> {
    const res = await this.db.query('select 1 from match_previews where fixture_id = $1 and stage = $2', [fixtureId, stage]);
    return res.rows.length > 0;
  }

  /** Insert-only; the DB trigger rejects it at/after kickoff. */
  async insertMatchPreview(row: Row): Promise<number> {
    return Number(await insertReturning(this.db, 'match_previews', row));
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

  /** All rows of the latest Probability Engine run for a fixture (per model version). */
  async latestProbabilities(fixtureId: number, primaryVersion: string) {
    const res = await this.db.query<Record<string, unknown>>(
      `with last as (
         select max(computed_at) as t from probability_predictions where fixture_id = $1 and model_version_id = $2
       )
       select p.model_version_id, p.market, p.selection, p.line, p.probability, p.inputs, p.computed_at
         from probability_predictions p, last
        where p.fixture_id = $1 and p.computed_at = last.t`,
      [fixtureId, primaryVersion],
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

  /** Latest quote per (bookmaker, bet, value) for a fixture. */
  async latestQuotes(fixtureId: number) {
    const res = await this.db.query<Record<string, unknown>>(
      `select distinct on (bookmaker_id, api_bet_id, raw_value)
              bookmaker_id, market, selection, line, home_line, odds, source_updated_at
         from odds_history
        where fixture_id = $1 and market in ('MATCH_WINNER','ASIAN_HANDICAP','OVER_UNDER')
        order by bookmaker_id, api_bet_id, raw_value, source_updated_at desc`,
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
}
