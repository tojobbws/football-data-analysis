import type { Metadata } from 'next';
import Link from 'next/link';
import { MatchList } from '@/components/match-list';
import { IconChevronLeft, IconChevronRight } from '@/components/icons';
import { ScrollToCurrent } from '@/components/scroll-to-current';
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
    <main className="mx-auto max-w-5xl space-y-4 px-4 py-5 sm:py-8">
      <h1 className="text-xl font-bold sm:text-2xl">
        แมตช์ <span className="font-normal text-slate-600">· {dayTH(`${date}T12:00:00+07:00`)}</span>
      </h1>
      {/* arrows stay put; only the days scroll (and the selected day is centred on load) */}
      <nav className="flex items-stretch gap-2" aria-label="เลือกวัน">
        <Link href={`/matches?date=${addDaysStr(date, -7)}`} className="flex min-h-14 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 hover:bg-slate-50" aria-label="สัปดาห์ก่อน">
          <IconChevronLeft size={18} />
        </Link>
        <ScrollToCurrent className="rail flex min-w-0 flex-1 snap-x gap-2 overflow-x-auto">
          {strip.map((d) => (
            <Link
              key={d}
              href={`/matches?date=${d}`}
              aria-current={d === date ? 'date' : undefined}
              className={`flex min-h-14 min-w-[4.75rem] flex-1 shrink-0 snap-center flex-col items-center justify-center rounded-xl border px-3 py-2 text-center text-sm transition-colors ${d === date ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-white' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
            >
              <span className="block whitespace-nowrap">{d === today ? 'วันนี้' : shortDayTH(`${d}T12:00:00+07:00`)}</span>
              <span className={`text-xs ${d === date ? 'text-slate-300' : 'text-slate-500'}`}>{counts.get(d) ?? 0} นัด</span>
            </Link>
          ))}
        </ScrollToCurrent>
        <Link href={`/matches?date=${addDaysStr(date, 7)}`} className="flex min-h-14 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 hover:bg-slate-50" aria-label="สัปดาห์ถัดไป">
          <IconChevronRight size={18} />
        </Link>
      </nav>
      {matches.length ? <MatchList matches={matches} /> : <Empty>ไม่มีแมตช์ในวันนี้ในลีกที่ติดตาม</Empty>}
    </main>
  );
}
