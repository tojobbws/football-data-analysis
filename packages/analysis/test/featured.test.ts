import { describe, expect, it } from 'vitest';
import { FEATURED_V1, isFeaturedEligible, lockFeatured, reserveFeatured, type FeaturedCandidate } from '../src/index.js';

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
});
