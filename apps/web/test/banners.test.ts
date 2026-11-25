import { describe, expect, it } from 'vitest';
import { chooseBanners, checkImageSize, httpsUrl, isBot, isoToThaiLocal, slotAfterLeague, thaiLocalToIso, type Banner } from '../src/lib/banners';

const b = (id: number, priority: number, slots: Banner['slots']): Banner => ({ id, name: `b${id}`, imageWide: '', imagePhone: '', alt: '', target: '', slots, priority });

describe('chooseBanners', () => {
  it('takes the highest priority per slot and never shows one banner twice', () => {
    const out = chooseBanners([b(1, 5, ['home_top', 'home_league_1']), b(2, 1, ['home_league_1']), b(3, 9, ['home_league_2'])]);
    expect(out.home_top?.id).toBe(1);
    expect(out.home_league_1?.id).toBe(2); // banner 1 is already on top
    expect(out.home_league_2?.id).toBe(3);
  });
  it('leaves a slot empty when nothing is left for it', () => {
    const out = chooseBanners([b(1, 5, ['home_top', 'home_league_1'])]);
    expect(out.home_league_1).toBeUndefined();
  });
  it('breaks a priority tie by the newest banner', () => {
    expect(chooseBanners([b(1, 0, ['home_top']), b(4, 0, ['home_top'])]).home_top?.id).toBe(4);
  });
});

describe('slotAfterLeague', () => {
  it('follows the 2nd and 5th league groups only when a league follows', () => {
    expect(slotAfterLeague(1, 6)).toBe('home_league_1');
    expect(slotAfterLeague(4, 6)).toBe('home_league_2');
    expect(slotAfterLeague(4, 5)).toBeNull();
    expect(slotAfterLeague(1, 2)).toBeNull();
    expect(slotAfterLeague(0, 6)).toBeNull();
  });
});

describe('checks', () => {
  it('isBot', () => {
    expect(isBot('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile Safari')).toBe(false);
    expect(isBot('Googlebot/2.1')).toBe(true);
    expect(isBot('facebookexternalhit/1.1')).toBe(true);
    expect(isBot('')).toBe(true);
  });
  it('httpsUrl', () => {
    expect(httpsUrl(' https://example.com/x?a=1 ')).toBe('https://example.com/x?a=1');
    expect(httpsUrl('http://example.com')).toBeNull();
    expect(httpsUrl('javascript:alert(1)')).toBeNull();
    expect(httpsUrl('https://localhost')).toBeNull();
  });
  it('checkImageSize accepts the size or a larger one of the same ratio', () => {
    expect(checkImageSize('wide', 1340, 200)).toBeNull();
    expect(checkImageSize('wide', 2680, 400)).toBeNull();
    expect(checkImageSize('phone', 1080, 360)).toBeNull();
    expect(checkImageSize('phone', 1080, 1080)).toMatch(/สัดส่วน/);
    expect(checkImageSize('wide', 670, 100)).toMatch(/เล็กเกินไป/);
  });
  it('Thai wall clock round trip', () => {
    expect(thaiLocalToIso('2026-11-25T10:00')).toBe('2026-11-25T03:00:00.000Z');
    expect(isoToThaiLocal('2026-11-25T03:00:00.000Z')).toBe('2026-11-25T10:00');
    expect(thaiLocalToIso('bad')).toBeNull();
  });
});
