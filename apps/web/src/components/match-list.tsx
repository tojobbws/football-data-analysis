import Link from 'next/link';
import type { MatchRow } from '@/lib/queries';
import { FINISHED, LIVE, selectionLabel } from '@/lib/labels';
import { timeTH } from '@/lib/time';
import { toSeed } from '@/lib/live';
import { CompassMark } from './icons';
import { LiveGoal, LiveMinute, LiveWatch } from './live';
import { StatusBadge, TeamLogo } from './ui';

const OFF: Record<string, string> = { PST: 'เลื่อน', CANC: 'ยกเลิก', ABD: 'ยุติ', AWD: 'ปรับแพ้', WO: 'ชนะบาย' };
const DONE: Record<string, string> = { FT: 'จบ', AET: 'ต่อเวลา', PEN: 'จุดโทษ' };

/**
 * Matches grouped by league, scoreboard style: status | home / away stacked with their scores | 🧭.
 * `compact` = the home page density (no 🔎 teaser, tighter rows); list pages keep the teaser.
 */
export function MatchList({ matches, compact = false }: { matches: MatchRow[]; compact?: boolean }) {
  const groups = new Map<number, { league: MatchRow['league']; rows: MatchRow[] }>();
  for (const m of matches) {
    const g = groups.get(m.league.id) ?? { league: m.league, rows: [] };
    g.rows.push(m);
    groups.set(m.league.id, g);
  }
  return (
    <div className="space-y-2.5">
      {[...groups.values()].map(({ league, rows }) => (
        <section key={league.id} aria-label={league.name} className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <header className="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2 text-sm font-semibold sm:px-4">
            <TeamLogo src={league.logo_url} alt="" size={18} />
            <span className="truncate">{league.name}</span>
            {league.country ? <span className="hidden shrink-0 font-normal text-slate-500 sm:inline">· {league.country}</span> : null}
            <span className="ml-auto shrink-0 text-xs font-normal text-slate-500">{rows.length} คู่</span>
          </header>
          <ul className="divide-y divide-slate-100">
            {rows.map((m) => (
              <MatchItem key={m.id} m={m} compact={compact} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function MatchItem({ m, compact }: { m: MatchRow; compact: boolean }) {
  const finished = FINISHED.includes(m.status_short);
  const live = LIVE.includes(m.status_short);
  const off = OFF[m.status_short];
  const showScore = finished || live;
  const gh = m.goals_home;
  const ga = m.goals_away;
  const decided = finished && gh != null && ga != null && gh !== ga;
  const seed = toSeed(m);
  const teams = [
    { t: m.home, g: gh, won: decided && gh! > ga! },
    { t: m.away, g: ga, won: decided && ga! > gh! },
  ];
  const c = m.compass;
  const pick = c?.kind === 'SIGNAL' ? selectionLabel(c.market!, c.selection!, c.line == null ? null : Number(c.line), m.home.name, m.away.name) : null;

  return (
    <li className={live ? 'border-l-[3px] border-l-[var(--color-live)]' : ''}>
      <Link
        href={`/matches/${m.slug}`}
        className={`grid grid-cols-[2.75rem_minmax(0,1fr)_auto] items-center gap-x-2 px-2 transition-colors duration-150 hover:bg-slate-50 sm:grid-cols-[3.5rem_minmax(0,1fr)_auto] sm:gap-x-3 sm:px-3 ${compact ? 'min-h-14 py-2' : 'min-h-16 gap-y-2 py-2.5'}`}
      >
        {/* status column: minute (live) / final / time */}
        <div className="flex flex-col items-center justify-center text-center leading-none">
          {live ? (
            <LiveMinute seed={seed} className="text-xs font-bold text-[var(--color-live)]" />
          ) : finished ? (
            <span className="text-xs font-medium text-slate-500">{DONE[m.status_short] ?? m.status_short}</span>
          ) : off ? (
            <span className="text-xs font-medium text-rose-700">{off}</span>
          ) : (
            <>
              <span className="text-sm font-semibold tabular-nums">{timeTH(m.kickoff_at)}</span>
              <LiveWatch seed={seed} />
            </>
          )}
        </div>

        {/* teams: home over away, scores right-aligned on each row */}
        <div className={`min-w-0 text-sm ${compact ? 'space-y-1' : 'space-y-1.5'}`}>
          {teams.map(({ t, g, won }, i) => (
            <div key={t.id} className="flex items-center gap-2">
              <TeamLogo src={t.logo_url} alt="" size={compact ? 18 : 20} />
              <span className={`truncate ${won ? 'font-semibold' : decided ? 'text-slate-500' : ''}`}>{t.name}</span>
              {live ? (
                <LiveGoal seed={seed} side={i === 0 ? 'home' : 'away'} className="ml-auto w-5 shrink-0 text-right font-bold tabular-nums" />
              ) : showScore ? (
                <span className={`ml-auto w-5 shrink-0 text-right tabular-nums ${won ? 'font-bold' : 'text-slate-500'}`}>{g ?? '–'}</span>
              ) : null}
            </div>
          ))}
        </div>

        {/* 🧭 column */}
        <div className="flex items-center justify-end">
          {c ? (
            pick ? (
              c.status !== 'PENDING' ? (
                <StatusBadge status={c.status} />
              ) : (
                <>
                  <span className="hidden max-w-[12rem] items-center gap-1.5 rounded-full bg-[var(--color-compass-soft)] py-0.5 pl-0.5 pr-2.5 text-xs font-semibold text-[var(--color-compass)] sm:inline-flex" title={pick}>
                    <CompassMark size={22} />
                    <span className="truncate">{pick}</span>
                  </span>
                  <span className="inline-flex h-8 w-8 items-center justify-center sm:hidden" title={`🧭 ${pick}`}>
                    <CompassMark size={28} />
                    <span className="sr-only">🧭 เข็มทิศเกม: {pick}</span>
                  </span>
                </>
              )
            ) : null
          ) : null}
        </div>

        {!compact && m.preview ? (
          <p className="col-start-2 col-end-4 line-clamp-2 text-xs leading-relaxed text-slate-600">
            <span className="mr-1" aria-hidden>
              🔎
            </span>
            {m.preview.overview_th}
          </p>
        ) : null}
      </Link>
    </li>
  );
}
