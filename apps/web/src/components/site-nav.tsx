'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { SITE_NAME } from '@/lib/brand';
import type { TickerMatch } from '@/lib/queries';
import { IconArticle, IconCalendar, IconChart, IconChevronRight, CompassMark, IconHome, Logo } from './icons';
import { isLive, minuteLabel, phaseGroup, toSeed } from '@/lib/live';
import { useLiveCount, useLiveMatch } from './live-provider';
import { TeamLogo } from './primitives';

const NAV = [
  { href: '/', label: 'หน้าแรก', Icon: IconHome },
  { href: '/matches', label: 'แมตช์', Icon: IconCalendar },
  { href: '/analysis', label: 'บทวิเคราะห์', Icon: IconArticle },
  { href: '/performance', label: 'ผลงาน', Icon: IconChart },
] as const;

const COMPASS_HREF = '/today'; // วิเคราะห์บอลวันนี้: where the day's signals are listed
const isActive = (path: string, href: string) => (href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`));

/**
 * Site navigation:
 *  - score strip (scrolls away with the page) — today's matches, live first
 *  - sticky white bar — logo, sections with an underline on the current one, LIVE count
 *  - phones: the sections move to a bottom tab bar with the 🧭 shortcut raised in the middle
 */
export function SiteNav({ ticker, tickerLabel }: { ticker: Array<TickerMatch & { clock: string }>; tickerLabel: string }) {
  const path = usePathname() ?? '/';
  const live = useLiveCount(ticker.filter((m) => isLive(m.status_short, m.kickoff_at)).length);
  if (path.startsWith('/admin')) return <AdminBar />;

  return (
    <>
      {/* the home page is itself the scoreboard: skip the strip there so today's list starts at the top */}
      {ticker.length && path !== '/' ? <ScoreStrip matches={ticker} label={tickerLabel} /> : null}

      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/85">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4 md:h-16 md:gap-6">
          <Link href="/" className="flex shrink-0 items-center gap-2.5 whitespace-nowrap" aria-label={`${SITE_NAME} หน้าแรก`}>
            {/* brand lockup (emblem + wordmark) replaces the icon and the text name */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/logo-lockup.webp" width={450} height={128} alt={SITE_NAME} decoding="async" className="h-9 w-auto md:h-10" draggable={false} />
          </Link>

          <nav aria-label="เมนูหลัก" className="hidden h-full md:block">
            <ul className="flex h-full items-stretch">
              {NAV.map(({ href, label }) => {
                const on = isActive(path, href);
                return (
                  <li key={href} className="flex">
                    <Link
                      href={href}
                      aria-current={on ? 'page' : undefined}
                      className={`relative flex items-center px-3.5 text-[15px] transition-colors duration-150 ${on ? 'font-semibold text-[var(--color-ink)]' : 'text-slate-600 hover:text-[var(--color-ink)]'}`}
                    >
                      {label === 'ผลงาน' ? 'ผลงานการวิเคราะห์' : label}
                      <span
                        className={`absolute inset-x-3.5 bottom-0 h-[3px] rounded-t-full bg-[var(--color-pitch)] transition-transform duration-200 ${on ? 'scale-x-100' : 'scale-x-0'}`}
                        aria-hidden
                      />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="ml-auto flex items-center gap-2">
            {live ? (
              <Link
                href="/matches"
                className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-rose-50 px-3 text-[13px] font-bold text-[var(--color-live-text)] ring-1 ring-inset ring-rose-200 transition-colors hover:bg-rose-100"
                aria-label={`กำลังแข่ง ${live} คู่`}
              >
                <span className="h-2 w-2 rounded-full bg-[var(--color-live)] motion-safe:animate-pulse" aria-hidden />
                LIVE {live}
              </Link>
            ) : null}
          </div>
        </div>
      </header>

      <nav aria-label="เมนูหลัก" className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        <ul className="grid h-[var(--spacing-tabbar)] grid-cols-5">
          {NAV.slice(0, 2).map((n) => (
            <Tab key={n.href} {...n} on={isActive(path, n.href)} />
          ))}
          <li className="flex justify-center">
            <Link href={COMPASS_HREF} className="flex -translate-y-4 flex-col items-center gap-1 text-xs font-semibold text-[var(--color-compass)]">
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-white shadow-lg ring-4 ring-white">
                <CompassMark size={56} />
              </span>
              เข็มทิศ
            </Link>
          </li>
          {NAV.slice(2).map((n) => (
            <Tab key={n.href} {...n} on={isActive(path, n.href)} />
          ))}
        </ul>
      </nav>
    </>
  );
}

function Tab({ href, label, Icon, on }: { href: string; label: string; Icon: (typeof NAV)[number]['Icon']; on: boolean }) {
  return (
    <li>
      <Link
        href={href}
        aria-current={on ? 'page' : undefined}
        className={`flex h-full flex-col items-center justify-center gap-1 text-xs transition-colors duration-150 ${on ? 'font-semibold text-[var(--color-pitch)]' : 'text-slate-600'}`}
      >
        <span className={`flex h-7 w-12 items-center justify-center rounded-full transition-colors ${on ? 'bg-[var(--color-pitch-soft)]' : ''}`}>
          <Icon size={20} />
        </span>
        {label}
      </Link>
    </li>
  );
}

/**
 * Today's matches as a horizontal strip, like a stadium scoreboard.
 * Dates/times arrive pre-formatted from the server: the browser's Thai locale data can differ from Node's.
 */
function ScoreStrip({ matches, label }: { matches: Array<TickerMatch & { clock: string }>; label: string }) {
  return (
    <div className="on-dark bg-[var(--color-ink)] text-white">
      <div className="mx-auto flex max-w-5xl items-stretch">
        <p className="flex shrink-0 items-center gap-2 border-r border-white/10 px-4 text-xs font-semibold text-[var(--color-pitch-bright)]">{label}</p>
        <ul className="rail flex min-w-0 flex-1 overflow-x-auto" aria-label={`แมตช์${label}`}>
          {matches.map((m) => (
            <StripItem key={m.slug} m={m} />
          ))}
        </ul>
        <Link href="/matches" className="hidden shrink-0 items-center gap-0.5 border-l border-white/10 px-4 text-xs font-medium text-slate-300 hover:text-white sm:flex">
          ทั้งหมด
          <IconChevronRight size={14} />
        </Link>
      </div>
    </div>
  );
}

/** One match on the strip; follows the live poller (minute, score, a brief highlight on a goal). */
function StripItem({ m }: { m: TickerMatch & { clock: string } }) {
  const { state, flash } = useLiveMatch(toSeed(m));
  const g = phaseGroup(state.status_short, m.kickoff_at);
  const live = g === 'live';
  const done = g === 'done';
  return (
    <li className="shrink-0 border-r border-white/10">
      <Link href={`/matches/${m.slug}`} className="flex h-full min-h-11 items-center gap-3 px-3.5 py-1.5 text-xs transition-colors hover:bg-white/5">
        <span className={`w-9 shrink-0 text-center font-semibold ${live ? 'text-rose-400' : 'text-slate-400'}`}>{live ? minuteLabel(state) : done ? 'จบ' : m.clock}</span>
        <span className="grid gap-0.5">
          {[
            [m.home, state.goals_home],
            [m.away, state.goals_away],
          ].map(([t, goals], i) => (
            <span key={i} className="flex items-center gap-1.5">
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm bg-white">
                <TeamLogo src={(t as TickerMatch['home']).logo_url} alt="" size={12} />
              </span>
              <span className="max-w-[7.5rem] truncate text-slate-200">{(t as TickerMatch['home']).name}</span>
              {live || done ? (
                <span className={`ml-auto rounded pl-2 pr-0.5 font-bold tabular-nums transition-colors duration-700 ${flash ? 'bg-amber-300 text-zinc-950' : ''}`}>{goals as number | null}</span>
              ) : null}
            </span>
          ))}
        </span>
      </Link>
    </li>
  );
}

/** Back office keeps a plain bar: no public sections, no score strip. */
function AdminBar() {
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex h-14 max-w-6xl items-center px-4">
        <Link href="/" className="flex items-center gap-2.5 font-bold">
          <Logo size={30} />
          {SITE_NAME}
        </Link>
      </div>
    </header>
  );
}
