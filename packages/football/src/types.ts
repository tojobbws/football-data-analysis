/**
 * Response types for API-Football v3 (only the fields we use).
 * Fields are nullable where the API is known to return null.
 */

export interface ApiEnvelope<T> {
  get: string;
  parameters: Record<string, string> | unknown[];
  errors: Record<string, string> | unknown[];
  results: number;
  paging: { current: number; total: number };
  response: T;
}

export interface TeamRef {
  id: number;
  name: string;
  logo?: string | null;
}

// ---------- /leagues ----------
export interface LeagueItem {
  league: { id: number; name: string; type: string; logo: string | null };
  country: { name: string | null; code: string | null; flag: string | null };
  seasons: Array<{
    year: number;
    start: string | null;
    end: string | null;
    current: boolean;
    coverage?: Record<string, unknown>;
  }>;
}

// ---------- /teams ----------
export interface TeamItem {
  team: {
    id: number;
    name: string;
    code: string | null;
    country: string | null;
    founded: number | null;
    national: boolean;
    logo: string | null;
  };
  venue: {
    id: number | null;
    name: string | null;
    address: string | null;
    city: string | null;
    capacity: number | null;
    surface: string | null;
    image: string | null;
  };
}

// ---------- /fixtures ----------
export interface ScorePair {
  home: number | null;
  away: number | null;
}

export interface FixtureEventItem {
  time: { elapsed: number | null; extra: number | null };
  team: TeamRef;
  player: { id: number | null; name: string | null };
  assist: { id: number | null; name: string | null };
  type: string;
  detail: string | null;
  comments: string | null;
}

export interface LineupPlayer {
  player: { id: number | null; name: string | null; number: number | null; pos: string | null; grid: string | null };
}

export interface FixtureLineupItem {
  team: TeamRef & { colors?: unknown };
  coach: { id: number | null; name: string | null; photo?: string | null };
  formation: string | null;
  startXI: LineupPlayer[];
  substitutes: LineupPlayer[];
}

export interface FixtureStatisticsItem {
  team: TeamRef;
  statistics: Array<{ type: string; value: number | string | null }>;
}

export interface PlayerMatchStatistics {
  games: {
    minutes: number | null;
    number?: number | null;
    position: string | null;
    rating: string | null;
    captain?: boolean;
    substitute: boolean | null;
  };
  shots?: { total: number | null; on: number | null };
  goals?: { total: number | null; conceded?: number | null; assists: number | null; saves?: number | null };
  passes?: { total: number | null; key: number | null; accuracy: string | number | null };
  tackles?: { total: number | null; blocks: number | null; interceptions: number | null };
  cards?: { yellow: number | null; red: number | null };
  [k: string]: unknown;
}

export interface FixturePlayersItem {
  team: TeamRef;
  players: Array<{
    player: { id: number; name: string; photo?: string | null };
    statistics: PlayerMatchStatistics[];
  }>;
}

export interface FixtureItem {
  fixture: {
    id: number;
    referee: string | null;
    timezone: string;
    date: string;
    timestamp: number;
    venue: { id: number | null; name: string | null; city: string | null };
    status: { long: string; short: string; elapsed: number | null; extra?: number | null };
  };
  league: { id: number; name: string; country: string; logo: string | null; flag: string | null; season: number; round: string | null };
  teams: { home: TeamRef & { winner: boolean | null }; away: TeamRef & { winner: boolean | null } };
  goals: ScorePair;
  score: { halftime: ScorePair; fulltime: ScorePair; extratime: ScorePair; penalty: ScorePair };
  /** Present only when fetched with `ids=` */
  events?: FixtureEventItem[];
  lineups?: FixtureLineupItem[];
  statistics?: FixtureStatisticsItem[];
  players?: FixturePlayersItem[];
}

// ---------- /injuries ----------
export interface InjuryItem {
  player: { id: number | null; name: string | null; photo?: string | null; type: string | null; reason: string | null };
  team: TeamRef;
  fixture: { id: number | null; timezone?: string; date: string | null; timestamp?: number };
  league: { id: number; season: number; name?: string };
}

// ---------- /standings ----------
export interface StandingRecord {
  played: number | null;
  win: number | null;
  draw: number | null;
  lose: number | null;
  goals: { for: number | null; against: number | null };
}

export interface StandingRow {
  rank: number;
  team: TeamRef;
  points: number;
  goalsDiff: number;
  group: string | null;
  form: string | null;
  status: string | null;
  description: string | null;
  all: StandingRecord;
  home: StandingRecord;
  away: StandingRecord;
  update: string | null;
}

export interface StandingsItem {
  league: { id: number; season: number; name: string; standings: StandingRow[][] };
}

// ---------- /predictions ----------
export interface PredictionItem {
  predictions: {
    winner: { id: number | null; name: string | null; comment: string | null };
    win_or_draw: boolean | null;
    under_over: string | null;
    goals: { home: string | null; away: string | null };
    advice: string | null;
    percent: { home: string | null; draw: string | null; away: string | null };
  };
  comparison?: Record<string, unknown>;
  [k: string]: unknown;
}

// ---------- /players ----------
export interface PlayerSeasonStatistics {
  team: TeamRef;
  league: { id: number; season: number; name?: string };
  games: {
    /** NOTE: the API really spells it "appearences" */
    appearences: number | null;
    lineups: number | null;
    minutes: number | null;
    position: string | null;
    rating: string | null;
  };
  shots?: { total: number | null; on: number | null };
  goals?: { total: number | null; assists: number | null };
  passes?: { key: number | null };
  tackles?: { total: number | null; interceptions: number | null };
  cards?: { yellow: number | null; red: number | null };
  [k: string]: unknown;
}

export interface PlayerItem {
  player: {
    id: number;
    name: string;
    firstname: string | null;
    lastname: string | null;
    birth: { date: string | null; place?: string | null; country?: string | null };
    nationality: string | null;
    height: string | null;
    weight: string | null;
    photo: string | null;
  };
  statistics: PlayerSeasonStatistics[];
}

// ---------- /odds ----------
export interface OddsValue {
  value: string | number;
  odd: string;
  handicap?: string | null;
}

export interface OddsBet {
  id: number;
  name: string;
  values: OddsValue[];
}

export interface OddsItem {
  league: { id: number; season: number };
  fixture: { id: number; timezone?: string; date?: string; timestamp?: number };
  update: string;
  bookmakers: Array<{ id: number; name: string; bets: OddsBet[] }>;
}
