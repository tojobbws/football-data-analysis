import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

// Stays "middleware" (edge), not Next 16's "proxy": OpenNext runs proxy on Node, experimental on Cloudflare.
/**
 * 1. One public address: www.<site> and *.workers.dev answer with a 301 to SITE_URL, so search
 *    engines index a single host (and the edge cache in /api/live works; it is off on workers.dev).
 * 2. Keeps the Supabase session cookie fresh on /admin (Server Components cannot write cookies).
 */
export async function middleware(request: NextRequest) {
  const moved = redirectToCanonicalHost(request);
  if (moved) return moved;
  if (!request.nextUrl.pathname.startsWith('/admin')) return NextResponse.next();

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  let response = NextResponse.next({ request });
  if (!url || !key) return response;
  const sb = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
      },
    },
  });
  await sb.auth.getUser();
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return response;
}

/** A 301 to the same path on SITE_URL when the request came in on www or workers.dev; else null. */
function redirectToCanonicalHost(request: NextRequest): NextResponse | null {
  const site = process.env.SITE_URL;
  if (!site) return null;
  let canonical: URL;
  try {
    canonical = new URL(site);
  } catch {
    return null;
  }
  const host = (request.headers.get('host') ?? '').toLowerCase();
  if (host !== `www.${canonical.host}` && !host.endsWith('.workers.dev')) return null;
  const target = new URL(request.nextUrl.pathname + request.nextUrl.search, canonical.origin);
  return NextResponse.redirect(target, 301);
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
