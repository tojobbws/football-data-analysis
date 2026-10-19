import { describe, expect, it, vi } from 'vitest';
import { ApiFootballClient } from '../src/index.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ok = (response: unknown) => ({ get: 'x', parameters: {}, errors: [], results: 1, paging: { current: 1, total: 1 }, response });

describe('request accounting', () => {
  it('counts a rate-limited attempt as an attempt but not as a request against the day', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => (++n === 1 ? new Response('', { status: 429 }) : json(ok([{ a: 1 }]))));
    const client = new ApiFootballClient({ apiKey: 'K', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} });
    await client.get('/fixtures', { live: 'all' });
    expect(client.requestCount).toBe(2);
    expect(client.rejectedCount).toBe(1);
    expect(client.billedCount).toBe(1);
  });

  it('also treats a rate-limit error body as rejected', async () => {
    let n = 0;
    const limited = { get: 'x', parameters: {}, errors: { rateLimit: 'Too many requests. You have exceeded the limit of requests per minute.' }, results: 0, paging: { current: 1, total: 1 }, response: [] };
    const fetchImpl = vi.fn(async () => (++n === 1 ? json(limited) : json(ok([]))));
    const client = new ApiFootballClient({ apiKey: 'K', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} });
    await client.get('/fixtures', { live: 'all' });
    expect(client.rejectedCount).toBe(1);
    expect(client.billedCount).toBe(1);
  });

  it('a plain success is one request that counts', async () => {
    const client = new ApiFootballClient({ apiKey: 'K', fetchImpl: (async () => json(ok([]))) as unknown as typeof fetch });
    await client.get('/status');
    expect([client.requestCount, client.rejectedCount, client.billedCount]).toEqual([1, 0, 1]);
  });
});
