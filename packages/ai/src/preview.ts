/**
 * 🔎 วิเคราะห์เกม — the AI half: prompt, output schema and guards for the per-match preview.
 * The AI writes prose over `PreviewFacts` (packages/analysis/preview.ts); it never produces a
 * number, a scoreline or a verdict the facts do not contain. Bump PREVIEW_PROMPT_VERSION on any
 * change: every stored row records the version that produced it.
 */
import { z } from 'zod';
import type { PreviewText } from '@fp/analysis';
import { allowedNumbers, BANNED_WORDS, inventedNumbers } from './guards.js';

export const PREVIEW_PROMPT_VERSION = 'preview-ai-v0.4';

/** Kept byte-stable (no dates, no per-request values) so it caches across fixtures. */
export const PREVIEW_SYSTEM_PROMPT = `You are the analyst of a Thai football data & analysis brand. You receive one upcoming match as JSON and write a short Thai preview a football fan enjoys reading.

What the input contains, and nothing else exists for you:
- fixture: teams, competition, round, stage (EARLY = before lineups, LINEUP = confirmed XIs)
- home / away: last 5 results (with xG when available), league standing, injuries, confirmed starters, how much history the model has for the team
- model: our statistical model's 1X2 probabilities, expected goals, the most likely scorelines (null = the model has no numbers for this match)
- market: 1X2 consensus odds (opening -> current), api_prediction: a third-party opinion
- h2h: recent meetings
- data_support: how far the data can carry an opinion (GOOD / LIMITED / THIN) and the reasons, in Thai. These reasons are facts about the input: respect them.

Write (all Thai, short sentences, no headings or bullet characters):
1. overview_th — 2-4 sentences: what this match looks like in the data, where the model, the market and the football facts agree or disagree.
2. home_th — 2-3 sentences on the home team: form, attack/defence from the numbers, absences, what to watch.
3. away_th — the same for the away team.
4. score_th — 1-2 sentences about the model's most likely scorelines and expected goals, and how confident the data lets you be. When data_support is LIMITED or THIN, say plainly in this field that the data is limited and why (use the given reason), e.g. a cup across leagues with few comparable matches.

Hard rules:
- Never create a probability, percentage, odds value, xG, goal count, rank, points or any other number. You may only repeat numbers that appear in the input (a probability like 0.634 may be written as 63%). If you are unsure whether a number is in the input, leave it out.
- Scorelines are the model's, not yours: only quote scorelines listed in model.scorelines. The first one is the single most likely score (สกอร์ที่เป็นไปได้มากที่สุด), one of many possible scores: never present it as a prediction of the result (no "คาดว่าจะจบ", no "สกอร์คาดการณ์").
- Do not write dates, kickoff times, player names or results that are not in the input. Use only facts present in the input; no outside knowledge about these teams or players.
- When model is null, say the model has no numbers for this match and base the text on the football facts only.
- This is data analysis, not gambling advice. Never use these words: ทีเด็ด, แทง, แทงบอล, กำไร, ตามคู่นี้, การันตี. Prefer: ข้อมูล, สัญญาณ, โมเดล, ความน่าจะเป็น, ตลาด.
- Tone: clear, grounded, a little lively; honest about uncertainty; not a research paper.`;

export const PREVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    overview_th: { type: 'string' },
    home_th: { type: 'string' },
    away_th: { type: 'string' },
    score_th: { type: 'string' },
  },
  required: ['overview_th', 'home_th', 'away_th', 'score_th'],
  additionalProperties: false,
} as const;

export const previewOutputSchema = z.object({
  overview_th: z.string().trim().min(20).max(1200),
  home_th: z.string().trim().min(10).max(800),
  away_th: z.string().trim().min(10).max(800),
  score_th: z.string().trim().min(10).max(600),
});

export interface ValidatedPreview {
  ok: boolean;
  violations: string[];
  text: PreviewText | null;
}

/**
 * Same discipline as the shadow ranking: every number in the Thai text must trace back to the
 * input, scorelines must be the model's, banned words are rejected. A failure never loses the
 * match — the job stores the template text instead and keeps the violations for review.
 */
export function validatePreviewOutput(raw: unknown, input: Record<string, unknown>): ValidatedPreview {
  const parsed = previewOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, violations: [`schema: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`], text: null };
  }
  const out = parsed.data;
  const violations: string[] = [];
  const texts = [out.overview_th, out.home_th, out.away_th, out.score_th];
  for (const t of texts) for (const w of BANNED_WORDS) if (t.includes(w)) violations.push(`banned word "${w}"`);

  const allowed = allowedNumbers(input);
  for (const t of texts) for (const n of inventedNumbers(t, allowed)) violations.push(`number not in input: ${n}`);

  const listed = knownScorelines(input);
  for (const t of texts) {
    for (const m of t.matchAll(/(?<![\d.])(\d)\s*[-–]\s*(\d)(?![\d.])/g)) {
      const s = `${m[1]}-${m[2]}`;
      // "2-1" style scorelines must be the model's or a result in the input; W-D-L counts like "ชนะ 3 เสมอ 1" don't match this shape
      if (!listed.has(s)) violations.push(`scoreline not in input: ${s}`);
    }
  }

  const unique = [...new Set(violations)];
  return { ok: unique.length === 0, violations: unique, text: unique.length ? null : out };
}

/** Scorelines the text may quote: the model's, H2H results, and each team's recent results (either order). */
function knownScorelines(input: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const both = (a: unknown, b: unknown) => {
    if (a == null || b == null) return;
    out.add(`${a}-${b}`);
    out.add(`${b}-${a}`);
  };
  const model = (input.model ?? null) as { scorelines?: Array<{ home: number; away: number }> } | null;
  for (const s of model?.scorelines ?? []) both(s.home, s.away);
  for (const h of (input.h2h ?? []) as Array<{ homeGoals?: number; awayGoals?: number }>) both(h.homeGoals, h.awayGoals);
  for (const side of ['home', 'away'] as const) {
    const form = ((input[side] as { form?: Array<{ goalsFor?: number; goalsAgainst?: number }> } | undefined)?.form ?? []);
    for (const r of form) both(r.goalsFor, r.goalsAgainst);
  }
  return out;
}
