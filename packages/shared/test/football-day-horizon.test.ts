import { describe, expect, it } from 'vitest';
import { footballDayHorizon } from '../src/time.js';

const thai = (s: string) => new Date(`${s}:00+07:00`);
const at = (now: string) => new Date(footballDayHorizon(thai(now), 48).getTime() + 7 * 3_600_000).toISOString().slice(0, 16);

describe('footballDayHorizon', () => {
  it('before 12:00 of the football day: until 16:00 the same day', () => {
    expect(at('2026-10-31T06:00')).toBe('2026-10-31T16:00');
    expect(at('2026-10-31T11:59')).toBe('2026-10-31T16:00');
  });

  it('from 12:00: until 10:00 next morning (evening, late and Brazil morning kick-offs)', () => {
    expect(at('2026-10-30T12:00')).toBe('2026-10-31T10:00');
    expect(at('2026-10-30T23:00')).toBe('2026-10-31T10:00');
  });

  it('after midnight it is still the previous football day', () => {
    expect(at('2026-10-31T02:00')).toBe('2026-10-31T10:00');
    expect(at('2026-10-31T05:59')).toBe('2026-10-31T10:00');
  });

  it('never looks past `hours`', () => {
    expect(footballDayHorizon(thai('2026-10-30T12:00'), 3).getTime()).toBe(thai('2026-10-30T15:00').getTime());
  });
});
