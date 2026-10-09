'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { IconCalendar, IconChevronRight } from './icons';

export interface DayTab {
  /** id of the section on the page */
  id: string;
  label: string;
  count: number;
  live?: number;
}

/**
 * Sticky day switcher under the site header (like a live-score app's date bar).
 * Day tabs jump to sections on this page; the last two chips leave for the calendar.
 * The current tab follows scrolling: the last section that has reached the sticky bar.
 */
export function DayTabs({ tabs, nextHref, nextLabel, calendarHref }: { tabs: DayTab[]; nextHref: string; nextLabel: string; calendarHref: string }) {
  const [current, setCurrent] = useState(tabs[0]?.id);

  useEffect(() => {
    // current = the last section whose top has scrolled up past the sticky bars (first section until then)
    let frame = 0;
    const update = () => {
      frame = 0;
      let cur = tabs[0]?.id;
      for (const t of tabs) {
        const el = document.getElementById(t.id);
        if (el && el.getBoundingClientRect().top <= 140) cur = t.id;
      }
      setCurrent(cur);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [tabs]);

  const chip = 'inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium transition-colors duration-150';
  const idle = 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50';
  const on = 'border-[var(--color-ink)] bg-[var(--color-ink)] text-white';

  return (
    <nav aria-label="เลือกวัน" className="sticky top-14 z-20 -mx-4 bg-[var(--color-canvas)]/95 px-4 py-2 backdrop-blur md:top-16">
      <ul className="rail flex items-center gap-2 overflow-x-auto">
        {tabs.map((t) => {
          const active = t.id === current;
          return (
            <li key={t.id}>
              <a href={`#${t.id}`} onClick={() => setCurrent(t.id)} aria-current={active ? 'true' : undefined} className={`${chip} ${active ? on : idle}`}>
                {t.label}
                <span className={`rounded-full px-1.5 py-0.5 text-xs tabular-nums ${active ? 'bg-white/15 text-slate-200' : 'bg-slate-100 text-slate-600'}`}>{t.count}</span>
                {t.live ? (
                  <span className={`flex items-center gap-1 text-xs font-bold ${active ? 'text-rose-300' : 'text-[var(--color-live)]'}`}>
                    <span className="h-1.5 w-1.5 rounded-full bg-current motion-safe:animate-pulse" aria-hidden />
                    {t.live}
                  </span>
                ) : null}
              </a>
            </li>
          );
        })}
        <li>
          <Link href={nextHref} className={`${chip} ${idle} pr-2.5`}>
            {nextLabel}
            <IconChevronRight size={16} />
          </Link>
        </li>
        <li className="ml-auto pl-1">
          <Link href={calendarHref} className={`${chip} ${idle} w-10 justify-center px-0`} aria-label="ปฏิทินแมตช์ทุกวัน" title="ปฏิทินแมตช์">
            <IconCalendar size={18} />
          </Link>
        </li>
      </ul>
    </nav>
  );
}
