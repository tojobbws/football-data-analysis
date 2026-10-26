/** Audit A-11: pipeline health checks and closing runs a killed process left RUNNING. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assessHealth, JOB_MAX_AGE_HOURS, readHealth, Repository, STALE_RUN_MINUTES, type HealthInput } from '../src/index.js';
import { createTestDb } from './helpers.js';

const NOW = new Date('2026-10-26T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

function healthy(): HealthInput {
  return {
    now: NOW,
    lastSuccess: new Map(Object.keys(JOB_MAX_AGE_HOURS).map((job) => [job, hoursAgo(1)])),
    failed24h: new Map(),
    lastOddsAt: hoursAgo(1),
    upcoming24h: 10,
    kickedOffUnpublished: 0,
  };
}

describe('assessHealth', () => {
  it('a pipeline where every job ran on time and odds are fresh has no issue', () => {
    expect(assessHealth(healthy())).toEqual([]);
  });

  it('a stale or missing job is a problem; failed runs alone are a warning', () => {
    const h = healthy();
    (h.lastSuccess as Map<string, Date>).set('publish', hoursAgo(5));
    (h.lastSuccess as Map<string, Date>).delete('tune');
    (h.failed24h as Map<string, number>).set('odds', 2);
    const issues = assessHealth(h);
    expect(issues).toContainEqual({ level: 'PROBLEM', check: 'job publish', detail: 'last success 5.0 h ago (limit 3 h)' });
    expect(issues).toContainEqual({ level: 'PROBLEM', check: 'job tune', detail: 'no successful run on record' });
    expect(issues).toContainEqual({ level: 'WARNING', check: 'job odds', detail: '2 failed run(s) in the last 24 h' });
  });

  it('old odds are a problem only while matches are coming', () => {
    expect(assessHealth({ ...healthy(), lastOddsAt: hoursAgo(5) })[0]).toMatchObject({ level: 'PROBLEM', check: 'odds feed' });
    expect(assessHealth({ ...healthy(), lastOddsAt: hoursAgo(5), upcoming24h: 0 })).toEqual([]);
  });

  it('a kicked-off match with model prices and no published record is a warning', () => {
    expect(assessHealth({ ...healthy(), kickedOffUnpublished: 2 })).toEqual([{ level: 'WARNING', check: 'publish', detail: '2 match(es) kicked off in the last 24 h with model prices but no published record' }]);
  });
});

describe('readHealth and stale runs (PGlite)', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => {
    db = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  it('a run left RUNNING longer than the limit is closed as FAILED when the job starts again', async () => {
    const repo = new Repository(db);
    await db.exec(`
      insert into sync_runs (job, status, started_at) values
        ('tune', 'RUNNING', now() - interval '${STALE_RUN_MINUTES + 10} minutes'),
        ('tune', 'RUNNING', now() - interval '5 minutes'),
        ('odds', 'RUNNING', now() - interval '${STALE_RUN_MINUTES + 10} minutes');`);
    const id = await repo.startSyncRun('tune', {});
    const rows = (await db.query<{ id: string; job: string; status: string; error: string | null }>(`select id, job, status, error from sync_runs order by id`)).rows;
    expect(rows.map((r) => [r.job, r.status])).toEqual([
      ['tune', 'FAILED'], // abandoned
      ['tune', 'RUNNING'], // a run of 5 minutes may still be going
      ['odds', 'RUNNING'], // another job: left to its own next start
      ['tune', 'RUNNING'], // the new run
    ]);
    expect(rows[0]!.error).toMatch(/^abandoned/);
    expect(Number(rows[3]!.id)).toBe(id);
  });

  it('reads last successes, failures, odds age, upcoming and unpublished matches', async () => {
    const now = new Date();
    await db.exec(`
      insert into sync_runs (job, status, started_at, finished_at) values
        ('publish', 'SUCCESS', now() - interval '2 hours', now() - interval '2 hours'),
        ('publish', 'FAILED', now() - interval '1 hour', now() - interval '1 hour');
      insert into leagues (id, name) values (39, 'Premier League');
      insert into teams (id, name) values (1, 'A'), (2, 'B');
      insert into bookmakers (id, name) values (1, 'b1');
      insert into model_versions (id) values ('dixon-coles-v0.2');
      insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short) values
        (1, 39, 2026, now() + interval '5 hours', 1, 2, 'NS'),
        (2, 39, 2026, now() - interval '3 hours', 2, 1, 'FT');
      insert into probability_predictions (fixture_id, model_version_id, computed_at, market, selection, probability)
        values (2, 'dixon-coles-v0.2', now() - interval '5 hours', 'MATCH_WINNER', 'HOME', 0.5);
      insert into odds_history (fixture_id, bookmaker_id, market, api_bet_id, api_bet_name, selection, raw_value, odds, source_updated_at, collected_at)
        values (1, 1, 'MATCH_WINNER', 1, 'Match Winner', 'HOME', 'Home', 2.0, now() - interval '4 hours', now() - interval '4 hours');`);
    const h = await readHealth(db, [39], now);
    expect(h.lastSuccess.get('publish')!.getTime()).toBeLessThan(now.getTime());
    expect(h.failed24h.get('publish')).toBe(1);
    expect(h.upcoming24h).toBe(1);
    expect(h.kickedOffUnpublished).toBe(1);
    expect((now.getTime() - h.lastOddsAt!.getTime()) / 3_600_000).toBeCloseTo(4, 1);
    const issues = assessHealth(h);
    expect(issues.find((i) => i.check === 'odds feed')?.level).toBe('PROBLEM');
    expect(issues.find((i) => i.check === 'publish')?.level).toBe('WARNING');
  });
});
