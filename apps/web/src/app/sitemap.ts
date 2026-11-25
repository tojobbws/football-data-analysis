import type { MetadataRoute } from 'next';
import { webEnv } from '@/lib/env';
import { isThinMatchPage } from '@/lib/indexing';
import { siteUrl } from '@/lib/site';
import { allRows, db } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const DAY = 86_400_000;
/** One sitemap file holds at most 50,000 URLs (sitemaps.org); far above what the windows below return. */
const MAX_URLS = 45_000;

/**
 * Public pages for search engines: sections, match pages from 90 days back to 30 days ahead
 * (tracked leagues; a match that is over only with a Thai write-up, lib/indexing.ts), and every
 * published article.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = await siteUrl();
  const now = Date.now();
  const sb = db();
  // .limit(5000) alone was capped at 1000 rows by the server: 3600 matches in the window, 2600 left out (2026-10-26)
  const [fixtures, articles, writeUps] = await Promise.all([
    allRows<{ id: number; slug: string; kickoff_at: string; synced_at: string | null }>(
      (from, to) =>
        sb
          .from('fixtures')
          .select('id, slug, kickoff_at, synced_at')
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
    // matches with a Thai write-up in the window: the others that are over leave the sitemap (lib/indexing.ts)
    allRows<{ fixture_id: number }>(
      (from, to) =>
        sb
          .from('web_match_previews')
          .select('fixture_id')
          .gte('kickoff_at', new Date(now - 90 * DAY).toISOString())
          .order('fixture_id')
          .range(from, to),
      MAX_URLS,
    ),
  ]);
  if (fixtures.error) console.error('sitemap fixtures:', fixtures.error.message);
  if (articles.error) console.error('sitemap articles:', articles.error.message);
  if (writeUps.error) console.error('sitemap write-ups:', writeUps.error.message);
  const written = new Set(writeUps.data.map((w) => w.fixture_id));

  const today = new Date(now);
  const pages: MetadataRoute.Sitemap = [
    { url: `${origin}/`, lastModified: today, changeFrequency: 'hourly', priority: 1 },
    { url: `${origin}/today`, lastModified: today, changeFrequency: 'hourly', priority: 0.9 },
    { url: `${origin}/matches`, lastModified: today, changeFrequency: 'hourly', priority: 0.8 },
    { url: `${origin}/analysis`, lastModified: today, changeFrequency: 'daily', priority: 0.7 },
    { url: `${origin}/performance`, lastModified: today, changeFrequency: 'daily', priority: 0.6 },
    { url: `${origin}/privacy`, lastModified: new Date('2026-11-25T00:00:00+07:00'), changeFrequency: 'yearly', priority: 0.1 },
    { url: `${origin}/terms`, lastModified: new Date('2026-11-25T00:00:00+07:00'), changeFrequency: 'yearly', priority: 0.1 },
  ];
  for (const f of fixtures.data ?? []) {
    // on a failed write-up read, keep every match rather than drop the written ones
    if (!writeUps.error && isThinMatchPage(f.kickoff_at, written.has(f.id), now)) continue;
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
