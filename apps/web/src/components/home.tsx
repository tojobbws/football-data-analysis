import Link from 'next/link';
import type { ReactNode } from 'react';
import type { ArticleCard, PreviewCard } from '@/lib/queries';
import { dayTH, shortDayTH, timeTH } from '@/lib/time';
import { IconChevronRight } from './icons';

export function MoreLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex min-h-11 shrink-0 items-center gap-0.5 rounded-lg px-2 text-sm font-medium text-[var(--color-pitch)] transition-colors hover:bg-[var(--color-pitch-soft)]/60"
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
  return <li className="w-[84%] shrink-0 snap-start sm:w-auto">{children}</li>;
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

/**
 * Each match's written preview as a card: the match is the headline, the preview's first lines the
 * teaser; opens the match page at its analysis.
 */
export function PreviewGrid({ previews }: { previews: PreviewCard[] }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {previews.map((p) => (
        <li key={p.slug}>
          <Link
            href={`/matches/${p.slug}#analysis`}
            className="group flex h-full flex-col rounded-2xl border border-slate-200 bg-white p-4 transition-shadow duration-200 hover:shadow-md"
          >
            <p className="truncate text-xs text-slate-500">
              {p.league} · {shortDayTH(p.kickoff_at)} {timeTH(p.kickoff_at)}
            </p>
            <p className="mt-1 text-base font-semibold leading-snug">
              {p.home} <span className="font-normal text-slate-400">vs</span> {p.away}
            </p>
            <p className="mt-1.5 line-clamp-3 text-sm leading-relaxed text-slate-600">{p.overview_th}</p>
            <p className="mt-auto inline-flex items-center gap-0.5 pt-3 text-sm font-medium text-[var(--color-pitch)]">
              อ่านบทวิเคราะห์
              <IconChevronRight size={16} />
            </p>
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
