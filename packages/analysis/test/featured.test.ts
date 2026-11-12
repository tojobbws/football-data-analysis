import { describe, expect, it } from 'vitest';
import { FEATURED_AI_V1, FEATURED_AI_V2, FEATURED_AI_V3, FEATURED_AI_V4, FEATURED_V1, FEATURED_V2, blendedProbability, featuredVerdict, isFeaturedEligible, trialSide, type TrialPick, lockFeatured, reserveFeatured, type FeaturedCandidate } from '../src/index.js';

const at = (h: number) => new Date(Date.UTC(2026, 9, 17, h));
const pick = (fixtureId: number, leagueId: number, supportScore: number, over: Partial<FeaturedCandidate> = {}): FeaturedCandidate => ({
  predictionId: fixtureId * 10,
  fixtureId,
  leagueId,
  kickoffAt: at(12),
  supportScore,
  distribution: { win: 0.6, halfWin: 0, push: 0, halfLoss: 0, loss: 0.4 },
  gateEnabled: true,
  ...over,
});
const ids = (r: FeaturedCandidate[]) => r.map((c) => c.fixtureId);

describe('daily featured list', () => {
  it('needs a fair win chance of at least 0.55 (half outcomes as half, pushes left out) and an open gate', () => {
    expect(isFeaturedEligible(pick(1, 39, 5))).toBe(true);
    // 0.5 win + 0.1 half win + 0.2 push + 0.2 loss -> 0.55 / (0.55 + 0.2) = 0.733
    expect(isFeaturedEligible(pick(1, 39, 5, { distribution: { win: 0.5, halfWin: 0.1, push: 0.2, halfLoss: 0, loss: 0.2 } }))).toBe(true);
    expect(isFeaturedEligible(pick(1, 39, 5, { distribution: { win: 0.54, halfWin: 0, push: 0, halfLoss: 0, loss: 0.46 } }))).toBe(false);
    expect(isFeaturedEligible(pick(1, 39, 5, { gateEnabled: false }))).toBe(false);
    expect(isFeaturedEligible(pick(1, 296, 5))).toBe(false); // Thai League 1 is outside the featured scope
  });

  it('ranks by support score, earlier kickoff then fixture id on ties, at most 5', () => {
    const r = reserveFeatured(
      [pick(1, 39, 3), pick(2, 140, 9), pick(3, 135, 5, { kickoffAt: at(18) }), pick(4, 78, 5, { kickoffAt: at(15) }), pick(5, 61, 7), pick(6, 88, 1), pick(7, 94, 2)],
      [],
    );
    expect(ids(r)).toEqual([2, 5, 4, 3, 1]);
  });

  it('at most 2 per league, counting matches already confirmed', () => {
    expect(ids(reserveFeatured([pick(1, 39, 9), pick(2, 39, 8), pick(3, 39, 7), pick(4, 140, 1)], []))).toEqual([1, 2, 4]);
    expect(ids(reserveFeatured([pick(2, 39, 8), pick(3, 39, 7), pick(4, 140, 1)], [{ fixtureId: 1, leagueId: 39 }]))).toEqual([2, 4]);
  });

  it('never fills by relaxing the threshold: fewer than the target stays fewer', () => {
    const weak = { distribution: { win: 0.5, halfWin: 0, push: 0, halfLoss: 0, loss: 0.5 } };
    const r = reserveFeatured([pick(1, 39, 9), pick(2, 140, 8, weak), pick(3, 135, 7, weak)], []);
    expect(ids(r)).toEqual([1]);
    expect(r.length).toBeLessThan(FEATURED_V1.target);
  });

  it('confirmed matches keep their slots; the rest of the day fills only the free ones', () => {
    const confirmed = [1, 2, 3, 4].map((fixtureId) => ({ fixtureId, leagueId: 100 + fixtureId }));
    expect(ids(reserveFeatured([pick(5, 39, 1), pick(6, 140, 9)], confirmed))).toEqual([6]);
    expect(reserveFeatured([pick(6, 140, 9)], [...confirmed, { fixtureId: 5, leagueId: 105 }])).toEqual([]);
    // a confirmed match offered again is not reserved twice
    expect(ids(reserveFeatured([pick(1, 101, 99), pick(6, 140, 9)], confirmed))).toEqual([6]);
  });

  it('locks a match as confirmed only if it holds a reserved slot at its LINEUP round; a drop frees the slot', () => {
    // morning: 1..5 reserved, 6 is sixth
    const morning = reserveFeatured([1, 2, 3, 4, 5, 6].map((i) => pick(i, 100 + i, 10 - i)), []);
    expect(ids(morning)).toEqual([1, 2, 3, 4, 5]);

    // match 1 at LINEUP: its pick changed and is no longer eligible -> dropped, 6 moves up
    const run = reserveFeatured([pick(1, 101, 9, { gateEnabled: false }), ...[2, 3, 4, 5, 6].map((i) => pick(i, 100 + i, 10 - i))], []);
    expect(lockFeatured(1, run)).toBe('DROPPED');
    expect(ids(run)).toEqual([2, 3, 4, 5, 6]);
    expect(lockFeatured(2, run)).toBe('CONFIRMED');
  });

  it('verdict: collect 150, then both CLV and fair hit rate must beat all LINEUP picks; extend once to 300', () => {
    const side = (n: number, win: number, clv: number) =>
      trialSide(Array.from({ length: n }, (_, i): TrialPick => ({ status: i < win ? 'WIN' : 'LOSS', clv })));
    expect(featuredVerdict(side(149, 100, 0.05), side(1000, 500, 0)).verdict).toBe('COLLECTING');
    expect(featuredVerdict(side(150, 90, 0.02), side(1000, 500, 0.01)).verdict).toBe('PASS');
    expect(featuredVerdict(side(150, 90, 0.0), side(1000, 500, 0.01)).verdict).toBe('EXTEND'); // CLV not better
    expect(featuredVerdict(side(150, 70, 0.02), side(1000, 500, 0.01)).verdict).toBe('EXTEND'); // hit rate not better
    expect(featuredVerdict(side(300, 140, 0.02), side(1000, 500, 0.01)).verdict).toBe('FAIL');
  });
});

describe('featured-ai-v1 (ADR 0012)', () => {
  const ai = (fixtureId: number, leagueId: number, over: Partial<FeaturedCandidate> = {}): FeaturedCandidate =>
    pick(fixtureId, leagueId, 0, { supportScore: null, distribution: null, engine: 'hybrid-ai-v1', aiConfidence: 'MEDIUM', dataGaps: 2, market: 'ASIAN_HANDICAP', ...over });

  it('takes a Hybrid AI pick of MEDIUM or higher confidence, AH or Over/Under; LOW, rules picks and excluded leagues stay out', () => {
    expect(isFeaturedEligible(ai(1, 39), FEATURED_AI_V1)).toBe(true);
    expect(isFeaturedEligible(ai(1, 39, { market: 'OVER_UNDER' }), FEATURED_AI_V1)).toBe(true);
    expect(isFeaturedEligible(ai(1, 39, { aiConfidence: 'HIGH' }), FEATURED_AI_V1)).toBe(true);
    expect(isFeaturedEligible(ai(1, 39, { aiConfidence: 'LOW' }), FEATURED_AI_V1)).toBe(false);
    expect(isFeaturedEligible(ai(1, 39, { engine: 'rules-v0.6' }), FEATURED_AI_V1)).toBe(false);
    expect(isFeaturedEligible(ai(1, 296), FEATURED_AI_V1)).toBe(false);
    // an AI pick has no distribution, so the rules' lists never take it
    expect(isFeaturedEligible(ai(1, 39), FEATURED_V2)).toBe(false);
  });

  it('orders: big five first, then fewer data gaps, then earlier kick-off', () => {
    const r = reserveFeatured(
      [
        ai(1, 88, { dataGaps: 0 }), // Eredivisie: not a priority league
        ai(2, 39, { dataGaps: 3 }),
        ai(3, 140, { dataGaps: 1, kickoffAt: at(18) }),
        ai(4, 78, { dataGaps: 1, kickoffAt: at(15) }),
        ai(5, 94, { dataGaps: 0, kickoffAt: at(10) }),
      ],
      [],
      FEATURED_AI_V1,
    );
    expect(ids(r)).toEqual([4, 3, 2, 5, 1]);
  });

  it('the AI confidence comes first: a HIGH pick outside the big five goes before a MEDIUM one inside', () => {
    const r = reserveFeatured([ai(1, 39), ai(2, 88, { aiConfidence: 'HIGH' }), ai(3, 140)], [], FEATURED_AI_V1);
    expect(ids(r)).toEqual([2, 1, 3]);
  });

  it('keeps the caps (2 per league, 5 per day) and never fills by relaxing the rules', () => {
    const r = reserveFeatured([ai(1, 39), ai(2, 39), ai(3, 39), ai(4, 140), ai(5, 135), ai(6, 78), ai(7, 61)], [], FEATURED_AI_V1);
    expect(ids(r)).toEqual([1, 2, 4, 5, 6]);
    expect(reserveFeatured([ai(1, 39, { aiConfidence: 'LOW' })], [], FEATURED_AI_V1)).toEqual([]);
  });
});

describe('featured-ai-v3 (ADR 0015)', () => {
  const ai = (fixtureId: number, leagueId: number, over: Partial<FeaturedCandidate> = {}): FeaturedCandidate =>
    pick(fixtureId, leagueId, 0, { supportScore: null, distribution: null, engine: 'hybrid-ai-v1', aiConfidence: 'MEDIUM', dataGaps: 2, market: 'ASIAN_HANDICAP', ...over });

  it('takes the Nations League; the other national-team competitions, Thai League 1 and the ASEAN club cup stay out', () => {
    expect(isFeaturedEligible(ai(1, 5), FEATURED_AI_V3)).toBe(true);
    expect(isFeaturedEligible(ai(1, 5), FEATURED_AI_V2)).toBe(false);
    for (const league of [536, 36, 7, 296, 1129]) expect(isFeaturedEligible(ai(1, league), FEATURED_AI_V3)).toBe(false);
    expect(isFeaturedEligible(ai(1, 5, { aiConfidence: 'LOW' }), FEATURED_AI_V3)).toBe(false);
  });

  it('up to 5 Nations League matches a day; every other league keeps the cap of 2', () => {
    const unl = [1, 2, 3, 4, 5, 6].map((i) => ai(i, 5));
    expect(ids(reserveFeatured(unl, [], FEATURED_AI_V3))).toEqual([1, 2, 3, 4, 5]);
    expect(ids(reserveFeatured([ai(1, 39), ai(2, 39), ai(3, 39), ai(4, 5), ai(5, 5)], [], FEATURED_AI_V3))).toEqual([1, 2, 4, 5]);
  });

  it('keeps the ai-v1 order: the big five before the Nations League on equal confidence', () => {
    expect(ids(reserveFeatured([ai(1, 5, { dataGaps: 0 }), ai(2, 39, { dataGaps: 3 })], [], FEATURED_AI_V3))).toEqual([2, 1]);
  });
});

describe('featured-ai-v4 (ADR 0018)', () => {
  const ai = (fixtureId: number, leagueId: number, over: Partial<FeaturedCandidate> = {}): FeaturedCandidate =>
    pick(fixtureId, leagueId, 0, { supportScore: null, distribution: null, engine: 'hybrid-ai-v1', aiConfidence: 'MEDIUM', dataGaps: 2, market: 'ASIAN_HANDICAP', voteAgree: 2, ...over });

  it('3 of 3 answers before 2 of 3, ahead of the big five, fewer gaps and kick-off; unknown agreement last', () => {
    // 1: big five, no gaps, 2 of 3. 2: Nations League, more gaps, 3 of 3. 3: before v1.6 (one answer)
    const list = reserveFeatured([ai(1, 39, { dataGaps: 0 }), ai(2, 5, { dataGaps: 4, voteAgree: 3 }), ai(3, 39, { voteAgree: null })], [], FEATURED_AI_V4);
    expect(ids(list)).toEqual([2, 1, 3]);
    // ai-v3 ignores the agreement
    expect(ids(reserveFeatured([ai(1, 39, { dataGaps: 0 }), ai(2, 5, { dataGaps: 4, voteAgree: 3 })], [], FEATURED_AI_V3))).toEqual([1, 2]);
  });

  it('no cap per league: one league may fill the day, still at most 5', () => {
    const pl = [1, 2, 3, 4, 5, 6].map((i) => ai(i, 39, { voteAgree: 3 }));
    expect(ids(reserveFeatured(pl, [], FEATURED_AI_V4))).toEqual([1, 2, 3, 4, 5]);
    expect(ids(reserveFeatured(pl, [], FEATURED_AI_V3))).toEqual([1, 2]);
  });

  it('keeps the ai-v3 scope: LOW confidence, Thai League 1 and the other national-team competitions stay out', () => {
    expect(isFeaturedEligible(ai(1, 5, { voteAgree: 3 }), FEATURED_AI_V4)).toBe(true);
    expect(isFeaturedEligible(ai(1, 39, { aiConfidence: 'LOW', voteAgree: 3 }), FEATURED_AI_V4)).toBe(false);
    for (const league of [536, 36, 7, 296, 1129, 143]) expect(isFeaturedEligible(ai(1, league, { voteAgree: 3 }), FEATURED_AI_V4)).toBe(false);
  });
});

describe('featured-v2 (ADR 0006)', () => {
  const p = (fixtureId: number, leagueId: number, model: number, market: number | null, over: Partial<FeaturedCandidate> = {}) =>
    pick(fixtureId, leagueId, 0, { modelProbability: model, marketProbability: market, market: 'ASIAN_HANDICAP', ...over });

  it('blends the model with the market; without a market quote it falls back to the model', () => {
    expect(blendedProbability({ modelProbability: 0.6, marketProbability: 0.5 }, 0.5)).toBeCloseTo(0.55);
    expect(blendedProbability({ modelProbability: 0.6, marketProbability: null }, 0.5)).toBe(0.6);
    expect(blendedProbability({ modelProbability: null, marketProbability: 0.5 }, 0.5)).toBeNull();
  });

  it('ranks by the blended probability, not by the edge over the market', () => {
    // the high-edge pick (model 0.62 vs market 0.50) sits below the one the market also backs
    const r = reserveFeatured([p(1, 39, 0.62, 0.5), p(2, 140, 0.6, 0.58)], [], FEATURED_V2);
    expect(ids(r)).toEqual([2, 1]);
  });

  it('keeps Over/Under out until it has a second signal, but not in v1', () => {
    const ou = p(1, 39, 0.6, 0.55, { market: 'OVER_UNDER' });
    expect(isFeaturedEligible(ou, FEATURED_V2)).toBe(false);
    expect(isFeaturedEligible(ou, FEATURED_V1)).toBe(true);
  });
});
