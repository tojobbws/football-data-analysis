import type { Metadata } from 'next';
import Link from 'next/link';
import { COMPASS_LINE, CompassExplainer } from '@/components/compass-explainer';
import { ArticleGrid, MoreLink, PreviewGrid, Rail, RailItem } from '@/components/home';
import { IconChevronRight, CompassMark, IconLock } from '@/components/icons';
import { LeagueWidgets } from '@/components/league-widgets';
import { BandEmpty, BandTitle, DateStrip, ScoreboardBand, ScoreboardList } from '@/components/scoreboard';
import { SignalCard } from '@/components/signal-card';
import { Empty } from '@/components/ui';
import { FINISHED, pct } from '@/lib/labels';
import { isLive as liveNow } from '@/lib/live';
import { latestArticles, leagueWidgets, liveMatches, matchesOnFootballDay, perfSummary, previewCards, upcomingSignals, type MatchRow } from '@/lib/queries';
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

  const [shown, live, signals, perf, articles, leagues, upcomingPreviews] = await Promise.all([
    date ? matchesOnFootballDay(date) : liveMatches(),
    liveMatches(),
    upcomingSignals(4),
    perfSummary(),
    latestArticles(4),
    leagueWidgets(5),
    previewCards('upcoming', 4),
  ]);
  // the matches' written previews; between match days, the latest ones written
  const previews = upcomingPreviews.length ? upcomingPreviews : await previewCards('recent', 4);
  // on today: live first, then upcoming, then finished; other days keep kickoff order
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
              <ScoreboardList matches={ordered} date={date} />
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

      {/* ---------------- 2: compass (white band, like the scoreboard) ---------------- */}
      <div className="border-b border-slate-200 bg-white">
        <section id="compass" className="mx-auto max-w-5xl scroll-mt-28 px-4 pb-6 pt-6" aria-labelledby="compass-h">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div className="min-w-0">
              <h2 id="compass-h" className="flex items-center gap-2.5 text-lg font-bold leading-tight">
                <CompassMark size={40} />
                เข็มทิศเกม คู่น่าจับตา
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-slate-600">{COMPASS_LINE}</p>
              <CompassExplainer />
            </div>
            <MoreLink href="/today" label="ทุกคู่" />
          </div>
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
                      round: s.publish_round,
                    }}
                  />
                </RailItem>
              ))}
            </Rail>
          ) : (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-6 text-center">
              <p className="text-sm font-semibold">ตอนนี้ยังไม่มีคู่ที่ข้อมูลชี้ชัด</p>
              <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-slate-600">
                เราเลือกเฉพาะคู่ที่ข้อมูลสนับสนุนพอ ไม่บังคับเลือกทุกคู่ — บทวิเคราะห์เผยแพร่ภายใน 24 ชม. ก่อนเตะ
              </p>
            </div>
          )}
          {perf && perf.total_signals ? (
            <Link
              href="/performance"
              className="mt-2 flex min-h-11 items-center justify-between gap-3 rounded-xl px-1 text-xs text-slate-600 transition-colors hover:text-[var(--color-ink)]"
            >
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="flex items-center gap-1 font-semibold text-[var(--color-ink)]">
                  <IconLock size={12} />
                  บันทึกสาธารณะ
                </span>
                <span>
                  <b className="text-[var(--color-ink)] tabular-nums">{perf.total_signals}</b> สัญญาณ
                </span>
                {perf.win_rate == null ? (
                  <span>
                    รอตัดสินผล <b className="text-[var(--color-ink)] tabular-nums">{perf.pending}</b>
                  </span>
                ) : (
                  <>
                    <span>
                      Win rate <b className="text-[var(--color-ink)] tabular-nums">{pct(perf.win_rate, 1)}</b>
                    </span>
                    <span>
                      ชนะราคาปิด <b className="text-[var(--color-ink)] tabular-nums">{pct(perf.beat_closing_rate, 0)}</b>
                    </span>
                  </>
                )}
              </span>
              <span className="flex shrink-0 items-center font-medium text-[var(--color-pitch)]">
                ผลงานทั้งหมด
                <IconChevronRight size={16} />
              </span>
            </Link>
          ) : null}
        </section>
      </div>

      <div className="mx-auto mt-8 grid max-w-5xl grid-cols-1 gap-8 px-4">
        <div className="space-y-8">
          {/* ---------------- 3: match previews, then editorial articles when there are some ---------------- */}
          <section aria-labelledby="previews-h">
            <DayHeading id="previews-h" kicker="อ่านต่อ" title="บทวิเคราะห์ล่าสุด" href="/analysis" />
            {previews.length ? <PreviewGrid previews={previews} /> : <Empty>บทวิเคราะห์จะเผยแพร่ภายใน 48 ชม. ก่อนเตะ</Empty>}
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
