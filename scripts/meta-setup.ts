/**
 * One-time setup for /admin/social (Facebook Reels + Instagram Reels): turns a short-lived user token from the
 * Graph API Explorer into a Page access token that does not expire, finds the Instagram account linked to the
 * Page, checks the permissions, and stores the three secrets. The token is never printed in full.
 *
 * Before running:
 *  1. developers.facebook.com: create an app (type Business), add "Facebook Login for Business" and "Instagram".
 *  2. The Instagram account must be a Professional (Business / Creator) account linked to the Facebook Page.
 *  3. Graph API Explorer: pick the app, "Get User Access Token" with pages_show_list, pages_read_engagement,
 *     pages_manage_posts, instagram_basic, instagram_content_publish, business_management; choose the Page.
 *
 * usage (bash, from the repo root; META_* in .env or inline):
 *   META_APP_ID=... META_APP_SECRET=... META_USER_TOKEN=... npx tsx scripts/meta-setup.ts            # check only
 *   ... npx tsx scripts/meta-setup.ts --page=<page id> --local     # write apps/web/.env.local (for `npm run dev:web`)
 *   ... npx tsx scripts/meta-setup.ts --page=<page id> --apply     # wrangler secret put (production Worker)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadDotEnvFile } from '@fp/shared';

loadDotEnvFile();
const V = process.env.META_GRAPH_VERSION || 'v23.0';
const NEED = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'instagram_basic', 'instagram_content_publish'];
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const flag = (k: string) => process.argv.includes(`--${k}`);
const mask = (t: string) => `${t.slice(0, 6)}…${t.slice(-4)} (${t.length} chars)`;

async function get<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`https://graph.facebook.com/${V}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  const json = (await res.json()) as T & { error?: { message: string } };
  if (json.error) throw new Error(`${path}: ${json.error.message}`);
  return json;
}

const appId = process.env.META_APP_ID, secret = process.env.META_APP_SECRET, userToken = process.env.META_USER_TOKEN;
if (!appId || !secret || !userToken) {
  console.error('set META_APP_ID, META_APP_SECRET and META_USER_TOKEN (see the header of this file)');
  process.exit(1);
}
const appToken = `${appId}|${secret}`;

// 1. a long-lived user token (about 60 days); the Page tokens made from it do not expire
const long = await get<{ access_token: string }>('oauth/access_token', { grant_type: 'fb_exchange_token', client_id: appId, client_secret: secret, fb_exchange_token: userToken });
const dbg = await get<{ data: { scopes?: string[]; is_valid: boolean } }>('debug_token', { input_token: long.access_token, access_token: appToken });
const missing = NEED.filter((s) => !(dbg.data.scopes ?? []).includes(s));
console.log(`user token: valid ${dbg.data.is_valid}, scopes ${(dbg.data.scopes ?? []).join(', ')}`);
if (missing.length) console.log(`MISSING permissions: ${missing.join(', ')} -> get a new token in the Graph API Explorer with them`);

// 2. the Pages this user manages, each with its linked Instagram account
const pages = await get<{ data: Array<{ id: string; name: string; access_token: string; tasks?: string[]; instagram_business_account?: { id: string; username?: string } }> }>(
  'me/accounts', { access_token: long.access_token, fields: 'id,name,access_token,tasks,instagram_business_account{id,username}' });
for (const p of pages.data) console.log(`page ${p.id} "${p.name}" · instagram ${p.instagram_business_account ? `${p.instagram_business_account.id} @${p.instagram_business_account.username ?? '?'}` : 'NOT LINKED'} · tasks ${(p.tasks ?? []).join(',')}`);

const pageId = arg('page');
if (!pageId) {
  console.log('\nrun again with --page=<page id> and --local and/or --apply to store the secrets');
  process.exit(0);
}
const page = pages.data.find((p) => p.id === pageId);
if (!page) throw new Error(`page ${pageId} is not in this user's Pages`);
if (!page.instagram_business_account) throw new Error('this Page has no linked Instagram professional account');
const pdbg = await get<{ data: { expires_at?: number; is_valid: boolean } }>('debug_token', { input_token: page.access_token, access_token: appToken });
console.log(`\npage token ${mask(page.access_token)} · valid ${pdbg.data.is_valid} · ${pdbg.data.expires_at ? `expires ${new Date(pdbg.data.expires_at * 1000).toISOString()}` : 'never expires'}`);
const secrets: Record<string, string> = { META_PAGE_ID: page.id, META_IG_USER_ID: page.instagram_business_account.id, META_PAGE_TOKEN: page.access_token };
// the private R2 bucket the films go through (/admin/social), when set in .env
for (const k of ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) if (process.env[k]) secrets[k] = process.env[k]!;
const r2Missing = ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'].filter((k) => !secrets[k]);
if (r2Missing.length) console.log(`R2 not stored (missing in .env): ${r2Missing.join(', ')}`);

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
