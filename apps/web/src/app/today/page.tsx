import type { Metadata } from 'next';
import { ArticleGrid, MoreLink } from '@/components/home';
import { MatchList } from '@/components/match-list';
import { SignalCard } from '@/components/signal-card';
import { Empty, Section } from '@/components/ui';
import { FINISHED } from '@/lib/labels';
import { latestArticles, matchDayCounts, matchesOnFootballDay } from '@/lib/queries';
import { SITE_NAME, siteUrl } from '@/lib/site';
import { addDaysStr, dayTH, footballDate } from '@/lib/time';

export const dynamic = 'force-dynamic';

const noon = (d: string) => `${d}T12:00:00+07:00`;

export async function generateMetadata(): Promise<Metadata> {
  const date = dayTH(noon(footballDate()));
  return {
    title: `วิเคราะห์บอลวันนี้ ${date} ทุกคู่`,
    description: `วิเคราะห์บอลวันนี้ ${date} — โปรแกรมแข่ง ผลบอล ฟอร์ม xG ตัวเจ็บ แรงตลาด และเข็มทิศเกม คู่น่าจับตา จาก${SITE_NAME} บันทึกก่อนเตะทุกคู่`,
    alternates: { canonical: '/today' },
  };
}

/** "Today" is the football day (06:00 → 06:00 Thai time), like the home scoreboard: a 01:45 kickoff is tonight's match. */
export default async function TodayPage() {
  const today = footballDate();
  const [todays, counts, articles] = await Promise.all([matchesOnFootballDay(today), matchDayCounts(addDaysStr(today, 1), 10), latestArticles(12)]);

  // nothing today: show the next day that has matches, and say so
  let day = today;
  let matches = todays;
  if (!matches.length) {
    const next = [...counts.keys()].sort()[0];
    if (next) {
      day = next;
      matches = await matchesOnFootballDay(next);
    }
  }
  const picks = matches.filter((m) => m.compass?.kind === 'SIGNAL' && !FINISHED.includes(m.status_short));
  const leagues = [...new Set(matches.map((m) => m.league.name))];
  const todaysArticles = articles.filter((a) => footballDate(new Date(a.published_at)) === today);
  const origin = await siteUrl();

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `วิเคราะห์บอลวันนี้ ${dayTH(noon(today))}`,
    itemListElement: matches.map((m, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      url: `${origin}/matches/${m.slug}`,
      name: `${m.home.name} vs ${m.away.name}`,
    })),
  };

  return (
    <main className="mx-auto max-w-5xl space-y-5 px-4 py-5 sm:py-8">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      <header>
        <p className="text-sm font-semibold text-[var(--color-pitch)]">{dayTH(noon(today))}</p>
        <h1 className="mt-1 text-2xl font-bold sm:text-3xl">วิเคราะห์บอลวันนี้</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-600 sm:text-base">
          {day === today
            ? `รวมการวิเคราะห์บอลวันนี้ ${matches.length} คู่`
            : `วันนี้ไม่มีแมตช์ในลีกที่เราติดตาม — คู่ถัดไปคือ${dayTH(noon(day))} ${matches.length} คู่`}
          {leagues.length ? ` จาก ${leagues.join(', ')}` : ''} ทุกคู่มีบทวิเคราะห์ มุมมองทั้งสองทีม และโอกาสของจำนวนประตูจากโมเดล พร้อมหมายเหตุเมื่อข้อมูลสนับสนุนไม่พอ
          บวกข้อมูลฟอร์ม 5 นัด, xG, ตัวเจ็บ, ตารางคะแนน และแรงตลาด
          ส่วนเข็มทิศเกม เลือก 1 ตัวเลือกต่อคู่ ตรงจุดที่โมเดลมองต่างจากตลาดชัดที่สุด และล็อกไว้ก่อนเตะเสมอ
        </p>
      </header>

      <Section title="เข็มทิศเกม คู่น่าจับตา" aside="ล็อกก่อนเตะ แก้ไขไม่ได้">
        {picks.length ? (
          <ul className="grid gap-3 sm:grid-cols-2">
            {picks.map((m) => (
              <li key={m.id}>
                <SignalCard
                  s={{
                    slug: m.slug,
                    league: m.league.name,
                    kickoff_at: m.kickoff_at,
                    home: m.home.name,
                    away: m.away.name,
                    home_logo: m.home.logo_url,
                    away_logo: m.away.logo_url,
                    market: m.compass!.market!,
                    selection: m.compass!.selection!,
                    line: m.compass!.line,
                    signal_strength: m.compass!.signal_strength,
                    model_probability: m.compass!.model_probability,
                    market_probability: m.compass!.market_probability,
                    odds_at_publish: m.compass!.odds_at_publish,
                    round: m.compass!.publish_round,
                  }}
                />
              </li>
            ))}
          </ul>
        ) : (
          <Empty>ยังไม่มีคู่ที่ผ่านเกณฑ์ — บทวิเคราะห์จะเผยแพร่ภายใน 24 ชม. ก่อนเตะ</Empty>
        )}
      </Section>

      <section aria-labelledby="today-fixtures">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 id="today-fixtures" className="text-lg font-bold">
            {day === today ? 'โปรแกรมบอลและบทวิเคราะห์วันนี้' : `โปรแกรมบอลและบทวิเคราะห์ ${dayTH(noon(day))}`}
          </h2>
          <MoreLink href={`/matches?date=${day}`} label="ดูตามวัน" />
        </div>
        {matches.length ? <MatchList matches={matches} /> : <Empty>ยังไม่มีโปรแกรมแข่งในลีกที่ติดตาม</Empty>}
      </section>

      {/* each match's written preview is already in the list above; editorial articles show only when there are some */}
      {todaysArticles.length ? (
        <Section title="บทความวันนี้" aside={<MoreLink href="/analysis" label="ทั้งหมด" />}>
          <ArticleGrid articles={todaysArticles} />
        </Section>
      ) : null}
    </main>
  );
}
