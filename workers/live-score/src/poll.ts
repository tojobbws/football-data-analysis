/**
 * One cron minute of live polling. Each poll is independent: a failed one (e.g. API-Football's
 * per-minute rate limit, which only this Worker hits — likely its shared egress IPs) is logged and
 * the next poll is the retry. Nothing sleeps on a failure, so a run never spills into the next
 * minute's run and the two never poll on top of each other.
 */
export interface PollMinuteOptions {
  /** seconds between polls (>= 15) */
  every: number;
  /** returns how many fixtures are in the live window (0 = nothing on, stop for this minute) */
  poll: () => Promise<number>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** don't start a poll after this many seconds into the minute */
  budgetSeconds?: number;
}

export async function pollMinute(opts: PollMinuteOptions): Promise<{ polls: number; failures: number }> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const budget = (opts.budgetSeconds ?? 50) * 1000;
  const start = now();
  let polls = 0;
  let failures = 0;
  for (let at = 0; at * 1000 <= budget; at += opts.every) {
    const wait = start + at * 1000 - now();
    if (wait > 0) await sleep(wait);
    if (now() - start > budget) break;
    polls++;
    try {
      if (!(await opts.poll())) break; // nothing on (or the API returned nothing): stop until next minute
    } catch {
      failures++; // already recorded as a FAILED sync_runs row; the next poll retries
    }
  }
  return { polls, failures };
}
