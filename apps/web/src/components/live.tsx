'use client';

import { unsettledPhaseLabel } from '@/lib/labels';
import { minuteLabel, phaseGroup, type LiveSeed } from '@/lib/live';
import { useLiveCount, useLiveMatch, useStaleSince } from './live-provider';
import { Badge } from './sheet';

// Leaves that server components drop in where a live value is shown. Each takes the server's
// values as its seed and follows /api/live from there. Structure (which cells exist, list order)
// stays server-rendered: a phase change (kick-off, full time) re-renders the page once.

// a goal: a short warm highlight behind the number (colour only, so reduced motion keeps it)
const FLASH = 'rounded bg-amber-200 text-zinc-950 transition-colors duration-700';

/** Minute column of a live match: "67′" / "45+2′" / "HT" with the pulsing dot. */
export function LiveMinute({ seed, className }: { seed: LiveSeed; className: string }) {
  const { state } = useLiveMatch(seed);
  const done = phaseGroup(state.status_short) === 'done';
  return (
    <>
      <span className={className}>{done ? 'จบ' : minuteLabel(state)}</span>
      {done ? null : <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-[var(--color-live)] motion-safe:animate-pulse" aria-hidden />}
    </>
  );
}

/** One side's goals. */
export function LiveGoal({ seed, side, className }: { seed: LiveSeed; side: 'home' | 'away'; className: string }) {
  const { state, flash } = useLiveMatch(seed);
  const g = side === 'home' ? state.goals_home : state.goals_away;
  return <span className={`${className} ${flash ? FLASH : 'transition-colors duration-700'}`}>{g ?? '–'}</span>;
}

/** Match page: "สด 67′" / "สด พักครึ่ง", or "จบการแข่งขัน" once the final whistle arrives. */
export function LiveHeadBadge({ seed }: { seed: LiveSeed }) {
  const { state } = useLiveMatch(seed);
  if (phaseGroup(state.status_short) === 'done') return <Badge variant="secondary">จบการแข่งขัน</Badge>;
  return <Badge variant="live">สด {state.status_short === 'HT' ? 'พักครึ่ง' : minuteLabel(state)}</Badge>;
}

/** Compass card: an unsettled pick described by where the match stands. */
export function LivePhaseBadge({ seed }: { seed: LiveSeed }) {
  const { state } = useLiveMatch(seed);
  const label = unsettledPhaseLabel(state.status_short);
  return label ? <Badge variant="secondary">{label}</Badge> : null;
}

/** Small red count on the LIVE pill. */
export function LiveCountBadge({ initial }: { initial: number }) {
  const n = useLiveCount(initial);
  return n ? (
    <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-live)] px-1 text-[10px] font-bold leading-none text-white ring-2 ring-white">
      {n}
    </span>
  ) : null;
}

/** Shown only when live reads have failed for 2+ minutes: the numbers on screen may be old. */
export function LiveStaleNote({ className = '' }: { className?: string }) {
  const since = useStaleSince();
  if (!since) return null;
  const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false }).format(since);
  return <p className={`text-xs text-zinc-500 ${className}`}>อัปเดตล่าสุด {hhmm}</p>;
}

/** Renders nothing: keeps a not-yet-live match watched so its kick-off re-renders the page. */
export function LiveWatch({ seed }: { seed: LiveSeed }) {
  useLiveMatch(seed);
  return null;
}
