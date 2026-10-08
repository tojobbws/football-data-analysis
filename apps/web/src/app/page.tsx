import type { Metadata } from 'next';
import Link from 'next/link';
import { AutoRefresh } from '@/components/auto-refresh';
import { ArticleGrid, BandHeading, MoreLink, Rail, RailItem, ScoreTile, WeeklyWinRate } from '@/components/home';
import { LeagueWidgets } from '@/components/league-widgets';
import { MatchList } from '@/components/match-list';
import { SignalCard } from '@/components/signal-card';
import { Empty, Section } from '@/components/ui';
import { FINISHED, LIVE, pct } from '@/lib/labels';
import { latestArticles, leagueWidgets, liveMatches, matchDayCounts, matchesOnDay, perfSummary, upcomingSignals, weeklyPerformance } from '@/lib/queries';
import { SITE_DESCRIPTION, SITE_NAME, SITE_TAGLINE } from '@/lib/site';
import { addDaysStr, dayTH, thaiDate } from '@/lib/time';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: { absolute: `${SITE_NAME} — ${SITE_TAGLINE}` },
  description: SITE_DESCRIPTION,
  alternates: { canonical: '/' },
};

const RESULTS_SHOWN = 8;

export default async function HomePage() {
  const today = thaiDate();
  const yesterday = addDaysStr(today, -1);
  const [live, played, todays, counts, signals, perf, weeks, articles, leagues] = await Promise.all([
    liveMatches(),
    matchesOnDay(yesterday),
    matchesOnDay(today),
    matchDayCounts(addDaysStr(today, 1), 10),
    upcomingSignals(6),
    perfSummary(),
    weeklyPerformance(8),
    latestArticles(12),
    leagueWidgets(5),
  ]);

  const results = played.filter((m) => FINISHED.includes(m.status_short));
  // still to kick off today; when today is done, the next day that has matches
  let upcoming = todays.filter((m) => !FINISHED.includes(m.status_short) && !LIVE.includes(m.status_short));
  let upcomingDay = today;
  if (!upcoming.length) {
    const next = [...counts.keys()].sort()[0];
    if (next) {
      upcomingDay = next;
      upcoming = await matchesOnDay(next);
    }
  }
  const todaysArticles = articles.filter((a) => thaiDate(new Date(a.published_at)) === today);
  const moreArticles = articles.filter((a) => !todaysArticles.includes(a)).slice(0, 6);

  return (
    <main className="mx-auto max-w-5xl px-4 py-5 sm:py-8">
      <h1 className="sr-only">
        {SITE_NAME} — วิเคราะห์บอลวันนี้ ผลบอล โปรแกรมแข่ง และบทวิเคราะห์ฟุตบอลด้วยข้อมูล
      </h1>
      {live.length ? <AutoRefresh seconds={60} /> : null}

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_300px] lg:grid-rows-[auto_auto_1fr] lg:gap-x-6">
        {/* ---------------- 1: on the pitch ---------------- */}
        <section className="space-y-6" aria-label="สนามตอนนี้">
          <div>
            <BandHeading kicker="สนามตอนนี้" title={live.length ? `กำลังแข่ง ${live.length} คู่` : 'ผลบอลเมื่อวาน'} />

            {live.length ? (
              <div className="mb-6">
                <p className="mb-2 flex items-center gap-2 text-xs text-slate-600">
                  <span className="h-2 w-2 rounded-full bg-[var(--color-live)] motion-safe:animate-pulse" aria-hidden />
                  สด · อัปเดตอัตโนมัติทุก 1 นาที
                </p>
                <Rail label="คู่ที่กำลังแข่ง">
                  {live.map((m) => (
                    <RailItem key={m.id}>
                      <ScoreTile m={m} />
                    </RailItem>
                  ))}
                </Rail>
              </div>
            ) : null}

            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="text-base font-semibold">{live.length ? 'ผลการแข่งขันเมื่อวาน' : dayTH(`${yesterday}T12:00:00+07:00`)}</h3>
              <MoreLink href={`/matches?date=${yesterday}`} label={results.length > RESULTS_SHOWN ? `ดูครบ ${results.length} คู่` : 'ดูตามวัน'} />
            </div>
            {results.length ? (
              <Rail label="ผลการแข่งขันเมื่อวาน">
                {results.slice(0, RESULTS_SHOWN).map((m) => (
                  <RailItem key={m.id}>
                    <ScoreTile m={m} />
                  </RailItem>
                ))}
              </Rail>
            ) : (
              <Empty>เมื่อวานไม่มีแมตช์ในลีกที่ติดตาม</Empty>
            )}
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="text-base font-semibold">{upcomingDay === today ? 'โปรแกรมแข่งวันนี้' : `โปรแกรมถัดไป · ${dayTH(`${upcomingDay}T12:00:00+07:00`)}`}</h3>
              <MoreLink href="/today" label="วิเคราะห์บอลวันนี้" />
            </div>
            {upcoming.length ? <MatchList matches={upcoming} /> : <Empty>ยังไม่มีโปรแกรมแข่งในลีกที่ติดตาม</Empty>}
          </div>
        </section>

        {/* ---------------- 2: compass ---------------- */}
        <section id="compass" className="scroll-mt-20 space-y-4" aria-label="เข็มทิศเกม">
          <BandHeading kicker="เข็มทิศเกม" title="คู่น่าจับตาและผลงานการวิเคราะห์" href="/performance" linkLabel="ผลงานทั้งหมด" />

          <Section title="🧭 คู่น่าจับตา" aside="ล็อกก่อนเตะ แก้ไขไม่ได้">
            {signals.length ? (
              <ul className="grid gap-3 sm:grid-cols-2">
                {signals.map((s) => (
                  <li key={s.public_id}>
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
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>ยังไม่มีคู่ที่ผ่านเกณฑ์ในขณะนี้ — บทวิเคราะห์จะเผยแพร่ภายใน 24 ชม. ก่อนเตะ</Empty>
            )}
          </Section>

          <Section title="บทวิเคราะห์วันนี้" aside={<MoreLink href="/analysis" label="ทั้งหมด" />}>
            {todaysArticles.length ? <ArticleGrid articles={todaysArticles} /> : <Empty>ยังไม่มีบทวิเคราะห์ที่เผยแพร่วันนี้</Empty>}
          </Section>

          <Section title="สรุปผลการวิเคราะห์" aside="ทุกสัญญาณ ทั้งถูกและผิด">
            {perf && perf.total_signals ? (
              <dl className="mb-5 grid grid-cols-3 gap-2">
                <Kpi k="สัญญาณทั้งหมด" v={String(perf.total_signals)} />
                <Kpi k="Win rate รวม" v={pct(perf.win_rate, 1)} />
                <Kpi k="ชนะราคาปิด" v={pct(perf.beat_closing_rate, 0)} />
              </dl>
            ) : null}
            {weeks.some((w) => w.settled) ? <WeeklyWinRate weeks={weeks} /> : <Empty>ยังไม่มีสัญญาณที่ตัดสินผลแล้ว — ผลรายสัปดาห์จะแสดงที่นี่</Empty>}
          </Section>
        </section>

        {/* ---------------- widgets ---------------- */}
        <aside className="space-y-4 lg:col-start-2 lg:row-span-3 lg:row-start-1" aria-label="ข้อมูลลีก">
          <LeagueWidgets widgets={leagues} />
        </aside>

        {/* ---------------- 3: articles ---------------- */}
        <section className="lg:col-start-1" aria-label="บทความ">
          <BandHeading kicker="อ่านต่อ" title="ข่าวและบทความ" href="/analysis" />
          {moreArticles.length ? <ArticleGrid articles={moreArticles} /> : <Empty>ยังไม่มีบทความ</Empty>}
        </section>
      </div>
    </main>
  );
}

function Kpi({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2.5">
      <dt className="text-xs text-slate-600">{k}</dt>
      <dd className="mt-0.5 text-xl font-bold tabular-nums">{v}</dd>
    </div>
  );
}
