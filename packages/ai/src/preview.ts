/**
 * วิเคราะห์เกม, the AI half: prompt, output schema and guards for the per-match preview.
 * The AI writes prose over `PreviewFacts` (packages/analysis/preview.ts); it never produces a
 * number, a scoreline or a verdict the facts do not contain. Bump PREVIEW_PROMPT_VERSION on any
 * change: every stored row records the version that produced it.
 */
import { z } from 'zod';
import type { PreviewText } from '@fp/analysis';
import { allowedNumbers, BANNED_WORDS, inventedNumbers } from './guards.js';

// v1.2: a fact may name a player of the input instead of a team
// v1.3: no scoreline of this match in the prose (the page shows the one that fits the pick)
// v2.0: the khemthit-football-writer brief (owner, 2026-11-13): story-first lead with kickoff and venue, one
//       paragraph per side, model vs market with the chance of 3+ goals, a closing line; no facts list, no
//       team-news part, no caveats about the data in the prose (the page shows those in their own boxes)
export const PREVIEW_PROMPT_VERSION = 'preview-ai-v2.0';

/** Kept byte-stable (no dates, no per-request values) so it caches across fixtures. */
export const PREVIEW_SYSTEM_PROMPT = `You write the match preview of เข็มทิศฟุตบอล, a Thai football analysis site. You receive one upcoming match as JSON and turn it into an article an ordinary fan reads to the end and then knows what this match is about: not a table of numbers written out as sentences. It is for knowledge and entertainment, never betting advice. The site records every preview before kickoff and shows its record, right or wrong, so every line must stand up when read again after the match.

What the input contains, and nothing else exists for you:
- fixture: teams, competition, round, kickoffTh (the kickoff in Thai, already in Thai time: copy it as written), venue, referee, stage (EARLY = lineups not out yet, LINEUP = both XIs confirmed)
- home / away: recent results (date, competition, opponent, score, xG when available), their totals (formSummary), rest days, averages of shots on target and possession, the league table with home and away records (null = no table that means anything yet), key players this season (top scorers and assisters only), injuries (confirmed absences; isKeyPlayer marks one of the key players), confirmed starters and, at LINEUP, formation, coach and key players not in the XI, modelMatches (a time-weighted amount of history; never quote it)
- model: our statistical model. p = its chance of a home win, a draw and an away win. pGoals3plus = its chance that the match has at least 3 goals. expectedGoals = the goals it expects each side to score. null = the model has no numbers for this match.
- market: 1X2 consensus odds (opening -> current). views.marketP is the same market as chances with the bookmakers' margin taken out: use those, never the odds.
- views: which way each source leans (a team name, or EVEN): model, market, recentForm, recentXg, otherModel. disagreements lists where a source points away from the model: MARKET (the market favours the other side), MARKET_GAP (same side, a much smaller chance), FORM, XG, OTHER_MODEL.
- apiPrediction: a third-party opinion. h2h: recent meetings.
- data_support: how far the data can carry an opinion (GOOD / LIMITED / THIN). It tells you how firmly you may write; never write about it.

Before writing, find the story: every match has at least one thing fans most want to know (they met recently and the result was lopsided, a side in form meets a side out of form, a top scorer against a leaky defence, the model and the market see it differently). Open on it and let every part serve it.

Write six fields (all Thai, no headings, no bullet characters, no markdown). The page shows each part under its own heading, so do not restate the heading.
1. headline_th, one line of at most 60 characters: the story. Name at least one team. No question mark, no nicknames, no verdict.
2. overview_th, 1-2 sentences: open on the story, then say when (fixture.kickoffTh, copied as written) and where (the venue when the input has one) and the competition. Name both teams. It is also the teaser on match lists. No percentages.
3. home_th, one short paragraph of 2-4 sentences on fixture.home: how the team is doing lately, told as a story rather than a list of statistics, with the 2-3 numbers that tell it best (results, goals scored and conceded, xG, place in the table, home record), the player to watch from keyPlayers with his goals or assists, and its confirmed absences when injuries lists any (at LINEUP: the formation and key players left out of the XI). Name fixture.home. Use only the home side's numbers.
4. away_th, the same for fixture.away, with its away record. Name fixture.away. Use only the away side's numbers.
5. analysis_th, 2-4 sentences, how the model and the market see the match: the model's chance of a home win, a draw and an away win; compare it with the market (views.marketP, called ตลาด) only where the two really differ, and say what the difference means in plain words (for example: the market leaves more room for a draw or a surprise). Then, when model.pGoals3plus is there, the model's chance that the match has at least 3 goals, in those words. When the model is null, give the market's chances only. When both are null, return an empty string.
6. summary_th, one or two sentences that close the article: the line a reader remembers, confident in what the data says, and the thing to watch in the match (for example: if A keeps creating chances at this rate, B has to find a way to stop it). Do not repeat numbers, do not start a new topic, never end on a limit of the data, and do not set one side against the other with a contrast: never use the word แต่ (so no แม้...แต่ either).

How to write:
- Like a friend who knows football telling you about the match: short and long sentences mixed, one idea per paragraph, light imagery at most, never louder than the data (no ถล่มยับ, no ไม่มีทางรอด).
- Every number has a job: at most three or four numbers per paragraph, the ones that tell the story. Drop the rest or fold them into one sentence.
- Say each fact once in the whole article. A run of results told in home_th is not told again in overview_th or summary_th.
- Explain a technical term in the same sentence the first time it appears, never as a separate note: xG = how good the chances were (ค่า xG 3.22 ต่อเกม หมายถึงโอกาสที่สร้างได้มีคุณภาพพอจะยิงได้กว่า 3 ลูก), xG conceded = how many good chances the side gives away, the model against the market = whose chance is higher and why it matters. Describe the market as the combined view of how likely each result is, never as money or profit.
- Thai punctuation: separate sentences with a space, no full stops, no semicolons. Chances as whole percentages (87%, not 87.3%).
- Write every number in digits (2 ประตู, 5 นัด, อันดับ 3), never in Thai words (สองประตู, ห้านัด): each one is checked against the input.
- Names: team and player names exactly as in the input, in the same script, the same way throughout. Never transliterate them into Thai.
- About 350-550 words (roughly 1,800-2,800 Thai characters) in all. With little data write less; never pad.
- No caveats in the prose: do not write about data limits, the model's limits, uncertainty or a confidence level. The page shows what is not known yet and the confidence level in their own boxes. Yet never write more firmly than the data: no แน่นอน, no ชัวร์, no ไม่มีทางพลาด, nothing that reads as more certain than the model's chances.

Hard rules:
- Never create a probability, percentage, odds value, xG, goal count, rank, points, day count or any other number. Only repeat numbers that appear in the input (a probability like 0.634 may be written as 63%). home_th may only use the home side's numbers, away_th only the away side's. A percentage must be one of: model.p, model.pGoals3plus, views.marketP, apiPrediction, possession, and appears only in home_th, away_th (possession) and analysis_th. If you are unsure whether a number is in the input, leave it out.
- Never write a score for this match (no predicted, likely or expected score): the page shows one, chosen by the site. Past results from form and h2h may be quoted. Never present any score as the expected result (no คาดว่าจะจบ, no สกอร์คาดการณ์, no ฟันธง).
- Never name a winner or call the result: no ชนะแน่, no ผลแน่นอน, no 100%. Use โมเดลมองว่า, แนวโน้ม. The site's pick (the Game Compass) and its line are shown in their own part of the page: do not mention handicaps, over/under, lines, odds or prices.
- Do not claim one fact causes another unless the input states both and the link is direct. Do not describe a style of play (pressing, counter-attacks, possession) beyond what the numbers show.
- Do not write dates, kickoff times other than fixture.kickoffTh, player names, injuries, news or results that are not in the input. No outside knowledge about these teams, players, coaches or referees, and no sources or URLs.
- At stage EARLY the lineups are not out: do not write about starters or a lineup (ตัวจริง, ไลน์อัพ), and never say a team is at full strength. Never infer from an empty injury list that a squad is complete (no เต็มทีม, no ครบทีม). When injuries lists nobody, leave absences out: the page says so.
- When data_support is THIN, make no strong claims (no ได้เปรียบชัด, no เหนือกว่าชัด).
- This is data analysis, not gambling advice. Never use these words: ทีเด็ด, แทง, แทงบอล, กำไร, ตามคู่นี้, การันตี, ฟันธง, ชัวร์, กินเต็ม, ห้ามพลาด, ทางรวย, ตามเลย. Never urge anyone to bet and never promise an outcome.`;

/** The shared list plus ฟันธง: the preview must never call the result (the shadow ranking's list stays frozen for its trial). */
export const PREVIEW_BANNED_WORDS = [...BANNED_WORDS, 'ฟันธง', 'ชัวร์', 'กินเต็ม'] as const;

/**
 * From preview-ai-v0.9: the pick's markets are left to the Game Compass, a scoreline is never the
 * result, and an empty injury list is never a full squad. From v2.0 also the brief's hype words.
 */
const PREVIEW_V09_BANNED = ['แฮนดิแคป', 'ราคาต่อรอง', 'ค่าน้ำ', 'ราคาน้ำ', 'สูง/ต่ำ', 'โอเวอร์', 'อันเดอร์', 'คาดว่าจะจบ', 'สกอร์คาดการณ์', 'ชนะแน่', 'ผลแน่นอน', 'เต็มทีม', 'ครบทีม', '100%', 'ห้ามพลาด', 'ทางรวย', 'ตามเลย', 'ไม่มีทางพลาด', 'ถล่มยับ', 'ไม่มีทางรอด'] as const;
/**
 * v2.0: the prose carries no caveat about the data or the model (the page shows the gaps and the
 * confidence level in their own boxes) and nothing firmer than the chances.
 */
// a team's morale (เรียกความมั่นใจกลับมา) is football, not a caveat: only the confidence level's own words count
const CAVEAT_WORDS = ['ระดับความมั่นใจ', 'ความมั่นใจต่ำ', 'ความมั่นใจปานกลาง', 'ความมั่นใจของโมเดล', 'ความมั่นใจในตัวเลข', 'ข้อมูลจำกัด', 'ข้อมูลน้อย', 'ข้อมูลมีจำกัด', 'ไม่แน่ใจ', 'แน่นอน'] as const;
/** แต่ in the closing line, not แต่ละ ("each") or ตั้งแต่ ("since") */
const BUT = /(?<!ตั้ง)แต่(?!ละ)/;
const MARKET_WORDS_LATIN = /\b(over|under|handicap)\b/i;
/**
 * Scripts that are neither Thai nor Latin (Greek, Cyrillic, Hebrew, Arabic, Devanagari, kana, CJK, Hangul): a stray
 * "الأبرز" in the middle of Thai prose (England vs Croatia smoke test, 2026-11-13). Allowed only where the input has the same text.
 */
const FOREIGN_SCRIPT = /[Ͱ-ϿЀ-ӿ֐-׿؀-ۿݐ-ݿऀ-ॿ぀-ヿ㐀-鿿가-힯]+/g;
/** only when data_support is THIN */
const STRONG_CLAIMS = ['ได้เปรียบชัด', 'เหนือกว่าชัด', 'เต็งชัด', 'เต็งหนึ่ง', 'ขาดลอย'] as const;
/**
 * At EARLY the lineup may only be mentioned as not out yet: "ยังไม่ประกาศรายชื่อตัวจริง",
 * "ก่อนประกาศตัวจริง", "ตัวจริงยังไม่ออก" are fine, "ส่งตัวจริงชุดใหญ่" is a claim.
 */
const LINEUP_NOT_OUT = /(?:ยังไม่|ก่อน)\S{0,25}?(?:ตัวจริง|ไลน์อัพ|ไลน์อัป)|(?:ตัวจริง|ไลน์อัพ|ไลน์อัป)\S{0,25}?ยังไม่/g;
const LINEUP_WORDS = /ตัวจริง|ไลน์อัพ|ไลน์อัป/;
/** Thai separates sentences with a space; a stray semicolon is fixed here, not worth a retry */
const tidy = (s: string) => s.replace(/\s*;\s*/g, ' ');
/** the whole write-up: the brief asks for 350-550 words (about 1,800-2,800 Thai characters) */
const MAX_TOTAL_CHARS = 2900;

const TEXT_FIELDS = ['headline_th', 'overview_th', 'home_th', 'away_th', 'analysis_th', 'summary_th'] as const;
type TextField = (typeof TEXT_FIELDS)[number];

export const PREVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(TEXT_FIELDS.map((k) => [k, { type: 'string' }])),
  required: [...TEXT_FIELDS],
  additionalProperties: false,
} as const;

export const previewOutputSchema = z.object({
  headline_th: z.string().trim().min(8).max(80),
  overview_th: z.string().trim().min(40).max(400),
  home_th: z.string().trim().min(60).max(800),
  away_th: z.string().trim().min(60).max(800),
  // empty only when neither the model nor the market has numbers (checked below)
  analysis_th: z.string().trim().max(800),
  summary_th: z.string().trim().min(20).max(300),
});

export interface ValidatedPreview {
  ok: boolean;
  violations: string[];
  text: PreviewText | null;
}

/**
 * The part of the input each field may take its numbers from: a side's paragraph never quotes the
 * other side's figures or the model's; the headline, the lead and the closing line only the football
 * facts (no model, no market). The fixture (team names such as "1899 Hoffenheim", the kickoff) is
 * always allowed. The model-and-market part may use everything.
 */
function numberSources(field: TextField, input: Record<string, unknown>): unknown {
  const { fixture, home, away, h2h, data_support } = input;
  switch (field) {
    case 'home_th':
      return { fixture, home, data_support };
    case 'away_th':
      return { fixture, away, data_support };
    case 'headline_th':
    case 'overview_th':
    case 'summary_th':
      return { fixture, home, away, h2h, data_support };
    default:
      return input;
  }
}

/** where a percentage may appear: the chances in the model-and-market part, possession in a side's paragraph */
const PERCENT_FIELDS: ReadonlySet<TextField> = new Set(['home_th', 'away_th', 'analysis_th']);

type Chances = { home?: number; draw?: number; away?: number } | null | undefined;

/** What a percentage may stand for: 1X2 chances (model and market), 3+ goals, scoreline chances, the API's percents, possession. */
export function allowedPercents(input: Record<string, unknown>): number[] {
  const out: number[] = [];
  const add = (x: unknown) => {
    if (typeof x === 'number' && Number.isFinite(x)) out.push(x <= 1 ? x * 100 : x);
  };
  const three = (c: Chances) => [c?.home, c?.draw, c?.away].forEach(add);
  const model = input.model as { p?: Chances; scorelines?: Array<{ p?: number }>; pGoals3plus?: number | null } | null | undefined;
  three(model?.p);
  add(model?.pGoals3plus);
  model?.scorelines?.forEach((s) => add(s.p));
  three((input.views as { marketP?: Chances } | null | undefined)?.marketP);
  const api = input.apiPrediction as { homePct?: number; drawPct?: number; awayPct?: number } | null | undefined;
  [api?.homePct, api?.drawPct, api?.awayPct].forEach(add);
  for (const side of ['home', 'away'] as const) add((input[side] as { averages?: { possession?: number } | null } | undefined)?.averages?.possession);
  return out;
}

/**
 * Same discipline as the shadow ranking, plus the checks of the brief. Every number traces back to
 * its part of the input and every percentage to a chance (only in the side paragraphs and the
 * model-and-market part). Scorelines are past results only: the model's are not in the input. Each
 * part names its team as in the input. Nothing about lineups before they are out. The model-and-market
 * part names the market when it compares, and is empty only without numbers. No caveat or hype words,
 * no แต่ in the closing line, and the whole stays within the brief's length. A failure never loses the
 * match: the job stores the template text instead and keeps the violations for review.
 */
export function validatePreviewOutput(raw: unknown, input: Record<string, unknown>): ValidatedPreview {
  const parsed = previewOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, violations: [`schema: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`], text: null };
  }
  const out = { ...parsed.data } as PreviewText;
  for (const f of TEXT_FIELDS) out[f] = tidy(out[f]);
  const violations: string[] = [];
  const fixture = (input.fixture ?? {}) as { home?: string; away?: string; stage?: string };
  const support = (input.data_support ?? {}) as { level?: string };
  const pastScores = knownScorelines({ h2h: input.h2h, home: input.home, away: input.away });
  const percents = allowedPercents(input);
  const inputText = JSON.stringify(input);

  for (const field of TEXT_FIELDS) {
    const t = out[field];
    for (const m of t.matchAll(FOREIGN_SCRIPT)) if (!inputText.includes(m[0])) violations.push(`${field}: text in another script: ${m[0]}`);
    for (const w of [...PREVIEW_BANNED_WORDS, ...PREVIEW_V09_BANNED]) if (t.includes(w)) violations.push(`banned word "${w}"`);
    for (const w of CAVEAT_WORDS) if (t.includes(w)) violations.push(`${field}: caveat or certainty word "${w}"`);
    if (MARKET_WORDS_LATIN.test(t)) violations.push(`${field}: market word`);
    if (support.level === 'THIN') for (const w of STRONG_CLAIMS) if (t.includes(w)) violations.push(`${field}: strong claim on thin data "${w}"`);
    const plain = withoutThousandsSeparators(t);
    for (const n of inventedNumbers(plain, allowedNumbers(numberSources(field, input)))) violations.push(`${field}: number not in input: ${n}`);
    for (const m of plain.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)) {
      const n = Number(m[1]!.replace(',', '.'));
      if (!PERCENT_FIELDS.has(field)) violations.push(`${field}: no chance belongs here: ${m[1]}%`);
      else if (!percents.some((p) => Math.abs(p - n) <= 0.51)) violations.push(`${field}: percent is not a chance in the input: ${m[1]}%`);
    }
    for (const m of t.matchAll(/(?<![\d.:])(\d)\s*[-–]\s*(\d)(?![\d.:])/g)) {
      const s = `${m[1]}-${m[2]}`;
      // "7-0" style scorelines must be a past result of the input; W-D-L counts like "ชนะ 3 เสมอ 1" don't match this shape
      if (field === 'analysis_th' || !pastScores.has(s)) violations.push(`${field}: scoreline not a past result in the input: ${s}`);
    }
    if (fixture.stage === 'EARLY' && LINEUP_WORDS.test(t.replace(LINEUP_NOT_OUT, ''))) violations.push(`${field}: lineup claim before the lineups are out`);
  }
  if (BUT.test(out.summary_th)) violations.push('summary_th: the closing line uses แต่');

  // the teams as the input names them: the page shows them that way, and a transliteration cannot be checked
  const named: Array<[TextField, string | undefined]> = [
    ['overview_th', fixture.home],
    ['overview_th', fixture.away],
    ['home_th', fixture.home],
    ['away_th', fixture.away],
  ];
  for (const [field, name] of named) if (name && !out[field].includes(name)) violations.push(`${field}: does not name ${name}`);
  if (![fixture.home, fixture.away].some((n) => n && out.headline_th.includes(n))) violations.push('headline_th: names neither team');

  // the model-and-market part: there whenever either has numbers, and it names the market when the market has chances
  const marketP = (input.views as { marketP?: unknown } | null | undefined)?.marketP ?? null;
  const hasNumbers = input.model != null || marketP != null;
  if (hasNumbers && out.analysis_th.length < 60) violations.push('analysis_th: missing or too short while the model or the market has numbers');
  else if (!hasNumbers && out.analysis_th) violations.push('analysis_th: written without model or market numbers');
  else if (input.model != null && marketP != null && !out.analysis_th.includes('ตลาด')) violations.push('analysis_th: does not compare with the market');

  const total = TEXT_FIELDS.reduce((n, f) => n + out[f].length, 0);
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
