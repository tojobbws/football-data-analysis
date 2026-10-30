import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CARD, PickCard, RATE, SUB, dayMonthYear, dayName, daySummary, mondayOf, netTone, signed } from '@/components/watched-day';
import { watchedPicks } from '@/lib/queries';
import { footballDate, isValidDate } from '@/lib/time';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ date: string }> }): Promise<Metadata> {
  const { date } = await params;
  return { title: isValidDate(date) ? `ผลงานการวิเคราะห์ คู่น่าจับตา ${dayMonthYear(date)}` : 'ผลงานการวิเคราะห์', robots: { index: false } };
}

/** One football day of คู่น่าจับตา: the day's numbers and every pick with its result. */
export default async function PerformanceDayPage({ params }: { params: Promise<{ date: string }> }) {
  const { date } = await params;
  if (!isValidDate(date)) notFound();
  const monday = mondayOf(date);
  const list = (await watchedPicks(date, 1)).get(date) ?? [];
  const { rate, tone, net, right, wrong } = daySummary(list);
  const pending = list.filter((p) => p.status === 'PENDING').length;

  return (
    <main className="mx-auto max-w-5xl space-y-4 px-4 py-5 sm:space-y-5 sm:py-8">
      <Link href={`/performance?week=${monday}`} className="inline-flex min-h-11 items-center text-sm font-medium text-[var(--color-pitch)] hover:underline">
        ← กลับไปปฏิทินสัปดาห์
      </Link>

      <header className={`rounded-2xl border p-4 ${CARD[tone]}`}>
        <p className="text-sm text-slate-600">
          {dayName(date)} {dayMonthYear(date)}
          {date === footballDate() ? <span className="ml-2 text-[13px] font-medium">วันนี้</span> : null}
        </p>
        <h1 className="mt-0.5 text-xl font-bold leading-snug sm:text-2xl">ผลงานคู่น่าจับตา</h1>
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:flex sm:flex-wrap sm:gap-x-8">
          <div>
            <dt className={`text-[13px] ${SUB[tone]}`}>ทายถูก</dt>
            <dd className={`text-3xl font-bold leading-snug tabular-nums ${RATE[tone]}`}>{rate == null ? '–' : `${(rate * 100).toFixed(0)}%`}</dd>
          </div>
          <div>
            <dt className={`text-[13px] ${SUB[tone]}`}>จำลองคู่ละ 1 หน่วย</dt>
            <dd className={`text-3xl font-bold leading-snug tabular-nums ${net == null ? 'text-slate-600' : netTone(net)}`}>{net == null ? '–' : signed(net)}</dd>
          </div>
          <div>
            <dt className={`text-[13px] ${SUB[tone]}`}>ถูก / ผิด</dt>
            <dd className="text-3xl font-bold leading-snug tabular-nums">
              {right} / {wrong}
            </dd>
          </div>
          <div>
            <dt className={`text-[13px] ${SUB[tone]}`}>ทั้งหมด</dt>
            <dd className="text-3xl font-bold leading-snug tabular-nums">
              {list.length}
              <span className={`ml-1 text-sm font-normal ${SUB[tone]}`}>คู่{pending ? ` · รอผล ${pending}` : ''}</span>
            </dd>
          </div>
        </dl>
      </header>

      {list.length ? (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((p) => (
            <li key={p.slug}>
              <PickCard p={p} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-600">{date >= footballDate() ? 'กำลังวิเคราะห์' : 'ไม่มีคู่น่าจับตาในวันนี้'}</p>
      )}

      <p className="text-[13px] leading-relaxed text-slate-600">
        "หน่วย" คือผลจำลองคู่ละ 1 หน่วย เป็นการคำนวณย้อนหลังเพื่อดูผลงาน ไม่ใช่เงินจริงและไม่ใช่คำแนะนำ: ถูกได้ (ราคา − 1) หน่วย ผิดเสีย 1 หน่วย ผลครึ่งนับครึ่ง เสมอตัวและโมฆะเป็น 0 ใช้ราคา ณ เวลาที่เผยแพร่
      </p>
    </main>
  );
}
