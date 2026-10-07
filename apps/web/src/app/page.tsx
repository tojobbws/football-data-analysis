import Link from 'next/link';
import { MatchList } from '@/components/match-list';
import { Empty, Section } from '@/components/ui';
import { matchDayCounts, matchesOnDay, performance, upcomingSignals } from '@/lib/queries';
import { odds, pct, selectionLabel } from '@/lib/labels';
import { dayTH, thaiDate, timeTH } from '@/lib/time';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const today = thaiDate();
  const [counts, signals, perf] = await Promise.all([matchDayCounts(today, 10), upcomingSignals(6), performance()]);
  // today, or the next day that has matches
  const day = counts.get(today) ? today : ([...counts.keys()].sort()[0] ?? today);
  const matches = await matchesOnDay(day);
  const all = perf.buckets.find((b) => b.dimension === 'all');

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-6">
      <section className="rounded-3xl bg-[var(--color-ink)] px-5 py-7 text-white sm:px-8">
        <p className="text-sm text-slate-300">Football Data &amp; Analysis</p>
        <h1 className="mt-1 text-2xl font-bold sm:text-3xl">🧭 เข็มทิศเกม: ทิศทางที่ข้อมูลชี้ไป</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-300">
          โมเดลสถิติ + ข้อมูลตลาด เลือก <b>1 ตัวเลือก</b> ที่มี Data Support สูงสุดต่อคู่ หรือบอกตรง ๆ ว่า 🌫️ หมอกข้อมูล — ทุกบทวิเคราะห์ถูกล็อกก่อนเตะ
          และเปิดผลให้ตรวจสอบทั้งหมด
        </p>
        {all ? (
          <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <span>
              สัญญาณทั้งหมด <b className="text-lg">{all.total_signals}</b>
            </span>
            <span>
              Win rate <b className="text-lg">{pct(all.win_rate, 1)}</b>
            </span>
            <Link href="/performance" className="text-teal-300 hover:underline">
              ดูผลงานทั้งหมด →
            </Link>
          </div>
        ) : null}
      </section>

      <Section title="🧭 เข็มทิศเกม ที่กำลังจะเตะ" aside="ล็อกแล้ว แก้ไขไม่ได้">
        {signals.length ? (
          <ul className="grid gap-3 sm:grid-cols-2">
            {signals.map((s) => (
              <li key={s.public_id}>
                <Link href={`/matches/${s.fixture_slug}`} className="block rounded-xl border border-slate-200 p-3 hover:border-[var(--color-compass)]/40 hover:bg-[var(--color-compass-soft)]/40">
                  <p className="text-xs text-slate-500">
                    {s.league_name} · {dayTH(s.kickoff_at)} {timeTH(s.kickoff_at)}
                  </p>
                  <p className="mt-0.5 text-sm font-medium">
                    {s.home_team} vs {s.away_team}
                  </p>
                  <p className="mt-2 text-lg font-bold text-[var(--color-compass)]">🧭 {selectionLabel(s.market!, s.selection!, s.line == null ? null : Number(s.line), s.home_team, s.away_team)}</p>
                  <p className="text-xs text-slate-500">
                    {s.signal_strength} · โมเดล {pct(s.model_probability)} vs ตลาด {pct(s.market_probability)} · ราคา {odds(s.odds_at_publish)}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>ยังไม่มีสัญญาณที่ผ่านเกณฑ์ในขณะนี้ — บทวิเคราะห์จะเผยแพร่ภายใน 24 ชม. ก่อนเตะ</Empty>
        )}
      </Section>

      <div>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-base font-semibold">🔎 {day === today ? 'แมตช์วันนี้' : `แมตช์ถัดไป · ${dayTH(`${day}T12:00:00+07:00`)}`}</h2>
          <Link href={`/matches?date=${day}`} className="text-sm text-[var(--color-pitch)] hover:underline">
            ดูตามวัน →
          </Link>
        </div>
        {matches.length ? <MatchList matches={matches} /> : <Empty>ไม่มีแมตช์ในลีกที่ติดตาม</Empty>}
      </div>
    </main>
  );
}
