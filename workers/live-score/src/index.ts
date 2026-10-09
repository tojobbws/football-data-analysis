/**
 * Cloudflare Worker: live scores. Cron fires every minute; each run polls every LIVE_POLL_SECONDS
 * (default 30) until the minute is up. `syncLive` checks the DB first, so while no match is on
 * a run costs one cheap query and zero API-Football requests.
 *
 * The DB is reached through Hyperdrive: Workers sockets can't verify Supabase's own-CA certificate,
 * Hyperdrive does TLS to the database itself (and pools connections across runs).
 */
import { createJobContext, createPgDb } from '@fp/database';
import { syncLive } from '@fp/football-sync';
import { loadEnv } from '@fp/shared';
import { pollMinute } from './poll.js';

interface WorkerEnv {
  HYPERDRIVE: { connectionString: string };
  API_FOOTBALL_KEY: string;
  TRACKED_LEAGUES: string;
  SEASON: string;
  LIVE_POLL_SECONDS?: string;
  LOG_LEVEL?: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export default {
  async scheduled(_controller: unknown, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runMinute(env));
  },
};

async function runMinute(bindings: WorkerEnv): Promise<void> {
  const { HYPERDRIVE, ...vars } = bindings;
  const env = loadEnv({ ...vars, DATABASE_URL: HYPERDRIVE.connectionString });
  const every = Math.max(15, Number(bindings.LIVE_POLL_SECONDS) || 30);
  // no in-run retries: a rate-limited request fails fast and the next poll (≤ `every` s later) retries
  const job = createJobContext({ env, db: createPgDb(env.DATABASE_URL, { max: 1, ssl: false }), storeRawResponses: false, maxRetries: 0 });
  try {
    await pollMinute({ every, poll: () => syncLive(job) });
  } finally {
    await job.db.close();
  }
}
