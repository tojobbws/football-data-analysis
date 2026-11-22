import { describe, expect, it } from 'vitest';
import { isThinMatchPage } from '../src/lib/indexing';

describe('isThinMatchPage', () => {
  const now = Date.parse('2026-11-22T12:00:00Z');
  it('marks a match over for more than a day without a write-up', () => {
    expect(isThinMatchPage('2026-11-20T12:00:00Z', false, now)).toBe(true);
  });
  it('keeps a match with a write-up, an upcoming one, and one that kicked off within the day', () => {
    expect(isThinMatchPage('2026-11-20T12:00:00Z', true, now)).toBe(false);
    expect(isThinMatchPage('2026-11-25T12:00:00Z', false, now)).toBe(false);
    expect(isThinMatchPage('2026-11-21T20:00:00Z', false, now)).toBe(false);
  });
});
