/**
 * Regular starters before the lineup is announced (.scratch/regular-starters/spec.md, docs/adr/0016-regular-starters.md).
 *
 * A fact, not a forecast: how many of the team's last stored lineups each player started. Guessing the XI as the 11
 * players with most starts in the last 5 got 7.9 of 11 right in league matches and 7.5 in continental cups (production,
 * 2026-11-10), so the count is shown and given to the AI, never presented as the coming XI.
 *
 * Domestic cups rotate: the last 5 got only 3.8 of 11 there, while the XI of the previous round of the same cup in the
 * same season got 5.5 (63 matches, League Cup). For a domestic cup each player also says whether he started that round.
 */

/** Same values as `CompetitionKind` in @fp/shared (this package does not depend on it). */
export type StartersCompetitionKind = 'LEAGUE' | 'DOMESTIC_CUP' | 'CONTINENTAL_CUP' | 'NATIONAL_TEAM';

/** One stored lineup of the team: a finished match before the analysed one. */
export interface StartersLineup {
  fixtureId: number;
  kickoffAt: Date;
  leagueId: number;
  season: number;
  starters: ReadonlyArray<{ playerId: number; name: string }>;
}

export interface RegularStarter {
  playerId: number;
  name: string;
  /** starts in the window's lineups */
  starts: number;
  /** domestic cup with a previous round this season: started it. null = not a domestic cup, or no previous round */
  startedPreviousCupRound: boolean | null;
  lastStartAt: Date | null;
}

export interface RegularStarters {
  /** lineups the counts rest on (at most `window`) */
  of: number;
  from: Date | null;
  to: Date | null;
  /** domestic cup only: the previous round of the same cup in the same season, when stored */
  previousCupRound: { fixtureId: number; kickoffAt: Date } | null;
  /** started at least once in the window, or started the previous cup round; most starts first */
  players: RegularStarter[];
}

/** Lineups counted: the measured rule (spec). */
export const STARTERS_WINDOW = 5;

/** A player who started at least this share of at least REGULAR_MIN_LINEUPS lineups is a regular starter. */
export const REGULAR_MIN_SHARE = 0.8;
export const REGULAR_MIN_LINEUPS = 3;

export function isRegularStarter(p: Pick<RegularStarter, 'starts'>, of: number): boolean {
  return of >= REGULAR_MIN_LINEUPS && p.starts / of >= REGULAR_MIN_SHARE;
}

/**
 * `history`: the team's stored lineups before the analysed match (any order; lineups with fewer than 11 starters are
 * left out, as in the measurement). `target`: the analysed match's competition.
 */
export function regularStarters(
  history: readonly StartersLineup[],
  target: { leagueId: number; season: number; kind: StartersCompetitionKind },
  window = STARTERS_WINDOW,
): RegularStarters {
  const full = history.filter((l) => l.starters.length >= 11).sort((a, b) => b.kickoffAt.getTime() - a.kickoffAt.getTime() || b.fixtureId - a.fixtureId);
  const recent = full.slice(0, window);
  const cup = target.kind === 'DOMESTIC_CUP' ? (full.find((l) => l.leagueId === target.leagueId && l.season === target.season) ?? null) : null;
  const cupStarters = new Set(cup?.starters.map((s) => s.playerId));

  const byId = new Map<number, RegularStarter>();
  const add = (s: { playerId: number; name: string }) => {
    let p = byId.get(s.playerId);
    if (!p) byId.set(s.playerId, (p = { playerId: s.playerId, name: s.name, starts: 0, startedPreviousCupRound: cup ? cupStarters.has(s.playerId) : null, lastStartAt: null }));
    return p;
  };
  for (const l of recent)
    for (const s of l.starters) {
      const p = add(s);
      p.starts++;
      if (!p.lastStartAt || l.kickoffAt > p.lastStartAt) p.lastStartAt = l.kickoffAt;
    }
  if (cup) for (const s of cup.starters) add(s);

  const players = [...byId.values()].sort(
    (a, b) =>
      b.starts - a.starts ||
      Number(b.startedPreviousCupRound === true) - Number(a.startedPreviousCupRound === true) ||
      (b.lastStartAt?.getTime() ?? 0) - (a.lastStartAt?.getTime() ?? 0) ||
      a.name.localeCompare(b.name),
  );
  return {
    of: recent.length,
    from: recent.length ? recent[recent.length - 1]!.kickoffAt : null,
    to: recent.length ? recent[0]!.kickoffAt : null,
    previousCupRound: cup ? { fixtureId: cup.fixtureId, kickoffAt: cup.kickoffAt } : null,
    players,
  };
}
