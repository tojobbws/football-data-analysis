/**
 * Daily featured list (คู่เด่นประจำวัน, ADR 0004): up to 5 of a football day's Game Compass picks.
 * Only real picks are ranked (never a separate opinion), so the list never contradicts a match page.
 *
 * Every run recomputes the reserved slots from the matches not locked yet; a match is locked at its
 * LINEUP round: CONFIRMED if it holds a reserved slot at that moment, DROPPED otherwise. Confirmed
 * matches keep their slot and count towards the caps; a locked match never comes back.
 */
import { fairProbability, type OutcomeDistribution } from './settlement.js';
import type { TrialSide, TrialVerdict } from './shadow-rules.js';

export interface FeaturedConfig {
  version: string;
  /** minimum fair win chance of the pick (half outcomes as half, pushes left out) */
  minFairWin: number;
  maxPerLeague: number;
  maxPerDay: number;
  /** wanted per day; never reached by relaxing the thresholds, only reported */
  target: number;
  /** tracked, but outside the featured scope */
  excludedLeagues: readonly number[];
}

/** Frozen for the shadow trial (ADR 0004): any change is a new version and the count restarts. */
export const FEATURED_V1: FeaturedConfig = {
  version: 'featured-v1',
  minFairWin: 0.55,
  maxPerLeague: 2,
  maxPerDay: 5,
  target: 3,
  excludedLeagues: [296, 5, 1129],
};

/** The current pick of a match not locked yet. */
export interface FeaturedCandidate {
  predictionId: number;
  fixtureId: number;
  leagueId: number;
  kickoffAt: Date;
  supportScore: number;
  distribution: OutcomeDistribution;
  /** the pick's market passes the league's tuning gate */
  gateEnabled: boolean;
}

export interface LockedSlot {
  fixtureId: number;
  leagueId: number;
}

export function isFeaturedEligible(c: FeaturedCandidate, cfg: FeaturedConfig = FEATURED_V1): boolean {
  return c.gateEnabled && !cfg.excludedLeagues.includes(c.leagueId) && fairProbability(c.distribution) >= cfg.minFairWin;
}

/**
 * Reserved slots for the rest of the day, best first. `confirmed` are the day's matches already locked
 * into the list; `candidates` must hold only matches not locked yet (a dropped match is never offered again).
 */
export function reserveFeatured(candidates: FeaturedCandidate[], confirmed: LockedSlot[], cfg: FeaturedConfig = FEATURED_V1): FeaturedCandidate[] {
  const taken = new Set(confirmed.map((s) => s.fixtureId));
  const perLeague = new Map<number, number>();
  for (const s of confirmed) perLeague.set(s.leagueId, (perLeague.get(s.leagueId) ?? 0) + 1);

  const ranked = candidates
    .filter((c) => !taken.has(c.fixtureId) && isFeaturedEligible(c, cfg))
    .sort((a, b) => b.supportScore - a.supportScore || a.kickoffAt.getTime() - b.kickoffAt.getTime() || a.fixtureId - b.fixtureId);

  const out: FeaturedCandidate[] = [];
  for (const c of ranked) {
    if (confirmed.length + out.length >= cfg.maxPerDay) break;
    if (out.some((o) => o.fixtureId === c.fixtureId)) continue;
    const n = perLeague.get(c.leagueId) ?? 0;
    if (n >= cfg.maxPerLeague) continue;
    perLeague.set(c.leagueId, n + 1);
    out.push(c);
  }
  return out;
}

/** Decision for a match reaching its LINEUP lock, given the slots reserved in the same run. */
export function lockFeatured(fixtureId: number, reserved: FeaturedCandidate[]): 'CONFIRMED' | 'DROPPED' {
  return reserved.some((r) => r.fixtureId === fixtureId) ? 'CONFIRMED' : 'DROPPED';
}

/** Criteria fixed before any result (ADR 0004), judged on confirmed LINEUP selections. */
export const FEATURED_TRIAL = { minPicks: 150, extendTo: 300 } as const;

/** Featured selections against all LINEUP picks of the same period: CLV and fair hit rate must both be higher. */
export function featuredVerdict(featured: TrialSide, all: TrialSide, t: typeof FEATURED_TRIAL = FEATURED_TRIAL) {
  const criteria = {
    enoughPicks: featured.settled >= t.minPicks,
    clvBetter: featured.clvMean !== null && all.clvMean !== null && featured.clvMean > all.clvMean,
    fairBetter: featured.fairHitRate !== null && all.fairHitRate !== null && featured.fairHitRate > all.fairHitRate,
  };
  const verdict: TrialVerdict = !criteria.enoughPicks
    ? 'COLLECTING'
    : criteria.clvBetter && criteria.fairBetter
      ? 'PASS'
      : featured.settled < t.extendTo
        ? 'EXTEND'
        : 'FAIL';
  return { verdict, criteria };
}
