'use server';

import { revalidatePath, updateTag } from 'next/cache';
import { redirect } from 'next/navigation';
import { authClient, requireAdmin } from '@/lib/auth';
import { BANNER_SLOTS, httpsUrl, thaiLocalToIso, type BannerSlot } from '@/lib/banners';
import { BANNERS_TAG, bannersEnv } from '@/lib/banners-server';
import { presign } from '@/lib/r2';

export interface BannerFormState {
  error?: string;
}

/** After any change: the home page's banner read and this page. */
function refresh() {
  updateTag(BANNERS_TAG);
  revalidatePath('/admin/banners');
  revalidatePath('/');
}

/** A picture we host: its address must be under R2_BANNERS_PUBLIC_URL. */
function ours(url: string): boolean {
  const { publicUrl } = bannersEnv();
  return !!publicUrl && url.startsWith(`${publicUrl}/`);
}

/** Create or update. RLS (role ADMIN) is the real guard; requireAdmin gives a clean redirect. */
export async function saveBanner(_: BannerFormState | undefined, form: FormData): Promise<BannerFormState> {
  const admin = await requireAdmin();
  if (admin.role !== 'ADMIN') return { error: 'เฉพาะ ADMIN จัดการป้ายได้' };
  const id = Number(form.get('id') ?? 0) || null;
  const name = String(form.get('name') ?? '').trim();
  const alt = String(form.get('alt_text') ?? '').trim();
  const target = httpsUrl(String(form.get('target_url') ?? ''));
  const wide = String(form.get('image_wide_url') ?? '');
  const phone = String(form.get('image_phone_url') ?? '');
  const slots = form.getAll('slots').map(String).filter((s): s is BannerSlot => (BANNER_SLOTS as readonly string[]).includes(s));
  const startsRaw = String(form.get('starts_at') ?? '');
  const endsRaw = String(form.get('ends_at') ?? '');
  const startsAt = startsRaw ? thaiLocalToIso(startsRaw) : new Date().toISOString();
  const endsAt = endsRaw ? thaiLocalToIso(endsRaw) : null;

  const errors: string[] = [];
  if (!name) errors.push('ใส่ชื่อป้าย');
  if (!alt) errors.push('ใส่ข้อความ alt (บอกว่าภาพเขียนว่าอะไร)');
  if (!target) errors.push('ลิงก์ปลายทางต้องขึ้นต้นด้วย https://');
  if (!ours(wide)) errors.push('อัปโหลดภาพ web');
  if (!ours(phone)) errors.push('อัปโหลดภาพ mobile');
  if (!slots.length) errors.push('เลือกอย่างน้อยหนึ่งตำแหน่ง');
  if (!startsAt) errors.push('วันเริ่มไม่ถูกต้อง');
  if (endsRaw && !endsAt) errors.push('วันจบไม่ถูกต้อง');
  if (startsAt && endsAt && endsAt <= startsAt) errors.push('วันจบต้องหลังวันเริ่ม');
  if (errors.length) return { error: errors.join('\n') };

  const row = {
    name,
    alt_text: alt,
    target_url: target,
    image_wide_url: wide,
    image_phone_url: phone,
    slots,
    priority: Math.round(Number(form.get('priority') ?? 0)) || 0,
    starts_at: startsAt,
    ends_at: endsAt,
    is_on: form.get('is_on') === 'on',
    is_gambling: form.get('is_gambling') === 'on',
    ...(id ? {} : { created_by: admin.email }),
  };
  const sb = await authClient();
  const res = id ? await sb.from('banners').update(row).eq('id', id).select('id').single() : await sb.from('banners').insert(row).select('id').single();
  if (res.error) return { error: res.error.message };
  refresh();
  redirect('/admin/banners?saved=1');
}

/** On/off without opening the form. */
export async function toggleBanner(form: FormData) {
  const admin = await requireAdmin();
  if (admin.role !== 'ADMIN') return;
  const sb = await authClient();
  await sb.from('banners').update({ is_on: form.get('is_on') === 'true' }).eq('id', Number(form.get('id')));
  refresh();
}

/** Deletes the banner, its clicks, and its two pictures from the bucket (a failed picture delete is only logged). */
export async function deleteBanner(form: FormData) {
  const admin = await requireAdmin();
  if (admin.role !== 'ADMIN') return;
  const sb = await authClient();
  const { data } = await sb.from('banners').delete().eq('id', Number(form.get('id'))).select('image_wide_url, image_phone_url').maybeSingle();
  const { r2, publicUrl } = bannersEnv();
  if (data && r2) {
    for (const url of [data.image_wide_url, data.image_phone_url] as string[]) {
      if (!url.startsWith(`${publicUrl}/`)) continue;
      const res = await fetch(await presign(r2, 'DELETE', url.slice(publicUrl.length + 1), 300), { method: 'DELETE' }).catch((e: unknown) => e);
      if (!(res instanceof Response) || !res.ok) console.error('banners: picture not deleted:', url);
    }
  }
  refresh();
  redirect('/admin/banners');
}

/** The one switch that hides (or shows again) every gambling banner, at once. */
export async function setGamblingHidden(form: FormData) {
  const admin = await requireAdmin();
  if (admin.role !== 'ADMIN') return;
  const sb = await authClient();
  await sb
    .from('site_settings')
    .update({ value: form.get('hide') === 'true', updated_at: new Date().toISOString(), updated_by: admin.email })
    .eq('key', 'hide_gambling_banners');
  refresh();
}
