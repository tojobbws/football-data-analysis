/**
 * Daily featured list (คู่เด่นประจำวัน), shadow only — docs/adr/0004-daily-featured-shadow.md.
 *
 * Runs hourly after `model:publish`. For the current football day (06:00 → 06:00 Thai):
 *   1. a match whose LINEUP round is published (or that kicked off without one) is locked:
 *      CONFIRMED if it holds a reserved slot now, DROPPED if it held one earlier, SKIPPED otherwise;
 *   2. the other matches get the current reservation (rank, or none).
 * Only real picks are ranked. Nothing here is shown on fan pages.
 */
import { FEATURED_V1, fairProbability, lockFeatured, reserveFeatured, type FeaturedCandidate, type FeaturedConfig } from '@fp/analysis';
import { runJob, type JobContext } from '@fp/database';
import { footballDay } from '@fp/shared';

export interface FeaturedOptions {
  now?: Date;
  config?: FeaturedConfig;
}

export function featuredJob(ctx: JobContext, opts: FeaturedOptions = {}) {
  const cfg = opts.config ?? FEATURED_V1;
  const leagues = ctx.env.TRACKED_LEAGUES;
  return runJob(ctx, 'featured', { version: cfg.version }, async () => {
    const now = opts.now ?? new Date();
    const day = footballDay(now);
    const [matches, rows] = await Promise.all([
      ctx.repo.featuredDayMatches(leagues, day.from.toISOString(), day.to.toISOString()),
      ctx.repo.featuredRows(day.date, cfg.version),
    ]);
    const row = new Map(rows.map((r) => [r.fixtureId, r]));
    const confirmed = rows.filter((r) => r.phase === 'CONFIRMED').map((r) => ({ fixtureId: r.fixtureId, leagueId: r.leagueId }));
    const open = matches.filter((m) => !row.get(m.fixtureId)?.locked);

    const asCandidate = (m: (typeof open)[number]): FeaturedCandidate | null =>
      m.kind === 'SIGNAL' && m.predictionId != null && m.distribution && m.supportScore != null && (m.round === 'LINEUP' || m.kickoffAt > now)
        ? { predictionId: m.predictionId, fixtureId: m.fixtureId, leagueId: m.leagueId, kickoffAt: m.kickoffAt, supportScore: m.supportScore, distribution: m.distribution, gateEnabled: true, market: m.market ?? undefined, modelProbability: m.modelProbability, marketProbability: m.marketProbability }
        : null;
    const reserved = reserveFeatured(open.map(asCandidate).filter((c): c is FeaturedCandidate => c !== null), confirmed, cfg);
    const rankOf = (fixtureId: number) => {
      const i = reserved.findIndex((r) => r.fixtureId === fixtureId);
      return i < 0 ? null : confirmed.length + i + 1;
    };

    let changed = 0;
    for (const m of open) {
      const c = asCandidate(m);
      const base = {
        footballDate: day.date,
        version: cfg.version,
        fixtureId: m.fixtureId,
        leagueId: m.leagueId,
        predictionId: m.predictionId,
        supportScore: c?.supportScore ?? null,
        fairProbability: c ? round5(fairProbability(c.distribution)) : null,
      };
      const lockNow = m.round === 'LINEUP' || m.kickoffAt <= now;
      if (lockNow) {
        const phase = m.round === 'LINEUP' && lockFeatured(m.fixtureId, reserved) === 'CONFIRMED' ? 'CONFIRMED' : row.has(m.fixtureId) ? 'DROPPED' : 'SKIPPED';
        await ctx.repo.lockFeatured({ ...base, phase, rank: phase === 'CONFIRMED' ? rankOf(m.fixtureId) : null });
        changed++;
      } else {
        const rank = rankOf(m.fixtureId);
        if (rank === null && !row.has(m.fixtureId)) continue;
        if (row.get(m.fixtureId)?.rank === rank) continue;
        await ctx.repo.reserveFeatured({ ...base, rank });
        changed++;
      }
    }
    ctx.log.info('featured', { date: day.date, version: cfg.version, confirmed: confirmed.length, reserved: reserved.map((r) => r.fixtureId) });
    return changed;
  });
}

const round5 = (x: number) => Math.round(x * 1e5) / 1e5;
