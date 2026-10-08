import type { DataSupport, MatchPreview } from '@/lib/queries';
import { pct } from '@/lib/labels';
import { dateTimeTH } from '@/lib/time';
import { Section } from './primitives';

export const DATA_SUPPORT: Record<DataSupport, { label: string; dot: string; tone: string }> = {
  GOOD: { label: 'ข้อมูลครบ', dot: 'bg-emerald-500', tone: 'bg-emerald-50 text-emerald-900 ring-emerald-200' },
  LIMITED: { label: 'ข้อมูลจำกัด', dot: 'bg-amber-500', tone: 'bg-amber-50 text-amber-900 ring-amber-200' },
  THIN: { label: 'ข้อมูลน้อย', dot: 'bg-rose-500', tone: 'bg-rose-50 text-rose-900 ring-rose-200' },
};

const STAGE: Record<MatchPreview['stage'], string> = { EARLY: 'ก่อนประกาศตัวจริง', LINEUP: 'หลังประกาศตัวจริง' };

/**
 * 🔎 วิเคราะห์เกม — the written preview. Reading material, not a pick: no compass colour, never in 🧭 stats.
 * Numbers (probabilities, predicted score) are the model's; the prose is AI or template text, stored before kickoff.
 */
export function MatchPreviewCard({ p, home, away, result }: { p: MatchPreview; home: string; away: string; result?: { home: number; away: number } | null }) {
  const support = DATA_SUPPORT[p.data_support];
  const hasScore = p.predicted_home != null && p.predicted_away != null;
  return (
    <Section title="🔎 วิเคราะห์เกม" aside={`${STAGE[p.stage]} · ${dateTimeTH(p.created_at)}`}>
      <div className={`mb-3 rounded-lg px-3 py-2 text-xs leading-relaxed ring-1 ${support.tone}`}>
        <p className="flex items-center gap-1.5 font-semibold">
          <span className={`h-2 w-2 shrink-0 rounded-full ${support.dot}`} aria-hidden />
          {support.label}
          {p.data_support === 'GOOD' && !p.data_notes.length ? <span className="font-normal">— ฟอร์ม, xG, ตารางคะแนน, ตัวเจ็บ, โมเดล และราคาตลาดครบ</span> : null}
        </p>
        {p.data_notes.length ? (
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {p.data_notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <p className="text-sm leading-relaxed text-slate-800">{p.overview_th}</p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {[
          { name: home, text: p.home_th, side: 'เจ้าบ้าน' },
          { name: away, text: p.away_th, side: 'ทีมเยือน' },
        ].map((t) => (
          <div key={t.side} className="rounded-xl bg-slate-50 p-3">
            <p className="mb-1 text-xs text-slate-500">{t.side}</p>
            <p className="text-sm font-semibold">{t.name}</p>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-700">{t.text}</p>
          </div>
        ))}
      </div>

      <div className="mt-4 rounded-xl border border-slate-200 p-3 sm:p-4">
        <p className="text-xs text-slate-500">คาดการณ์สกอร์จากโมเดล</p>
        {hasScore ? (
          <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <p className="text-2xl font-bold tabular-nums">
              {home} {p.predicted_home}-{p.predicted_away} {away}
            </p>
            <p className="text-xs text-slate-500">
              สกอร์ที่มีโอกาสมากที่สุด {pct(p.predicted_p)}
              {p.expected_home != null ? ` · ประตูคาดหวัง ${Number(p.expected_home).toFixed(2)} – ${Number(p.expected_away).toFixed(2)}` : ''}
            </p>
            {result ? (
              <p className="text-xs font-semibold text-slate-700">
                ผลจริง {result.home}-{result.away}
                {result.home === p.predicted_home && result.away === p.predicted_away ? ' ✓ ตรงสกอร์' : sameOutcome(result, p) ? ' ✓ ตรงผล' : ' ✗'}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="mt-1 text-sm text-slate-600">ยังไม่มีสกอร์คาดการณ์ — โมเดลไม่มีข้อมูลพอสำหรับรายการนี้</p>
        )}
        <p className="mt-2 text-sm leading-relaxed text-slate-700">{p.score_th}</p>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-slate-500">
        {p.text_source === 'AI' ? 'เรียบเรียงโดย AI จากข้อมูลในระบบเท่านั้น ตัวเลขทุกตัวมาจากโมเดลและฐานข้อมูล' : 'สร้างจากตัวเลขในระบบโดยอัตโนมัติ'} · บันทึกก่อนเตะ แก้ไขไม่ได้ · เป็นข้อมูลประกอบ{' '}
        <b>ไม่ใช่ 🧭 เข็มทิศเกม</b> และไม่นับในผลงาน
      </p>
    </Section>
  );
}

function sameOutcome(r: { home: number; away: number }, p: MatchPreview): boolean {
  const sign = (a: number, b: number) => Math.sign(a - b);
  return sign(r.home, r.away) === sign(p.predicted_home!, p.predicted_away!);
}
