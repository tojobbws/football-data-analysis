/**
 * API request budget: jobs are grouped, a group at its daily cap is skipped (never results/lineups),
 * only today's requests that counted are summed, and only admins read the usage.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '@fp/shared';
import { BUDGET_WARN_RATIO, budgetVerdict, Repository, runJob, type JobContext } from '../src/index.js';
import { createTestDb } from './helpers.js';

let db: Awaited<ReturnType<typeof createTestDb>>;
let repo: Repository;
const ADMIN = '11111111-1111-1111-1111-111111111111';
const STRANGER = '33333333-3333-3333-3333-333333333333';
const q = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<R>(sql, params)).rows;

/** Only the parts of the client that runJob reads; a job "spends" by changing billed / rejected. */
function fakeCtx() {
  const client = {
    billed: 0,
    rejected: 0,
    requestCount: 0,
    get billedCount() {
      return this.billed;
    },
    get rejectedCount() {
      return this.rejected;
    },
    lastRateLimit: { dailyRemaining: 4000 as number | null, minuteRemaining: null },
  };
  const ctx = { repo, client, log: createLogger('error') } as unknown as JobContext;
  return { ctx, client };
}

const addRun = (job: string, requests: number, startedAt = 'now()') =>
  q(`insert into sync_runs (job, status, requests_used, started_at, finished_at) values ($1, 'SUCCESS', $2, ${startedAt}, now())`, [job, requests]);

beforeAll(async () => {
  db = await createTestDb();
  repo = new Repository(db);
  await db.exec(`
    create schema if not exists auth;
    create or replace function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant all on all tables in schema public to anon, authenticated;   -- like Supabase's default grants: RLS alone must hide the rows
    insert into admin_users (user_id, email, role) values ('${ADMIN}', 'admin@x', 'ADMIN');
  `);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('budgetVerdict', () => {
  it('stops an enforced group at its cap, warns from 80%, never stops an unenforced one', () => {
    expect(budgetVerdict({ used: 0, cap: 100, enforced: true })).toBe('ok');
    expect(budgetVerdict({ used: 79, cap: 100, enforced: true })).toBe('ok');
    expect(budgetVerdict({ used: 80, cap: 100, enforced: true })).toBe('warn');
    expect(budgetVerdict({ used: 99, cap: 100, enforced: true })).toBe('warn');
    expect(budgetVerdict({ used: 100, cap: 100, enforced: true })).toBe('stop');
    expect(budgetVerdict({ used: 5000, cap: 100, enforced: false })).toBe('warn');
    expect(BUDGET_WARN_RATIO).toBe(0.8);
  });
});

describe('usage per group', () => {
  it('seeds the four groups and maps jobs, defaulting to sync', async () => {
    const groups = await q<{ group_name: string; daily_cap: number; enforced: boolean }>(`select group_name, daily_cap, enforced from api_budgets order by 1`);
    expect(groups.map((g) => g.group_name)).toEqual(['critical', 'live', 'odds', 'sync']);
    expect(groups.find((g) => g.group_name === 'critical')!.enforced).toBe(false);
    expect((await repo.apiBudgetFor('live'))!.group).toBe('live');
    expect((await repo.apiBudgetFor('odds'))!.group).toBe('odds');
    expect((await repo.apiBudgetFor('results'))!.group).toBe('critical');
    expect((await repo.apiBudgetFor('lineups'))!.group).toBe('critical');
    expect((await repo.apiBudgetFor('injuries'))!.group).toBe('sync');
    expect((await repo.apiBudgetFor('some-new-job'))!.group).toBe('sync');
  });

  it('sums only today (UTC) and by group', async () => {
    await addRun('injuries', 120);
    await addRun('details', 30);
    await addRun('live', 7);
    await addRun('injuries', 999, `now() - interval '2 days'`); // an old day does not count
    expect((await repo.apiBudgetFor('standings'))!.used).toBe(150); // sync group: injuries + details
    expect((await repo.apiBudgetFor('live'))!.used).toBe(7);
  });
});

describe('runJob budget guard', () => {
  it('runs a job under its cap and records what counted and what was rejected', async () => {
    const { ctx, client } = fakeCtx();
    let called = 0;
    const written = await runJob(ctx, 'live', {}, async () => {
      called++;
      client.billed += 3;
      client.rejected += 2;
      return 5;
    });
    expect(written).toBe(5);
    expect(called).toBe(1);
    const [r] = await q<{ requests_used: number; requests_rejected: number; api_daily_remaining: number; status: string }>(
      `select requests_used, requests_rejected, api_daily_remaining, status from sync_runs where job = 'live' and params = '{}'::jsonb order by id desc limit 1`,
    );
    expect(r).toMatchObject({ requests_used: 3, requests_rejected: 2, api_daily_remaining: 4000, status: 'SUCCESS' });
  });

  it('skips a job once its group is at the cap: no API call, one skip row per 15 minutes', async () => {
    await q(`update api_budgets set daily_cap = 150 where group_name = 'sync'`); // 150 already used today
    const { ctx } = fakeCtx();
    let called = 0;
    const fn = async () => {
      called++;
      return 1;
    };
    expect(await runJob(ctx, 'standings', { x: 1 }, fn)).toBe(0);
    expect(await runJob(ctx, 'standings', { x: 1 }, fn)).toBe(0);
    expect(called).toBe(0);
    const skips = await q(`select params from sync_runs where job = 'standings' and params->>'skipped' = 'budget'`);
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatchObject({ params: { skipped: 'budget', group: 'sync', used: 150, cap: 150, x: 1 } });
    await q(`update api_budgets set daily_cap = 1500 where group_name = 'sync'`);
  });

  it('never skips results or lineups, however much is used', async () => {
    await addRun('results', 5000);
    const { ctx } = fakeCtx();
    let called = 0;
    await runJob(ctx, 'results', {}, async () => {
      called++;
      return 1;
    });
    await runJob(ctx, 'lineups', {}, async () => {
      called++;
      return 1;
    });
    expect(called).toBe(2);
  });

  it('a skipped job leaves nothing half-done, so running it again later is safe', async () => {
    await q(`update api_budgets set daily_cap = 0 where group_name = 'odds'`);
    const { ctx } = fakeCtx();
    let called = 0;
    const fn = async () => {
      called++;
      return 1;
    };
    await runJob(ctx, 'odds', {}, fn);
    expect(called).toBe(0);
    await q(`update api_budgets set daily_cap = 3000 where group_name = 'odds'`);
    await runJob(ctx, 'odds', {}, fn);
    expect(called).toBe(1);
  });

  it('keeps running jobs when the budget tables are missing (code deployed before the migration)', async () => {
    const broken = new Repository({ ...db, query: async () => Promise.reject(new Error('relation does not exist')) } as never);
    expect(await broken.apiBudgetFor('live')).toBeNull();
  });
});

describe('admin usage view', () => {
  async function asUser<T>(role: 'anon' | 'authenticated', uid: string | null, fn: () => Promise<T>) {
    await db.exec(`begin; set local role ${role}; select set_config('test.uid', '${uid ?? ''}', true);`);
    try {
      return await fn();
    } finally {
      await db.exec('rollback;');
    }
  }

  it('is readable by an admin only', async () => {
    const usage = await asUser('authenticated', ADMIN, async () => (await db.query<{ u: { today: Array<{ group_name: string }>; days: unknown[] } }>(`select fp_admin_api_usage() as u`)).rows[0]!.u);
    expect(usage.today.map((t) => t.group_name).sort()).toEqual(['critical', 'live', 'odds', 'sync']);
    expect(usage.days.length).toBeGreaterThan(0);
    await expect(asUser('authenticated', STRANGER, () => db.query(`select fp_admin_api_usage()`))).rejects.toThrow(/admin only/);
    await expect(asUser('anon', null, () => db.query(`select fp_admin_api_usage()`))).rejects.toThrow();
    await expect(asUser('anon', null, () => db.query(`select * from fp_api_usage_today()`))).rejects.toThrow();
    expect(await asUser('anon', null, async () => (await db.query(`select * from api_budgets`)).rows)).toEqual([]);
  });
});
