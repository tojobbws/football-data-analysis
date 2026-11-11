/**
 * Edge cache for the public HTML pages, in front of the Next handler (apps/web/worker.ts).
 *
 * Every page is `force-dynamic` and reads Supabase on each request: 0.2–2.8 s on 2026-11-05. The pages are the same
 * for every visitor (no cookie or header changes them; SITE_URL is fixed in production), so one rendered copy per URL
 * is kept in the Cloudflare Cache API of each data centre:
 *  - younger than PAGE_TTL_SECONDS: served as is (HIT);
 *  - older, up to PAGE_TTL_SECONDS + PAGE_STALE_SECONDS: served at once, and a fresh copy is rendered in the
 *    background (STALE) — a visitor never waits for the database once a copy exists;
 *  - none: rendered, served, stored (MISS).
 * Live scores do not wait for the page: the client follows /api/live (its own 10 s cache) from the page's seed.
 *
 * Never cached: anything but a plain GET of an HTML document — /admin, /api, Next internals, client-side navigation
 * (RSC requests, prefetches, server actions) — and any response that is not a 200 HTML page or that sets a cookie.
 * The Cache API is a no-op on *.workers.dev and in `next dev`: there every request renders.
 */

/** A copy younger than this is served without rendering. */
export const PAGE_TTL_SECONDS = 60;
/** After the TTL, a copy is still served this long while a fresh one renders in the background. */
export const PAGE_STALE_SECONDS = 600;

const CACHED_AT = 'x-edge-cached-at';
const SKIP_PREFIXES = ['/admin', '/api', '/_next', '/cdn-cgi'];
/** request headers Next uses for client-side navigation and actions: their responses are not the HTML document */
const NEXT_REQUEST_HEADERS = ['rsc', 'next-router-prefetch', 'next-router-state-tree', 'next-action', 'next-router-segment-prefetch'];
/** query parameters that never change a page: dropped from the cache key so shared links hit the same copy */
const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|ttclid|igshid)$/i;

export interface EdgeCache {
  match(key: Request): Promise<Response | undefined>;
  put(key: Request, res: Response): Promise<void>;
}
export interface WaitUntil {
  waitUntil(p: Promise<unknown>): void;
}

/** Whether this request may be answered from, or stored in, the page cache. */
export function isCacheableRequest(req: Request): boolean {
  if (req.method !== 'GET') return false;
  const url = new URL(req.url);
  if (SKIP_PREFIXES.some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`))) return false;
  if (url.searchParams.has('_rsc')) return false;
  if (NEXT_REQUEST_HEADERS.some((h) => req.headers.has(h))) return false;
  if (req.headers.has('authorization')) return false;
  const accept = req.headers.get('accept') ?? '';
  return accept.includes('text/html');
}

/** The cache key: the URL without tracking parameters (sorted, so the same page is one key). */
export function cacheKey(req: Request): Request {
  const url = new URL(req.url);
  url.hash = '';
  const kept = [...url.searchParams].filter(([k]) => !TRACKING_PARAMS.test(k)).sort(([a], [b]) => a.localeCompare(b));
  url.search = new URLSearchParams(kept).toString();
  return new Request(url.toString(), { method: 'GET' });
}

/**
 * A page that failed while it streamed still answers 200 (root loading.tsx sends the status before the reads
 * end) and carries the error inside the HTML: the RSC error row (`:E{"digest":…}`, escaped in the page's
 * __next_f payload) or React's client-render fallback (`$RX("…` script, `<!--$!-->` boundary).
 * On 2026-11-11 such a copy of the home page ("This page couldn't load") was the one visitors were served.
 */
const RENDER_ERROR = /:E\{\\*"digest\\*":|\$RX\("|<!--\$!-->/;
export function hasRenderError(html: string): boolean {
  return RENDER_ERROR.test(html);
}

/** Whether a rendered response may be stored: a 200 HTML page that sets no cookie. */
export function isStorableResponse(res: Response): boolean {
  return res.status === 200 && (res.headers.get('content-type') ?? '').includes('text/html') && !res.headers.has('set-cookie');
}

/** The copy kept in the cache: shared, held for TTL + stale, stamped with the time it was rendered. */
function storedCopy(res: Response, now: number): Response {
  const headers = new Headers(res.headers);
  headers.set('cache-control', `public, s-maxage=${PAGE_TTL_SECONDS + PAGE_STALE_SECONDS}`);
  headers.set(CACHED_AT, String(now));
  headers.delete('vary'); // RSC requests never reach the cache, so the copy varies on nothing
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** What the browser gets: no browser cache (it asks the edge every time), and where the page came from. */
function forClient(res: Response, state: 'HIT' | 'STALE' | 'MISS' | 'BYPASS'): Response {
  const headers = new Headers(res.headers);
  if (state !== 'BYPASS') {
    headers.set('cache-control', 'public, max-age=0, must-revalidate');
    headers.delete(CACHED_AT);
  }
  headers.set('x-edge-cache', state);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** keys being rendered in the background by this isolate: one refresh at a time per page */
const refreshing = new Set<string>();

/**
 * Serve `req` through the page cache. `render` produces the page (the Next handler); `cache` is caches.default.
 * Any cache failure falls back to rendering: the cache can make a page faster, never break it.
 */
export async function withEdgeCache(
  req: Request,
  ctx: WaitUntil,
  render: () => Promise<Response>,
  cache: EdgeCache | undefined,
  now: () => number = Date.now,
): Promise<Response> {
  if (!cache || !isCacheableRequest(req)) return render();
  const key = cacheKey(req);

  const store = async (res: Response) => {
    try {
      const body = await res.text();
      if (hasRenderError(body)) return; // never kept: the next visitor renders again
      await cache.put(key, storedCopy(new Response(body, res), now()));
    } catch {
      /* the next visitor renders again */
    }
  };

  let hit: Response | undefined;
  try {
    hit = await cache.match(key);
  } catch {
    hit = undefined;
  }
  if (hit) {
    const age = (now() - Number(hit.headers.get(CACHED_AT) ?? 0)) / 1000;
    if (age <= PAGE_TTL_SECONDS) return forClient(hit, 'HIT');
    if (age <= PAGE_TTL_SECONDS + PAGE_STALE_SECONDS) {
      if (!refreshing.has(key.url)) {
        refreshing.add(key.url);
        ctx.waitUntil(
          render()
            .then((fresh) => (isStorableResponse(fresh) ? store(fresh) : undefined))
            .catch(() => undefined)
            .finally(() => refreshing.delete(key.url)),
        );
      }
      return forClient(hit, 'STALE');
    }
  }

  const res = await render();
  if (!isStorableResponse(res)) return forClient(res, 'BYPASS');
  ctx.waitUntil(store(res.clone()));
  return forClient(res, 'MISS');
}
