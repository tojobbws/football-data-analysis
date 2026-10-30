import Link from 'next/link';
import type { ReactNode } from 'react';
import type { MatchRow } from '@/lib/queries';
import { FINISHED, STATUS, selectionLabel } from '@/lib/labels';
import { addDaysStr, dayMonthTH, thaiDate, timeTH, weekdayShortTH } from '@/lib/time';
import { DatePickerButton } from './date-picker-button';
import { isLive, toSeed } from '@/lib/live';
import { CompassMark, CompassPicksTitle } from './icons';
import { LiveCountBadge, LiveGoal, LiveMinute, LiveWatch } from './live';
import { TeamLogo } from './primitives';
import { ResultMark } from './ui';

// Livescore-style scoreboard: date strip → league header → one card per match.
// Shared by the home page and /matches. White surface, light-grey cards.

const noon = (d: string) => `${d}T12:00:00+07:00`;
// INT/SUSP reach this only once past the live window (see isLive)
const OFF: Record<string, string> = { PST: 'เลื่อน', CANC: 'ยกเลิก', ABD: 'ยุติ', AWD: 'ปรับแพ้', WO: 'ชนะบาย', INT: 'หยุด', SUSP: 'หยุด' };
const DONE: Record<string, string> = { FT: 'จบ', AET: 'ต่อเวลา', PEN: 'จุดโทษ' };

/** Band that holds the scoreboard (full width, content centred). `wide` makes room for a sidebar from `lg`. */
export function ScoreboardBand({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="border-b border-slate-200 bg-white text-[var(--color-ink)]">
      <div className={`mx-auto max-w-3xl px-4 pb-8 ${wide ? 'lg:max-w-5xl' : ''}`}>{children}</div>
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
    <nav aria-label="เลือกวันที่" className="sticky top-14 z-20 -mx-4 border-b border-slate-200 bg-white/95 px-3 py-2 backdrop-blur supports-[backdrop-filter]:bg-white/85 md:top-16">
      <ul className="flex items-center gap-1">
        <li className="shrink-0">
          <Link
            href={`${base}?live=1`}
            scroll={false}
            aria-current={selected === null ? 'page' : undefined}
            className={`relative flex h-11 min-w-11 items-center justify-center rounded-full px-3 text-[13px] font-bold transition-colors duration-150 ${
              selected === null ? 'bg-[var(--color-live)] text-white' : 'bg-slate-100 text-[var(--color-ink)] hover:bg-slate-200'
            }`}
          >
            LIVE
            <LiveCountBadge initial={liveCount} />
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
                className={`flex h-11 flex-col items-center justify-center rounded-xl text-center leading-snug transition-colors duration-150 ${
                  on ? 'bg-[var(--color-pitch-soft)] font-semibold text-[var(--color-ink)]' : 'text-slate-600 hover:bg-slate-50 hover:text-[var(--color-ink)]'
                }`}
              >
                <span className={`text-[13px] font-semibold ${isToday && !on ? 'text-[var(--color-pitch)]' : ''}`}>{isToday ? 'วันนี้' : weekdayShortTH(noon(d))}</span>
                <span className="whitespace-nowrap text-[13px]">{dayMonthTH(noon(d))}</span>
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
export function ScoreboardList({ matches, date, watch }: { matches: MatchRow[]; date: string | null; watch?: Set<string> }) {
  const groups = new Map<number, { league: MatchRow['league']; rows: MatchRow[] }>();
  for (const m of matches) {
    const g = groups.get(m.league.id) ?? { league: m.league, rows: [] };
    g.rows.push(m);
    groups.set(m.league.id, g);
  }
  const nextMorning = date ? addDaysStr(date, 1) : null;
  return (
    <div className="space-y-5">
      {[...groups.values()].map(({ league, rows }) => {
        const firstLate = nextMorning ? rows.findIndex((m) => thaiDate(new Date(m.kickoff_at)) === nextMorning) : -1;
        return (
          <section key={league.id} aria-label={league.name}>
            <LeagueHeader league={league} count={rows.length} />
            <ul className="space-y-1.5">
              {rows.map((m, i) => (
                <li key={m.id}>
                  {i === firstLate ? <Divider label={`เช้ามืดวัน${longWeekday(nextMorning!)} ${dayMonthTH(noon(nextMorning!))}`} /> : null}
                  <MatchCard m={m} watched={watch?.has(m.slug) ?? false} />
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
    <div className="mb-2 flex items-center gap-2.5">
      {/* ringed badge: pitch ring, white disc so dark league logos stay readable */}
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-pitch)] p-[2px]" aria-hidden>
        <span className="flex h-full w-full items-center justify-center rounded-full bg-white">
          <TeamLogo src={league.logo_url} alt="" size={18} />
        </span>
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-bold leading-snug">{league.name}</h3>
        {league.country ? <p className="truncate text-[13px] text-slate-500">{league.country}</p> : null}
      </div>
      <span className="shrink-0 text-[13px] text-slate-500">{count} คู่</span>
    </div>
  );
}

function Divider({ label }: { label: string }) {
  return (
    <p className="my-2 flex items-center gap-3 text-[13px] font-semibold text-slate-500">
      <span className="h-px w-4 bg-slate-300" aria-hidden />
      {label}
      <span className="h-px flex-1 bg-slate-200" aria-hidden />
    </p>
  );
}

function MatchCard({ m, watched = false }: { m: MatchRow; watched?: boolean }) {
  const live = isLive(m.status_short, m.kickoff_at);
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
  const seed = toSeed(m);

  return (
    <Link
      href={`/matches/${m.slug}`}
      className={`flex min-h-14 items-center rounded-xl py-2 pl-2 pr-1.5 ring-inset transition-colors duration-150 ${watched ? 'bg-[var(--color-compass-soft)]/40 ring-2 ring-[var(--color-compass-ring)] hover:bg-[var(--color-compass-soft)]/70' : `bg-slate-50 ring-1 hover:bg-slate-100 ${live ? 'ring-[var(--color-live)]/50' : 'ring-slate-200/80'}`}`}
    >
      {/* status */}
      <div className="flex w-11 shrink-0 flex-col items-center justify-center text-center leading-snug">
        {live ? (
          <LiveMinute seed={seed} className="text-[13px] font-bold text-[var(--color-live-text)]" />
        ) : finished ? (
          <span className="text-[13px] font-semibold text-slate-500">{DONE[m.status_short] ?? m.status_short}</span>
        ) : off ? (
          <span className="text-[13px] font-semibold text-rose-700">{off}</span>
        ) : (
          <>
            <span className="text-sm font-semibold tabular-nums">{timeTH(m.kickoff_at)}</span>
            <LiveWatch seed={seed} />
          </>
        )}
      </div>

      <span className="mx-2.5 h-8 w-px shrink-0 bg-slate-200" aria-hidden />

      {/* teams + score */}
      <div className="min-w-0 flex-1 space-y-1">
        {showScore && gh != null && ga != null ? <span className="sr-only">{live ? 'กำลังแข่ง ' : ''}ผล {gh} ต่อ {ga}</span> : null}
        {teams.map(({ t, g, won }, i) => (
          <div key={t.id} className="flex items-center gap-2">
            <TeamLogo src={t.logo_url} alt="" size={18} />
            <span className={`truncate text-sm ${won ? 'font-semibold' : decided ? 'text-slate-500' : ''}`}>{t.name}</span>
            {live ? (
              <LiveGoal seed={seed} side={i === 0 ? 'home' : 'away'} className="ml-auto w-6 shrink-0 text-right text-sm font-bold tabular-nums" />
            ) : showScore ? (
              <span className={`ml-auto w-6 shrink-0 text-right text-sm tabular-nums ${won ? 'font-bold' : 'text-slate-500'}`}>{g ?? '–'}</span>
            ) : null}
          </div>
        ))}
      </div>

      {/* 🧭 marker (one pick, or settled result; a finished คู่น่าจับตา shows ถูก/ผิด) */}
      <div className={`flex shrink-0 items-center justify-center ${watched && c && pick && (finished || c.status === 'PENDING') ? 'min-w-[4.5rem] pl-1' : 'w-9'}`}>
        {c && pick ? (
          watched && finished ? (
            <span title={`🧭 ${pick} · ${STATUS[c.status].label}`}>
              <span className="sr-only">🧭 เข็มทิศเกม คู่น่าจับตา {pick}: </span>
              <ResultMark status={c.status} compact />
            </span>
          ) : c.status !== 'PENDING' ? (
            <span className="text-sm" title={`🧭 ${pick} · ${STATUS[c.status].label}`}>
              <span aria-hidden>{STATUS[c.status].icon}</span>
              <span className="sr-only">
                🧭 {pick}: {STATUS[c.status].label}
              </span>
            </span>
          ) : (
            <span className={`flex h-7 items-center justify-center ${watched ? '' : 'w-7'}`} title={`🧭 ${pick}`}>
              {watched ? <CompassPicksTitle className="h-6" /> : <CompassMark size={26} />}
              <span className="sr-only">🧭 เข็มทิศเกม: {pick}</span>
            </span>
          )
        ) : null}
      </div>
    </Link>
  );
}

/** Section heading on the scoreboard band. */
export function BandTitle({ id, title, sub, aside }: { id?: string; title: string; sub?: string; aside?: ReactNode }) {
  return (
    <div className="mb-3 mt-4 flex items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 id={id} className="text-base font-bold leading-snug">
          {title}
        </h2>
        {sub ? <p className="mt-0.5 text-[13px] text-slate-500">{sub}</p> : null}
      </div>
      {aside}
    </div>
  );
}

export function BandEmpty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">{children}</p>;
}
