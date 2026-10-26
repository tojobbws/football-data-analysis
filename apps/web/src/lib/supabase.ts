import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { webEnv } from './env';

/** Read-only client with the anon key: RLS limits it to public tables and views. */
export function db(): SupabaseClient {
  const env = webEnv();
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Supabase's PostgREST answers at most this many rows per request (max_rows), whatever `.limit()` asks for. */
export const PAGE_ROWS = 1000;

/**
 * Every row of a query that may pass PAGE_ROWS, read page by page. `page(from, to)` must end with
 * `.range(from, to)` on a total order (finish with a unique column), or rows can repeat or go missing
 * between pages. `max` stops early, like a `.limit()` the server would otherwise cap at PAGE_ROWS.
 */
export async function allRows<T>(
  // rows typed by the caller (`T`): the query builders type their rows loosely
  page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
  max = Infinity,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const data: T[] = [];
  for (let from = 0; from < max; from += PAGE_ROWS) {
    const to = Math.min(from + PAGE_ROWS, max) - 1;
    const res = await page(from, to);
    if (res.error) return { data, error: res.error };
    data.push(...((res.data ?? []) as T[]));
    if ((res.data ?? []).length < to - from + 1) break;
  }
  return { data, error: null };
}
