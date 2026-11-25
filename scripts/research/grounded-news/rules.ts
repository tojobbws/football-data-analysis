/**
 * Grounded news, Phase 0: pure rules (.scratch/grounded-news/spec.md §2.3, §3.2). No I/O here: URL canonical form,
 * HTML text and timestamps, the verbatim-quote check, player name resolution, novelty, impact, corroboration, status.
 */
import type { ExtractedSignal, NewsSignalRecord, SourceTier } from './schema.js';
import { PLAYER_CATEGORIES } from './schema.js';

// ---------------------------------------------------------------- text

const SPECIAL: Record<string, string> = { ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', đ: 'd', ð: 'd', ł: 'l', þ: 'th', ı: 'i' };

/** lower case, accents removed, special letters mapped: for name and team matching only */
export function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[øæœßđðłþı]/g, (c) => SPECIAL[c] ?? c);
}

/** the form both the quote and the article text are compared in: Unicode NFKC, one kind of quote and dash, one space */
export function normalizeForQuote(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[‘’‚‛′´`]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[\s ​]+/g, ' ')
    .trim();
}

/**
 * The quote is a verbatim passage of the text the model saw. Leading and trailing quote marks and ellipses around the
 * quote are ignored (the model often wraps the passage); nothing inside it may differ.
 */
export function quoteVerified(quote: string, text: string): boolean {
  const q = normalizeForQuote(quote).replace(/^["'.\s]+|["'.\s]+$/g, '');
  return q.length >= 8 && normalizeForQuote(text).includes(q);
}

/**
 * A raw signal whose quote runs over 200 characters (up to 300) gets the quote cut at the last space within 200
 * characters: a prefix of a verbatim passage is still verbatim. Anything else is returned unchanged.
 */
export function trimQuote(raw: unknown): { raw: unknown; trimmed: boolean } {
  const r = raw as { evidence_quote?: unknown } | null;
  const q = r && typeof r.evidence_quote === 'string' ? r.evidence_quote : null;
  if (!q || q.length <= 200 || q.length > 300) return { raw, trimmed: false };
  const head = q.slice(0, 200);
  const at = head.lastIndexOf(' ');
  return { raw: { ...r, evidence_quote: (at >= 80 ? head.slice(0, at) : head).trimEnd() }, trimmed: true };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** The article's paragraphs: <p> elements outside script, style, nav, header, footer, aside and forms, tags removed. */
export function extractParagraphs(html: string): string[] {
  const body = html
    .replace(/<(script|style|noscript|nav|header|footer|aside|form|svg|figure|button)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const out: string[] = [];
  for (const m of body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = decodeEntities(m[1]!.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (text.length >= 30) out.push(text);
  }
  return [...new Set(out)];
}

/**
 * The part of the article the model sees: the first two paragraphs and every paragraph that names a team, a squad player
 * or a news keyword, in article order, cut at maxChars. Quotes are verified against exactly this text.
 */
export function selectExcerpt(paragraphs: readonly string[], keywords: readonly string[], maxChars = 6000): string {
  const keys = keywords.map(fold).filter((k) => k.length >= 3);
  const picked: string[] = [];
  let size = 0;
  paragraphs.forEach((p, i) => {
    const f = fold(p);
    if (i < 2 || keys.some((k) => f.includes(k))) {
      if (size + p.length > maxChars) return;
      picked.push(p);
      size += p.length + 2;
    }
  });
  return picked.join('\n\n');
}

// ---------------------------------------------------------------- URLs and sources

const TRACKING = /^(utm_|fbclid|gclid|ocid|cmpid|ito|at_|mc_|igshid|xtor|ref$|src$|share)/i;

export function canonicalUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^(www|m|amp)\./, '');
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k) || k === 'amp' || k === 'outputType') u.searchParams.delete(k);
  u.pathname = u.pathname.replace(/\/amp\/?$/i, '/').replace(/\.amp(\.html)?$/i, '$1').replace(/\/+$/, '') || '/';
  return u.toString();
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^(www|m|amp)\./, '');
  } catch {
    return '';
  }
}

/**
 * Phase 0 source tiers: a short static list of established outlets (reputable_media). No beat-reporter list yet, so
 * nothing is tier1_beat in Phase 0. A domain made of the team's own name is taken as the club's site (heuristic,
 * named in the report). Everything else, including syndication portals (MSN, Yahoo), is aggregator.
 */
export const REPUTABLE_DOMAINS: readonly string[] = [
  'bbc.co.uk', 'bbc.com', 'skysports.com', 'theathletic.com', 'nytimes.com', 'theguardian.com', 'telegraph.co.uk', 'independent.co.uk',
  'thetimes.com', 'thetimes.co.uk', 'standard.co.uk', 'espn.com', 'espn.co.uk', 'espn.com.br', 'espn.com.ar', 'espn.com.mx', 'reuters.com',
  'apnews.com', 'football.london', 'manchestereveningnews.co.uk', 'liverpoolecho.co.uk', 'birminghammail.co.uk', 'chroniclelive.co.uk',
  'dailyrecord.co.uk', 'heraldscotland.com', 'goal.com', 'skysports.de', 'kicker.de', 'sport1.de', 'sportschau.de', 'bild.de', 'faz.net',
  'transfermarkt.com', 'marca.com', 'as.com', 'mundodeportivo.com', 'sport.es', 'elpais.com', 'relevo.com', 'gazzetta.it', 'corrieredellosport.it',
  'tuttosport.com', 'sky.it', 'sport.sky.it', 'football-italia.net', 'lequipe.fr', 'rmcsport.bfmtv.com', 'francefootball.fr', 'ouest-france.fr',
  'ge.globo', 'globo.com', 'globoesporte.globo.com', 'uol.com.br', 'lance.com.br', 'gazetaesportiva.com', 'terra.com.br', 'estadao.com.br',
  'folha.uol.com.br', 'correiodopovo.com.br', 'gauchazh.clicrbs.com.br', 'oglobo.globo.com', 'record.pt', 'abola.pt', 'ojogo.pt', 'maisfutebol.iol.pt',
  'ole.com.ar', 'tycsports.com', 'lanacion.com.ar', 'clarin.com', 'infobae.com', 'mediotiempo.com', 'record.com.mx', 'voetbalinternational.nl',
  'nos.nl', 'ad.nl', 'telegraaf.nl', 'hln.be', 'sporza.be', 'nieuwsblad.be', 'fanatik.com.tr', 'hurriyet.com.tr', 'sabah.com.tr', 'mlssoccer.com',
  'nikkansports.com', 'sponichi.co.jp', 'hochi.news', 'gekisaka.jp', 'football-zone.net', 'yna.co.kr', 'sports.chosun.com', 'arabnews.com',
  'kooora.com', 'tv2.dk', 'bold.dk', 'vg.no', 'nrk.no', 'aftonbladet.se', 'expressen.se', 'sportbladet.se', 'premierleague.com', 'laliga.com',
  'bundesliga.com', 'legaseriea.it', 'ligue1.com', 'uefa.com', 'fifa.com', 'cbf.com.br', 'ligaportugal.pt',
  // added after the first full dry run (24 Nov 2026): established national and regional outlets seen in the results
  'sportsmole.co.uk', 'lancashiretelegraph.co.uk', 'lancs.live', 'yorkshirepost.co.uk', 'thenorthernecho.co.uk', 'stokesentinel.co.uk',
  'watfordobserver.co.uk', 'expressandstar.com', 'milliyet.com.tr', 'sozcu.com.tr', 'cnnturk.com', 'ntvspor.net', 'fotomac.com.tr', 'aspor.com.tr',
  'fvn.no', 'aftenbladet.no', 'jn.pt', 'dn.pt', 'publico.pt', 'tn.com.ar', 'tudn.com', 'esto.com.mx', 'eluniversal.com.mx',
  'milenio.com', 'gazzetta.gr', 'idnes.cz', 'sport.cz', 'isport.blesk.cz', 'dhnet.be', 'lesoir.be', 'derstandard.at',
];
const AGGREGATORS = ['msn.com', 'yahoo.com', 'news.google.com', 'newsnow.co.uk', 'flipboard.com', 'onefootball.com', 'besoccer.com'];

const GENERIC_TEAM_WORDS = new Set([
  'fc', 'cf', 'sc', 'ac', 'as', 'ss', 'afc', 'cd', 'ca', 'ec', 'se', 'club', 'clube', 'de', 'do', 'da', 'del', 'la', 'le', 'city', 'united',
  'town', 'real', 'sporting', 'athletic', 'atletico', 'sport', 'sports', 'futbol', 'futebol', 'calcio', 'hotspur', 'albion', 'rovers', 'county',
  'wanderers', 'deportivo', 'racing', 'olympique', 'stade', 'borussia', 'vfb', 'vfl', 'tsg', 'rb', 'fk', 'sk', 'if', 'bk', 'ik', 'u21', 'w',
]);

/** the distinctive words of a team name ("Manchester United" → manchester; "Grêmio" → gremio), folded */
export function teamTokens(name: string): string[] {
  return fold(name)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !GENERIC_TEAM_WORDS.has(t));
}

/** the folded full name and its distinctive words: a text mentions the team when it holds one of them */
export function teamKeys(name: string): string[] {
  const full = fold(name).replace(/[^a-z0-9]+/g, ' ').trim();
  return [...new Set([full, ...teamTokens(name)])].filter((k) => k.length >= 4);
}

export function mentionsTeam(text: string, teamName: string): boolean {
  const f = fold(text);
  return teamKeys(teamName).some((k) => new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(f));
}

export function sourceTier(domain: string, teamNames: readonly string[]): SourceTier {
  const d = domain.toLowerCase();
  const matches = (list: readonly string[]) => list.some((x) => d === x || d.endsWith(`.${x}`));
  if (matches(AGGREGATORS)) return 'aggregator';
  const root = d.split('.')[0] ?? '';
  for (const name of teamNames) {
    const compact = fold(name).replace(/[^a-z0-9]/g, '');
    if (root.length >= 4 && (root === compact || teamTokens(name).some((t) => root === t || root === `${t}fc` || root === `fc${t}`))) return 'official_club';
  }
  if (matches(REPUTABLE_DOMAINS)) return 'reputable_media';
  return 'aggregator';
}

// ---------------------------------------------------------------- timestamps

/** an ISO-like date string as a Date, or null; "+0000" offsets are accepted */
export function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const t = s.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) return null;
  const y = new Date(ms).getUTCFullYear();
  return y >= 2000 && y <= 2100 ? new Date(ms) : null;
}

const META_PUBLISHED = ['article:published_time', 'og:article:published_time', 'datepublished', 'pubdate', 'publishdate', 'publish-date', 'parsely-pub-date', 'sailthru.date', 'dc.date', 'dcterms.created', 'date'];
const META_MODIFIED = ['article:modified_time', 'og:updated_time', 'datemodified', 'dcterms.modified', 'lastmod'];

function metaContent(html: string, names: readonly string[]): string | null {
  for (const name of names) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const a = html.match(new RegExp(`<meta[^>]+(?:property|name|itemprop)\\s*=\\s*["']${esc}["'][^>]*content\\s*=\\s*["']([^"']+)["']`, 'i'));
    const b = html.match(new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']+)["'][^>]*(?:property|name|itemprop)\\s*=\\s*["']${esc}["']`, 'i'));
    const v = a?.[1] ?? b?.[1];
    if (v && parseDate(v)) return v;
  }
  return null;
}

/** The page's own publication and modification times: JSON-LD, then meta tags, then a <time> marked as publication. */
export function pageTimestamps(html: string): { published: Date | null; modified: Date | null } {
  const ld = (k: string) => {
    for (const m of html.matchAll(new RegExp(`"${k}"\\s*:\\s*"([^"]+)"`, 'g'))) {
      const d = parseDate(m[1]);
      if (d) return d;
    }
    return null;
  };
  const time = html.match(/<time[^>]*(?:itemprop\s*=\s*["']datePublished["']|pubdate)[^>]*datetime\s*=\s*["']([^"']+)["']/i)?.[1] ?? html.match(/<time[^>]*datetime\s*=\s*["']([^"']+)["'][^>]*(?:itemprop\s*=\s*["']datePublished["']|pubdate)/i)?.[1];
  return {
    published: ld('datePublished') ?? parseDate(metaContent(html, META_PUBLISHED)) ?? parseDate(time),
    modified: ld('dateModified') ?? parseDate(metaContent(html, META_MODIFIED)),
  };
}

/**
 * The publication time used: the page's own when present; the feed's otherwise (flagged RSS_ONLY); none → NONE. When
 * the page and the feed disagree by more than three hours, the later of the two (the conservative choice).
 */
export function chooseTimestamp(page: Date | null, feed: Date | null): { published: Date | null; basis: 'PAGE_META' | 'RSS_ONLY' | 'NONE' } {
  if (page && feed && Math.abs(page.getTime() - feed.getTime()) > 3 * 3_600_000) return { published: page > feed ? page : feed, basis: 'PAGE_META' };
  if (page) return { published: page, basis: 'PAGE_META' };
  if (feed) return { published: feed, basis: 'RSS_ONLY' };
  return { published: null, basis: 'NONE' };
}

// ---------------------------------------------------------------- players

export interface RosterPlayer {
  playerId: number;
  name: string;
}

const tokens = (s: string) =>
  fold(s)
    .replace(/\bjr\b\.?/g, 'junior')
    .split(/[^a-z]+/)
    .filter(Boolean);

/**
 * The squad player a written name refers to, or UNRESOLVED. EXACT: same words. FUZZY: same surname (last word) with a
 * compatible first initial, or a one-word name (a mononym) equal to one word of exactly one player's name. Two or more
 * candidates at the first level that finds any: UNRESOLVED (ambiguous), never a guess.
 */
export function resolvePlayer(written: string, roster: readonly RosterPlayer[]): { player: RosterPlayer | null; match: 'EXACT' | 'FUZZY' | 'UNRESOLVED' } {
  const w = tokens(written);
  if (!w.length) return { player: null, match: 'UNRESOLVED' };
  const unique = new Map(roster.map((p) => [p.playerId, p]));
  const all = [...unique.values()].map((p) => ({ p, t: tokens(p.name) })).filter((x) => x.t.length);
  const one = (xs: typeof all, match: 'EXACT' | 'FUZZY') => (xs.length === 1 ? { player: xs[0]!.p, match } : xs.length > 1 ? { player: null, match: 'UNRESOLVED' as const } : null);

  const exact = one(all.filter((x) => x.t.join(' ') === w.join(' ')), 'EXACT');
  if (exact) return exact;
  const wLast = w[w.length - 1]!;
  const bySurname = all.filter((x) => {
    const full = x.t.filter((t) => t.length > 1);
    if (!full.length || full[full.length - 1] !== wLast) return false;
    const initial = x.t.length > 1 && x.t[0]!.length === 1 ? x.t[0] : null;
    return !(initial && w.length > 1 && w[0]![0] !== initial);
  });
  const s = one(bySurname, 'FUZZY');
  if (s) return s;
  if (w.length === 1) {
    const m = one(all.filter((x) => x.t.includes(wLast)), 'FUZZY');
    if (m) return m;
  }
  return { player: null, match: 'UNRESOLVED' };
}

// ---------------------------------------------------------------- verdicts

export interface PlayerFacts {
  alreadyInApi: boolean | null;
  recentStarts: number | null;
  recentLineups: number | null;
  minutesPlayedShare: number | null;
  goalShare: number | null;
}

export function isRegularStarter(f: Pick<PlayerFacts, 'recentStarts' | 'recentLineups'>): boolean | null {
  if (f.recentLineups === null || f.recentStarts === null) return null;
  return f.recentLineups >= 3 && f.recentStarts >= 3;
}

export function novelty(s: ExtractedSignal, f: { alreadyInApi: boolean | null; coachAlreadyVisible: boolean }): NewsSignalRecord['novelty'] {
  if (PLAYER_CATEGORIES.includes(s.category)) {
    if (!f.alreadyInApi) return 'NOVEL';
    return s.severity === 'RETURNED_EARLY' || s.eligibility === 'CLEARED_TO_PLAY' ? 'CONTRADICTS_API' : 'CONFIRMS_API';
  }
  if (s.category === 'MANAGER_CHANGE') return f.coachAlreadyVisible ? 'CONFIRMS_API' : 'NOVEL';
  return 'NOVEL';
}

export function impact(s: ExtractedSignal, f: PlayerFacts & { resolved: boolean; novel: boolean }): NewsSignalRecord['impact'] {
  if (PLAYER_CATEGORIES.includes(s.category)) {
    if (!f.resolved) return 'UNKNOWN';
    if (isRegularStarter(f) || (f.minutesPlayedShare ?? 0) >= 0.6 || (f.goalShare ?? 0) >= 0.25) return 'HIGH';
    if ((f.recentStarts ?? 0) >= 1 || (f.minutesPlayedShare ?? 0) >= 0.3) return 'MEDIUM';
    return f.recentLineups === null && f.minutesPlayedShare === null ? 'UNKNOWN' : 'LOW';
  }
  if (s.category === 'MANAGER_CHANGE') return f.novel ? 'HIGH' : 'MEDIUM';
  if (s.category === 'ROTATION_HINT') return s.rotation_strength === 'EXPLICIT' && (s.rotation_scope === 'WIDESPREAD' || s.rotation_scope === 'GOALKEEPER') ? 'HIGH' : 'MEDIUM';
  return s.disruption && ['TRAVEL', 'UNPAID_WAGES', 'SQUAD_UNREST', 'ILLNESS_OUTBREAK'].includes(s.disruption) ? 'MEDIUM' : 'LOW';
}

export interface StatusInput {
  signal: ExtractedSignal;
  quoteOk: boolean;
  articleAbout: string | null;
  published: Date | null;
  basis: 'PAGE_META' | 'RSS_ONLY' | 'NONE';
  collected: Date;
  cutoff: Date;
  /** the team's previous stored match; news before it is stale for player and rotation categories */
  since: Date | null;
  tier: SourceTier;
  corroboratedByBetterTier: boolean;
  playerResolved: boolean;
}

/** REJECTED, UNVERIFIED or ELIGIBLE, with every reason; reasons starting "note:" do not lower the status. */
export function signalStatus(x: StatusInput): { status: NewsSignalRecord['status']; reasons: string[] } {
  const rejected: string[] = [];
  const unverified: string[] = [];
  const notes: string[] = [];
  if (!x.quoteOk) rejected.push('QUOTE_NOT_FOUND');
  if (x.articleAbout !== 'YES') rejected.push(`ARTICLE_${x.articleAbout ?? 'UNKNOWN'}`);
  if (x.collected > x.cutoff) rejected.push('COLLECTED_AFTER_CUTOFF');
  if (x.published && x.published > x.collected) rejected.push('PUBLISHED_AFTER_COLLECTION');
  const window = x.signal.category === 'MANAGER_CHANGE' ? new Date(x.cutoff.getTime() - 14 * 86_400_000) : x.since;
  if (x.published && window && x.published < window) rejected.push(x.signal.category === 'MANAGER_CHANGE' ? 'OLDER_THAN_14_DAYS' : 'BEFORE_PREVIOUS_MATCH');
  if (x.basis === 'NONE') unverified.push('NO_TIMESTAMP');
  if (x.basis === 'RSS_ONLY') notes.push('note:TIMESTAMP_RSS_ONLY');
  if (x.tier === 'aggregator' && !x.corroboratedByBetterTier) unverified.push('AGGREGATOR_UNCORROBORATED');
  if (x.signal.attribution === 'UNATTRIBUTED_RUMOUR') unverified.push('RUMOUR');
  if (PLAYER_CATEGORIES.includes(x.signal.category) && !x.playerResolved) unverified.push('PLAYER_UNRESOLVED');
  const status = rejected.length ? 'REJECTED' : unverified.length ? 'UNVERIFIED' : 'ELIGIBLE';
  return { status, reasons: [...rejected, ...unverified, ...notes] };
}

/** the key under which signals from different articles say the same thing */
export function corroborationKey(s: ExtractedSignal, playerId: number | null): string {
  const who = playerId !== null ? `id:${playerId}` : s.player_name_as_written ? `name:${tokens(s.player_name_as_written).join(' ')}` : 'team';
  const what = s.severity ?? s.eligibility ?? s.rotation_strength ?? s.manager_change ?? s.disruption ?? '';
  return `${s.team}|${s.category}|${who}|${what}`;
}
