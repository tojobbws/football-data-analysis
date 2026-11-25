/**
 * One-time setup for /admin/social YouTube Shorts: the channel owner signs in with Google once, this script keeps
 * the refresh token, checks which channel it posts to, and stores the three secrets. Tokens are never printed in full.
 *
 * Before running (console.cloud.google.com, signed in as the channel owner or a project the owner can use):
 *  1. A project -> APIs & Services -> enable "YouTube Data API v3".
 *  2. OAuth consent screen (Google Auth Platform): External, app name เข็มทิศฟุตบอล, homepage
 *     https://khemthitfootball.com, privacy https://khemthitfootball.com/privacy, terms .../terms;
 *     scopes youtube.upload + youtube.readonly. Then press "Publish app" (In production): a Testing app's refresh
 *     token dies after 7 days. Unverified is fine for our own account (Google shows a warning screen once).
 *  3. Credentials -> Create OAuth client ID -> type "Desktop app" -> copy the client id and secret.
 *  4. Uploads stay locked private until YouTube audits the project: YouTube API Services "Audit and Quota Extension"
 *     form (see docs/adr/0025-youtube-shorts-posting.md).
 *
 * usage (bash, from the repo root; YT_CLIENT_ID / YT_CLIENT_SECRET in .env or inline):
 *   YT_CLIENT_ID=... YT_CLIENT_SECRET=... npx tsx scripts/youtube-setup.ts            # sign in + check only
 *   ... npx tsx scripts/youtube-setup.ts --local     # also write apps/web/.env.local (for `npm run dev:web`)
 *   ... npx tsx scripts/youtube-setup.ts --apply     # also wrangler secret put (production Worker)
 *   YT_REFRESH_TOKEN=... npx tsx scripts/youtube-setup.ts --check   # test a stored token without signing in
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { loadDotEnvFile } from '@fp/shared';

loadDotEnvFile();
const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];
const flag = (k: string) => process.argv.includes(`--${k}`);
const mask = (t: string) => `${t.slice(0, 6)}…${t.slice(-4)} (${t.length} chars)`;

const clientId = process.env.YT_CLIENT_ID, clientSecret = process.env.YT_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('set YT_CLIENT_ID and YT_CLIENT_SECRET (see the header of this file)');
  process.exit(1);
}

async function token(params: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; scope?: string }> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId!, client_secret: clientSecret!, ...params }),
  });
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; scope?: string; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) throw new Error(`token: ${json.error ?? res.status} ${json.error_description ?? ''}`);
  return json as { access_token: string; refresh_token?: string; scope?: string };
}

/** Opens Google's sign-in, waits for the redirect on a loopback port, returns the refresh token. */
async function signIn(): Promise<string> {
  const state = randomBytes(16).toString('hex');
  let redirect = '';
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', redirect);
      if (u.pathname !== '/callback') return void res.writeHead(404).end();
      const err = u.searchParams.get('error');
      const got = u.searchParams.get('code');
      const ok = !err && got && u.searchParams.get('state') === state;
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(ok ? 'เรียบร้อย ปิดหน้านี้แล้วกลับไปที่ terminal' : `ไม่สำเร็จ: ${err ?? 'state mismatch'}`);
      server.close();
      if (ok) resolve(got);
      else reject(new Error(`sign-in failed: ${err ?? 'state mismatch'}`));
    });
    server.listen(0, '127.0.0.1', () => {
      redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({ client_id: clientId!, redirect_uri: redirect, response_type: 'code', scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', state }).toString();
      console.log(`\nเปิดลิงก์นี้ใน browser แล้วเข้าสู่ระบบด้วยบัญชี Google ที่เป็นเจ้าของช่อง YouTube:\n\n${url}\n`);
    });
  });
  const t = await token({ grant_type: 'authorization_code', code, redirect_uri: redirect });
  if (!t.refresh_token) throw new Error('Google did not return a refresh token (remove the app at myaccount.google.com/permissions and run again)');
  const missing = SCOPES.filter((s) => !(t.scope ?? '').split(' ').includes(s));
  if (missing.length) throw new Error(`missing scopes: ${missing.join(', ')} — tick every box on the consent screen`);
  return t.refresh_token;
}

const refresh = flag('check') ? process.env.YT_REFRESH_TOKEN : await signIn();
if (!refresh) throw new Error('--check needs YT_REFRESH_TOKEN');

// the channel this token posts to
const { access_token } = await token({ grant_type: 'refresh_token', refresh_token: refresh });
const res = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet,status&mine=true', { headers: { authorization: `Bearer ${access_token}` } });
const ch = (await res.json()) as { items?: Array<{ id: string; snippet?: { title?: string; customUrl?: string }; status?: { longUploadsStatus?: string } }>; error?: { message?: string } };
if (!res.ok) throw new Error(`channels: ${ch.error?.message ?? res.status}`);
if (!ch.items?.length) throw new Error('this Google account has no YouTube channel');
for (const c of ch.items) console.log(`channel ${c.id} "${c.snippet?.title}" ${c.snippet?.customUrl ?? ''}`);
console.log(`refresh token ${mask(refresh)}`);

const secrets: Record<string, string> = { YT_CLIENT_ID: clientId, YT_CLIENT_SECRET: clientSecret, YT_REFRESH_TOKEN: refresh };
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
if (!flag('local') && !flag('apply')) console.log('\nrun again with --local and/or --apply to store the secrets');
