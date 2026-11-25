/**
 * Grounded news extraction — Phase 0 dry run (.scratch/grounded-news/spec.md §6, approved by the owner 2026-11-24).
 *
 * READ-ONLY on the database: every query runs inside a READ ONLY transaction, nothing is inserted anywhere. Output goes
 * to reports/grounded-news/<pick day>/ (gitignored): run-<stamp>.jsonl (one line per fixture) and summary-<stamp>.md
 * (numbers + a review sheet for the owner to mark each signal right or wrong).
 *
 *   npx tsx scripts/research/grounded-news/dry-run.ts                          # the coming pick day, every fixture
 *   npx tsx scripts/research/grounded-news/dry-run.ts --max-fixtures 5 --no-ai # smoke test: discovery and reading only
 *   npx tsx scripts/research/grounded-news/dry-run.ts --no-google              # Bing only, without the Google title bridge
 *   npx tsx scripts/research/grounded-news/dry-run.ts --followup reports/grounded-news/2026-11-25/run-….jsonl
 *       # after the matches: OUT/DOUBTFUL signals against the confirmed lineups, and whether API injuries caught up
 *
 * A valid Phase 0 day is run on the day itself, started at about 13:20 Thai and finished before 14:00 (the pick run's
 * cut-off): the summary says whether it was. The pick day is 14:00 Thai on D to 14:00 on D+1 (ADR 0014). Leagues: the
 * ones the production Hybrid AI decided in the last 14 days (local TRACKED_LEAGUES is not production's), or --leagues.
 *
 * Model: OPENAI_NEWS_MODEL, else OPENAI_MODEL. Cost is estimated from the returned usage: gpt-6-luna's list price (as read
 * on 16 Nov 2026, scripts/research/hybrid-v21-replay.ts), or --prices input,cached,output (USD per 1M tokens) for another
 * model; --usd-cap stops the calls of a run.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createOpenAIStructuredCall, isPersistentOpenAIError } from '@fp/ai';
import { regularStarters } from '@fp/analysis';
import { createPgDb, Repository, type Db, type Queryable } from '@fp/database';
import { competitionKind, loadDotEnvFile, loadEnv } from '@fp/shared';
import { bingNewsRss, bridgeGoogleTitles, googleNewsRss, leagueLanguage, readArticle, USER_AGENT, type NewsCandidate } from './fetch.js';
import {
  canonicalUrl,
  chooseTimestamp,
  corroborationKey,
  domainOf,
  extractParagraphs,
  fold,
  impact,
  isRegularStarter,
  mentionsTeam,
  novelty,
  pageTimestamps,
  quoteVerified,
  resolvePlayer,
  selectExcerpt,
  signalStatus,
  sourceTier,
  teamTokens,
  trimQuote,
  type RosterPlayer,
} from './rules.js';
import {
  ExtractedSignalSchema,
  NEWS_EXTRACT_PROMPT_VERSION,
  NEWS_OUTPUT_SCHEMA,
  NEWS_RULES_VERSION,
  NEWS_SYSTEM_PROMPT,
  NewsExtractionSchema,
  PLAYER_CATEGORIES,
  type ExtractedSignal,
  type NewsSignalRecord,
  type SourceTier,
} from './schema.js';

const { values } = parseArgs({
  options: {
    'pick-day': { type: 'string' },
    'max-fixtures': { type: 'string', default: '100' },
    fixture: { type: 'string' },
    leagues: { type: 'string' },
    'no-ai': { type: 'boolean', default: false },
    'no-google': { type: 'boolean', default: false },
    concurrency: { type: 'string', default: '4' },
    prices: { type: 'string' },
    'usd-cap': { type: 'string', default: '1' },
    'allow-late': { type: 'boolean', default: false },
    followup: { type: 'string' },
    model: { type: 'string' },
  },
});

loadDotEnvFile();
const env = loadEnv();
const H = 3_600_000;
const DAY = 24 * H;
const MAX_ARTICLES = 8;
const MAX_PAGE_TRIES = 14;
/** Google titles looked up on Bing per fixture */
const GOOGLE_BRIDGE_PER_FIXTURE = 6;
const NEWS_WORDS = [
  'injur', 'lesao', 'lesion', 'desfalque', 'desfalques', 'infortun', 'verletz', 'blessure', 'blesse', 'sakat', 'suspen', 'ruled out', 'doubt',
  'team news', 'fitness', 'escalacao', 'convocad', 'relacionad', 'baja', 'bajas', 'duda', 'ausencia', 'ausente', 'sacked', 'demit', 'treinador',
  'tecnico', 'entrenador', 'allenatore', 'trainer', 'coach', 'manager', 'press conference', 'coletiva', 'rueda de prensa', 'conferenza',
  'squalific', 'gesperrt', 'sperre', 'rotation', 'rodizio', 'poupad', 'descanso', 'training', 'treino', 'entrenamiento', 'allenamento',
];

/** $ per 1M tokens; gpt-6-luna as read on the OpenAI pricing page on 16 Nov 2026 (cache write as in decisions-bias.ts) */
const KNOWN_PRICES: Record<string, { input: number; cached: number; cacheWrite: number; output: number }> = { 'gpt-6-luna': { input: 0.1, cached: 0.01, cacheWrite: 0.125, output: 0.5 } };

function costOf(usage: unknown, p: { input: number; cached: number; cacheWrite: number; output: number }): number {
  const u = (usage ?? {}) as { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } };
  const input = u.input_tokens ?? 0;
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  const write = u.input_tokens_details?.cache_write_tokens ?? 0;
  return (Math.max(0, input - cached - write) * p.input + cached * p.cached + write * p.cacheWrite + (u.output_tokens ?? 0) * p.output) / 1e6;
}

/** the primary treated signal of the spec (§6): an eligible, novel, high-impact absence (OUT, SUSPENDED, INELIGIBLE) */
export const isTreatedAbsence = (s: NewsSignalRecord) =>
  s.status === 'ELIGIBLE' && s.novelty === 'NOVEL' && s.impact === 'HIGH' && (s.severity === 'OUT' || s.eligibility === 'SUSPENDED' || s.eligibility === 'INELIGIBLE');

// ---------------------------------------------------------------- read-only database

/** Every query in its own READ ONLY transaction: works through any connection pooler, and cannot write. */
function readOnlyDb(base: Db): Db {
  const ro = <T>(fn: (tx: Queryable) => Promise<T>) =>
    base.transaction(async (tx) => {
      await tx.query('set transaction read only');
      return fn(tx);
    });
  return {
    query: (text, params) => ro((tx) => tx.query(text, params)),
    exec: async () => {
      throw new Error('dry run: exec is not allowed');
    },
    transaction: (fn) => ro(fn),
    close: () => base.close(),
  };
}

const db = readOnlyDb(createPgDb(env.DATABASE_URL!, { max: 4 }));
const repo = new Repository(db);
const q = async <R = Record<string, unknown>>(text: string, params: unknown[] = []) => (await db.query<R>(text, params)).rows;

// ---------------------------------------------------------------- time

const thai = (d: Date) => new Date(d.getTime() + 7 * H).toISOString().slice(0, 16).replace('T', ' ');

/** the coming pick day: today (Thai) before 14:00 Thai, tomorrow from 14:00 */
function pickDayOf(now: Date, given?: string): { date: string; cutoff: Date } {
  let date = given;
  if (!date) {
    const t = new Date(now.getTime() + 7 * H);
    if (t.getUTCHours() >= 14) t.setUTCDate(t.getUTCDate() + 1);
    date = t.toISOString().slice(0, 10);
  }
  return { date, cutoff: new Date(`${date}T14:00:00+07:00`) };
}

// ---------------------------------------------------------------- context from the database

interface TeamCtx {
  id: number;
  name: string;
  prevMatch: Date | null;
  roster: Array<RosterPlayer & { starts180: number }>;
  rs: ReturnType<typeof regularStarters>;
  figures: Awaited<ReturnType<Repository['playerSeasonFigures']>>;
  teamMinutes: number;
  teamGoals: number;
  coaches: Array<string | null>;
}

interface FixtureRow {
  id: number;
  league_id: number;
  season: number;
  kickoff_at: Date;
  home_team_id: number;
  away_team_id: number;
  home: string;
  away: string;
  league: string;
  league_type: string | null;
  league_country: string | null;
  home_country: string | null;
  away_country: string | null;
}

interface InjuryRow {
  team_id: number;
  player_id: number | null;
  player_name: string | null;
  type: string | null;
  reason: string | null;
  first_seen_at: Date;
}

const teamCache = new Map<string, Promise<TeamCtx>>();

function teamCtx(id: number, name: string, f: FixtureRow, now: Date): Promise<TeamCtx> {
  const key = `${id}:${f.league_id}:${f.season}`;
  if (!teamCache.has(key))
    teamCache.set(
      key,
      (async () => {
        const [prev, roster, lineups, figures, coaches] = await Promise.all([
          q<{ k: Date | null }>(
            `select max(kickoff_at) as k from fixtures where (home_team_id = $1 or away_team_id = $1) and status_short in ('FT','AET','PEN') and kickoff_at < $2`,
            [id, now.toISOString()],
          ),
          q<{ player_id: number; name: string; starts: string }>(
            `select lp.player_id, max(lp.player_name) as name, count(*) filter (where lp.is_starter) as starts
               from fixture_lineup_players lp join fixtures f on f.id = lp.fixture_id
              where lp.team_id = $1 and lp.player_id is not null and f.kickoff_at < $2 and f.kickoff_at > $2::timestamptz - interval '180 days'
              group by lp.player_id order by starts desc`,
            [id, now.toISOString()],
          ),
          repo.teamRecentLineups(id, now),
          repo.playerSeasonFigures(id, f.season, now),
          q<{ coach_name: string | null }>(
            `select fl.coach_name from fixture_lineups fl join fixtures f on f.id = fl.fixture_id
              where fl.team_id = $1 and f.status_short in ('FT','AET','PEN') and f.kickoff_at < $2 order by f.kickoff_at desc limit 10`,
            [id, now.toISOString()],
          ),
        ]);
        const kind = competitionKind(f.league_id, f.league_type, f.league_country);
        return {
          id,
          name,
          prevMatch: prev[0]?.k ? new Date(prev[0].k) : null,
          roster: roster.map((r) => ({ playerId: Number(r.player_id), name: String(r.name ?? ''), starts180: Number(r.starts) })),
          rs: regularStarters(lineups, { leagueId: f.league_id, season: f.season, kind }),
          figures,
          teamMinutes: figures.reduce((s, p) => s + p.minutes, 0),
          teamGoals: figures.reduce((s, p) => s + p.goals, 0),
          coaches: coaches.map((c) => c.coach_name),
        };
      })(),
    );
  return teamCache.get(key)!;
}

const leagueCoverage = new Map<number, Promise<boolean>>();
function leagueHasInjuries(leagueId: number, now: Date): Promise<boolean> {
  if (!leagueCoverage.has(leagueId))
    leagueCoverage.set(
      leagueId,
      q<{ n: string }>(`select count(*) as n from injuries where league_id = $1 and fixture_date > $2::timestamptz - interval '30 days'`, [leagueId, now.toISOString()]).then((r) => Number(r[0]?.n ?? 0) > 0),
    );
  return leagueCoverage.get(leagueId)!;
}

// ---------------------------------------------------------------- run

interface ArticleRec {
  ref: string;
  url: string;
  canonical: string;
  domain: string;
  source_name: string;
  tier: SourceTier;
  title: string;
  published_at_utc: string | null;
  modified_at_utc: string | null;
  timestamp_basis: 'PAGE_META' | 'RSS_ONLY' | 'NONE';
  feed_published_at_utc: string | null;
  collected_at_utc: string;
  content_sha256: string;
  excerpt_chars: number;
  mentions: Array<'HOME' | 'AWAY'>;
  discovered_via: string;
  about_this_fixture: string | null;
  /** in memory only, never written */
  excerpt?: string;
}

const discoveryCache = new Map<string, ReturnType<typeof bingNewsRss.discover>>();
const googleCache = new Map<string, ReturnType<typeof googleNewsRss.discover>>();

function discover(fetcher: typeof bingNewsRss, cache: typeof discoveryCache, teamName: string, country: string | null) {
  const lang = leagueLanguage(country);
  const key = `${teamName}|${lang.market}`;
  if (!cache.has(key)) cache.set(key, fetcher.discover({ teamName, market: lang.market, injuryWord: lang.injuryWord }));
  return cache.get(key)!;
}

/** the language a team's news is searched in: the league's country, or the team's own in a competition between countries */
const searchCountry = (f: FixtureRow, s: 'HOME' | 'AWAY') => (f.league_country && f.league_country !== 'World' ? f.league_country : ((s === 'HOME' ? f.home_country : f.away_country) ?? f.league_country));

const normTitle = (t: string) => fold(t).replace(/[^a-z0-9]+/g, ' ').trim();

async function main() {
  if (values.followup) return followup(values.followup);
  const startedAt = new Date();
  const { date, cutoff } = pickDayOf(startedAt, values['pick-day']);
  if (startedAt >= cutoff && !values['allow-late']) {
    console.error(`pick day ${date}: its cut-off ${thai(cutoff)} Thai has passed. A dry run after the cut-off is not a valid Phase 0 day (use --allow-late for a smoke test).`);
    process.exit(1);
  }
  const model = values.model ?? process.env.OPENAI_NEWS_MODEL ?? env.OPENAI_MODEL;
  const useAi = !values['no-ai'];
  if (useAi && (!env.OPENAI_API_KEY || !model)) throw new Error('OPENAI_API_KEY and OPENAI_NEWS_MODEL / OPENAI_MODEL are needed (or --no-ai)');
  const price = values.prices
    ? (([input, cached, output]) => ({ input: input!, cached: cached!, cacheWrite: input!, output: output!, note: 'from --prices' }))(values.prices.split(',').map(Number))
    : KNOWN_PRICES[model ?? '']
      ? { ...KNOWN_PRICES[model!]!, note: `${model} list price` }
      : { ...KNOWN_PRICES['gpt-6-luna']!, note: `UNKNOWN for ${model}: gpt-6-luna prices used, pass --prices` };
  const usdCap = Number(values['usd-cap']);

  const leagues = values.leagues
    ? values.leagues.split(',').map(Number)
    : (await q<{ league_id: number }>(`select distinct f.league_id from hybrid_decisions h join fixtures f on f.id = h.fixture_id where h.decided_at > now() - interval '14 days'`)).map((r) => Number(r.league_id));
  const fixtures = (
    await q<FixtureRow>(
      `select f.id, f.league_id, f.season, f.kickoff_at, f.home_team_id, f.away_team_id, th.name as home, ta.name as away,
              l.name as league, l.type as league_type, l.country as league_country, th.country as home_country, ta.country as away_country
         from fixtures f join teams th on th.id = f.home_team_id join teams ta on ta.id = f.away_team_id join leagues l on l.id = f.league_id
        where f.league_id = any($1::int[]) and f.status_short in ('NS','TBD') and f.kickoff_at > $2 and f.kickoff_at <= $3
          ${values.fixture ? 'and f.id = any($4::bigint[])' : ''}
        order by f.kickoff_at, f.id`,
      [leagues, cutoff.toISOString(), new Date(cutoff.getTime() + DAY).toISOString(), ...(values.fixture ? [values.fixture.split(',').map(Number)] : [])],
    )
  ).map((r) => ({ ...r, id: Number(r.id), league_id: Number(r.league_id), season: Number(r.season), home_team_id: Number(r.home_team_id), away_team_id: Number(r.away_team_id), kickoff_at: new Date(r.kickoff_at) }));
  console.log(`pick day ${date} (cut-off ${thai(cutoff)} Thai): ${fixtures.length} fixtures in ${leagues.length} leagues; model ${useAi ? model : 'none (--no-ai)'}; user agent "${USER_AGENT}"`);

  // priority (spec §2.2)
  const prepared = await Promise.all(
    fixtures.map(async (f) => {
      const [home, away, injuries, covered] = await Promise.all([
        teamCtx(f.home_team_id, f.home, f, startedAt),
        teamCtx(f.away_team_id, f.away, f, startedAt),
        q<InjuryRow>(`select team_id, player_id, player_name, type, reason, first_seen_at from injuries where fixture_id = $1`, [f.id]),
        leagueHasInjuries(f.league_id, startedAt),
      ]);
      const breakGap = [home, away].some((t) => t.prevMatch && f.kickoff_at.getTime() - t.prevMatch.getTime() >= 10 * DAY);
      const coachChange = [home, away].some((t) => t.coaches[0] && t.coaches[1] && t.coaches[0] !== t.coaches[1]);
      const priority = !covered || injuries.length === 0 ? 'P1' : breakGap ? 'P2' : coachChange ? 'P3' : 'P4';
      return { f, home, away, injuries: injuries.map((i) => ({ ...i, team_id: Number(i.team_id), player_id: i.player_id == null ? null : Number(i.player_id), first_seen_at: new Date(i.first_seen_at) })), covered, priority };
    }),
  );
  prepared.sort((a, b) => a.priority.localeCompare(b.priority) || a.f.kickoff_at.getTime() - b.f.kickoff_at.getTime());
  const scope = prepared.slice(0, Number(values['max-fixtures']));

  const dir = `reports/grounded-news/${date}`;
  await mkdir(dir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[-:]/g, '').slice(0, 13);
  const lines: Array<Record<string, any>> = [];
  let cost = 0;
  let aiStopped: string | null = null;
  const call = useAi ? createOpenAIStructuredCall({ apiKey: env.OPENAI_API_KEY!, model: model!, system: NEWS_SYSTEM_PROMPT, schemaName: 'news_extraction', schema: NEWS_OUTPUT_SCHEMA as unknown as Record<string, unknown> }) : null;

  const one = async (p: (typeof scope)[number]) => {
    const { f, home, away, injuries } = p;
    const side = (s: 'HOME' | 'AWAY') => (s === 'HOME' ? home : away);
    const since = (() => {
      const prevs = [home.prevMatch, away.prevMatch].filter((d): d is Date => d !== null).map((d) => d.getTime());
      const base = Math.min(...prevs, cutoff.getTime() - 3 * DAY);
      return new Date(Math.max(base, cutoff.getTime() - 14 * DAY));
    })();

    // 1. discovery
    const [dh, da] = await Promise.all([discover(bingNewsRss, discoveryCache, f.home, searchCountry(f, 'HOME')), discover(bingNewsRss, discoveryCache, f.away, searchCountry(f, 'AWAY'))]);
    const seen = new Set<string>();
    const titles = new Set<string>();
    const candidates: NewsCandidate[] = [];
    for (const c of [...dh.candidates, ...da.candidates]) {
      const t = normTitle(c.title);
      if (seen.has(c.canonical) || (t && titles.has(t))) continue;
      seen.add(c.canonical);
      if (t) titles.add(t);
      if (c.feedPublishedAt && (c.feedPublishedAt < since || c.feedPublishedAt > startedAt)) continue;
      candidates.push(c);
    }
    // Google's titles not found by Bing, team news first, looked up on Bing by exact title (fetch.ts bridgeGoogleTitles)
    let google: Record<string, unknown> | null = null;
    if (!values['no-google']) {
      const [gh, ga] = await Promise.all([discover(googleNewsRss, googleCache, f.home, searchCountry(f, 'HOME')), discover(googleNewsRss, googleCache, f.away, searchCountry(f, 'AWAY'))]);
      const inWindow = (c: NewsCandidate) => !c.feedPublishedAt || (c.feedPublishedAt >= since && c.feedPublishedAt <= startedAt);
      const newsy = (c: NewsCandidate) => NEWS_WORDS.some((w) => fold(c.title).includes(w));
      const onlyGoogle = [...gh.candidates.map((c) => ({ c, s: 'HOME' as const })), ...ga.candidates.map((c) => ({ c, s: 'AWAY' as const }))].filter(({ c }) => !titles.has(normTitle(c.title)));
      const gscore = (c: NewsCandidate) => (newsy(c) ? 2 : 0) + (mentionsTeam(c.title, f.home) && mentionsTeam(c.title, f.away) ? 2 : 0) + (c.feedPublishedAt ? c.feedPublishedAt.getTime() / 1e14 : 0);
      const picked = new Map<string, { c: NewsCandidate; s: 'HOME' | 'AWAY' }>();
      for (const x of onlyGoogle.filter(({ c }) => inWindow(c) && (newsy(c) || mentionsTeam(c.title, f.home) || mentionsTeam(c.title, f.away))).sort((a, b) => gscore(b.c) - gscore(a.c)))
        if (picked.size < GOOGLE_BRIDGE_PER_FIXTURE && !picked.has(normTitle(x.c.title))) picked.set(normTitle(x.c.title), x);
      let found = 0;
      for (const s of ['HOME', 'AWAY'] as const) {
        const items = [...picked.values()].filter((x) => x.s === s).map((x) => x.c);
        if (!items.length) continue;
        const b = await bridgeGoogleTitles(items, leagueLanguage(searchCountry(f, s)).market);
        for (const c of b.candidates)
          if (!seen.has(c.canonical)) {
            seen.add(c.canonical);
            titles.add(normTitle(c.title));
            candidates.push(c);
            found++;
          }
      }
      google = {
        items: gh.candidates.length + ga.candidates.length,
        only_in_google: onlyGoogle.length,
        only_in_google_newsy: onlyGoogle.filter(({ c }) => newsy(c)).length,
        bridge_tried: picked.size,
        bridge_found: found,
        errors: [...gh.errors, ...ga.errors],
      };
    }
    const names = [f.home, f.away];
    const score = (c: NewsCandidate) => {
      const t = fold(c.title);
      const both = mentionsTeam(c.title, f.home) && mentionsTeam(c.title, f.away);
      const any = mentionsTeam(c.title, f.home) || mentionsTeam(c.title, f.away);
      const tier = sourceTier(c.sourceDomain, names);
      return (both ? 3 : any ? 1 : 0) + (NEWS_WORDS.some((w) => t.includes(w)) ? 2 : 0) + (tier === 'official_club' ? 2 : tier === 'reputable_media' ? 1 : 0) + (c.feedPublishedAt ? c.feedPublishedAt.getTime() / 1e14 : 0);
    };
    candidates.sort((a, b) => score(b) - score(a));

    // 2. read pages
    const keywords = [f.home, f.away, ...teamTokens(f.home), ...teamTokens(f.away), ...NEWS_WORDS, ...[...home.roster, ...away.roster].slice(0, 80).map((r) => r.name.split(/\s+/).pop() ?? '')];
    const articles: ArticleRec[] = [];
    const fetchFailures: Record<string, number> = {};
    let tries = 0;
    for (const c of candidates) {
      if (articles.length >= MAX_ARTICLES || tries >= MAX_PAGE_TRIES) break;
      tries++;
      const page = await readArticle(c.url);
      if (!page.ok) {
        const k = (page.reason ?? 'UNKNOWN').split(' ')[0]!;
        fetchFailures[k] = (fetchFailures[k] ?? 0) + 1;
        continue;
      }
      const paragraphs = extractParagraphs(page.html);
      const full = paragraphs.join('\n');
      const mentions = (['HOME', 'AWAY'] as const).filter((s) => mentionsTeam(full, side(s).name));
      if (paragraphs.length < 2 || !mentions.length) {
        fetchFailures[paragraphs.length < 2 ? 'NO_TEXT' : 'NO_TEAM_MENTION'] = (fetchFailures[paragraphs.length < 2 ? 'NO_TEXT' : 'NO_TEAM_MENTION'] ?? 0) + 1;
        continue;
      }
      const excerpt = selectExcerpt(paragraphs, keywords);
      const ts = pageTimestamps(page.html);
      const chosen = chooseTimestamp(ts.published, c.feedPublishedAt);
      const finalUrl = page.finalUrl;
      if (articles.some((a) => a.canonical === canonicalUrl(finalUrl))) continue;
      articles.push({
        ref: `A${articles.length + 1}`,
        url: finalUrl,
        canonical: canonicalUrl(finalUrl),
        domain: domainOf(finalUrl),
        source_name: c.sourceName,
        tier: sourceTier(domainOf(finalUrl), names),
        title: c.title,
        published_at_utc: chosen.published?.toISOString() ?? null,
        modified_at_utc: ts.modified?.toISOString() ?? null,
        timestamp_basis: chosen.basis,
        feed_published_at_utc: c.feedPublishedAt?.toISOString() ?? null,
        collected_at_utc: page.fetchedAt.toISOString(),
        content_sha256: createHash('sha256').update(excerpt).digest('hex'),
        excerpt_chars: excerpt.length,
        mentions,
        discovered_via: c.discoveredVia,
        about_this_fixture: null,
        excerpt,
      });
    }
    const coverage = (s: 'HOME' | 'AWAY') => {
      const d = s === 'HOME' ? dh : da;
      if (articles.some((a) => a.mentions.includes(s))) return 'SEARCHED_FOUND';
      return d.errors.length && !d.candidates.length ? 'FAILED' : 'SEARCHED_NONE_FOUND';
    };

    // 3. extraction
    let run: Record<string, any> = { status: articles.length ? 'NOT_RUN' : 'NO_ARTICLES', model: null, usage: null, est_cost_usd: 0, input_hash: null };
    const signals: NewsSignalRecord[] = [];
    const truncated = new Set<NewsSignalRecord>();
    const rejectedRaw: Array<Record<string, unknown>> = [];
    if (articles.length && call && !aiStopped && cost < usdCap) {
      const squad = (t: TeamCtx) => {
        const inj = injuries.filter((i) => i.team_id === t.id && i.player_name).map((i) => String(i.player_name));
        return [...new Set([...t.roster.filter((r) => r.starts180 > 0).slice(0, 30).map((r) => r.name), ...inj])];
      };
      const input = {
        fixture: { home: f.home, away: f.away, competition: f.league, country: f.league_country, kickoff_utc: f.kickoff_at.toISOString() },
        collected_at_utc: new Date().toISOString(),
        squads: { home: squad(home), away: squad(away) },
        articles: articles.map((a) => ({ article_id: a.ref, source_name: a.source_name, title: a.title, published_at_utc: a.published_at_utc, text: a.excerpt })),
      };
      const inputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      try {
        const res = await call(input);
        const c = costOf(res.usage, price);
        cost += c;
        run = { status: res.refusal ? 'REFUSED' : res.output === null ? 'INVALID' : 'OK', model: res.model, usage: res.usage, est_cost_usd: Math.round(c * 1e5) / 1e5, input_hash: inputHash, stop_reason: res.stopReason };
        const parsed = NewsExtractionSchema.safeParse(res.output);
        if (res.output !== null && !parsed.success) run.status = 'INVALID';
        if (parsed.success) {
          for (const a of parsed.data.articles) {
            const art = articles.find((x) => x.ref === a.article_id);
            if (art) art.about_this_fixture = a.about_this_fixture;
          }
          for (const raw of parsed.data.signals) {
            // a quote a little over 200 characters is cut at a word boundary: still a verbatim passage, noted
            const cut = trimQuote(raw);
            const s = ExtractedSignalSchema.safeParse(cut.raw);
            if (!s.success) {
              rejectedRaw.push({ raw, issues: s.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
              continue;
            }
            const art = articles.find((x) => x.ref === s.data.article_id);
            if (!art) {
              rejectedRaw.push({ raw, issues: ['unknown article_id'] });
              continue;
            }
            const rec = crossMatch(s.data, art, side(s.data.team), injuries, f.id, cutoff);
            if (cut.trimmed) truncated.add(rec);
            signals.push(rec);
          }
        }
      } catch (err) {
        run = { status: 'ERROR', error: String(err).slice(0, 300), model, usage: null, est_cost_usd: 0, input_hash: inputHash };
        if (isPersistentOpenAIError(err)) aiStopped = String(err).slice(0, 200);
      }
    }
    // corroboration across articles, then the final status
    const groups = new Map<string, NewsSignalRecord[]>();
    for (const s of signals) {
      const k = corroborationKey(s, s.player_id);
      groups.set(k, [...(groups.get(k) ?? []), s]);
    }
    for (const s of signals) {
      const others = (groups.get(corroborationKey(s, s.player_id)) ?? []).filter((o) => o !== s && o.source_domain !== s.source_domain && o.quote_verified);
      s.corroborating_domains = [...new Set(others.map((o) => o.source_domain))];
      const art = articles.find((a) => a.ref === s.article_id)!;
      const st = signalStatus({
        signal: s,
        quoteOk: s.quote_verified,
        articleAbout: art.about_this_fixture,
        published: s.published_at_utc ? new Date(s.published_at_utc) : null,
        basis: s.timestamp_basis,
        collected: new Date(s.collected_at_utc),
        cutoff,
        since: side(s.team).prevMatch,
        tier: s.source_tier,
        corroboratedByBetterTier: others.some((o) => o.source_tier !== 'aggregator'),
        playerResolved: s.player_match !== 'UNRESOLVED',
      });
      s.status = st.status;
      s.reasons = truncated.has(s) ? [...st.reasons, 'note:QUOTE_TRUNCATED'] : st.reasons;
    }

    const line = {
      pick_day: date,
      fixture: { id: f.id, home: f.home, away: f.away, league: f.league, country: f.league_country, kickoff_utc: f.kickoff_at.toISOString() },
      priority: p.priority,
      api_injuries: injuries.length,
      league_reports_injuries: p.covered,
      cutoff_utc: cutoff.toISOString(),
      since_utc: since.toISOString(),
      coverage: { home: coverage('HOME'), away: coverage('AWAY') },
      discovery: { queries: [...dh.queries.map((x) => `${f.home}: ${x}`), ...da.queries.map((x) => `${f.away}: ${x}`)], errors: [...dh.errors, ...da.errors], candidates: candidates.length, pages_tried: tries, fetch_failures: fetchFailures },
      ...(google ? { google } : {}),
      articles: articles.map(({ excerpt: _e, ...a }) => a),
      run: { ...run, prompt_version: NEWS_EXTRACT_PROMPT_VERSION, rules_version: NEWS_RULES_VERSION },
      signals,
      rejected_raw: rejectedRaw,
    };
    lines.push(line);
    const elig = signals.filter((s) => s.status === 'ELIGIBLE');
    console.log(`${p.priority} ${f.home} v ${f.away}: ${candidates.length} candidates, ${articles.length} articles, ${run.status}, ${signals.length} signals (${elig.length} eligible, ${elig.filter(isTreatedAbsence).length} novel high-impact absences)`);
  };

  const queue = [...scope];
  await Promise.all(
    Array.from({ length: Math.max(1, Number(values.concurrency)) }, async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        try {
          await one(p);
        } catch (err) {
          console.error(`fixture ${p.f.id} failed: ${String(err).slice(0, 200)}`);
          lines.push({ pick_day: date, fixture: { id: p.f.id, home: p.f.home, away: p.f.away, league: p.f.league }, priority: p.priority, run: { status: 'ERROR', error: String(err).slice(0, 300) }, coverage: { home: 'FAILED', away: 'FAILED' }, signals: [], articles: [] });
        }
      }
    }),
  );
  const finishedAt = new Date();
  for (const p of prepared.slice(scope.length))
    lines.push({ pick_day: date, fixture: { id: p.f.id, home: p.f.home, away: p.f.away, league: p.f.league }, priority: p.priority, run: { status: 'NOT_RUN' }, coverage: { home: 'NOT_RUN', away: 'NOT_RUN' }, signals: [], articles: [] });

  const jsonl = `${dir}/run-${stamp}.jsonl`;
  await writeFile(jsonl, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const md = `${dir}/summary-${stamp}.md`;
  await writeFile(md, summary({ date, cutoff, startedAt, finishedAt, model: useAi ? model! : null, leagues, lines, cost, aiStopped, priceNote: `${price.note}: $${price.input} / $${price.cached} cached / $${price.output} out per 1M tokens` }));
  console.log(`\n${jsonl}\n${md}\nestimated cost $${cost.toFixed(3)}${aiStopped ? `; AI stopped: ${aiStopped}` : ''}`);
  await db.close();
}

/** provenance from the article, the player and team facts from the database; status is set after corroboration */
function crossMatch(s: ExtractedSignal, art: ArticleRec, team: TeamCtx, injuries: InjuryRow[], fixtureId: number, cutoff: Date): NewsSignalRecord {
  const collected = new Date(art.collected_at_utc);
  const teamInj = injuries.filter((i) => i.team_id === team.id);
  const isPlayer = PLAYER_CATEGORIES.includes(s.category);
  let player: RosterPlayer | null = null;
  let match: NewsSignalRecord['player_match'] = null;
  let inApi: InjuryRow | undefined;
  if (isPlayer) {
    const roster: RosterPlayer[] = [...team.roster, ...teamInj.filter((i) => i.player_id !== null).map((i) => ({ playerId: i.player_id!, name: String(i.player_name ?? '') }))];
    const r = resolvePlayer(s.player_name_as_written!, roster);
    player = r.player;
    match = r.match;
    const visible = teamInj.filter((i) => i.first_seen_at <= collected);
    inApi = player ? visible.find((i) => i.player_id === player!.playerId) : undefined;
    if (!inApi && !player) {
      const byName = resolvePlayer(s.player_name_as_written!, visible.filter((i) => i.player_name).map((i, k) => ({ playerId: i.player_id ?? -1 - k, name: String(i.player_name) })));
      if (byName.player) inApi = visible.find((i) => (i.player_id ?? null) === byName.player!.playerId || i.player_name === byName.player!.name);
    }
  }
  const rsPlayer = player ? team.rs.players.find((x) => x.playerId === player!.playerId) : undefined;
  const fig = player ? team.figures.find((x) => x.playerId === player!.playerId) : undefined;
  const recentLineups = isPlayer && player ? team.rs.of : null;
  const recentStarts = isPlayer && player ? (rsPlayer?.starts ?? 0) : null;
  const matchMinutes = team.teamMinutes / 11;
  const minutesShare = fig && matchMinutes > 0 ? Math.round((fig.minutes / matchMinutes) * 1000) / 1000 : player && team.teamMinutes > 0 ? 0 : null;
  const goalShare = fig && team.teamGoals > 0 ? Math.round((fig.goals / team.teamGoals) * 1000) / 1000 : null;
  const lastCoach = team.coaches[0] ?? null;
  let withLast = 0;
  for (const c of team.coaches) if (c && c === lastCoach) withLast++;
  else break;
  const published = art.published_at_utc ? new Date(art.published_at_utc) : null;
  const surname = lastCoach ? fold(lastCoach).split(/[^a-z]+/).filter((t) => t.length > 1).pop() ?? null : null;
  const playedSince = Boolean(published && team.prevMatch && published < team.prevMatch);
  // the change is already in our data when a match was played after the article, or the two last lineups name different coaches
  const changedInLineups = Boolean(team.coaches[0] && team.coaches[1] && team.coaches[0] !== team.coaches[1]);
  const coachAlreadyVisible =
    s.category === 'MANAGER_CHANGE' && (playedSince || changedInLineups || (['APPOINTED', 'INTERIM_APPOINTED'].includes(s.manager_change ?? '') && withLast >= 1 && Boolean(surname && fold(s.evidence_quote).includes(surname))));
  const alreadyInApi = isPlayer ? Boolean(inApi) : null;
  const nov = novelty(s, { alreadyInApi, coachAlreadyVisible });
  const facts = { alreadyInApi, recentStarts, recentLineups, minutesPlayedShare: minutesShare, goalShare };
  return {
    ...s,
    fixture_id: fixtureId,
    team_id: team.id,
    source_url: art.url,
    source_name: art.source_name,
    source_domain: art.domain,
    source_tier: art.tier,
    published_at_utc: art.published_at_utc,
    modified_at_utc: art.modified_at_utc,
    timestamp_basis: art.timestamp_basis,
    collected_at_utc: art.collected_at_utc,
    cutoff_utc: cutoff.toISOString(),
    quote_verified: quoteVerified(s.evidence_quote, art.excerpt ?? ''),
    corroborating_domains: [],
    player_id: player?.playerId ?? null,
    player_name_matched: player?.name ?? null,
    player_match: match,
    already_in_api_injuries: alreadyInApi,
    api_injury_first_seen_at: inApi ? inApi.first_seen_at.toISOString() : null,
    api_injury_type: inApi ? [inApi.type, inApi.reason].filter(Boolean).join(': ') || null : null,
    matched_regular_starter: isPlayer && player ? isRegularStarter(facts) : null,
    recent_starts: recentStarts,
    recent_lineups: recentLineups,
    season_minutes_played_share: isPlayer ? minutesShare : null,
    season_goal_share: isPlayer ? goalShare : null,
    last_lineup_coach: s.category === 'MANAGER_CHANGE' ? lastCoach : null,
    matches_with_last_coach: s.category === 'MANAGER_CHANGE' ? withLast : null,
    novelty: nov,
    impact: impact(s, { ...facts, resolved: Boolean(player), novel: nov === 'NOVEL' }),
    status: 'REJECTED',
    reasons: [],
  };
}

// ---------------------------------------------------------------- summary

function summary(x: { date: string; cutoff: Date; startedAt: Date; finishedAt: Date; model: string | null; leagues: number[]; lines: Array<Record<string, any>>; cost: number; aiStopped: string | null; priceNote: string }): string {
  const L = x.lines;
  const sig: NewsSignalRecord[] = L.flatMap((l) => l.signals ?? []);
  const arts = L.flatMap((l) => l.articles ?? []);
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '–');
  const count = <T,>(xs: T[], k: (t: T) => string) => {
    const m: Record<string, number> = {};
    for (const t of xs) m[k(t)] = (m[k(t)] ?? 0) + 1;
    return Object.entries(m)
      .sort((a, b) => b[1] - a[1])
      .map(([a, b]) => `${a} ${b}`)
      .join(', ');
  };
  const failures: Record<string, number> = {};
  for (const l of L) for (const [k, v] of Object.entries((l.discovery?.fetch_failures ?? {}) as Record<string, number>)) failures[k] = (failures[k] ?? 0) + v;
  const nh = (l: Record<string, any>) => (l.signals as NewsSignalRecord[]).some(isTreatedAbsence);
  const byPri = ['P1', 'P2', 'P3', 'P4']
    .map((p) => {
      const ls = L.filter((l) => l.priority === p);
      return `| ${p} | ${ls.length} | ${ls.filter((l) => (l.articles ?? []).length).length} | ${ls.filter((l) => (l.signals ?? []).some((s: NewsSignalRecord) => s.status === 'ELIGIBLE')).length} | ${ls.filter(nh).length} |`;
    })
    .join('\n');
  const playerSigs = sig.filter((s) => PLAYER_CATEGORIES.includes(s.category));
  const review = sig
    .filter((s) => s.status !== 'REJECTED')
    .sort((a, b) => (a.status === b.status ? 0 : a.status === 'ELIGIBLE' ? -1 : 1));
  const fx = new Map(L.map((l) => [l.fixture.id, l.fixture]));
  const row = (s: NewsSignalRecord, i: number) => {
    const f = fx.get(s.fixture_id);
    const what = [s.category.replace(/_/g, ' ').toLowerCase(), s.severity ?? s.eligibility ?? s.rotation_strength ?? s.manager_change ?? s.disruption].filter(Boolean).join(' / ');
    const who = s.player_name_as_written ? `${s.player_name_as_written}${s.player_name_matched ? ` → ${s.player_name_matched} (${s.player_match}${s.recent_starts !== null ? `, ${s.recent_starts}/${s.recent_lineups} starts` : ''})` : ` (${s.player_match})`}` : '–';
    const esc = (t: string) => t.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    return `| ${i + 1} | ${esc(`${f?.home} v ${f?.away}`)} | ${s.team} | ${esc(what)} | ${esc(who)} | ${s.status}${s.reasons.length ? ` (${s.reasons.join(', ')})` : ''} | ${s.novelty} / ${s.impact} | ${s.source_tier} | ${s.published_at_utc ? thai(new Date(s.published_at_utc)) : '–'} (${s.timestamp_basis}) | ${esc(s.evidence_quote)} | ${esc(s.fact_en)} | [${s.source_domain}](${s.source_url}) | |`;
  };
  const g = L.filter((l) => l.google);
  const gsum = (k: string) => g.reduce((s, l) => s + Number(l.google[k] ?? 0), 0);
  const viaGoogle = arts.filter((a: ArticleRec) => a.discovered_via === 'google-news-rss');
  return `# Grounded news dry run — pick day ${x.date}

Phase 0, read-only (.scratch/grounded-news/spec.md §6). Nothing was written to the database.

- Run: ${thai(x.startedAt)} → ${thai(x.finishedAt)} Thai; cut-off ${thai(x.cutoff)} Thai. **${x.finishedAt <= x.cutoff ? 'Finished before the cut-off: a valid Phase 0 day.' : 'Finished AFTER the cut-off: not a valid Phase 0 day (smoke test only).'}**
- Model: ${x.model ?? 'none (--no-ai)'}; prompt ${NEWS_EXTRACT_PROMPT_VERSION}; rules ${NEWS_RULES_VERSION}; discovery Bing News RSS; user agent "${USER_AGENT}"
- Leagues: ${x.leagues.length}; fixtures in the pick day: ${L.length}; processed: ${L.filter((l) => l.discovery || l.run?.status === 'ERROR').length} (the rest NOT_RUN: --max-fixtures)
- Estimated cost: $${x.cost.toFixed(4)} (${x.priceNote})${x.aiStopped ? `; AI calls stopped: ${x.aiStopped}` : ''}

## Discovery and reading

| | |
|---|---|
| Candidates per fixture (median) | ${median(L.filter((l) => l.discovery).map((l) => l.discovery.candidates))} |
| Fixtures with ≥ 1 article read | ${L.filter((l) => (l.articles ?? []).length).length} of ${L.length} |
| Articles read | ${arts.length} |
| Page failures | ${Object.entries(failures).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'} |
| Timestamp basis | ${count(arts, (a: ArticleRec) => a.timestamp_basis) || '–'} (found: ${pct(arts.filter((a: ArticleRec) => a.timestamp_basis !== 'NONE').length, arts.length)}) |
| Source tiers | ${count(arts, (a: ArticleRec) => a.tier) || '–'} |
| Coverage, team level | ${count(L.flatMap((l) => [l.coverage?.home, l.coverage?.away]), (c) => String(c))} |

## Extraction

| | |
|---|---|
| Calls | ${count(L, (l) => l.run?.status ?? '?')} |
| Signals (schema-valid) | ${sig.length}; schema rejects ${L.reduce((s, l) => s + (l.rejected_raw ?? []).length, 0)} |
| Quote verified | ${pct(sig.filter((s) => s.quote_verified).length, sig.length)} |
| Status | ${count(sig, (s) => s.status) || '–'} |
| Reasons | ${count(sig.flatMap((s) => s.reasons), (r) => r) || '–'} |
| Categories | ${count(sig, (s) => s.category) || '–'} |
| Player resolution | ${count(playerSigs, (s) => String(s.player_match)) || '–'} |
| Eligible: novelty / impact | ${count(sig.filter((s) => s.status === 'ELIGIBLE'), (s) => `${s.novelty}/${s.impact}`) || '–'} |

## Coverage by priority

| Priority | Fixtures | With articles | With ≥ 1 eligible signal | With ≥ 1 novel high-impact absence |
|---|---|---|---|---|
${byPri}
${g.length ? `\n## Google News title bridge\n\nGoogle items ${gsum('items')}; titles not in Bing ${gsum('only_in_google')} (team-news words ${gsum('only_in_google_newsy')}); looked up on Bing ${gsum('bridge_tried')}, found ${gsum('bridge_found')}; articles read through the bridge ${viaGoogle.length}, signals from them ${sig.filter((s) => viaGoogle.some((a: ArticleRec) => a.url === s.source_url)).length}.\n` : ''}
## Review sheet (owner): is each signal what the article says? Mark ✓ / ✗ in the last column

ELIGIBLE first, then UNVERIFIED. REJECTED signals are in the jsonl only.

| # | Match | Team | Signal | Player | Status | Novelty / impact | Tier | Published (Thai) | Quote | fact_en | Source | ✓/✗ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
${review.map(row).join('\n')}
`;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

// ---------------------------------------------------------------- follow-up after the matches (read-only)

async function followup(file: string) {
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
  const rows: string[] = [];
  const tally: Record<string, { n: number; started: number; bench: number; absent: number; noLineup: number }> = {};
  let caught = 0;
  let novelPlayer = 0;
  for (const l of lines) {
    const sigs = (l.signals ?? []) as NewsSignalRecord[];
    const players = sigs.filter((s) => s.status === 'ELIGIBLE' && s.player_id !== null);
    if (!players.length) continue;
    const lp = await q<{ player_id: number; is_starter: boolean }>(`select player_id, is_starter from fixture_lineup_players where fixture_id = $1 and player_id is not null`, [l.fixture.id]);
    const inj = await q<{ player_id: number; first_seen_at: Date }>(`select player_id, first_seen_at from injuries where fixture_id = $1 and player_id is not null`, [l.fixture.id]);
    for (const s of players) {
      const k = s.severity ?? s.eligibility ?? '?';
      const t = (tally[k] ??= { n: 0, started: 0, bench: 0, absent: 0, noLineup: 0 });
      t.n++;
      const row = lp.find((r) => Number(r.player_id) === s.player_id);
      const result = !lp.length ? 'no lineup stored' : row ? (row.is_starter ? 'STARTED' : 'BENCH') : 'NOT IN SQUAD';
      if (!lp.length) t.noLineup++;
      else if (!row) t.absent++;
      else if (row.is_starter) t.started++;
      else t.bench++;
      let api = '–';
      if (s.novelty === 'NOVEL') {
        novelPlayer++;
        const later = inj.find((i) => Number(i.player_id) === s.player_id && new Date(i.first_seen_at) > new Date(s.collected_at_utc));
        if (later) {
          caught++;
          api = `API added it ${Math.round((new Date(later.first_seen_at).getTime() - new Date(s.collected_at_utc).getTime()) / H)} h later`;
        } else api = 'never in API';
      }
      rows.push(`| ${l.fixture.home} v ${l.fixture.away} | ${s.player_name_matched ?? s.player_name_as_written} | ${k} | ${s.novelty} / ${s.impact} | ${result} | ${api} |`);
    }
  }
  const out = `# Grounded news follow-up — ${file}

Eligible player signals against the confirmed lineups (read-only). OUT / SUSPENDED is right when the player is not in the
starting XI; DOUBTFUL has no right answer, only a start rate.

| Signal | n | Started | Bench | Not in squad | No lineup stored |
|---|---|---|---|---|---|
${Object.entries(tally)
  .map(([k, t]) => `| ${k} | ${t.n} | ${t.started} | ${t.bench} | ${t.absent} | ${t.noLineup} |`)
  .join('\n')}

NOVEL player signals later added by API-Football injuries before kickoff: ${caught} of ${novelPlayer}.

| Match | Player | Signal | Novelty / impact | Lineup | API catch-up |
|---|---|---|---|---|---|
${rows.join('\n')}
`;
  const target = file.replace(/run-([^.]+)\.jsonl$/, 'followup-$1.md');
  await writeFile(target, out);
  console.log(target);
  await db.close();
}

main().catch(async (err) => {
  console.error(err);
  await db.close().catch(() => undefined);
  process.exit(1);
});
