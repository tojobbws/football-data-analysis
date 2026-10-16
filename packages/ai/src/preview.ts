/**
 * 🔎 วิเคราะห์เกม — the AI half: prompt, output schema and guards for the per-match preview.
 * The AI writes prose over `PreviewFacts` (packages/analysis/preview.ts); it never produces a
 * number, a scoreline or a verdict the facts do not contain. Bump PREVIEW_PROMPT_VERSION on any
 * change: every stored row records the version that produced it.
 */
import { z } from 'zod';
import type { PreviewText } from '@fp/analysis';
import { allowedNumbers, BANNED_WORDS, inventedNumbers } from './guards.js';

export const PREVIEW_PROMPT_VERSION = 'preview-ai-v0.7';

/** Kept byte-stable (no dates, no per-request values) so it caches across fixtures. */
export const PREVIEW_SYSTEM_PROMPT = `You are the analyst of a Thai football data & analysis brand. You receive one upcoming match as JSON and write a sectioned Thai preview a football fan enjoys reading.

What the input contains, and nothing else exists for you:
- fixture: teams, competition, round, stage (EARLY = before lineups, LINEUP = confirmed XIs), venue, referee
- home / away: recent results (date, competition, opponent, score, xG when available), their totals (formSummary), rest days since the last match, averages of shots on target and possession, the league table (overall, home and away records, goal difference, zone, number of teams; null = no table that means anything yet), key players this season (goals, assists, appearances), injuries (isKeyPlayer marks a key player), confirmed starters and, at LINEUP, formation, coach and key players not in the XI, how much history the model has for the team
- model: our statistical model's 1X2 probabilities, expected goals, the most likely scorelines (null = the model has no numbers for this match)
- market: 1X2 consensus odds (opening -> current), api_prediction: a third-party opinion
- h2h: recent meetings
- data_support: how far the data can carry an opinion (GOOD / LIMITED / THIN) and the reasons, in Thai. These reasons are facts about the input: respect them.

Write (all Thai, short sentences, no headings or bullet characters):
1. overview_th — 2-3 sentences: what this match looks like in the data (table positions, form), where the model, the market and the football facts agree or disagree.
2. home_th — 2-4 sentences on the home team's recent form: results, the latest match, rest days, key players, absences (a missing key player matters most), what to watch.
3. away_th — the same for the away team.
4. attack_th — 1-2 sentences comparing the two attacks (goals, xG, shots on target, key scorers).
5. defence_th — 1-2 sentences comparing the two defences (goals against, xG against, home/away records).
6. h2h_th — 1-2 sentences on the recent meetings; an empty string when h2h is empty.
7. key_factor_th — 1-2 sentences on what could decide the match, as conditions drawn from the facts ("if ... then ..."): an early goal, a missing key player, tired legs after few rest days, home strength. No new numbers.
8. score_th — 1-2 sentences led by the model's expected goals (how open or tight the match looks in the numbers), then at most a passing mention of the most likely scoreline as one of many possible scores, and how confident the data lets you be. When data_support is LIMITED or THIN, say plainly in this field that the data is limited and why (use the given reason), e.g. a cup across leagues with few comparable matches.
9. summary_th — one sentence that sums the match up in the data, for the end of the page.

You do not need to use every fact: pick what makes this match interesting.

Hard rules:
- Never create a probability, percentage, odds value, xG, goal count, rank, points, day count or any other number. You may only repeat numbers that appear in the input (a probability like 0.634 may be written as 63%). Each section may only use numbers from the part of the input it is about: a team's section only that team's numbers, h2h_th only h2h. If you are unsure whether a number is in the input, leave it out.
- Scorelines are the model's, not yours: only quote scorelines listed in model.scorelines, past results in form and h2h. The first model scoreline is the single most likely score (สกอร์ที่เป็นไปได้มากที่สุด), one of many possible scores: never present it as a prediction of the result (no "คาดว่าจะจบ", no "สกอร์คาดการณ์").
- Never name a winner or call the result: no ฟันธง, no "X ชนะแน่". The site has one analytical view per match and it is not this text.
- Do not write dates, kickoff times, player names or results that are not in the input. Use only facts present in the input; no outside knowledge about these teams, players, coaches or referees. The table zone is the data provider's English label: you may say it in Thai (e.g. โซนลุ้นแชมเปียนส์ลีก), never add to it.
- When model is null, say the model has no numbers for this match and base the text on the football facts only.
- Missing pieces that are not in data_support (no injuries listed, no h2h, no market, no venue): simply leave that topic out. Do not point out that it is missing, and never infer from an empty injury list that a squad is complete.
- This is data analysis, not gambling advice. Never use these words: ทีเด็ด, แทง, แทงบอล, กำไร, ตามคู่นี้, การันตี, ฟันธง. Prefer: ข้อมูล, สัญญาณ, โมเดล, ความน่าจะเป็น, ตลาด.
- Tone: clear, grounded, a little lively; honest about uncertainty; not a research paper.`;

/** The shared list plus ฟันธง: the preview must never call the result (the shadow ranking's list stays frozen for its trial). */
export const PREVIEW_BANNED_WORDS = [...BANNED_WORDS, 'ฟันธง'] as const;

const TEXT_FIELDS = ['overview_th', 'home_th', 'away_th', 'attack_th', 'defence_th', 'h2h_th', 'key_factor_th', 'score_th', 'summary_th'] as const;

export const PREVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(TEXT_FIELDS.map((k) => [k, { type: 'string' }])),
  required: [...TEXT_FIELDS],
  additionalProperties: false,
} as const;

export const previewOutputSchema = z.object({
  overview_th: z.string().trim().min(20).max(1000),
  home_th: z.string().trim().min(10).max(1000),
  away_th: z.string().trim().min(10).max(1000),
  attack_th: z.string().trim().min(10).max(600),
  defence_th: z.string().trim().min(10).max(600),
  // empty = no meetings to write about
  h2h_th: z.string().trim().max(600).transform((s) => s || null),
  key_factor_th: z.string().trim().min(10).max(600),
  score_th: z.string().trim().min(10).max(600),
  summary_th: z.string().trim().min(10).max(300),
});

export interface ValidatedPreview {
  ok: boolean;
  violations: string[];
  text: PreviewText | null;
}

/**
 * The part of the input each field may take its numbers from: a team's section never quotes the
 * other team's figures, h2h_th only the meetings. The fixture (team names such as "1899 Hoffenheim")
 * is always allowed. Sections that compare or sum up (overview, attack, defence, key factor,
 * summary) may use both teams.
 */
function numberSources(field: (typeof TEXT_FIELDS)[number], input: Record<string, unknown>): unknown {
  const { fixture, home, away, model, market, h2h, data_support } = input;
  switch (field) {
    case 'home_th':
      return { fixture, home, model, market, data_support };
    case 'away_th':
      return { fixture, away, model, market, data_support };
    case 'attack_th':
    case 'defence_th':
      return { fixture, home, away, model };
    case 'h2h_th':
      return { fixture, h2h };
    case 'score_th':
      return { fixture, model, market, data_support };
    default:
      return input;
  }
}

/**
 * Same discipline as the shadow ranking: every number in the Thai text must trace back to its part
 * of the input, scorelines must be the model's or past results, banned words are rejected. A failure
 * never loses the match — the job stores the template text instead and keeps the violations for review.
 */
export function validatePreviewOutput(raw: unknown, input: Record<string, unknown>): ValidatedPreview {
  const parsed = previewOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, violations: [`schema: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`], text: null };
  }
  const out = parsed.data;
  const violations: string[] = [];
  const listed = knownScorelines(input);
  for (const field of TEXT_FIELDS) {
    const t = out[field];
    if (!t) continue;
    for (const w of PREVIEW_BANNED_WORDS) if (t.includes(w)) violations.push(`banned word "${w}"`);
    for (const n of inventedNumbers(withoutThousandsSeparators(t), allowedNumbers(numberSources(field, input)))) violations.push(`${field}: number not in input: ${n}`);
    for (const m of t.matchAll(/(?<![\d.])(\d)\s*[-–]\s*(\d)(?![\d.])/g)) {
      const s = `${m[1]}-${m[2]}`;
      // "2-1" style scorelines must be the model's or a result in the input; W-D-L counts like "ชนะ 3 เสมอ 1" don't match this shape
      if (!listed.has(s)) violations.push(`scoreline not in input: ${s}`);
    }
  }

  const unique = [...new Set(violations)];
  return { ok: unique.length === 0, violations: unique, text: unique.length ? null : out };
}

/**
 * "1,356" is one thousand three hundred and fifty-six, not 1.356: the number guard reads a comma as a
 * decimal point (Thai text writes neither often), so a count the AI wrote with a separator was rejected
 * (Kyoto Sanga, 2026-10-16). Only a comma followed by exactly three digits is a separator. The shadow
 * ranking keeps the plain guard: it stays frozen for its trial.
 */
export function withoutThousandsSeparators(text: string): string {
  return text.replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
}

/** Scorelines the text may quote: the model's, H2H results, and each team's recent results (either order). */
export function knownScorelines(input: Record<string, unknown>): Set<string> {
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
