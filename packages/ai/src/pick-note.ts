/**
 * The Game Compass note (pick_th), the AI half: one or two Thai sentences that explain a published
 * pick from the match facts. Same discipline as the preview: only numbers from the input, only
 * scorelines from the input, no gambling words, no verdict. Bump PICK_NOTE_PROMPT_VERSION on any change.
 */
import { z } from 'zod';
import { allowedNumbers, inventedNumbers } from './guards.js';
import { knownScorelines, PREVIEW_BANNED_WORDS, withoutThousandsSeparators } from './preview.js';

export const PICK_NOTE_PROMPT_VERSION = 'pick-note-ai-v0.2';

/** Kept byte-stable (no dates, no per-request values) so it caches across picks. */
export const PICK_NOTE_SYSTEM_PROMPT = `You are the analyst of a Thai football data & analysis brand. Our model has published one analytical view for a match (the Game Compass, เข็มทิศเกม). You receive the match facts and that view as JSON and write one short Thai note that sits under the view on the match page.

The input:
- pick: the view. label is how the site shows it; winConditions list which 90-minute results make it right (ถูก), half right, a push, half wrong or wrong; modelChance is our model's chance of it being right with half outcomes counted half, marketChance is the combined view of many bookmakers' prices on the same thing; differencePts is the gap; rationale says in which direction the model sees the match differently from the market.
- fixture, home, away, model, market, h2h, data_support: the match facts (form, xG, table, key players, injuries, lineups, the model's numbers).

The page already shows the label in large type and a table of the win conditions right next to your note. So:
- Do NOT repeat the label or the win conditions. Do not start with มุมมองคือ, เข็มทิศเกมเลือก, เข็มทิศเกมชี้ or the label.
- Start straight with where the model sees the match differently from the market, in plain words (use rationale as the idea, in your own words; you may give modelChance and marketChance as whole percentages).
- Then give ONE fact from the input that matters for this view. If the recent facts point the other way (e.g. the side is on a poor run), say so honestly and say the difference comes from the model's numbers over a longer stretch, not from recent form. Never present a fact against the view as if it supported it.

Write pick_th: 1-2 short, plain Thai sentences, at most about 180 characters in all. No semicolons, no technical terms such as จุดเปอร์เซ็นต์ or edge.

Hard rules:
- The view is where the model differs from the market, not the most likely result. Never say the market is wrong (no ตลาดประเมินพลาด, no ตลาดผิด), never say the result will happen, never use ฟันธง or "แน่นอน".
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

/** ~180 characters asked for; the slack keeps a slightly long but clean note from falling back to the template. */
export const pickNoteOutputSchema = z.object({ pick_th: z.string().trim().min(20).max(240) });

/**
 * Saying the market got it wrong is a claim the record does not support (CONTEXT.md: Edge).
 * Semicolons and จุดเปอร์เซ็นต์ marked the stiff v0.1 notes.
 */
const PICK_NOTE_BANNED = [...PREVIEW_BANNED_WORDS, 'ประเมินพลาด', 'ตลาดผิด', 'แน่นอน', 'จุดเปอร์เซ็นต์', ';'] as const;

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
  const t = parsed.data.pick_th;
  const violations: string[] = [];
  for (const w of PICK_NOTE_BANNED) if (t.includes(w)) violations.push(`banned word "${w}"`);
  const label = (input.pick as { label?: string } | undefined)?.label;
  if (RESTATING_OPENINGS.some((o) => t.startsWith(o)) || (label && t.startsWith(label))) violations.push('restates the pick at the start');
  for (const n of inventedNumbers(withoutThousandsSeparators(t), allowedNumbers(input))) violations.push(`number not in input: ${n}`);
  const listed = knownScorelines(input);
  for (const m of t.matchAll(/(?<![\d.])(\d)\s*[-–]\s*(\d)(?![\d.])/g)) {
    const s = `${m[1]}-${m[2]}`;
    if (!listed.has(s)) violations.push(`scoreline not in input: ${s}`);
  }
  const unique = [...new Set(violations)];
  return { ok: unique.length === 0, violations: unique, text: unique.length ? null : t };
}
