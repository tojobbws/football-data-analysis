import type { MetadataRoute } from 'next';
import { webEnv } from '@/lib/env';
import { siteUrl } from '@/lib/site';
import { allRows, db } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const DAY = 86_400_000;
/** One sitemap file holds at most 50,000 URLs (sitemaps.org); far above what the windows below return. */
const MAX_URLS = 45_000;

/**
 * Public pages for search engines: sections, match pages from 90 days back to 30 days ahead
 * (tracked leagues), and every published article.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = await siteUrl();
  const now = Date.now();
  const sb = db();
  // .limit(5000) alone was capped at 1000 rows by the server: 3600 matches in the window, 2600 left out (2026-10-26)
  const [fixtures, articles] = await Promise.all([
    allRows<{ slug: string; kickoff_at: string; synced_at: string | null }>(
      (from, to) =>
        sb
          .from('fixtures')
          .select('slug, kickoff_at, synced_at')
          .in('league_id', webEnv().leagues)
          .not('slug', 'is', null)
          .gte('kickoff_at', new Date(now - 90 * DAY).toISOString())
          .lt('kickoff_at', new Date(now + 30 * DAY).toISOString())
          .order('kickoff_at', { ascending: false })
          .order('id')
          .range(from, to),
      MAX_URLS,
    ),
    allRows<{ slug: string; published_at: string | null; updated_at: string | null }>(
      (from, to) => sb.from('articles').select('slug, published_at, updated_at').eq('status', 'PUBLISHED').order('published_at', { ascending: false }).order('id').range(from, to),
      MAX_URLS,
    ),
  ]);
  if (fixtures.error) console.error('sitemap fixtures:', fixtures.error.message);
  if (articles.error) console.error('sitemap articles:', articles.error.message);

  const today = new Date(now);
  const pages: MetadataRoute.Sitemap = [
    { url: `${origin}/`, lastModified: today, changeFrequency: 'hourly', priority: 1 },
    { url: `${origin}/today`, lastModified: today, changeFrequency: 'hourly', priority: 0.9 },
    { url: `${origin}/matches`, lastModified: today, changeFrequency: 'hourly', priority: 0.8 },
    { url: `${origin}/analysis`, lastModified: today, changeFrequency: 'daily', priority: 0.7 },
    { url: `${origin}/performance`, lastModified: today, changeFrequency: 'daily', priority: 0.6 },
  ];
  for (const f of fixtures.data ?? []) {
    const upcoming = new Date(f.kickoff_at as string).getTime() > now;
    pages.push({
      url: `${origin}/matches/${f.slug}`,
      lastModified: new Date((f.synced_at as string) ?? (f.kickoff_at as string)),
      changeFrequency: upcoming ? 'hourly' : 'weekly',
      priority: upcoming ? 0.8 : 0.5,
    });
  }
  for (const a of articles.data ?? []) {
    pages.push({ url: `${origin}/analysis/${a.slug}`, lastModified: new Date((a.updated_at as string) ?? (a.published_at as string)), changeFrequency: 'weekly', priority: 0.7 });
  }
  return pages;
}
