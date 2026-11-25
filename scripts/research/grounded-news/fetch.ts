/**
 * Grounded news, Phase 0: discovery and the article reader (.scratch/grounded-news/spec.md §4).
 *
 * Discovery: Bing News RSS, whose items carry the publisher's URL (the `url` parameter of the click link) and a pubDate.
 * Google News RSS items only carry an encoded news.google.com link; turning it into the publisher's URL needs an
 * internal Google endpoint, which this dry run does not call. Google's team-news titles are instead looked up on Bing
 * News by exact title (bridgeGoogleTitles); Google links are never followed.
 *
 * Every page is read by our own reader: final URL, paragraphs, the page's own timestamps. robots.txt is honoured
 * (User-agent: * group), one request at a time per host with a gap, a timeout and a size cap.
 */
import { createHash } from 'node:crypto';
import { canonicalUrl, decodeEntities, domainOf, parseDate } from './rules.js';

export type NewsFetcherId = 'bing-news-rss' | 'google-news-rss';

export interface FixtureTeamQuery {
  teamName: string;
  /** Bing market, e.g. pt-BR */
  market: string;
  /** a word for "injury" in the league's language */
  injuryWord: string;
}

export interface NewsCandidate {
  url: string;
  canonical: string;
  title: string;
  sourceName: string;
  sourceDomain: string;
  feedPublishedAt: Date | null;
  discoveredVia: NewsFetcherId;
  query: string;
}

export interface NewsFetcher {
  readonly id: NewsFetcherId;
  discover(q: FixtureTeamQuery): Promise<{ candidates: NewsCandidate[]; queries: string[]; errors: string[] }>;
}

export const USER_AGENT = process.env.NEWS_USER_AGENT ?? 'Mozilla/5.0 (compatible; FootballNewsResearch/0.1; dry run)';
const TIMEOUT_MS = 12_000;
const MAX_BYTES = 3_000_000;
const HOST_GAP_MS = 400;

// ---------------------------------------------------------------- polite HTTP

const hostQueue = new Map<string, Promise<unknown>>();

/** One request at a time per host, HOST_GAP_MS apart. */
async function perHost<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const host = domainOf(url);
  const prev = hostQueue.get(host) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(async () => {
    try {
      return await fn();
    } finally {
      await new Promise((r) => setTimeout(r, HOST_GAP_MS));
    }
  });
  hostQueue.set(host, next);
  return next;
}

export async function httpGet(url: string): Promise<{ status: number; finalUrl: string; body: string; contentType: string }> {
  return perHost(url, async () => {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,application/rss+xml,application/xml;q=0.9,*/*;q=0.5' } });
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader)
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) {
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
    return { status: res.status, finalUrl: res.url || url, body: Buffer.concat(chunks).toString('utf8'), contentType: res.headers.get('content-type') ?? '' };
  });
}

// ---------------------------------------------------------------- robots.txt

const robotsCache = new Map<string, Promise<RobotsRule[]>>();

export interface RobotsRule {
  allow: boolean;
  pattern: string;
}

/** Allow / Disallow rules of the `User-agent: *` group (Phase 0 sends a generic agent, so only * applies). */
export function parseRobots(txt: string): RobotsRule[] {
  const rules: RobotsRule[] = [];
  let inStar = false;
  let sawRule = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const val = m[2]!.trim();
    if (key === 'user-agent') {
      if (sawRule) {
        inStar = false;
        sawRule = false;
      }
      if (val === '*') inStar = true;
    } else {
      sawRule = true;
      if (inStar && (key === 'disallow' || key === 'allow') && val) rules.push({ allow: key === 'allow', pattern: val });
    }
  }
  return rules;
}

/** `*` matches any run of characters, a final `$` anchors the end; otherwise a prefix match. */
const robotsRegex = (pattern: string) => new RegExp(`^${pattern.replace(/\$$/, '').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}${pattern.endsWith('$') ? '$' : ''}`);

/** RFC 9309: the most specific (longest) matching rule decides; Allow wins a tie; no match = allowed. */
export function robotsAllows(rules: readonly RobotsRule[], path: string): boolean {
  let best: RobotsRule | null = null;
  for (const r of rules) {
    if (!robotsRegex(r.pattern).test(path)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

async function allowedByRobots(url: string): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const origin = u.origin;
  if (!robotsCache.has(origin))
    robotsCache.set(
      origin,
      httpGet(`${origin}/robots.txt`)
        .then((r) => (r.status >= 200 && r.status < 300 ? parseRobots(r.body) : []))
        .catch(() => []),
    );
  return robotsAllows(await robotsCache.get(origin)!, u.pathname + u.search);
}

// ---------------------------------------------------------------- RSS

const tag = (xml: string, name: string) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeEntities(m[1]!.replace(/^<!\[CDATA\[|\]\]>$/g, '')).trim() : null;
};

export function parseRssItems(xml: string): Array<{ title: string; link: string; pubDate: Date | null; source: string | null; sourceUrl: string | null }> {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => {
    const it = m[1]!;
    const sourceUrl = it.match(/<source[^>]*url="([^"]+)"/i)?.[1] ?? null;
    return { title: tag(it, 'title') ?? '', link: tag(it, 'link') ?? '', pubDate: parseDate(tag(it, 'pubDate')), source: tag(it, 'News:Source') ?? tag(it, 'source'), sourceUrl };
  });
}

/** the publisher's URL inside a Bing click link (…/apiclick.aspx?…&url=<encoded>), or the link itself */
export function bingTargetUrl(link: string): string {
  try {
    const u = new URL(link);
    const target = u.searchParams.get('url');
    return target && /^https?:\/\//i.test(target) ? target : link;
  } catch {
    return link;
  }
}

/** Bing News RSS, past week, in the league's market: the team alone, then the team with the local word for injury. */
export const bingNewsRss: NewsFetcher = {
  id: 'bing-news-rss',
  async discover(q) {
    const queries = [`"${q.teamName}"`, `"${q.teamName}" ${q.injuryWord}`];
    const candidates: NewsCandidate[] = [];
    const errors: string[] = [];
    for (const query of queries) {
      const url = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&mkt=${encodeURIComponent(q.market)}&qft=${encodeURIComponent('interval="8"')}`;
      try {
        const r = await httpGet(url);
        if (r.status !== 200) {
          errors.push(`bing ${r.status} for ${query}`);
          continue;
        }
        for (const it of parseRssItems(r.body)) {
          const target = bingTargetUrl(it.link);
          if (!/^https?:\/\//i.test(target)) continue;
          candidates.push({
            url: target,
            canonical: canonicalUrl(target),
            title: it.title,
            sourceName: it.source ?? domainOf(target),
            sourceDomain: domainOf(target),
            feedPublishedAt: it.pubDate,
            discoveredVia: 'bing-news-rss',
            query,
          });
        }
      } catch (err) {
        errors.push(`bing error for ${query}: ${String(err).slice(0, 120)}`);
      }
    }
    return { candidates, queries, errors };
  },
};

const GOOGLE_EDITION: Record<string, { hl: string; gl: string; ceid: string }> = {
  'pt-BR': { hl: 'pt-BR', gl: 'BR', ceid: 'BR:pt-419' },
  'pt-PT': { hl: 'pt-PT', gl: 'PT', ceid: 'PT:pt-150' },
  'es-ES': { hl: 'es', gl: 'ES', ceid: 'ES:es' },
  'es-AR': { hl: 'es-419', gl: 'AR', ceid: 'AR:es-419' },
  'es-MX': { hl: 'es-419', gl: 'MX', ceid: 'MX:es-419' },
  'it-IT': { hl: 'it', gl: 'IT', ceid: 'IT:it' },
  'de-DE': { hl: 'de', gl: 'DE', ceid: 'DE:de' },
  'fr-FR': { hl: 'fr', gl: 'FR', ceid: 'FR:fr' },
  'nl-NL': { hl: 'nl', gl: 'NL', ceid: 'NL:nl' },
  'ja-JP': { hl: 'ja', gl: 'JP', ceid: 'JP:ja' },
  'ko-KR': { hl: 'ko', gl: 'KR', ceid: 'KR:ko' },
  'en-US': { hl: 'en-US', gl: 'US', ceid: 'US:en' },
};

/** Google News RSS search, comparison only: titles and sources are counted, links are never followed. */
export const googleNewsRss: NewsFetcher = {
  id: 'google-news-rss',
  async discover(q) {
    const ed = GOOGLE_EDITION[q.market] ?? { hl: 'en-GB', gl: 'GB', ceid: 'GB:en' };
    const queries = [`"${q.teamName}" when:7d`];
    const candidates: NewsCandidate[] = [];
    const errors: string[] = [];
    for (const query of queries) {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${ed.hl}&gl=${ed.gl}&ceid=${encodeURIComponent(ed.ceid)}`;
      try {
        const r = await httpGet(url);
        if (r.status !== 200) {
          errors.push(`google ${r.status}`);
          continue;
        }
        for (const it of parseRssItems(r.body)) {
          const domain = it.sourceUrl ? domainOf(it.sourceUrl) : '';
          candidates.push({ url: it.link, canonical: it.link, title: it.title.replace(/\s+-\s+[^-]+$/, ''), sourceName: it.source ?? domain, sourceDomain: domain, feedPublishedAt: it.pubDate, discoveredVia: 'google-news-rss', query });
        }
      } catch (err) {
        errors.push(`google error: ${String(err).slice(0, 120)}`);
      }
    }
    return { candidates, queries, errors };
  },
};

/**
 * Google finds more local team news than Bing, but its links cannot be followed without an internal Google endpoint.
 * The bridge asks Bing News for each chosen Google title, exactly, and keeps a result from the same publisher (or with
 * the same title): the publisher's own URL through public RSS only. A title Bing cannot find is dropped.
 */
export async function bridgeGoogleTitles(items: readonly NewsCandidate[], market: string): Promise<{ candidates: NewsCandidate[]; tried: number; found: number }> {
  const out: NewsCandidate[] = [];
  const norm = (t: string) => t.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  for (const g of items) {
    const query = `"${g.title}"`;
    try {
      const r = await httpGet(`https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&mkt=${encodeURIComponent(market)}`);
      if (r.status !== 200) continue;
      const hit = parseRssItems(r.body)
        .map((it) => ({ it, target: bingTargetUrl(it.link) }))
        .find(({ it, target }) => /^https?:\/\//i.test(target) && ((g.sourceDomain && domainOf(target).endsWith(g.sourceDomain.replace(/^www\./, ''))) || norm(it.title) === norm(g.title)));
      if (!hit) continue;
      out.push({ ...g, url: hit.target, canonical: canonicalUrl(hit.target), sourceDomain: domainOf(hit.target), feedPublishedAt: g.feedPublishedAt ?? hit.it.pubDate, query: `bridge: ${query}` });
    } catch {
      // a failed lookup only loses that title
    }
  }
  return { candidates: out, tried: items.length, found: out.length };
}

// ---------------------------------------------------------------- article reader

export interface FetchedPage {
  ok: boolean;
  reason: string | null;
  finalUrl: string;
  html: string;
  fetchedAt: Date;
  sha256: string | null;
}

export async function readArticle(url: string): Promise<FetchedPage> {
  const fetchedAt = new Date();
  const fail = (reason: string): FetchedPage => ({ ok: false, reason, finalUrl: url, html: '', fetchedAt, sha256: null });
  if (!(await allowedByRobots(url))) return fail('ROBOTS_DISALLOW');
  try {
    const r = await httpGet(url);
    if (r.status !== 200) return fail(`HTTP_${r.status}`);
    if (!/html/i.test(r.contentType)) return fail(`NOT_HTML ${r.contentType.slice(0, 40)}`);
    if (r.finalUrl !== url && !(await allowedByRobots(r.finalUrl))) return fail('ROBOTS_DISALLOW_AFTER_REDIRECT');
    return { ok: true, reason: null, finalUrl: r.finalUrl, html: r.body, fetchedAt: new Date(), sha256: createHash('sha256').update(r.body).digest('hex') };
  } catch (err) {
    return fail(`FETCH_ERROR ${String(err).slice(0, 80)}`);
  }
}

// ---------------------------------------------------------------- languages

/** Bing market and the local word for injury, by the league's country (API-Football names). */
export function leagueLanguage(country: string | null): { market: string; injuryWord: string } {
  const c = (country ?? '').toLowerCase();
  const map: Array<[string[], string, string]> = [
    [['england', 'scotland', 'wales', 'northern-ireland', 'ireland'], 'en-GB', 'injury'],
    [['usa'], 'en-US', 'injury'],
    [['australia'], 'en-AU', 'injury'],
    [['spain'], 'es-ES', 'lesión'],
    [['mexico'], 'es-MX', 'lesión'],
    [['argentina', 'uruguay', 'paraguay'], 'es-AR', 'lesión'],
    [['chile', 'colombia', 'peru', 'ecuador', 'bolivia', 'venezuela'], 'es-CL', 'lesión'],
    [['brazil'], 'pt-BR', 'lesão'],
    [['portugal'], 'pt-PT', 'lesão'],
    [['italy'], 'it-IT', 'infortunio'],
    [['germany'], 'de-DE', 'Verletzung'],
    [['austria'], 'de-AT', 'Verletzung'],
    [['switzerland'], 'de-CH', 'Verletzung'],
    [['france'], 'fr-FR', 'blessure'],
    [['belgium'], 'nl-BE', 'blessure'],
    [['netherlands'], 'nl-NL', 'blessure'],
    [['turkey'], 'tr-TR', 'sakatlık'],
    [['japan'], 'ja-JP', '負傷'],
    [['south-korea', 'korea-republic'], 'ko-KR', '부상'],
    [['saudi-arabia'], 'ar-SA', 'إصابة'],
    [['denmark'], 'da-DK', 'skade'],
    [['norway'], 'nb-NO', 'skade'],
    [['sweden'], 'sv-SE', 'skada'],
  ];
  for (const [countries, market, injuryWord] of map) if (countries.includes(c)) return { market, injuryWord };
  return { market: 'en-GB', injuryWord: 'injury' };
}
