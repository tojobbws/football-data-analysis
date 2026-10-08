import 'server-only';
import { headers } from 'next/headers';
import { webEnv } from './env';

export { SITE_DESCRIPTION, SITE_NAME, SITE_NAME_EN, SITE_TAGLINE } from './brand';

/**
 * Absolute origin for canonical URLs, Open Graph and the sitemap.
 * SITE_URL when set (production); otherwise the host of the current request.
 */
export async function siteUrl(): Promise<string> {
  const fixed = webEnv().SITE_URL;
  if (fixed) return fixed.replace(/\/+$/, '');
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
  return `${proto}://${host}`;
}
