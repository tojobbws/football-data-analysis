// Live match state shared by the server pages, the /api/live route and the client components.
// No server-only imports: client components read these lists and labels too.

export const LIVE = ['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE', 'INT', 'SUSP'];
export const FINISHED = ['FT', 'AET', 'PEN'];

/** What /api/live returns per match: the few fields that move during a game. */
export interface LiveState {
  id: number;
  status_short: string;
  elapsed: number | null;
  elapsed_extra: number | null;
  goals_home: number | null;
  goals_away: number | null;
}

export interface LiveSnapshot {
  /** server time of the read, ISO */
  at: string;
  matches: LiveState[];
}

/**
 * A live status this long after kickoff is a match the API stopped (INT/SUSP) and never closed:
 * it stops counting as live. Same window as the live-score worker's poll gate.
 */
export const LIVE_WINDOW_MS = 6 * 3_600_000;

/** Earliest kickoff that can still be live (ISO), for DB filters. */
export const liveSince = (now = Date.now()) => new Date(now - LIVE_WINDOW_MS).toISOString();

export function isLive(statusShort: string, kickoffAt: string, now = Date.now()): boolean {
  return LIVE.includes(statusShort) && Date.parse(kickoffAt) > now - LIVE_WINDOW_MS;
}

/** Coarse phase: a change between these re-renders the page once (order, tabs, post-match stats). */
export type PhaseGroup = 'pre' | 'live' | 'done';
export function phaseGroup(statusShort: string, kickoffAt?: string, now = Date.now()): PhaseGroup {
  if (LIVE.includes(statusShort)) return kickoffAt == null || isLive(statusShort, kickoffAt, now) ? 'live' : 'pre';
  if (FINISHED.includes(statusShort)) return 'done';
  return 'pre';
}

/** "HT", "45+2′", "67′" for a match in play. */
export function minuteLabel(s: Pick<LiveState, 'status_short' | 'elapsed' | 'elapsed_extra'>): string {
  if (s.status_short === 'HT') return 'HT';
  if (s.elapsed == null) return '';
  return s.elapsed_extra ? `${s.elapsed}+${s.elapsed_extra}′` : `${s.elapsed}′`;
}

/** Poll while a match is in play, or about to kick off (so its start is noticed without a reload). */
export function isWatchable(s: Pick<LiveState, 'status_short'>, kickoffAt: string, now = Date.now()): boolean {
  const g = phaseGroup(s.status_short, kickoffAt, now);
  if (g === 'live') return true;
  if (g === 'done') return false;
  const ko = Date.parse(kickoffAt);
  return ko <= now + 2 * 60_000 && ko > now - 3 * 3_600_000;
}

/** What a live component starts from: the server's values plus what the poller needs to know. */
export interface LiveSeed extends LiveState {
  kickoff_at: string;
  home: string;
  away: string;
}

export function toSeed(m: Omit<LiveState, 'elapsed_extra'> & { elapsed_extra?: number | null; kickoff_at: string; home: { name: string }; away: { name: string } }): LiveSeed {
  return {
    id: m.id,
    status_short: m.status_short,
    elapsed: m.elapsed,
    elapsed_extra: m.elapsed_extra ?? null,
    goals_home: m.goals_home,
    goals_away: m.goals_away,
    kickoff_at: m.kickoff_at,
    home: m.home.name,
    away: m.away.name,
  };
}
