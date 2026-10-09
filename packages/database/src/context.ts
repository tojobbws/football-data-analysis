import { ApiFootball, ApiFootballClient } from '@fp/football';
import { createLogger, loadEnv, type Env, type Logger } from '@fp/shared';
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

/** Runs a job with a sync_runs audit row and API request accounting. */
export async function runJob(
  ctx: JobContext,
  name: string,
  params: Record<string, unknown>,
  fn: () => Promise<number>,
): Promise<number> {
  const runId = await ctx.repo.startSyncRun(name, params);
  const before = ctx.client.requestCount;
  const log = ctx.log.child({ job: name, runId });
  log.info('job started', params);
  try {
    const written = await fn();
    const requestsUsed = ctx.client.requestCount - before;
    await ctx.repo.finishSyncRun(runId, { status: 'SUCCESS', requestsUsed, itemsWritten: written });
    log.info('job finished', { written, requestsUsed, dailyRemaining: ctx.client.lastRateLimit.dailyRemaining });
    return written;
  } catch (err) {
    const requestsUsed = ctx.client.requestCount - before;
    await ctx.repo
      .finishSyncRun(runId, { status: 'FAILED', requestsUsed, itemsWritten: 0, error: String(err instanceof Error ? err.stack ?? err.message : err) })
      .catch(() => {});
    log.error('job failed', { error: String(err) });
    throw err;
  }
}
