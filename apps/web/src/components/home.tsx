import Link from 'next/link';
import type { ReactNode } from 'react';
import type { ArticleCard, MatchRow, WeekPerf } from '@/lib/queries';
import { FINISHED, LIVE, pct } from '@/lib/labels';
import { dayTH, shortDayTH, timeTH } from '@/lib/time';
import { IconChevronRight } from './icons';
import { TeamLogo } from './primitives';

/** Heading for one of the home page's three bands. */
export function BandHeading({ kicker, title, href, linkLabel = 'ทั้งหมด', dark = false }: { kicker: string; title: string; href?: string; linkLabel?: string; dark?: boolean }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-3">
      <div>
        <p className={`flex items-center gap-2 text-xs font-semibold tracking-wide ${dark ? 'text-[var(--color-pitch-bright)]' : 'text-[var(--color-pitch)]'}`}>
          <span className="h-3 w-1 rounded-full bg-current" aria-hidden />
          {kicker}
        </p>
        <h2 className="mt-1 text-xl font-bold leading-tight sm:text-2xl">{title}</h2>
      </div>
      {href ? <MoreLink href={href} label={linkLabel} dark={dark} /> : null}
    </div>
  );
}

export function MoreLink({ href, label, dark = false }: { href: string; label: string; dark?: boolean }) {
  return (
    <Link
      href={href}
      className={`inline-flex min-h-11 shrink-0 items-center gap-0.5 rounded-lg px-2 text-sm font-medium transition-colors ${dark ? 'text-[var(--color-pitch-bright)] hover:bg-white/10' : 'text-[var(--color-pitch)] hover:bg-[var(--color-pitch-soft)]/60'}`}
    >
      {label}
      <IconChevronRight size={16} />
    </Link>
  );
}

/**
 * Cards that scroll sideways on phones (snap, peeking next card) and become a grid from `sm`.
 * Keeps the first screen short instead of stacking 8 cards.
 */
export function Rail({ children, label }: { children: ReactNode; label: string }) {
  return (
    <ul aria-label={label} className="rail -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 sm:pb-0">
      {children}
    </ul>
  );
}

export function RailItem({ children }: { children: ReactNode }) {
  return <li className="w-[78%] shrink-0 snap-start sm:w-auto">{children}</li>;
}

/** Compact score card for live and finished matches. */
export function ScoreTile({ m }: { m: MatchRow }) {
  const live = LIVE.includes(m.status_short);
  const finished = FINISHED.includes(m.status_short);
  const gh = m.goals_home ?? 0;
  const ga = m.goals_away ?? 0;
  const rows: Array<[MatchRow['home'], number | null, boolean]> = [
    [m.home, m.goals_home, finished && gh > ga],
    [m.away, m.goals_away, finished && ga > gh],
  ];
  return (
    <Link
      href={`/matches/${m.slug}`}
      className={`block h-full rounded-xl border bg-white p-3 transition-shadow duration-150 hover:shadow-md ${live ? 'border-[var(--color-live)]/50' : 'border-slate-200'}`}
    >
      <div className="mb-2.5 flex items-center justify-between gap-2 text-xs text-slate-500">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="flex h-4 w-4 shrink-0 items-center justify-center">
            <TeamLogo src={m.league.logo_url} alt="" size={12} />
          </span>
          <span className="truncate">{m.league.name}</span>
        </span>
        {live ? (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-[var(--color-live)] px-2 py-0.5 font-semibold text-white">
            <span className="h-1.5 w-1.5 rounded-full bg-white motion-safe:animate-pulse" aria-hidden />
            {m.status_short === 'HT' ? 'พักครึ่ง' : `${m.elapsed ?? ''}′`}
          </span>
        ) : (
          <span className="shrink-0">{finished ? 'จบเกม' : timeTH(m.kickoff_at)}</span>
        )}
      </div>
      <div className="space-y-1.5 text-sm">
        {rows.map(([t, g, won]) => (
          <div key={t.id} className="flex items-center gap-2">
            <TeamLogo src={t.logo_url} alt="" size={20} />
            <span className={`truncate ${won ? 'font-semibold' : 'text-slate-700'}`}>{t.name}</span>
            <span className={`ml-auto text-base tabular-nums ${won || live ? 'font-bold' : 'text-slate-600'}`}>{g ?? '–'}</span>
          </div>
        ))}
      </div>
    </Link>
  );
}

/**
 * Weekly win rate as one series of bars (single hue, direct labels, 50% reference line).
 * Weeks with no settled signal show an empty slot instead of a 0% bar.
 */
export function WeeklyWinRate({ weeks }: { weeks: WeekPerf[] }) {
  const H = 112;
  const dm = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', timeZone: 'Asia/Bangkok' });
  return (
    <figure>
      <div className="relative" style={{ height: H + 20 }}>
        <div className="absolute inset-x-0 border-t border-dashed border-slate-300" style={{ top: 20 + H / 2 }} aria-hidden />
        <span className="absolute right-0 bg-white pl-1 text-xs text-slate-500" style={{ top: 20 + H / 2 - 9 }} aria-hidden>
          50%
        </span>
        <ol className="relative flex h-full items-end gap-1.5 pr-9">
          {weeks.map((w) => {
            const label = `สัปดาห์ ${shortDayTH(`${w.week}T12:00:00+07:00`)}: ${w.win_rate == null ? 'ยังไม่มีผล' : `Win rate ${pct(w.win_rate, 0)} จาก ${w.settled} สัญญาณ`}`;
            return (
              <li key={w.week} className="flex h-full flex-1 flex-col items-center justify-end" title={label} aria-label={label}>
                {w.win_rate == null ? (
                  <span className="mb-1 text-xs text-slate-500">–</span>
                ) : (
                  <>
                    <span className="mb-1 text-xs font-semibold tabular-nums">{pct(w.win_rate, 0)}</span>
                    <span className="w-full max-w-8 rounded-t bg-[var(--color-pitch)]" style={{ height: Math.max(2, w.win_rate * H) }} />
                  </>
                )}
              </li>
            );
          })}
        </ol>
      </div>
      <ol className="mt-1 flex gap-1.5 border-t border-slate-200 pt-1 pr-9 text-center text-xs text-slate-500" aria-hidden>
        {weeks.map((w, i) => (
          <li key={w.week} className="min-w-0 flex-1">
            {/* every other date on phones so labels never collide */}
            <span className={i % 2 ? 'hidden sm:inline' : ''}>{dm.format(new Date(`${w.week}T12:00:00+07:00`))}</span>
            <span className="block tabular-nums">{w.settled ? w.settled : ''}</span>
          </li>
        ))}
      </ol>
      <figcaption className="mt-2 text-xs text-slate-500">Win rate ต่อสัปดาห์ (ตามวันเตะ) · ตัวเลขใต้แท่ง = จำนวนสัญญาณที่ตัดสินผล · HALF นับครึ่ง · ไม่นับ PUSH/VOID</figcaption>
    </figure>
  );
}

export function ArticleGrid({ articles }: { articles: ArticleCard[] }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {articles.map((a) => (
        <li key={a.slug}>
          <Link href={`/analysis/${a.slug}`} className="group flex h-full flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white transition-shadow duration-200 hover:shadow-md">
            <div className="relative aspect-[1.91/1] overflow-hidden bg-[var(--color-ink)]">
              {a.og_image_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={a.og_image_url} alt="" width={640} height={336} loading="lazy" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
              ) : (
                <CoverFallback />
              )}
              <span className="absolute left-3 top-3 rounded-full bg-white/95 px-2.5 py-1 text-xs font-semibold text-[var(--color-pitch)]">{a.category?.name ?? 'บทความ'}</span>
            </div>
            <div className="flex flex-1 flex-col p-4">
              <p className="text-base font-semibold leading-snug">{a.title}</p>
              {a.description ? <p className="mt-1 line-clamp-2 text-sm text-slate-600">{a.description}</p> : null}
              <p className="mt-auto pt-3 text-xs text-slate-500">{dayTH(a.published_at)}</p>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Stand-in cover until an article has its own image: pitch lines on the brand ink. */
function CoverFallback() {
  return (
    <svg viewBox="0 0 382 200" className="h-full w-full" aria-hidden>
      <rect width="382" height="200" fill="var(--color-ink)" />
      <g fill="none" stroke="var(--color-pitch-bright)" strokeOpacity=".22" strokeWidth="2">
        <rect x="16" y="16" width="350" height="168" rx="4" />
        <path d="M191 16v168" />
        <circle cx="191" cy="100" r="34" />
        <rect x="16" y="58" width="44" height="84" />
        <rect x="322" y="58" width="44" height="84" />
      </g>
      <g transform="translate(171 80) scale(1.667)" fill="none" stroke="var(--color-pitch-bright)" strokeOpacity=".7" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
        <path d="M14 3v6h6M8 13h8M8 17h5" />
      </g>
    </svg>
  );
}
