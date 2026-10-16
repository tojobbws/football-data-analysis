/**
 * The Game Compass note (pick_th), the deterministic half: the facts about one published pick that
 * the AI explains, and the template text used when the AI is unavailable or fails the guards.
 * Every number comes from the pick itself; the AI never computes one.
 */
import type { MarketSelection, Outcome } from './settlement.js';
import { pickRationale, winCondition } from './win-condition.js';
import { selectionLabel } from './publish.js';

export const PICK_NOTE_VERSION = 'pick-note-v0.2';

export const OUTCOME_TH: Record<Outcome, string> = {
  WIN: 'ถูก',
  HALF_WIN: 'ถูกครึ่ง',
  PUSH: 'เสมอตัว',
  HALF_LOSS: 'ผิดครึ่ง',
  LOSS: 'ผิด',
};

export interface PickNoteFacts {
  round: string;
  market: 'ASIAN_HANDICAP' | 'OVER_UNDER' | 'MATCH_WINNER';
  /** a team name, or OVER / UNDER, or DRAW */
  side: string;
  line: number | null;
  /** as the compass card shows it, e.g. "Egnatia Rrogozhinë +1.75" */
  label: string;
  /** the model's fair chance of the pick being right (half outcomes count half) */
  modelChance: number;
  /** the market's fair chance of the same */
  marketChance: number;
  /** modelChance − marketChance, in percentage points */
  differencePts: number;
  strength: string | null;
  /** which way the model sees it differently, in Thai */
  rationale: string;
  /** "Egnatia Rrogozhinë ชนะ เสมอ หรือแพ้ 1 ลูก → ถูก" */
  winConditions: string[];
}

export interface PublishedPick {
  publishRound: string;
  market: string | null;
  selection: string | null;
  line: number | null;
  modelProbability: number | null;
  marketProbability: number | null;
  signalStrength: string | null;
}

function toSelection(market: string | null, selection: string | null, line: number | null): MarketSelection | null {
  if (market === 'MATCH_WINNER' && (selection === 'HOME' || selection === 'DRAW' || selection === 'AWAY')) return { market, selection };
  if (line == null) return null;
  if (market === 'ASIAN_HANDICAP' && (selection === 'HOME' || selection === 'AWAY')) return { market, selection, line };
  if (market === 'OVER_UNDER' && (selection === 'OVER' || selection === 'UNDER')) return { market, selection, line };
  return null;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

/** The facts of a published pick; null for fog or a pick without both chances. */
export function pickNoteFacts(p: PublishedPick, home: string, away: string): PickNoteFacts | null {
  const sel = toSelection(p.market, p.selection, p.line);
  if (!sel || p.modelProbability == null || p.marketProbability == null) return null;
  const side = sel.selection === 'HOME' ? home : sel.selection === 'AWAY' ? away : sel.selection;
  return {
    round: p.publishRound,
    market: sel.market,
    side,
    line: 'line' in sel ? sel.line : null,
    label: selectionLabel(sel.market, sel.selection, 'line' in sel ? sel.line : null, home, away),
    modelChance: r4(p.modelProbability),
    marketChance: r4(p.marketProbability),
    differencePts: r1((p.modelProbability - p.marketProbability) * 100),
    strength: p.signalStrength,
    rationale: pickRationale(sel, home, away),
    winConditions: winCondition(sel, home, away).map((r) => `${r.when} → ${OUTCOME_TH[r.outcome]}`),
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Fallback note: the direction of the difference and both chances; the label is right above it on the card. */
export function pickNoteTemplate(f: PickNoteFacts): string {
  return `${f.rationale} โมเดลให้โอกาสถูก ${pct(f.modelChance)} ขณะที่ตลาดให้ ${pct(f.marketChance)}`;
}
