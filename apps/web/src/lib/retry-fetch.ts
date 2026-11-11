/**
 * The site's database reads try once more when the request failed on the way (a network error, or a gateway
 * 5xx from Supabase or Cloudflare), so one dropped request no longer takes a whole page down.
 * A query error (a statement timeout is a 500 with code 57014) is answered as is: running it again would only
 * wait as long again. Only reads are retried: GET/HEAD, and POST to a /rpc/ function (the web functions are reads).
 */
export const RETRY_STATUS = new Set([502, 503, 504, 520, 521, 522, 523, 524]);
export const RETRY_DELAY_MS = 250;

type Fetch = typeof fetch;

export function retryOnce(base: Fetch = (...a) => fetch(...a), delayMs = RETRY_DELAY_MS): Fetch {
  return async (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!(method === 'GET' || method === 'HEAD' || url.includes('/rest/v1/rpc/'))) return base(input, init);
    try {
      const res = await base(input, init);
      if (!RETRY_STATUS.has(res.status)) return res;
      await res.body?.cancel().catch(() => undefined);
    } catch (e) {
      if (init?.signal?.aborted) throw e;
    }
    await new Promise((r) => setTimeout(r, delayMs));
    return base(input, init);
  };
}
