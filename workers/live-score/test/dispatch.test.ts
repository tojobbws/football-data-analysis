import { describe, expect, it } from 'vitest';
import { dispatchWorkflow } from '../src/dispatch.js';

function fakeFetch(status: number) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(status === 204 ? null : 'Bad credentials', { status });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe('dispatchWorkflow', () => {
  it('starts the hourly data-sync on main', async () => {
    const f = fakeFetch(204);
    await dispatchWorkflow({ token: 't0k', repo: 'owner/repo', fetchImpl: f.impl });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe('https://api.github.com/repos/owner/repo/actions/workflows/sync.yml/dispatches');
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer t0k');
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ ref: 'main', inputs: { job: 'hourly' } });
  });

  it('throws when GitHub refuses, so the failure shows in the Worker logs', async () => {
    const f = fakeFetch(401);
    await expect(dispatchWorkflow({ token: 'bad', repo: 'owner/repo', fetchImpl: f.impl })).rejects.toThrow(/401 Bad credentials/);
  });
});
