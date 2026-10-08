import type { Metadata } from 'next';
import Link from 'next/link';
import { Empty, Section, StatusBadge } from '@/components/ui';
import { MARKET, ROUND, odds, pct, selectionLabel, type Status } from '@/lib/labels';
import { performance, type PerfBucket } from '@/lib/queries';
import { dateTimeTH, shortDayTH } from '@/lib/time';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: '📊 ผลงานการวิเคราะห์ (Track Record)',
  description: 'ผลงาน 🧭 เข็มทิศเกม ทุกรายการ ทั้งถูกและผิด — บันทึกก่อนเตะ แก้ไขไม่ได้ และตรวจสอบด้วย hash chain',
};

const MONTH = new Intl.DateTimeFormat('th-TH', { month: 'long', year: 'numeric', timeZone: 'Asia/Bangkok' });

export default async function PerformancePage() {
  const { buckets, recent, leagueNames } = await performance();
  const all = buckets.find((b) => b.dimension === 'all');
  const by = (dim: string) => buckets.filter((b) => b.dimension === dim).sort((a, b) => b.total_signals - a.total_signals);
  const signals = recent.filter((r) => r.kind === 'SIGNAL');
  const streak = streaks(signals);

  return (
    <main className="mx-auto max-w-5xl space-y-4 px-4 py-5 sm:space-y-5 sm:py-8">
      <div>
        <h1 className="text-2xl font-bold sm:text-3xl">ผลงานการวิเคราะห์</h1>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-600">
          เราไม่ได้บอกว่าถูกทุกคู่ แต่เปิดให้เห็นว่าก่อนแข่งเราวิเคราะห์อะไร เลือกอะไร และผลออกมาอย่างไร — แสดง<b>ทุกรายการ</b> ไม่ลบผลแพ้ ไม่แก้หลังรู้ผล
        </p>
      </div>

      {all && all.total_signals + all.no_signal > 0 ? (
        <>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi k="สัญญาณ 🧭 ทั้งหมด" v={String(all.total_signals)} sub={`🌫️ หมอกข้อมูล ${all.no_signal} รายการ`} />
            <Kpi k="Win rate" v={pct(all.win_rate, 1)} sub="HALF นับครึ่ง · ไม่นับ PUSH/VOID" />
            <Kpi k="ชนะราคาปิดตลาด" v={pct(all.beat_closing_rate, 0)} sub={`CLV เฉลี่ย ${all.avg_clv == null ? '–' : `${(all.avg_clv * 100).toFixed(1)}%`}`} />
            <Kpi k="Streak ปัจจุบัน" v={streak.current} sub={`ดีที่สุด ${streak.best} ติด`} />
          </section>
          <Section title="สรุปผลทั้งหมด">
            <ResultBar b={all} />
          </Section>
        </>
      ) : (
        <Section title="สรุปผล">
          <Empty>ยังไม่มีบทวิเคราะห์ที่ตัดสินผล — track record เริ่มนับตั้งแต่บทวิเคราะห์แรกที่เผยแพร่</Empty>
        </Section>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Breakdown title="แยกตามตลาด" rows={by('market')} name={(b) => MARKET[b.bucket] ?? b.bucket} />
        <Breakdown title="แยกตามลีก" rows={by('league')} name={(b) => leagueNames.get(b.bucket) ?? `League ${b.bucket}`} />
        <Breakdown title="รายเดือน" rows={by('month').sort((a, b) => b.bucket.localeCompare(a.bucket))} name={(b) => MONTH.format(new Date(`${b.bucket}-15T00:00:00Z`))} />
        <Breakdown title="แยกตามรอบเผยแพร่" rows={by('round')} name={(b) => ROUND[b.bucket] ?? b.bucket} />
      </div>

      <Section title="ประวัติทุกรายการ" aside={`ล่าสุด ${recent.length} รายการ`}>
        {recent.length ? (
          <div className="-mx-4 overflow-x-auto sm:mx-0">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="px-4 pb-2 font-normal sm:px-0">แมตช์</th>
                  <th className="pb-2 font-normal">🧭</th>
                  <th className="pb-2 text-right font-normal">ราคา</th>
                  <th className="pb-2 text-right font-normal">ผล</th>
                  <th className="pb-2 pr-4 text-right font-normal sm:pr-0">สถานะ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {recent.map((r) => (
                  <tr key={r.public_id} className="align-top">
                    <td className="px-4 py-2 sm:px-0">
                      <Link href={`/matches/${r.fixture_slug}`} className="hover:underline">
                        {r.home_team} vs {r.away_team}
                      </Link>
                      <p className="text-xs text-slate-500">
                        {shortDayTH(r.kickoff_at)} · {r.league_name} · {r.public_id} · เผยแพร่ {dateTimeTH(r.published_at)}
                      </p>
                    </td>
                    <td className="py-2">
                      {r.kind === 'SIGNAL' ? (
                        <>
                          {selectionLabel(r.market!, r.selection!, r.line == null ? null : Number(r.line), r.home_team, r.away_team)}
                          <p className="text-xs text-slate-500">
                            {r.signal_strength} · {r.publish_round === 'LINEUP' ? 'หลังตัวจริง' : 'รอบแรก'}
                          </p>
                        </>
                      ) : (
                        <span className="text-slate-400">🌫️</span>
                      )}
                    </td>
                    <td className="py-2 text-right tabular-nums">{r.kind === 'SIGNAL' ? odds(r.odds_at_publish) : ''}</td>
                    <td className="py-2 text-right tabular-nums">{r.result_score ?? ''}</td>
                    <td className="py-2 pr-4 text-right sm:pr-0">
                      <StatusBadge status={r.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>ยังไม่มีบทวิเคราะห์ที่เผยแพร่</Empty>
        )}
      </Section>

      <Section title="ตรวจสอบได้อย่างไร">
        <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-slate-600">
          <li>ทุกบทวิเคราะห์ถูกบันทึก <b>ก่อนเตะ</b> ด้วยเวลาของฐานข้อมูล และฐานข้อมูลปฏิเสธการแก้ไขหรือลบทุกกรณี</li>
          <li>แต่ละรายการมี hash ที่ต่อกันเป็นสาย (hash chain) — ถ้าแก้รายการใดย้อนหลัง hash ของทุกรายการถัดไปจะไม่ตรง</li>
          <li>ผลตัดสินด้วยสกอร์ 90 นาทีอัตโนมัติ และตัดสินได้ครั้งเดียว · HALF WIN / HALF LOSS แสดงแยก ไม่รวมกับ WIN / LOSS</li>
          <li>🌫️ หมอกข้อมูล ก็ถูกบันทึก เพื่อให้เห็นว่าเราเลือกไม่ออกความเห็นบ่อยแค่ไหน</li>
        </ul>
      </Section>
    </main>
  );
}

function Kpi({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3 sm:p-4">
      <p className="text-xs text-slate-500">{k}</p>
      <p className="mt-1 text-xl font-bold tabular-nums sm:text-2xl">{v}</p>
      {sub ? <p className="mt-0.5 text-xs text-slate-500">{sub}</p> : null}
    </div>
  );
}

const PARTS: Array<{ key: keyof PerfBucket; status: Status; color: string }> = [
  { key: 'win', status: 'WIN', color: 'bg-emerald-600' },
  { key: 'half_win', status: 'HALF_WIN', color: 'bg-emerald-300' },
  { key: 'push', status: 'PUSH', color: 'bg-slate-300' },
  { key: 'void', status: 'VOID', color: 'bg-slate-200' },
  { key: 'half_loss', status: 'HALF_LOSS', color: 'bg-orange-300' },
  { key: 'loss', status: 'LOSS', color: 'bg-rose-500' },
  { key: 'pending', status: 'PENDING', color: 'bg-slate-100' },
];

function ResultBar({ b }: { b: PerfBucket }) {
  const total = PARTS.reduce((s, p) => s + Number(b[p.key] ?? 0), 0);
  return (
    <div>
      <div className="flex h-3 overflow-hidden rounded-full bg-slate-100">
        {total
          ? PARTS.map((p) => {
              const n = Number(b[p.key] ?? 0);
              return n ? <div key={p.key} className={p.color} style={{ width: `${(n / total) * 100}%` }} title={`${p.status} ${n}`} /> : null;
            })
          : null}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {PARTS.map((p) => (
          <span key={p.key} className="inline-flex items-center gap-1.5 text-sm">
            <StatusBadge status={p.status} />
            <b className="tabular-nums">{Number(b[p.key] ?? 0)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

function Breakdown({ title, rows, name }: { title: string; rows: PerfBucket[]; name: (b: PerfBucket) => string }) {
  return (
    <Section title={title}>
      {rows.length ? (
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <table className="w-full min-w-[24rem] text-sm">
          <thead>
            <tr className="text-xs text-slate-500">
              <th className="pb-2 text-left font-normal" />
              <th className="pb-2 font-normal">🧭</th>
              <th className="pb-2 font-normal">W / ½W</th>
              <th className="pb-2 font-normal">L / ½L</th>
              <th className="pb-2 font-normal">P / V</th>
              <th className="pb-2 text-right font-normal">Win rate</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-center tabular-nums">
            {rows.map((b) => (
              <tr key={b.bucket}>
                <td className="py-1.5 text-left">{name(b)}</td>
                <td>{b.total_signals}</td>
                <td>
                  {b.win} / {b.half_win}
                </td>
                <td>
                  {b.loss} / {b.half_loss}
                </td>
                <td>
                  {b.push} / {b.void}
                </td>
                <td className="text-right font-semibold">{pct(b.win_rate, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      ) : (
        <Empty>ยังไม่มีข้อมูล</Empty>
      )}
    </Section>
  );
}

/** Settled 🧭 in kickoff order: WIN/HALF_WIN extend a win streak, LOSS/HALF_LOSS a losing one; PUSH/VOID/pending skip. */
function streaks(rows: Array<{ kickoff_at: string; status: Status; publish_round: string; fixture_slug: string }>) {
  const settled = rows
    .filter((r) => ['WIN', 'HALF_WIN', 'LOSS', 'HALF_LOSS'].includes(r.status))
    .sort((a, b) => a.kickoff_at.localeCompare(b.kickoff_at));
  let best = 0;
  let run = 0;
  for (const r of settled) {
    run = r.status === 'WIN' || r.status === 'HALF_WIN' ? Math.max(run, 0) + 1 : Math.min(run, 0) - 1;
    best = Math.max(best, run);
  }
  return { current: run > 0 ? `ชนะ ${run}` : run < 0 ? `แพ้ ${-run}` : '–', best };
}
