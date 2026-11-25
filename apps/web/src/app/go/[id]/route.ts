import { isBot } from '@/lib/banners';
import { db } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * A banner click (ADR 0024): counts it (known bots are not counted) and redirects to the banner's destination.
 * A banner that is off, outside its period or hidden by the gambling switch sends the reader to the home page.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const home = new URL('/', req.url);
  const headers = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' };
  const bannerId = Number(id);
  if (!Number.isSafeInteger(bannerId) || bannerId <= 0) return Response.redirect(home, 302);
  try {
    const { data, error } = await db().rpc('fp_banner_click', { p_id: bannerId, p_count: !isBot(req.headers.get('user-agent')) });
    if (error) throw new Error(error.message);
    const target = typeof data === 'string' && data.startsWith('https://') ? data : null;
    return new Response(null, { status: 302, headers: { ...headers, location: target ?? home.toString() } });
  } catch (e) {
    console.error('go: banner click failed:', e instanceof Error ? e.message : e);
    return new Response(null, { status: 302, headers: { ...headers, location: home.toString() } });
  }
}
