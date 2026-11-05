/**
 * The public-page edge cache (src/lib/edge-cache.ts): what is cached, for how long, and that it never breaks a page.
 */
import { describe, expect, it } from 'vitest';
import { cacheKey, isCacheableRequest, isStorableResponse, PAGE_STALE_SECONDS, PAGE_TTL_SECONDS, withEdgeCache, type EdgeCache } from '../src/lib/edge-cache';

const page = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
  new Request(`https://khemthitfootball.com${path}`, { method, headers: { accept: 'text/html,application/xhtml+xml', ...headers } });
const html = (body = '<html>page</html>', headers: Record<string, string> = {}, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-cache, no-store, max-age=0, must-revalidate', ...headers } });

/** an in-memory Cache API keyed by URL */
function memoryCache(): EdgeCache & { store: Map<string, Response>; puts: number } {
  const c = {
    store: new Map<string, Response>(),
    puts: 0,
    async match(key: Request) {
      const r = c.store.get(key.url);
      return r ? r.clone() : undefined;
    },
    async put(key: Request, res: Response) {
      c.puts++;
      c.store.set(key.url, new Response(await res.text(), { status: res.status, headers: res.headers }));
    },
  };
  return c;
}
function waits() {
  const pending: Promise<unknown>[] = [];
  return { waitUntil: (p: Promise<unknown>) => void pending.push(p), settle: () => Promise.all(pending.splice(0)) };
}

describe('which requests the page cache answers', () => {
  it('plain GETs of public HTML pages', () => {
    for (const p of ['/', '/?date=2026-11-05', '/today', '/performance', '/matches/arsenal-vs-everton-2026-11-05']) expect(isCacheableRequest(page(p))).toBe(true);
  });

  it('never admin, the API, Next internals, a non-GET, or a request that is not for a document', () => {
    for (const p of ['/admin', '/admin/picks', '/api/live', '/_next/static/x.js', '/cdn-cgi/image/x']) expect(isCacheableRequest(page(p))).toBe(false);
    expect(isCacheableRequest(page('/', {}, 'POST'))).toBe(false);
    expect(isCacheableRequest(page('/', { accept: 'application/json' }))).toBe(false);
    expect(isCacheableRequest(page('/', { authorization: 'Bearer x' }))).toBe(false);
  });

  it('never client-side navigation: RSC requests, prefetches and server actions get another body than the document', () => {
    expect(isCacheableRequest(page('/?_rsc=abc'))).toBe(false);
    for (const h of ['rsc', 'next-router-prefetch', 'next-router-state-tree', 'next-action']) expect(isCacheableRequest(page('/', { [h]: '1' }))).toBe(false);
  });

  it('keys a page by its URL, without tracking parameters, in a fixed order', () => {
    expect(cacheKey(page('/?utm_source=fb&date=2026-11-05&fbclid=x')).url).toBe('https://khemthitfootball.com/?date=2026-11-05');
    expect(cacheKey(page('/?live=1&date=2026-11-05')).url).toBe(cacheKey(page('/?date=2026-11-05&live=1')).url);
    expect(cacheKey(page('/?date=2026-11-05')).url).not.toBe(cacheKey(page('/?date=2026-11-06')).url);
  });

  it('stores only a 200 HTML page that sets no cookie', () => {
    expect(isStorableResponse(html())).toBe(true);
    expect(isStorableResponse(html('x', {}, 404))).toBe(false);
    expect(isStorableResponse(html('x', {}, 500))).toBe(false);
    expect(isStorableResponse(html('x', { 'set-cookie': 'a=b' }))).toBe(false);
    expect(isStorableResponse(new Response('{}', { headers: { 'content-type': 'application/json' } }))).toBe(false);
  });
});

describe('withEdgeCache', () => {
  it('renders once, then serves the stored copy until the TTL, with no browser cache', async () => {
    const cache = memoryCache();
    const ctx = waits();
    let t = 1_000_000;
    let renders = 0;
    const render = async () => html(`<html>render ${++renders}</html>`);

    const first = await withEdgeCache(page('/'), ctx, render, cache, () => t);
    await ctx.settle();
    expect(first.headers.get('x-edge-cache')).toBe('MISS');
    expect(await first.text()).toBe('<html>render 1</html>');
    expect(first.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');

    t += PAGE_TTL_SECONDS * 1000;
    const second = await withEdgeCache(page('/?utm_source=line'), ctx, render, cache, () => t);
    expect(second.headers.get('x-edge-cache')).toBe('HIT');
    expect(await second.text()).toBe('<html>render 1</html>');
    expect(second.headers.has('x-edge-cached-at')).toBe(false);
    expect(renders).toBe(1);
  });

  it('after the TTL serves the old copy at once and renders a fresh one in the background, once', async () => {
    const cache = memoryCache();
    const ctx = waits();
    let t = 1_000_000;
    let renders = 0;
    const render = async () => html(`<html>render ${++renders}</html>`);
    await withEdgeCache(page('/today'), ctx, render, cache, () => t);
    await ctx.settle();

    t += (PAGE_TTL_SECONDS + 1) * 1000;
    const [a, b] = await Promise.all([withEdgeCache(page('/today'), ctx, render, cache, () => t), withEdgeCache(page('/today'), ctx, render, cache, () => t)]);
    expect([a.headers.get('x-edge-cache'), b.headers.get('x-edge-cache')]).toEqual(['STALE', 'STALE']);
    expect(await a.text()).toBe('<html>render 1</html>');
    await ctx.settle();
    expect(renders).toBe(2); // one background render for both visitors

    const after = await withEdgeCache(page('/today'), ctx, render, cache, () => t);
    expect(after.headers.get('x-edge-cache')).toBe('HIT');
    expect(await after.text()).toBe('<html>render 2</html>');
  });

  it('a copy older than TTL + stale is not served: the visitor gets a fresh render', async () => {
    const cache = memoryCache();
    const ctx = waits();
    let t = 1_000_000;
    let renders = 0;
    const render = async () => html(`<html>render ${++renders}</html>`);
    await withEdgeCache(page('/'), ctx, render, cache, () => t);
    await ctx.settle();
    t += (PAGE_TTL_SECONDS + PAGE_STALE_SECONDS + 1) * 1000;
    const res = await withEdgeCache(page('/'), ctx, render, cache, () => t);
    expect(res.headers.get('x-edge-cache')).toBe('MISS');
    expect(await res.text()).toBe('<html>render 2</html>');
  });

  it('never stores an error page or a page that sets a cookie, and passes them through unchanged', async () => {
    const cache = memoryCache();
    const ctx = waits();
    const res = await withEdgeCache(page('/'), ctx, async () => html('down', {}, 500), cache);
    await ctx.settle();
    expect(res.status).toBe(500);
    expect(res.headers.get('x-edge-cache')).toBe('BYPASS');
    expect(res.headers.get('cache-control')).toContain('no-store');
    await withEdgeCache(page('/'), ctx, async () => html('x', { 'set-cookie': 'a=b' }), cache);
    await ctx.settle();
    expect(cache.puts).toBe(0);
  });

  it('leaves uncacheable requests and a missing or failing cache to the handler', async () => {
    const ctx = waits();
    const render = async () => html('<html>fresh</html>');
    const admin = await withEdgeCache(page('/admin'), ctx, render, memoryCache());
    expect(admin.headers.has('x-edge-cache')).toBe(false);
    expect(await (await withEdgeCache(page('/'), ctx, render, undefined)).text()).toBe('<html>fresh</html>');
    const broken: EdgeCache = { match: async () => Promise.reject(new Error('cache down')), put: async () => Promise.reject(new Error('cache down')) };
    const res = await withEdgeCache(page('/'), ctx, render, broken);
    await ctx.settle();
    expect(await res.text()).toBe('<html>fresh</html>');
  });
});
