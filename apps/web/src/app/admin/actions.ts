'use server';

import { redirect } from 'next/navigation';
import { authClient } from '@/lib/auth';

export async function login(_: { error?: string } | undefined, form: FormData): Promise<{ error?: string }> {
  const email = String(form.get('email') ?? '').trim();
  const password = String(form.get('password') ?? '');
  if (!email || !password) return { error: 'กรุณากรอกอีเมลและรหัสผ่าน' };
  const sb = await authClient();
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) return { error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' };
  redirect('/admin');
}

export async function logout() {
  const sb = await authClient();
  await sb.auth.signOut();
  redirect('/admin/login');
}
