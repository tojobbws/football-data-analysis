import 'server-only';
import { webEnv } from './env';
import { db } from './supabase';
import { FINISHED, type Status } from './labels';
import { thaiDayRange } from './time';

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
  goals_home: number | null;
  goals_away: number | null;
  league: { id: number; name: string; logo_url: string | null; country: string | null };
  home: Team;
  away: Team;
  compass: Compass | null;
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
}

const MATCH_SELECT = `id, slug, kickoff_at, status_short, elapsed, goals_home, goals_away,
  league:leagues!fixtures_league_id_fkey(id, name, logo_url, country),
  home:teams!fixtures_home_team_id_fkey(id, name, logo_url),
  away:teams!fixtures_away_team_id_fkey(id, name, logo_url)`;

const COMPASS_SELECT = `fixture_id, public_id, publish_round, kind, market, selection, line, odds_at_publish, model_probability,
  market_probability, signal_strength, reason, published_at, status, result_score, settled_at, record_hash`;

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

// ---------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------

export async function matchesOnDay(date: string): Promise<MatchRow[]> {
  const { from, to } = thaiDayRange(date);
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
  const compass = await compassFor(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, compass: compass.get(r.id) ?? null }));
}

/** Next days that have matches (for the date strip), starting at `date`. */
export async function matchDayCounts(fromDate: string, days: number): Promise<Map<string, number>> {
  const { from } = thaiDayRange(fromDate);
  const to = new Date(new Date(from).getTime() + days * 86_400_000).toISOString();
  const { data, error } = await db().from('fixtures').select('kickoff_at').in('league_id', webEnv().leagues).gte('kickoff_at', from).lt('kickoff_at', to);
  if (error) fail('fixtures', error);
  const out = new Map<string, number>();
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' });
  for (const r of data ?? []) {
    const d = fmt.format(new Date(r.kickoff_at as string));
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

export async function matchBySlug(slug: string) {
  const sb = db();
  const { data: f, error } = await sb
    .from('fixtures')
    .select(`${MATCH_SELECT}, season, round, referee, league_id, home_team_id, away_team_id, ht_home, ht_away, ft_home, ft_away,
      venue:venues!fixtures_venue_id_fkey(name, city)`)
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
    venue: { name: string | null; city: string | null } | null;
  };

  const finished = FINISHED.includes(m.status_short);
  const [rounds, snapshot, formHome, formAway, h2h, standings, injuries, lineups, market, stats, events] = await Promise.all([
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
  ]);
  for (const [name, r] of Object.entries({ rounds, snapshot, h2h, standings, injuries, lineups, market, stats, events })) if (r.error) fail(name, r.error);

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
  };
}

/** Last 5 finished matches of a team before `before`, with xG when available. */
async function teamForm(teamId: number, before: string): Promise<FormRow[]> {
  const sb = db();
  const { data, error } = await sb
    .from('fixtures')
    .select('id, slug, kickoff_at, home_team_id, away_team_id, ft_home, ft_away, goals_home, goals_away, home:teams!fixtures_home_team_id_fkey(name), away:teams!fixtures_away_team_id_fkey(name)')
    .or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`)
    .in('status_short', FINISHED)
    .lt('kickoff_at', before)
    .order('kickoff_at', { ascending: false })
    .limit(5);
  if (error) fail('form', error);
  const rows = (data ?? []) as unknown as Array<{ id: number; slug: string; kickoff_at: string; home_team_id: number; away_team_id: number; ft_home: number | null; ft_away: number | null; goals_home: number | null; goals_away: number | null; home: { name: string }; away: { name: string } }>;
  const ids = rows.map((r) => r.id);
  const xg = new Map<string, number>();
  if (ids.length) {
    const { data: s, error: e2 } = await sb.from('fixture_statistics').select('fixture_id, team_id, value_num').eq('type', 'expected_goals').in('fixture_id', ids);
    if (e2) fail('xg', e2);
    for (const x of s ?? []) if (x.value_num != null) xg.set(`${x.fixture_id}:${x.team_id}`, Number(x.value_num));
  }
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
