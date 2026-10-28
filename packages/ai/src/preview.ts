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
export const PREVIEW_PROMPT_VERSION = 'preview-ai-v1.2';

/** Kept byte-stable (no dates, no per-request values) so it caches across fixtures. */
export const PREVIEW_SYSTEM_PROMPT = `You are the analyst of a Thai football data & analysis brand. You receive one upcoming match as JSON and write a Thai match preview in the shape of the Thai football press: a headline, the match in brief, each side in turn, the team news, the analysis, and a few facts worth knowing. Lively and easy to read for ordinary fans, every point backed by the data, readable in about three minutes. It is for knowledge and entertainment, never betting advice.

What the input contains, and nothing else exists for you:
- fixture: teams, competition, round, stage (EARLY = lineups not out yet, LINEUP = both XIs confirmed), venue, referee
- home / away: recent results (date, competition, opponent, score, xG when available), their totals (formSummary), rest days, averages of shots on target and possession, the league table with home and away records (null = no table that means anything yet), key players this season (top scorers and assisters only), injuries (isKeyPlayer marks one of those key players; other absent players may still matter, you just cannot tell from the data), confirmed starters and, at LINEUP, formation, coach and key players not in the XI, modelMatches (a time-weighted amount of history the model rates the team on; never quote it as a number of matches)
- model: our statistical model. p = its chance of a home win, a draw and an away win. expectedGoals = the goals it expects each side to score. scorelines = the single scores it rates most likely, with their chances. null = the model has no numbers for this match.
- market: 1X2 consensus odds (opening -> current). views.marketP is the same market as chances with the bookmakers' margin taken out: use those, never the odds.
- views: which way each source leans (a team name, or EVEN): model, market, recentForm (points over the recent results), recentXg, otherModel (a second rating model). disagreements lists where a source points away from the model: MARKET (the market favours the other side), MARKET_GAP (same side, but the market gives it a much smaller chance), FORM, XG, OTHER_MODEL.
- apiPrediction: a third-party opinion. h2h: recent meetings.
- data_support: how far the data can carry an opinion (GOOD / LIMITED / THIN) and the reasons, in Thai. These are facts about the input: respect them.

Write seven fields (all Thai, no headings, no bullet characters, no markdown). The page shows each under its own heading, so do not restate the heading.
1. headline_th, one line of at most 60 characters: the story of this match as the data tells it (a run of results, the table, a key absence, the meeting of two sides in contrasting form). Name at least one team. No nicknames, no news, no question marks, no verdict.
2. overview_th, 1-2 sentences: the match in brief and which side the data favours, naming both teams. It is also the teaser on match lists.
3. home_th, 3-5 sentences on the home side (fixture.home): its recent form and how it scores and concedes (goals, xG, shots on target), its home record and place in the table, the key players the data confirms, rest days or a busy run of matches when the data shows it. Name fixture.home. Use only the home side's numbers.
4. away_th, 3-5 sentences on the away side (fixture.away), in the same frame, with its away record. Name fixture.away. Use only the away side's numbers.
5. team_news_th, 1-3 sentences: the confirmed absences on both sides and how each could matter (a missing key player matters most); at LINEUP, the formation and the key players left out of the XI. At EARLY say the lineups are not announced yet. When neither side lists an absence, say only that the lineups are not out yet (EARLY) or describe the XIs (LINEUP).
6. analysis_th, 4-6 sentences: how the two sides meet (where one side's strength runs into the other's weak spot, as the numbers show it), then the model's most likely score and two or three reasons for it and for the lean, each tied to a fact in the input (the model's chances, expected goals, recent form, the market). The page shows the score itself in large type right above this field. If views.disagreements is not empty, say plainly which source points elsewhere and keep both sides of it: for MARKET or MARKET_GAP, say the market (ตลาด) sees it closer or the other way, with its chance from views.marketP; for FORM or XG, say recent form or xG points the other way and that the model rates the teams on a longer stretch of matches than the last five; for OTHER_MODEL, say the model's view is not settled. Never quote only the numbers that support one side. End with what in the facts could change the result when there is something specific (a missing key player, a disagreement, a gap in rest days); no stock lines such as "the first goal will matter".
7. facts_th, a list of 3-5 short items, one fact each, read straight off the input: a run of results, a home or away record, a place in the table, a top scorer's goals, a recent meeting in h2h. One sentence each, no opinion, no chance or percentage, nothing about the market, no prediction. Each item names the team it is about, or a player listed in the input (keyPlayers or injuries) as the input writes the name. Do not repeat a sentence from another field word for word.

Style: short spoken sentences, no officialese, no research-paper tone, no long run-ups. Thai punctuation: separate sentences with a space, no full stops, no semicolons. Write chances as whole percentages (80%, not 80.3%). Explain a technical term once where it first appears (xG คือค่าประเมินคุณภาพของโอกาสยิง). Use only the numbers that explain the match, at most three or four in a section. Say each point once: what one section says, another does not repeat. Keep what the data shows (results, table, injuries) apart from what it suggests (how the match may go). Not every match needs a firm conclusion: when the data is thin or the sources disagree, say the picture is open. Aim for 2,000-3,200 Thai characters in all, fewer when the data is limited; never pad to reach a length.

Names: write team and player names exactly as they appear in the input, in the same script. Never transliterate them into Thai.

Hard rules:
- Never create a probability, percentage, odds value, xG, goal count, rank, points, day count or any other number. Only repeat numbers that appear in the input (a probability like 0.634 may be written as 63%). home_th may only use the home side's numbers, away_th only the away side's, team_news_th only the two sides' (not the model's). A percentage must be one of: model.p, a scoreline chance, views.marketP, apiPrediction, possession, and never appears in headline_th or facts_th. If you are unsure whether a number is in the input, leave it out.
- Scorelines are the model's, not yours: only quote scorelines listed in model.scorelines and past results in form and h2h; in analysis_th only model.scorelines; in headline_th and facts_th only past results. Call the first one สกอร์ที่โมเดลให้โอกาสสูงสุด, one of many possible scores; never present it as the expected result (no คาดว่าจะจบ, no สกอร์คาดการณ์, no ฟันธง).
- Never name a winner or call the result: no ชนะแน่, no ผลแน่นอน, no 100%. The site's one analytical view of the match (the Game Compass) is explained elsewhere on the page: do not mention handicaps, over/under, lines, odds or prices.
- Do not claim one fact causes another unless the input states both and the link is direct. A stronger team is not the same as a team that will win by a margin. Do not describe a style of play (pressing, counter-attacks, possession) beyond what the numbers in the input show.
- Do not write dates, kickoff times, player names, injuries, news or results that are not in the input. No outside knowledge about these teams, players, coaches or referees, and no sources or URLs. The table zone is the provider's English label: you may say it in Thai, never add to it.
- At stage EARLY the lineups are not out: do not write about starters or a lineup (ตัวจริง, ไลน์อัพ) except to say they are not announced yet, and never say a team is at full strength. Never infer from an empty injury list that a squad is complete (no เต็มทีม, no ครบทีม).
- When model is null, say the model has no numbers for this match and write from the football facts only. When data_support is THIN, make no strong claims (no ได้เปรียบชัด, no เหนือกว่าชัด).
- Missing pieces that are not in data_support (no injuries listed, no h2h, no market, no venue): leave that topic out without pointing out that it is missing.
- This is data analysis, not gambling advice. Never use these words: ทีเด็ด, แทง, แทงบอล, กำไร, ตามคู่นี้, การันตี, ฟันธง, ชัวร์, กินเต็ม. Never guarantee or promise an outcome.`;

/** The shared list plus ฟันธง: the preview must never call the result (the shadow ranking's list stays frozen for its trial). */
export const PREVIEW_BANNED_WORDS = [...BANNED_WORDS, 'ฟันธง', 'ชัวร์', 'กินเต็ม'] as const;

/**
 * From preview-ai-v0.9: the pick's markets are left to the Game Compass note, a scoreline is never
 * the result, and an empty injury list is never a full squad.
 */
const PREVIEW_V09_BANNED = ['แฮนดิแคป', 'ราคาต่อรอง', 'ค่าน้ำ', 'ราคาน้ำ', 'สูง/ต่ำ', 'โอเวอร์', 'อันเดอร์', 'คาดว่าจะจบ', 'สกอร์คาดการณ์', 'ชนะแน่', 'ผลแน่นอน', 'เต็มทีม', 'ครบทีม', '100%'] as const;
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
/** a FORM / XG disagreement counts as stated when one of these appears where it should be said */
const FORM_WORDS = ['ฟอร์ม', 'xG', 'ช่วงหลัง', 'ล่าสุด'];
/** the whole write-up, about 800 Thai words (the brief asks for 2,000-3,200 characters) */
const MAX_TOTAL_CHARS = 3800;

const TEXT_FIELDS = ['headline_th', 'overview_th', 'home_th', 'away_th', 'team_news_th', 'analysis_th'] as const;
type TextField = (typeof TEXT_FIELDS)[number] | 'facts_th';

export const PREVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  properties: { ...Object.fromEntries(TEXT_FIELDS.map((k) => [k, { type: 'string' }])), facts_th: { type: 'array', items: { type: 'string' } } },
  required: [...TEXT_FIELDS, 'facts_th'],
  additionalProperties: false,
} as const;

export const previewOutputSchema = z.object({
  headline_th: z.string().trim().min(8).max(80),
  overview_th: z.string().trim().min(40).max(400),
  home_th: z.string().trim().min(60).max(900),
  away_th: z.string().trim().min(60).max(900),
  team_news_th: z.string().trim().min(20).max(600),
  analysis_th: z.string().trim().min(60).max(1100),
  facts_th: z.array(z.string().trim().min(10).max(220)).min(3).max(5),
});

export interface ValidatedPreview {
  ok: boolean;
  violations: string[];
  text: PreviewText | null;
}

/**
 * The part of the input each field may take its numbers from: a side's part never quotes the other
 * side's figures or the model's, the team news only the two sides', the headline and the facts only
 * the football facts (no model, no market). The fixture (team names such as "1899 Hoffenheim") is
 * always allowed. The overview and the analysis may use everything.
 */
function numberSources(field: TextField, input: Record<string, unknown>): unknown {
  const { fixture, home, away, h2h, data_support } = input;
  switch (field) {
    case 'home_th':
      return { fixture, home, data_support };
    case 'away_th':
      return { fixture, away, data_support };
    case 'team_news_th':
      return { fixture, home, away, data_support };
    case 'headline_th':
    case 'facts_th':
      return { fixture, home, away, h2h, data_support };
    default:
      return input;
  }
}

/** Player names the input lists for either side: key players and injuries. */
function inputPlayers(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const side of ['home', 'away'] as const) {
    const t = input[side] as { keyPlayers?: Array<{ name?: string | null }>; injuries?: Array<{ player?: string | null }> } | undefined;
    for (const p of t?.keyPlayers ?? []) if (p.name) out.push(p.name);
    for (const i of t?.injuries ?? []) if (i.player) out.push(i.player);
  }
  return out;
}

type Chances ={ home?: number; draw?: number; away?: number } | null | undefined;

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
 * Same discipline as the shadow ranking, plus the v0.9 / v1.0 / v1.1 checks. Every number traces back
 * to its part of the input and every percentage to a chance (none in the headline or the facts).
 * Scorelines are the model's or past results (the analysis only the model's, the headline and the
 * facts only past results). Each part names its team as in the input. Nothing about lineups before
 * they are out. A disagreement listed in views is stated. No market or verdict words, and the whole
 * stays within about 800 words. A failure never loses the match: the job stores the template text
 * instead and keeps the violations for review.
 */
export function validatePreviewOutput(raw: unknown, input: Record<string, unknown>): ValidatedPreview {
  const parsed = previewOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, violations: [`schema: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`], text: null };
  }
  const out: PreviewText = { ...parsed.data, facts_th: parsed.data.facts_th.map((x) => tidy(x)!) };
  for (const f of TEXT_FIELDS) out[f] = tidy(out[f])!;
  const violations: string[] = [];
  const fixture = (input.fixture ?? {}) as { home?: string; away?: string; stage?: string };
  const support = (input.data_support ?? {}) as { level?: string };
  const listed = knownScorelines(input);
  const modelScores = knownScorelines({ model: input.model });
  const pastScores = knownScorelines({ h2h: input.h2h, home: input.home, away: input.away });
  const percents = allowedPercents(input);
  const parts: Array<[TextField, string]> = [...TEXT_FIELDS.map((f): [TextField, string] => [f, out[f]]), ...out.facts_th.map((x): [TextField, string] => ['facts_th', x])];

  for (const [field, t] of parts) {
    for (const w of [...PREVIEW_BANNED_WORDS, ...PREVIEW_V09_BANNED]) if (t.includes(w)) violations.push(`banned word "${w}"`);
    if (MARKET_WORDS_LATIN.test(t)) violations.push(`${field}: market word`);
    if (support.level === 'THIN') for (const w of STRONG_CLAIMS) if (t.includes(w)) violations.push(`${field}: strong claim on thin data "${w}"`);
    const plain = withoutThousandsSeparators(t);
    for (const n of inventedNumbers(plain, allowedNumbers(numberSources(field, input)))) violations.push(`${field}: number not in input: ${n}`);
    for (const m of plain.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)) {
      const n = Number(m[1]!.replace(',', '.'));
      if (field === 'headline_th' || field === 'facts_th') violations.push(`${field}: no chance belongs here: ${m[1]}%`);
      else if (!percents.some((p) => Math.abs(p - n) <= 0.51)) violations.push(`${field}: percent is not a chance in the input: ${m[1]}%`);
    }
    const allowed = field === 'analysis_th' ? modelScores : field === 'headline_th' || field === 'facts_th' ? pastScores : listed;
    for (const m of t.matchAll(/(?<![\d.])(\d)\s*[-–]\s*(\d)(?![\d.])/g)) {
      const s = `${m[1]}-${m[2]}`;
      // "2-1" style scorelines must be the model's or a result in the input; W-D-L counts like "ชนะ 3 เสมอ 1" don't match this shape
      if (!allowed.has(s)) violations.push(field === 'analysis_th' ? `analysis_th: scoreline not from the model: ${s}` : `${field}: scoreline not in input: ${s}`);
    }
    if (fixture.stage === 'EARLY' && LINEUP_WORDS.test(t.replace(LINEUP_NOT_OUT, ''))) violations.push(`${field}: lineup claim before the lineups are out`);
  }

  // the teams as the input names them: the page shows them that way, and a transliteration cannot be checked
  const named: Array<[(typeof TEXT_FIELDS)[number], string | undefined]> = [
    ['overview_th', fixture.home],
    ['overview_th', fixture.away],
    ['home_th', fixture.home],
    ['away_th', fixture.away],
  ];
  for (const [field, name] of named) if (name && !out[field].includes(name)) violations.push(`${field}: does not name ${name}`);
  const namesATeam = (t: string) => [fixture.home, fixture.away].some((n) => n && t.includes(n));
  if (!namesATeam(out.headline_th)) violations.push('headline_th: names neither team');
  // a fact about a player ("Gabriel Barbosa ทำ 15 ประตู") is as traceable as one about a team (Santos, 2026-10-28)
  const players = inputPlayers(input);
  for (const x of out.facts_th) if (!namesATeam(x) && !players.some((p) => x.includes(p))) violations.push(`facts_th: names no team or player of the input: ${x.slice(0, 40)}`);

  const says = (fields: Array<(typeof TEXT_FIELDS)[number]>, words: string[]) => fields.some((f) => words.some((w) => out[f].includes(w)));
  const disagreements = (input.views as { disagreements?: string[] } | null | undefined)?.disagreements ?? [];
  if ((disagreements.includes('MARKET') || disagreements.includes('MARKET_GAP')) && !says(['overview_th', 'analysis_th'], ['ตลาด'])) violations.push('disagreement not stated: market');
  if ((disagreements.includes('FORM') || disagreements.includes('XG')) && !says(['overview_th', 'analysis_th'], FORM_WORDS)) violations.push('disagreement not stated: recent form');

  const total = parts.reduce((n, [, t]) => n + t.length, 0);
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
