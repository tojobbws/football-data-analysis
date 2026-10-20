/**
 * The Game Compass note (pick_th), the AI half: one or two Thai sentences that explain a published
 * pick from the match facts. Same discipline as the preview: only numbers from the input, only
 * scorelines from the input, no gambling words, no verdict. Bump PICK_NOTE_PROMPT_VERSION on any change.
 */
import { z } from 'zod';
import { allowedNumbers, inventedNumbers } from './guards.js';
import { knownScorelines, PREVIEW_BANNED_WORDS, withoutThousandsSeparators } from './preview.js';

export const PICK_NOTE_PROMPT_VERSION = 'pick-note-ai-v0.3';

/** Kept byte-stable (no dates, no per-request values) so it caches across picks. */
export const PICK_NOTE_SYSTEM_PROMPT = `You are the analyst of a Thai football data & analysis brand. Our rules engine has published one analytical view for a match (the Game Compass, เข็มทิศเกม). You receive the match facts and that view as JSON and write one short Thai note that sits under the view on the match page. You explain the view; you never choose, change or second-guess it.

The input:
- pick: the view. label is how the site shows it; winConditions list which 90-minute results make it right (ถูก), half right, a push, half wrong or wrong; modelChance is our model's chance of it being right with half outcomes counted half, marketChance is the combined view of many bookmakers' prices on the same thing; differencePts is the gap; rationale says in which direction the model sees the match differently from the market.
- fixture, home, away, model, market, views, h2h, data_support: the match facts (form, xG, table, key players, injuries, lineups, the model's numbers, which way each source leans).

The page shows the label in large type and a table of the win conditions right next to your note. So:
- Do not start with มุมมองคือ, เข็มทิศเกมเลือก, เข็มทิศเกมชี้ or the label.
- Start with what the view needs, in plain words taken from winConditions (e.g. "ต้องชนะตั้งแต่ 3 ลูก"), and the gap: the model gives it modelChance, the market marketChance, as whole percentages. Never use a vaguer phrase such as ชนะขาด instead of the real condition.
- Then one or two facts from the input that bear on this view. If the recent facts point the other way (views.disagreements, a poor run, a missing key player), say so honestly and say the difference comes from the model's numbers over a longer stretch, not from recent form. Never present a fact against the view as if it supported it, and never pick out a single result (one big win) as if it were the pattern.
- End with the main risk or limit for this view in a few words (data_support, a disagreement, the margin it needs).

Write pick_th: 2-3 short, plain Thai sentences, at most about 300 characters in all. Separate sentences with a space: no full stops, no semicolons. No technical terms such as จุดเปอร์เซ็นต์ or edge. Outcomes are ถูก, ถูกครึ่ง, เสมอตัว, ผิดครึ่ง, ผิด: never betting words such as คืนทุน, ได้เงิน or เสียเงิน.

Hard rules:
- The view is where the model differs from the market, not the most likely result. Never say the market is wrong (no ตลาดประเมินพลาด, no ตลาดผิด), never say the result will happen, never use ฟันธง or "แน่นอน".
- A percentage may only be modelChance or marketChance. The model's 1X2 chances (model.p) are the chance of a result, not of this view: never quote them here.
- Mention no other market, line or side than the view's own.
- Never create a number. Only repeat numbers in the input (0.815 may be written as 81%). If unsure, leave the number out.
- Only facts from the input: no outside knowledge about these teams or players. Do not write scorelines other than the model's or past results in the input.
- Write team and player names exactly as they appear in the input (the page shows them that way); never transliterate them into Thai.
- This is data analysis, not gambling advice. Never use these words: ทีเด็ด, แทง, แทงบอล, กำไร, ตามคู่นี้, การันตี, ฟันธง. Do not mention odds or prices.
- Tone: clear and grounded, honest that it is one view among many possible results.`;

export const PICK_NOTE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: { pick_th: { type: 'string' } },
  required: ['pick_th'],
  additionalProperties: false,
} as const;

/** ~300 characters asked for; the slack keeps a slightly long but clean note from falling back to the template. */
export const pickNoteOutputSchema = z.object({ pick_th: z.string().trim().min(20).max(380) });

/**
 * Saying the market got it wrong is a claim the record does not support (CONTEXT.md: Edge).
 * Semicolons and จุดเปอร์เซ็นต์ marked the stiff v0.1 notes. ชนะขาด stood in for "wins by 3 or
 * more" on Liverpool -2.5 (v0.2): the note names the real condition instead.
 */
const PICK_NOTE_BANNED = [...PREVIEW_BANNED_WORDS, 'ประเมินพลาด', 'ตลาดผิด', 'แน่นอน', 'จุดเปอร์เซ็นต์', 'ชนะขาด', 'คืนทุน', 'ได้เงิน', 'เสียเงิน'] as const;
/** "ความไม่แน่นอน" (uncertainty) is the honest word, not the banned "แน่นอน" */
const UNCERTAIN = /ไม่แน่นอน/g;

/** The card shows the label right above the note: an opening that restates it is noise (v0.1: "มุมมองคือ X: ..."). */
const RESTATING_OPENINGS = ['มุมมองคือ', 'เข็มทิศเกมเลือก', 'เข็มทิศเกมชี้'];

export interface ValidatedPickNote {
  ok: boolean;
  violations: string[];
  text: string | null;
}

export function validatePickNote(raw: unknown, input: Record<string, unknown>): ValidatedPickNote {
  const parsed = pickNoteOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, violations: [`schema: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`], text: null };
  }
  // a stray semicolon (the stiff v0.1 mark) is turned into a space, as in the preview, not worth a retry
  const t = parsed.data.pick_th.replace(/\s*;\s*/g, ' ');
  const violations: string[] = [];
  const unhedged = t.replace(UNCERTAIN, '');
  for (const w of PICK_NOTE_BANNED) if (unhedged.includes(w)) violations.push(`banned word "${w}"`);
  const pick = (input.pick ?? {}) as { label?: string; market?: string; line?: number | null; modelChance?: number; marketChance?: number };
  if (RESTATING_OPENINGS.some((o) => t.startsWith(o)) || (pick.label && t.startsWith(pick.label))) violations.push('restates the pick at the start');
  const plain = withoutThousandsSeparators(t);
  for (const n of inventedNumbers(plain, allowedNumbers(input))) violations.push(`number not in input: ${n}`);
  // a percentage is the pick's own chance: 80% (Liverpool to win) is not the chance of Liverpool -2.5
  const chances = [pick.modelChance, pick.marketChance].filter((x): x is number => typeof x === 'number').map((x) => x * 100);
  for (const m of plain.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)) {
    if (!chances.some((c) => Math.abs(c - Number(m[1]!.replace(',', '.'))) <= 0.51)) violations.push(`percent is not the pick's chance: ${m[1]}%`);
  }
  for (const v of otherMarket(t, pick)) violations.push(v);
  const listed = knownScorelines(input);
  for (const m of t.matchAll(/(?<![\d.])(\d)\s*[-–]\s*(\d)(?![\d.])/g)) {
    const s = `${m[1]}-${m[2]}`;
    if (!listed.has(s)) violations.push(`scoreline not in input: ${s}`);
  }
  const unique = [...new Set(violations)];
  return { ok: unique.length === 0, violations: unique, text: unique.length ? null : t };
}

/** A handicap note that talks over/under, a totals note that talks handicap, or a line that is not the pick's. */
function otherMarket(t: string, pick: { market?: string; line?: number | null }): string[] {
  const out: string[] = [];
  if (pick.market === 'ASIAN_HANDICAP' && /\b(over|under)\b|สูง\/ต่ำ|โอเวอร์|อันเดอร์/i.test(t)) out.push('mentions over/under on a handicap view');
  if (pick.market === 'OVER_UNDER' && /แฮนดิแคป|\bhandicap\b/i.test(t)) out.push('mentions a handicap on an over/under view');
  // "+0.75" / "-2.5": a signed line in the note must be the pick's own (either sign: the other side's view of it)
  for (const m of t.matchAll(/(?<![\d.])[+-]\s?(\d+(?:\.\d+)?)/g)) {
    if (pick.line == null || Math.abs(Number(m[1]) - Math.abs(pick.line)) > 1e-9) out.push(`line not the pick's: ${m[0].replace(/\s/, '')}`);
  }
  return out;
}
