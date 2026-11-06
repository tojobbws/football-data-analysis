import { describe, expect, it } from 'vitest';
import { buildHybridReason, dailyRoundFor } from '../src/index.js';

const thai = (s: string) => new Date(`${s}:00+07:00`);
// the run of 2026-11-06: pick day 14:00 on the 6th to 14:00 on the 7th
const run = { day: { from: thai('2026-11-06T14:00'), to: thai('2026-11-07T14:00') } };
const now = thai('2026-11-06T14:20');

describe('dailyRoundFor (ADR 0014)', () => {
  it('every match of the pick day, tonight and tomorrow morning', () => {
    expect(dailyRoundFor(thai('2026-11-06T19:00'), now, run, false)).toBe('DAILY');
    expect(dailyRoundFor(thai('2026-11-07T03:00'), now, run, false)).toBe('DAILY');
    expect(dailyRoundFor(thai('2026-11-07T07:30'), now, run, false)).toBe('DAILY');
    expect(dailyRoundFor(thai('2026-11-07T13:59'), now, run, false)).toBe('DAILY');
  });

  it('not outside the pick day', () => {
    expect(dailyRoundFor(thai('2026-11-07T14:00'), now, run, false)).toBeNull();
    expect(dailyRoundFor(thai('2026-11-06T13:00'), now, run, false)).toBeNull();
  });

  it('not when the run is closed', () => {
    expect(dailyRoundFor(thai('2026-11-06T19:00'), thai('2026-11-06T16:05'), null, false)).toBeNull();
  });

  it('a pick is final: a match with any published round is not picked again', () => {
    expect(dailyRoundFor(thai('2026-11-06T19:00'), now, run, true)).toBeNull();
  });

  it('at least 15 minutes before kick-off', () => {
    expect(dailyRoundFor(thai('2026-11-06T14:34'), now, run, false)).toBeNull();
    expect(dailyRoundFor(thai('2026-11-06T14:35'), now, run, false)).toBe('DAILY');
  });
});

describe('buildHybridReason: DAILY', () => {
  it('names the round วิเคราะห์ก่อนเกม', () => {
    const r = buildHybridReason({ kind: 'SIGNAL', round: 'DAILY', engineChanged: false, label: 'Arsenal -0.5', summaryTh: 'ฟอร์มดีกว่า', supporting: [], risks: [], missing: [], confidence: 'MEDIUM', odds: 1.9, nBookmakers: 5 });
    expect(r.split('\n')[0]).toBe('🧭 เข็มทิศเกม: Arsenal -0.5 (วิเคราะห์ก่อนเกม)');
  });
});
