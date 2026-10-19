import type { Metadata } from 'next';
import { ScrollTopOnEnter } from '@/components/scroll-top-on-enter';
import { BandEmpty, BandTitle, DateStrip, ScoreboardBand, ScoreboardList } from '@/components/scoreboard';
import { liveMatches, matchesOnFootballDay } from '@/lib/queries';
import { dayTH, footballDate, isValidDate } from '@/lib/time';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'ผลบอล โปรแกรมบอล และบทวิเคราะห์รายวัน',
  description: 'ผลบอลและโปรแกรมแข่งฟุตบอลรายวัน เลือกดูตามวันที่ พร้อม 🧭 เข็มทิศเกม',
  alternates: { canonical: '/matches' },
};

/** Results and fixtures by day — the dark scoreboard on its own page. */
export default async function MatchesPage({ searchParams }: { searchParams: Promise<{ date?: string; live?: string }> }) {
  const q = await searchParams;
  const today = footballDate();
  const liveView = q.live === '1';
  const date = liveView ? null : isValidDate(q.date) ? q.date : today;
  const [matches, live] = await Promise.all([date ? matchesOnFootballDay(date) : liveMatches(), liveMatches()]);
  const title = liveView ? 'กำลังแข่งขัน' : date === today ? 'แมตช์วันนี้' : date! < today ? 'ผลการแข่งขัน' : 'โปรแกรมแข่ง';

  return (
    <main className="min-h-[70vh] bg-white">
      <ScrollTopOnEnter />
      <ScoreboardBand>
        <DateStrip base="/matches" selected={date} today={today} liveCount={live.length} />
        <h1 className="sr-only">
          ผลบอล โปรแกรมบอล {liveView ? 'ที่กำลังแข่งขัน' : dayTH(`${date}T12:00:00+07:00`)}
        </h1>
        <BandTitle title={title} sub={liveView ? 'อัปเดตสด' : `${dayTH(`${date}T12:00:00+07:00`)} · ${matches.length} คู่`} />
        {matches.length ? (
          <ScoreboardList matches={matches} date={date} />
        ) : (
          <BandEmpty>{liveView ? 'ตอนนี้ไม่มีคู่ที่กำลังแข่งในลีกที่ติดตาม' : 'ไม่มีแมตช์ในวันนี้ในลีกที่ติดตาม — ลองเลือกวันอื่นจากแถบด้านบน'}</BandEmpty>
        )}
      </ScoreboardBand>
    </main>
  );
}
