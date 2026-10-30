import type { Metadata } from 'next';
import Link from 'next/link';
import { CARD, RATE, SUB, dayMonth, dayName, dayOfMonth, daySummary, mondayOf, netTone, signed } from '@/components/watched-day';
import { watchedPicks } from '@/lib/queries';
import { addDaysStr, footballDate, isValidDate } from '@/lib/time';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'ผลงานการวิเคราะห์ คู่น่าจับตา',
  description: 'ผลของเข็มทิศเกม คู่น่าจับตา สรุปเป็นรายวัน ปฏิทิน 7 วัน จันทร์ถึงอาทิตย์ ทั้งถูกและผิด',
};

const NAV = 'inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-full border border-slate-200 bg-white px-2.5 hover:bg-slate-50 sm:px-4';

export default async function PerformancePage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const { week } = await searchParams;
  const today = footballDate();
  const monday = mondayOf(isValidDate(week) ? week : today);
  const days = Array.from({ length: 7 }, (_, i) => addDaysStr(monday, i));
  const picks = await watchedPicks(monday);
  const isCurrent = monday === mondayOf(today);
  const total = [...picks.values()].reduce((n, l) => n + l.length, 0);

  return (
    <main className="mx-auto max-w-7xl space-y-4 px-4 py-5 sm:space-y-5 sm:py-8">
      <div>
        <h1 className="text-2xl font-bold sm:text-3xl">ผลงานการวิเคราะห์</h1>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-600">
          เฉพาะ <b>คู่น่าจับตา</b> สรุปเป็นรายวัน ไม่ลบผลที่ผิด สีเขียวคือวันที่ถูกมากกว่าผิด สีแดงคือผิดมากกว่าถูก กดดูรายละเอียดรายคู่ของแต่ละวันได้
        </p>
      </div>

      <nav className="flex items-center justify-between gap-2 text-sm sm:gap-3" aria-label="เลือกสัปดาห์">
        {/* on a phone the buttons keep to one line with a shorter word; the full label stays for screen readers */}
        <Link href={`/performance?week=${addDaysStr(monday, -7)}`} aria-label="สัปดาห์ก่อน" className={NAV}>
          ← <span className="ml-1 sm:hidden">ก่อนหน้า</span>
          <span className="ml-1 hidden sm:inline">สัปดาห์ก่อน</span>
        </Link>
        <p className="min-w-0 text-center font-semibold leading-snug tabular-nums">
          <span className="whitespace-nowrap">
            {dayMonth(monday)} – {dayMonth(days[6]!)}
          </span>
          {isCurrent ? <span className="block text-[13px] font-normal text-slate-600">สัปดาห์นี้</span> : null}
        </p>
        {isCurrent ? (
          <span aria-hidden="true" className="inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-full border border-transparent px-2.5 text-slate-300 sm:px-4">
            <span className="mr-1 sm:hidden">ถัดไป</span>
            <span className="mr-1 hidden sm:inline">สัปดาห์ถัดไป</span> →
          </span>
        ) : (
          <Link href={`/performance?week=${addDaysStr(monday, 7)}`} aria-label="สัปดาห์ถัดไป" className={NAV}>
            <span className="mr-1 sm:hidden">ถัดไป</span>
            <span className="mr-1 hidden sm:inline">สัปดาห์ถัดไป</span> →
          </Link>
        )}
      </nav>

      {total === 0 ? <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-600">ยังไม่มีคู่น่าจับตาในสัปดาห์นี้</p> : null}

      {/* a week as a calendar row: Monday to Sunday; on a phone the days stack and today comes first */}
      <ol className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {days.map((date) => {
          const list = picks.get(date) ?? [];
          const { rate, tone, net } = daySummary(list);
          const isToday = date === today;
          return (
            <li
              key={date}
              aria-current={isToday ? 'date' : undefined}
              className={`flex flex-col rounded-2xl border p-3 ${CARD[tone]} ${isToday ? 'order-first col-span-2 ring-2 ring-slate-500 sm:order-none sm:col-span-1' : ''}`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-1">
                <h2 className="text-sm font-bold leading-snug">{dayName(date)}</h2>
                {isToday ? <span className={`text-[13px] font-medium ${SUB[tone]}`}>วันนี้</span> : null}
              </div>
              <p className={`text-[13px] ${SUB[tone]}`}>{dayOfMonth(date)} {dayMonth(date).replace(/^\d+\s*/, '')}</p>

              <div className="mt-3 flex-1">
                {rate != null ? (
                  <>
                    <p className={`text-3xl font-bold leading-tight tabular-nums ${RATE[tone]}`}>
                      {(rate * 100).toFixed(0)}
                      <span className="text-lg">%</span>
                    </p>
                    <p className={`text-[13px] leading-snug ${SUB[tone]}`}>ทายถูก</p>
                  </>
                ) : (
                  <p className="text-sm leading-snug text-slate-600">{list.length ? 'รอผล' : date >= today ? 'กำลังวิเคราะห์' : 'ไม่มีคู่'}</p>
                )}
                {net != null ? (
                  <p className={`mt-2 text-lg font-bold leading-snug tabular-nums ${netTone(net)}`}>
                    {signed(net)}
                    <span className={`ml-1 text-[13px] font-normal ${SUB[tone]}`}>หน่วย</span>
                  </p>
                ) : null}
                {list.length ? <p className={`mt-1 text-[13px] leading-snug ${SUB[tone]}`}>{list.length} คู่</p> : null}
              </div>

              {list.length ? (
                <Link
                  href={`/performance/${date}`}
                  aria-label={`ดูรายละเอียดคู่น่าจับตา ${dayName(date)} ${dayOfMonth(date)} ${dayMonth(date).replace(/^\d+\s*/, '')}`}
                  className="mt-3 inline-flex min-h-11 items-center justify-center rounded-full bg-white px-3 text-sm font-semibold ring-1 ring-slate-300 hover:bg-slate-50"
                >
                  ดูรายละเอียด
                </Link>
              ) : null}
            </li>
          );
        })}
      </ol>

      <p className="text-[13px] leading-relaxed text-slate-600">
        "หน่วย" คือผลจำลองคู่ละ 1 หน่วย เป็นการคำนวณย้อนหลังเพื่อดูผลงาน ไม่ใช่เงินจริงและไม่ใช่คำแนะนำ: ถูกได้ (ราคา − 1) หน่วย ผิดเสีย 1 หน่วย ผลครึ่งนับครึ่ง เสมอตัวและโมฆะเป็น 0
        ใช้ราคา ณ เวลาที่เผยแพร่ และยังไม่นับคู่ที่รอผล ส่วน % นับแบบเดียวกัน ถูกครึ่งและผิดครึ่งนับครึ่ง เสมอตัวและโมฆะไม่นับ
      </p>
    </main>
  );
}
