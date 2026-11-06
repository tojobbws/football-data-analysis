/**
 * The featured list of a pick day, chosen once (featured-ai-v2, docs/adr/0014-one-daily-pick-run.md).
 *
 * Runs hourly after `model:publish`. For the current pick day (14:00 → 14:00 Thai) without a list yet, between
 * 14:00 and LIST_LATEST_HOUR: once every match still ahead has a published round, or once the run's cut-off (16:00)
 * has passed, the list is chosen with the ai-v1 order and caps from the matches not kicked off yet and written in one
 * statement: listed matches CONFIRMED with their rank, every other published match SKIPPED. It never changes after.
 * A day with no qualifying pick has no list (no rows) and is looked at again until LIST_LATEST_HOUR.
 */
import { DAILY_MIN_MINUTES, FEATURED_AI_V2, reserveFeatured, type FeaturedCandidate, type FeaturedConfig } from '@fp/analysis';
import { runJob, type JobContext } from '@fp/database';
import { addHours, PICK_RUN_CUTOFF_HOUR, PICK_RUN_HOUR, pickDay } from '@fp/shared';

/** After 20:00 Thai a pick day without a list stays without one (e.g. the switch day, or runs that did not happen). */
export const LIST_LATEST_HOUR = 20;

export interface FeaturedOnceOptions {
  now?: Date;
  config?: FeaturedConfig;
}

const confidenceOf = (s: string | null) => (s === 'STRONG' ? 'HIGH' : s === 'MEDIUM' ? 'MEDIUM' : s === 'LEAN' ? 'LOW' : null);

export function featuredOnceJob(ctx: JobContext, opts: FeaturedOnceOptions = {}) {
  const cfg = opts.config ?? FEATURED_AI_V2;
  const leagues = ctx.env.TRACKED_LEAGUES;
  return runJob(ctx, 'featured', { version: cfg.version }, async () => {
    const now = opts.now ?? new Date();
    const day = pickDay(now);
    if (now >= addHours(day.from, LIST_LATEST_HOUR - PICK_RUN_HOUR)) return 0;
    if ((await ctx.repo.featuredRows(day.date, cfg.version)).length) return 0;

    const [matches, upcoming] = await Promise.all([
      ctx.repo.featuredDayMatches(leagues, day.from.toISOString(), day.to.toISOString()),
      ctx.repo.fixturesForCandidates(leagues, now.toISOString(), day.to.toISOString()),
    ]);
    const published = new Map(matches.filter((m) => m.predictionId != null).map((m) => [m.fixtureId, m]));
    const soon = addHours(now, DAILY_MIN_MINUTES / 60);
    // the pick day is half open (dailyRoundFor): a 14:00 kick-off belongs to the next one and never waits here
    const waiting = upcoming.filter((f) => f.kickoffAt >= soon && f.kickoffAt < day.to && !published.has(f.id));
    const cutoff = addHours(day.from, PICK_RUN_CUTOFF_HOUR - PICK_RUN_HOUR);
    if (waiting.length && now < cutoff) {
      ctx.log.info('featured: the daily pick run is not finished; the list waits', { date: day.date, version: cfg.version, waiting: waiting.length });
      return 0;
    }

    // nothing is chosen after the whistle: only matches that have not kicked off
    const ahead = [...published.values()].filter((m) => m.kickoffAt > now);
    const candidates: FeaturedCandidate[] = ahead
      .filter((m) => m.kind === 'SIGNAL')
      .map((m) => ({ predictionId: m.predictionId!, fixtureId: m.fixtureId, leagueId: m.leagueId, kickoffAt: m.kickoffAt, supportScore: null, distribution: null, gateEnabled: true, market: m.market ?? undefined, marketProbability: m.marketProbability, engine: m.engine, aiConfidence: confidenceOf(m.signalStrength), dataGaps: m.dataGaps ?? 0 }));
    const listed = reserveFeatured(candidates, [], cfg);
    if (!listed.length) {
      ctx.log.info('featured: no qualifying pick, the day has no list', { date: day.date, version: cfg.version });
      return 0;
    }
    const rankOf = new Map(listed.map((c, i) => [c.fixtureId, i + 1]));
    const rows = ahead.map((m) => {
      const rank = rankOf.get(m.fixtureId) ?? null;
      return { fixtureId: m.fixtureId, leagueId: m.leagueId, phase: rank === null ? ('SKIPPED' as const) : ('CONFIRMED' as const), rank, predictionId: m.predictionId };
    });
    const written = await ctx.repo.insertFeaturedList(day.date, cfg.version, rows);
    ctx.log.info('featured', { date: day.date, version: cfg.version, listed: listed.map((c) => c.fixtureId), written });
    return written ? rows.length : 0;
  });
}
