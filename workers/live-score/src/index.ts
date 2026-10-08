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
  const job = createJobContext({ env, db: createPgDb(env.DATABASE_URL, { max: 1, ssl: false }), storeRawResponses: false });
  const start = Date.now();
  try {
    for (let at = 0; at < 60; at += every) {
      const wait = start + at * 1000 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (!(await syncLive(job))) break; // nothing on (or the API returned nothing): stop until next minute
    }
  } finally {
    await job.db.close();
  }
}
