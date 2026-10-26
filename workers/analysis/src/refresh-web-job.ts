import { runJob, type JobContext } from '@fp/database';

/**
 * Refreshes the materialized model results behind /performance (migration 0044, audit A-18): the site reads
 * them as of this run. Hourly and daily, after settlement and the closing market.
 */
export function refreshWebJob(ctx: JobContext) {
  return runJob(ctx, 'refresh-web', {}, async () => {
    const started = Date.now();
    await ctx.db.query('select fp_refresh_web_results()');
    ctx.log.info('web results refreshed', { ms: Date.now() - started });
    return 1;
  });
}
