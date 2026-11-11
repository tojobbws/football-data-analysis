/**
 * Presigned URLs for a private Cloudflare R2 bucket (S3 API, AWS Signature V4 in the query string). /admin/social
 * puts each film here once (the browser uploads straight to R2), Meta fetches it by a short-lived GET link, and the
 * object is deleted after posting. Web Crypto only, so it runs on Cloudflare and under Node alike.
 */

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (s: string) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
async function hmac(key: BufferSource, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(msg));
}
/** RFC 3986 encoding, as SigV4 wants it. */
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * A URL that allows one `method` on `key` for `expiresSeconds` (max 7 days), signed for the `host` header only, so
 * the caller may send any body and content type.
 */
export async function presign(cfg: R2Config, method: 'GET' | 'PUT' | 'DELETE' | 'HEAD', key: string, expiresSeconds = 3600, now = new Date()): Promise<string> {
  const host = `${cfg.accountId}.r2.cloudflarestorage.com`;
  const path = `/${rfc3986(cfg.bucket)}/${key.split('/').map(rfc3986).join('/')}`;
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // YYYYMMDDTHHMMSSZ
  const day = amzDate.slice(0, 8);
  const scope = `${day}/auto/s3/aws4_request`;
  const params: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${cfg.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(Math.min(Math.max(1, Math.round(expiresSeconds)), 604800)),
    'X-Amz-SignedHeaders': 'host',
  };
  const query = Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`).join('&');
  const canonical = [method, path, query, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256(canonical)].join('\n');
  let k = await hmac(enc.encode(`AWS4${cfg.secretAccessKey}`), day);
  for (const part of ['auto', 's3', 'aws4_request']) k = await hmac(k, part);
  const signature = hex(await hmac(k, toSign));
  return `https://${host}${path}?${query}&X-Amz-Signature=${signature}`;
}

/** Where a film for a social post lives in the bucket: unguessable, grouped by day. */
export function socialKey(fileName: string, now = new Date()): string {
  const ext = /\.mov$/i.test(fileName) ? 'mov' : 'mp4';
  return `social/${now.toISOString().slice(0, 10)}/${crypto.randomUUID()}.${ext}`;
}
