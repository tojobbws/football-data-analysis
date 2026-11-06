import { describe, expect, it } from 'vitest';
import { pickDay, pickRunAt } from '../src/time.js';

const thai = (s: string) => new Date(`${s}:00+07:00`);

describe('pickDay', () => {
  it('14:00 Thai on D to 14:00 on D+1 is named D', () => {
    expect(pickDay(thai('2026-11-06T14:00')).date).toBe('2026-11-06');
    expect(pickDay(thai('2026-11-06T23:59')).date).toBe('2026-11-06');
    expect(pickDay(thai('2026-11-07T05:30')).date).toBe('2026-11-06');
    expect(pickDay(thai('2026-11-07T13:59')).date).toBe('2026-11-06');
    expect(pickDay(thai('2026-11-07T14:00')).date).toBe('2026-11-07');
  });

  it('spans exactly 24 hours from 14:00 Thai', () => {
    const d = pickDay(thai('2026-11-07T03:00'));
    expect(d.from.getTime()).toBe(thai('2026-11-06T14:00').getTime());
    expect(d.to.getTime()).toBe(thai('2026-11-07T14:00').getTime());
  });
});

describe('pickRunAt', () => {
  it('open from 14:00 to 16:00 Thai, for the pick day starting that afternoon', () => {
    expect(pickRunAt(thai('2026-11-06T13:59'))).toBeNull();
    const run = pickRunAt(thai('2026-11-06T14:05'))!;
    expect(run.day.date).toBe('2026-11-06');
    expect(run.startedAt.getTime()).toBe(thai('2026-11-06T14:00').getTime());
    expect(run.cutoff.getTime()).toBe(thai('2026-11-06T16:00').getTime());
    expect(pickRunAt(thai('2026-11-06T15:59'))?.day.date).toBe('2026-11-06');
    expect(pickRunAt(thai('2026-11-06T16:00'))).toBeNull();
    expect(pickRunAt(thai('2026-11-07T02:00'))).toBeNull();
  });
});
