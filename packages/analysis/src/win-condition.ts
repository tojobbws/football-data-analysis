/**
 * Win condition: the plain-language list of 90-minute results that lead to each outcome of a pick
 * ("Bremen แพ้ 2 ลูกพอดี → เสมอตัว"). Built from `settle`, so it can never disagree with settlement.
 */
import { settle, type MarketSelection, type Outcome } from './settlement.js';

export interface WinConditionRow {
  /** match results, e.g. "Bremen ชนะ เสมอ หรือแพ้ 1 ลูก" */
  when: string;
  outcome: Outcome;
}

const ORDER: Outcome[] = ['WIN', 'HALF_WIN', 'PUSH', 'HALF_LOSS', 'LOSS'];
// margins/totals beyond this behave like the edge value for every line we publish
const SPAN = 12;

interface Range {
  lo: number | null; // null = unbounded
  hi: number | null;
  outcome: Outcome;
}

/** Group consecutive values of `xs` that settle the same way. */
function ranges(xs: number[], outcome: (x: number) => Outcome): Range[] {
  const out: Range[] = [];
  for (const x of xs) {
    const o = outcome(x);
    const last = out.at(-1);
    if (last && last.outcome === o) last.hi = x;
    else out.push({ lo: x, hi: x, outcome: o });
  }
  // the edges stand for "and beyond" (total goals start at a real 0)
  if (xs[0]! < 0) out[0]!.lo = null;
  out.at(-1)!.hi = null;
  return out;
}

const goals = (n: number) => `${n} ลูก${n >= 2 ? 'พอดี' : ''}`;

/** Selected team's goal margin m (team − opponent) as words. */
function marginText(r: Range, team: string): string {
  const { lo, hi } = r;
  if (lo === hi) return lo === 0 ? 'เสมอ' : lo! > 0 ? `${team} ชนะ ${goals(lo!)}` : `${team} แพ้ ${goals(-lo!)}`;
  if (hi === null) {
    if (lo! > 0) return lo === 1 ? `${team} ชนะ` : `${team} ชนะ ${lo} ลูกขึ้นไป`;
    if (lo === 0) return `${team} ชนะ หรือเสมอ`;
    return `${team} ชนะ เสมอ หรือแพ้${lo === -1 ? ' 1 ลูก' : `ไม่เกิน ${-lo!} ลูก`}`;
  }
  if (lo === null) {
    if (hi < 0) return hi === -1 ? `${team} แพ้` : `${team} แพ้ ${-hi} ลูกขึ้นไป`;
    if (hi === 0) return `เสมอ หรือ ${team} แพ้`;
    return `${team} แพ้ เสมอ หรือชนะ${hi === 1 ? ' 1 ลูก' : `ไม่เกิน ${hi} ลูก`}`;
  }
  // a bounded band (not produced by single or quarter lines, kept for completeness)
  const side = (m: number) => (m > 0 ? `ชนะ ${m}` : m < 0 ? `แพ้ ${-m}` : 'เสมอ');
  return `${team} ${side(lo!)} ถึง ${side(hi)} ลูก`;
}

/** Total goals t as words. */
function totalText(r: Range): string {
  const { lo, hi } = r;
  if (lo === hi) return lo === 0 ? 'ไม่มีประตู' : `รวม ${lo} ลูก`;
  if (hi === null) return `รวม ${lo} ลูกขึ้นไป`;
  if (lo === 0) return hi === 0 ? 'ไม่มีประตู' : `รวม ${hi} ลูกหรือน้อยกว่า`;
  return `รวม ${lo}–${hi} ลูก`;
}

/**
 * Why a pick exists, in one sentence: every pick is the model disagreeing with the market, so say in
 * which direction. Keeps an underdog pick from reading as "we think they win".
 */
export function pickRationale(sel: MarketSelection, home: string, away: string): string {
  if (sel.market === 'OVER_UNDER') return `โมเดลมองว่าเกมนี้จะมีประตู${sel.selection === 'OVER' ? 'มาก' : 'น้อย'}กว่าที่ตลาดคาด`;
  if (sel.market === 'MATCH_WINNER') {
    if (sel.selection === 'DRAW') return 'โมเดลให้โอกาสเสมอมากกว่าที่ตลาดคาด';
    return `โมเดลให้โอกาส ${sel.selection === 'HOME' ? home : away} ชนะมากกว่าที่ตลาดคาด`;
  }
  const team = sel.selection === 'HOME' ? home : away;
  const opponent = sel.selection === 'HOME' ? away : home;
  if (sel.line < 0) return `โมเดลมองว่า ${team} จะชนะห่างมากกว่าที่ตลาดคาด`;
  if (sel.line === 0) return `โมเดลมองว่า ${team} มีโอกาสชนะมากกว่าที่ตลาดคาด (เสมอ = เสมอตัว)`;
  if (sel.line < 1) return `โมเดลมองว่า ${team} มีโอกาสไม่แพ้มากกว่าที่ตลาดคาด`;
  return `${opponent} อาจชนะ แต่โมเดลมองว่าจะชนะห่างน้อยกว่าที่ตลาดคาด`;
}

/** Rows ordered from the best outcome for the pick to the worst; impossible outcomes are left out. */
export function winCondition(sel: MarketSelection, home: string, away: string): WinConditionRow[] {
  let rows: WinConditionRow[];
  if (sel.market === 'MATCH_WINNER' && sel.selection === 'DRAW') {
    rows = [
      { when: 'เสมอ', outcome: 'WIN' },
      { when: 'ทีมใดทีมหนึ่งชนะ', outcome: 'LOSS' },
    ];
  } else if (sel.market === 'OVER_UNDER') {
    const ts = Array.from({ length: SPAN + 1 }, (_, i) => i);
    rows = ranges(ts, (t) => settle(sel, t, 0)).map((r) => ({ when: totalText(r), outcome: r.outcome }));
  } else {
    const team = sel.selection === 'HOME' ? home : away;
    const ms = Array.from({ length: 2 * SPAN + 1 }, (_, i) => i - SPAN);
    // margin m of the selected team, as a home-side score for `settle`
    const byMargin = (m: number) => (sel.selection === 'HOME' ? settle(sel, Math.max(m, 0), Math.max(-m, 0)) : settle(sel, Math.max(-m, 0), Math.max(m, 0)));
    rows = ranges(ms, byMargin).map((r) => ({ when: marginText(r, team), outcome: r.outcome }));
  }
  return rows.sort((a, b) => ORDER.indexOf(a.outcome) - ORDER.indexOf(b.outcome));
}
