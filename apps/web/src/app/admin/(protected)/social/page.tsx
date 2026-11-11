import { Section } from '@/components/ui';
import { authClient, requireAdmin } from '@/lib/auth';
import { socialEnv } from '@/lib/meta';
import { CHANNEL_LABEL, SOCIAL_FORMATS, STATUS_LABEL, isOpen, type SocialChannel, type SocialFormat, type SocialStatus } from '@/lib/social';
import { dateTimeTH } from '@/lib/time';
import { cancelSocialPost } from './actions';
import { SocialForm } from './social-form';

export const dynamic = 'force-dynamic';

interface Row {
  id: number;
  created_at: string;
  format: string;
  channel: SocialChannel;
  title: string | null;
  status: SocialStatus;
  error: string | null;
  video_seconds: number | null;
  created_by: string | null;
  social_publications: Array<{ url: string | null }>;
}

/**
 * Post a finished film as a Facebook Reel and an Instagram Reel. The owner picks the file, watches it,
 * writes the caption and presses post; nothing is posted on a schedule or without that press.
 */
export default async function AdminSocial() {
  const admin = await requireAdmin();
  const { missing } = socialEnv();
  const sb = await authClient();
  const history = await sb
    .from('social_contents')
    .select('id, created_at, format, channel, title, status, error, video_seconds, created_by, social_publications(url)')
    .order('created_at', { ascending: false })
    .limit(60);
  const rows = (history.data ?? []) as unknown as Row[];
  const canPost = admin.role === 'ADMIN' && !missing.length && !history.error;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-bold">โพสต์ Reels (Facebook · Instagram)</h1>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-600">
          เลือกไฟล์วิดีโอที่ render แล้ว ดูตัวอย่างให้ครบ เขียนแคปชัน แล้วกดโพสต์ ไฟล์ขึ้นที่เก็บชั่วคราว (R2) ครั้งเดียว ให้ Facebook และ Instagram ดึงไป แล้วลบทิ้งเมื่อโพสต์เสร็จ ลิงก์โพสต์บันทึกไว้ด้านล่าง
          Facebook Reels รับคลิป 3–90 วินาที Instagram Reels รับได้ถึง 15 นาที
        </p>
      </header>
      {admin.role !== 'ADMIN' ? <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">บัญชี {admin.role} ดูประวัติได้ แต่โพสต์ได้เฉพาะ ADMIN</p> : null}
      {missing.length ? (
        <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">
          ยังไม่ได้ตั้งค่า secret: <code>{missing.join(', ')}</code> (Meta: <code>scripts/meta-setup.ts</code> · R2: bucket ส่วนตัว + API token)
        </p>
      ) : null}
      {history.error ? <p className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">อ่านประวัติไม่ได้: {history.error.message} (รัน migration 0057 แล้วหรือยัง?)</p> : null}

      <Section title="โพสต์ใหม่">
        <SocialForm ready={canPost} />
      </Section>

      <Section title="ประวัติการโพสต์" aside={`${rows.length} รายการล่าสุด`}>
        {rows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-slate-500">
                <tr>
                  <th className="py-2 pr-3">เวลา</th>
                  <th className="pr-3">ช่องทาง</th>
                  <th className="pr-3">ประเภท</th>
                  <th className="pr-3">ชื่อ</th>
                  <th className="pr-3">สถานะ</th>
                  <th>ลิงก์</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => {
                  const url = r.social_publications?.[0]?.url;
                  return (
                    <tr key={r.id} className="align-top">
                      <td className="whitespace-nowrap py-2 pr-3 text-xs text-slate-600">{dateTimeTH(r.created_at)}</td>
                      <td className="pr-3">{CHANNEL_LABEL[r.channel] ?? r.channel}</td>
                      <td className="pr-3 text-xs">{SOCIAL_FORMATS[r.format as SocialFormat] ?? r.format}</td>
                      <td className="pr-3 text-xs">
                        {r.title ?? '—'}
                        {r.video_seconds ? <span className="text-slate-400"> · {Math.round(Number(r.video_seconds))} วิ</span> : null}
                      </td>
                      <td className="pr-3 text-xs">
                        <span className={r.status === 'PUBLISHED' ? 'text-emerald-700' : r.status === 'FAILED' ? 'text-rose-700' : 'text-slate-600'}>{STATUS_LABEL[r.status] ?? r.status}</span>
                        {r.error ? <span className="block max-w-xs text-rose-600">{r.error}</span> : null}
                        {admin.role === 'ADMIN' && isOpen(r.status) ? (
                          <form action={cancelSocialPost} className="mt-1">
                            <input type="hidden" name="id" value={r.id} />
                            <button className="rounded-full px-2 py-0.5 text-rose-700 hover:bg-rose-50">ยกเลิก (ถ้าค้าง)</button>
                          </form>
                        ) : null}
                      </td>
                      <td className="text-xs">{url ? <a href={url} target="_blank" rel="noreferrer" className="text-sky-700 underline">เปิดโพสต์</a> : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-slate-500">ยังไม่มีโพสต์</p>
        )}
      </Section>
    </div>
  );
}
