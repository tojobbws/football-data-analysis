import 'server-only';
import { cache } from 'react';
import type { OutcomeDistribution } from '@fp/analysis';
import { webEnv } from './env';
import { db } from './supabase';
import { FINISHED, LIVE, type Status } from './labels';
import { liveSince, type LiveSnapshot, type LiveState } from './live';
import { addDaysStr, footballDate, footballDayRange, thaiDate, thaiDayRange } from './time';

// ---------------------------------------------------------------------------
// Types (what the pages render)
// ---------------------------------------------------------------------------

export interface Team {
  id: number;
  name: string;
  logo_url: string | null;
}

export interface MatchRow {
  id: number;
  slug: string;
  kickoff_at: string;
  status_short: string;
  elapsed: number | null;
  elapsed_extra: number | null;
  goals_home: number | null;
  goals_away: number | null;
  league: { id: number; name: string; logo_url: string | null; country: string | null };
  home: Team;
  away: Team;
  compass: Compass | null;
  /** 🔎 one-line teaser of the written preview (list pages) */
  preview?: { overview_th: string; data_support: DataSupport } | null;
}

export type DataSupport = 'GOOD' | 'LIMITED' | 'THIN';

/** 🔎 วิเคราะห์เกม — written preview, latest stage per fixture, stored before kickoff and immutable. */
export interface MatchPreview {
  stage: 'EARLY' | 'LINEUP';
  text_source: 'AI' | 'TEMPLATE';
  ai_status: string;
  data_support: DataSupport;
  data_notes: string[];
  predicted_home: number | null;
  predicted_away: number | null;
  predicted_p: number | null;
  expected_home: number | null;
  expected_away: number | null;
  p_home: number | null;
  p_draw: number | null;
  p_away: number | null;
  /** goal bands (total goals 0–1 / 2 / 3+); null on previews written before preview-v0.5 */
  p_goals_0_1: number | null;
  p_goals_2: number | null;
  p_goals_3plus: number | null;
  overview_th: string;
  home_th: string;
  away_th: string;
  score_th: string;
  created_at: string;
}

const PREVIEW_SELECT = `fixture_id, stage, text_source, ai_status, data_support, data_notes, predicted_home, predicted_away, predicted_p,
  expected_home, expected_away, p_home, p_draw, p_away, overview_th, home_th, away_th, score_th, created_at,
  p_goals_0_1, p_goals_2, p_goals_3plus`;

async function previewsFor(fixtureIds: number[]): Promise<Map<number, MatchRow['preview']>> {
  const out = new Map<number, MatchRow['preview']>();
  if (!fixtureIds.length) return out;
  const { data, error } = await db().from('web_match_previews').select('fixture_id, overview_th, data_support').in('fixture_id', fixtureIds);
  if (error) fail('web_match_previews', error);
  for (const r of data ?? []) out.set(Number(r.fixture_id), { overview_th: String(r.overview_th), data_support: r.data_support as DataSupport });
  return out;
}

export interface Compass {
  public_id: string;
  publish_round: string;
  kind: 'SIGNAL' | 'NO_CLEAR_SIGNAL';
  market: string | null;
  selection: string | null;
  line: number | null;
  odds_at_publish: number | null;
  model_probability: number | null;
  market_probability: number | null;
  signal_strength: string | null;
  reason: string | null;
  published_at: string;
  status: Status;
  result_score: string | null;
  settled_at: string | null;
  record_hash: string;
  /** model's chance of each outcome (null on fog rounds) */
  model_distribution: OutcomeDistribution | null;
}

const MATCH_SELECT = `id, slug, kickoff_at, status_short, elapsed, elapsed_extra, goals_home, goals_away,
  league:leagues!fixtures_league_id_fkey(id, name, logo_url, country),
  home:teams!fixtures_home_team_id_fkey(id, name, logo_url),
  away:teams!fixtures_away_team_id_fkey(id, name, logo_url)`;

const COMPASS_SELECT = `fixture_id, public_id, publish_round, kind, market, selection, line, odds_at_publish, model_probability,
  market_probability, signal_strength, reason, published_at, status, result_score, settled_at, record_hash, model_distribution`;

function fail(what: string, error: { message: string } | null): never {
  throw new Error(`${what}: ${error?.message ?? 'unknown error'}`);
}

/** Latest published round per fixture (LINEUP supersedes EARLY on the page; both stay in the record). */
async function compassFor(fixtureIds: number[]): Promise<Map<number, Compass>> {
  const out = new Map<number, Compass>();
  if (!fixtureIds.length) return out;
  const { data, error } = await db().from('analysis_predictions').select(COMPASS_SELECT).in('fixture_id', fixtureIds).order('published_at', { ascending: true });
  if (error) fail('analysis_predictions', error);
  for (const r of data ?? []) out.set(Number(r.fixture_id), r as unknown as Compass);
  return out;
}

/** A match's written preview as a card (home "บทวิเคราะห์ล่าสุด", /analysis). */
export interface PreviewCard {
  slug: string;
  kickoff_at: string;
  league: string;
  home: string;
  away: string;
  overview_th: string;
  data_support: DataSupport;
}

/**
 * Matches that have a written preview: `upcoming` = kicking off from now, soonest first;
 * `recent` = already kicked off, latest first. Only the leagues the site shows.
 */
export async function previewCards(when: 'upcoming' | 'recent', limit: number): Promise<PreviewCard[]> {
  const now = new Date().toISOString();
  let q = db().from('fixtures').select(MATCH_SELECT).in('league_id', webEnv().leagues);
  q = when === 'upcoming' ? q.gte('kickoff_at', now).order('kickoff_at') : q.lt('kickoff_at', now).order('kickoff_at', { ascending: false });
  const { data, error } = await q.limit(Math.max(60, limit * 4));
  if (error) fail('fixtures', error);
  const rows = (data ?? []) as unknown as MatchRow[];
  const previews = await previewsFor(rows.map((r) => r.id));
  return rows
    .filter((r) => previews.get(r.id))
    .slice(0, limit)
    .map((r) => ({
      slug: r.slug,
      kickoff_at: r.kickoff_at,
      league: r.league.name,
      home: r.home.name,
      away: r.away.name,
      overview_th: previews.get(r.id)!.overview_th,
      data_support: previews.get(r.id)!.data_support,
    }));
}

// ---------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------

/** Matches of one football day (06:00 → 06:00 Thai time) — the scoreboard views and /today. */
export async function matchesOnFootballDay(date: string): Promise<MatchRow[]> {
  const { from, to } = footballDayRange(date);
  return matchesBetween(from, to);
}

async function matchesBetween(from: string, to: string): Promise<MatchRow[]> {
  const { data, error } = await db()
    .from('fixtures')
    .select(MATCH_SELECT)
    .in('league_id', webEnv().leagues)
    .gte('kickoff_at', from)
    .lt('kickoff_at', to)
    .order('kickoff_at')
    .order('id');
  if (error) fail('fixtures', error);
  const rows = (data ?? []) as unknown as Omit<MatchRow, 'compass'>[];
  const ids = rows.map((r) => r.id);
  const [compass, previews] = await Promise.all([compassFor(ids), previewsFor(ids)]);
  return rows.map((r) => ({ ...r, compass: compass.get(r.id) ?? null, preview: previews.get(r.id) ?? null }));
}

/** Next days that have matches (for the date strip), starting at `date`. */
/** Matches per football day (06:00 → 06:00 Thai time) for `days` football days from `fromDate`. */
export async function matchDayCounts(fromDate: string, days: number): Promise<Map<string, number>> {
  const { from } = footballDayRange(fromDate);
  const to = new Date(new Date(from).getTime() + days * 86_400_000).toISOString();
  const { data, error } = await db().from('fixtures').select('kickoff_at').in('league_id', webEnv().leagues).gte('kickoff_at', from).lt('kickoff_at', to);
  if (error) fail('fixtures', error);
  const out = new Map<string, number>();
  for (const r of data ?? []) {
    const d = footballDate(new Date(r.kickoff_at as string));
    out.set(d, (out.get(d) ?? 0) + 1);
  }
  return out;
}

/** Upcoming 🧭 signals (published, not started), soonest first. */
export async function upcomingSignals(limit = 6) {
  const { data, error } = await db()
    .from('published_analysis')
    .select('public_id, fixture_slug, kickoff_at, league_name, home_team, away_team, market, selection, line, model_probability, market_probability, odds_at_publish, signal_strength, publish_round')
    .eq('kind', 'SIGNAL')
    .eq('status', 'PENDING')
    .gt('kickoff_at', new Date().toISOString())
    .order('kickoff_at')
    .limit(limit * 2);
  if (error) fail('published_analysis', error);
  // one card per match (LINEUP round supersedes EARLY)
  const seen = new Map<string, NonNullable<typeof data>[number]>();
  for (const r of data ?? []) {
    const prev = seen.get(r.fixture_slug);
    if (!prev || r.publish_round === 'LINEUP') seen.set(r.fixture_slug, r);
  }
  return [...seen.values()].slice(0, limit);
}

// ---------------------------------------------------------------------------
// Match detail
// ---------------------------------------------------------------------------

export interface FormRow {
  slug: string;
  kickoff_at: string;
  venue: 'H' | 'A';
  opponent: string;
  gf: number;
  ga: number;
  result: 'W' | 'D' | 'L';
  xgFor: number | null;
  xgAgainst: number | null;
}

/** One request = one read: generateMetadata and the page share it (React cache). */
export const matchBySlug = cache(async (slug: string) => {
  const sb = db();
  const { data: f, error } = await sb
    .from('fixtures')
    .select(`${MATCH_SELECT}, season, round, referee, league_id, home_team_id, away_team_id, ht_home, ht_away, ft_home, ft_away,
      venue:venues!fixtures_venue_id_fkey(name, city, image_url),
      home_ground:teams!fixtures_home_team_id_fkey(venue:venues(image_url))`)
    .eq('slug', slug)
    .maybeSingle();
  if (error) fail('fixture', error);
  if (!f) return null;
  const m = f as unknown as Omit<MatchRow, 'compass'> & {
    season: number;
    round: string | null;
    referee: string | null;
    league_id: number;
    home_team_id: number;
    away_team_id: number;
    ht_home: number | null;
    ht_away: number | null;
    ft_home: number | null;
    ft_away: number | null;
    venue: { name: string | null; city: string | null; image_url: string | null } | null;
    /** The home team's own stadium; backs the header photo when the fixture venue has none. */
    home_ground: { venue: { image_url: string | null } | null } | null;
  };

  const finished = FINISHED.includes(m.status_short);
  const [rounds, snapshot, formHome, formAway, h2h, standings, injuries, lineups, market, stats, events, outlook, preview] = await Promise.all([
    sb.from('analysis_predictions').select(COMPASS_SELECT).eq('fixture_id', m.id).order('published_at'),
    sb
      .from('analysis_predictions')
      .select('publish_round, analysis_snapshots(xg_snapshot, candidates_snapshot, model_snapshot, created_at, snapshot_hash)')
      .eq('fixture_id', m.id)
      .order('published_at', { ascending: false })
      .limit(1),
    teamForm(m.home_team_id, m.kickoff_at),
    teamForm(m.away_team_id, m.kickoff_at),
    sb
      .from('fixtures')
      .select('slug, kickoff_at, home_team_id, away_team_id, ft_home, ft_away, goals_home, goals_away, home:teams!fixtures_home_team_id_fkey(name), away:teams!fixtures_away_team_id_fkey(name)')
      .in('status_short', FINISHED)
      .lt('kickoff_at', m.kickoff_at)
      .or(`and(home_team_id.eq.${m.home_team_id},away_team_id.eq.${m.away_team_id}),and(home_team_id.eq.${m.away_team_id},away_team_id.eq.${m.home_team_id})`)
      .order('kickoff_at', { ascending: false })
      .limit(5),
    sb
      .from('standings')
      .select('team_id, rank, points, played, win, draw, lose, goals_for, goals_against, form, group_name')
      .eq('league_id', m.league_id)
      .eq('season', m.season)
      .in('team_id', [m.home_team_id, m.away_team_id]),
    sb.from('injuries').select('team_id, player_name, type, reason').eq('fixture_id', m.id),
    sb.from('fixture_lineup_players').select('team_id, player_name, number, position, is_starter').eq('fixture_id', m.id).order('is_starter', { ascending: false }),
    sb.from('web_market_consensus').select('market, selection, line, bookmakers, opening_odds, current_odds, last_quote_at').eq('fixture_id', m.id),
    finished ? sb.from('fixture_statistics').select('team_id, type, value_num, value_text').eq('fixture_id', m.id) : Promise.resolve({ data: [], error: null }),
    finished ? sb.from('fixture_events').select('elapsed, extra, team_id, player_name, type, detail').eq('fixture_id', m.id).order('seq') : Promise.resolve({ data: [], error: null }),
    sb.from('web_model_outlook').select('computed_at, p_home, p_draw, p_away, p_over25, sides_tested, totals_tested').eq('fixture_id', m.id).maybeSingle(),
    sb.from('web_match_previews').select(PREVIEW_SELECT).eq('fixture_id', m.id).maybeSingle(),
  ]);
  for (const [name, r] of Object.entries({ rounds, snapshot, h2h, standings, injuries, lineups, market, stats, events, outlook, preview })) if (r.error) fail(name, r.error);

  const snapRow = (snapshot.data?.[0] as { analysis_snapshots?: unknown } | undefined)?.analysis_snapshots;
  return {
    match: m,
    finished,
    rounds: (rounds.data ?? []) as unknown as Compass[],
    snapshot: (Array.isArray(snapRow) ? snapRow[0] : snapRow) as
      | { xg_snapshot: unknown; candidates_snapshot: unknown; model_snapshot: unknown; created_at: string; snapshot_hash: string }
      | null
      | undefined,
    form: { home: formHome, away: formAway },
    h2h: (h2h.data ?? []) as unknown as Array<{ slug: string; kickoff_at: string; home_team_id: number; ft_home: number | null; ft_away: number | null; goals_home: number | null; goals_away: number | null; home: { name: string }; away: { name: string } }>,
    standings: (standings.data ?? []) as Array<{ team_id: number; rank: number; points: number; played: number; win: number; draw: number; lose: number; goals_for: number; goals_against: number; form: string | null }>,
    injuries: (injuries.data ?? []) as Array<{ team_id: number; player_name: string | null; type: string | null; reason: string | null }>,
    lineups: (lineups.data ?? []) as Array<{ team_id: number; player_name: string | null; number: number | null; position: string | null; is_starter: boolean }>,
    market: (market.data ?? []) as Array<{ market: string; selection: string; line: number | null; bookmakers: number; opening_odds: number | null; current_odds: number | null; last_quote_at: string }>,
    stats: (stats.data ?? []) as Array<{ team_id: number; type: string; value_num: number | null; value_text: string | null }>,
    events: (events.data ?? []) as Array<{ elapsed: number | null; extra: number | null; team_id: number | null; player_name: string | null; type: string; detail: string | null }>,
    outlook: (outlook.data ?? null) as ModelOutlook | null,
    preview: (preview.data ?? null) as MatchPreview | null,
  };
});

/** 📊 มุมมองโมเดล: last model probabilities computed before kickoff (information, not a 🧭 pick). */
export interface ModelOutlook {
  computed_at: string;
  p_home: number | null;
  p_draw: number | null;
  p_away: number | null;
  p_over25: number | null;
  /** the league's model passed `model:tune` for this market */
  sides_tested: boolean;
  totals_tested: boolean;
}

export interface ModelOutlookScore {
  tested: boolean;
  matches: number;
  correct: number;
  expected_rate: number | null;
  ou_matches: number;
  ou_correct: number;
  ou_expected_rate: number | null;
}

/** How the model outlook did on finished matches, split by tested / not tested leagues. */
export async function modelOutlookPerformance(): Promise<ModelOutlookScore[]> {
  const { data, error } = await db().from('web_model_outlook_performance').select('*');
  if (error) fail('model outlook performance', error);
  return ((data ?? []) as ModelOutlookScore[]).sort((a, b) => Number(b.tested) - Number(a.tested));
}

/** Last 5 finished matches of a team before `before`, with xG when available. */
async function teamForm(teamId: number, before: string): Promise<FormRow[]> {
  const sb = db();
  const { data, error } = await sb
    .from('fixtures')
    // xG rides along as an embedded resource: one round trip instead of two (the DB is far away)
    .select('id, slug, kickoff_at, home_team_id, away_team_id, ft_home, ft_away, goals_home, goals_away, home:teams!fixtures_home_team_id_fkey(name), away:teams!fixtures_away_team_id_fkey(name), xg:fixture_statistics(team_id, value_num)')
    .eq('xg.type', 'expected_goals')
    .or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`)
    .in('status_short', FINISHED)
    .lt('kickoff_at', before)
    .order('kickoff_at', { ascending: false })
    .limit(5);
  if (error) fail('form', error);
  const rows = (data ?? []) as unknown as Array<{ id: number; slug: string; kickoff_at: string; home_team_id: number; away_team_id: number; ft_home: number | null; ft_away: number | null; goals_home: number | null; goals_away: number | null; home: { name: string }; away: { name: string }; xg: Array<{ team_id: number; value_num: number | null }> }>;
  const xg = new Map<string, number>();
  for (const r of rows) for (const x of r.xg ?? []) if (x.value_num != null) xg.set(`${r.id}:${x.team_id}`, Number(x.value_num));
  return rows.map((r) => {
    const home = r.home_team_id === teamId;
    const gh = r.ft_home ?? r.goals_home ?? 0;
    const ga = r.ft_away ?? r.goals_away ?? 0;
    const gf = home ? gh : ga;
    const gaa = home ? ga : gh;
    const oppId = home ? r.away_team_id : r.home_team_id;
    return {
      slug: r.slug,
      kickoff_at: r.kickoff_at,
      venue: home ? 'H' : 'A',
      opponent: home ? r.away.name : r.home.name,
      gf,
      ga: gaa,
      result: gf > gaa ? 'W' : gf < gaa ? 'L' : 'D',
      xgFor: xg.get(`${r.id}:${teamId}`) ?? null,
      xgAgainst: xg.get(`${r.id}:${oppId}`) ?? null,
    } satisfies FormRow;
  });
}

// ---------------------------------------------------------------------------
// 📊 Performance
// ---------------------------------------------------------------------------

export interface PerfBucket {
  dimension: string;
  bucket: string;
  total_signals: number;
  no_signal: number;
  pending: number;
  win: number;
  half_win: number;
  loss: number;
  half_loss: number;
  push: number;
  void: number;
  win_rate: number | null;
  avg_clv: number | null;
  beat_closing_rate: number | null;
}

export async function performance() {
  const sb = db();
  const [perf, recent, leagues] = await Promise.all([
    sb.from('analysis_performance').select('*'),
    sb
      .from('published_analysis')
      .select('public_id, fixture_slug, kickoff_at, published_at, publish_round, league_name, home_team, away_team, kind, market, selection, line, odds_at_publish, model_probability, signal_strength, status, result_score, settled_at, record_hash')
      .order('kickoff_at', { ascending: false })
      .order('publish_round', { ascending: false })
      .limit(200),
    sb.from('leagues').select('id, name').in('id', webEnv().leagues),
  ]);
  for (const [name, r] of Object.entries({ perf, recent, leagues })) if (r.error) fail(name, r.error);
  return {
    buckets: (perf.data ?? []).map((r) => {
      const x: Record<string, unknown> = { ...r };
      for (const k of ['total_signals', 'no_signal', 'pending', 'win', 'half_win', 'loss', 'half_loss', 'push', 'void']) x[k] = Number(r[k] ?? 0);
      for (const k of ['win_rate', 'avg_clv', 'beat_closing_rate']) x[k] = r[k] == null ? null : Number(r[k]);
      return x as unknown as PerfBucket;
    }),
    recent: (recent.data ?? []) as Array<{
      public_id: string;
      fixture_slug: string;
      kickoff_at: string;
      published_at: string;
      publish_round: string;
      league_name: string;
      home_team: string;
      away_team: string;
      kind: string;
      market: string | null;
      selection: string | null;
      line: number | null;
      odds_at_publish: number | null;
      model_probability: number | null;
      signal_strength: string | null;
      status: Status;
      result_score: string | null;
      settled_at: string | null;
      record_hash: string;
    }>,
    leagueNames: new Map((leagues.data ?? []).map((l) => [String(l.id), String(l.name)])),
  };
}

// ---------------------------------------------------------------------------
// Home page
// ---------------------------------------------------------------------------

export interface TickerMatch {
  id: number;
  slug: string;
  kickoff_at: string;
  status_short: string;
  elapsed: number | null;
  elapsed_extra: number | null;
  goals_home: number | null;
  goals_away: number | null;
  home: Team;
  away: Team;
}

/**
 * Score strip in the site header: live matches first, then today's (Thai time) fixtures in kickoff order;
 * when today has none, the next day that does. Never throws: the header must not take the page down.
 */
export async function tickerMatches(limit = 24): Promise<{ day: string | null; matches: TickerMatch[] }> {
  try {
    const sel = `id, slug, kickoff_at, status_short, elapsed, elapsed_extra, goals_home, goals_away,
      home:teams!fixtures_home_team_id_fkey(id, name, logo_url),
      away:teams!fixtures_away_team_id_fkey(id, name, logo_url)`;
    const sb = db();
    const leagues = webEnv().leagues;
    const today = thaiDate();
    const { from, to } = thaiDayRange(today);
    const [live, day] = await Promise.all([
      sb.from('fixtures').select(sel).in('league_id', leagues).in('status_short', LIVE).gte('kickoff_at', liveSince()).order('kickoff_at'),
      sb.from('fixtures').select(sel).in('league_id', leagues).gte('kickoff_at', from).lt('kickoff_at', to).order('kickoff_at').limit(limit),
    ]);
    let rows = (day.data ?? []) as unknown as TickerMatch[];
    let shown: string | null = today;
    if (!rows.length) {
      const next = await sb.from('fixtures').select(sel).in('league_id', leagues).gte('kickoff_at', to).order('kickoff_at').limit(limit);
      rows = (next.data ?? []) as unknown as TickerMatch[];
      shown = rows[0] ? thaiDate(new Date(rows[0].kickoff_at)) : null;
      rows = rows.filter((r) => thaiDate(new Date(r.kickoff_at)) === shown);
    }
    const liveRows = (live.data ?? []) as unknown as TickerMatch[];
    const seen = new Set(liveRows.map((r) => r.slug));
    return { day: shown, matches: [...liveRows, ...rows.filter((r) => !seen.has(r.slug))].slice(0, limit) };
  } catch {
    return { day: null, matches: [] };
  }
}

/**
 * /api/live: matches in play plus those that finished in the last 15 minutes (so open pages see FT),
 * only the fields that move during a game. One response for every page: it is cached at the edge.
 */
export async function liveSnapshot(): Promise<LiveSnapshot> {
  const now = new Date();
  const sel = 'id, status_short, elapsed, elapsed_extra, goals_home, goals_away';
  const sb = db();
  const leagues = webEnv().leagues;
  const [live, done] = await Promise.all([
    sb.from('fixtures').select(sel).in('league_id', leagues).in('status_short', LIVE).gte('kickoff_at', liveSince(now.getTime())),
    sb
      .from('fixtures')
      .select(sel)
      .in('league_id', leagues)
      .in('status_short', FINISHED)
      .gte('synced_at', new Date(now.getTime() - 15 * 60_000).toISOString())
      .gte('kickoff_at', new Date(now.getTime() - 6 * 3_600_000).toISOString()),
  ]);
  if (live.error) fail('fixtures (live)', live.error);
  if (done.error) fail('fixtures (just finished)', done.error);
  return { at: now.toISOString(), matches: [...(live.data ?? []), ...(done.data ?? [])] as LiveState[] };
}

/** Matches in play right now (tracked leagues). */
export async function liveMatches(): Promise<MatchRow[]> {
  const { data, error } = await db()
    .from('fixtures')
    .select(MATCH_SELECT)
    .in('league_id', webEnv().leagues)
    .in('status_short', LIVE)
    .gte('kickoff_at', liveSince())
    .order('kickoff_at')
    .order('id');
  if (error) fail('fixtures', error);
  const rows = (data ?? []) as unknown as Omit<MatchRow, 'compass'>[];
  const compass = await compassFor(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, compass: compass.get(r.id) ?? null }));
}

export interface WeekPerf {
  /** Monday of the week (YYYY-MM-DD, Thai time) */
  week: string;
  settled: number;
  win_rate: number | null;
}

/**
 * Win rate per week (by kickoff, Thai time) for settled 🧭 signals, oldest first.
 * Same formula as analysis_performance: HALF counts half, PUSH/VOID excluded.
 */
export async function weeklyPerformance(weeks = 8): Promise<WeekPerf[]> {
  const thisMonday = mondayOf(thaiDate());
  const firstMonday = addDaysStr(thisMonday, -7 * (weeks - 1));
  const { data, error } = await db()
    .from('published_analysis')
    .select('kickoff_at, status')
    .eq('kind', 'SIGNAL')
    .neq('status', 'PENDING')
    .gte('kickoff_at', thaiDayRange(firstMonday).from);
  if (error) fail('published_analysis', error);
  const out = Array.from({ length: weeks }, (_, i) => ({ week: addDaysStr(firstMonday, 7 * i), w: 0, l: 0, settled: 0 }));
  const weight: Partial<Record<Status, [number, number]>> = { WIN: [1, 0], LOSS: [0, 1], HALF_WIN: [0.5, 0], HALF_LOSS: [0, 0.5] };
  for (const r of data ?? []) {
    const b = out.find((x) => x.week === mondayOf(thaiDate(new Date(r.kickoff_at as string))));
    if (!b) continue;
    b.settled++;
    const [w, l] = weight[r.status as Status] ?? [0, 0];
    b.w += w;
    b.l += l;
  }
  return out.map((b) => ({ week: b.week, settled: b.settled, win_rate: b.w + b.l > 0 ? b.w / (b.w + b.l) : null }));
}

function mondayOf(date: string): string {
  const dow = new Date(`${date}T12:00:00+07:00`).getUTCDay();
  return addDaysStr(date, -((dow + 6) % 7));
}

/** The 'all' row of analysis_performance. */
export async function perfSummary(): Promise<PerfBucket | null> {
  const { data, error } = await db().from('analysis_performance').select('*').eq('dimension', 'all').maybeSingle();
  if (error) fail('analysis_performance', error);
  if (!data) return null;
  const x: Record<string, unknown> = { ...data };
  for (const k of ['total_signals', 'no_signal', 'pending', 'win', 'half_win', 'loss', 'half_loss', 'push', 'void']) x[k] = Number(data[k] ?? 0);
  for (const k of ['win_rate', 'avg_clv', 'beat_closing_rate']) x[k] = data[k] == null ? null : Number(data[k]);
  return x as unknown as PerfBucket;
}

export interface ArticleCard {
  slug: string;
  title: string;
  description: string | null;
  og_image_url: string | null;
  published_at: string;
  fixture_id: number | null;
  category: { slug: string; name: string } | null;
}

/** Latest published articles (anon only sees PUBLISHED via RLS). */
export async function latestArticles(limit = 6): Promise<ArticleCard[]> {
  const { data, error } = await db()
    .from('articles')
    .select('slug, title, description, og_image_url, published_at, fixture_id, category:article_categories(slug, name)')
    .eq('status', 'PUBLISHED')
    .order('published_at', { ascending: false })
    .limit(limit);
  if (error) fail('articles', error);
  return (data ?? []) as unknown as ArticleCard[];
}

export interface LeagueInfo {
  id: number;
  name: string;
  logo_url: string | null;
  country: string | null;
  /** API-Football league type: 'League' or 'Cup' */
  type: string | null;
}

export interface StandingRow {
  rank: number;
  team: Team;
  played: number;
  goals_diff: number;
  points: number;
}

export interface ScorerRow {
  player: string;
  photo_url: string | null;
  team: Team;
  goals: number;
  assists: number;
}

export interface LeagueWidget {
  league: LeagueInfo;
  standings: StandingRow[];
  scorers: ScorerRow[];
}

/**
 * Per tracked league (current season): standings and top scorers.
 * Leagues played in groups (e.g. Nations League) get no standings here.
 */
export async function leagueWidgets(scorers = 5): Promise<LeagueWidget[]> {
  const sb = db();
  const ids = webEnv().leagues;
  const [leagues, seasons] = await Promise.all([
    sb.from('leagues').select('id, name, logo_url, country, type').in('id', ids),
    sb.from('league_seasons').select('league_id, season').eq('is_current', true).in('league_id', ids),
  ]);
  for (const [name, r] of Object.entries({ leagues, seasons })) if (r.error) fail(name, r.error);
  const season = new Map((seasons.data ?? []).map((s) => [Number(s.league_id), Number(s.season)]));
  const years = [...new Set(season.values())];
  const current = (r: { league_id: unknown; season: unknown }) => season.get(Number(r.league_id)) === Number(r.season);

  const [st, ps] = await Promise.all([
    sb.from('standings').select('league_id, season, group_name, team_id, rank, played, goals_diff, points').in('league_id', ids).in('season', years),
    sb
      .from('player_season_stats')
      .select('player_id, team_id, league_id, season, goals, assists, player:players(name, photo_url)')
      .in('league_id', ids)
      .in('season', years)
      .gt('goals', 0),
  ]);
  for (const [name, r] of Object.entries({ st, ps })) if (r.error) fail(name, r.error);
  const stRows = (st.data ?? []).filter(current);
  const psRows = (
    (ps.data ?? []) as unknown as Array<{ player_id: number; team_id: number; league_id: number; season: number; goals: number; assists: number | null; player: { name: string; photo_url: string | null } | null }>
  ).filter(current);

  const teamIds = [...new Set([...stRows.map((r) => Number(r.team_id)), ...psRows.map((r) => Number(r.team_id))])];
  const teams = new Map<number, Team>();
  if (teamIds.length) {
    const { data, error } = await sb.from('teams').select('id, name, logo_url').in('id', teamIds);
    if (error) fail('teams', error);
    for (const t of data ?? []) teams.set(Number(t.id), t as Team);
  }
  const team = (id: number): Team => teams.get(id) ?? { id, name: `#${id}`, logo_url: null };

  const order = new Map(ids.map((id, i) => [id, i]));
  return ((leagues.data ?? []) as LeagueInfo[])
    .sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99))
    .map((league) => {
      const rows = stRows.filter((r) => Number(r.league_id) === league.id);
      const standings =
        new Set(rows.map((r) => r.group_name)).size === 1
          ? rows
              .map((r) => ({ rank: Number(r.rank), team: team(Number(r.team_id)), played: Number(r.played ?? 0), goals_diff: Number(r.goals_diff ?? 0), points: Number(r.points ?? 0) }))
              .sort((a, b) => a.rank - b.rank)
          : [];
      // a player who moved clubs mid-season has one row per team: sum them, show the latest club
      const byPlayer = new Map<number, Omit<ScorerRow, 'team'> & { teamId: number }>();
      for (const r of psRows.filter((x) => Number(x.league_id) === league.id)) {
        const p = byPlayer.get(r.player_id) ?? { player: r.player?.name ?? `#${r.player_id}`, photo_url: r.player?.photo_url ?? null, goals: 0, assists: 0, teamId: r.team_id };
        p.goals += Number(r.goals ?? 0);
        p.assists += Number(r.assists ?? 0);
        p.teamId = r.team_id;
        byPlayer.set(r.player_id, p);
      }
      const top = [...byPlayer.values()]
        .sort((a, b) => b.goals - a.goals || b.assists - a.assists)
        .slice(0, scorers)
        .map(({ teamId, ...p }) => ({ ...p, team: team(teamId) }));
      return { league, standings, scorers: top };
    });
}
