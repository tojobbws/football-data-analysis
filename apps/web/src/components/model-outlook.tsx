import type { ModelOutlook } from '@/lib/queries';
import { pct } from '@/lib/labels';
import { dateTimeTH } from '@/lib/time';
import { Section } from './primitives';

/**
 * 📊 มุมมองโมเดล — model probabilities as information. Deliberately NOT styled like 🧭:
 * no pick, no compass colour; never counted in 🧭 stats (measured on its own on /performance).
 */
export function ModelOutlookCard({ o, home, away, result }: { o: ModelOutlook; home: string; away: string; result?: 'HOME' | 'DRAW' | 'AWAY' | null }) {
  const sides = [
    { key: 'HOME' as const, label: home, p: o.p_home },
    { key: 'DRAW' as const, label: 'เสมอ', p: o.p_draw },
    { key: 'AWAY' as const, label: away, p: o.p_away },
  ];
  return (
    <Section title="📊 มุมมองโมเดล" aside={`ค่าล่าสุดก่อนเตะ · ${dateTimeTH(o.computed_at)}`}>
      {!o.sides_tested ? (
        <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200">
          ⚠️ <b>ยังไม่ผ่านการทดสอบ</b> — โมเดลยังไม่ได้พิสูจน์ว่าทายลีกนี้แม่นกว่าค่าเฉลี่ยของลีก ใช้ตัวเลขนี้อย่างระวัง
        </p>
      ) : null}
      <ul className="space-y-2">
        {sides.map((s) => (
          <li key={s.key}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">
                {s.label}
                {result === s.key ? <span className="ml-1.5 text-xs font-semibold text-[var(--color-pitch)]">✓ ผลจริง</span> : null}
              </span>
              <span className="font-semibold tabular-nums">{pct(s.p)}</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100" aria-hidden>
              <div className="h-full rounded-full bg-[var(--color-pitch)]" style={{ width: `${Math.round(Number(s.p ?? 0) * 100)}%` }} />
            </div>
          </li>
        ))}
      </ul>
      {o.p_over25 != null ? (
        <p className="mt-3 text-sm text-slate-700">
          สูงกว่า 2.5 ประตู <b className="tabular-nums">{pct(o.p_over25)}</b> · ต่ำกว่า <b className="tabular-nums">{pct(1 - Number(o.p_over25))}</b>
          {!o.totals_tested ? <span className="ml-1 text-xs text-amber-800">(⚠️ ยังไม่ผ่านการทดสอบ)</span> : null}
        </p>
      ) : null}
      <p className="mt-3 text-xs leading-relaxed text-slate-500">
        โอกาสที่โมเดลสถิติคำนวณจากผลงานย้อนหลัง — เป็นข้อมูลประกอบ <b>ไม่ใช่ 🧭 เข็มทิศเกม</b> และไม่นับเป็นการชี้ ความแม่นของส่วนนี้วัดแยกไว้ที่หน้าผลงาน
      </p>
    </Section>
  );
}
