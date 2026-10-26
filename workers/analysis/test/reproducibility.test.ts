/** Audit A-05 / A-13: the tune job's multiple-testing report and the training-set hash stored with each model run. */
import { describe, expect, it } from 'vitest';
import type { FinishedMatchRow } from '@fp/database';
import { multipleTesting, trainingSetHash } from '../src/jobs.js';

const row = (id: number, day: number, gh = 1, xg: number | null = 1.2): FinishedMatchRow => ({
  fixtureId: id,
  kickoffAt: new Date(Date.UTC(2026, 9, day)),
  homeTeamId: 1,
  awayTeamId: 2,
  homeGoals: gh,
  awayGoals: 0,
  homeXg: xg,
  awayXg: 0.4,
  redCardMinute: null,
  eventsKnown: true,
});

describe('trainingSetHash', () => {
  const asOf = new Date(Date.UTC(2026, 9, 10));
  it('same data before asOf, same hash; later matches do not count', () => {
    expect(trainingSetHash([row(1, 1), row(2, 2)], asOf)).toBe(trainingSetHash([row(1, 1), row(2, 2), row(3, 20, 9)], asOf));
  });
  it('a revised xG or score changes it', () => {
    const base = trainingSetHash([row(1, 1), row(2, 2)], asOf);
    expect(trainingSetHash([row(1, 1), row(2, 2, 1, 2.5)], asOf)).not.toBe(base);
    expect(trainingSetHash([row(1, 1), row(2, 2, 3)], asOf)).not.toBe(base);
    expect(base).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('multipleTesting', () => {
  it('Holm over every gate test of the run; enabled itself is left as it was', () => {
    const cfg = (leagueId: number, z: number, enabled: boolean) => ({ leagueId, purpose: 'SIDES', enabled, metrics: { test: { z } } });
    const rows = multipleTesting([cfg(1, 4, true), cfg(2, 1.5, true), cfg(3, 0.2, false), { leagueId: 4, purpose: 'TOTALS', enabled: false, metrics: {} }]);
    expect(rows.map((r) => r.enabled)).toEqual([true, true, false, false]);
    // z 4 survives Holm over 3 tests (p ≈ 3e-5 × 3); z 1.5 does not (p ≈ 0.067 × 2 > 0.10)
    expect(rows.map((r) => r.enabledUnderHolm)).toEqual([true, false, false, false]);
    expect(rows[3]!.pHolm).toBeNull();
  });
});
