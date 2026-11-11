'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { cancelSocialPost } from './actions';
import {
  CHANNEL_LABEL, SOCIAL_CHANNELS, SOCIAL_FORMATS, STATUS_LABEL, checkCaption, checkVideo, hashtags, isOpen,
  type SocialChannel, type SocialFormat, type SocialStatus, type VideoInfo,
} from '@/lib/social';

const input = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm';
const POLL_MS = 4000;
const POLL_MAX_MS = 15 * 60_000;

/** Starter captions: the owner edits them; numbers and picks are never filled in here. */
const TEMPLATES: Record<SocialFormat, string> = {
  SPOTLIGHT: 'คู่น่าจับตาวันนี้ จากเข็มทิศเกม\nเหตุผลจากข้อมูลจริงทุกคู่ อ่านเต็มที่ khemthitfootball.com\n\nมุมมองจากข้อมูล ไม่ใช่ผลที่แน่นอน\n#วิเคราะห์บอล #เข็มทิศฟุตบอล #ฟุตบอล',
  RECAP: 'สรุปผลงานการทำนายเมื่อวาน ทุกคู่ ถูกและผิด\nผลงานย้อนหลังทั้งหมดดูได้ที่ khemthitfootball.com/performance\n\n#วิเคราะห์บอล #เข็มทิศฟุตบอล #ฟุตบอล',
  INSIGHT: 'ข้อมูลที่เว็บอื่นไม่บอก\n\nทีมของคุณเป็นยังไงบ้าง? คอมเมนต์บอกเรา\nข้อมูลจากผลการแข่งขันจริง · khemthitfootball.com\n#วิเคราะห์บอล #เข็มทิศฟุตบอล #ฟุตบอล',
  OTHER: '\n\nkhemthitfootball.com\n#วิเคราะห์บอล #เข็มทิศฟุตบอล',
};

interface Post { id: number; channel: SocialChannel; status: SocialStatus; sent: number; url?: string | null; error?: string; note?: string }
interface Cover { at: number; blob: Blob; url: string }

/** The film, once, straight into the private R2 bucket by its presigned link (needs the bucket's CORS rule). */
function putFilm(url: string, file: File, onProgress: (sent: number) => void): Promise<string | null> {
  return new Promise((resolve) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    x.setRequestHeader('content-type', file.type || 'video/mp4');
    x.upload.onprogress = (e) => onProgress(e.loaded);
    x.onload = () => resolve(x.status < 300 ? null : `อัปโหลดไป R2 ไม่สำเร็จ (HTTP ${x.status})`);
    x.onerror = () => resolve('อัปโหลดไป R2 ไม่สำเร็จ: เครือข่ายขัดข้อง หรือ bucket ยังไม่ได้ตั้ง CORS ให้เว็บนี้');
    x.send(file);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;

async function call<T>(url: string, init: RequestInit): Promise<{ ok: boolean; body: T & { error?: string } }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, init);
      return { ok: res.ok, body: (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as T & { error?: string } };
    } catch (e) {
      if (attempt >= 2) return { ok: false, body: { error: `เครือข่ายขัดข้อง: ${e instanceof Error ? e.message : e}` } as T & { error?: string } };
      await sleep(1500 * (attempt + 1));
    }
  }
}

export function SocialForm({ ready }: { ready: boolean }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ seconds: number; width: number; height: number } | null>(null);
  const [channels, setChannels] = useState<Record<SocialChannel, boolean>>({ FACEBOOK: true, INSTAGRAM: true });
  const [shareToFeed, setShareToFeed] = useState(true);
  const [format, setFormat] = useState<SocialFormat>('SPOTLIGHT');
  const [title, setTitle] = useState('');
  const [caption, setCaption] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [cover, setCover] = useState<Cover | null>(null);
  const [player, setPlayer] = useState<HTMLVideoElement | null>(null);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  useEffect(() => () => { if (cover) URL.revokeObjectURL(cover.url); }, [cover]);
  useEffect(() => {
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [running]);

  const info: VideoInfo | null = file && meta ? { name: file.name, bytes: file.size, ...meta } : null;
  const checks = useMemo(() => {
    const out = {} as Record<SocialChannel, { errors: string[]; warnings: string[] }>;
    for (const c of SOCIAL_CHANNELS) {
      const v = info ? checkVideo(info, c) : { errors: [], warnings: [] };
      out[c] = { errors: [...v.errors, ...(caption.trim() ? checkCaption(caption, c) : [])], warnings: v.warnings };
    }
    return out;
  }, [info, caption]);
  const chosen = SOCIAL_CHANNELS.filter((c) => channels[c]);
  const blocked = !ready || !info || !caption.trim() || !chosen.length || chosen.some((c) => checks[c].errors.length > 0);

  /** The frame on screen now becomes the cover (Instagram: its time; Facebook: this JPEG). */
  function grab(v: HTMLVideoElement) {
    if (!v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height);
    const at = v.currentTime;
    c.toBlob((b) => b && setCover({ at, blob: b, url: URL.createObjectURL(b) }), 'image/jpeg', 0.9);
  }

  function pick(f: File | null) {
    setPosts([]);
    setError(null);
    setMeta(null);
    setCover(null);
    setFile(f);
    setPreview(f ? URL.createObjectURL(f) : null);
    if (f && !title) setTitle(f.name.replace(/\.(mp4|mov)$/i, ''));
  }

  async function post() {
    if (!file || !info || blocked) return;
    if (!window.confirm(`โพสต์สาธารณะลง ${chosen.map((c) => CHANNEL_LABEL[c]).join(' และ ')} ตอนนี้?\nโพสต์แล้วลบได้จากแอป Facebook / Instagram เท่านั้น`)) return;
    setRunning(true);
    setError(null);
    const start = await call<{ posts: Post[]; putUrl: string }>('/api/admin/social/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, format, caption, channels: chosen, shareToFeed, coverMs: Math.round((cover?.at ?? 0) * 1000), video: info }),
    });
    if (!start.ok) {
      setError(start.body.error ?? 'เริ่มโพสต์ไม่สำเร็จ');
      setRunning(false);
      return;
    }
    const list: Post[] = start.body.posts.map((p) => ({ ...p, sent: 0 }));
    const show = () => setPosts(list.map((p) => ({ ...p })));
    show();
    // one upload for every channel: Meta fetches the film from R2
    const failed = await putFilm(start.body.putUrl, file, (sent) => {
      for (const p of list) p.sent = Math.min(sent, file.size - 1);
      show();
    });
    if (failed) {
      for (const p of list) {
        Object.assign(p, { status: 'FAILED', error: failed });
        const form = new FormData();
        form.append('id', String(p.id));
        await cancelSocialPost(form);
      }
      show();
      setRunning(false);
      router.refresh();
      return;
    }
    for (const p of list) p.sent = file.size;
    show();
    // publish, then follow Meta's processing until each post is live or failed
    await Promise.all(
      list
        .filter((p) => p.status === 'UPLOADING')
        .map(async (p) => {
          const until = Date.now() + POLL_MAX_MS;
          while (Date.now() < until) {
            const r = await call<{ status: SocialStatus; url?: string | null }>('/api/admin/social/finish', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id: p.id }),
            });
            if (!r.ok) {
              Object.assign(p, { status: 'FAILED', error: r.body.error });
              break;
            }
            Object.assign(p, { status: r.body.status, url: r.body.url, error: r.body.error });
            if (p.channel === 'FACEBOOK' && cover && !p.note && (p.status === 'PROCESSING' || p.status === 'PUBLISHED')) {
              const c = await call<{ ok: boolean }>(`/api/admin/social/cover?id=${p.id}`, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: cover.blob });
              p.note = c.ok ? 'ตั้งภาพปกแล้ว' : `ตั้งภาพปกไม่สำเร็จ (โพสต์ยังอยู่ตามปกติ): ${c.body.error}`;
            }
            show();
            if (!isOpen(p.status)) break;
            await sleep(POLL_MS);
          }
          if (isOpen(p.status)) p.error = 'Meta ยังประมวลผลไม่เสร็จใน 15 นาที กดรีเฟรชหน้านี้ภายหลังเพื่อตรวจสถานะ';
          show();
        }),
    );
    setRunning(false);
    router.refresh();
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
      <div className="space-y-3">
        <label className="block text-sm font-semibold">
          ไฟล์วิดีโอ (.mp4 แนวตั้ง 9:16)
          <input type="file" accept="video/mp4,video/quicktime,.mp4,.mov" disabled={running} onChange={(e) => pick(e.target.files?.[0] ?? null)} className="mt-1 block w-full text-sm" />
        </label>
        {preview ? (
          <video
            src={preview}
            controls
            playsInline
            className="aspect-[9/16] w-full rounded-xl bg-black"
            ref={setPlayer}
            onLoadedMetadata={(e) => setMeta({ seconds: e.currentTarget.duration, width: e.currentTarget.videoWidth, height: e.currentTarget.videoHeight })}
            onLoadedData={(e) => { if (!cover) grab(e.currentTarget); }}
          />
        ) : (
          <div className="flex aspect-[9/16] w-full items-center justify-center rounded-xl border-2 border-dashed border-slate-300 text-sm text-slate-400">ตัวอย่างวิดีโอ</div>
        )}
        {preview ? (
          <div className="flex items-start gap-3 rounded-xl border border-slate-200 p-3">
            {cover ? <img src={cover.url} alt="ภาพปก" className="w-20 rounded-lg" /> : <div className="aspect-[9/16] w-20 rounded-lg bg-slate-100" />}
            <div className="space-y-2 text-xs text-slate-600">
              <p>
                <b className="text-slate-800">ภาพปก</b> · วินาทีที่ {(cover?.at ?? 0).toFixed(1)}
              </p>
              <p>ค่าเริ่มต้นคือเฟรมแรก (หน้าปกของคลิป) อยากใช้ภาพอื่นให้เลื่อนวิดีโอไปที่ภาพนั้นแล้วกดปุ่ม</p>
              <button type="button" disabled={running || !player} onClick={() => player && grab(player)} className="rounded-full bg-slate-100 px-3 py-1 font-semibold text-slate-800 hover:bg-slate-200 disabled:opacity-50">
                ใช้เฟรมนี้เป็นปก
              </button>
            </div>
          </div>
        ) : null}
        {info ? (
          <p className="text-xs text-slate-600">
            {Math.round(info.seconds)} วินาที · {info.width}x{info.height} · {mb(info.bytes)}
          </p>
        ) : null}
      </div>

      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            ประเภทคลิป
            <select value={format} disabled={running} onChange={(e) => setFormat(e.target.value as SocialFormat)} className={input}>
              {Object.entries(SOCIAL_FORMATS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            ชื่อในระบบ (ไม่แสดงบนโซเชียล)
            <input value={title} disabled={running} onChange={(e) => setTitle(e.target.value)} className={input} />
          </label>
        </div>

        <label className="block text-sm">
          <span className="flex items-center justify-between">
            แคปชัน (ใช้ร่วมกันทั้งสองช่องทาง)
            <button type="button" disabled={running} onClick={() => setCaption(TEMPLATES[format])} className="rounded-full px-2 py-0.5 text-xs text-sky-700 hover:bg-sky-50">
              ใส่แคปชันตัวอย่าง
            </button>
          </span>
          <textarea value={caption} disabled={running} onChange={(e) => setCaption(e.target.value)} rows={8} className={`${input} leading-relaxed`} />
          <span className="mt-1 block text-xs text-slate-500">
            {[...caption.trim()].length} ตัวอักษร · {hashtags(caption).length} แฮชแท็ก · ห้ามใช้: ทีเด็ด แทง กำไร ตามคู่นี้ การันตี ฟันธง ชัวร์ · ไม่ใส่ราคาหรือตัวเลขที่ไม่มีในคลิป
          </span>
        </label>

        <div className="space-y-2">
          {SOCIAL_CHANNELS.map((c) => (
            <div key={c} className="rounded-xl border border-slate-200 p-3">
              <label className="flex items-center gap-2 text-sm font-semibold">
                <input type="checkbox" checked={channels[c]} disabled={running} onChange={(e) => setChannels({ ...channels, [c]: e.target.checked })} />
                {CHANNEL_LABEL[c]}
                {c === 'INSTAGRAM' ? (
                  <label className="ml-auto flex items-center gap-1 text-xs font-normal text-slate-600">
                    <input type="checkbox" checked={shareToFeed} disabled={running || !channels.INSTAGRAM} onChange={(e) => setShareToFeed(e.target.checked)} />
                    แสดงในฟีดด้วย
                  </label>
                ) : null}
              </label>
              {channels[c] && checks[c].errors.length ? <ul className="mt-1 list-disc pl-6 text-xs text-rose-700">{checks[c].errors.map((e) => <li key={e}>{e}</li>)}</ul> : null}
              {channels[c] && checks[c].warnings.length ? <ul className="mt-1 list-disc pl-6 text-xs text-amber-700">{checks[c].warnings.map((e) => <li key={e}>{e}</li>)}</ul> : null}
            </div>
          ))}
        </div>

        {error ? <p className="whitespace-pre-line rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}
        <button onClick={post} disabled={blocked || running} className="rounded-lg bg-[var(--color-ink)] px-6 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
          {running ? 'กำลังโพสต์… อย่าปิดหน้านี้' : 'โพสต์'}
        </button>

        {posts.length ? (
          <ul className="space-y-2">
            {posts.map((p) => {
              const pct = file ? Math.round((p.sent / file.size) * 100) : 0;
              return (
                <li key={p.id} className="rounded-xl bg-slate-50 p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <b>{CHANNEL_LABEL[p.channel]}</b>
                    <span className={p.status === 'PUBLISHED' ? 'text-emerald-700' : p.status === 'FAILED' ? 'text-rose-700' : 'text-slate-600'}>
                      {STATUS_LABEL[p.status]}{p.status === 'UPLOADING' ? ` ${pct}%` : ''}
                    </span>
                  </div>
                  {p.status === 'UPLOADING' ? (
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200"><div className="h-full bg-[var(--color-ink)] transition-all" style={{ width: `${pct}%` }} /></div>
                  ) : null}
                  {p.url ? <a href={p.url} target="_blank" rel="noreferrer" className="mt-1 block break-all text-xs text-sky-700 underline">{p.url}</a> : null}
                  {p.error ? <p className="mt-1 text-xs text-rose-700">{p.error}</p> : null}
                  {p.note ? <p className={`mt-1 text-xs ${p.note.startsWith('ตั้งภาพปกแล้ว') ? 'text-emerald-700' : 'text-amber-700'}`}>{p.note}</p> : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
