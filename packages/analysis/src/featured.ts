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
  /** a league's own cap, in place of maxPerLeague (featured-ai-v3: the Nations League, one league of many groups) */
  leagueCaps?: Readonly<Record<number, number>>;
  maxPerDay: number;
  /** wanted per day; never reached by relaxing the thresholds, only reported */
  target: number;
  /** tracked, but outside the featured scope */
  excludedLeagues: readonly number[];
  /** how qualifying picks are ranked: the support score (edge over the market), or the model blended with the market */
  rankBy: 'SUPPORT' | 'BLENDED';
  /** weight of the model in the blended probability (the rest is the market's no-vig probability) */
  modelWeight: number;
  /** Over/Under needs a second independent signal (ADR 0006) that does not exist yet, so v2 leaves it out */
  allowOverUnder: boolean;
  /** MODEL: picks of the rules engine, ranked by probability. AI: picks of the Hybrid AI, which have no model probability (ADR 0012) */
  pool: 'MODEL' | 'AI';
  /** AI pool: leagues listed first (the big five) */
  priorityLeagues: readonly number[];
  /**
   * HOURLY: slots are reserved every hour and locked match by match (v1, v2, ai-v1, per football day).
   * ONCE: the list of a pick day is chosen once, after the daily pick run, and confirmed at once (ai-v2, ADR 0014).
   */
  choose?: 'HOURLY' | 'ONCE';
}

/** The AI's confidence in the evidence, as stored on its published pick (STRONG = HIGH, MEDIUM, LEAN = LOW). */
export type AiConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

/** Frozen for the shadow trial (ADR 0004): any change is a new version and the count restarts. */
export const FEATURED_V1: FeaturedConfig = {
  version: 'featured-v1',
  minFairWin: 0.55,
  maxPerLeague: 2,
  maxPerDay: 5,
  target: 3,
  // national-team competitions (5 UNL, 536 CONCACAF NL, 36 AFCON qual., 7 Asian Cup) stay out of v1 to ai-v2;
  // 536/36/7 were added 2026-11-09 before they were tracked, so no version's pool changed. ai-v3 takes UNL (ADR 0015).
  // Copa del Rey (143) likewise, added 2026-11-10 before it was tracked.
  excludedLeagues: [296, 5, 1129, 536, 36, 7, 143],
  rankBy: 'SUPPORT',
  modelWeight: 1,
  allowOverUnder: true,
  pool: 'MODEL',
  priorityLeagues: [],
};

/** ADR 0006: ranked by the model blended 50/50 with the market; the edge stays a gate (already one of the pick rules). */
export const FEATURED_V2: FeaturedConfig = {
  ...FEATURED_V1,
  version: 'featured-v2',
  rankBy: 'BLENDED',
  modelWeight: 0.5,
  allowOverUnder: false,
};

/**
 * ADR 0012: the list for Hybrid AI picks. Asian handicap and Over/Under, only a pick the AI is at least MEDIUM sure of.
 * Order is editorial, declared before any result: the big five leagues, fewer data gaps, earlier kick-off.
 * Caps and excluded leagues are those of v1/v2. A new version, so its count starts again (ADR 0004).
 */
export const FEATURED_AI_V1: FeaturedConfig = {
  ...FEATURED_V1,
  version: 'featured-ai-v1',
  allowOverUnder: true,
  pool: 'AI',
  priorityLeagues: [39, 140, 78, 135, 61],
};

/**
 * ADR 0014: the list of a pick day (14:00 → 14:00 Thai), chosen once after the daily pick run with the order, pool
 * and caps of ai-v1, every listed match confirmed at once (no DROPPED). A new version, so its count starts again.
 */
export const FEATURED_AI_V2: FeaturedConfig = {
  ...FEATURED_AI_V1,
  version: 'featured-ai-v2',
  choose: 'ONCE',
};

/**
 * ADR 0015: ai-v2 with the UEFA Nations League (5) in scope, up to 5 of its matches a day (it is one league of many
 * groups). The other national-team competitions stay out. A new version, so its count starts again.
 */
export const FEATURED_AI_V3: FeaturedConfig = {
  ...FEATURED_AI_V2,
  version: 'featured-ai-v3',
  excludedLeagues: [296, 1129, 536, 36, 7, 143],
  leagueCaps: { 5: 5 },
};

/** Every version by name, for the report and the job that chooses a pick day's list. */
export const FEATURED_CONFIGS: Readonly<Record<string, FeaturedConfig>> = Object.fromEntries(
  [FEATURED_V1, FEATURED_V2, FEATURED_AI_V1, FEATURED_AI_V2, FEATURED_AI_V3].map((c) => [c.version, c]),
);

/** The current pick of a match not locked yet. */
export interface FeaturedCandidate {
  predictionId: number;
  fixtureId: number;
  leagueId: number;
  kickoffAt: Date;
  /** pool MODEL only */
  supportScore: number | null;
  /** pool MODEL only: the model's outcome distribution of the pick (an AI pick has none) */
  distribution: OutcomeDistribution | null;
  /** pool AI only */
  engine?: string | null;
  aiConfidence?: AiConfidence | null;
  /** pool AI only: items the decision lists as missing data; fewer is better */
  dataGaps?: number;
  /** the pick's market passes the league's tuning gate */
  gateEnabled: boolean;
  market?: string;
  modelProbability?: number | null;
  marketProbability?: number | null;
}

/** Probability the list is ranked by: model and no-vig market blended; without a market quote, the model alone. */
export function blendedProbability(c: Pick<FeaturedCandidate, 'modelProbability' | 'marketProbability'>, modelWeight: number): number | null {
  if (c.modelProbability == null) return null;
  if (c.marketProbability == null) return c.modelProbability;
  return modelWeight * c.modelProbability + (1 - modelWeight) * c.marketProbability;
}

function rankScore(c: FeaturedCandidate, cfg: FeaturedConfig): number {
  return cfg.rankBy === 'BLENDED' ? (blendedProbability(c, cfg.modelWeight) ?? -1) : (c.supportScore ?? -1);
}

/** Pool AI order (ADR 0012): the AI's confidence, then on a tie priority leagues, fewer data gaps, earlier kick-off, fixture id. */
function compareAi(a: FeaturedCandidate, b: FeaturedCandidate, cfg: FeaturedConfig): number {
  const conf = (c: FeaturedCandidate) => (c.aiConfidence === 'HIGH' ? 0 : 1);
  const pri = (c: FeaturedCandidate) => (cfg.priorityLeagues.includes(c.leagueId) ? 0 : 1);
  return conf(a) - conf(b) || pri(a) - pri(b) || (a.dataGaps ?? 0) - (b.dataGaps ?? 0) || a.kickoffAt.getTime() - b.kickoffAt.getTime() || a.fixtureId - b.fixtureId;
}

export interface LockedSlot {
  fixtureId: number;
  leagueId: number;
}

export function isFeaturedEligible(c: FeaturedCandidate, cfg: FeaturedConfig = FEATURED_V1): boolean {
  if (!cfg.allowOverUnder && c.market === 'OVER_UNDER') return false;
  if (cfg.excludedLeagues.includes(c.leagueId)) return false;
  if (cfg.pool === 'AI') return c.engine === 'hybrid-ai-v1' && (c.aiConfidence === 'MEDIUM' || c.aiConfidence === 'HIGH');
  return c.gateEnabled && c.distribution != null && fairProbability(c.distribution) >= cfg.minFairWin;
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
    .sort((a, b) => (cfg.pool === 'AI' ? compareAi(a, b, cfg) : rankScore(b, cfg) - rankScore(a, cfg) || a.kickoffAt.getTime() - b.kickoffAt.getTime() || a.fixtureId - b.fixtureId));

  const out: FeaturedCandidate[] = [];
  for (const c of ranked) {
    if (confirmed.length + out.length >= cfg.maxPerDay) break;
    if (out.some((o) => o.fixtureId === c.fixtureId)) continue;
    const n = perLeague.get(c.leagueId) ?? 0;
    if (n >= (cfg.leagueCaps?.[c.leagueId] ?? cfg.maxPerLeague)) continue;
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
