import 'server-only';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import type { R2Config } from './r2';

/**
 * Meta Graph API for /admin/social. The film sits in a private R2 bucket (src/lib/r2.ts); Meta fetches it by a
 * short-lived presigned link, so it crosses the network once from the browser and never passes through the Worker.
 * The Page access token stays on the server (Worker secret META_PAGE_TOKEN); it never reaches the browser.
 *
 * Facebook: POST /{page}/video_reels upload_phase=start -> rupload with header file_url -> upload_phase=finish
 *           (video_state=PUBLISHED) -> GET /{video} status until the publishing phase completes.
 * Instagram: POST /{ig-user}/media media_type=REELS video_url=... -> GET /{container} status_code until FINISHED
 *           -> POST /{ig-user}/media_publish.
 * (2026-11-10: Instagram's resumable upload failed every 1080x1920 film over about 30 s, so the film goes by URL.)
 */

export interface MetaEnv {
  pageId: string;
  igUserId: string;
  token: string;
  version: string;
}

const META_KEYS = ['META_PAGE_ID', 'META_IG_USER_ID', 'META_PAGE_TOKEN'];
const R2_KEYS = ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

/** The Meta account and the R2 bucket, or the names of the secrets still missing. */
export function socialEnv(): { meta: MetaEnv | null; r2: R2Config | null; missing: string[] } {
  let src: Record<string, unknown> = process.env;
  try {
    src = { ...process.env, ...(getCloudflareContext().env as unknown as Record<string, unknown>) };
  } catch {
    // not running inside the Cloudflare runtime
  }
  const get = (k: string) => String(src[k] ?? '').trim();
  const missing = [...META_KEYS, ...R2_KEYS].filter((k) => !get(k));
  if (missing.length) return { meta: null, r2: null, missing };
  return {
    meta: { pageId: get('META_PAGE_ID'), igUserId: get('META_IG_USER_ID'), token: get('META_PAGE_TOKEN'), version: get('META_GRAPH_VERSION') || 'v23.0' },
    r2: { accountId: get('R2_ACCOUNT_ID'), bucket: get('R2_BUCKET'), accessKeyId: get('R2_ACCESS_KEY_ID'), secretAccessKey: get('R2_SECRET_ACCESS_KEY') },
    missing,
  };
}

export class MetaError extends Error {}

type MetaJson = { error?: { message?: string; error_user_msg?: string; code?: number } };
const metaError = (status: number, json: MetaJson) =>
  new MetaError(`Meta ${status}: ${json.error?.error_user_msg || json.error?.message || 'unknown error'}${json.error?.code ? ` (code ${json.error.code})` : ''}`);

async function graph<T>(env: MetaEnv, method: 'GET' | 'POST', path: string, params: Record<string, string | number | boolean> = {}): Promise<T> {
  const url = new URL(`https://graph.facebook.com/${env.version}/${path}`);
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) (method === 'GET' ? url.searchParams : body).set(k, String(v));
  const res = await fetch(url, {
    method,
    headers: { authorization: `OAuth ${env.token}`, ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: method === 'POST' ? body : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as MetaJson & T;
  if (!res.ok || json.error) throw metaError(res.status, json);
  return json;
}

// ---------- Facebook Page Reels ----------
/** Opens a Reel upload and has Meta fetch the film from `fileUrl`. Returns the video id. */
export async function fbUpload(env: MetaEnv, fileUrl: string): Promise<string> {
  const s = await graph<{ video_id: string; upload_url?: string }>(env, 'POST', `${env.pageId}/video_reels`, { upload_phase: 'start' });
  const uploadUrl = s.upload_url || `https://rupload.facebook.com/video-upload/${env.version}/${s.video_id}`;
  if (!uploadUrl.startsWith('https://rupload.facebook.com/')) throw new MetaError('unexpected upload address');
  const res = await fetch(uploadUrl, { method: 'POST', headers: { authorization: `OAuth ${env.token}`, file_url: fileUrl } });
  const text = await res.text();
  if (!res.ok) throw new MetaError(`Facebook upload ${res.status}: ${text.slice(0, 300)}`);
  return s.video_id;
}

export async function fbFinish(env: MetaEnv, videoId: string, description: string): Promise<void> {
  await graph(env, 'POST', `${env.pageId}/video_reels`, { upload_phase: 'finish', video_id: videoId, video_state: 'PUBLISHED', description });
}

/** The Reel's cover: a JPEG made from the chosen frame, set as the preferred thumbnail of the video. */
export async function fbThumbnail(env: MetaEnv, videoId: string, jpeg: ArrayBuffer): Promise<void> {
  const form = new FormData();
  form.append('source', new Blob([jpeg], { type: 'image/jpeg' }), 'cover.jpg');
  form.append('is_preferred', 'true');
  const res = await fetch(`https://graph.facebook.com/${env.version}/${videoId}/thumbnails`, { method: 'POST', headers: { authorization: `OAuth ${env.token}` }, body: form });
  const json = (await res.json().catch(() => ({}))) as MetaJson;
  if (!res.ok || json.error) throw metaError(res.status, json);
}

interface Phase { status?: string; errors?: Array<{ message?: string }> }
export async function fbState(env: MetaEnv, videoId: string): Promise<{ state: 'processing' | 'published' | 'error'; url: string | null; error?: string }> {
  const r = await graph<{ status?: { video_status?: string; uploading_phase?: Phase; processing_phase?: Phase; publishing_phase?: Phase & { publish_status?: string } }; permalink_url?: string }>(
    env, 'GET', videoId, { fields: 'status,permalink_url' });
  const s = r.status ?? {};
  const url = r.permalink_url ? (r.permalink_url.startsWith('http') ? r.permalink_url : `https://www.facebook.com${r.permalink_url}`) : null;
  const failed = [s.uploading_phase, s.processing_phase, s.publishing_phase].find((p) => p?.status === 'error');
  if (s.video_status === 'error' || failed) return { state: 'error', url, error: failed?.errors?.map((e) => e.message).join('; ') || 'Facebook could not process the video' };
  if (s.publishing_phase?.status === 'complete') return { state: 'published', url };
  return { state: 'processing', url };
}

// ---------- Instagram Reels ----------
/** A Reel container that Meta fills from `videoUrl`; `coverMs` = the frame (ms into the film) shown as the cover. */
export async function igCreate(env: MetaEnv, videoUrl: string, caption: string, shareToFeed: boolean, coverMs: number): Promise<string> {
  const r = await graph<{ id: string }>(env, 'POST', `${env.igUserId}/media`, { media_type: 'REELS', video_url: videoUrl, caption, share_to_feed: shareToFeed, thumb_offset: coverMs });
  return r.id;
}

/** FINISHED (ready to publish), IN_PROGRESS, ERROR, EXPIRED or PUBLISHED. */
export async function igState(env: MetaEnv, containerId: string): Promise<{ code: string; error?: string }> {
  const r = await graph<{ status_code?: string; status?: string }>(env, 'GET', containerId, { fields: 'status_code,status' });
  return { code: r.status_code ?? 'IN_PROGRESS', error: r.status_code === 'ERROR' || r.status_code === 'EXPIRED' ? r.status || r.status_code : undefined };
}

export async function igPublish(env: MetaEnv, containerId: string): Promise<{ mediaId: string; url: string | null }> {
  const r = await graph<{ id: string }>(env, 'POST', `${env.igUserId}/media_publish`, { creation_id: containerId });
  const p = await graph<{ permalink?: string }>(env, 'GET', r.id, { fields: 'permalink' }).catch(() => ({ permalink: undefined }));
  return { mediaId: r.id, url: p.permalink ?? null };
}
