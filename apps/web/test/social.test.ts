/**
 * Posting rules for /admin/social (src/lib/social.ts): what each channel refuses before a film is sent to Meta.
 */
import { describe, expect, it } from 'vitest';
import { checkCaption, checkVideo, checkYtTitle, hashtags, isOpen, ytTitleFrom, type VideoInfo } from '../src/lib/social';

const film = (over: Partial<VideoInfo> = {}): VideoInfo => ({ name: '2026-11-10_recap.mp4', bytes: 40 * 1048576, seconds: 45, width: 1080, height: 1920, ...over });

describe('checkVideo', () => {
  it('passes a 45 s 1080x1920 mp4 on both channels', () => {
    for (const c of ['FACEBOOK', 'INSTAGRAM'] as const) expect(checkVideo(film(), c)).toEqual({ errors: [], warnings: [] });
  });
  it('stops a film over 90 s for Facebook Reels only', () => {
    const long = film({ seconds: 134 });
    expect(checkVideo(long, 'FACEBOOK').errors.join()).toContain('90');
    expect(checkVideo(long, 'INSTAGRAM').errors).toEqual([]);
  });
  it('stops a film under 3 s, a non-video file and a file over 1 GB', () => {
    expect(checkVideo(film({ seconds: 2 }), 'INSTAGRAM').errors.length).toBe(1);
    expect(checkVideo(film({ name: 'cover.png' }), 'INSTAGRAM').errors.length).toBe(1);
    expect(checkVideo(film({ bytes: 2 * 1024 ** 3 }), 'FACEBOOK').errors.length).toBe(1);
  });
  it('warns, without stopping, on a landscape or small film', () => {
    const r = checkVideo(film({ width: 1920, height: 1080 }), 'INSTAGRAM');
    expect(r.errors).toEqual([]);
    expect(r.warnings.length).toBe(2);
  });
});

describe('checkCaption', () => {
  it('needs a caption and keeps the banned words out', () => {
    expect(checkCaption('   ', 'FACEBOOK')).toEqual(['ต้องมีแคปชัน']);
    expect(checkCaption('คู่นี้ทีเด็ด แทงเลย', 'INSTAGRAM').join()).toMatch(/ทีเด็ด.*แทง/);
    expect(checkCaption('คู่น่าจับตาวันนี้ #วิเคราะห์บอล', 'INSTAGRAM')).toEqual([]);
  });
  it('holds Instagram to 2,200 characters and 30 hashtags', () => {
    expect(checkCaption('ก'.repeat(2201), 'INSTAGRAM').length).toBe(1);
    expect(checkCaption('ก'.repeat(2201), 'FACEBOOK')).toEqual([]);
    const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ');
    expect(hashtags(tags).length).toBe(31);
    expect(checkCaption(tags, 'INSTAGRAM').length).toBe(1);
  });
});

describe('isOpen', () => {
  it('keeps polling only while Meta still works on the post', () => {
    expect(['UPLOADING', 'PUBLISHING', 'PROCESSING'].every((s) => isOpen(s as never))).toBe(true);
    expect(['PUBLISHED', 'FAILED', 'DRAFT'].some((s) => isOpen(s as never))).toBe(false);
  });
});

describe('YouTube Shorts', () => {
  it('takes a vertical film up to 3 minutes and refuses a landscape one', () => {
    expect(checkVideo(film({ seconds: 134 }), 'YOUTUBE_SHORTS')).toEqual({ errors: [], warnings: [] });
    expect(checkVideo(film({ seconds: 181 }), 'YOUTUBE_SHORTS').errors.join()).toContain('180');
    expect(checkVideo(film({ width: 1920, height: 1080 }), 'YOUTUBE_SHORTS').errors.join()).toContain('แนวนอน');
    expect(checkVideo(film({ width: 1080, height: 1080 }), 'YOUTUBE_SHORTS').errors).toEqual([]);
  });
  it('counts the description in UTF-8 bytes (Thai = 3 bytes) and refuses < >', () => {
    expect(checkCaption('ก'.repeat(1666), 'YOUTUBE_SHORTS')).toEqual([]);
    expect(checkCaption('ก'.repeat(1667), 'YOUTUBE_SHORTS').join()).toContain('ไบต์');
    expect(checkCaption('สกอร์ 2 > 1', 'YOUTUBE_SHORTS').length).toBe(1);
    expect(checkCaption('สกอร์ 2 > 1', 'INSTAGRAM')).toEqual([]);
  });
  it('holds hashtags to 15 (more and YouTube ignores them all)', () => {
    const tags = Array.from({ length: 16 }, (_, i) => `#t${i}`).join(' ');
    expect(checkCaption(tags, 'YOUTUBE_SHORTS').join()).toContain('15');
  });
  it('needs a title of at most 100 characters without banned words', () => {
    expect(checkYtTitle('')).toEqual(['ต้องมีชื่อคลิป YouTube']);
    expect(checkYtTitle('ก'.repeat(100))).toEqual([]);
    expect(checkYtTitle('ก'.repeat(101)).length).toBe(1);
    expect(checkYtTitle('คู่นี้ฟันธง').join()).toContain('ฟันธง');
    expect(checkYtTitle('<b>').length).toBe(1);
  });
  it('starts the title from the caption first line', () => {
    expect(ytTitleFrom('คู่น่าจับตาวันนี้ <3\nบรรทัดสอง')).toBe('คู่น่าจับตาวันนี้ 3');
    expect([...ytTitleFrom('ก'.repeat(150))].length).toBe(100);
  });
});
