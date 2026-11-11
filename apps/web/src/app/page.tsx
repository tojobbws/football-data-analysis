import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { ArticleGrid, MoreLink, PreviewTable } from '@/components/home';
import { watchSlugs } from '@/components/featured-picks';
import { CompassMark, IconChevronRight } from '@/components/icons';
import { LeagueWidgets } from '@/components/league-widgets';
import { BandEmpty, BandTitle, DateStrip, ScoreboardBand, ScoreboardList } from '@/components/scoreboard';
import { Empty } from '@/components/ui';
import { FINISHED } from '@/lib/labels';
import { isLive as liveNow } from '@/lib/live';
import { byLeagueThenKickoff } from '@/lib/popularity';
import { featuredRanks, latestArticles, leagueWidgets, liveMatches, matchesOnFootballDay, popularityRegistry, previewCards, type MatchRow } from '@/lib/queries';
import { SITE_DESCRIPTION, SITE_NAME, SITE_TAGLINE } from '@/lib/site';
import { addDaysStr, dayTH, footballDate, footballDayRange, isValidDate } from '@/lib/time';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: { absolute: `${SITE_NAME} — ${SITE_TAGLINE}` },
  description: SITE_DESCRIPTION,
  alternates: { canonical: '/' },
};

const noon = (d: string) => `${d}T12:00:00+07:00`;
const isLive = (m: MatchRow) => liveNow(m.status_short, m.kickoff_at);
/** what's on now → what's next (by kickoff) → what's done */
const phase = (m: MatchRow) => (isLive(m) ? 0 : FINISHED.includes(m.status_short) ? 2 : 1);

/**
 * Home = the scoreboard: pick a day (default today) → matches by league.
 * Then 🧭 picks, articles and league widgets on the light page below.
 */
export default async function HomePage({ searchParams }: { searchParams: Promise<{ date?: string; live?: string }> }) {
  const q = await searchParams;
  const today = footballDate();
  const liveView = q.live === '1';
  const date = liveView ? null : isValidDate(q.date) ? q.date : today;
  const onToday = date === today;

  const liveRead = liveMatches();
  // between match days there are no upcoming previews: the fallback read starts alongside instead of after
  const recentRead = soft('recent previews', previewCards('recent', 4), []);
  const noRanks = new Map<number, number>();
  // only the day's matches (or the live list on ?live=1) may fail the page; every other read falls back to empty
  const [shown, live, articles, upcomingPreviews, ranks, prevRanks, registry] = await Promise.all([
    date ? matchesOnFootballDay(date, { withPreDawn: true }) : liveRead,
    soft('live count', liveRead, []),
    soft('articles', latestArticles(4), []),
    soft('upcoming previews', previewCards('upcoming', 4), []),
    date ? soft('featured ranks', featuredRanks(date), noRanks) : noRanks,
    date ? soft('featured ranks', featuredRanks(addDaysStr(date, -1)), noRanks) : noRanks,
    popularityRegistry(),
  ]);
  // the matches' written previews; between match days, the latest ones written
  const previews = upcomingPreviews.length ? upcomingPreviews : await recentRead;
  // matches marked คู่น่าจับตา on the scoreboard: the day's ranked list; finished ones keep the mark with their result
  // the day's own 00:00-06:00 kick-offs belong to the previous football day: they keep that day's gold frames
  const dayFrom = date ? Date.parse(footballDayRange(date).from) : 0;
  const preDawn = shown.filter((m) => Date.parse(m.kickoff_at) < dayFrom);
  const watch = new Set([...watchSlugs(shown.filter((m) => !preDawn.includes(m)), ranks), ...watchSlugs(preDawn, prevRanks)]);
  // league by league: PL, La Liga, Bundesliga, Serie A, Ligue 1 first, then the rest by importance;
  // inside a league on today: live first, then upcoming, then finished; then kickoff order
  const ordered = byLeagueThenKickoff(shown, registry, onToday ? phase : undefined);

  return (
    <main className="pb-8">
      <h1 className="sr-only">
        {SITE_NAME} — วิเคราะห์บอลวันนี้ ผลบอล โปรแกรมแข่ง และบทวิเคราะห์ฟุตบอลด้วยข้อมูล
      </h1>

      {/* ---------------- 1: scoreboard ---------------- */}
      <ScoreboardBand wide>
        <DateStrip base="/" selected={date} today={today} liveCount={live.length} />
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-x-6">
          <section aria-labelledby="day-h" className="min-w-0">
            <BandTitle
              id="day-h"
              title={liveView ? 'กำลังแข่งขัน' : onToday ? 'แมตช์วันนี้' : date! < today ? 'ผลการแข่งขัน' : 'โปรแกรมแข่ง'}
              sub={liveView ? 'อัปเดตสด' : `${dayTH(noon(date!))} · ${shown.length} คู่`}
              aside={!liveView ? <BandLink href="/today" label="วิเคราะห์ทุกคู่" /> : null}
            />
            {ordered.some((m) => m.compass?.kind === 'SIGNAL') ? <SignalLegend /> : null}
            {ordered.length ? (
              <ScoreboardList matches={ordered} date={date} watch={watch} />
            ) : (
              <BandEmpty>{liveView ? 'ตอนนี้ไม่มีคู่ที่กำลังแข่งในลีกที่ติดตาม' : 'ไม่มีแมตช์ในวันนี้ในลีกที่ติดตาม — ลองเลือกวันอื่นจากแถบด้านบน'}</BandEmpty>
            )}
          </section>

          {/* tracked leagues beside the day's matches on wide screens; phones and tablets get them further down */}
          <aside className="mt-4 hidden space-y-4 lg:sticky lg:top-32 lg:block lg:self-start" aria-label="ลีกที่เราวิเคราะห์">
            <Widgets />
          </aside>
        </div>
      </ScoreboardBand>

      <div className="mx-auto mt-8 grid max-w-5xl grid-cols-1 gap-8 px-4">
        <div className="space-y-8">
          {/* ---------------- 3: match previews, then editorial articles when there are some ---------------- */}
          <section aria-labelledby="previews-h">
            <DayHeading id="previews-h" title="บทวิเคราะห์ล่าสุด" href="/analysis" />
            {previews.length ? <PreviewTable previews={previews} /> : <Empty>บทวิเคราะห์จะเผยแพร่ภายใน 48 ชม. ก่อนเตะ</Empty>}
          </section>
          {articles.length ? (
            <section aria-labelledby="articles-h">
              <DayHeading id="articles-h" title="บทความ" href="/analysis" />
              <ArticleGrid articles={articles} />
            </section>
          ) : null}
        </div>

        {/* ---------------- widgets (below lg; on lg they sit beside the scoreboard) ---------------- */}
        <aside className="space-y-4 lg:hidden" aria-label="ลีกที่เราวิเคราะห์">
          <Widgets />
        </aside>
      </div>
    </main>
  );
}

/**
 * Standings and top scorers of every tracked league: the slowest read of the page (thousands of scorer rows),
 * so it streams in after the scoreboard instead of holding it back. Both asides share one read (React cache).
 */
function Widgets() {
  return (
    <Suspense fallback={<WidgetsSkeleton />}>
      <WidgetsLoaded />
    </Suspense>
  );
}

async function WidgetsLoaded() {
  // a side panel: if its read fails the page goes on without it
  const widgets = await soft('league widgets', leagueWidgets(5), null);
  return widgets ? <LeagueWidgets widgets={widgets} /> : null;
}

/** A read the page can live without: on failure it logs and answers `fallback` instead of failing the page. */
async function soft<T>(what: string, read: Promise<T>, fallback: T): Promise<T> {
  try {
    return await read;
  } catch (e) {
    console.error(`home: ${what} unavailable:`, e instanceof Error ? e.message : e);
    return fallback;
  }
}

function WidgetsSkeleton() {
  return (
    <div className="space-y-4 motion-safe:animate-pulse" aria-hidden>
      <div className="h-40 rounded-xl bg-slate-50 ring-1 ring-inset ring-slate-200/80" />
      <div className="h-72 rounded-xl bg-slate-50 ring-1 ring-inset ring-slate-200/80" />
    </div>
  );
}

function DayHeading({ id, title, href, linkLabel = 'ทั้งหมด' }: { id: string; title: string; href?: string; linkLabel?: string }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-3">
      <h2 id={id} className="flex min-w-0 items-center gap-2 text-base font-bold leading-snug">
        <span className="h-4 w-1 shrink-0 rounded-full bg-[var(--color-pitch)]" aria-hidden />
        {title}
      </h2>
      {href ? <MoreLink href={href} label={linkLabel} /> : null}
    </div>
  );
}

/** Says what the compass emblem on a row means; shown only when the day has such a row. */
function SignalLegend() {
  return (
    <p className="mb-3 flex items-center gap-2 text-[13px] leading-snug text-slate-600">
      <CompassMark size={20} />
      <span>คู่ที่มีสัญญาณเข็มทิศเกม · แตะคู่เพื่ออ่านเหตุผล</span>
    </p>
  );
}

function BandLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="inline-flex min-h-11 shrink-0 items-center gap-0.5 rounded-lg px-2 text-xs font-medium text-[var(--color-pitch)] transition-colors hover:bg-[var(--color-pitch-soft)]/60">
      {label}
      <IconChevronRight size={16} />
    </Link>
  );
}
