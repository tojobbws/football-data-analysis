import 'server-only';

/**
 * TikTok Content Posting API, upload mode, for /admin/social (ADR 0026). The film goes to the TikTok app's inbox as
 * a draft; the owner opens the notification, adds the caption (and TikTok's own sounds if wanted) and posts it there.
 * Upload mode takes no caption and no privacy setting, and it is not locked private like an unaudited Direct Post.
 *
 * Sign-in: the owner signed in once with scripts/tiktok-setup.ts. TikTok returns a new refresh token on every
 * refresh and the old one stops working, so the tokens live in the oauth_tokens table (migration 0064, ADMIN only),
 * not in a Worker secret; the 2-hour access token is kept there too, so polls do not refresh (and rotate) each time.
 * The Worker holds only TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET. No token reaches the browser.
 *
 * TikTok cannot fetch from our R2 links (PULL_FROM_URL wants a verified domain), so the Worker streams the film:
 * GET byte ranges from the private R2 bucket -> PUT each chunk to TikTok's upload_url, never held in memory.
 */

export interface TikTokEnv {
  clientKey: string;
  clientSecret: string;
}

export interface TokenRow {
  refresh_token: string;
  refresh_expires_at: string;
  access_token: string | null;
  access_expires_at: string | null;
}

/** Reads and conditionally replaces the one TIKTOK row of oauth_tokens (as the logged-in ADMIN). */
export interface TokenStore {
  read(): Promise<TokenRow | null>;
  /** writes the refreshed tokens only while the row still holds `previous`; false when another request got there first */
  save(previous: string, next: TokenRow): Promise<boolean>;
}

export class TikTokError extends Error {}

const API = 'https://open.tiktokapis.com';
/** Refresh this long before the access token runs out. */
const EARLY_MS = 5 * 60_000;
const SETUP_HINT = 'รัน scripts/tiktok-setup.ts เพื่อเชื่อมบัญชี TikTok ใหม่';

type TikTokJson = { error?: { code?: string; message?: string; log_id?: string } | string; error_description?: string };
const tiktokError = (what: string, status: number, json: TikTokJson) => {
  const e = json.error;
  const code = typeof e === 'string' ? e : e?.code;
  const text = typeof e === 'string' ? json.error_description ?? '' : e?.message ?? '';
  const hint = TIKTOK_ERROR_TH[code ?? ''];
  return new TikTokError(`TikTok ${what} ${status}: ${code ?? 'unknown error'}${text ? ` ${text}` : ''}${hint ? ` — ${hint}` : ''}`);
};

/** What the owner can do about the errors we expect to meet. */
const TIKTOK_ERROR_TH: Record<string, string> = {
  spam_risk_too_many_pending_share: 'มีร่างค้างใน Inbox ครบ 5 คลิปใน 24 ชม. แล้ว เปิดแอป TikTok โพสต์หรือลบร่างก่อน',
  spam_risk_user_banned_from_posting: 'บัญชีนี้ถูก TikTok ระงับการโพสต์',
  access_token_invalid: SETUP_HINT,
  invalid_grant: `refresh token หมดอายุหรือถูกถอนสิทธิ์ ${SETUP_HINT}`,
  scope_not_authorized: `บัญชีไม่ได้ให้สิทธิ์ video.upload ${SETUP_HINT}`,
  rate_limit_exceeded: 'ส่งถี่เกินไป รอสักครู่แล้วลองใหม่',
  auth_removed: `เจ้าของบัญชีถอนสิทธิ์แอปแล้ว ${SETUP_HINT}`,
};

const live = (at: string | null, now: number) => !!at && Date.parse(at) - EARLY_MS > now;

/** A working access token: the stored one while it lasts, else a refresh (which rotates the refresh token). */
export async function accessToken(env: TikTokEnv, store: TokenStore, now = Date.now()): Promise<string> {
  const row = await store.read();
  if (!row) throw new TikTokError(`ยังไม่ได้เชื่อมบัญชี TikTok — ${SETUP_HINT}`);
  if (row.access_token && live(row.access_expires_at, now)) return row.access_token;
  if (!live(row.refresh_expires_at, now)) throw new TikTokError(`refresh token ของ TikTok หมดอายุแล้ว — ${SETUP_HINT}`);

  const res = await fetch(`${API}/v2/oauth/token/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_key: env.clientKey, client_secret: env.clientSecret, grant_type: 'refresh_token', refresh_token: row.refresh_token }),
  });
  const json = (await res.json().catch(() => ({}))) as TikTokJson & { access_token?: string; expires_in?: number; refresh_token?: string; refresh_expires_in?: number };
  if (!res.ok || !json.access_token || !json.refresh_token) {
    // another request may have refreshed with the same token a moment ago: use what it stored
    const again = await store.read();
    if (again && again.refresh_token !== row.refresh_token && again.access_token && live(again.access_expires_at, Date.now())) return again.access_token;
    throw tiktokError('token', res.status, json);
  }
  const t = Date.now();
  await store.save(row.refresh_token, {
    access_token: json.access_token,
    access_expires_at: new Date(t + (json.expires_in ?? 7200) * 1000).toISOString(),
    refresh_token: json.refresh_token,
    refresh_expires_at: new Date(t + (json.refresh_expires_in ?? 180 * 86400) * 1000).toISOString(),
  });
  return json.access_token;
}

async function api<T>(token: string, what: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as TikTokJson & { data?: T };
  const code = typeof json.error === 'string' ? json.error : json.error?.code;
  if (!res.ok || (code && code !== 'ok') || !json.data) throw tiktokError(what, res.status, json);
  return json.data;
}

/**
 * TikTok's chunk rules (Media Transfer Guide): a film up to 64 MB may go whole (chunk_size = video_size); a bigger film
 * MUST go in several chunks of 5–64 MB, total_chunk_count = floor(video_size / chunk_size), the remainder joining the
 * last chunk (≤ 128 MB). A 64–128 MB film sent as one chunk with chunk_size 64 MB is refused at init with
 * "invalid_params The chunk size is invalid" (2026-11-27), so above CHUNK_MAX we split into CHUNK_SPLIT pieces: always
 * ≥ 2 chunks, the last < 2 × CHUNK_SPLIT. Decimal MB stays inside the limits whether TikTok means 10^6 or 2^20.
 */
export const CHUNK_MAX = 64_000_000;
export const CHUNK_SPLIT = 32_000_000;
export function chunkPlan(bytes: number): { chunkSize: number; count: number; ranges: Array<[number, number]> } {
  const chunkSize = bytes <= CHUNK_MAX ? bytes : CHUNK_SPLIT;
  const count = Math.max(1, Math.floor(bytes / chunkSize));
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) ranges.push([i * chunkSize, i === count - 1 ? bytes - 1 : (i + 1) * chunkSize - 1]);
  return { chunkSize, count, ranges };
}

/**
 * Sends the film at `fileUrl` (a presigned R2 GET link) to the owner's TikTok inbox and returns the publish id.
 * The upload_url lasts an hour; a failure part-way leaves nothing in the inbox and the post can be sent again.
 */
export async function ttUpload(env: TikTokEnv, store: TokenStore, fileUrl: string, bytes: number): Promise<string> {
  const token = await accessToken(env, store);
  const plan = chunkPlan(bytes);
  const init = await api<{ publish_id?: string; upload_url?: string }>(token, 'upload start', '/v2/post/publish/inbox/video/init/', {
    source_info: { source: 'FILE_UPLOAD', video_size: bytes, chunk_size: plan.chunkSize, total_chunk_count: plan.count },
  });
  const upload = init.upload_url ? new URL(init.upload_url) : null;
  if (!init.publish_id || !upload || upload.protocol !== 'https:' || !upload.hostname.endsWith('.tiktokapis.com')) throw new TikTokError('TikTok did not open an upload');

  for (const [first, last] of plan.ranges) {
    const size = last - first + 1;
    const part = await fetch(fileUrl, { headers: { range: `bytes=${first}-${last}` } });
    if (part.status !== 206 && !(part.status === 200 && plan.count === 1)) throw new TikTokError(`อ่านไฟล์จาก R2 ไม่ได้ (HTTP ${part.status})`);
    if (!part.body) throw new TikTokError('อ่านไฟล์จาก R2 ไม่ได้ (ไม่มีข้อมูล)');
    const put = await fetch(upload, {
      method: 'PUT',
      headers: { 'content-type': 'video/mp4', 'content-length': String(size), 'content-range': `bytes ${first}-${last}/${bytes}` },
      body: sized(part.body, size),
      ...({ duplex: 'half' } as object),
    });
    if (put.status !== 201 && put.status !== 206) throw new TikTokError(`TikTok upload ${put.status} ที่ไบต์ ${first}-${last}: ${(await put.text().catch(() => '')).slice(0, 200)}`);
  }
  return init.publish_id;
}

/** A body of known length: on Cloudflare a FixedLengthStream, so the PUT goes with Content-Length, not chunked. */
function sized(body: ReadableStream<Uint8Array>, bytes: number): ReadableStream<Uint8Array> {
  const Fixed = (globalThis as unknown as { FixedLengthStream?: new (n: number) => TransformStream<Uint8Array, Uint8Array> }).FixedLengthStream;
  if (!Fixed) return body;
  const t = new Fixed(bytes);
  void body.pipeTo(t.writable).catch(() => undefined);
  return t.readable;
}

/** fail_reason values TikTok documents, in words the owner can act on. */
const FAIL_TH: Record<string, string> = {
  file_format_check_failed: 'รูปแบบไฟล์ไม่ผ่าน (ใช้ MP4 H.264)',
  duration_check_failed: 'ความยาวคลิปไม่ผ่าน',
  frame_rate_check_failed: 'frame rate ต้องอยู่ระหว่าง 23–60 fps',
  picture_size_check_failed: 'ขนาดภาพต้องด้านละ 360–4096 px',
  internal: 'TikTok ขัดข้องภายใน ลองส่งใหม่ได้',
  publish_cancelled: 'ถูกยกเลิก',
  auth_removed: `เจ้าของบัญชีถอนสิทธิ์แอปแล้ว ${SETUP_HINT}`,
  spam_risk_too_many_posts: 'โพสต์ถี่เกินที่ TikTok ยอมในวันนี้',
  spam_risk_user_banned_from_posting: 'บัญชีนี้ถูก TikTok ระงับการโพสต์',
  spam_risk: 'TikTok มองว่าเสี่ยงสแปม',
  spam_risk_text: 'TikTok มองว่าข้อความเสี่ยงสแปม',
};

export interface InboxState {
  state: 'processing' | 'inbox' | 'posted' | 'error';
  error?: string;
}

/** PROCESSING_UPLOAD -> SEND_TO_USER_INBOX (draft waiting in the app) -> PUBLISH_COMPLETE (owner posted it) | FAILED. */
export async function ttState(env: TikTokEnv, store: TokenStore, publishId: string): Promise<InboxState> {
  const token = await accessToken(env, store);
  const s = await api<{ status?: string; fail_reason?: string }>(token, 'status', '/v2/post/publish/status/fetch/', { publish_id: publishId });
  if (s.status === 'FAILED') return { state: 'error', error: `TikTok FAILED: ${s.fail_reason ?? ''}${s.fail_reason && FAIL_TH[s.fail_reason] ? ` — ${FAIL_TH[s.fail_reason]}` : ''}`.trim() };
  if (s.status === 'SEND_TO_USER_INBOX') return { state: 'inbox' };
  if (s.status === 'PUBLISH_COMPLETE') return { state: 'posted' };
  return { state: 'processing' };
}

/** Note kept on a TikTok post once the draft is in the inbox. */
export const INBOX_NOTE = 'คลิปอยู่ใน Inbox ของแอป TikTok แล้ว เปิดการแจ้งเตือน วางแคปชัน แล้วกดโพสต์ในแอป';
