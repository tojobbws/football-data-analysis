/**
 * Daily featured list report (ADR 0004): confirmed selections against all comparable picks of the same
 * period (LINEUP picks for the rules lists, every Hybrid AI pick for the AI lists, ADR 0012 / 0014; leagues
 * outside the featured scope left out), how many selections each day got, and the verdict. Read-only; it also needs ADR 0003's verdict before the list may go public.
 */
import { FEATURED_TRIAL, FEATURED_V1, featuredVerdict, trialSide, type TrialPick } from '@fp/analysis';
import type { JobContext } from '@fp/database';
import { footballDay, pickDay } from '@fp/shared';

const statusOf = (s: string | null): TrialPick['status'] => (s === null || s === 'PENDING' ? null : (s as TrialPick['status']));

export async function featuredReport(ctx: JobContext, opts: { version?: string; now?: Date } = {}) {
  const version = opts.version ?? FEATURED_V1.version;
  const now = opts.now ?? new Date();
  const locked = await ctx.repo.featuredLocked(version);

  const confirmed = locked.filter((r) => r.phase === 'CONFIRMED');
  const featured = trialSide(confirmed.map((r) => ({ status: statusOf(r.status), clv: r.clv })));

  const since = locked.length ? new Date(Math.min(...locked.map((r) => r.kickoffAt.getTime()))) : now;
  const all = trialSide(
    (await ctx.repo.publishedPicksSince(since))
      .filter((p) => (version.startsWith('featured-ai-') ? p.engine === 'hybrid-ai-v1' : p.round === 'LINEUP') && !FEATURED_V1.excludedLeagues.includes(p.leagueId))
      .map((p) => ({ status: statusOf(p.status), clv: p.clv })),
  );

  // finished days only (pick days for a list chosen once, football days before): per day, how many selections were confirmed
  const today = (version === 'featured-ai-v2' ? pickDay(now) : footballDay(now)).date;
  const perDay = new Map<string, number>();
  for (const r of locked) if (r.footballDate < today) perDay.set(r.footballDate, (perDay.get(r.footballDate) ?? 0) + (r.phase === 'CONFIRMED' ? 1 : 0));
  const days = { none: 0, belowTarget: 0, target: 0 };
  for (const n of perDay.values()) days[n === 0 ? 'none' : n < FEATURED_V1.target ? 'belowTarget' : 'target']++;

  return {
    version,
    since,
    trial: FEATURED_TRIAL,
    featured,
    all,
    dropped: locked.filter((r) => r.phase === 'DROPPED').length,
    days,
    ...featuredVerdict(featured, all),
  };
}
