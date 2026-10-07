import { describe, expect, it, vi } from 'vitest';
import { ApiFootball, ApiFootballClient, ApiFootballError, type RawResponseRecord } from '../src/index.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const ok = (response: unknown, paging = { current: 1, total: 1 }) => ({
  get: 'x',
  parameters: {},
  errors: [],
  results: Array.isArray(response) ? response.length : 1,
  paging,
  response,
});

describe('ApiFootballClient', () => {
  it('sends the API key header, builds the URL and records the raw response', async () => {
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) =>
      jsonResponse(ok([{ a: 1 }]), 200, { 'x-ratelimit-requests-remaining': '95', 'x-ratelimit-remaining': '9' }),
    );
    const raws: RawResponseRecord[] = [];
    const client = new ApiFootballClient({
      apiKey: 'KEY',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onRawResponse: (r) => {
        raws.push(r);
        return 42;
      },
    });

    const res = await client.get<unknown[]>('/fixtures', { league: 39, season: 2026, skip: undefined });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://v3.football.api-sports.io/fixtures?league=39&season=2026');
    expect((init?.headers as Record<string, string>)['x-apisports-key']).toBe('KEY');
    expect(res.data).toEqual([{ a: 1 }]);
    expect(res.meta.rawResponseId).toBe(42);
    expect(res.meta.rateLimit).toEqual({ dailyRemaining: 95, minuteRemaining: 9 });
    expect(raws[0]).toMatchObject({ endpoint: '/fixtures', params: { league: '39', season: '2026' }, httpStatus: 200 });
  });

  it('turns HTTP-200 `errors` objects into typed errors (not retried)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ...ok([]), errors: { requests: 'You have reached the request limit for the day' } }));
    const client = new ApiFootballClient({ apiKey: 'K', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} });
    await expect(client.get('/status')).rejects.toMatchObject({ kind: 'QUOTA' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 / 5xx then succeeds', async () => {
    const responses = [jsonResponse({}, 429), jsonResponse({}, 503), jsonResponse(ok(['done']))];
    const fetchImpl = vi.fn(async () => responses.shift()!);
    const sleeps: number[] = [];
    const client = new ApiFootballClient({
      apiKey: 'K',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const res = await client.get<string[]>('/status');
    expect(res.data).toEqual(['done']);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps.length).toBe(2);
    expect(client.requestCount).toBe(3);
  });

  it('does not retry auth errors', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 403));
    const client = new ApiFootballClient({ apiKey: 'K', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} });
    const err = await client.get('/status').catch((e) => e);
    expect(err).toBeInstanceOf(ApiFootballError);
    expect(err.kind).toBe('AUTH');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throttles to requestsPerMinute', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const fetchImpl = vi.fn(async () => jsonResponse(ok([])));
    const client = new ApiFootballClient({
      apiKey: 'K',
      requestsPerMinute: 2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    await client.get('/a');
    await client.get('/b');
    await client.get('/c'); // must wait ~60s
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(60_000);
  });

  it('follows pagination', async () => {
    const pages = [jsonResponse(ok([1, 2], { current: 1, total: 2 })), jsonResponse(ok([3], { current: 2, total: 2 }))];
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo) => pages.shift()!);
    const api = new ApiFootball(new ApiFootballClient({ apiKey: 'K', fetchImpl: fetchImpl as unknown as typeof fetch }));
    const res = await api.odds({ league: 39, season: 2026 });
    expect(res.data).toEqual([1, 2, 3]);
    expect(String(fetchImpl.mock.calls[1]![0])).toContain('page=2');
  });

  it('fixturesByIds joins ids with "-" and enforces the 20-id limit', async () => {
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo) => jsonResponse(ok([])));
    const api = new ApiFootball(new ApiFootballClient({ apiKey: 'K', fetchImpl: fetchImpl as unknown as typeof fetch }));
    await api.fixturesByIds([1, 2, 3]);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('ids=1-2-3');
    expect(() => api.fixturesByIds(Array.from({ length: 21 }, (_, i) => i))).toThrow();
  });
});
