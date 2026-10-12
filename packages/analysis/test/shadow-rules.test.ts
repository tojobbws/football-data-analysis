import { describe, expect, it } from 'vitest';
import { SHADOW_TRIAL, trialSide, trialVerdict, type TrialPick } from '../src/index.js';

const picks = (n: number, status: TrialPick['status'], clv: number | null): TrialPick[] => Array.from({ length: n }, () => ({ status, clv }));

describe('shadow trial', () => {
  it('fair hit rate leaves pushes and voids out and counts half outcomes as half', () => {
    const s = trialSide([...picks(2, 'WIN', null), ...picks(1, 'HALF_WIN', null), ...picks(1, 'LOSS', null), ...picks(1, 'HALF_LOSS', null), ...picks(3, 'PUSH', null), ...picks(1, 'VOID', null), ...picks(2, null, null)]);
    expect(s.picks).toBe(11);
    expect(s.settled).toBe(8);
    expect(s.fairHitRate).toBeCloseTo(2.5 / 4, 10);
    expect(s.clvMean).toBeNull();
  });

  it('collects below the minimum, passes only with clearly better CLV and no clear drop in hits', () => {
    const real = trialSide([...picks(150, 'WIN', -0.01), ...picks(150, 'LOSS', 0.01)]);
    const clv = (better: number) => [...picks(150, 'WIN', better - 0.02), ...picks(150, 'LOSS', better + 0.02)];
    expect(trialVerdict(trialSide(clv(0.05).slice(0, 299)), real).verdict).toBe('COLLECTING');
    expect(trialVerdict(trialSide(clv(0.05)), real).verdict).toBe('PASS');
    expect(trialVerdict(trialSide(clv(0.001)), real).verdict).toBe('EXTEND'); // CLV not clearly better
    const worseHits = trialSide([...picks(130, 'WIN', 0.03), ...picks(170, 'LOSS', 0.07)]);
    expect(trialVerdict(worseHits, real).criteria.fairNotWorse).toBe(false);
    expect(trialVerdict(trialSide([...clv(0.001), ...clv(0.001)]), real).verdict).toBe('FAIL'); // 600 and still unclear
    expect(SHADOW_TRIAL.round).toBe('LINEUP');
  });
});
