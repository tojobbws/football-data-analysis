import type { DataSupport, MatchPreview } from '@/lib/queries';
import { STATUS, pct, settle, type Status } from '@/lib/labels';
import type { MarketSelection } from '@fp/analysis';
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
 * Numbers (probabilities, most likely score) are the model's; the prose is AI or template text, stored before kickoff.
 * With a pick on the page, the most likely score is tied back to it ("ถ้าจบ 2–0 … = เสมอตัว") so the two never read as rivals.
 * The score section leads with the goal bands (0–1 / 2 / 3+): a low top scoreline beside the outlook's over 2.5
 * read as a contradiction. Previews written before the bands (preview-v0.5) keep the scoreline and point to the outlook.
 */
export function MatchPreviewCard({ p, home, away, result, modelTested, pick, overInOutlook = false, id }: { p: MatchPreview; home: string; away: string; result?: { home: number; away: number } | null; modelTested: boolean; pick?: { label: string; sel: MarketSelection } | null; overInOutlook?: boolean; id?: string }) {
  const notes = p.data_notes.filter((n) => !n.includes(UNTESTED_NOTE));
  // a LIMITED level whose only reason was the untested note reads as GOOD, like a preview written today
  const support = DATA_SUPPORT[p.data_support === 'LIMITED' && notes.length === 0 && p.data_notes.length > 0 ? 'GOOD' : p.data_support];
  const hasScore = p.predicted_home != null && p.predicted_away != null;
  const ifScore = pick && hasScore ? (settle(pick.sel, Number(p.predicted_home), Number(p.predicted_away)) as Status) : null;
  const hit = result && hasScore ? (result.home === p.predicted_home && result.away === p.predicted_away ? 'ตรงสกอร์' : sameOutcome(result, p) ? 'ตรงผล' : 'ไม่ตรง') : null;
  const bands =
    p.p_goals_0_1 != null && p.p_goals_2 != null && p.p_goals_3plus != null
      ? [
          { key: 1, label: '0–1 ประตู', p: Number(p.p_goals_0_1) },
          { key: 2, label: '2 ประตู', p: Number(p.p_goals_2) },
          { key: 3, label: '3 ประตูขึ้นไป', p: Number(p.p_goals_3plus) },
        ]
      : null;
  const topBand = bands ? Math.max(...bands.map((b) => b.p)) : null;
  const resultBand = result ? Math.max(1, Math.min(3, result.home + result.away)) : null;

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

      {bands ? (
        <div className="mt-5 grid gap-x-8 gap-y-3 border-t border-zinc-100 pt-4 sm:grid-cols-[15rem_minmax(0,1fr)]">
          <div>
            <p className="text-xs text-zinc-500">จำนวนประตูรวม</p>
            <dl className="mt-1 divide-y divide-zinc-100">
              {bands.map((b) => (
                <div key={b.key} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                  <dt className="flex min-w-0 items-center gap-2">
                    <span className={b.p === topBand ? 'font-semibold text-zinc-950' : 'text-zinc-700'}>{b.label}</span>
                    {resultBand === b.key ? <Badge variant="secondary">ผลจริง</Badge> : null}
                  </dt>
                  <dd className={`tabular-nums ${b.p === topBand ? 'font-semibold text-zinc-950' : 'text-zinc-600'}`}>{pct(b.p)}</dd>
                </div>
              ))}
            </dl>
            {hasScore ? (
              <div className="mt-3 border-t border-zinc-100 pt-3 text-xs leading-relaxed text-zinc-500">
                <p>
                  สกอร์เดียวที่เป็นไปได้มากที่สุด <b className="font-semibold tabular-nums text-zinc-950">{p.predicted_home}–{p.predicted_away}</b> โอกาส {pct(p.predicted_p)}
                  {p.predicted_p != null ? ` · ยังมีสกอร์อื่นอีก ${pct(1 - Number(p.predicted_p))}` : ''}
                </p>
                <ScoreDetails p={p} ifScore={ifScore} pick={pick} modelTested={modelTested} hit={hit} result={result} />
              </div>
            ) : null}
          </div>
          <p className="max-w-prose text-sm leading-relaxed text-zinc-700 sm:pt-5">{p.score_th}</p>
        </div>
      ) : (
        <div className="mt-5 grid gap-x-8 gap-y-2 border-t border-zinc-100 pt-4 sm:grid-cols-[11rem_minmax(0,1fr)]">
          <div>
            <p className="text-xs text-zinc-500">สกอร์ที่เป็นไปได้มากที่สุด</p>
            {hasScore ? (
              <>
                <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-zinc-950">
                  {p.predicted_home}–{p.predicted_away}
                </p>
                <p className="mt-1 text-xs text-zinc-500">
                  โอกาส {pct(p.predicted_p)}
                  {p.predicted_p != null ? ` · ยังมีสกอร์อื่นอีก ${pct(1 - Number(p.predicted_p))}` : ''}
                </p>
                <ScoreDetails p={p} ifScore={ifScore} pick={pick} modelTested={modelTested} hit={hit} result={result} />
              </>
            ) : (
              <p className="mt-1 text-sm text-zinc-600">ยังไม่มี — โมเดลมีข้อมูลไม่พอ</p>
            )}
          </div>
          <div className="max-w-prose space-y-2 text-sm leading-relaxed text-zinc-700 sm:pt-5">
            <p>{p.score_th}</p>
            {hasScore && overInOutlook ? (
              <p className="text-xs text-zinc-500">
                สกอร์เดียวที่สูงสุดมักเป็นสกอร์ต่ำ ส่วนโอกาสที่จะยิงรวม 3 ประตูขึ้นไป ดูได้ที่{' '}
                <a href="#model" className="underline underline-offset-2 hover:text-zinc-950">
                  มุมมองโมเดล
                </a>
              </p>
            ) : null}
          </div>
        </div>
      )}

      <Note>
        {p.text_source === 'AI' ? 'เรียบเรียงโดย AI จากข้อมูลในระบบเท่านั้น ตัวเลขทุกตัวมาจากโมเดลและฐานข้อมูล' : 'สร้างจากตัวเลขในระบบโดยอัตโนมัติ'} · บันทึกก่อนเตะ แก้ไขไม่ได้ · เป็นข้อมูลประกอบ ไม่ใช่เข็มทิศเกม และไม่นับในผลงาน
      </Note>
    </Card>
  );
}

/** Under the scoreline: xG, what that score means for the pick, the measuring note, and the result once known. */
function ScoreDetails({ p, ifScore, pick, modelTested, hit, result }: { p: MatchPreview; ifScore: Status | null; pick?: { label: string } | null; modelTested: boolean; hit: string | null; result?: { home: number; away: number } | null }) {
  return (
    <>
      {p.expected_home != null ? (
        <p className="mt-1 text-xs text-zinc-500">
          xG {Number(p.expected_home).toFixed(2)}–{Number(p.expected_away).toFixed(2)}
        </p>
      ) : null}
      {ifScore ? (
        <p className="mt-1 text-xs text-zinc-600">
          ถ้าจบ {p.predicted_home}–{p.predicted_away} เข็มทิศเกม {pick!.label} = <b className="font-semibold text-zinc-950">{STATUS[ifScore].label}</b>
        </p>
      ) : null}
      {modelTested ? null : <p className="mt-1 text-xs text-zinc-400">อยู่ระหว่างการวัดผล</p>}
      {hit ? (
        <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-600">
          ผลจริง <b className="tabular-nums text-zinc-950">{result!.home}–{result!.away}</b>
          <Badge variant={hit === 'ไม่ตรง' ? 'outline' : 'good'}>{hit}</Badge>
        </p>
      ) : null}
    </>
  );
}

function sameOutcome(r: { home: number; away: number }, p: MatchPreview): boolean {
  const sign = (a: number, b: number) => Math.sign(a - b);
  return sign(r.home, r.away) === sign(p.predicted_home!, p.predicted_away!);
}
