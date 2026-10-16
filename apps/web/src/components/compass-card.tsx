import type { OutcomeDistribution } from '@fp/analysis';
import type { Compass } from '@/lib/queries';
import { STATUS, odds, pct, pickRationale, selectionLabel, toSelection, winCondition } from '@/lib/labels';
import type { LiveSeed } from '@/lib/live';
import { dateTimeTH } from '@/lib/time';
import { CompassExplainer } from './compass-explainer';
import { LivePhaseBadge } from './live';
import { Badge, Card, StatStrip, StatusPill, plainLine } from './sheet';

const MARKET_TH: Record<string, string> = { MATCH_WINNER: 'ผลแพ้ชนะ 1X2', ASIAN_HANDICAP: 'กำแพง · แฮนดิแคป', OVER_UNDER: 'สูง/ต่ำ' };
const STRENGTH_TH: Record<string, string> = { STRONG: 'หนักแน่น', MEDIUM: 'ปานกลาง', LEAN: 'อ่อน' };
// reason lines that only repeat the pick or the stat strip
const REPEATS = ['เข็มทิศเกม', 'ระดับสัญญาณ', 'โมเดลให้โอกาส', 'อ้างอิงราคา'];
// technical reason lines: kept, but behind "รายละเอียดเพิ่มเติม"
const TECHNICAL = ['โมเดลผ่านการทดสอบ', 'แรงตลาด'];
const ROUND_TH: Record<string, string> = { EARLY: 'รอบแรก ก่อนประกาศตัวจริง', LINEUP: 'หลังประกาศตัวจริง', PREMATCH: 'ก่อนเตะ' };
const DIST_KEY = { WIN: 'win', HALF_WIN: 'halfWin', PUSH: 'push', HALF_LOSS: 'halfLoss', LOSS: 'loss' } as const satisfies Record<string, keyof OutcomeDistribution>;
const OUTCOME_TONE: Record<string, string> = { WIN: 'text-emerald-800', HALF_WIN: 'text-emerald-700', PUSH: 'text-zinc-600', HALF_LOSS: 'text-orange-800', LOSS: 'text-rose-800' };

/**
 * เข็มทิศเกม — the one pick for this match (SIGNAL rounds only; fog is not shown on the match page).
 * Reads top-down for any fan: the pick, what has to happen on the pitch for each outcome (with the
 * model's chance of it), and why it was picked. Technical figures sit behind "รายละเอียดเพิ่มเติม".
 */
export function CompassCard({ c, home, away, live, id }: { c: Compass; home: string; away: string; live: LiveSeed; id?: string }) {
  const line = c.line == null ? null : Number(c.line);
  const label = selectionLabel(c.market!, c.selection!, line, home, away);
  const sel = toSelection(c.market, c.selection, line);
  const rows = sel ? winCondition(sel, home, away) : [];
  const dist = c.model_distribution;

  // the stored reason is hashed and can't change: only how it is shown can
  const reasons = (c.reason ?? '')
    .split('\n')
    .map(plainLine)
    .filter((l) => l && !REPEATS.some((p) => l.startsWith(p)))
    .map((l) => l.replace('โมเดล Elo', 'อีกโมเดลหนึ่งของเรา'));
  const isTechnical = (l: string) => TECHNICAL.some((p) => l.startsWith(p));
  const edge = c.model_probability != null && c.market_probability != null ? Math.round((Number(c.model_probability) - Number(c.market_probability)) * 1000) / 10 : null;

  // an unsettled pick is described by where the match stands; settled picks show their result
  const badge = c.status !== 'PENDING' ? <StatusPill status={c.status} /> : <LivePhaseBadge seed={live} />;

  // model_probability leaves pushes out and counts half outcomes as half: say so when it matters
  const qualifiers = [
    rows.some((r) => r.outcome === 'PUSH') ? 'ไม่นับกรณีเสมอตัว' : null,
    rows.some((r) => r.outcome === 'HALF_WIN' || r.outcome === 'HALF_LOSS') ? 'นับถูกครึ่ง/ผิดครึ่งเป็นครึ่งหนึ่ง' : null,
  ].filter(Boolean);

  return (
    <Card id={id} title="เข็มทิศเกม" description={`${ROUND_TH[c.publish_round] ?? c.publish_round} · ล็อกก่อนเตะ แก้ไขไม่ได้`} action={badge} tone="pick">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="compass">{MARKET_TH[c.market!] ?? c.market}</Badge>
        {c.signal_strength ? <Badge>สัญญาณ{STRENGTH_TH[c.signal_strength] ?? c.signal_strength}</Badge> : null}
      </div>
      <p className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-zinc-950">{label}</p>
      {/* the note (pick_th) says the same direction as the rationale, with the facts behind it */}
      {c.note_th ? (
        <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-zinc-700">{c.note_th}</p>
      ) : sel ? (
        <p className="mt-1.5 text-sm leading-relaxed text-zinc-700">{pickRationale(sel, home, away)}</p>
      ) : null}

      {rows.length ? (
        <div className="mt-4">
          <table className="w-full text-sm">
            <caption className="sr-only">ผลการแข่งขันที่ทำให้เข็มทิศเกมถูกหรือผิด{dist ? ' พร้อมโอกาสจากโมเดล' : ''}</caption>
            <tbody className="divide-y divide-zinc-100">
              {rows.map((r) => {
                const actual = r.outcome === c.status;
                return (
                  <tr key={r.outcome} className={actual ? 'bg-zinc-50 font-semibold' : undefined}>
                    <td className="py-2 pr-3 text-zinc-800">{r.when}</td>
                    <td className={`whitespace-nowrap py-2 pr-3 font-medium ${OUTCOME_TONE[r.outcome]}`}>
                      <span aria-hidden>→ </span>
                      {STATUS[r.outcome].label}
                    </td>
                    {dist ? <td className="whitespace-nowrap py-2 text-right tabular-nums text-zinc-950">{pct(dist[DIST_KEY[r.outcome]])}</td> : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-1.5 text-xs text-zinc-500">นับผล 90 นาที ไม่รวมต่อเวลาพิเศษ{dist ? ' · เปอร์เซ็นต์คือโอกาสจากโมเดลก่อนเตะ' : ''}</p>
        </div>
      ) : null}

      {c.model_probability != null && c.market_probability != null ? (
        <p className="mt-3 text-sm leading-relaxed text-zinc-700">
          {qualifiers.length ? `เมื่อ${qualifiers.join(' และ')} ` : ''}โมเดลให้โอกาสถูก <b className="font-semibold text-amber-800">{pct(c.model_probability)}</b> ส่วนตลาดประเมินไว้{' '}
          <b className="font-semibold text-zinc-950">{pct(c.market_probability)}</b>
        </p>
      ) : null}
      <CompassExplainer className="mt-1" />

      <ReasonList lines={reasons.filter((l) => !isTechnical(l))} />

      {c.result_score ? (
        <p className="mt-4 text-sm text-zinc-700">
          ผล 90 นาที <b className="font-semibold tabular-nums text-zinc-950">{c.result_score}</b>
          {c.settled_at ? <span className="text-xs text-zinc-500"> · ตัดสินผล {dateTimeTH(c.settled_at)}</span> : null}
        </p>
      ) : null}

      <details className="group mt-4 border-t border-zinc-100 pt-1">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between text-sm text-zinc-600 [&::-webkit-details-marker]:hidden">
          รายละเอียดเพิ่มเติม
          <span className="text-xs text-zinc-500 group-open:hidden">แสดง</span>
          <span className="hidden text-xs text-zinc-500 group-open:inline">ซ่อน</span>
        </summary>
        <div className="pb-1 pt-2">
          <StatStrip
            items={[
              { k: 'โมเดล', v: pct(c.model_probability, 1), tone: 'text-amber-800' },
              { k: 'ตลาด', v: pct(c.market_probability, 1) },
              { k: 'ส่วนต่าง', v: edge == null ? '–' : `${edge > 0 ? '+' : ''}${edge.toFixed(1)} จุด` },
              { k: 'ราคาอ้างอิง', v: odds(c.odds_at_publish) },
            ]}
          />
          <ReasonList lines={reasons.filter(isTechnical)} />
          <div className="mt-4 text-xs text-zinc-500">
            <p>
              วิเคราะห์เมื่อ {dateTimeTH(c.published_at)} · รหัส {c.public_id}
            </p>
            {/* tap to reveal + select the full hash (a hover tooltip never shows on touch screens) */}
            <details className="mt-1">
              <summary className="inline-flex min-h-8 cursor-pointer items-center font-mono">hash {c.record_hash.slice(0, 12)}… แตะเพื่อดูทั้งหมด</summary>
              <p className="mt-1 select-all break-all rounded-md border border-zinc-200 bg-zinc-50 p-2 font-mono">{c.record_hash}</p>
            </details>
          </div>
        </div>
      </details>
    </Card>
  );
}

function ReasonList({ lines }: { lines: string[] }) {
  if (!lines.length) return null;
  return (
    <ul className="mt-4 space-y-1.5 text-sm leading-relaxed text-zinc-700">
      {lines.map((r, i) => (
        <li key={i} className="flex gap-2.5">
          <span className="mt-[0.6em] h-px w-2.5 shrink-0 bg-zinc-300" aria-hidden />
          <span>{r}</span>
        </li>
      ))}
    </ul>
  );
}
