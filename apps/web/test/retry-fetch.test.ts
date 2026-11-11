/**
 * Database reads retry once on a failure in transit (src/lib/retry-fetch.ts), never on a query error or a write.
 */
import { describe, expect, it } from 'vitest';
import { retryOnce } from '../src/lib/retry-fetch';

const REST = 'https://x.supabase.co/rest/v1';

function stub(...answers: (number | Error)[]) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a instanceof Error) throw a;
    return new Response('{}', { status: a });
  }) as typeof fetch;
  return { f, calls };
}

describe('retryOnce', () => {
  it('answers a good read at once', async () => {
    const s = stub(200);
    expect((await retryOnce(s.f, 0)(`${REST}/fixtures`)).status).toBe(200);
    expect(s.calls).toHaveLength(1);
  });

  it('retries a read once after a network error or a gateway 5xx', async () => {
    const net = stub(new TypeError('fetch failed'), 200);
    expect((await retryOnce(net.f, 0)(`${REST}/fixtures`)).status).toBe(200);
    expect(net.calls).toHaveLength(2);
    const gw = stub(503, 200);
    expect((await retryOnce(gw.f, 0)(`${REST}/fixtures`)).status).toBe(200);
    expect(gw.calls).toHaveLength(2);
  });

  it('gives up after the second try', async () => {
    const s = stub(504, 504, 200);
    expect((await retryOnce(s.f, 0)(`${REST}/fixtures`)).status).toBe(504);
    expect(s.calls).toHaveLength(2);
  });

  it('does not retry a query error such as a statement timeout (500)', async () => {
    const s = stub(500, 200);
    expect((await retryOnce(s.f, 0)(`${REST}/fixtures`)).status).toBe(500);
    expect(s.calls).toHaveLength(1);
  });

  it('retries a POST to an rpc function but never another POST', async () => {
    const rpc = stub(502, 200);
    expect((await retryOnce(rpc.f, 0)(`${REST}/rpc/web_top_scorers`, { method: 'POST', body: '{}' })).status).toBe(200);
    expect(rpc.calls).toHaveLength(2);
    const write = stub(502, 200);
    expect((await retryOnce(write.f, 0)(`${REST}/articles`, { method: 'POST', body: '{}' })).status).toBe(502);
    expect(write.calls).toHaveLength(1);
  });
});
