import type { Metadata } from 'next';
import Link from 'next/link';
import { BigMatches } from '@/components/big-matches';
import { ArticleGrid, MoreLink, PreviewTable } from '@/components/home';
import { featuredList } from '@/components/featured-picks';
import { IconChevronRight } from '@/components/icons';
import { LeagueWidgets } from '@/components/league-widgets';
import { BandEmpty, BandTitle, DateStrip, ScoreboardBand, ScoreboardList } from '@/components/scoreboard';
import { Empty } from '@/components/ui';
import { FINISHED } from '@/lib/labels';
import { isLive as liveNow } from '@/lib/live';
import { bigMatchesOf } from '@/lib/popularity';
import { featuredRanks, latestArticles, leagueWidgets, liveMatches, matchesOnFootballDay, popularityRegistry, previewCards, upcomingSignals, type MatchRow } from '@/lib/queries';
import { SITE_DESCRIPTION, SITE_NAME, SITE_TAGLINE } from '@/lib/site';
import { dayTH, footballDate, isValidDate } from '@/lib/time';

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
const byPhase = (a: MatchRow, b: MatchRow) => phase(a) - phase(b) || Date.parse(a.kickoff_at) - Date.parse(b.kickoff_at);

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

  const [shown, live, signals, articles, leagues, upcomingPreviews, ranks, registry] = await Promise.all([
    date ? matchesOnFootballDay(date) : liveMatches(),
    liveMatches(),
    upcomingSignals(5),
    latestArticles(4),
    leagueWidgets(5),
    previewCards('upcoming', 4),
    date ? featuredRanks(date) : Promise.resolve(new Map<number, number>()),
    popularityRegistry(),
  ]);
  const big = date ? bigMatchesOf(shown, registry, 4) : [];
  // the matches' written previews; between match days, the latest ones written
  const previews = upcomingPreviews.length ? upcomingPreviews : await previewCards('recent', 4);
  // on today: live first, then upcoming, then finished; other days keep kickoff order
  // matches marked คู่น่าจับตา on the scoreboard: the day's ranked list when switched on and filled, otherwise the next signals
  const featured = featuredList(shown, ranks);
  const watch = new Set(featured.length ? featured.map((f) => f.slug) : signals.map((x) => x.fixture_slug));
  const ordered = onToday ? [...shown].sort(byPhase) : shown;

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
            {ordered.length ? (
              <ScoreboardList matches={ordered} date={date} watch={watch} />
            ) : (
              <BandEmpty>{liveView ? 'ตอนนี้ไม่มีคู่ที่กำลังแข่งในลีกที่ติดตาม' : 'ไม่มีแมตช์ในวันนี้ในลีกที่ติดตาม — ลองเลือกวันอื่นจากแถบด้านบน'}</BandEmpty>
            )}
          </section>

          {/* tracked leagues beside the day's matches on wide screens; phones and tablets get them further down */}
          <aside className="mt-4 hidden space-y-4 lg:block" aria-label="ลีกที่เราวิเคราะห์">
            <LeagueWidgets widgets={leagues} />
          </aside>
        </div>
      </ScoreboardBand>

      <div className="mx-auto mt-8 grid max-w-5xl grid-cols-1 gap-8 px-4">
        <div className="space-y-8">
          <BigMatches items={big} title={onToday ? 'คู่ใหญ่วันนี้' : 'คู่ใหญ่'} />
          {/* ---------------- 3: match previews, then editorial articles when there are some ---------------- */}
          <section aria-labelledby="previews-h">
            <DayHeading id="previews-h" kicker="อ่านต่อ" title="บทวิเคราะห์ล่าสุด" href="/analysis" />
            {previews.length ? <PreviewTable previews={previews} /> : <Empty>บทวิเคราะห์จะเผยแพร่ภายใน 48 ชม. ก่อนเตะ</Empty>}
          </section>
          {articles.length ? (
            <section aria-labelledby="articles-h">
              <DayHeading id="articles-h" kicker="อ่านต่อ" title="บทความ" href="/analysis" />
              <ArticleGrid articles={articles} />
            </section>
          ) : null}
        </div>

        {/* ---------------- widgets (below lg; on lg they sit beside the scoreboard) ---------------- */}
        <aside className="space-y-4 lg:hidden" aria-label="ลีกที่เราวิเคราะห์">
          <LeagueWidgets widgets={leagues} />
        </aside>
      </div>
    </main>
  );
}

function DayHeading({ id, kicker, title, href, linkLabel = 'ทั้งหมด' }: { id: string; kicker: string; title: string; href?: string; linkLabel?: string }) {
  return (
    <div className="mb-2 flex items-end justify-between gap-3">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-xs font-semibold text-[var(--color-pitch)]">
          <span className="h-3 w-1 rounded-full bg-current" aria-hidden />
          {kicker}
        </p>
        <h2 id={id} className="mt-0.5 text-base font-bold leading-tight">
          {title}
        </h2>
      </div>
      {href ? <MoreLink href={href} label={linkLabel} /> : null}
    </div>
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
