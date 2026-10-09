import Link from 'next/link';
import type { ReactNode } from 'react';
import type { MatchRow } from '@/lib/queries';
import { FINISHED, LIVE, STATUS, selectionLabel } from '@/lib/labels';
import { addDaysStr, dayMonthTH, thaiDate, timeTH, weekdayShortTH } from '@/lib/time';
import { DatePickerButton } from './date-picker-button';
import { IconCompass } from './icons';
import { TeamLogo } from './primitives';

// Dark, livescore-style scoreboard: date strip → league header → one card per match.
// Shared by the home page and /matches. Lives on the brand ink surface.

const noon = (d: string) => `${d}T12:00:00+07:00`;
const OFF: Record<string, string> = { PST: 'เลื่อน', CANC: 'ยกเลิก', ABD: 'ยุติ', AWD: 'ปรับแพ้', WO: 'ชนะบาย' };
const DONE: Record<string, string> = { FT: 'จบ', AET: 'ต่อเวลา', PEN: 'จุดโทษ' };

/** Dark band that holds the scoreboard (full width, content centred). */
export function ScoreboardBand({ children }: { children: ReactNode }) {
  return (
    <div className="bg-[var(--color-ink)] text-slate-100">
      <div className="mx-auto max-w-3xl px-4 pb-8">{children}</div>
    </div>
  );
}

/**
 * LIVE | five days around the selected one | calendar. Sticky under the site header.
 * `selected` = null means the LIVE view.
 */
export function DateStrip({ base, selected, today, liveCount }: { base: string; selected: string | null; today: string; liveCount: number }) {
  const center = selected ?? today;
  const days = Array.from({ length: 5 }, (_, i) => addDaysStr(center, i - 2));
  return (
    <nav aria-label="เลือกวันที่" className="sticky top-14 z-20 -mx-4 border-b border-white/10 bg-[var(--color-ink)] px-3 py-2.5 md:top-16">
      <ul className="flex items-center gap-1">
        <li className="shrink-0">
          <Link
            href={`${base}?live=1`}
            scroll={false}
            aria-current={selected === null ? 'page' : undefined}
            className={`relative flex h-11 min-w-11 items-center justify-center rounded-full px-3 text-sm font-bold transition-colors duration-150 ${
              selected === null ? 'bg-[var(--color-live)] text-white' : 'bg-white/10 text-slate-100 hover:bg-white/15'
            }`}
          >
            LIVE
            {liveCount ? (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-live)] px-1 text-[10px] font-bold leading-none text-white ring-2 ring-[var(--color-ink)]">
                {liveCount}
              </span>
            ) : null}
          </Link>
        </li>
        {days.map((d) => {
          const on = d === selected;
          const isToday = d === today;
          return (
            <li key={d} className="min-w-0 flex-1">
              <Link
                href={isToday && base === '/' ? '/' : `${base}?date=${d}`}
                scroll={false}
                aria-current={on ? 'date' : undefined}
                className={`flex h-12 flex-col items-center justify-center rounded-xl text-center leading-tight transition-colors duration-150 ${
                  on ? 'bg-[#26324d] text-white' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                }`}
              >
                <span className={`text-[13px] font-semibold ${isToday && !on ? 'text-[var(--color-pitch-bright)]' : ''}`}>{isToday ? 'วันนี้' : weekdayShortTH(noon(d))}</span>
                <span className="whitespace-nowrap text-[11px]">{dayMonthTH(noon(d))}</span>
              </Link>
            </li>
          );
        })}
        <li className="pl-1">
          <DatePickerButton value={center} base={base} />
        </li>
      </ul>
    </nav>
  );
}

/**
 * Matches grouped by league (in kickoff order). On a football day (`date` given), kick-offs that fall
 * on the next calendar morning get a "เช้ามืด…" divider, like the reference app's "tomorrow morning".
 */
export function ScoreboardList({ matches, date }: { matches: MatchRow[]; date: string | null }) {
  const groups = new Map<number, { league: MatchRow['league']; rows: MatchRow[] }>();
  for (const m of matches) {
    const g = groups.get(m.league.id) ?? { league: m.league, rows: [] };
    g.rows.push(m);
    groups.set(m.league.id, g);
  }
  const nextMorning = date ? addDaysStr(date, 1) : null;
  return (
    <div className="space-y-6">
      {[...groups.values()].map(({ league, rows }) => {
        const firstLate = nextMorning ? rows.findIndex((m) => thaiDate(new Date(m.kickoff_at)) === nextMorning) : -1;
        return (
          <section key={league.id} aria-label={league.name}>
            <LeagueHeader league={league} count={rows.length} />
            <ul className="space-y-2">
              {rows.map((m, i) => (
                <li key={m.id}>
                  {i === firstLate ? <Divider label={`เช้ามืดวัน${longWeekday(nextMorning!)} ${dayMonthTH(noon(nextMorning!))}`} /> : null}
                  <MatchCard m={m} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

const longWeekday = (d: string) => new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', weekday: 'long' }).format(new Date(noon(d))).replace(/^วัน/, '');

function LeagueHeader({ league, count }: { league: MatchRow['league']; count: number }) {
  return (
    <div className="mb-3 flex items-center gap-3">
      {/* ringed badge: gradient ring, white disc so dark league logos stay readable */}
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[var(--color-pitch-bright)] via-sky-500 to-violet-600 p-[2px]" aria-hidden>
        <span className="flex h-full w-full items-center justify-center rounded-full bg-white">
          <TeamLogo src={league.logo_url} alt="" size={24} />
        </span>
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-base font-bold leading-tight text-white">{league.name}</h3>
        {league.country ? <p className="truncate text-sm text-slate-400">{league.country}</p> : null}
      </div>
      <span className="shrink-0 text-xs text-slate-400">{count} คู่</span>
    </div>
  );
}

function Divider({ label }: { label: string }) {
  return (
    <p className="my-3 flex items-center gap-3 text-xs font-semibold text-slate-400">
      <span className="h-px w-4 bg-white/15" aria-hidden />
      {label}
      <span className="h-px flex-1 bg-white/15" aria-hidden />
    </p>
  );
}

function MatchCard({ m }: { m: MatchRow }) {
  const live = LIVE.includes(m.status_short);
  const finished = FINISHED.includes(m.status_short);
  const off = OFF[m.status_short];
  const showScore = live || finished;
  const gh = m.goals_home;
  const ga = m.goals_away;
  const decided = finished && gh != null && ga != null && gh !== ga;
  const teams = [
    { t: m.home, g: gh, won: decided && gh! > ga! },
    { t: m.away, g: ga, won: decided && ga! > gh! },
  ];
  const c = m.compass;
  const pick = c?.kind === 'SIGNAL' ? selectionLabel(c.market!, c.selection!, c.line == null ? null : Number(c.line), m.home.name, m.away.name) : null;

  return (
    <Link
      href={`/matches/${m.slug}`}
      className={`flex min-h-[4.5rem] items-center rounded-xl bg-[var(--color-ink-2)] py-3 pl-3 pr-2 transition-colors duration-150 hover:bg-[#1d2a48] ${live ? 'ring-1 ring-inset ring-[var(--color-live)]/60' : ''}`}
    >
      {/* status */}
      <div className="flex w-12 shrink-0 flex-col items-center justify-center text-center leading-none">
        {live ? (
          <>
            <span className="text-sm font-bold text-rose-400">{m.status_short === 'HT' ? 'HT' : `${m.elapsed ?? ''}′`}</span>
            <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-rose-400 motion-safe:animate-pulse" aria-hidden />
          </>
        ) : finished ? (
          <span className="text-xs font-semibold text-slate-400">{DONE[m.status_short] ?? m.status_short}</span>
        ) : off ? (
          <span className="text-xs font-semibold text-rose-300">{off}</span>
        ) : (
          <span className="text-[15px] font-semibold tabular-nums text-slate-100">{timeTH(m.kickoff_at)}</span>
        )}
      </div>

      <span className="mx-3 h-9 w-px shrink-0 bg-white/10" aria-hidden />

      {/* teams + score */}
      <div className="min-w-0 flex-1 space-y-1.5">
        {teams.map(({ t, g, won }) => (
          <div key={t.id} className="flex items-center gap-2.5">
            <TeamLogo src={t.logo_url} alt="" size={22} />
            <span className={`truncate text-[15px] ${won ? 'font-semibold text-white' : decided ? 'text-slate-400' : 'text-slate-100'}`}>{t.name}</span>
            {showScore ? (
              <span className={`ml-auto w-6 shrink-0 text-right text-[15px] tabular-nums ${live ? 'font-bold text-white' : won ? 'font-bold text-white' : 'text-slate-400'}`}>{g ?? '–'}</span>
            ) : null}
          </div>
        ))}
      </div>

      {/* 🧭 marker (one pick, or settled result) */}
      <div className="flex w-10 shrink-0 items-center justify-center">
        {c && pick ? (
          c.status !== 'PENDING' ? (
            <span className="text-base" title={`🧭 ${pick} · ${STATUS[c.status].label}`}>
              <span aria-hidden>{STATUS[c.status].icon}</span>
              <span className="sr-only">
                🧭 {pick}: {STATUS[c.status].label}
              </span>
            </span>
          ) : (
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-amber-400/15 text-amber-300" title={`🧭 ${pick}`}>
              <IconCompass size={18} />
              <span className="sr-only">🧭 เข็มทิศเกม: {pick}</span>
            </span>
          )
        ) : null}
      </div>
    </Link>
  );
}

/** Section heading on the dark band. */
export function BandTitle({ id, title, sub, aside }: { id?: string; title: string; sub?: string; aside?: ReactNode }) {
  return (
    <div className="mb-4 mt-6 flex items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 id={id} className="text-lg font-bold leading-tight text-white">
          {title}
        </h2>
        {sub ? <p className="mt-0.5 text-sm text-slate-400">{sub}</p> : null}
      </div>
      {aside}
    </div>
  );
}

export function BandEmpty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl bg-[var(--color-ink-2)] px-4 py-8 text-center text-sm text-slate-400">{children}</p>;
}
