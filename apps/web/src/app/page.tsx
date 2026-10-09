import type { Metadata } from 'next';
import Link from 'next/link';
import { AutoRefresh } from '@/components/auto-refresh';
import { DayTabs } from '@/components/day-tabs';
import { ArticleGrid, MoreLink, Rail, RailItem } from '@/components/home';
import { IconChevronRight } from '@/components/icons';
import { LeagueWidgets } from '@/components/league-widgets';
import { MatchList } from '@/components/match-list';
import { SignalCard } from '@/components/signal-card';
import { Empty } from '@/components/ui';
import { FINISHED, LIVE, pct } from '@/lib/labels';
import { latestArticles, leagueWidgets, matchDayCounts, matchesOnDay, perfSummary, upcomingSignals, type MatchRow } from '@/lib/queries';
import { SITE_DESCRIPTION, SITE_NAME, SITE_TAGLINE } from '@/lib/site';
import { addDaysStr, dayTH, shortDayTH, thaiDate } from '@/lib/time';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: { absolute: `${SITE_NAME} — ${SITE_TAGLINE}` },
  description: SITE_DESCRIPTION,
  alternates: { canonical: '/' },
};

const noon = (d: string) => `${d}T12:00:00+07:00`;
const isLive = (m: MatchRow) => LIVE.includes(m.status_short);
/** what's on now → what's next (by kickoff) → what's done */
const phase = (m: MatchRow) => (isLive(m) ? 0 : FINISHED.includes(m.status_short) ? 2 : 1);

/**
 * Home = today's scoreboard first, yesterday's results second, everything else below.
 * Mobile first: one column, dense rows, sticky day tabs to jump between the two days.
 */
export default async function HomePage() {
  const today = thaiDate();
  const yesterday = addDaysStr(today, -1);
  const tomorrow = addDaysStr(today, 1);
  const [todays, played, counts, signals, perf, articles, leagues] = await Promise.all([
    matchesOnDay(today),
    matchesOnDay(yesterday),
    matchDayCounts(tomorrow, 10),
    upcomingSignals(4),
    perfSummary(),
    latestArticles(4),
    leagueWidgets(5),
  ]);

  // nothing today: show the next day that has matches, and say so
  let day = today;
  let matches = todays;
  if (!matches.length) {
    const next = [...counts.keys()].sort()[0];
    if (next) {
      day = next;
      matches = await matchesOnDay(next);
    }
  }
  const ordered = [...matches].sort((a, b) => phase(a) - phase(b) || Date.parse(a.kickoff_at) - Date.parse(b.kickoff_at));
  const liveToday = matches.filter(isLive).length;
  const liveYesterday = played.filter(isLive).length; // late kick-offs still in play after midnight

  const tabs = [
    { id: 'today', label: day === today ? 'วันนี้' : shortDayTH(noon(day)), count: matches.length, live: liveToday },
    { id: 'yesterday', label: 'เมื่อวาน', count: played.length, live: liveYesterday },
  ];

  return (
    <main className="mx-auto max-w-5xl px-4 pb-8">
      <h1 className="sr-only">
        {SITE_NAME} — วิเคราะห์บอลวันนี้ ผลบอล โปรแกรมแข่ง และบทวิเคราะห์ฟุตบอลด้วยข้อมูล
      </h1>
      {liveToday + liveYesterday ? <AutoRefresh seconds={60} /> : null}

      <DayTabs tabs={tabs} nextHref={`/matches?date=${day === today ? tomorrow : addDaysStr(day, 1)}`} nextLabel={day === today ? 'พรุ่งนี้' : 'วันถัดไป'} calendarHref="/matches" />

      <div className="mt-2 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-x-6">
        <div className="space-y-8">
          {/* ---------------- 1: today ---------------- */}
          <section id="today" className="scroll-mt-28" aria-labelledby="today-h">
            <DayHeading
              id="today-h"
              kicker={dayTH(noon(day))}
              title={day === today ? 'แมตช์วันนี้' : 'โปรแกรมถัดไป'}
              count={matches.length}
              live={liveToday}
              href="/today"
              linkLabel="วิเคราะห์ทุกคู่"
            />
            {day !== today ? <p className="mb-2 text-sm text-slate-600">วันนี้ไม่มีแมตช์ในลีกที่เราติดตาม — นี่คือโปรแกรมวันถัดไปที่มีแข่ง</p> : null}
            {ordered.length ? <MatchList matches={ordered} compact /> : <Empty>ยังไม่มีโปรแกรมแข่งในลีกที่ติดตาม</Empty>}
          </section>

          {/* ---------------- 2: yesterday ---------------- */}
          <section id="yesterday" className="scroll-mt-28" aria-labelledby="yesterday-h">
            <DayHeading id="yesterday-h" kicker={dayTH(noon(yesterday))} title="ผลบอลเมื่อวาน" count={played.length} live={liveYesterday} href={`/matches?date=${yesterday}`} linkLabel="ดูตามวัน" />
            {played.length ? <MatchList matches={played} compact /> : <Empty>เมื่อวานไม่มีแมตช์ในลีกที่ติดตาม</Empty>}
          </section>

          {/* ---------------- 3: compass ---------------- */}
          <section id="compass" className="scroll-mt-28" aria-labelledby="compass-h">
            <DayHeading id="compass-h" kicker="เข็มทิศเกม" title="🧭 คู่น่าจับตา" href="/performance" linkLabel="ผลงานทั้งหมด" />
            {signals.length ? (
              <Rail label="คู่น่าจับตา">
                {signals.map((s) => (
                  <RailItem key={s.public_id}>
                    <SignalCard
                      s={{
                        slug: s.fixture_slug,
                        league: s.league_name,
                        kickoff_at: s.kickoff_at,
                        home: s.home_team,
                        away: s.away_team,
                        market: s.market!,
                        selection: s.selection!,
                        line: s.line,
                        signal_strength: s.signal_strength,
                        model_probability: s.model_probability,
                        market_probability: s.market_probability,
                        odds_at_publish: s.odds_at_publish,
                      }}
                    />
                  </RailItem>
                ))}
              </Rail>
            ) : (
              <Empty>ยังไม่มีคู่ที่ผ่านเกณฑ์ในขณะนี้ — บทวิเคราะห์จะเผยแพร่ภายใน 24 ชม. ก่อนเตะ</Empty>
            )}
            {perf && perf.total_signals ? (
              <Link href="/performance" className="mt-3 flex min-h-11 items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 text-sm transition-colors hover:bg-slate-50">
                <span className="text-slate-600">
                  ผลงานรวม <b className="text-[var(--color-ink)] tabular-nums">{perf.total_signals}</b> สัญญาณ · Win rate <b className="text-[var(--color-ink)] tabular-nums">{pct(perf.win_rate, 1)}</b> · ชนะราคาปิด{' '}
                  <b className="text-[var(--color-ink)] tabular-nums">{pct(perf.beat_closing_rate, 0)}</b>
                </span>
                <IconChevronRight size={16} className="shrink-0 text-slate-500" />
              </Link>
            ) : null}
          </section>

          {/* ---------------- 4: articles ---------------- */}
          <section aria-labelledby="articles-h">
            <DayHeading id="articles-h" kicker="อ่านต่อ" title="บทวิเคราะห์ล่าสุด" href="/analysis" />
            {articles.length ? <ArticleGrid articles={articles} /> : <Empty>ยังไม่มีบทความ</Empty>}
          </section>
        </div>

        {/* ---------------- widgets ---------------- */}
        <aside className="space-y-4" aria-label="ข้อมูลลีก">
          <LeagueWidgets widgets={leagues} />
        </aside>
      </div>
    </main>
  );
}

function DayHeading({ id, kicker, title, count, live, href, linkLabel = 'ทั้งหมด' }: { id: string; kicker: string; title: string; count?: number; live?: number; href?: string; linkLabel?: string }) {
  return (
    <div className="mb-2 flex items-end justify-between gap-3">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-xs font-semibold text-[var(--color-pitch)]">
          <span className="h-3 w-1 rounded-full bg-current" aria-hidden />
          {kicker}
        </p>
        <h2 id={id} className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-lg font-bold leading-tight">
          {title}
          {count != null ? <span className="text-sm font-normal text-slate-500">{count} คู่</span> : null}
          {live ? (
            <span className="inline-flex items-center gap-1 text-xs font-bold text-[var(--color-live)]">
              <span className="h-1.5 w-1.5 rounded-full bg-current motion-safe:animate-pulse" aria-hidden />
              สด {live}
            </span>
          ) : null}
        </h2>
      </div>
      {href ? <MoreLink href={href} label={linkLabel} /> : null}
    </div>
  );
}
