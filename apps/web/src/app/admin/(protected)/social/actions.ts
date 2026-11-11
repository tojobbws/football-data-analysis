'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/auth';
import { cancelPost } from '@/lib/social-server';

/** Marks a post stuck in an open status as FAILED. Only role ADMIN (RLS 0057 is the real guard). */
export async function cancelSocialPost(form: FormData) {
  const admin = await requireAdmin();
  if (admin.role !== 'ADMIN') return;
  await cancelPost(Number(form.get('id')), admin.email);
  revalidatePath('/admin/social');
}
