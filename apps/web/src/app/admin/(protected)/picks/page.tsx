import Link from 'next/link';
import { Empty, Section, StatusBadge } from '@/components/ui';
import { authClient } from '@/lib/auth';
import { FINISHED, ROUND_SHORT, selectionLabel, settle, toSelection, type Status } from '@/lib/labels';
import { addDaysStr, footballDate, footballDayRange, isValidDate, timeTH } from '@/lib/time';

interface Row {
  fixture_id: number;
  slug: string | null;
  kickoff_at: string;
  status_short: string;
  home: string;
  away: string;
  goals_home: number | null;
  goals_away: number | null;
  round: string;
  decided_at: string;
  ai_status: 'OK' | 'INVALID' | 'REFUSED' | 'ERROR';
  side: 'FAVORITE' | 'UNDERDOG' | 'OVER' | 'UNDER' | 'NO_PICK' | null;
  market: string | null;
  selection: string | null;
  line: number | null;
  odds: number | null;
  confidence: string | null;
  summary_th: string | null;
  legacy: { outcome?: string; pick?: { market: string; selection: string; line: number | null; odds: number | null } | null } | null;
  published: boolean;
}

interface Bet {
  market: string;
  selection: string;
  line: number | null;
  odds: number | null;
}

const ROUNDS = ['EARLY', 'PREMATCH', 'LINEUP'] as const;
const SIDE: Record<string, string> = { FAVORITE: 'เต็ง', UNDERDOG: 'ทีมรอง', OVER: 'สูง', UNDER: 'ต่ำ' };

const aiBet = (r: Row): Bet | null => (r.ai_status === 'OK' && r.side && r.side !== 'NO_PICK' && r.market && r.selection ? { market: r.market, selection: r.selection, line: r.line == null ? null : Number(r.line), odds: r.odds == null ? null : Number(r.odds) } : null);
const rulesBet = (r: Row): Bet | null => {
  const p = r.legacy?.pick;
  return p ? { market: p.market, selection: p.selection, line: p.line == null ? null : Number(p.line), odds: p.odds == null ? null : Number(p.odds) } : null;
};

function result(r: Row, b: Bet | null): { status: Status; units: number | null } | null {
  if (!b || !FINISHED.includes(r.status_short) || r.goals_home == null || r.goals_away == null) return null;
  const sel = toSelection(b.market, b.selection, b.line);
  if (!sel) return null;
  const status = settle(sel, r.goals_home, r.goals_away) as Status;
  const o = b.odds;
  const units = o == null ? null : { WIN: o - 1, HALF_WIN: (o - 1) / 2, PUSH: 0, HALF_LOSS: -0.5, LOSS: -1 }[status as 'WIN' | 'HALF_WIN' | 'PUSH' | 'HALF_LOSS' | 'LOSS'] ?? null;
  return { status, units };
}

const same = (a: Bet | null, b: Bet | null) => !!a && !!b && a.market === b.market && a.selection === b.selection && a.line === b.line;
const u = (x: number | null) => (x == null ? '' : `${x > 0 ? '+' : ''}${x.toFixed(2)}`);

interface Tally { picks: number; settled: number; win: number; loss: number; push: number; units: number }
function tally(rows: Array<{ res: ReturnType<typeof result>; bet: Bet | null }>): Tally {
  const t: Tally = { picks: 0, settled: 0, win: 0, loss: 0, push: 0, units: 0 };
  for (const { res, bet } of rows) {
    if (!bet) continue;
    t.picks++;
    if (!res) continue;
    t.settled++;
    if (res.status === 'WIN' || res.status === 'HALF_WIN') t.win++;
    else if (res.status === 'LOSS' || res.status === 'HALF_LOSS') t.loss++;
    else t.push++;
    t.units += res.units ?? 0;
  }
  return t;
}

/**
 * Per football day (06:00 → 06:00 Thai): what the rules and the Hybrid AI each chose for every match, side by side,
 * with the result of each bet at its own price. Read-only. Only matches the AI has decided (hybrid_decisions, since 2026-10-26).
 */
export default async function AdminPickCompare({ searchParams }: { searchParams: Promise<{ date?: string; round?: string }> }) {
  const q = await searchParams;
  const today = footballDate();
  const date = isValidDate(q.date) ? q.date : today;
  const round = (ROUNDS as readonly string[]).includes(q.round ?? '') ? q.round! : 'EARLY';
  const { from, to } = footballDayRange(date);

  const sb = await authClient();
  const res = await sb.rpc('fp_admin_pick_compare', { p_from: from, p_to: to });
  const all = ((res.data ?? []) as Row[]).filter((r) => r.round === round);

  const lines = all.map((r) => {
    const ai = aiBet(r);
    const rl = rulesBet(r);
    return { r, ai, rl, aiRes: result(r, ai), rlRes: result(r, rl) };
  });
  const aiT = tally(lines.map((l) => ({ res: l.aiRes, bet: l.ai })));
  const rlT = tally(lines.map((l) => ({ res: l.rlRes, bet: l.rl })));
  const both = lines.filter((l) => l.ai && l.rl);
  const q2 = (d: string, r = round) => `/admin/picks?date=${d}&round=${r}`;

  return (
    <main className="space-y-5">
      <header>
        <h1 className="text-xl font-bold">สูตรคณิตศาสตร์เดิม (rules) vs Hybrid-AI-v1 รายวัน</h1>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-600">
          ผลตัดสินล่าสุดของแต่ละรอบ ณ เวลาเดียวกัน · ผลและหน่วยคิดจากราคาของแต่ละฝั่ง (แทงคู่ละ 1 หน่วย) · pick ของ rules ในหน้านี้อาจไม่ได้เผยแพร่ ·
          ข้อมูลมีตั้งแต่ 26 ต.ค. 2026 · ตัวอย่างระดับรายวันเล็กเกินจะสรุปว่าฝั่งไหนดีกว่า
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Link href={q2(addDaysStr(date, -1))} className="rounded-full bg-slate-100 px-3 py-1 hover:bg-slate-200">← วันก่อน</Link>
        <b className="px-2">วันบอล {date}</b>
        {date < today ? <Link href={q2(addDaysStr(date, 1))} className="rounded-full bg-slate-100 px-3 py-1 hover:bg-slate-200">วันถัดไป →</Link> : null}
        <span className="mx-2 text-slate-300">|</span>
        {ROUNDS.map((x) => (
          <Link key={x} href={q2(date, x)} className={`rounded-full px-3 py-1 ${x === round ? 'bg-[var(--color-ink)] text-white' : 'bg-slate-100 hover:bg-slate-200'}`}>
            {ROUND_SHORT[x]}
          </Link>
        ))}
      </div>

      {res.error ? <p className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">โหลดข้อมูลไม่สำเร็จ: {res.error.message} (ต้อง migrate 0050 ก่อน)</p> : null}

      <Section title="สรุปวัน" aside={`${lines.length} คู่ที่ AI ตัดสินในรอบนี้`}>
        {lines.length ? (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-500">
                  <th className="pb-2 text-left font-normal">ผู้เลือก</th>
                  <th className="pb-2 font-normal">เลือก</th>
                  <th className="pb-2 font-normal">จบแล้ว</th>
                  <th className="pb-2 font-normal">ได้ (รวมครึ่ง)</th>
                  <th className="pb-2 font-normal">เสีย (รวมครึ่ง)</th>
                  <th className="pb-2 font-normal">เจ๊า</th>
                  <th className="pb-2 font-normal">หน่วยสุทธิ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-center tabular-nums">
                {([['Hybrid-AI-v1', aiT], ['rules เดิม', rlT]] as const).map(([name, t]) => (
                  <tr key={name}>
                    <td className="py-1.5 text-left">{name}</td>
                    <td>{t.picks}</td>
                    <td>{t.settled}</td>
                    <td>{t.win}</td>
                    <td>{t.loss}</td>
                    <td>{t.push}</td>
                    <td className="font-semibold">{t.settled ? u(t.units) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-slate-500">
              เลือกทั้งคู่ {both.length} คู่ · เดิมพันเหมือนกัน {both.filter((l) => same(l.ai, l.rl)).length} คู่ · ฝั่งเดียวเลือก: AI {lines.filter((l) => l.ai && !l.rl).length} · rules {lines.filter((l) => !l.ai && l.rl).length}
            </p>
          </>
        ) : (
          <Empty inline>ยังไม่มีการตัดสินของ AI ในรอบนี้ของวันนี้</Empty>
        )}
      </Section>

      <Section title="รายคู่">
        {lines.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="text-xs text-slate-500">
                  <th className="pb-2 text-left font-normal">คู่</th>
                  <th className="pb-2 text-left font-normal">Hybrid-AI-v1</th>
                  <th className="pb-2 text-left font-normal">rules เดิม</th>
                  <th className="pb-2 font-normal">เทียบ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 align-top">
                {lines.map(({ r, ai, rl, aiRes, rlRes }) => {
                  const note = ai && rl ? (same(ai, rl) ? 'ตรงกัน' : 'ต่างกัน') : ai ? 'AI เท่านั้น' : rl ? 'rules เท่านั้น' : '';
                  return (
                    <tr key={r.fixture_id}>
                      <td className="py-2 pr-3">
                        {r.slug ? <Link href={`/matches/${r.slug}`} className="font-medium hover:underline">{r.home} vs {r.away}</Link> : <span className="font-medium">{r.home} vs {r.away}</span>}
                        <p className="text-xs text-slate-500">
                          {timeTH(r.kickoff_at)}
                          {r.goals_home != null && FINISHED.includes(r.status_short) ? ` · ${r.goals_home}-${r.goals_away}` : ''}
                        </p>
                      </td>
                      <td className="py-2 pr-3">
                        {r.ai_status !== 'OK' ? (
                          <span className="text-rose-600">{r.ai_status}</span>
                        ) : ai ? (
                          <>
                            <p>
                              {selectionLabel(ai.market, ai.selection, ai.line, r.home, r.away)} <span className="text-xs text-slate-500">@{ai.odds ?? '-'} · {SIDE[r.side ?? ''] ?? ''}{r.confidence ? ` · ${r.confidence}` : ''}</span>
                            </p>
                            <p className="mt-0.5 flex items-center gap-1.5">
                              {aiRes ? <StatusBadge admin status={aiRes.status} /> : <span className="text-xs text-slate-500">รอผล</span>} <span className="text-xs tabular-nums">{u(aiRes?.units ?? null)}</span>
                              {r.published ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">เผยแพร่</span> : null}
                            </p>
                          </>
                        ) : (
                          <span className="text-slate-400">ไม่เลือก</span>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        {rl ? (
                          <>
                            <p>
                              {selectionLabel(rl.market, rl.selection, rl.line, r.home, r.away)} <span className="text-xs text-slate-500">@{rl.odds ?? '-'}</span>
                            </p>
                            <p className="mt-0.5 flex items-center gap-1.5">
                              {rlRes ? <StatusBadge admin status={rlRes.status} /> : <span className="text-xs text-slate-500">รอผล</span>} <span className="text-xs tabular-nums">{u(rlRes?.units ?? null)}</span>
                            </p>
                          </>
                        ) : (
                          <span className="text-slate-400">{r.legacy ? 'ไม่มีสัญญาณ' : 'ไม่มีข้อมูล'}</span>
                        )}
                      </td>
                      <td className={`py-2 text-center text-xs ${note === 'ตรงกัน' ? 'text-emerald-700' : note === 'ต่างกัน' ? 'text-amber-700' : 'text-slate-500'}`}>{note}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty inline>ไม่มีคู่</Empty>
        )}
      </Section>
    </main>
  );
}
