import { Empty, Section } from '@/components/ui';
import { authClient } from '@/lib/auth';
import { dayTH } from '@/lib/time';

/** First review of the daily featured list and the pick rules (ADR 0006). */
const REVIEW_DATE = '2026-11-06';
const NEED_SETTLED = 300;
const NEED_HIT = 0.55;
const NEED_CALIBRATION = 0.05;
const NEED_LOWER_BOUND = 0.5;
const Z90 = 1.2816;

interface Side {
  picks: number;
  settled: number;
  fair_hit: number | null;
  clv_n: number;
  clv_mean: number | null;
  beat_close: number | null;
  avg_fair_probability: number | null;
}
interface Review {
  sides: Record<string, Side>;
  by_edge: Array<{ bucket: string; settled: number; fair_hit: number; clv_mean: number | null }>;
  by_side: Array<{ market: string; selection: string; settled: number; fair_hit: number; avg_edge: number | null }>;
  by_rules: Array<{ rules: string; picks: number; settled: number; fair_hit: number | null }>;
  days: Array<{ version: string; day: string; picks: number; won: number; lost: number; push: number; pending: number }>;
}

const p1 = (x: number | null | undefined) => (x == null ? '-' : `${(Number(x) * 100).toFixed(1)}%`);
const f3 = (x: number | null | undefined) => (x == null ? '-' : `${Number(x) >= 0 ? '+' : ''}${Number(x).toFixed(3)}`);
const num = (x: unknown) => (x == null ? null : Number(x));

type Verdict = 'ผ่าน' | 'ไม่ผ่าน' | 'ยังไม่พอข้อมูล';
const tone: Record<Verdict, string> = { ผ่าน: 'text-emerald-700', ไม่ผ่าน: 'text-rose-600', ยังไม่พอข้อมูล: 'text-slate-500' };

function criteria(s: Side | undefined, all: Side | undefined) {
  const n = s?.settled ?? 0;
  const hit = num(s?.fair_hit);
  const enough = n >= NEED_SETTLED;
  const judge = (ok: boolean | null): Verdict => (ok === null || !enough ? 'ยังไม่พอข้อมูล' : ok ? 'ผ่าน' : 'ไม่ผ่าน');
  const lower = hit == null || n === 0 ? null : hit - Z90 * Math.sqrt((hit * (1 - hit)) / n);
  const fairP = num(s?.avg_fair_probability);
  const clv = num(s?.clv_mean);
  const allClv = num(all?.clv_mean);
  const allHit = num(all?.fair_hit);
  return [
    { label: `ตัดสินผลแล้วอย่างน้อย ${NEED_SETTLED} พิก`, value: `${n} / ${NEED_SETTLED}`, verdict: (enough ? 'ผ่าน' : 'ยังไม่พอข้อมูล') as Verdict },
    { label: `fair hit rate ≥ ${NEED_HIT * 100}%`, value: p1(hit), verdict: judge(hit == null ? null : hit >= NEED_HIT) },
    {
      label: `โอกาสชนะเฉลี่ยของโมเดลห่างจากผลจริงไม่เกิน ${NEED_CALIBRATION * 100} จุด`,
      value: fairP == null || hit == null ? '-' : `${p1(fairP)} เทียบ ${p1(hit)}`,
      verdict: judge(fairP == null || hit == null ? null : Math.abs(fairP - hit) <= NEED_CALIBRATION),
    },
    { label: `ขอบล่าง 90% ของ hit rate ≥ ${NEED_LOWER_BOUND * 100}%`, value: p1(lower), verdict: judge(lower == null ? null : lower >= NEED_LOWER_BOUND) },
    { label: 'CLV เฉลี่ยสูงกว่าพิก LINEUP ทั้งหมดในช่วงเดียวกัน', value: `${f3(clv)} เทียบ ${f3(allClv)}`, verdict: judge(clv == null || allClv == null ? null : clv > allClv) },
    { label: 'fair hit rate สูงกว่าพิก LINEUP ทั้งหมดในช่วงเดียวกัน', value: `${p1(hit)} เทียบ ${p1(allHit)}`, verdict: judge(hit == null || allHit == null ? null : hit > allHit) },
  ];
}

function Criteria({ version, review }: { version: 'featured-v1' | 'featured-v2'; review: Review }) {
  const s = review.sides[version];
  const rows = criteria(s, review.sides[`all:${version}`]);
  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold">{version}</h3>
      <table className="w-full text-sm">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-t border-slate-100">
              <td className="py-1.5 text-left">{r.label}</td>
              <td className="py-1.5 text-right tabular-nums text-slate-600">{r.value}</td>
              <td className={`py-1.5 pl-3 text-right font-medium ${tone[r.verdict]}`}>{r.verdict}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {s ? <p className="mt-1 text-xs text-slate-500">พิกที่ยืนยันแล้ว {s.picks} ตัดสินผลแล้ว {s.settled}</p> : <p className="mt-1 text-xs text-slate-500">ยังไม่มีพิกที่ยืนยัน</p>}
    </div>
  );
}

function daysLeft() {
  const ms = new Date(`${REVIEW_DATE}T00:00:00+07:00`).getTime() - Date.now();
  return Math.ceil(ms / 86_400_000);
}

/** Admin only: what the 2026-11-06 review needs, computed on every open (ADR 0006). */
export default async function AdminReview() {
  const sb = await authClient();
  const { data, error } = await sb.rpc('fp_admin_review');
  const review = data as Review | null;
  const left = daysLeft();
  const v2 = review?.sides['featured-v2'];
  const reviewDay = dayTH(`${REVIEW_DATE}T12:00:00+07:00`);

  return (
    <main className="space-y-5">
      {error ? <p className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">โหลดข้อมูลไม่สำเร็จ: {error.message}</p> : null}
      <Section title="ทบทวนเข็มทิศเกมประจำวัน" aside={left > 0 ? `อีก ${left} วันถึงวันทบทวน ${reviewDay}` : `ถึงวันทบทวนแล้ว (${reviewDay})`}>
        <p className="mb-3 text-sm text-slate-600">
          เกณฑ์จาก ADR 0004 และ 0006 ตอนนี้ v2 ตัดสินผลแล้ว {v2?.settled ?? 0} จาก {NEED_SETTLED} พิก ถ้ายังไม่ถึง {NEED_SETTLED} ให้เลื่อนการตัดสินใจ ไม่ลดเกณฑ์ ตัวเลขที่ตัวอย่างยังน้อยไม่ใช่ข้อสรุป
        </p>
        {review ? (
          <div className="grid gap-6 lg:grid-cols-2">
            <Criteria version="featured-v2" review={review} />
            <Criteria version="featured-v1" review={review} />
          </div>
        ) : (
          <Empty>ยังไม่มีข้อมูล</Empty>
        )}
      </Section>

      {review ? (
        <>
          <Section title="แต่ละวัน (พิกที่ยืนยันแล้ว)" aside="v1 และ v2">
            {review.days.length ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-slate-500">
                    <th className="pb-2 text-left font-normal">วัน</th>
                    <th className="pb-2 text-left font-normal">เวอร์ชัน</th>
                    <th className="pb-2 font-normal">พิก</th>
                    <th className="pb-2 font-normal">ชนะ</th>
                    <th className="pb-2 font-normal">แพ้</th>
                    <th className="pb-2 font-normal">เจ๊า/ยกเลิก</th>
                    <th className="pb-2 font-normal">รอผล</th>
                  </tr>
                </thead>
                <tbody className="text-center tabular-nums">
                  {review.days.map((d) => (
                    <tr key={`${d.day}-${d.version}`} className="border-t border-slate-100">
                      <td className="py-1.5 text-left">{d.day}</td>
                      <td className="text-left">{d.version}</td>
                      <td>{d.picks}</td>
                      <td>{d.won}</td>
                      <td>{d.lost}</td>
                      <td>{d.push}</td>
                      <td>{d.pending}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty>ยังไม่มีพิกที่ยืนยัน (ล็อกที่รอบ LINEUP)</Empty>
            )}
          </Section>

          <Section title="พิกที่ตัดสินผลแล้ว: ตามส่วนต่างจากตลาด" aside="จุดที่ทำให้ลดเพดาน edge เป็น 0.12">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-500">
                  <th className="pb-2 text-left font-normal">โมเดลสูงกว่าตลาด (จุด)</th>
                  <th className="pb-2 font-normal">ตัดสินแล้ว</th>
                  <th className="pb-2 font-normal">fair hit rate</th>
                  <th className="pb-2 font-normal">CLV เฉลี่ย</th>
                </tr>
              </thead>
              <tbody className="text-center tabular-nums">
                {review.by_edge.map((e) => (
                  <tr key={e.bucket} className="border-t border-slate-100">
                    <td className="py-1.5 text-left">{e.bucket.slice(3)}</td>
                    <td>{e.settled}</td>
                    <td>{p1(e.fair_hit)}</td>
                    <td>{f3(e.clv_mean)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-slate-500">กลุ่มละไม่ถึง 30 พิก อ่านเป็นทิศทางเท่านั้น</p>
          </Section>

          <div className="grid gap-5 lg:grid-cols-2">
            <Section title="ตามตลาดและฝั่ง">
              <table className="w-full text-sm">
                <tbody className="tabular-nums">
                  {review.by_side.map((r) => (
                    <tr key={`${r.market}-${r.selection}`} className="border-t border-slate-100">
                      <td className="py-1.5 text-left">
                        {r.market} · {r.selection}
                      </td>
                      <td className="text-right">{r.settled}</td>
                      <td className="text-right">{p1(r.fair_hit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
            <Section title="ตามเวอร์ชันกติกาเลือกพิก" aside="rules-v0.5 เริ่มใช้ 2026-10-17">
              <table className="w-full text-sm">
                <tbody className="tabular-nums">
                  {review.by_rules.map((r) => (
                    <tr key={r.rules} className="border-t border-slate-100">
                      <td className="py-1.5 text-left">{r.rules}</td>
                      <td className="text-right">{r.picks} พิก</td>
                      <td className="text-right">{r.settled} ตัดสินแล้ว</td>
                      <td className="text-right">{p1(r.fair_hit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          </div>
        </>
      ) : null}
    </main>
  );
}
