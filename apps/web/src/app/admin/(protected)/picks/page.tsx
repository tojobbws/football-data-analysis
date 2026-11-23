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

const ROUNDS = ['DAILY', 'EARLY', 'PREMATCH', 'LINEUP'] as const;
const SIDE: Record<string, string> = { FAVORITE: 'เต็ง', UNDERDOG: 'ทีมรอง', OVER: 'สูง', UNDER: 'ต่ำ' };

const aiBet = (r: Row): Bet | null => (r.ai_status === 'OK' && r.side && r.side !== 'NO_PICK' && r.market && r.selection ? { market: r.market, selection: r.selection, line: r.line == null ? null : Number(r.line), odds: r.odds == null ? null : Number(r.odds) } : null);
const rulesBet = (r: Row): Bet | null => {
  const p = r.legacy?.pick;
  return p ? { market: p.market, selection: p.selection, line: p.line == null ? null : Number(p.line), odds: p.odds == null ? null : Number(p.odds) } : null;
};

function result(r: Pick<Row, 'status_short' | 'goals_home' | 'goals_away'>, b: Bet | null): { status: Status; units: number | null } | null {
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
 * Per football day (10:00 → 10:00 Thai): what the rules and the Hybrid AI each chose for every match, side by side,
 * with the result of each bet at its own price. Read-only. Only matches the AI has decided (hybrid_decisions, since 2026-10-26).
 */
export default async function AdminPickCompare({ searchParams }: { searchParams: Promise<{ date?: string; round?: string }> }) {
  const q = await searchParams;
  const today = footballDate();
  const date = isValidDate(q.date) ? q.date : today;
  const round = (ROUNDS as readonly string[]).includes(q.round ?? '') ? q.round! : 'DAILY';
  const { from, to } = footballDayRange(date);

  const sb = await authClient();
  const res = await sb.rpc('fp_admin_pick_compare', { p_from: from, p_to: to });
  const all = ((res.data ?? []) as Row[]).filter((r) => r.round === round);
  const dres = round === 'DAILY' ? await sb.rpc('fp_admin_decisions_shadow', { p_from: from, p_to: to }) : null;
  const shadowRows = ((dres?.data ?? []) as DRow[]);
  // decisions_shadow holds the one-night OpenAI Decisions v1 test and, since 2026-11-23, the Gemini Decision shadow
  const gRows = shadowRows.filter((r) => r.config.startsWith('gemini:'));
  const dRows = shadowRows.filter((r) => !r.config.startsWith('gemini:'));
  const v2res = round === 'DAILY' ? await sb.rpc('fp_admin_decisions_v2', { p_from: from, p_to: to }) : null;
  const v2Rows = ((v2res?.data ?? []) as DRow[]);

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

      {round === 'DAILY' && gRows.length ? <GeminiCompare rows={gRows} v2Rows={v2Rows} /> : null}
      {round === 'DAILY' && (v2Rows.length || (v2res?.error && dRows.length === 0)) ? <DecisionsShadow v2 rows={v2Rows} error={v2res?.error?.message ?? null} /> : null}
      {round === 'DAILY' && (dRows.length || (dres?.error && !gRows.length)) ? <DecisionsShadow rows={dRows} error={dres?.error?.message ?? null} /> : null}
    </main>
  );
}

/** fp_admin_decisions_shadow (migration 0061): one OpenAI Decisions answer on the input of a DAILY Hybrid AI decision */
interface DRow {
  fixture_id: number;
  slug: string | null;
  kickoff_at: string;
  status_short: string;
  home: string;
  away: string;
  goals_home: number | null;
  goals_away: number | null;
  config: string;
  called_at: string;
  status: 'OK' | 'INVALID' | 'ERROR';
  side: string | null;
  market: string | null;
  selection: string | null;
  line: number | null;
  odds: number | null;
  choice_probability?: number | null;
  /** v2 only (fp_admin_decisions_v2, migration 0062) */
  market_probability?: number | null;
  fair_probability?: number | null;
  ev?: number | null;
  ev_sd?: number | null;
  no_pick_reasons?: string[];
  data_sufficient?: number | null;
  ai_prompt_version: string;
  ai_status: string;
  ai_side: string | null;
  ai_market: string | null;
  ai_selection: string | null;
  ai_line: number | null;
  ai_odds: number | null;
}

const betOf = (ok: boolean, side: string | null, market: string | null, selection: string | null, line: number | null, odds: number | null): Bet | null =>
  ok && side && side !== 'NO_PICK' && market && selection ? { market, selection, line: line == null ? null : Number(line), odds: odds == null ? null : Number(odds) } : null;

const V2_REASON: Record<string, string> = {
  MARKET_FIT_FAILED: 'ไม่มีเส้นหลักครบ',
  DATA_INSUFFICIENT: 'ข้อมูลไม่พอ',
  TOO_FEW_BOOKMAKERS: 'เจ้ามือน้อย',
  STALE_PRICE: 'ราคาเก่า',
  EV_BELOW_THRESHOLD: 'EV ไม่ถึงเกณฑ์',
  EV_NOT_ROBUST: 'EV ไม่นิ่งพอ',
};

/**
 * Shadow only: OpenAI Decisions asked on exactly the stored input of the day's DAILY Hybrid AI decisions; never published.
 * v1 (migration 0061) chose an option; v2 (migration 0062) gives categories that the engine prices, with EV per option.
 */
function DecisionsShadow({ rows, error, v2 = false }: { rows: DRow[]; error: string | null; v2?: boolean }) {
  const lines = rows.map((r) => {
    const dec = betOf(r.status === 'OK', r.side, r.market, r.selection, r.line, r.odds);
    const ai = betOf(r.ai_status === 'OK', r.ai_side, r.ai_market, r.ai_selection, r.ai_line, r.ai_odds);
    return { r, dec, ai, decRes: result(r, dec), aiRes: result(r, ai), late: Date.parse(r.called_at) >= Date.parse(r.kickoff_at) };
  });
  const decT = tally(lines.map((l) => ({ res: l.decRes, bet: l.dec })));
  const aiT = tally(lines.map((l) => ({ res: l.aiRes, bet: l.ai })));
  const late = lines.filter((l) => l.late).length;
  return (
    <Section title={v2 ? 'ทดลอง: Decisions v2 (shadow ไม่เผยแพร่)' : 'ทดลอง: OpenAI Decisions v1 (shadow ไม่เผยแพร่)'} aside={`${lines.length} คู่ · ${rows[0]?.config ?? ''}`}>
      {error ? <p className="mb-3 rounded-xl bg-rose-50 p-3 text-sm text-rose-700">โหลดข้อมูลไม่สำเร็จ: {error} (ต้อง migrate {v2 ? '0062' : '0061'} ก่อน)</p> : null}
      {v2 ? (
        <p className="mb-3 max-w-3xl text-xs leading-relaxed text-slate-600">
          v2 อ่าน input ชุดเดียวกับ Hybrid AI รอบ 14:00 แต่ไม่เห็นคำตอบของ Hybrid · AI ตอบเป็นหมวด (เอียงทีมไหนเทียบเส้นแฮนดิแคป / ประตูมากน้อยเทียบเส้นสกอร์รวม) ·
          เครื่องคำนวณโอกาส ได้/ได้ครึ่ง/คืน/เสียครึ่ง/เสีย และ EV ที่ราคาเดียวกับ Hybrid · เลือกเมื่อ EV ≥ 3% และยังเป็นบวกหลังหักความไม่แน่นอน ไม่งั้นไม่เลือก ·
          เกณฑ์ตัดสินผลกำหนดไว้ก่อน (spec §5) ห้ามสรุปจากรายวัน
        </p>
      ) : (
        <p className="mb-3 max-w-3xl text-xs leading-relaxed text-slate-600">
          Decisions อ่าน input ชุดเดียวกับที่ Hybrid AI ใช้ตัดสินรอบ 14:00 (เก็บไว้ก่อนเตะ) แล้วเลือก 1 ทางหรือไม่เลือก · เทียบกับ Hybrid AI ของ input เดียวกัน ·
          {late ? ` ${late} คู่ถามหลังเตะแล้ว (ยังเห็นแค่ข้อมูล 14:00) มีเครื่องหมาย ⏱ ·` : ''} ตัวอย่างคืนเดียวเล็กเกินจะสรุปว่าแบบไหนดีกว่า
        </p>
      )}
      <table className="mb-4 w-full text-sm">
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
          {([[v2 ? 'Decisions v2' : 'OpenAI Decisions', decT], ['Hybrid AI (×3)', aiT]] as const).map(([name, t]) => (
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
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="text-xs text-slate-500">
              <th className="pb-2 text-left font-normal">คู่</th>
              <th className="pb-2 text-left font-normal">{v2 ? 'Decisions v2' : 'OpenAI Decisions'}</th>
              <th className="pb-2 text-left font-normal">Hybrid AI (×3)</th>
              <th className="pb-2 font-normal">เทียบ</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 align-top">
            {lines.map(({ r, dec, ai, decRes, aiRes, late: isLate }) => {
              const note = dec && ai ? (same(dec, ai) ? 'ตรงกัน' : 'ต่างกัน') : dec ? 'Decisions เท่านั้น' : ai ? 'AI เท่านั้น' : 'ไม่เลือกทั้งคู่';
              const cell = (b: Bet | null, res: ReturnType<typeof result>, side: string | null, status: string, extra: string) =>
                status !== 'OK' ? (
                  <span className="text-rose-600">{status}</span>
                ) : b ? (
                  <>
                    <p>
                      {selectionLabel(b.market, b.selection, b.line, r.home, r.away)} <span className="text-xs text-slate-500">@{b.odds ?? '-'} · {SIDE[side ?? ''] ?? ''}{extra}</span>
                    </p>
                    <p className="mt-0.5 flex items-center gap-1.5">
                      {res ? <StatusBadge admin status={res.status} /> : <span className="text-xs text-slate-500">รอผล</span>} <span className="text-xs tabular-nums">{u(res?.units ?? null)}</span>
                    </p>
                  </>
                ) : (
                  <span className="text-slate-400">ไม่เลือก{extra}</span>
                );
              const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
              const p = v2
                ? dec && r.ev != null
                  ? ` · EV ${Number(r.ev) >= 0 ? '+' : ''}${pct(Number(r.ev))} ±${pct(Number(r.ev_sd ?? 0))} · โอกาส ${pct(Number(r.fair_probability))} (ตลาด ${pct(Number(r.market_probability))})`
                  : r.status === 'OK' && r.no_pick_reasons?.length
                    ? ` · ${r.no_pick_reasons.map((x) => V2_REASON[x] ?? x).join(', ')}`
                    : ''
                : r.choice_probability == null
                  ? ''
                  : ` · p ${Math.round(Number(r.choice_probability) * 100)}%`;
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
                    {cell(dec, decRes, r.side, r.status, p)}
                    {isLate ? <p className="text-xs text-amber-700">⏱ ถามหลังเตะ (input 14:00)</p> : null}
                  </td>
                  <td className="py-2 pr-3">{cell(ai, aiRes, r.ai_side, r.ai_status, '')}</td>
                  <td className={`py-2 text-center text-xs ${note === 'ตรงกัน' ? 'text-emerald-700' : note === 'ต่างกัน' ? 'text-amber-700' : 'text-slate-500'}`}>{note}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

type Res = ReturnType<typeof result>;

/** one engine's choice in a match row: the bet, its price and result, or why there is none */
function BetCell({ r, bet, res, side, status, extra = '' }: { r: Pick<DRow, 'home' | 'away'>; bet: Bet | null; res: Res; side: string | null; status: string | null; extra?: string }) {
  if (status == null) return <span className="text-slate-400">ไม่มีข้อมูล</span>;
  if (status !== 'OK') return <span className="text-rose-600">{status}</span>;
  if (!bet) return <span className="text-slate-400">ไม่เลือก{extra}</span>;
  return (
    <>
      <p>
        {selectionLabel(bet.market, bet.selection, bet.line, r.home, r.away)} <span className="text-xs text-slate-500">@{bet.odds ?? '-'} · {SIDE[side ?? ''] ?? ''}{extra}</span>
      </p>
      <p className="mt-0.5 flex items-center gap-1.5">
        {res ? <StatusBadge admin status={res.status} /> : <span className="text-xs text-slate-500">รอผล</span>} <span className="text-xs tabular-nums">{u(res?.units ?? null)}</span>
      </p>
    </>
  );
}

/**
 * Shadow only (owner, 2026-11-23): Gemini answers the Hybrid AI v2.1.1 prompt once on exactly the stored input of the
 * day's DAILY Hybrid AI decision; side by side with Decisions v2 and the Hybrid AI (×3) on the same input and prices.
 */
function GeminiCompare({ rows, v2Rows }: { rows: DRow[]; v2Rows: DRow[] }) {
  const v2By = new Map(v2Rows.map((v) => [v.fixture_id, v]));
  const lines = rows.map((r) => {
    const v = v2By.get(r.fixture_id) ?? null;
    const gem = betOf(r.status === 'OK', r.side, r.market, r.selection, r.line, r.odds);
    const v2 = v ? betOf(v.status === 'OK', v.side, v.market, v.selection, v.line, v.odds) : null;
    const ai = betOf(r.ai_status === 'OK', r.ai_side, r.ai_market, r.ai_selection, r.ai_line, r.ai_odds);
    return { r, v, gem, v2, ai, gemRes: result(r, gem), v2Res: result(r, v2), aiRes: result(r, ai) };
  });
  const totals = [
    ['Gemini (×1)', tally(lines.map((l) => ({ res: l.gemRes, bet: l.gem })))],
    ['Decisions v2', tally(lines.map((l) => ({ res: l.v2Res, bet: l.v2 })))],
    ['Hybrid AI (×3)', tally(lines.map((l) => ({ res: l.aiRes, bet: l.ai })))],
  ] as const;
  // both chose the same bet, or both chose none
  const agree = (a: Bet | null, b: Bet | null) => (a && b ? same(a, b) : !a && !b);
  const withAi = lines.filter((l) => l.r.status === 'OK' && l.r.ai_status === 'OK');
  const withV2 = lines.filter((l) => l.r.status === 'OK' && l.v?.status === 'OK');
  const invalid = lines.filter((l) => l.r.status !== 'OK').length;
  const model = rows[0]?.config.split(':')[1] ?? '';
  const tone = (x: string) => (x.startsWith('ตรง') ? 'text-emerald-700' : 'text-amber-700');
  return (
    <Section title="ทดลอง: Gemini Decision (shadow ไม่เผยแพร่)" aside={`${lines.length} คู่ · ${model}`}>
      <p className="mb-3 max-w-3xl text-xs leading-relaxed text-slate-600">
        Gemini ตอบ prompt เดียวกับ Hybrid AI v2.1.1 ครั้งเดียว บน input ชุดเดียวกับรอบ 14:00 (ไม่เห็นคำตอบของ Hybrid) ผ่านตัวตรวจตัวเลขชุดเดิม · ต่างจาก Hybrid แค่ model และจำนวนคำตอบ
        (Hybrid ใช้เสียงข้างมากจาก 3 คำตอบ) · ผลคิดที่ราคาเดียวกับ Hybrid · ตัวอย่างรายวันเล็กเกินจะสรุปว่าแบบไหนดีกว่า
      </p>
      <table className="mb-2 w-full text-sm">
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
          {totals.map(([name, t]) => (
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
      <p className="mb-4 text-xs text-slate-500">
        Gemini ตรงกับ Hybrid {withAi.filter((l) => agree(l.gem, l.ai)).length}/{withAi.length} คู่ · ตรงกับ Decisions v2 {withV2.filter((l) => agree(l.gem, l.v2)).length}/{withV2.length} คู่ (นับการไม่เลือกที่ตรงกันด้วย)
        {invalid ? ` · Gemini ตอบไม่ผ่านตัวตรวจ ${invalid} คู่` : ''}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[920px] text-sm">
          <thead>
            <tr className="text-xs text-slate-500">
              <th className="pb-2 text-left font-normal">คู่</th>
              <th className="pb-2 text-left font-normal">Gemini (×1)</th>
              <th className="pb-2 text-left font-normal">Decisions v2</th>
              <th className="pb-2 text-left font-normal">Hybrid AI (×3)</th>
              <th className="pb-2 font-normal">Gemini เทียบ</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 align-top">
            {lines.map(({ r, v, gem, v2, ai, gemRes, v2Res, aiRes }) => {
              const vsAi = r.status !== 'OK' || r.ai_status !== 'OK' ? '' : agree(gem, ai) ? 'ตรง Hybrid' : 'ต่าง Hybrid';
              const vsV2 = r.status !== 'OK' || v?.status !== 'OK' ? '' : agree(gem, v2) ? 'ตรง v2' : 'ต่าง v2';
              const v2Why = v?.status === 'OK' && !v2 && v.no_pick_reasons?.length ? ` · ${v.no_pick_reasons.map((x) => V2_REASON[x] ?? x).join(', ')}` : '';
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
                    <BetCell r={r} bet={gem} res={gemRes} side={r.side} status={r.status} />
                  </td>
                  <td className="py-2 pr-3">
                    <BetCell r={r} bet={v2} res={v2Res} side={v?.side ?? null} status={v?.status ?? null} extra={v2Why} />
                  </td>
                  <td className="py-2 pr-3">
                    <BetCell r={r} bet={ai} res={aiRes} side={r.ai_side} status={r.ai_status} />
                  </td>
                  <td className="py-2 text-center text-xs">
                    {vsAi ? <p className={tone(vsAi)}>{vsAi}</p> : null}
                    {vsV2 ? <p className={tone(vsV2)}>{vsV2}</p> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
