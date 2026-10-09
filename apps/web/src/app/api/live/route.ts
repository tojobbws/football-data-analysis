import { getCloudflareContext } from '@opennextjs/cloudflare';
import { liveSnapshot } from '@/lib/queries';

export const dynamic = 'force-dynamic';

// One shared response for every open page, cached at the Cloudflare edge for 10 s: however many
// people watch a big match, the database sees at most one read per 10 s per data centre. The live
// worker writes every 30 s, so the cache adds little delay. (Cache API is a no-op on *.workers.dev
// and in `next dev`: there every request reads the database.)
const TTL_SECONDS = 10;

export async function GET(req: Request): Promise<Response> {
  const cache = (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
  const key = new Request(new URL('/api/live', req.url).toString(), { method: 'GET' });
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }

  let body: string;
  try {
    body = JSON.stringify(await liveSnapshot());
  } catch {
    // the client keeps its last values and backs off; never cache a failure
    return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }
  const res = new Response(body, {
    headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${TTL_SECONDS}, s-maxage=${TTL_SECONDS}` },
  });
  if (cache) {
    const put = cache.put(key, res.clone());
    try {
      getCloudflareContext().ctx.waitUntil(put);
    } catch {
      await put;
    }
  }
  return res;
}
