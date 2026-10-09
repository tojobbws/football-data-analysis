import type { Compass } from '@/lib/queries';
import { odds, pct, selectionLabel } from '@/lib/labels';
import { dateTimeTH } from '@/lib/time';
import { Badge, Card, StatStrip, StatusPill, plainLine } from './sheet';

const MARKET_TH: Record<string, string> = { MATCH_WINNER: 'ผลแพ้ชนะ 1X2', ASIAN_HANDICAP: 'กำแพง · แฮนดิแคป', OVER_UNDER: 'สูง/ต่ำ' };
const STRENGTH_TH: Record<string, string> = { STRONG: 'หนักแน่น', MEDIUM: 'ปานกลาง', LEAN: 'อ่อน' };
// reason lines that only repeat the pick or the stat strip
const REPEATS = ['เข็มทิศเกม', 'ระดับสัญญาณ', 'โมเดลให้โอกาส', 'อ้างอิงราคา'];
const ROUND_TH: Record<string, string> = { EARLY: 'รอบแรก ก่อนประกาศตัวจริง', LINEUP: 'หลังประกาศตัวจริง', PREMATCH: 'ก่อนเตะ' };

/**
 * เข็มทิศเกม — the one pick for this match (SIGNAL rounds only; fog is not shown on the match page).
 * The stored reason is shown line by line with leading emoji stripped for display.
 */
export function CompassCard({ c, home, away, id }: { c: Compass; home: string; away: string; id?: string }) {
  const label = selectionLabel(c.market!, c.selection!, c.line == null ? null : Number(c.line), home, away);
  // the first line repeats the pick and the strength line repeats the strip: keep the rest
  const reasons = (c.reason ?? '')
    .split('\n')
    .map(plainLine)
    .filter((l) => l && !REPEATS.some((p) => l.startsWith(p)));
  const edge = c.model_probability != null && c.market_probability != null ? Math.round((Number(c.model_probability) - Number(c.market_probability)) * 1000) / 10 : null;

  return (
    <Card id={id} title="เข็มทิศเกม" description={`${ROUND_TH[c.publish_round] ?? c.publish_round} · ล็อกก่อนเตะ แก้ไขไม่ได้`} action={<StatusPill status={c.status} />} tone="pick">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="compass">{MARKET_TH[c.market!] ?? c.market}</Badge>
        {c.signal_strength ? <Badge>สัญญาณ{STRENGTH_TH[c.signal_strength] ?? c.signal_strength}</Badge> : null}
      </div>
      <p className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-zinc-950">{label}</p>

      <div className="mt-4">
        <StatStrip
          items={[
            { k: 'โมเดล', v: pct(c.model_probability, 1), tone: 'text-amber-800' },
            { k: 'ตลาด', v: pct(c.market_probability, 1) },
            { k: 'ส่วนต่าง', v: edge == null ? '–' : `${edge > 0 ? '+' : ''}${edge.toFixed(1)} จุด` },
            { k: 'ราคาอ้างอิง', v: odds(c.odds_at_publish) },
          ]}
        />
      </div>

      {reasons.length ? (
        <ul className="mt-4 space-y-1.5 text-sm leading-relaxed text-zinc-700">
          {reasons.map((r, i) => (
            <li key={i} className="flex gap-2.5">
              <span className="mt-[0.6em] h-px w-2.5 shrink-0 bg-zinc-300" aria-hidden />
              <span>{r}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {c.result_score ? (
        <p className="mt-4 text-sm text-zinc-700">
          ผล 90 นาที <b className="font-semibold tabular-nums text-zinc-950">{c.result_score}</b>
        </p>
      ) : null}

      <div className="mt-4 border-t border-zinc-100 pt-3 text-xs text-zinc-500">
        <p>
          วิเคราะห์เมื่อ {dateTimeTH(c.published_at)} · รหัส {c.public_id}
          {c.settled_at ? <> · ตัดสินผล {dateTimeTH(c.settled_at)}</> : null}
        </p>
        {/* tap to reveal + select the full hash (a hover tooltip never shows on touch screens) */}
        <details className="mt-1">
          <summary className="inline-flex min-h-8 cursor-pointer items-center font-mono">hash {c.record_hash.slice(0, 12)}… แตะเพื่อดูทั้งหมด</summary>
          <p className="mt-1 select-all break-all rounded-md border border-zinc-200 bg-zinc-50 p-2 font-mono">{c.record_hash}</p>
        </details>
      </div>
    </Card>
  );
}
