import type { MetadataRoute } from 'next';
import { webEnv } from '@/lib/env';
import { siteUrl } from '@/lib/site';
import { db } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const DAY = 86_400_000;

/**
 * Public pages for search engines: sections, match pages from 90 days back to 30 days ahead
 * (tracked leagues), and every published article.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = await siteUrl();
  const now = Date.now();
  const sb = db();
  const [fixtures, articles] = await Promise.all([
    sb
      .from('fixtures')
      .select('slug, kickoff_at, synced_at')
      .in('league_id', webEnv().leagues)
      .not('slug', 'is', null)
      .gte('kickoff_at', new Date(now - 90 * DAY).toISOString())
      .lt('kickoff_at', new Date(now + 30 * DAY).toISOString())
      .order('kickoff_at', { ascending: false })
      .limit(5000),
    sb.from('articles').select('slug, published_at, updated_at').eq('status', 'PUBLISHED').order('published_at', { ascending: false }).limit(5000),
  ]);

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
