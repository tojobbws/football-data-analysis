import type { Metadata } from 'next';
import Link from 'next/link';
import { MatchList } from '@/components/match-list';
import { Empty } from '@/components/ui';
import { matchDayCounts, matchesOnDay } from '@/lib/queries';
import { addDaysStr, dayTH, isValidDate, shortDayTH, thaiDate } from '@/lib/time';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'แมตช์ฟุตบอล ตารางแข่ง และบทวิเคราะห์', description: 'ตารางแข่งฟุตบอลรายวัน พร้อม 🧭 เข็มทิศเกม และผลการแข่งขัน' };

export default async function MatchesPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const { date: q } = await searchParams;
  const today = thaiDate();
  const date = isValidDate(q) ? q : today;
  const start = addDaysStr(date, -3);
  const [matches, counts] = await Promise.all([matchesOnDay(date), matchDayCounts(start, 7)]);
  const strip = Array.from({ length: 7 }, (_, i) => addDaysStr(start, i));

  return (
    <main className="mx-auto max-w-5xl space-y-5 px-4 py-6">
      <h1 className="text-xl font-bold">🔎 แมตช์ · {dayTH(`${date}T12:00:00+07:00`)}</h1>
      <nav className="flex gap-2 overflow-x-auto pb-1" aria-label="เลือกวัน">
        <Link href={`/matches?date=${addDaysStr(date, -7)}`} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm" aria-label="สัปดาห์ก่อน">
          ‹
        </Link>
        {strip.map((d) => (
          <Link
            key={d}
            href={`/matches?date=${d}`}
            className={`min-w-[4.75rem] rounded-xl border px-3 py-2 text-center text-sm ${d === date ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-white' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
          >
            <span className="block whitespace-nowrap">{d === today ? 'วันนี้' : shortDayTH(`${d}T12:00:00+07:00`)}</span>
            <span className={`text-xs ${d === date ? 'text-slate-300' : 'text-slate-400'}`}>{counts.get(d) ?? 0} นัด</span>
          </Link>
        ))}
        <Link href={`/matches?date=${addDaysStr(date, 7)}`} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm" aria-label="สัปดาห์ถัดไป">
          ›
        </Link>
      </nav>
      {matches.length ? <MatchList matches={matches} /> : <Empty>ไม่มีแมตช์ในวันนี้ในลีกที่ติดตาม</Empty>}
    </main>
  );
}
