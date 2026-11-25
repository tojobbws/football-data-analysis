'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { BANNER_IMAGES, BANNER_SLOTS, SLOT_LABEL, checkImageFile, checkImageSize, type BannerImageKind, type BannerSlot } from '@/lib/banners';
import { saveBanner, type BannerFormState } from './actions';

const input = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm';

export interface BannerDraft {
  id?: number;
  name: string;
  alt_text: string;
  target_url: string;
  image_wide_url: string;
  image_phone_url: string;
  slots: BannerSlot[];
  priority: number;
  starts_at: string; // Thai wall clock, datetime-local
  ends_at: string;
  is_on: boolean;
  is_gambling: boolean;
}

/** The picture's pixel size, read in the browser before it is uploaded. */
function measure(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      reject(new Error('อ่านไฟล์ภาพไม่ได้'));
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

/** One picture: checked here, then put straight into the public R2 bucket by a presigned link (needs its CORS rule). */
function ImagePicker({ kind, value, onChange }: { kind: BannerImageKind; value: string; onChange: (url: string) => void }) {
  const t = BANNER_IMAGES[kind];
  const [state, setState] = useState<{ busy: boolean; error?: string }>({ busy: false });

  async function pick(file: File | undefined) {
    if (!file) return;
    setState({ busy: true });
    try {
      const fileError = checkImageFile(kind, file.type, file.size);
      if (fileError) throw new Error(fileError);
      const { width, height } = await measure(file);
      const sizeError = checkImageSize(kind, width, height);
      if (sizeError) throw new Error(sizeError);
      const res = await fetch('/api/admin/banners/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, type: file.type, bytes: file.size, width, height }),
      });
      const body = (await res.json().catch(() => ({}))) as { putUrl?: string; url?: string; error?: string };
      if (!res.ok || !body.putUrl || !body.url) throw new Error(body.error ?? `ขอลิงก์อัปโหลดไม่สำเร็จ (${res.status})`);
      const put = await fetch(body.putUrl, { method: 'PUT', body: file, headers: { 'content-type': file.type, 'cache-control': 'public, max-age=31536000, immutable' } });
      if (!put.ok) throw new Error(`อัปโหลดไม่สำเร็จ (${put.status}) ตรวจ CORS ของ bucket`);
      onChange(body.url);
      setState({ busy: false });
    } catch (e) {
      setState({ busy: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <div>
      <span className="text-sm font-medium">
        {t.label} <span className="font-normal text-slate-500">{t.width}×{t.height} px · JPG/WebP/PNG ≤ 300KB</span>
      </span>
      {value ? (
        // eslint-disable-next-line @next/next/no-img-element -- admin preview of our own upload
        <img src={value} alt="" width={t.width} height={t.height} className={`mt-1 h-auto rounded-lg ring-1 ring-slate-200 ${kind === 'wide' ? 'w-full max-w-[670px]' : 'w-full max-w-[360px]'}`} />
      ) : null}
      <input type="file" accept="image/jpeg,image/webp,image/png" disabled={state.busy} onChange={(e) => pick(e.target.files?.[0])} className="mt-1 block text-sm" />
      {state.busy ? <p className="mt-1 text-xs text-slate-500">กำลังอัปโหลด…</p> : null}
      {state.error ? <p className="mt-1 text-xs text-red-700">{state.error}</p> : null}
    </div>
  );
}

export function BannerForm({ draft }: { draft: BannerDraft }) {
  const [state, action, pending] = useActionState<BannerFormState | undefined, FormData>(saveBanner, undefined);
  const [wide, setWide] = useState(draft.image_wide_url);
  const [phone, setPhone] = useState(draft.image_phone_url);

  return (
    <form action={action} className="space-y-4 rounded-2xl bg-white p-4 ring-1 ring-slate-200">
      <h2 className="font-bold">{draft.id ? `แก้ป้าย #${draft.id}` : 'สร้างป้ายใหม่'}</h2>
      {draft.id ? <input type="hidden" name="id" value={draft.id} /> : null}
      <input type="hidden" name="image_wide_url" value={wide} />
      <input type="hidden" name="image_phone_url" value={phone} />

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm font-medium">
          ชื่อป้าย <span className="font-normal text-slate-500">(เห็นเฉพาะหลังบ้าน)</span>
          <input name="name" defaultValue={draft.name} required className={input} />
        </label>
        <label className="block text-sm font-medium">
          ลิงก์ปลายทาง <span className="font-normal text-slate-500">(https:// เท่านั้น)</span>
          <input name="target_url" type="url" defaultValue={draft.target_url} required placeholder="https://" className={input} />
        </label>
      </div>
      <label className="block text-sm font-medium">
        ข้อความ alt <span className="font-normal text-slate-500">(ภาพนี้บอกอะไร สำหรับโปรแกรมอ่านหน้าจอและ SEO)</span>
        <input name="alt_text" defaultValue={draft.alt_text} required className={input} />
      </label>

      <ImagePicker kind="wide" value={wide} onChange={setWide} />
      <ImagePicker kind="phone" value={phone} onChange={setPhone} />

      <fieldset>
        <legend className="text-sm font-medium">ตำแหน่ง</legend>
        <div className="mt-1 flex flex-wrap gap-x-5 gap-y-2">
          {BANNER_SLOTS.map((s) => (
            <label key={s} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="slots" value={s} defaultChecked={draft.slots.includes(s)} />
              {SLOT_LABEL[s]}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-3">
        <label className="block text-sm font-medium">
          ลำดับความสำคัญ <span className="font-normal text-slate-500">(มากขึ้นก่อน)</span>
          <input name="priority" type="number" step={1} defaultValue={draft.priority} className={input} />
        </label>
        <label className="block text-sm font-medium">
          เริ่ม (เวลาไทย)
          <input name="starts_at" type="datetime-local" defaultValue={draft.starts_at} className={input} />
        </label>
        <label className="block text-sm font-medium">
          จบ (เวลาไทย) <span className="font-normal text-slate-500">ว่าง = ไม่มีกำหนด</span>
          <input name="ends_at" type="datetime-local" defaultValue={draft.ends_at} className={input} />
        </label>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" name="is_on" defaultChecked={draft.is_on} /> เปิดใช้งาน
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="is_gambling" defaultChecked={draft.is_gambling} /> ป้ายพนัน <span className="text-slate-500">(ซ่อนพร้อมกันได้ด้วยสวิตช์ด้านบน)</span>
        </label>
      </div>

      {state?.error ? <p className="whitespace-pre-line rounded-lg bg-red-50 p-3 text-sm text-red-800">{state.error}</p> : null}
      <div className="flex items-center gap-3">
        <button disabled={pending} className="rounded-full bg-[var(--color-pitch)] px-5 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {pending ? 'กำลังบันทึก…' : 'บันทึก'}
        </button>
        {draft.id ? (
          <Link href="/admin/banners" className="text-sm text-slate-600 hover:underline">
            ยกเลิก
          </Link>
        ) : null}
      </div>
    </form>
  );
}
