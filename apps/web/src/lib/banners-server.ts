import 'server-only';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { unstable_cache } from 'next/cache';
import { chooseBanners, type Banner, type BannerSlot, type SlotBanners } from './banners';
import type { R2Config } from './r2';
import { db } from './supabase';

/** Cache tag of the home page's banner read; /admin/banners revalidates it on every change. */
export const BANNERS_TAG = 'banners';

/**
 * The public banner bucket (ADR 0024): same R2 account and token as /admin/social, its own bucket, served at
 * R2_BANNERS_PUBLIC_URL (a custom domain on the bucket). Null with the names of the missing settings.
 */
export function bannersEnv(): { r2: R2Config | null; publicUrl: string; missing: string[] } {
  let src: Record<string, unknown> = process.env;
  try {
    src = { ...process.env, ...(getCloudflareContext().env as unknown as Record<string, unknown>) };
  } catch {
    // not running inside the Cloudflare runtime
  }
  const get = (k: string) => String(src[k] ?? '').trim();
  const keys = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BANNERS_BUCKET', 'R2_BANNERS_PUBLIC_URL'];
  const missing = keys.filter((k) => !get(k));
  const publicUrl = get('R2_BANNERS_PUBLIC_URL').replace(/\/+$/, '');
  if (missing.length) return { r2: null, publicUrl, missing };
  return {
    r2: { accountId: get('R2_ACCOUNT_ID'), bucket: get('R2_BANNERS_BUCKET'), accessKeyId: get('R2_ACCESS_KEY_ID'), secretAccessKey: get('R2_SECRET_ACCESS_KEY') },
    publicUrl,
    missing,
  };
}

interface Row { id: number; name: string; image_wide_url: string; image_phone_url: string; alt_text: string; target_url: string; slots: BannerSlot[]; priority: number }

/** The banners that may show now (RLS decides: on, inside the run period, gambling switch) — one minute in cache. */
const liveBanners = unstable_cache(
  async (): Promise<Banner[]> => {
    const { data, error } = await db().from('banners').select('id, name, image_wide_url, image_phone_url, alt_text, target_url, slots, priority');
    if (error) throw new Error(error.message);
    return ((data ?? []) as Row[]).map((r) => ({
      id: Number(r.id),
      name: r.name,
      imageWide: r.image_wide_url,
      imagePhone: r.image_phone_url,
      alt: r.alt_text,
      target: r.target_url,
      slots: r.slots,
      priority: Number(r.priority),
    }));
  },
  ['live-banners'],
  { revalidate: 60, tags: [BANNERS_TAG] },
);

/** One banner per home-page slot. A banner whose period ends inside the cached minute may show up to a minute longer. */
export async function homeBanners(): Promise<SlotBanners> {
  return chooseBanners(await liveBanners());
}
