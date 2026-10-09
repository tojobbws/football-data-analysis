import type { DataSupport, MatchPreview } from '@/lib/queries';
import { pct } from '@/lib/labels';
import { dateTimeTH } from '@/lib/time';
import { Badge, Card, Note } from './sheet';

export const DATA_SUPPORT: Record<DataSupport, { label: string; variant: 'good' | 'warn' | 'bad' }> = {
  GOOD: { label: 'ข้อมูลครบ', variant: 'good' },
  LIMITED: { label: 'ข้อมูลจำกัด', variant: 'warn' },
  THIN: { label: 'ข้อมูลน้อย', variant: 'bad' },
};

/** Older previews carried an "untested model" note; fan pages no longer show it (the record is untouched). */
const UNTESTED_NOTE = 'ยังไม่ผ่านการทดสอบ';

const STAGE: Record<MatchPreview['stage'], string> = { EARLY: 'ก่อนประกาศตัวจริง', LINEUP: 'หลังประกาศตัวจริง' };

/**
 * วิเคราะห์เกม — the written preview. Reading material, not a pick: no compass colour, never in pick stats.
 * Numbers (probabilities, predicted score) are the model's; the prose is AI or template text, stored before kickoff.
 */
export function MatchPreviewCard({ p, home, away, result, modelTested, id }: { p: MatchPreview; home: string; away: string; result?: { home: number; away: number } | null; modelTested: boolean; id?: string }) {
  const notes = p.data_notes.filter((n) => !n.includes(UNTESTED_NOTE));
  // a LIMITED level whose only reason was the untested note reads as GOOD, like a preview written today
  const support = DATA_SUPPORT[p.data_support === 'LIMITED' && notes.length === 0 && p.data_notes.length > 0 ? 'GOOD' : p.data_support];
  const hasScore = p.predicted_home != null && p.predicted_away != null;
  const hit = result && hasScore ? (result.home === p.predicted_home && result.away === p.predicted_away ? 'ตรงสกอร์' : sameOutcome(result, p) ? 'ตรงผล' : 'ไม่ตรง') : null;

  return (
    <Card id={id} title="วิเคราะห์เกม" description={`${STAGE[p.stage]} · ${dateTimeTH(p.created_at)}`} action={<Badge variant={support.variant}>{support.label}</Badge>}>
      {notes.length ? <p className="mb-3 text-xs leading-relaxed text-zinc-500">{notes.join(' · ')}</p> : null}

      <p className="max-w-prose text-[15px] leading-7 text-zinc-800">{p.overview_th}</p>

      <div className="mt-5 grid gap-x-8 gap-y-5 border-t border-zinc-100 pt-4 sm:grid-cols-2">
        {[
          { name: home, text: p.home_th, side: 'เจ้าบ้าน' },
          { name: away, text: p.away_th, side: 'ทีมเยือน' },
        ].map((t) => (
          <div key={t.side}>
            <p className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-zinc-950">{t.name}</span>
              <Badge variant="secondary">{t.side}</Badge>
            </p>
            <p className="mt-1.5 text-sm leading-relaxed text-zinc-700">{t.text}</p>
          </div>
        ))}
      </div>

      <div className="mt-5 grid gap-x-8 gap-y-2 border-t border-zinc-100 pt-4 sm:grid-cols-[11rem_minmax(0,1fr)]">
        <div>
          <p className="text-xs text-zinc-500">สกอร์คาดการณ์จากโมเดล</p>
          {hasScore ? (
            <>
              <p className="mt-1 text-3xl font-semibold tabular-nums tracking-tight text-zinc-950">
                {p.predicted_home}–{p.predicted_away}
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                โอกาส {pct(p.predicted_p)}
                {p.expected_home != null ? ` · xG ${Number(p.expected_home).toFixed(2)}–${Number(p.expected_away).toFixed(2)}` : ''}
              </p>
              {modelTested ? null : <p className="mt-1 text-xs text-zinc-400">อยู่ระหว่างการวัดผล</p>}
              {hit ? (
                <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-600">
                  ผลจริง <b className="tabular-nums text-zinc-950">{result!.home}–{result!.away}</b>
                  <Badge variant={hit === 'ไม่ตรง' ? 'outline' : 'good'}>{hit}</Badge>
                </p>
              ) : null}
            </>
          ) : (
            <p className="mt-1 text-sm text-zinc-600">ยังไม่มี — โมเดลมีข้อมูลไม่พอ</p>
          )}
        </div>
        <p className="max-w-prose text-sm leading-relaxed text-zinc-700 sm:pt-5">{p.score_th}</p>
      </div>

      <Note>
        {p.text_source === 'AI' ? 'เรียบเรียงโดย AI จากข้อมูลในระบบเท่านั้น ตัวเลขทุกตัวมาจากโมเดลและฐานข้อมูล' : 'สร้างจากตัวเลขในระบบโดยอัตโนมัติ'} · บันทึกก่อนเตะ แก้ไขไม่ได้ · เป็นข้อมูลประกอบ ไม่ใช่เข็มทิศเกม และไม่นับในผลงาน
      </Note>
    </Card>
  );
}

function sameOutcome(r: { home: number; away: number }, p: MatchPreview): boolean {
  const sign = (a: number, b: number) => Math.sign(a - b);
  return sign(r.home, r.away) === sign(p.predicted_home!, p.predicted_away!);
}
