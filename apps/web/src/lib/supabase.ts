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
