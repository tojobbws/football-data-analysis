import { describe, expect, it } from 'vitest';
import { dispatchWorkflow, NEWS_DRYRUN_WORKFLOW, newsDryRunDue } from '../src/dispatch.js';

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

describe('grounded-news dry run dispatch', () => {
  it('starts the dry-run workflow with its own job input', async () => {
    const f = fakeFetch(204);
    await dispatchWorkflow({ token: 't0k', repo: 'owner/repo', workflow: NEWS_DRYRUN_WORKFLOW, job: 'dry-run', fetchImpl: f.impl });
    expect(f.calls[0]!.url).toBe('https://api.github.com/repos/owner/repo/actions/workflows/grounded-news-dryrun.yml/dispatches');
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ ref: 'main', inputs: { job: 'dry-run' } });
  });

  it('is due up to and including the last Thai date, then stops', () => {
    // 06:15 UTC = 13:15 Thai
    expect(newsDryRunDue(new Date('2026-11-25T06:15:00Z'), '2026-11-27')).toBe(true);
    expect(newsDryRunDue(new Date('2026-11-27T06:15:00Z'), '2026-11-27')).toBe(true);
    expect(newsDryRunDue(new Date('2026-11-28T06:15:00Z'), '2026-11-27')).toBe(false);
    // 18:00 UTC on the 27th is already the 28th in Thailand
    expect(newsDryRunDue(new Date('2026-11-27T18:00:00Z'), '2026-11-27')).toBe(false);
  });

  it('is off when the var is unset, empty or malformed', () => {
    const now = new Date('2026-11-25T06:15:00Z');
    expect(newsDryRunDue(now, undefined)).toBe(false);
    expect(newsDryRunDue(now, '')).toBe(false);
    expect(newsDryRunDue(now, '27/11/2026')).toBe(false);
  });
});
