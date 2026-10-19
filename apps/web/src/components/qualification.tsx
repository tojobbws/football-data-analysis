import { pct } from '@/lib/labels';
import type { QualificationView } from '@/lib/queries';
import { dateTimeTH } from '@/lib/time';
import { Card, Note } from './sheet';

/**
 * โอกาสผ่านเข้ารอบ — the chance each side goes through a two-legged cup tie. Not the 90-minute win chance of
 * this match and not a pick: the two legs together, then extra time, then penalties, under the competition's rules.
 * Shown only when the league's 1X2 model passed its test (the page gates on `sides_tested`).
 */
export function QualificationCard({ q, a, b, id }: { q: QualificationView; a: string; b: string; id?: string }) {
  const pA = Number(q.p_a);
  const pB = Number(q.p_b);
  const lead = pA >= pB ? 'A' : 'B';
  const played = q.leg === 2;
  return (
    <Card
      id={id}
      title="โอกาสผ่านเข้ารอบ"
      description={`${played ? `หลังนัดแรก ${a} ${q.agg_a}–${q.agg_b} ${b} · ` : ''}คำนวณจากผลรวมสองนัด · ค่าล่าสุด ${dateTimeTH(q.computed_at)}`}
    >
      <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full" aria-hidden>
        <div className={lead === 'A' ? 'bg-[var(--color-pitch)]' : 'bg-zinc-400'} style={{ width: `${pA * 100}%` }} />
        <div className={lead === 'B' ? 'bg-[var(--color-pitch)]' : 'bg-zinc-400'} style={{ width: `${pB * 100}%` }} />
      </div>
      <dl className="mt-3 divide-y divide-zinc-100">
        {[
          { name: a, p: pA, top: lead === 'A' },
          { name: b, p: pB, top: lead === 'B' },
        ].map((r) => (
          <div key={r.name} className="flex items-center justify-between gap-3 py-2 text-sm">
            <dt className={`truncate ${r.top ? 'font-semibold text-zinc-950' : 'text-zinc-700'}`}>{r.name} ผ่านเข้ารอบ</dt>
            <dd className={`tabular-nums ${r.top ? 'font-semibold text-zinc-950' : 'text-zinc-600'}`}>{pct(r.p)}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-xs leading-relaxed text-zinc-600">
        ถ้ารวมสองนัดเสมอกัน (โอกาสราว {pct(Number(q.p_extra_time))}) จะมีต่อเวลาพิเศษ และอาจถึงดวลจุดโทษ (ราว {pct(Number(q.p_penalties))})
      </p>
      <Note>
        {(q.assumptions ?? []).join(' · ')}
        {q.assumptions?.length ? ' · ' : ''}
        ไม่ใช่โอกาสชนะใน 90 นาทีของนัดนี้ เป็นข้อมูลประกอบ ไม่ใช่เข็มทิศเกม
      </Note>
    </Card>
  );
}
