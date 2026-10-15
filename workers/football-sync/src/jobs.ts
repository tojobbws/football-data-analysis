import { runJob, type JobContext } from '@fp/database';
import {
  MAX_FIXTURE_IDS_PER_CALL,
  toApiPredictionRow,
  toInjuryRow,
  toLeagueRow,
  toLeagueSeasonRows,
  toPlayerRows,
  toStandingRows,
  toTeamRow,
  toVenueRow,
} from '@fp/football';
import { addDays, addHours, chunk, CROSS_LEAGUE_CUPS, toDateString } from '@fp/shared';
import { persistFixtures } from './persist.js';

/** Leagues + seasons (+ coverage flags: tells us if xG/odds/predictions exist for a league). */
export function syncLeagues(ctx: JobContext) {
  return runJob(ctx, 'leagues', { leagues: ctx.env.TRACKED_LEAGUES }, async () => {
    let n = 0;
    for (const id of ctx.env.TRACKED_LEAGUES) {
      const res = await ctx.api.leagues({ id });
      const item = res.data[0];
      if (!item) {
        ctx.log.warn('league not found', { id });
        continue;
      }
      n += await ctx.repo.upsertLeagues([toLeagueRow(item, true)]);
      n += await ctx.repo.upsertLeagueSeasons(toLeagueSeasonRows(item));
    }
    return n;
  });
}

export function syncTeams(ctx: JobContext) {
  const { TRACKED_LEAGUES: leagues, SEASON: season } = ctx.env;
  return runJob(ctx, 'teams', { leagues, season }, async () => {
    let n = 0;
    for (const league of leagues) {
      const { data } = await ctx.api.teams({ league, season });
      n += await ctx.repo.upsertVenues(data.map(toVenueRow).filter((v): v is Record<string, unknown> => v !== null));
      n += await ctx.repo.upsertTeams(data.map(toTeamRow));
      n += await ctx.repo.upsertTeamSeasons(data.map((t) => ({ team_id: t.team.id, league_id: league, season })));
    }
    return n;
  });
}

/** Whole season (1 request per league) or a date window. */
export function syncFixtures(ctx: JobContext, opts: { from?: string; to?: string; season?: number } = {}) {
  const leagues = ctx.env.TRACKED_LEAGUES;
  const season = opts.season ?? ctx.env.SEASON;
  return runJob(ctx, 'fixtures', { leagues, ...opts, season }, async () => {
    let n = 0;
    for (const league of leagues) {
      const { data } = await ctx.api.fixtures({ league, season, from: opts.from, to: opts.to });
      n += await persistFixtures(ctx.repo, data, { withDetails: false });
    }
    return n;
  });
}

/**
 * Support leagues: domestic leagues behind a tracked cross-league cup (CROSS_LEAGUE_CUPS) that are not
 * tracked themselves. Results only (the cross-league model needs scores, nothing else), never shown on the
 * site. `last` N played per league = 1 request each, and works across season boundaries.
 */
export function syncSupportLeagues(ctx: JobContext, opts: { last?: number } = {}) {
  const tracked = new Set(ctx.env.TRACKED_LEAGUES);
  const leagues = [...new Set(ctx.env.TRACKED_LEAGUES.flatMap((l) => CROSS_LEAGUE_CUPS[l] ?? []))].filter((l) => !tracked.has(l));
  const last = opts.last ?? 30;
  return runJob(ctx, 'support', { leagues, last }, async () => {
    let n = 0;
    for (const league of leagues) {
      const { data } = await ctx.api.fixtures({ league, last });
      n += await persistFixtures(ctx.repo, data, { withDetails: false });
    }
    return n;
  });
}

/** Finished matches: events, statistics (incl. xG), lineups, player stats — 20 fixtures per request. */
export function syncFinishedDetails(ctx: JobContext, opts: { limit?: number; leagues?: number[]; seasons?: number[] } = {}) {
  // optional filters, e.g. backfill history only for some leagues/seasons
  const leagues = opts.leagues?.length ? opts.leagues : ctx.env.TRACKED_LEAGUES;
  return runJob(ctx, 'details', { ...opts, leagues }, async () => {
    const ids = await ctx.repo.fixturesNeedingDetails(leagues, opts.limit ?? 200, opts.seasons);
    let n = 0;
    for (const batch of chunk(ids, MAX_FIXTURE_IDS_PER_CALL)) {
      const { data } = await ctx.api.fixturesByIds(batch);
      n += await persistFixtures(ctx.repo, data, { withDetails: true });
      await ctx.repo.markFixtureDetailsSynced(data.map((f) => f.fixture.id));
    }
    return n;
  });
}

/**
 * Results: refresh fixtures that kicked off but are not final yet (score/status), 20 per request,
 * plus any fixture with a PENDING analysis — the Settlement Engine depends on this.
 * Details come in the same response, so finished matches are marked as detail-synced too.
 */
export function syncResults(ctx: JobContext, opts: { days?: number; now?: Date } = {}) {
  const leagues = ctx.env.TRACKED_LEAGUES;
  return runJob(ctx, 'results', { leagues, ...opts }, async () => {
    const ids = await ctx.repo.fixturesAwaitingResult(leagues, opts.now ?? new Date(), opts.days ?? 14);
    let n = 0;
    for (const batch of chunk(ids, MAX_FIXTURE_IDS_PER_CALL)) {
      const { data } = await ctx.api.fixturesByIds(batch);
      n += await persistFixtures(ctx.repo, data, { withDetails: true });
      await ctx.repo.markFixtureDetailsSynced(data.filter((f) => ['FT', 'AET', 'PEN'].includes(f.fixture.status.short)).map((f) => f.fixture.id));
    }
    return n;
  });
}

/**
 * Live scores: refresh matches in play (or kicking off within a minute), 20 per request, with
 * events/stats/lineups. The DB is checked first: nothing on -> no API request and no sync_runs row.
 */
export async function syncLive(ctx: JobContext, opts: { now?: Date } = {}): Promise<number> {
  const leagues = ctx.env.TRACKED_LEAGUES;
  const ids = await ctx.repo.liveWindowFixtureIds(leagues, opts.now ?? new Date());
  if (!ids.length) return 0;
  return runJob(ctx, 'live', { leagues, fixtures: ids.length }, async () => {
    let n = 0;
    for (const batch of chunk(ids, MAX_FIXTURE_IDS_PER_CALL)) {
      const { data } = await ctx.api.fixturesByIds(batch);
      n += await persistFixtures(ctx.repo, data, { withDetails: true });
      await ctx.repo.markFixtureDetailsSynced(data.filter((f) => ['FT', 'AET', 'PEN'].includes(f.fixture.status.short)).map((f) => f.fixture.id));
    }
    return n;
  });
}

/** Fixtures kicking off soon: refresh status + confirmed lineups (released ~20-40 min before KO). */
export function syncPrematchLineups(ctx: JobContext, opts: { withinMinutes?: number } = {}) {
  const leagues = ctx.env.TRACKED_LEAGUES;
  const minutes = opts.withinMinutes ?? 90;
  return runJob(ctx, 'lineups', { leagues, minutes }, async () => {
    const now = new Date();
    const upcoming = await ctx.repo.upcomingFixtures(leagues, now.toISOString(), addHours(now, minutes / 60).toISOString());
    let n = 0;
    for (const batch of chunk(upcoming.map((f) => f.id), MAX_FIXTURE_IDS_PER_CALL)) {
      const { data } = await ctx.api.fixturesByIds(batch);
      n += await persistFixtures(ctx.repo, data, { withDetails: true });
    }
    return n;
  });
}

export function syncInjuries(ctx: JobContext, opts: { days?: number } = {}) {
  const { TRACKED_LEAGUES: leagues, SEASON: season } = ctx.env;
  const days = opts.days ?? 3;
  return runJob(ctx, 'injuries', { leagues, season, days }, async () => {
    let n = 0;
    for (const league of leagues) {
      for (let d = 0; d <= days; d++) {
        const date = toDateString(addDays(new Date(), d));
        const { data } = await ctx.api.injuries({ league, season, date });
        n += await ctx.repo.upsertInjuries(data.map(toInjuryRow));
      }
    }
    return n;
  });
}

/**
 * API-Football predictions for upcoming fixtures (1 request per fixture).
 * Stored as append-only snapshots; re-collected at most every `minGapHours`.
 */
export function syncApiPredictions(ctx: JobContext, opts: { hours?: number; minGapHours?: number } = {}) {
  const leagues = ctx.env.TRACKED_LEAGUES;
  const hours = opts.hours ?? 48;
  const minGap = opts.minGapHours ?? 12;
  return runJob(ctx, 'predictions', { leagues, hours, minGap }, async () => {
    const now = new Date();
    const upcoming = await ctx.repo.upcomingFixtures(leagues, now.toISOString(), addHours(now, hours).toISOString());
    let n = 0;
    for (const f of upcoming) {
      const last = await ctx.repo.lastApiPredictionAt(f.id);
      if (last && now.getTime() - last.getTime() < minGap * 3_600_000) continue;
      const res = await ctx.api.predictions(f.id);
      const item = res.data[0];
      if (!item) continue;
      n += await ctx.repo.insertApiPrediction(toApiPredictionRow(f.id, item, res.meta.rawResponseId));
    }
    return n;
  });
}

export function syncStandings(ctx: JobContext) {
  const { TRACKED_LEAGUES: leagues, SEASON: season } = ctx.env;
  return runJob(ctx, 'standings', { leagues, season }, async () => {
    let n = 0;
    for (const league of leagues) {
      const { data } = await ctx.api.standings({ league, season });
      for (const item of data) n += await ctx.repo.upsertStandings(toStandingRows(item));
    }
    return n;
  });
}

/** Heavy (many pages per league) — run weekly. */
export function syncPlayers(ctx: JobContext, opts: { maxPages?: number } = {}) {
  const { TRACKED_LEAGUES: leagues, SEASON: season } = ctx.env;
  return runJob(ctx, 'players', { leagues, season, ...opts }, async () => {
    let n = 0;
    for (const league of leagues) {
      const { data } = await ctx.api.players({ league, season }, opts.maxPages ?? 100);
      const mapped = data.map(toPlayerRows);
      n += await ctx.repo.upsertPlayers(mapped.map((m) => m.player));
      n += await ctx.repo.upsertPlayerSeasonStats(mapped.flatMap((m) => m.seasonStats));
    }
    return n;
  });
}

/**
 * Retention (ADR 0002): drop raw API audit rows older than N days (default 3); odds snapshots are kept for good.
 * --vacuum also returns the raw table's space to the OS.
 */
export function pruneStorage(ctx: JobContext, opts: { days?: number; vacuum?: boolean } = {}) {
  const days = opts.days ?? 3;
  return runJob(ctx, 'prune', { days, vacuum: !!opts.vacuum }, async () => {
    const before = await ctx.repo.databaseSizeBytes();
    const raw = await ctx.repo.pruneRawResponses(days);
    if (opts.vacuum) await ctx.repo.vacuumRawResponses();
    const after = await ctx.repo.databaseSizeBytes();
    const mb = (b: number) => Math.round(b / 1048576);
    ctx.log.info('storage pruned', { rawDeleted: raw, dbSizeMbBefore: mb(before), dbSizeMbAfter: mb(after) });
    return raw;
  });
}
