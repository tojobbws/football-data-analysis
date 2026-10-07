import 'server-only';
import { getCloudflareContext } from '@opennextjs/cloudflare';

export interface WebEnv {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  /** league ids shown on the site (comma-separated) */
  leagues: number[];
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
  const leagues = String(src.WEB_LEAGUES ?? '39,140,135,78,61,296,5')
    .split(',')
    .map((x) => Number(x.trim()))
    .filter(Number.isInteger);
  return { SUPABASE_URL: url, SUPABASE_ANON_KEY: key, leagues };
}
