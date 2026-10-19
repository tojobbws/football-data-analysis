import { ApiFootball, ApiFootballClient } from '@fp/football';
import { createLogger, loadEnv, type Env, type Logger } from '@fp/shared';
import { budgetVerdict } from './budget.js';
import { createPgDb, type Db } from './db.js';
import { Repository } from './repository.js';

export interface JobContext {
  env: Env;
  db: Db;
  repo: Repository;
  api: ApiFootball;
  client: ApiFootballClient;
  log: Logger;
}

/**
 * Wires env -> DB -> API client. Every API response is stored in api_raw_responses
 * BEFORE it is processed (source + timestamp + raw data, always) — except with
 * `storeRawResponses: false` (live-score polling: the final state is still stored by `results`).
 */
export function createJobContext(
  overrides: Partial<Pick<JobContext, 'db'>> & { env?: Env; storeRawResponses?: boolean; maxRetries?: number } = {},
): JobContext {
  const env = overrides.env ?? loadEnv();
  const log = createLogger(env.LOG_LEVEL);
  const db = overrides.db ?? createPgDb(env.DATABASE_URL);
  const repo = new Repository(db);
  const client = new ApiFootballClient({
    apiKey: env.API_FOOTBALL_KEY,
    baseUrl: env.API_FOOTBALL_BASE_URL,
    requestsPerMinute: env.API_FOOTBALL_RPM,
    maxRetries: overrides.maxRetries,
    onRawResponse: overrides.storeRawResponses === false ? undefined : (rec) => repo.insertRawResponse(rec),
    onRequest: (endpoint, params) => log.debug('api request', { endpoint, params }),
  });
  return { env, db, repo, api: new ApiFootball(client), client, log };
}

/**
 * Tracked leagues with their own current season: calendar-year leagues (MLS, J1, Allsvenskan, ...)
 * change season in Feb-Mar while European ones change in August. Falls back to env SEASON for a
 * league `sync:leagues` has not stored yet.
 */
export async function trackedLeagueSeasons(ctx: Pick<JobContext, 'env' | 'repo'>, leagues = ctx.env.TRACKED_LEAGUES) {
  const current = await ctx.repo.currentSeasons(leagues);
  return leagues.map((league) => ({ league, season: current.get(league) ?? ctx.env.SEASON }));
}

/** Runs a job with a sync_runs audit row and API request accounting. */
export async function runJob(
  ctx: JobContext,
  name: string,
  params: Record<string, unknown>,
  fn: () => Promise<number>,
): Promise<number> {
  const budget = await ctx.repo.apiBudgetFor(name);
  if (budget && budgetVerdict(budget) === 'stop') {
    // the group's daily cap is reached: do nothing (no API call, no writes), so a later re-run is always safe
    const first = await ctx.repo.recordBudgetSkip(name, { ...params, group: budget.group, used: budget.used, cap: budget.cap });
    if (first) ctx.log.warn('job skipped: daily API budget reached', { job: name, ...budget });
    return 0;
  }
  const runId = await ctx.repo.startSyncRun(name, params);
  const before = ctx.client.billedCount;
  const rejectedBefore = ctx.client.rejectedCount;
  const log = ctx.log.child({ job: name, runId });
  log.info('job started', params);
  try {
    const written = await fn();
    const requestsUsed = ctx.client.billedCount - before;
    const requestsRejected = ctx.client.rejectedCount - rejectedBefore;
    await ctx.repo.finishSyncRun(runId, { status: 'SUCCESS', requestsUsed, requestsRejected, dailyRemaining: ctx.client.lastRateLimit.dailyRemaining, itemsWritten: written });
    log.info('job finished', { written, requestsUsed, dailyRemaining: ctx.client.lastRateLimit.dailyRemaining });
    return written;
  } catch (err) {
    const requestsUsed = ctx.client.billedCount - before;
    const requestsRejected = ctx.client.rejectedCount - rejectedBefore;
    await ctx.repo
      .finishSyncRun(runId, { status: 'FAILED', requestsUsed, requestsRejected, dailyRemaining: ctx.client.lastRateLimit.dailyRemaining, itemsWritten: 0, error: String(err instanceof Error ? err.stack ?? err.message : err) })
      .catch(() => {});
    log.error('job failed', { error: String(err) });
    throw err;
  }
}
