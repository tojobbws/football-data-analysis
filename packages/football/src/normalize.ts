/**
 * Pure mappers: API-Football response -> database rows (snake_case = column names).
 * No I/O here, so everything is unit-testable.
 */
import type {
  FixtureItem,
  InjuryItem,
  LeagueItem,
  PlayerItem,
  PredictionItem,
  StandingsItem,
  TeamItem,
  TeamRef,
} from './types.js';

export type Row = Record<string, unknown>;

export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9฀-๿]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

/** /matches/liverpool-vs-arsenal-2026-10-18 (date keeps it unique across seasons/cups) */
export function fixtureSlug(home: string, away: string, kickoffIso: string): string {
  return `${slugify(home)}-vs-${slugify(away)}-${kickoffIso.slice(0, 10)}`;
}

/** "55%" -> 55, "1.23" -> 1.23, 7 -> 7, null -> null */
export function parseNumeric(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace('%', '').trim());
  return Number.isFinite(n) ? n : null;
}

export function statKey(type: string): string {
  return type
    .trim()
    .toLowerCase()
    .replace(/%/g, ' pct')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** API-Football uses 0 (or null) for "unknown" ids, e.g. venue 0 in some national-team / Thai League fixtures. */
export function validId(id: number | null | undefined): number | null {
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null;
}

// ---------- leagues ----------
export function toLeagueRow(item: LeagueItem, isTracked: boolean): Row {
  return {
    id: item.league.id,
    name: item.league.name,
    type: item.league.type,
    country: item.country.name,
    country_code: item.country.code,
    logo_url: item.league.logo,
    flag_url: item.country.flag,
    slug: slugify(`${item.country.name ?? ''} ${item.league.name}`) || String(item.league.id),
    is_tracked: isTracked,
    raw: item,
  };
}

export function toLeagueSeasonRows(item: LeagueItem): Row[] {
  return item.seasons.map((s) => ({
    league_id: item.league.id,
    season: s.year,
    start_date: s.start,
    end_date: s.end,
    is_current: s.current,
    coverage: s.coverage ?? null,
  }));
}

// ---------- teams / venues ----------
export function toVenueRow(item: TeamItem): Row | null {
  const v = item.venue;
  if (!v?.id) return null;
  return { id: v.id, name: v.name, address: v.address, city: v.city, capacity: v.capacity, surface: v.surface, image_url: v.image, raw: v };
}

export function toTeamRow(item: TeamItem): Row {
  const t = item.team;
  return {
    id: t.id,
    name: t.name,
    code: t.code,
    country: t.country,
    founded: t.founded,
    is_national: t.national,
    logo_url: t.logo,
    venue_id: validId(item.venue?.id),
    slug: `${slugify(t.name)}-${t.id}`,
    raw: item,
  };
}

/** Minimal team row derived from a fixture (cups can include teams not in /teams). */
export function toTeamStub(t: TeamRef): Row {
  return { id: t.id, name: t.name, logo_url: t.logo ?? null, slug: `${slugify(t.name)}-${t.id}` };
}

// ---------- fixtures ----------
export function toFixtureRow(item: FixtureItem): Row {
  const f = item.fixture;
  const kickoff = new Date(f.date).toISOString();
  return {
    id: f.id,
    league_id: item.league.id,
    season: item.league.season,
    round: item.league.round,
    kickoff_at: kickoff,
    timezone: f.timezone,
    venue_id: validId(f.venue?.id),
    referee: f.referee,
    home_team_id: item.teams.home.id,
    away_team_id: item.teams.away.id,
    status_short: f.status.short,
    status_long: f.status.long,
    elapsed: f.status.elapsed,
    goals_home: item.goals.home,
    goals_away: item.goals.away,
    ht_home: item.score.halftime.home,
    ht_away: item.score.halftime.away,
    ft_home: item.score.fulltime.home,
    ft_away: item.score.fulltime.away,
    et_home: item.score.extratime.home,
    et_away: item.score.extratime.away,
    pen_home: item.score.penalty.home,
    pen_away: item.score.penalty.away,
    slug: fixtureSlug(item.teams.home.name, item.teams.away.name, kickoff),
    // keep raw without the heavy detail arrays (they live in their own tables)
    raw: { fixture: item.fixture, league: item.league, teams: item.teams, goals: item.goals, score: item.score },
  };
}

export function toVenueStubFromFixture(item: FixtureItem): Row | null {
  const v = item.fixture.venue;
  if (!v?.id) return null;
  return { id: v.id, name: v.name, city: v.city };
}

export function toEventRows(item: FixtureItem): Row[] {
  return (item.events ?? []).map((e, i) => ({
    fixture_id: item.fixture.id,
    seq: i + 1,
    elapsed: e.time.elapsed,
    extra: e.time.extra,
    team_id: e.team?.id ?? null,
    player_id: e.player?.id ?? null,
    player_name: e.player?.name ?? null,
    assist_id: e.assist?.id ?? null,
    assist_name: e.assist?.name ?? null,
    type: e.type,
    detail: e.detail,
    comments: e.comments,
  }));
}

export function toStatisticRows(item: FixtureItem): Row[] {
  const rows: Row[] = [];
  for (const block of item.statistics ?? []) {
    const seen = new Set<string>();
    for (const s of block.statistics ?? []) {
      const type = statKey(s.type);
      if (!type || seen.has(type)) continue;
      seen.add(type);
      rows.push({
        fixture_id: item.fixture.id,
        team_id: block.team.id,
        type,
        value_num: parseNumeric(s.value),
        value_text: s.value === null || s.value === undefined ? null : String(s.value),
      });
    }
  }
  return rows;
}

export function toLineupRows(item: FixtureItem): { lineups: Row[]; players: Row[] } {
  const lineups: Row[] = [];
  const players: Row[] = [];
  for (const l of item.lineups ?? []) {
    lineups.push({
      fixture_id: item.fixture.id,
      team_id: l.team.id,
      formation: l.formation,
      coach_id: l.coach?.id ?? null,
      coach_name: l.coach?.name ?? null,
      raw: l,
    });
    const add = (list: typeof l.startXI, isStarter: boolean) => {
      for (const p of list ?? []) {
        players.push({
          fixture_id: item.fixture.id,
          team_id: l.team.id,
          player_id: p.player.id,
          player_name: p.player.name,
          number: p.player.number,
          position: p.player.pos,
          grid: p.player.grid,
          is_starter: isStarter,
        });
      }
    };
    add(l.startXI, true);
    add(l.substitutes, false);
  }
  return { lineups, players };
}

export function toFixturePlayerStatRows(item: FixtureItem): Row[] {
  const rows: Row[] = [];
  const seen = new Set<number>();
  for (const block of item.players ?? []) {
    for (const p of block.players ?? []) {
      const s = p.statistics?.[0];
      if (!s || seen.has(p.player.id)) continue;
      seen.add(p.player.id);
      rows.push({
        fixture_id: item.fixture.id,
        team_id: block.team.id,
        player_id: p.player.id,
        minutes: s.games?.minutes ?? null,
        position: s.games?.position ?? null,
        rating: parseNumeric(s.games?.rating),
        is_substitute: s.games?.substitute ?? null,
        goals: s.goals?.total ?? null,
        assists: s.goals?.assists ?? null,
        shots_total: s.shots?.total ?? null,
        shots_on: s.shots?.on ?? null,
        passes_total: s.passes?.total ?? null,
        passes_key: s.passes?.key ?? null,
        tackles: s.tackles?.total ?? null,
        interceptions: s.tackles?.interceptions ?? null,
        cards_yellow: s.cards?.yellow ?? null,
        cards_red: s.cards?.red ?? null,
        // no per-row raw copy: the full response (incl. every player's stats) is kept in api_raw_responses
      });
    }
  }
  return rows;
}

// ---------- injuries ----------
export function toInjuryRow(item: InjuryItem): Row {
  return {
    fixture_id: item.fixture?.id ?? null,
    league_id: item.league?.id ?? null,
    season: item.league?.season ?? null,
    team_id: item.team?.id ?? null,
    player_id: item.player?.id ?? null,
    player_name: item.player?.name ?? null,
    type: item.player?.type ?? null,
    reason: item.player?.reason ?? null,
    fixture_date: item.fixture?.date ? new Date(item.fixture.date).toISOString() : null,
    raw: item,
  };
}

// ---------- standings ----------
export function toStandingRows(item: StandingsItem): Row[] {
  const rows: Row[] = [];
  for (const group of item.league.standings ?? []) {
    for (const r of group) {
      rows.push({
        league_id: item.league.id,
        season: item.league.season,
        group_name: r.group ?? '',
        team_id: r.team.id,
        rank: r.rank,
        points: r.points,
        goals_diff: r.goalsDiff,
        form: r.form,
        status: r.status,
        description: r.description,
        played: r.all?.played ?? null,
        win: r.all?.win ?? null,
        draw: r.all?.draw ?? null,
        lose: r.all?.lose ?? null,
        goals_for: r.all?.goals?.for ?? null,
        goals_against: r.all?.goals?.against ?? null,
        home: r.home,
        away: r.away,
        source_updated_at: r.update ? new Date(r.update).toISOString() : null,
      });
    }
  }
  return rows;
}

// ---------- API predictions ----------
export function toApiPredictionRow(fixtureId: number, item: PredictionItem, rawResponseId: number | null): Row {
  const p = item.predictions;
  return {
    fixture_id: fixtureId,
    winner_team_id: p.winner?.id ?? null,
    winner_comment: p.winner?.comment ?? null,
    win_or_draw: p.win_or_draw ?? null,
    under_over: p.under_over ?? null,
    goals_home: p.goals?.home ?? null,
    goals_away: p.goals?.away ?? null,
    advice: p.advice ?? null,
    percent_home: parseNumeric(p.percent?.home),
    percent_draw: parseNumeric(p.percent?.draw),
    percent_away: parseNumeric(p.percent?.away),
    comparison: item.comparison ?? null,
    raw: item,
    raw_response_id: rawResponseId,
  };
}

// ---------- players ----------
export function toPlayerRows(item: PlayerItem): { player: Row; seasonStats: Row[] } {
  const p = item.player;
  const player: Row = {
    id: p.id,
    name: p.name,
    firstname: p.firstname,
    lastname: p.lastname,
    birth_date: p.birth?.date ?? null,
    nationality: p.nationality,
    height: p.height,
    weight: p.weight,
    photo_url: p.photo,
    raw: { player: p },
  };
  const seasonStats = (item.statistics ?? [])
    .filter((s) => s.team?.id && s.league?.id)
    .map((s) => ({
      player_id: p.id,
      team_id: s.team.id,
      league_id: s.league.id,
      season: s.league.season,
      position: s.games?.position ?? null,
      appearances: s.games?.appearences ?? null,
      lineups: s.games?.lineups ?? null,
      minutes: s.games?.minutes ?? null,
      rating: parseNumeric(s.games?.rating),
      goals: s.goals?.total ?? null,
      assists: s.goals?.assists ?? null,
      shots_total: s.shots?.total ?? null,
      shots_on: s.shots?.on ?? null,
      passes_key: s.passes?.key ?? null,
      tackles_total: s.tackles?.total ?? null,
      interceptions: s.tackles?.interceptions ?? null,
      cards_yellow: s.cards?.yellow ?? null,
      cards_red: s.cards?.red ?? null,
      raw: s,
    }));
  return { player, seasonStats };
}
