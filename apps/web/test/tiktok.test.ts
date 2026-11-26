/**
 * TikTok inbox upload (src/lib/tiktok.ts, ADR 0026): the chunk plan TikTok's upload accepts, and the rotating
 * refresh token kept in oauth_tokens.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const { CHUNK_MAX, accessToken, chunkPlan } = await import('../src/lib/tiktok');
const { checkVideo } = await import('../src/lib/social');

describe('chunkPlan', () => {
  it('sends a film up to 64 MB as one chunk', () => {
    expect(chunkPlan(3_000_000)).toEqual({ chunkSize: 3_000_000, count: 1, ranges: [[0, 2_999_999]] });
    expect(chunkPlan(CHUNK_MAX).count).toBe(1);
  });
  it('splits a bigger film into 64 MB chunks, the remainder joining the last (<= 128 MB)', () => {
    const bytes = 2 * CHUNK_MAX + 5_000_123;
    const p = chunkPlan(bytes);
    expect(p).toMatchObject({ chunkSize: CHUNK_MAX, count: 2 });
    expect(p.ranges).toEqual([[0, CHUNK_MAX - 1], [CHUNK_MAX, bytes - 1]]);
    const last = p.ranges.at(-1)!;
    expect(last[1] - last[0] + 1).toBeLessThanOrEqual(128_000_000);
    expect(chunkPlan(CHUNK_MAX + 1)).toMatchObject({ count: 1, ranges: [[0, CHUNK_MAX]] });
  });
});

describe('checkVideo TIKTOK', () => {
  const film = { name: 'recap.mp4', bytes: 40 * 1048576, seconds: 45, width: 1080, height: 1920 };
  it('takes a vertical film up to 10 minutes', () => {
    expect(checkVideo({ ...film, seconds: 134 }, 'TIKTOK')).toEqual({ errors: [], warnings: [] });
    expect(checkVideo({ ...film, seconds: 601 }, 'TIKTOK').errors.join()).toContain('600');
    expect(checkVideo({ ...film, seconds: 2 }, 'TIKTOK').errors.length).toBe(1);
  });
  it('refuses a side under 360 px', () => {
    expect(checkVideo({ ...film, width: 320, height: 568 }, 'TIKTOK').errors.join()).toContain('360');
  });
});

describe('accessToken', () => {
  const env = { clientKey: 'ck', clientSecret: 'cs' };
  const now = Date.parse('2026-11-26T12:00:00Z');
  const row = (over = {}) => ({
    refresh_token: 'r1', refresh_expires_at: '2027-05-01T00:00:00Z', access_token: 'a1', access_expires_at: '2026-11-26T13:00:00Z', ...over,
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reuses a stored access token that still has time left', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const save = vi.fn();
    expect(await accessToken(env, { read: async () => row(), save }, now)).toBe('a1');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refreshes near expiry and stores the new (rotated) refresh token against the old one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'a2', expires_in: 7200, refresh_token: 'r2', refresh_expires_in: 15552000 }))));
    const save = vi.fn(async () => true);
    const t = await accessToken(env, { read: async () => row({ access_expires_at: '2026-11-26T12:03:00Z' }), save }, now);
    expect(t).toBe('a2');
    expect(save).toHaveBeenCalledWith('r1', expect.objectContaining({ access_token: 'a2', refresh_token: 'r2' }));
  });

  it('uses what a parallel request stored when its own refresh is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })));
    const reads = [row({ access_token: null }), row({ refresh_token: 'r2', access_token: 'a2', access_expires_at: new Date(Date.now() + 3600_000).toISOString() })];
    const t = await accessToken(env, { read: async () => reads.shift() ?? null, save: vi.fn() }, now);
    expect(t).toBe('a2');
  });

  it('asks for the setup script when nobody signed in, or the refresh token ran out', async () => {
    await expect(accessToken(env, { read: async () => null, save: vi.fn() }, now)).rejects.toThrow('tiktok-setup');
    await expect(accessToken(env, { read: async () => row({ access_token: null, refresh_expires_at: '2026-11-01T00:00:00Z' }), save: vi.fn() }, now)).rejects.toThrow('tiktok-setup');
  });
});
