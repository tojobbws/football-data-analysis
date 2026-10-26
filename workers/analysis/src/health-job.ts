import { assessHealth, readHealth, runJob, type HealthIssue, type JobContext } from '@fp/database';

/**
 * Pipeline health (audit A-11). Prints every issue and fails when one is a PROBLEM, so the GitHub Actions run
 * fails and GitHub e-mails the owner: a stale job, an odds feed that stopped while matches are coming.
 */
export function healthJob(ctx: JobContext, opts: { now?: Date } = {}) {
  return runJob(ctx, 'health', {}, async () => {
    const issues = assessHealth(await readHealth(ctx.db, ctx.env.TRACKED_LEAGUES, opts.now));
    if (issues.length) console.table(issues);
    else console.log('pipeline healthy: every scheduled job succeeded on time and the odds feed is fresh');
    const problems = issues.filter((i) => i.level === 'PROBLEM');
    if (problems.length) throw new PipelineUnhealthy(problems);
    return issues.length;
  });
}

export class PipelineUnhealthy extends Error {
  constructor(readonly problems: HealthIssue[]) {
    super(`pipeline unhealthy: ${problems.map((p) => `${p.check} (${p.detail})`).join('; ')}`);
  }
}
