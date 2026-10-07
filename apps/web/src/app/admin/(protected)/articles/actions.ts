'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { authClient, requireAdmin } from '@/lib/auth';

export interface ArticleFormState {
  error?: string;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Create or update. RLS (fp_is_admin) is the real guard; requireAdmin only gives a clean redirect. */
export async function saveArticle(_: ArticleFormState | undefined, form: FormData): Promise<ArticleFormState> {
  const admin = await requireAdmin();
  const id = Number(form.get('id') ?? 0) || null;
  const title = String(form.get('title') ?? '').trim();
  const slug = String(form.get('slug') ?? '').trim().toLowerCase();
  const body = String(form.get('body_md') ?? '').trim();
  const status = String(form.get('status') ?? 'DRAFT');
  const fixtureSlug = String(form.get('fixture_slug') ?? '').trim();
  if (!title || !body) return { error: 'ต้องมีหัวข้อและเนื้อหา' };
  if (!SLUG.test(slug)) return { error: 'slug ใช้ได้เฉพาะ a-z 0-9 และขีด - เช่น liverpool-vs-arsenal-preview' };
  if (!['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(status)) return { error: 'สถานะไม่ถูกต้อง' };

  const sb = await authClient();
  let fixtureId: number | null = null;
  if (fixtureSlug) {
    const { data } = await sb.from('fixtures').select('id').eq('slug', fixtureSlug).maybeSingle();
    if (!data) return { error: `ไม่พบแมตช์ slug "${fixtureSlug}"` };
    fixtureId = Number(data.id);
  }
  const row = {
    title,
    slug,
    body_md: body,
    status,
    description: String(form.get('description') ?? '').trim() || null,
    category_id: Number(form.get('category_id') ?? 0) || null,
    fixture_id: fixtureId,
    ...(id ? {} : { generated_by: `human:${admin.email}` }),
  };
  const res = id ? await sb.from('articles').update(row).eq('id', id).select('id').single() : await sb.from('articles').insert(row).select('id').single();
  if (res.error) return { error: res.error.code === '23505' ? 'slug นี้ถูกใช้แล้ว' : res.error.message };
  revalidatePath('/analysis');
  redirect(`/admin/articles/${res.data.id}?saved=1`);
}

export async function deleteArticle(form: FormData) {
  await requireAdmin();
  const sb = await authClient();
  await sb.from('articles').delete().eq('id', Number(form.get('id')));
  revalidatePath('/analysis');
  redirect('/admin/articles');
}
