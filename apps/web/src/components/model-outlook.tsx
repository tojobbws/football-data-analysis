import type { ModelOutlook } from '@/lib/queries';
import { pct } from '@/lib/labels';
import { dateTimeTH } from '@/lib/time';
import { Badge, Card, Note } from './sheet';

/**
 * มุมมองโมเดล — model probabilities as information. Deliberately NOT styled like the pick:
 * no compass colour; never counted in pick stats (measured on its own on /performance).
 * One 100% bar split three ways, with the values in a legend underneath.
 * Rendered only when the league's 1X2 model passed `model:tune` (the page gates on `sides_tested`);
 * an untested over/under line still shows, with a quiet note instead of a warning badge.
 */
export function ModelOutlookCard({ o, home, away, result, id }: { o: ModelOutlook; home: string; away: string; result?: 'HOME' | 'DRAW' | 'AWAY' | null; id?: string }) {
  const sides = [
    { key: 'HOME' as const, label: home, p: Number(o.p_home ?? 0) },
    { key: 'DRAW' as const, label: 'เสมอ', p: Number(o.p_draw ?? 0) },
    { key: 'AWAY' as const, label: away, p: Number(o.p_away ?? 0) },
  ].map((s, _, all) => {
    // teal marks whichever outcome the model leans to; the rest stay neutral
    const lead = s.p === Math.max(...all.map((x) => x.p));
    return { ...s, fill: lead ? 'bg-[var(--color-pitch)]' : s.key === 'DRAW' ? 'bg-zinc-200' : 'bg-zinc-400' };
  });
  const top = Math.max(...sides.map((s) => s.p));
  const over = o.p_over25 == null ? null : Number(o.p_over25);

  return (
    <Card
      id={id}
      title="มุมมองโมเดล"
      description={`โอกาสแพ้ชนะจากโมเดลสถิติ · ค่าล่าสุด ${dateTimeTH(o.computed_at)}`}
      action={<Badge variant="good">ผ่านการทดสอบ</Badge>}
    >
      <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full" aria-hidden>
        {sides.map((s) => (
          <div key={s.key} className={s.fill} style={{ width: `${s.p * 100}%` }} />
        ))}
      </div>

      <dl className="mt-3 divide-y divide-zinc-100">
        {sides.map((s) => (
          <div key={s.key} className="flex items-center justify-between gap-3 py-2 text-sm">
            <dt className="flex min-w-0 items-center gap-2.5">
              <span className={`h-2.5 w-2.5 shrink-0 rounded-[3px] ${s.fill}`} aria-hidden />
              <span className={`truncate ${s.p === top ? 'font-semibold text-zinc-950' : 'text-zinc-700'}`}>{s.label}</span>
              {result === s.key ? <Badge variant="secondary">ผลจริง</Badge> : null}
            </dt>
            <dd className={`tabular-nums ${s.p === top ? 'font-semibold text-zinc-950' : 'text-zinc-600'}`}>{pct(s.p)}</dd>
          </div>
        ))}
      </dl>

      {over != null ? (
        <div className="mt-2 rounded-lg border border-zinc-200 px-3 py-2.5 text-sm">
          <span className="text-zinc-700">
            สูงกว่า 2.5 ประตู <b className="font-semibold tabular-nums text-zinc-950">{pct(over)}</b>
            <span className="px-2 text-zinc-300">/</span>
            ต่ำกว่า <b className="font-semibold tabular-nums text-zinc-950">{pct(1 - over)}</b>
          </span>
        </div>
      ) : null}

      <Note>
        {over != null && !o.totals_tested ? 'ตัวเลขสูง/ต่ำยังอยู่ระหว่างการวัดผล · ' : ''}
        คำนวณจากผลงานย้อนหลัง เป็นข้อมูลประกอบ ไม่ใช่เข็มทิศเกม และไม่นับเป็นการชี้ ความแม่นของส่วนนี้วัดแยกไว้ที่หน้าผลงาน
      </Note>
    </Card>
  );
}
