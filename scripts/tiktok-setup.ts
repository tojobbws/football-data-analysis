/**
 * One-time setup for /admin/social TikTok (ADR 0026): the account owner signs in to TikTok once; this script stores
 * the tokens in the oauth_tokens table (migration 0064) of DATABASE_URL and, with --apply, the two app secrets on the
 * production Worker. TikTok rotates the refresh token on every refresh, so the Worker keeps it in the table from then
 * on. Tokens are never printed in full.
 *
 * Before running (developers.tiktok.com, signed in with the account that will own the app):
 *  1. Manage apps -> Connect an app. App name เข็มทิศฟุตบอล, category Sports/News, description, icon;
 *     Terms of Service https://khemthitfootball.com/terms, Privacy Policy https://khemthitfootball.com/privacy.
 *     Platforms: tick Desktop (and Web with https://khemthitfootball.com if TikTok asks for a website).
 *  2. Add products: Login Kit and Content Posting API. Scopes: user.info.basic, video.upload. Leave Direct Post off.
 *  3. Login Kit -> Desktop redirect URI: http://127.0.0.1:3455/callback/  (or the port in TIKTOK_REDIRECT_PORT).
 *  4. Until TikTok approves the app (Submit for review, with a screen recording of /admin/social), use the Sandbox:
 *     add the channel's TikTok account as a target user, and use the Sandbox client key and secret.
 *  5. Copy the Client key and Client secret.
 *
 * usage (bash, from the repo root; TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET and DATABASE_URL in .env or inline):
 *   npx tsx scripts/tiktok-setup.ts            # sign in, store the tokens in oauth_tokens
 *   npx tsx scripts/tiktok-setup.ts --local    # also write the two app secrets to apps/web/.env.local
 *   npx tsx scripts/tiktok-setup.ts --apply    # also wrangler secret put (production Worker)
 *   npx tsx scripts/tiktok-setup.ts --check    # refresh the stored token once (no sign-in) and show the account
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createPgDb } from '@fp/database';
import { loadDotEnvFile } from '@fp/shared';

loadDotEnvFile();
const SCOPES = ['user.info.basic', 'video.upload'];
const API = 'https://open.tiktokapis.com';
const flag = (k: string) => process.argv.includes(`--${k}`);
const mask = (t: string) => `${t.slice(0, 6)}…${t.slice(-4)} (${t.length} chars)`;

const clientKey = process.env.TIKTOK_CLIENT_KEY, clientSecret = process.env.TIKTOK_CLIENT_SECRET, dbUrl = process.env.DATABASE_URL;
if (!clientKey || !clientSecret || !dbUrl) {
  console.error('set TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET and DATABASE_URL (see the header of this file)');
  process.exit(1);
}
const port = Number(process.env.TIKTOK_REDIRECT_PORT || 3455);
const redirect = `http://127.0.0.1:${port}/callback/`;

interface Tokens { access_token: string; expires_in: number; refresh_token: string; refresh_expires_in: number; open_id?: string; scope?: string }

async function token(params: Record<string, string>): Promise<Tokens> {
  const res = await fetch(`${API}/v2/oauth/token/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_key: clientKey!, client_secret: clientSecret!, ...params }),
  });
  const json = (await res.json()) as Partial<Tokens> & { error?: string; error_description?: string };
  if (!res.ok || !json.access_token || !json.refresh_token) throw new Error(`token: ${json.error ?? res.status} ${json.error_description ?? ''}`);
  return json as Tokens;
}

/** Desktop Login Kit with PKCE (TikTok wants the challenge as HEX of SHA-256, not base64url). */
async function signIn(): Promise<Tokens> {
  const state = randomBytes(16).toString('hex');
  const verifier = randomBytes(48).toString('base64url'); // 64 chars of [A-Za-z0-9-_]
  const challenge = createHash('sha256').update(verifier).digest('hex');
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', redirect);
      if (!u.pathname.startsWith('/callback')) return void res.writeHead(404).end();
      const err = u.searchParams.get('error');
      const got = u.searchParams.get('code');
      const ok = !err && got && u.searchParams.get('state') === state;
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(ok ? 'เรียบร้อย ปิดหน้านี้แล้วกลับไปที่ terminal' : `ไม่สำเร็จ: ${err ?? 'state mismatch'} ${u.searchParams.get('error_description') ?? ''}`);
      server.close();
      if (ok) resolve(got);
      else reject(new Error(`sign-in failed: ${err ?? 'state mismatch'}`));
    });
    server.listen(port, '127.0.0.1', () => {
      const url = new URL('https://www.tiktok.com/v2/auth/authorize/');
      url.search = new URLSearchParams({ client_key: clientKey!, scope: SCOPES.join(','), response_type: 'code', redirect_uri: redirect, state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
      console.log(`\nเปิดลิงก์นี้ใน browser แล้วเข้าสู่ระบบด้วยบัญชี TikTok ของช่อง:\n\n${url}\n`);
    });
  });
  const t = await token({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier });
  const missing = SCOPES.filter((s) => !(t.scope ?? '').split(',').includes(s));
  if (missing.length) throw new Error(`missing scopes: ${missing.join(', ')} — allow every permission on TikTok's screen`);
  return t;
}

const db = createPgDb(dbUrl, { max: 1 });
try {
  let t: Tokens;
  if (flag('check')) {
    const { rows } = await db.query<{ refresh_token: string }>(`select refresh_token from oauth_tokens where provider = 'TIKTOK'`);
    if (!rows[0]) throw new Error('no TIKTOK row in oauth_tokens: run without --check first');
    t = await token({ grant_type: 'refresh_token', refresh_token: rows[0].refresh_token });
  } else {
    t = await signIn();
  }

  const me = await fetch(`${API}/v2/user/info/?fields=open_id,display_name`, { headers: { authorization: `Bearer ${t.access_token}` } });
  const info = (await me.json()) as { data?: { user?: { display_name?: string; open_id?: string } }; error?: { code?: string; message?: string } };
  if (!me.ok || (info.error?.code && info.error.code !== 'ok')) throw new Error(`user/info: ${info.error?.code ?? me.status} ${info.error?.message ?? ''}`);
  const account = info.data?.user?.display_name ?? null;
  const now = Date.now();
  await db.query(
    `insert into oauth_tokens (provider, account, open_id, scope, refresh_token, refresh_expires_at, access_token, access_expires_at, updated_at)
     values ('TIKTOK', $1, $2, $3, $4, $5, $6, $7, now())
     on conflict (provider) do update set account = excluded.account, open_id = excluded.open_id, scope = excluded.scope,
       refresh_token = excluded.refresh_token, refresh_expires_at = excluded.refresh_expires_at,
       access_token = excluded.access_token, access_expires_at = excluded.access_expires_at, updated_at = now()`,
    [account, t.open_id ?? info.data?.user?.open_id ?? null, t.scope ?? null, t.refresh_token, new Date(now + t.refresh_expires_in * 1000), t.access_token, new Date(now + t.expires_in * 1000)],
  );
  console.log(`TikTok account "${account}" · scope ${t.scope}`);
  console.log(`refresh token ${mask(t.refresh_token)} stored in oauth_tokens, valid until ${new Date(now + t.refresh_expires_in * 1000).toISOString()}`);
} finally {
  await db.close();
}

const secrets: Record<string, string> = { TIKTOK_CLIENT_KEY: clientKey, TIKTOK_CLIENT_SECRET: clientSecret };
if (flag('local')) {
  const f = fileURLToPath(new URL('../apps/web/.env.local', import.meta.url));
  let text = existsSync(f) ? readFileSync(f, 'utf8') : '';
  for (const [k, v] of Object.entries(secrets)) text = new RegExp(`^${k}=.*$`, 'm').test(text) ? text.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : `${text.replace(/\n?$/, '\n')}${k}=${v}\n`;
  writeFileSync(f, text);
  console.log(`wrote ${Object.keys(secrets).join(', ')} to apps/web/.env.local`);
}
if (flag('apply')) {
  for (const [k, v] of Object.entries(secrets)) {
    const r = spawnSync('npx', ['wrangler', 'secret', 'put', k], { cwd: fileURLToPath(new URL('../apps/web', import.meta.url)), input: v, stdio: ['pipe', 'inherit', 'inherit'], shell: true });
    if (r.status) throw new Error(`wrangler secret put ${k} failed`);
  }
  console.log(`stored ${Object.keys(secrets).join(', ')} on the production Worker`);
}
if (!flag('local') && !flag('apply') && !flag('check')) console.log('\nrun again with --local and/or --apply to store the app secrets');
