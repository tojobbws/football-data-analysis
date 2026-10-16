import 'server-only';
import { getCloudflareContext } from '@opennextjs/cloudflare';

export interface WebEnv {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  /** league ids shown on the site (comma-separated) */
  leagues: number[];
  /** public origin, e.g. https://www.example.com (canonical URLs, sitemap); optional */
  SITE_URL: string;
}

/** Cloudflare bindings in production/preview, process.env in `next dev`. Server only. */
export function webEnv(): WebEnv {
  let src: Record<string, unknown> = process.env;
  try {
    src = { ...process.env, ...(getCloudflareContext().env as unknown as Record<string, unknown>) };
  } catch {
    // not running inside the Cloudflare runtime
  }
  const url = String(src.SUPABASE_URL ?? '');
  const key = String(src.SUPABASE_ANON_KEY ?? '');
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set (see apps/web/.env.local.example)');
  const leagues = String(src.WEB_LEAGUES ?? '39,140,135,78,61,296,5,2,3,848,1129,40,88,94,144,203,179,119,218,207,103,113,292,98,253,262,128,307,188,71')
    .split(',')
    .map((x) => Number(x.trim()))
    .filter(Number.isInteger);
  return { SUPABASE_URL: url, SUPABASE_ANON_KEY: key, leagues, SITE_URL: String(src.SITE_URL ?? '') };
}
