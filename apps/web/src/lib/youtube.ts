import 'server-only';
import type { YtPrivacy } from './social';

/**
 * YouTube Data API v3 for /admin/social (YouTube Shorts). The channel owner signed in once with
 * scripts/youtube-setup.ts; the Worker keeps only the refresh token (secret YT_REFRESH_TOKEN) and trades it for a
 * one-hour access token per request, so no token reaches the browser.
 *
 * YouTube cannot fetch a film by URL the way Meta does, so the Worker streams it: GET from the private R2 bucket
 * -> PUT into a resumable upload session, without holding it in memory (FixedLengthStream keeps the length).
 * A vertical or square video up to 3 minutes is shown as a Short; nothing else marks it.
 *
 * An API project YouTube has not audited gets every upload locked private (YouTube API Services audit), whatever
 * privacyStatus asks for; ytState reports the privacy YouTube actually gave.
 */

export interface YouTubeEnv {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export class YouTubeError extends Error {}

type GoogleJson = { error?: { message?: string; errors?: Array<{ reason?: string }> } | string; error_description?: string };
const googleError = (what: string, status: number, json: GoogleJson) => {
  const e = json.error;
  const text = typeof e === 'string' ? `${e}${json.error_description ? `: ${json.error_description}` : ''}` : `${e?.message ?? 'unknown error'}${e?.errors?.[0]?.reason ? ` (${e.errors[0].reason})` : ''}`;
  return new YouTubeError(`YouTube ${what} ${status}: ${text}`);
};

/** A one-hour access token from the stored refresh token. */
export async function accessToken(env: YouTubeEnv): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: env.clientId, client_secret: env.clientSecret, refresh_token: env.refreshToken }),
  });
  const json = (await res.json().catch(() => ({}))) as GoogleJson & { access_token?: string };
  if (!res.ok || !json.access_token) {
    const err = googleError('token', res.status, json);
    if (typeof json.error === 'string' && json.error === 'invalid_grant') err.message += ' — refresh token หมดอายุหรือถูกถอนสิทธิ์ รัน scripts/youtube-setup.ts ใหม่';
    throw err;
  }
  return json.access_token;
}

export interface ShortMeta {
  title: string;
  description: string;
  privacy: YtPrivacy;
}

/**
 * Uploads the film at `fileUrl` (a presigned R2 GET link) as a new video and returns its id. One resumable session,
 * one PUT with the whole film; a failure leaves nothing on the channel.
 */
export async function ytUpload(env: YouTubeEnv, fileUrl: string, bytes: number, meta: ShortMeta): Promise<string> {
  const token = await accessToken(env);
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-length': String(bytes),
      'x-upload-content-type': 'video/mp4',
    },
    body: JSON.stringify({
      snippet: { title: meta.title, description: meta.description, categoryId: '17', defaultLanguage: 'th', defaultAudioLanguage: 'th' }, // 17 = Sports
      status: { privacyStatus: meta.privacy, selfDeclaredMadeForKids: false, embeddable: true },
    }),
  });
  if (!init.ok) throw googleError('upload start', init.status, (await init.json().catch(() => ({}))) as GoogleJson);
  const session = init.headers.get('location');
  if (!session?.startsWith('https://www.googleapis.com/upload/youtube/')) throw new YouTubeError('YouTube did not open an upload session');

  const film = await fetch(fileUrl);
  if (!film.ok || !film.body) throw new YouTubeError(`อ่านไฟล์จาก R2 ไม่ได้ (HTTP ${film.status})`);
  const put = await fetch(session, {
    method: 'PUT',
    headers: { 'content-type': 'video/mp4', 'content-length': String(bytes) },
    body: sized(film.body, bytes),
    // Node's fetch needs this for a stream body; the Workers runtime ignores it
    ...({ duplex: 'half' } as object),
  });
  const json = (await put.json().catch(() => ({}))) as GoogleJson & { id?: string };
  if (!put.ok || !json.id) throw googleError('upload', put.status, json);
  return json.id;
}

/** A body of known length: on Cloudflare a FixedLengthStream, so the PUT is sent with Content-Length, not chunked. */
function sized(body: ReadableStream<Uint8Array>, bytes: number): ReadableStream<Uint8Array> {
  const Fixed = (globalThis as unknown as { FixedLengthStream?: new (n: number) => TransformStream<Uint8Array, Uint8Array> }).FixedLengthStream;
  if (!Fixed) return body;
  const t = new Fixed(bytes);
  void body.pipeTo(t.writable).catch(() => undefined);
  return t.readable;
}

export interface ShortState {
  state: 'processing' | 'published' | 'error';
  /** the privacy YouTube gave the video (private when the API project is not audited yet) */
  privacy: string | null;
  error?: string;
}

/** uploaded -> processed (live) | failed | rejected | deleted. */
export async function ytState(env: YouTubeEnv, videoId: string): Promise<ShortState> {
  const token = await accessToken(env);
  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', 'status');
  url.searchParams.set('id', videoId);
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const json = (await res.json().catch(() => ({}))) as GoogleJson & {
    items?: Array<{ status?: { uploadStatus?: string; privacyStatus?: string; failureReason?: string; rejectionReason?: string } }>;
  };
  if (!res.ok) throw googleError('status', res.status, json);
  const s = json.items?.[0]?.status;
  if (!s) return { state: 'error', privacy: null, error: 'ไม่พบวิดีโอบน YouTube (ถูกลบไปแล้ว?)' };
  if (s.uploadStatus === 'processed') return { state: 'published', privacy: s.privacyStatus ?? null };
  if (s.uploadStatus === 'failed' || s.uploadStatus === 'rejected' || s.uploadStatus === 'deleted')
    return { state: 'error', privacy: s.privacyStatus ?? null, error: `YouTube ${s.uploadStatus}: ${s.failureReason ?? s.rejectionReason ?? ''}`.trim() };
  return { state: 'processing', privacy: s.privacyStatus ?? null };
}

export const shortUrl = (videoId: string) => `https://www.youtube.com/shorts/${videoId}`;
