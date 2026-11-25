import Link from 'next/link';
import { authClient, requireAdmin } from '@/lib/auth';
import { BANNER_IMAGES, SLOT_LABEL, isoToThaiLocal, type BannerSlot } from '@/lib/banners';
import { bannersEnv } from '@/lib/banners-server';
import { dateTimeTH } from '@/lib/time';
import { deleteBanner, setGamblingHidden, toggleBanner } from './actions';
import { BannerForm, type BannerDraft } from './banner-form';

export const dynamic = 'force-dynamic';

interface Row {
  id: number;
  name: string;
  alt_text: string;
  target_url: string;
  image_wide_url: string;
  image_phone_url: string;
  slots: BannerSlot[];
  priority: number;
  starts_at: string;
  ends_at: string | null;
  is_on: boolean;
  is_gambling: boolean;
}

/** What a reader sees of a banner right now. */
function status(b: Row, gamblingHidden: boolean, now: number): { label: string; tone: string } {
  if (!b.is_on) return { label: 'ปิดอยู่', tone: 'bg-slate-100 text-slate-600' };
  if (Date.parse(b.starts_at) > now) return { label: 'รอเริ่ม', tone: 'bg-sky-50 text-sky-800' };
  if (b.ends_at && Date.parse(b.ends_at) <= now) return { label: 'หมดเวลา', tone: 'bg-slate-100 text-slate-600' };
  if (b.is_gambling && gamblingHidden) return { label: 'ซ่อน (สวิตช์ป้ายพนัน)', tone: 'bg-amber-50 text-amber-800' };
  return { label: 'กำลังแสดง', tone: 'bg-emerald-50 text-emerald-800' };
}

/** Home-page banners (ADR 0024): three slots, one banner each by priority, clicks counted through /go/<id>. */
export default async function AdminBanners({ searchParams }: { searchParams: Promise<{ edit?: string; saved?: string }> }) {
  const admin = await requireAdmin();
  const q = await searchParams;
  const { missing } = bannersEnv();
  const sb = await authClient();
  const [list, clicks, setting] = await Promise.all([
    sb.from('banners').select('id, name, alt_text, target_url, image_wide_url, image_phone_url, slots, priority, starts_at, ends_at, is_on, is_gambling').order('priority', { ascending: false }).order('id', { ascending: false }),
    sb.rpc('fp_admin_banner_clicks'),
    sb.from('site_settings').select('value').eq('key', 'hide_gambling_banners').maybeSingle(),
  ]);
  const rows = (list.data ?? []) as Row[];
  const clickBy = new Map(((clicks.data ?? []) as Array<{ banner_id: number; total: number; last_7d: number }>).map((c) => [Number(c.banner_id), c]));
  const gamblingHidden = setting.data?.value === true;
  const canEdit = admin.role === 'ADMIN' && !missing.length;
  const now = Date.now();

  const editing = rows.find((r) => r.id === Number(q.edit));
  const draft: BannerDraft = editing
    ? { ...editing, starts_at: isoToThaiLocal(editing.starts_at), ends_at: isoToThaiLocal(editing.ends_at) }
    : { name: '', alt_text: '', target_url: '', image_wide_url: '', image_phone_url: '', slots: ['home_top'], priority: 0, starts_at: '', ends_at: '', is_on: true, is_gambling: false };

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-bold">ป้ายโฆษณาหน้าแรก</h1>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-600">
          หน้าแรกมี 3 ตำแหน่ง: บนสุดก่อนแมตช์วันนี้ หลังลีกที่ 2 และหลังลีกที่ 5 (สองตำแหน่งหลังขึ้นเมื่อมีลีกต่อจากนั้น) แต่ละตำแหน่งแสดงครั้งละ 1 ป้าย เลือกจากลำดับความสำคัญ ป้ายเดียวกันไม่ขึ้นซ้ำในหน้าเดียว
          ภาพ web {BANNER_IMAGES.wide.width}×{BANNER_IMAGES.wide.height} px (จอ ≥ 640px) และภาพ mobile {BANNER_IMAGES.phone.width}×{BANNER_IMAGES.phone.height} px วางตัวหนังสือห่างขอบ 5% ป้ายที่แก้จะขึ้นหน้าเว็บภายใน 1 นาที
        </p>
      </header>

      {admin.role !== 'ADMIN' ? <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">บัญชี {admin.role} ดูได้ แต่แก้ป้ายได้เฉพาะ ADMIN</p> : null}
      {missing.length ? <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">ยังไม่ได้ตั้งค่า {missing.join(', ')} จึงอัปโหลดภาพไม่ได้</p> : null}
      {q.saved ? <p className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">บันทึกแล้ว</p> : null}

      <section className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl p-4 ring-1 ${gamblingHidden ? 'bg-amber-50 ring-amber-200' : 'bg-white ring-slate-200'}`}>
        <div className="text-sm">
          <p className="font-bold">สวิตช์ป้ายพนัน: {gamblingHidden ? 'ซ่อนป้ายพนันทั้งหมดอยู่' : 'แสดงตามปกติ'}</p>
          <p className="mt-0.5 text-slate-600">กดครั้งเดียว ป้ายที่ติ๊ก &quot;ป้ายพนัน&quot; ทุกอันหายจากหน้าเว็บทันที และลิงก์ของป้ายเหล่านั้นจะพาไปหน้าแรกแทน</p>
        </div>
        {admin.role === 'ADMIN' ? (
          <form action={setGamblingHidden}>
            <input type="hidden" name="hide" value={gamblingHidden ? 'false' : 'true'} />
            <button className={`rounded-full px-4 py-2 text-sm font-semibold ${gamblingHidden ? 'bg-white ring-1 ring-slate-300' : 'bg-amber-600 text-white'}`}>
              {gamblingHidden ? 'แสดงป้ายพนันอีกครั้ง' : 'ซ่อนป้ายพนันทั้งหมด'}
            </button>
          </form>
        ) : null}
      </section>

      {canEdit ? <BannerForm key={draft.id ?? 'new'} draft={draft} /> : null}

      <section className="space-y-3">
        <h2 className="font-bold">ป้ายทั้งหมด ({rows.length})</h2>
        {list.error ? <p className="text-sm text-red-700">{list.error.message}</p> : null}
        {!rows.length && !list.error ? <p className="text-sm text-slate-500">ยังไม่มีป้าย</p> : null}
        {rows.map((b) => {
          const st = status(b, gamblingHidden, now);
          const c = clickBy.get(b.id);
          return (
            <article key={b.id} className="grid gap-3 rounded-2xl bg-white p-3 ring-1 ring-slate-200 md:grid-cols-[300px_minmax(0,1fr)]">
              {/* eslint-disable-next-line @next/next/no-img-element -- admin thumbnail of our own upload */}
              <img src={b.image_wide_url} alt={b.alt_text} width={BANNER_IMAGES.wide.width} height={BANNER_IMAGES.wide.height} className="h-auto w-full rounded-lg ring-1 ring-slate-200" />
              <div className="min-w-0 space-y-1 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold">#{b.id} {b.name}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${st.tone}`}>{st.label}</span>
                  {b.is_gambling ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900">ป้ายพนัน</span> : null}
                </div>
                <p className="truncate text-slate-600">
                  <a href={b.target_url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                    {b.target_url}
                  </a>
                </p>
                <p className="text-slate-600">
                  {b.slots.map((s) => SLOT_LABEL[s]).join(' · ')} · ลำดับ {b.priority}
                </p>
                <p className="text-slate-600">
                  {dateTimeTH(b.starts_at)} → {b.ends_at ? dateTimeTH(b.ends_at) : 'ไม่มีกำหนด'}
                </p>
                <p>
                  คลิก <b>{Number(c?.total ?? 0).toLocaleString('th-TH')}</b> ครั้ง · 7 วันล่าสุด <b>{Number(c?.last_7d ?? 0).toLocaleString('th-TH')}</b>
                </p>
                {admin.role === 'ADMIN' ? (
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <Link href={`/admin/banners?edit=${b.id}`} className="rounded-full px-3 py-1 ring-1 ring-slate-300 hover:bg-slate-50">
                      แก้
                    </Link>
                    <form action={toggleBanner}>
                      <input type="hidden" name="id" value={b.id} />
                      <input type="hidden" name="is_on" value={b.is_on ? 'false' : 'true'} />
                      <button className="rounded-full px-3 py-1 ring-1 ring-slate-300 hover:bg-slate-50">{b.is_on ? 'ปิด' : 'เปิด'}</button>
                    </form>
                    <form action={deleteBanner}>
                      <input type="hidden" name="id" value={b.id} />
                      <button className="rounded-full px-3 py-1 text-red-700 ring-1 ring-red-200 hover:bg-red-50">ลบ</button>
                    </form>
                  </div>
                ) : null}
              </div>
            </article>
          );
        })}
      </section>
    </div>
  );
}
