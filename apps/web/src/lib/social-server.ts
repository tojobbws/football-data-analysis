import 'server-only';
import { authClient, currentAdmin, type Admin } from './auth';
import { fbFinish, fbState, fbThumbnail, fbUpload, igCreate, igPublish, igState, socialEnv, type MetaEnv } from './meta';
import { presign, socialKey, type R2Config } from './r2';
import { checkCaption, checkVideo, isOpen, SOCIAL_CHANNELS, SOCIAL_FORMATS, type SocialChannel, type SocialStatus, type VideoInfo } from './social';

/**
 * The server half of /admin/social. The browser puts the film once into the private R2 bucket by a presigned link;
 * then each channel (one social_contents row) has Meta fetch it from a short-lived presigned GET link:
 *   UPLOADING (the browser is sending the film to R2) -> PUBLISHING (one request hands it to Meta)
 *   -> PROCESSING (Meta fetches and encodes) -> PUBLISHED (+ social_publications row) | FAILED (error kept).
 * The R2 object is deleted when no row that uses it is still open (and a 1-day lifecycle rule catches the rest).
 * Writes run as the logged-in admin (RLS 0057: role ADMIN only).
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** How long Meta may take to fetch the film by its link. */
const FETCH_LINK_SECONDS = 2 * 3600;

interface Upload { key?: string; id?: string; coverMs?: number; shareToFeed?: boolean; cover?: boolean }
interface Row { id: number; channel: SocialChannel; caption: string; status: SocialStatus; upload: Upload; video_bytes: number }

/** Admin with role ADMIN, a configured Meta account and R2 bucket, or the Response to send back. */
async function gate(): Promise<{ admin: Admin; meta: MetaEnv; r2: R2Config } | Response> {
  const admin = await currentAdmin();
  if (!admin) return json({ error: 'ต้องเข้าสู่ระบบหลังบ้าน' }, 401);
  if (admin.role !== 'ADMIN') return json({ error: 'เฉพาะ ADMIN โพสต์ได้' }, 403);
  const { meta, r2, missing } = socialEnv();
  if (!meta || !r2) return json({ error: `ยังไม่ได้ตั้งค่า ${missing.join(', ')}` }, 503);
  return { admin, meta, r2 };
}

async function load(id: number): Promise<Row | null> {
  const sb = await authClient();
  const { data } = await sb.from('social_contents').select('id, channel, caption, status, upload, video_bytes').eq('id', id).maybeSingle();
  return data ? ({ ...data, id: Number(data.id), video_bytes: Number(data.video_bytes) } as Row) : null;
}

async function update(id: number, patch: Record<string, unknown>, onlyFrom?: SocialStatus[]): Promise<boolean> {
  const sb = await authClient();
  let q = sb.from('social_contents').update(patch).eq('id', id);
  if (onlyFrom) q = q.in('status', onlyFrom);
  const { data, error } = await q.select('id');
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

const fail = (id: number, e: unknown) => update(id, { status: 'FAILED', error: message(e).slice(0, 1000) });

/** POST /api/admin/social/start: check the draft, make one row per channel, hand back the link to put the film in R2. */
export async function startPost(req: Request): Promise<Response> {
  const g = await gate();
  if (g instanceof Response) return g;
  const b = (await req.json().catch(() => null)) as { title?: string; format?: string; caption?: string; channels?: string[]; shareToFeed?: boolean; coverMs?: number; video?: VideoInfo } | null;
  if (!b || !b.video) return json({ error: 'ข้อมูลไม่ครบ' }, 400);
  const channels = [...new Set(b.channels ?? [])].filter((c): c is SocialChannel => (SOCIAL_CHANNELS as readonly string[]).includes(c));
  const caption = String(b.caption ?? '').trim();
  const format = String(b.format ?? 'OTHER');
  const video: VideoInfo = { name: String(b.video.name ?? ''), bytes: Number(b.video.bytes), seconds: Number(b.video.seconds), width: Number(b.video.width) || 0, height: Number(b.video.height) || 0 };
  const errors: string[] = [];
  if (!channels.length) errors.push('เลือกอย่างน้อยหนึ่งช่องทาง');
  if (!(format in SOCIAL_FORMATS)) errors.push('ประเภทคลิปไม่ถูกต้อง');
  for (const c of channels) errors.push(...checkVideo(video, c).errors.map((e) => `${c}: ${e}`), ...checkCaption(caption, c).map((e) => `${c}: ${e}`));
  if (errors.length) return json({ error: [...new Set(errors)].join('\n') }, 400);
  // the cover frame: inside the film, the first frame (our films open on a cover) when not given
  const coverMs = Math.min(Math.max(0, Math.round(Number(b.coverMs) || 0)), Math.floor(video.seconds * 1000));
  const key = socialKey(video.name);

  const sb = await authClient();
  const posts: Array<{ id: number; channel: SocialChannel; status: SocialStatus }> = [];
  for (const channel of channels) {
    const upload: Upload = { key, coverMs, shareToFeed: b.shareToFeed !== false };
    const { data, error } = await sb
      .from('social_contents')
      .insert({ format, channel, caption, title: String(b.title ?? '').trim() || null, status: 'UPLOADING', upload, video_name: video.name, video_bytes: video.bytes, video_seconds: Math.round(video.seconds * 100) / 100, created_by: g.admin.email })
      .select('id')
      .single();
    if (error || !data) return json({ error: error?.message ?? 'บันทึกไม่สำเร็จ' }, 500);
    posts.push({ id: Number(data.id), channel, status: 'UPLOADING' });
  }
  return json({ posts, putUrl: await presign(g.r2, 'PUT', key, 3600) });
}

/**
 * POST /api/admin/social/finish {id}: after the film is in R2, and again every few seconds until the post is done.
 * The first call checks the film in R2 and hands it to Meta; later calls follow Meta's processing and publish
 * Instagram once it is ready. Conditional status updates let only one request take each step, so a repeated
 * poll can never post twice.
 */
export async function finishPost(req: Request): Promise<Response> {
  const g = await gate();
  if (g instanceof Response) return g;
  const b = (await req.json().catch(() => null)) as { id?: number } | null;
  const id = Number(b?.id);
  const row = await load(id);
  if (!row) return json({ error: 'ไม่พบโพสต์' }, 404);
  const u = row.upload;
  if (isOpen(row.status) && u.key) {
    try {
      if (row.status === 'UPLOADING') {
        if (await update(id, { status: 'PUBLISHING' }, ['UPLOADING'])) {
          const head = await fetch(await presign(g.r2, 'HEAD', u.key, 300), { method: 'HEAD' });
          if (!head.ok || Number(head.headers.get('content-length')) !== row.video_bytes) throw new Error(`ไฟล์ใน R2 ไม่ครบหรือไม่พบ (HTTP ${head.status}, ${head.headers.get('content-length') ?? 0} จาก ${row.video_bytes} ไบต์)`);
          const link = await presign(g.r2, 'GET', u.key, FETCH_LINK_SECONDS);
          if (row.channel === 'FACEBOOK') {
            const videoId = await fbUpload(g.meta, link);
            await update(id, { upload: { ...u, id: videoId } });
            await fbFinish(g.meta, videoId, row.caption);
            await update(id, { status: 'PROCESSING' });
          } else {
            const containerId = await igCreate(g.meta, link, row.caption, u.shareToFeed !== false, u.coverMs ?? 0);
            await update(id, { status: 'PROCESSING', upload: { ...u, id: containerId } });
          }
        }
      } else if (row.status === 'PROCESSING' && u.id) {
        if (row.channel === 'FACEBOOK') {
          const s = await fbState(g.meta, u.id);
          if (s.state === 'error') await fail(id, s.error);
          else if (s.state === 'published' && (await update(id, { status: 'PUBLISHED', error: null }, ['PROCESSING']))) await record(id, 'FACEBOOK', u.id, s.url);
        } else {
          const s = await igState(g.meta, u.id);
          if (s.error) await fail(id, s.error);
          else if (s.code === 'FINISHED' && (await update(id, { status: 'PUBLISHING' }, ['PROCESSING']))) {
            const p = await igPublish(g.meta, u.id);
            await update(id, { status: 'PUBLISHED', error: null });
            await record(id, 'INSTAGRAM', p.mediaId, p.url);
          }
        }
      }
    } catch (e) {
      await fail(id, e);
    }
  }
  const now = await load(id);
  if (now && !isOpen(now.status)) await cleanup(g.r2, now.upload.key);
  const sb = await authClient();
  const { data: pub } = await sb.from('social_publications').select('url').eq('social_content_id', id).maybeSingle();
  const { data: err } = await sb.from('social_contents').select('error').eq('id', id).maybeSingle();
  return json({ status: now?.status, url: pub?.url ?? null, error: now?.status === 'FAILED' ? (err?.error ?? undefined) : undefined });
}

/** Deletes the film from R2 once no row that uses it is still open. Best effort: the lifecycle rule is the backstop. */
async function cleanup(r2: R2Config, key: string | undefined) {
  if (!key) return;
  const sb = await authClient();
  const { data } = await sb.from('social_contents').select('id').eq('upload->>key', key).in('status', ['UPLOADING', 'PUBLISHING', 'PROCESSING']);
  if ((data ?? []).length) return;
  await fetch(await presign(r2, 'DELETE', key, 300), { method: 'DELETE' }).catch(() => undefined);
}

/**
 * PUT /api/admin/social/cover?id=: the chosen frame as a JPEG, set as the Facebook Reel's cover once Meta has the
 * video (Instagram takes the frame time when its container is made). A refusal leaves the post as it is.
 */
export async function setCover(req: Request): Promise<Response> {
  const g = await gate();
  if (g instanceof Response) return g;
  const id = Number(new URL(req.url).searchParams.get('id'));
  const row = await load(id);
  if (!row) return json({ error: 'ไม่พบโพสต์' }, 404);
  if (row.channel !== 'FACEBOOK' || !row.upload.id || !['PROCESSING', 'PUBLISHED'].includes(row.status)) return json({ error: `ตั้งภาพปกตอนสถานะ ${row.status} ไม่ได้` }, 409);
  const bytes = await req.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > 8 * 1048576) return json({ error: 'ภาพปกต้องเป็น JPEG ไม่เกิน 8 MB' }, 400);
  try {
    await fbThumbnail(g.meta, row.upload.id, bytes);
    await update(id, { upload: { ...row.upload, cover: true } });
    return json({ ok: true });
  } catch (e) {
    return json({ error: message(e) }, 502);
  }
}

/** /admin/social "ยกเลิก": a post stuck in an open status becomes FAILED (nothing more is sent to Meta). */
export async function cancelPost(id: number, by: string): Promise<boolean> {
  return update(id, { status: 'FAILED', error: `ยกเลิกโดย ${by}` }, ['UPLOADING', 'PUBLISHING', 'PROCESSING']);
}

async function record(id: number, channel: SocialChannel, externalId: string, url: string | null) {
  const sb = await authClient();
  await sb.from('social_publications').insert({ social_content_id: id, channel, external_id: externalId, url });
}
