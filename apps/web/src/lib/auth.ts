import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { webEnv } from './env';

/**
 * Supabase client acting as the logged-in user (session in cookies). Same publishable key as the
 * public site: what it may read/write is decided by RLS (admin_users + fp_is_admin()).
 */
export async function authClient() {
  const env = webEnv();
  const store = await cookies();
  return createServerClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // called from a Server Component: middleware keeps the session fresh instead
        }
      },
    },
  });
}

export interface Admin {
  userId: string;
  email: string;
  role: 'ADMIN' | 'EDITOR';
}

/** Logged-in user listed in admin_users, or null. */
export async function currentAdmin(): Promise<Admin | null> {
  const sb = await authClient();
  const { data } = await sb.auth.getUser();
  if (!data.user) return null;
  const { data: row } = await sb.from('admin_users').select('email, role').eq('user_id', data.user.id).maybeSingle();
  return row ? { userId: data.user.id, email: String(row.email), role: row.role as Admin['role'] } : null;
}

/** For admin pages/actions: redirect to login when not logged in; 'forbidden' when logged in without admin rights. */
export async function requireAdmin(): Promise<Admin> {
  const sb = await authClient();
  const { data } = await sb.auth.getUser();
  if (!data.user) redirect('/admin/login');
  const admin = await currentAdmin();
  if (!admin) redirect('/admin/login?error=forbidden');
  return admin;
}
