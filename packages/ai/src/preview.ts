/**
 * วิเคราะห์เกม, the AI half: prompt, output schema and guards for the per-match preview.
 * The AI writes prose over `PreviewFacts` (packages/analysis/preview.ts); it never produces a
 * number, a scoreline or a verdict the facts do not contain. Bump PREVIEW_PROMPT_VERSION on any
 * change: every stored row records the version that produced it.
 */
import { z } from 'zod';
import type { PreviewText } from '@fp/analysis';
import { allowedNumbers, BANNED_WORDS, inventedNumbers } from './guards.js';

export const PREVIEW_PROMPT_VERSION = 'preview-ai-v0.9';

/** Kept byte-stable (no dates, no per-request values) so it caches across fixtures. */
export const PREVIEW_SYSTEM_PROMPT = `You are the analyst of a Thai football data & analysis brand. You receive one upcoming match as JSON and write a short Thai preview that an ordinary fan understands in 30 seconds, like an analyst explaining the match to a friend.

What the input contains, and nothing else exists for you:
- fixture: teams, competition, round, stage (EARLY = lineups not out yet, LINEUP = both XIs confirmed), venue, referee
- home / away: recent results (date, competition, opponent, score, xG when available), their totals (formSummary), rest days, averages of shots on target and possession, the league table (null = no table that means anything yet), key players this season (top scorers and assisters only), injuries (isKeyPlayer marks one of those key players; other absent players may still matter, you just cannot tell from the data), confirmed starters and, at LINEUP, formation, coach and key players not in the XI, modelMatches (a time-weighted amount of history the model rates the team on; never quote it as a number of matches)
- model: our statistical model. p = its chance of a home win, a draw and an away win. expectedGoals = the goals it expects each side to score. scorelines = the single scores it rates most likely, with their chances. null = the model has no numbers for this match.
- market: 1X2 consensus odds (opening -> current). views.marketP is the same market as chances with the bookmakers' margin taken out: use those, never the odds.
- views: which way each source leans (a team name, or EVEN): model, market, recentForm (points over the recent results), recentXg, otherModel (a second rating model). disagreements lists where a source points away from the model: MARKET (the market favours the other side), MARKET_GAP (same side, but the market gives it a much smaller chance), FORM, XG, OTHER_MODEL.
- apiPrediction: a third-party opinion. h2h: recent meetings.
- data_support: how far the data can carry an opinion (GOOD / LIMITED / THIN) and the reasons, in Thai. These are facts about the input: respect them.

Write five fields (all Thai, no headings, no bullet characters, no markdown):
1. overview_th, 2-3 sentences: how the match looks and which side has the edge, saying which data the edge comes from (the model, the market, the table, recent form). Name both teams. If views.disagreements is not empty, say plainly which source points elsewhere and keep both sides of it: for MARKET or MARKET_GAP, say the market (ตลาด) sees it closer or the other way, with its chance from views.marketP; for FORM or XG, say recent form or xG points the other way and that the model rates the teams on a longer stretch of matches than the last five; for OTHER_MODEL, say the model's view is not settled. Never quote only the numbers that support one side.
2. home_th, 2-3 sentences on the home team: one strength and one worry, each backed by this team's own facts. Pick only what explains this match: recent form, xG and chances created, attack or defence, a missing key player, the confirmed XI (LINEUP only), the home or away record or rest days when they show something. Name the team.
3. away_th: the same for the away team.
4. score_th, 2-3 sentences on the model's numbers: start with the expected goals (how open or tight the match looks), then the most likely scoreline as one of many possible scores with its chance, and how it fits the overview. Keep the three kinds of number apart: a 1X2 chance is the chance of a result, expected goals are goals, a scoreline's chance is the chance of that exact score. Never present one as another, and never turn expected goals into a chance of a goal count.
5. uncertainty_th, 0-2 sentences: what in the facts could change the picture for this match (a missing key player, a disagreement from views, a gap in rest days). The page lists the data_support reasons right under this field, so do not repeat them here. An empty string when the facts name nothing else specific. No stock lines such as "the first goal will matter".

Style: short spoken sentences, no officialese, no research-paper tone. Thai punctuation: separate sentences with a space, no full stops, no semicolons. Write chances as whole percentages (80%, not 80.3%). Explain a technical term once where it first appears (xG คือค่าประเมินคุณภาพของโอกาสยิง). Use only the few numbers that explain the match, at most three or four in a section. Say each point once: what one section says, another does not repeat. Keep what the data shows (results, table, injuries) apart from what it suggests (how the match may go). Not every match needs a firm conclusion: when the data is thin or the sources disagree, say the picture is open. Aim for 900-1,400 Thai characters in all, fewer when the data is limited; never pad to reach a length.

Names: write team and player names exactly as they appear in the input, in the same script. Never transliterate them into Thai.

Hard rules:
- Never create a probability, percentage, odds value, xG, goal count, rank, points, day count or any other number. Only repeat numbers that appear in the input (a probability like 0.634 may be written as 63%). A team section may only use that team's numbers. A percentage must be one of: model.p, a scoreline chance, views.marketP, apiPrediction, possession. If you are unsure whether a number is in the input, leave it out.
- Scorelines are the model's, not yours: only quote scorelines listed in model.scorelines and past results in form and h2h; in score_th only model.scorelines. Never present the most likely scoreline as the expected result (no คาดว่าจะจบ, no สกอร์คาดการณ์).
- Never name a winner or call the result: no ฟันธง, no ชนะแน่, no ผลแน่นอน. The site's one analytical view of the match (the Game Compass) is explained elsewhere on the page: do not mention handicaps, over/under, lines, odds or prices.
- Do not claim one fact causes another unless the input states both and the link is direct. A stronger team is not the same as a team that will win by a margin.
- Do not write dates, kickoff times, player names, injuries or results that are not in the input. No outside knowledge about these teams, players, coaches or referees. The table zone is the provider's English label: you may say it in Thai, never add to it.
- At stage EARLY the lineups are not out: do not write about starters or a lineup (ตัวจริง, ไลน์อัพ) except to say they are not announced yet, and never say a team is at full strength. Never infer from an empty injury list that a squad is complete (no เต็มทีม, no ครบทีม).
- When model is null, say the model has no numbers for this match and write from the football facts only. When data_support is THIN, make no strong claims (no ได้เปรียบชัด, no เหนือกว่าชัด).
- Missing pieces that are not in data_support (no injuries listed, no h2h, no market, no venue): leave that topic out without pointing out that it is missing.
- This is data analysis, not gambling advice. Never use these words: ทีเด็ด, แทง, แทงบอล, กำไร, ตามคู่นี้, การันตี, ฟันธง, ชัวร์, กินเต็ม. Never guarantee or promise an outcome.`;

/** The shared list plus ฟันธง: the preview must never call the result (the shadow ranking's list stays frozen for its trial). */
export const PREVIEW_BANNED_WORDS = [...BANNED_WORDS, 'ฟันธง', 'ชัวร์', 'กินเต็ม'] as const;

/**
 * preview-ai-v0.9: the pick's markets are left to the Game Compass note, a scoreline is never the
 * result, and an empty injury list is never a full squad.
 */
const PREVIEW_V09_BANNED = ['แฮนดิแคป', 'ราคาต่อรอง', 'ค่าน้ำ', 'ราคาน้ำ', 'สูง/ต่ำ', 'โอเวอร์', 'อันเดอร์', 'คาดว่าจะจบ', 'สกอร์คาดการณ์', 'ชนะแน่', 'ผลแน่นอน', 'เต็มทีม', 'ครบทีม'] as const;
const MARKET_WORDS_LATIN = /\b(over|under|handicap)\b/i;
/** only when data_support is THIN */
const STRONG_CLAIMS = ['ได้เปรียบชัด', 'เหนือกว่าชัด', 'เต็งชัด', 'เต็งหนึ่ง', 'ขาดลอย'] as const;
/**
 * At EARLY the lineup may only be mentioned as not out yet: "ยังไม่ประกาศรายชื่อตัวจริง",
 * "ก่อนประกาศตัวจริง", "ตัวจริงยังไม่ออก" are fine, "ส่งตัวจริงชุดใหญ่" is a claim.
 */
const LINEUP_NOT_OUT = /(?:ยังไม่|ก่อน)\S{0,25}?(?:ตัวจริง|ไลน์อัพ|ไลน์อัป)|(?:ตัวจริง|ไลน์อัพ|ไลน์อัป)\S{0,25}?ยังไม่/g;
const LINEUP_WORDS = /ตัวจริง|ไลน์อัพ|ไลน์อัป/;
/** Thai separates sentences with a space; a stray semicolon is fixed here, not worth a retry */
const tidy = (s: string | null) => (s == null ? s : s.replace(/\s*;\s*/g, ' '));
/** a FORM / XG disagreement counts as stated when the overview or the uncertainty mentions one of these */
const FORM_WORDS = ['ฟอร์ม', 'xG', 'ช่วงหลัง', 'ล่าสุด'];
/** the whole write-up, about 400 Thai words */
const MAX_TOTAL_CHARS = 1700;

const TEXT_FIELDS = ['overview_th', 'home_th', 'away_th', 'score_th', 'uncertainty_th'] as const;
type TextField = (typeof TEXT_FIELDS)[number];

export const PREVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(TEXT_FIELDS.map((k) => [k, { type: 'string' }])),
  required: [...TEXT_FIELDS],
  additionalProperties: false,
} as const;

export const previewOutputSchema = z.object({
  overview_th: z.string().trim().min(40).max(500),
  home_th: z.string().trim().min(30).max(500),
  away_th: z.string().trim().min(30).max(500),
  score_th: z.string().trim().min(30).max(500),
  // empty = nothing specific could change the picture
  uncertainty_th: z.string().trim().max(350).transform((s) => s || null),
});

export interface ValidatedPreview {
  ok: boolean;
  violations: string[];
  text: PreviewText | null;
}

/**
 * The part of the input each field may take its numbers from: a team's section never quotes the
 * other team's figures or the model's, score_th only the model's. The fixture (team names such as
 * "1899 Hoffenheim") is always allowed. The overview and the uncertainty may use everything.
 */
function numberSources(field: TextField, input: Record<string, unknown>): unknown {
  const { fixture, home, away, model, data_support } = input;
  switch (field) {
    case 'home_th':
      return { fixture, home, data_support };
    case 'away_th':
      return { fixture, away, data_support };
    case 'score_th':
      return { fixture, model, data_support };
    default:
      return input;
  }
}

type Chances = { home?: number; draw?: number; away?: number } | null | undefined;

/** What a percentage may stand for: 1X2 chances (model and market), scoreline chances, the API's percents, possession. */
export function allowedPercents(input: Record<string, unknown>): number[] {
  const out: number[] = [];
  const add = (x: unknown) => {
    if (typeof x === 'number' && Number.isFinite(x)) out.push(x <= 1 ? x * 100 : x);
  };
  const three = (c: Chances) => [c?.home, c?.draw, c?.away].forEach(add);
  const model = input.model as { p?: Chances; scorelines?: Array<{ p?: number }> } | null | undefined;
  three(model?.p);
  model?.scorelines?.forEach((s) => add(s.p));
  three((input.views as { marketP?: Chances } | null | undefined)?.marketP);
  const api = input.apiPrediction as { homePct?: number; drawPct?: number; awayPct?: number } | null | undefined;
  [api?.homePct, api?.drawPct, api?.awayPct].forEach(add);
  for (const side of ['home', 'away'] as const) add((input[side] as { averages?: { possession?: number } | null } | undefined)?.averages?.possession);
  return out;
}

/**
 * Same discipline as the shadow ranking, plus the v0.9 checks. Every number traces back to its part
 * of the input and every percentage to a chance. Scorelines are the model's or past results (the
 * score section only the model's). Both teams are named as in the input. Nothing about lineups
 * before they are out. A disagreement listed in views is stated. No market or verdict words, and
 * the whole stays short. A failure never loses the match: the job stores the template text instead
 * and keeps the violations for review.
 */
export function validatePreviewOutput(raw: unknown, input: Record<string, unknown>): ValidatedPreview {
  const parsed = previewOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, violations: [`schema: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`], text: null };
  }
  const out = { ...parsed.data };
  for (const f of TEXT_FIELDS) (out as Record<TextField, string | null>)[f] = tidy(out[f]);
  const violations: string[] = [];
  const fixture = (input.fixture ?? {}) as { home?: string; away?: string; stage?: string };
  const support = (input.data_support ?? {}) as { level?: string };
  const listed = knownScorelines(input);
  const modelScores = knownScorelines({ model: input.model });
  const percents = allowedPercents(input);

  for (const field of TEXT_FIELDS) {
    const t = out[field];
    if (!t) continue;
    for (const w of [...PREVIEW_BANNED_WORDS, ...PREVIEW_V09_BANNED]) if (t.includes(w)) violations.push(`banned word "${w}"`);
    if (MARKET_WORDS_LATIN.test(t)) violations.push(`${field}: market word`);
    if (support.level === 'THIN') for (const w of STRONG_CLAIMS) if (t.includes(w)) violations.push(`${field}: strong claim on thin data "${w}"`);
    const plain = withoutThousandsSeparators(t);
    for (const n of inventedNumbers(plain, allowedNumbers(numberSources(field, input)))) violations.push(`${field}: number not in input: ${n}`);
    for (const m of plain.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)) {
      const n = Number(m[1]!.replace(',', '.'));
      if (!percents.some((p) => Math.abs(p - n) <= 0.51)) violations.push(`${field}: percent is not a chance in the input: ${m[1]}%`);
    }
    const allowed = field === 'score_th' ? modelScores : listed;
    for (const m of t.matchAll(/(?<![\d.])(\d)\s*[-–]\s*(\d)(?![\d.])/g)) {
      const s = `${m[1]}-${m[2]}`;
      // "2-1" style scorelines must be the model's or a result in the input; W-D-L counts like "ชนะ 3 เสมอ 1" don't match this shape
      if (!allowed.has(s)) violations.push(field === 'score_th' ? `score_th: scoreline not from the model: ${s}` : `scoreline not in input: ${s}`);
    }
    if (fixture.stage === 'EARLY' && LINEUP_WORDS.test(t.replace(LINEUP_NOT_OUT, ''))) violations.push(`${field}: lineup claim before the lineups are out`);
  }

  // the teams as the input names them: the page shows them that way, and a transliteration cannot be checked
  const named: Array<[TextField, string | undefined]> = [
    ['overview_th', fixture.home],
    ['overview_th', fixture.away],
    ['home_th', fixture.home],
    ['away_th', fixture.away],
  ];
  for (const [field, name] of named) if (name && !out[field]!.includes(name)) violations.push(`${field}: does not name ${name}`);

  const says = (fields: TextField[], words: string[]) => fields.some((f) => words.some((w) => out[f]?.includes(w)));
  const disagreements = (input.views as { disagreements?: string[] } | null | undefined)?.disagreements ?? [];
  if ((disagreements.includes('MARKET') || disagreements.includes('MARKET_GAP')) && !says(['overview_th', 'score_th'], ['ตลาด'])) violations.push('disagreement not stated: market');
  if ((disagreements.includes('FORM') || disagreements.includes('XG')) && !says(['overview_th', 'uncertainty_th'], FORM_WORDS)) violations.push('disagreement not stated: recent form');

  const total = TEXT_FIELDS.reduce((n, f) => n + (out[f]?.length ?? 0), 0);
  if (total > MAX_TOTAL_CHARS) violations.push(`too long: ${total} characters`);

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
