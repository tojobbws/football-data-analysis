import type { Metadata } from 'next';
import Link from 'next/link';
import { Empty, Section, StatusBadge } from '@/components/ui';
import { MARKET, ROUND, ROUND_SHORT, odds, pct, selectionLabel, type Status } from '@/lib/labels';
import { benchmark, modelOutlookPerformance, modelResults, performance, type BenchmarkMetric, type ModelOutlookScore, type PerfBucket } from '@/lib/queries';
import { dateTimeTH, shortDayTH } from '@/lib/time';
import type { ModelResultRow } from '@/lib/queries';
import type { BenchmarkVerdict, ClusteredMean } from '@fp/analysis';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: '📊 ผลงานการวิเคราะห์ (Track Record)',
  description: 'ผลงาน 🧭 เข็มทิศเกม ทุกรายการ ทั้งถูกและผิด — บันทึกก่อนเตะ แก้ไขไม่ได้ และตรวจสอบด้วย hash chain',
};

const MONTH = new Intl.DateTimeFormat('th-TH', { month: 'long', year: 'numeric', timeZone: 'Asia/Bangkok' });

export default async function PerformancePage() {
  const [{ buckets, recent, leagueNames }, outlook, modelRes, bench] = await Promise.all([performance(), modelOutlookPerformance(), modelResults(), benchmark(MAIN_MODEL)]);
  const all = buckets.find((b) => b.dimension === 'all');
  const by = (dim: string) => buckets.filter((b) => b.dimension === dim && b.total_signals > 0).sort((a, b) => b.total_signals - a.total_signals);
  const pick = bench.PICK.summary;
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
            <Kpi k="สัญญาณ 🧭 ทั้งหมด" v={String(all.total_signals)} sub={`นับแมตช์ละ 1 รายการ · 🌫️ หมอกข้อมูล ${all.no_signal} รายการ`} />
            <Kpi k="Win rate" v={pct(all.win_rate, 1)} sub={`HALF นับครึ่ง · ไม่นับ PUSH/VOID${pick.hit.lo == null ? '' : ` · ช่วง 95% ${pctRange(pick.hit)}`}`} />
            <Kpi
              k="ชนะราคาปิดตลาด"
              v={pct(all.beat_closing_rate, 0)}
              sub={`CLV เฉลี่ย ${all.avg_clv == null ? '–' : signedPct(all.avg_clv, 1)}${pick.clv.lo == null ? '' : ` (ช่วง 95% ${signedPct(pick.clv.lo, 1)} ถึง ${signedPct(pick.clv.hi!, 1)})`}`}
            />
            <Kpi k="Streak ปัจจุบัน" v={streak.current} sub={`ดีที่สุด ${streak.best} ติด`} />
          </section>
          {all.matches_with_repeat_signal > 0 ? (
            <p className="text-xs leading-relaxed text-slate-500">
              {all.matches_with_repeat_signal} แมตช์มีเข็มทิศเกมมากกว่าหนึ่งรอบ ตัวเลขด้านบนนับเฉพาะรอบล่าสุดของแมตช์นั้น ส่วนตาราง "แยกตามรอบเผยแพร่" นับตามรอบที่ถูกนับ
            </p>
          ) : null}
          <Section title="สรุปผลทั้งหมด">
            <ResultBar b={all} />
          </Section>
        </>
      ) : (
        <Section title="สรุปผล">
          <Empty>ยังไม่มีบทวิเคราะห์ที่ตัดสินผล — track record เริ่มนับตั้งแต่บทวิเคราะห์แรกที่เผยแพร่</Empty>
        </Section>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Breakdown title="แยกตามตลาด" rows={by('market')} name={(b) => MARKET[b.bucket] ?? b.bucket} />
        <Breakdown title="แยกตามลีก" rows={by('league')} name={(b) => leagueNames.get(b.bucket) ?? `League ${b.bucket}`} />
        <Breakdown title="รายเดือน" rows={by('month').sort((a, b) => b.bucket.localeCompare(a.bucket))} name={(b) => MONTH.format(new Date(`${b.bucket}-15T00:00:00Z`))} />
        <Breakdown title="แยกตามรอบเผยแพร่" rows={by('round')} name={(b) => ROUND[b.bucket] ?? b.bucket} />
      </div>

      <MarketBenchmarkSection data={bench} />

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
                    <td className="px-4 pb-3 sm:px-0">
                      <Link href={`/matches/${r.fixture_slug}`} className="inline-flex min-h-11 items-center hover:underline">
                        {r.home_team} vs {r.away_team}
                      </Link>
                      <p className="text-xs text-slate-500">
                        {shortDayTH(r.kickoff_at)} · {r.league_name} · {r.public_id} · เผยแพร่ {dateTimeTH(r.published_at)}
                      </p>
                    </td>
                    <td className="py-3">
                      {r.kind === 'SIGNAL' ? (
                        <>
                          {selectionLabel(r.market!, r.selection!, r.line == null ? null : Number(r.line), r.home_team, r.away_team)}
                          <p className="text-xs text-slate-500">
                            {ROUND_SHORT[r.publish_round] ?? r.publish_round}
                          </p>
                        </>
                      ) : (
                        <span className="text-slate-400">🌫️</span>
                      )}
                    </td>
                    <td className="py-3 text-right tabular-nums">{r.kind === 'SIGNAL' ? odds(r.odds_at_publish) : ''}</td>
                    <td className="py-3 text-right tabular-nums">{r.result_score ?? ''}</td>
                    <td className="py-3 pr-4 text-right sm:pr-0">
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

      <OutlookSection rows={outlook} />

      <ModelResultsSection data={modelRes} />

      <Section title="ตรวจสอบได้อย่างไร">
        <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-slate-600">
          <li>ทุกบทวิเคราะห์ถูกบันทึก <b>ก่อนเตะ</b> ด้วยเวลาของฐานข้อมูล และฐานข้อมูลปฏิเสธการแก้ไขหรือลบทุกกรณี</li>
          <li>แต่ละรายการมี hash ที่ต่อกันเป็นสาย (hash chain) — ถ้าแก้รายการใดย้อนหลัง hash ของทุกรายการถัดไปจะไม่ตรง</li>
          <li>ผลตัดสินด้วยสกอร์ 90 นาทีอัตโนมัติ และตัดสินได้ครั้งเดียว · HALF WIN / HALF LOSS แสดงแยก ไม่รวมกับ WIN / LOSS</li>
          <li>🌫️ หมอกข้อมูล ก็ถูกบันทึก เพื่อให้เห็นว่าเราเลือกไม่ออกความเห็นบ่อยแค่ไหน</li>
          <li>📊 มุมมองโมเดล ใช้ค่าสุดท้ายที่คำนวณ<b>ก่อนเตะ</b> (บันทึกแบบแก้ไม่ได้) และวัดผลแยกจาก 🧭 ไม่นับรวมกัน</li>
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

/** 📊 มุมมองโมเดล — scored on its own, never mixed into 🧭 stats. */
function OutlookSection({ rows }: { rows: ModelOutlookScore[] }) {
  const total = rows.reduce((n, r) => n + r.matches, 0);
  return (
    <Section title="📊 มุมมองโมเดล (วัดแยกจาก 🧭)" aside={total ? `${total} นัดที่จบแล้ว` : undefined}>
      <p className="mb-3 text-sm leading-relaxed text-slate-600">
        ตัวเลขโอกาสบนหน้าแมตช์ ไม่ใช่การชี้ แต่เราก็วัดผลให้ดู: <b>ทายผลถูก</b> = ผลที่โมเดลให้โอกาสสูงสุดเกิดจริงกี่ % เทียบกับ <b>ที่โมเดลคาด</b> (ค่าเฉลี่ยของโอกาสนั้น) — สองค่ายิ่งใกล้กัน แปลว่าตัวเลข % เชื่อถือได้
      </p>
      {total ? (
        <div className="-mx-4 overflow-x-auto sm:mx-0">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className="px-4 pb-2 font-normal sm:px-0">กลุ่มลีก</th>
                <th className="pb-2 text-right font-normal">นัด</th>
                <th className="pb-2 text-right font-normal">ผลแพ้ชนะ: ทายถูก / ที่คาด</th>
                <th className="pb-2 pr-4 text-right font-normal sm:pr-0">สูง/ต่ำ 2.5: ทายถูก / ที่คาด</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={String(r.tested)}>
                  <td className="px-4 py-2 sm:px-0">{r.tested ? 'ผ่านการทดสอบ' : '⚠️ ยังไม่ผ่านการทดสอบ'}</td>
                  <td className="py-2 text-right tabular-nums">{r.matches}</td>
                  <td className="py-2 text-right tabular-nums">
                    {pct(r.correct / Math.max(1, r.matches), 0)} / {pct(r.expected_rate, 0)}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums sm:pr-0">
                    {r.ou_matches ? `${pct(r.ou_correct / r.ou_matches, 0)} / ${pct(r.ou_expected_rate, 0)}` : '–'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>ยังไม่มีนัดที่จบพร้อมมุมมองโมเดลก่อนเตะ</Empty>
      )}
    </Section>
  );
}

const MODEL_NAME: Record<string, string> = {
  'dixon-coles-v0.2': 'โมเดลหลัก (Dixon-Coles)',
  'elo-v0.1': 'Elo',
  'ensemble-v0.1': 'โมเดลผสม (Dixon-Coles + Elo)',
};
const MAIN_MODEL = 'dixon-coles-v0.2';
/** What always guessing 1/3 each scores: the line a model has to beat to know anything. */
const BRIER_UNIFORM = 2 / 3;
const LOG_LOSS_UNIFORM = Math.log(3);
const MIN_LEAGUE_MATCHES = 30;
const f3 = (v: number | null) => (v == null ? '–' : Number(v).toFixed(3));

/** ผลโมเดล — every finished match the model priced before kickoff, not only the matches that got a เข็มทิศเกม. */
function ModelResultsSection({ data }: { data: Awaited<ReturnType<typeof modelResults>> }) {
  const overall = data.results.filter((r) => r.league_id === null && r.matches > 0).sort((a, b) => b.matches - a.matches);
  const leagues = data.results
    .filter((r) => r.league_id !== null && r.model_version_id === MAIN_MODEL && r.matches >= MIN_LEAGUE_MATCHES)
    .sort((a, b) => b.matches - a.matches)
    .slice(0, 15);
  const calib = data.calibration.filter((c) => c.model_version_id === MAIN_MODEL);
  const total = overall.find((r) => r.model_version_id === MAIN_MODEL)?.matches ?? 0;
  return (
    <Section title="ผลโมเดล (ทุกนัดที่จบแล้ว)" aside={total ? `${total} นัด` : undefined}>
      <p className="mb-3 text-sm leading-relaxed text-slate-600">
        วัดโอกาส แพ้ / เสมอ / ชนะ ที่โมเดลคำนวณ<b>ก่อนเตะ</b> กับผล 90 นาทีของ<b>ทุกนัด</b> ไม่ใช่เฉพาะนัดที่เรามีเข็มทิศเกม ใช้ค่าสุดท้ายก่อนเตะเท่านั้น และแยกจากผลของเข็มทิศเกมด้านบน
        ค่า <b>Brier</b> และ <b>log loss</b> ยิ่งต่ำยิ่งดี — ถ้าเดาเท่ากันทุกผล (33% / 33% / 33%) จะได้ Brier {f3(BRIER_UNIFORM)} และ log loss {f3(LOG_LOSS_UNIFORM)}
      </p>
      {total ? (
        <>
          <div className="-mx-4 overflow-x-auto sm:mx-0">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="px-4 pb-2 font-normal sm:px-0">โมเดล</th>
                  <th className="pb-2 text-right font-normal">นัด</th>
                  <th className="pb-2 text-right font-normal">ทายผลถูก / ที่คาด</th>
                  <th className="pb-2 text-right font-normal">Brier</th>
                  <th className="pb-2 pr-4 text-right font-normal sm:pr-0">Log loss</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {overall.map((r) => (
                  <ResultRow key={r.model_version_id} r={r} label={MODEL_NAME[r.model_version_id] ?? r.model_version_id} />
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">โมเดลผสมมีเฉพาะลีกที่ผ่านการทดสอบ จำนวนนัดของแต่ละโมเดลจึงไม่เท่ากัน อย่าเทียบตัวเลขข้ามแถวโดยตรง</p>

          {leagues.length ? (
            <>
              <h3 className="mb-2 mt-5 text-sm font-semibold">แยกตามลีก ({MODEL_NAME[MAIN_MODEL]} · ลีกที่มีอย่างน้อย {MIN_LEAGUE_MATCHES} นัด)</h3>
              <div className="-mx-4 overflow-x-auto sm:mx-0">
                <table className="w-full min-w-[560px] text-sm">
                  <tbody className="divide-y divide-slate-100">
                    {leagues.map((r) => (
                      <ResultRow key={r.league_id} r={r} label={data.leagueNames.get(Number(r.league_id)) ?? `ลีก ${r.league_id}`} />
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}

          {calib.length ? (
            <>
              <h3 className="mb-2 mt-5 text-sm font-semibold">โอกาสที่โมเดลให้ กับสิ่งที่เกิดขึ้นจริง ({MODEL_NAME[MAIN_MODEL]})</h3>
              <div className="-mx-4 overflow-x-auto sm:mx-0">
                <table className="w-full min-w-[420px] text-sm">
                  <thead>
                    <tr className="text-left text-xs text-slate-500">
                      <th className="px-4 pb-2 font-normal sm:px-0">โมเดลให้โอกาส</th>
                      <th className="pb-2 text-right font-normal">ผลลัพธ์</th>
                      <th className="pb-2 text-right font-normal">โมเดลคาดเฉลี่ย</th>
                      <th className="pb-2 pr-4 text-right font-normal sm:pr-0">เกิดขึ้นจริง</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {calib.map((c) => (
                      <tr key={c.bucket}>
                        <td className="px-4 py-2 sm:px-0">{c.bucket * 10}–{c.bucket * 10 + 10}%</td>
                        <td className="py-2 text-right tabular-nums">{c.outcomes}</td>
                        <td className="py-2 text-right tabular-nums">{pct(c.avg_probability, 0)}</td>
                        <td className="py-2 pr-4 text-right tabular-nums sm:pr-0">{pct(c.hit_rate, 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-slate-500">สองคอลัมน์ท้ายยิ่งใกล้กัน แปลว่าตัวเลข % ของโมเดลเชื่อถือได้ ช่วงที่มีผลลัพธ์น้อยอย่าเพิ่งสรุป</p>
            </>
          ) : null}
        </>
      ) : (
        <Empty>ยังไม่มีนัดที่จบพร้อมโอกาสของโมเดลก่อนเตะ</Empty>
      )}
    </Section>
  );
}

const signedPct = (x: number, digits = 1) => `${x > 0 ? '+' : ''}${(x * 100).toFixed(digits)}%`;
const pctRange = (m: ClusteredMean) => (m.lo == null || m.hi == null ? '–' : `${(m.lo * 100).toFixed(1)}–${(m.hi * 100).toFixed(1)}%`);
const signed3 = (x: number | null) => (x == null ? '–' : `${x > 0 ? '+' : ''}${x.toFixed(3)}`);

const BENCH_ROWS: Array<{ metric: BenchmarkMetric; label: string; note: string }> = [
  { metric: '1X2', label: 'ผลแพ้ชนะ', note: 'โอกาส เจ้าบ้านชนะ / เสมอ / ทีมเยือนชนะ' },
  { metric: 'AH_MAIN', label: 'แฮนดิแคปเส้นหลัก', note: 'เส้นหลักของตลาดตอนเริ่มเกม' },
  { metric: 'OU_MAIN', label: 'สูง/ต่ำเส้นหลัก', note: 'เส้นหลักของตลาดตอนเริ่มเกม' },
  { metric: 'PICK', label: 'เข็มทิศเกม', note: 'ฝั่งที่เลือก เทียบ ณ เวลาที่เผยแพร่' },
];

const VERDICT: Record<BenchmarkVerdict, { text: string; tone: string }> = {
  MARKET_BETTER: { text: 'ตลาดแม่นกว่า', tone: 'text-rose-600' },
  MODEL_BETTER: { text: 'โมเดลแม่นกว่า', tone: 'text-emerald-700' },
  NO_CLEAR_DIFFERENCE: { text: 'ยังแยกไม่ออก', tone: 'text-slate-600' },
  INSUFFICIENT_EVIDENCE: { text: 'ข้อมูลยังไม่พอสรุป', tone: 'text-slate-500' },
};

/**
 * Model against the market on the same matches and the same target (audit A-03). Brier is the primary score;
 * intervals are 95% and clustered by football day, so matches of one day are not treated as independent.
 */
function MarketBenchmarkSection({ data }: { data: Awaited<ReturnType<typeof benchmark>> }) {
  const any = BENCH_ROWS.some((r) => data[r.metric].summary.n > 0);
  const first = BENCH_ROWS.map((r) => data[r.metric].summary.from).filter((x): x is string => x !== null).sort()[0];
  const last = BENCH_ROWS.map((r) => data[r.metric].summary.to).filter((x): x is string => x !== null).sort().at(-1);
  return (
    <Section title="เทียบกับตลาด" aside={first && last ? `${shortDayTH(`${first}T12:00:00+07:00`)} – ${shortDayTH(`${last}T12:00:00+07:00`)}` : undefined}>
      <p className="mb-3 text-sm leading-relaxed text-slate-600">
        ตลาด คือภาพรวมที่ตลาดฟุตบอลให้โอกาสแต่ละผล เราให้คะแนนโมเดลกับตลาด<b>บนนัดเดียวกันและเป้าหมายเดียวกัน</b> ผลแพ้ชนะเทียบผลแพ้ชนะ ส่วนแฮนดิแคปและสูง/ต่ำเทียบบนเส้นเดียวกัน (ผลครึ่งนับครึ่ง เสมอตัวไม่นับ)
        ค่า <b>Brier</b> ยิ่งต่ำยิ่งแม่น · <b>ส่วนต่าง = โมเดล − ตลาด</b> ติดลบแปลว่าโมเดลแม่นกว่า บวกแปลว่าตลาดแม่นกว่า · ช่วงในวงเล็บคือช่วงความเชื่อมั่น 95% ที่นับนัดในวันฟุตบอลเดียวกันเป็นกลุ่มเดียว
      </p>
      {any ? (
        <>
          <div className="-mx-4 overflow-x-auto sm:mx-0">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="px-4 pb-2 font-normal sm:px-0">เทียบ</th>
                  <th className="pb-2 text-right font-normal">นัด · วัน</th>
                  <th className="pb-2 text-right font-normal">Brier โมเดล</th>
                  <th className="pb-2 text-right font-normal">Brier ตลาด</th>
                  <th className="pb-2 text-right font-normal">ส่วนต่าง (ช่วง 95%)</th>
                  <th className="pb-2 pr-4 text-right font-normal sm:pr-0">สรุป</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {BENCH_ROWS.map(({ metric, label, note }) => {
                  const { summary: s, finishedOnDays } = data[metric];
                  const d = s.brier.diff;
                  const v = VERDICT[s.verdict];
                  return (
                    <tr key={metric} className="align-top">
                      <td className="px-4 py-2 sm:px-0">
                        {label}
                        <p className="text-xs text-slate-500">{note}</p>
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {s.n} · {s.days}
                        {metric !== 'PICK' && finishedOnDays > 0 ? <p className="text-xs text-slate-500">{pct(s.n / finishedOnDays, 0)} ของนัดที่จบ</p> : null}
                      </td>
                      <td className="py-2 text-right tabular-nums">{f3(s.brier.model.mean)}</td>
                      <td className="py-2 text-right tabular-nums">{f3(s.brier.market.mean)}</td>
                      <td className="py-2 text-right tabular-nums">
                        {signed3(d.mean)}
                        {d.lo != null && d.hi != null ? <p className="text-xs text-slate-500">({signed3(d.lo)} ถึง {signed3(d.hi)})</p> : null}
                      </td>
                      <td className={`py-2 pr-4 text-right sm:pr-0 ${v.tone}`}>{v.text}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <h3 className="mb-2 mt-5 text-sm font-semibold">โอกาสที่ให้ กับสิ่งที่เกิดขึ้นจริง</h3>
          <div className="-mx-4 overflow-x-auto sm:mx-0">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="px-4 pb-2 font-normal sm:px-0">เทียบ</th>
                  <th className="pb-2 text-right font-normal">โมเดลให้โอกาสเฉลี่ย</th>
                  <th className="pb-2 text-right font-normal">ตลาดให้โอกาสเฉลี่ย</th>
                  <th className="pb-2 pr-4 text-right font-normal sm:pr-0">เกิดขึ้นจริง (ช่วง 95%)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {BENCH_ROWS.filter((r) => r.metric !== '1X2').map(({ metric, label }) => {
                  const s = data[metric].summary;
                  return (
                    <tr key={metric}>
                      <td className="px-4 py-2 sm:px-0">{label}</td>
                      <td className="py-2 text-right tabular-nums">{pct(s.pModel.mean, 1)}</td>
                      <td className="py-2 text-right tabular-nums">{pct(s.pMarket.mean, 1)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums sm:pr-0">
                        {pct(s.hit.mean, 1)} <span className="text-xs text-slate-500">({pctRange(s.hit)})</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            แฮนดิแคปวัดฝั่งเจ้าบ้าน สูง/ต่ำวัดฝั่งสูง และเข็มทิศเกมวัดฝั่งที่เลือก ถ้าโมเดลให้โอกาสเฉลี่ยสูงกว่าที่เกิดจริงมาก แปลว่าโมเดลมั่นใจเกินไป
            · ผลแพ้ชนะ แฮนดิแคป และสูง/ต่ำ ใช้ค่าสุดท้ายของโมเดลก่อนเตะเทียบกับตลาด ณ เวลาเตะ ตลาดจึงเห็นข่าวล่าสุดมากกว่าเล็กน้อย ส่วนเข็มทิศเกมเทียบกับตลาด ณ เวลาเดียวกับที่เผยแพร่
            · สรุปผลได้เมื่อมีอย่างน้อย 100 นัดใน 20 วันฟุตบอล
          </p>
        </>
      ) : (
        <Empty>ยังไม่มีนัดที่จบพร้อมทั้งโอกาสของโมเดลและของตลาด</Empty>
      )}
    </Section>
  );
}

function ResultRow({ r, label }: { r: ModelResultRow; label: string }) {
  return (
    <tr>
      <td className="px-4 py-2 sm:px-0">{label}</td>
      <td className="py-2 text-right tabular-nums">{r.matches}</td>
      <td className="py-2 text-right tabular-nums">
        {pct(r.correct / Math.max(1, r.matches), 0)} / {pct(r.avg_top_probability, 0)}
      </td>
      <td className="py-2 text-right tabular-nums">{f3(r.brier)}</td>
      <td className="py-2 pr-4 text-right tabular-nums sm:pr-0">{f3(r.log_loss)}</td>
    </tr>
  );
}
