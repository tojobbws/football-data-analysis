/**
 * Pipeline health (audit A-11): is every scheduled job still succeeding on time, is the odds feed fresh while
 * matches are coming, and did any match kick off without a published record? `npm run job -w
 * @fp/analysis-worker -- health` exits non-zero on a problem, so a failed GitHub Actions run (and its
 * e-mail) is the alert; no extra service.
 */
import type { Queryable } from './db.js';

/** Longest normal gap between successful runs, in hours (schedules in .github/workflows/sync.yml). */
export const JOB_MAX_AGE_HOURS: Readonly<Record<string, number>> = {
  // hourly, dispatched by the live-score Worker's cron
  odds: 3,
  results: 3,
  settle: 3,
  closing: 3,
  probabilities: 3,
  candidates: 3,
  publish: 3,
  // runs every hour; does nothing while PICK_ENGINE=legacy
  hybrid: 3,
  'refresh-web': 3,
  // daily
  fixtures: 30,
  injuries: 30,
  standings: 30,
  // weekly
  tune: 8 * 24,
};

export interface HealthInput {
  now: Date;
  /** last SUCCESS per job (absent = never) */
  lastSuccess: ReadonlyMap<string, Date>;
  /** runs closed as FAILED in the last 24 hours, per job */
  failed24h: ReadonlyMap<string, number>;
  /** newest odds_history row (collected_at) */
  lastOddsAt: Date | null;
  /** fixtures not started yet, kicking off within 24 hours */
  upcoming24h: number;
  /** tracked matches that kicked off 1–24 hours ago with model prices but no published record at all */
  kickedOffUnpublished: number;
}

export interface HealthIssue {
  level: 'PROBLEM' | 'WARNING';
  check: string;
  detail: string;
}

export const ODDS_MAX_AGE_HOURS = 3;

export function assessHealth(h: HealthInput): HealthIssue[] {
  const issues: HealthIssue[] = [];
  const hoursSince = (d: Date) => (h.now.getTime() - d.getTime()) / 3_600_000;
  for (const [job, maxAge] of Object.entries(JOB_MAX_AGE_HOURS)) {
    const last = h.lastSuccess.get(job);
    if (!last) issues.push({ level: 'PROBLEM', check: `job ${job}`, detail: 'no successful run on record' });
    else if (hoursSince(last) > maxAge) issues.push({ level: 'PROBLEM', check: `job ${job}`, detail: `last success ${hoursSince(last).toFixed(1)} h ago (limit ${maxAge} h)` });
    const failed = h.failed24h.get(job) ?? 0;
    if (failed > 0) issues.push({ level: 'WARNING', check: `job ${job}`, detail: `${failed} failed run(s) in the last 24 h` });
  }
  if (h.upcoming24h > 0 && (!h.lastOddsAt || hoursSince(h.lastOddsAt) > ODDS_MAX_AGE_HOURS))
    issues.push({
      level: 'PROBLEM',
      check: 'odds feed',
      detail: `${h.upcoming24h} match(es) within 24 h but the newest odds were stored ${h.lastOddsAt ? `${hoursSince(h.lastOddsAt).toFixed(1)} h ago` : 'never'}`,
    });
  if (h.kickedOffUnpublished > 0)
    issues.push({ level: 'WARNING', check: 'publish', detail: `${h.kickedOffUnpublished} match(es) kicked off in the last 24 h with model prices but no published record` });
  return issues;
}

/** Reads what assessHealth needs. `leagues` = tracked leagues. */
export async function readHealth(db: Queryable, leagues: readonly number[], now = new Date()): Promise<HealthInput> {
  const [runs, odds, upcoming, unpublished] = await Promise.all([
    db.query<{ job: string; last_ok: string | Date | null; failed: string | number }>(
      `select job, max(started_at) filter (where status = 'SUCCESS') as last_ok,
              count(*) filter (where status = 'FAILED' and started_at > $1::timestamptz - interval '24 hours') as failed
         from sync_runs where job = any($2::text[]) group by job`,
      [now.toISOString(), Object.keys(JOB_MAX_AGE_HOURS)],
    ),
    db.query<{ t: string | Date | null }>(`select max(collected_at) as t from odds_history where collected_at > $1::timestamptz - interval '14 days'`, [now.toISOString()]),
    db.query<{ n: string | number }>(
      `select count(*) as n from fixtures where league_id = any($1::int[]) and status_short in ('NS', 'TBD')
          and kickoff_at > $2::timestamptz and kickoff_at <= $2::timestamptz + interval '24 hours'`,
      [leagues, now.toISOString()],
    ),
    db.query<{ n: string | number }>(
      `select count(*) as n from fixtures f
        where f.league_id = any($1::int[])
          and f.kickoff_at between $2::timestamptz - interval '24 hours' and $2::timestamptz - interval '1 hour'
          and f.status_short not in ('PST', 'CANC', 'ABD', 'AWD', 'WO', 'TBD')
          and exists (select 1 from probability_predictions p where p.fixture_id = f.id and p.computed_at < f.kickoff_at)
          and not exists (select 1 from analysis_predictions a where a.fixture_id = f.id)`,
      [leagues, now.toISOString()],
    ),
  ]);
  const lastSuccess = new Map<string, Date>();
  const failed24h = new Map<string, number>();
  for (const r of runs.rows) {
    if (r.last_ok) lastSuccess.set(r.job, new Date(r.last_ok));
    failed24h.set(r.job, Number(r.failed));
  }
  const t = odds.rows[0]?.t;
  return {
    now,
    lastSuccess,
    failed24h,
    lastOddsAt: t ? new Date(t) : null,
    upcoming24h: Number(upcoming.rows[0]?.n ?? 0),
    kickedOffUnpublished: Number(unpublished.rows[0]?.n ?? 0),
  };
}
