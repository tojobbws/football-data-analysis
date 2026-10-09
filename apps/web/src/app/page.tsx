import type { Metadata } from 'next';
import Link from 'next/link';
import { AutoRefresh } from '@/components/auto-refresh';
import { ArticleGrid, MoreLink, Rail, RailItem } from '@/components/home';
import { IconChevronRight } from '@/components/icons';
import { LeagueWidgets } from '@/components/league-widgets';
import { BandEmpty, BandTitle, DateStrip, ScoreboardBand, ScoreboardList } from '@/components/scoreboard';
import { SignalCard } from '@/components/signal-card';
import { Empty } from '@/components/ui';
import { FINISHED, LIVE, pct } from '@/lib/labels';
import { latestArticles, leagueWidgets, liveMatches, matchesOnFootballDay, perfSummary, upcomingSignals, type MatchRow } from '@/lib/queries';
import { SITE_DESCRIPTION, SITE_NAME, SITE_TAGLINE } from '@/lib/site';
import { dayTH, footballDate, isValidDate } from '@/lib/time';

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

  const [shown, live, signals, perf, articles, leagues] = await Promise.all([
    date ? matchesOnFootballDay(date) : liveMatches(),
    liveMatches(),
    upcomingSignals(4),
    perfSummary(),
    latestArticles(4),
    leagueWidgets(5),
  ]);
  // on today: live first, then upcoming, then finished; other days keep kickoff order
  const ordered = onToday ? [...shown].sort(byPhase) : shown;

  return (
    <main className="pb-8">
      <h1 className="sr-only">
        {SITE_NAME} — วิเคราะห์บอลวันนี้ ผลบอล โปรแกรมแข่ง และบทวิเคราะห์ฟุตบอลด้วยข้อมูล
      </h1>
      {live.length ? <AutoRefresh seconds={60} /> : null}

      {/* ---------------- 1: scoreboard ---------------- */}
      <ScoreboardBand>
        <DateStrip base="/" selected={date} today={today} liveCount={live.length} />
        <section aria-labelledby="day-h">
          <BandTitle
            id="day-h"
            title={liveView ? 'กำลังแข่งขัน' : onToday ? 'แมตช์วันนี้' : date! < today ? 'ผลการแข่งขัน' : 'โปรแกรมแข่ง'}
            sub={liveView ? 'อัปเดตอัตโนมัติทุก 1 นาที' : `${dayTH(noon(date!))} · ${shown.length} คู่`}
            aside={!liveView ? <BandLink href="/today" label="วิเคราะห์ทุกคู่" /> : null}
          />
          {ordered.length ? (
            <ScoreboardList matches={ordered} date={date} />
          ) : (
            <BandEmpty>{liveView ? 'ตอนนี้ไม่มีคู่ที่กำลังแข่งในลีกที่ติดตาม' : 'ไม่มีแมตช์ในวันนี้ในลีกที่ติดตาม — ลองเลือกวันอื่นจากแถบด้านบน'}</BandEmpty>
          )}
        </section>

      </ScoreboardBand>

      <div className="mx-auto mt-8 grid max-w-5xl grid-cols-1 gap-8 px-4 lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-x-6">
        <div className="space-y-8">
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

function DayHeading({ id, kicker, title, href, linkLabel = 'ทั้งหมด' }: { id: string; kicker: string; title: string; href?: string; linkLabel?: string }) {
  return (
    <div className="mb-2 flex items-end justify-between gap-3">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-xs font-semibold text-[var(--color-pitch)]">
          <span className="h-3 w-1 rounded-full bg-current" aria-hidden />
          {kicker}
        </p>
        <h2 id={id} className="mt-0.5 text-lg font-bold leading-tight">
          {title}
        </h2>
      </div>
      {href ? <MoreLink href={href} label={linkLabel} /> : null}
    </div>
  );
}

function BandLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="inline-flex min-h-11 shrink-0 items-center gap-0.5 rounded-lg px-2 text-sm font-medium text-[var(--color-pitch)] transition-colors hover:bg-[var(--color-pitch-soft)]/60">
      {label}
      <IconChevronRight size={16} />
    </Link>
  );
}
