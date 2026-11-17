/**
 * Hybrid AI v2.1 / v2.1.1 (docs/adr/0021-hybrid-v21-no-ai-arithmetic.md). v2.1.1 is the production version from
 * 16 Nov 2026 (the hybrid job, HYBRID_VERSION unset or v2.1.1); v2.1 stays for the dry-run record. hybrid-ai-v2.0
 * (HYBRID_PROMPT_VERSION, HYBRID_SYSTEM_PROMPT, buildHybridInput) is the locked baseline, not changed here, and the
 * rollback (HYBRID_VERSION=v2.0).
 *
 * v2.1.1 adds to v2.1: the match count beside every sum and average, the owner's rule to state it when citing an
 * average (checked: averagesWithoutCount), and a check of every dated input value against the decision time
 * (enforceCutoffV211).
 *
 * The audit of 16 Nov 2026 (docs/research/hybrid-invalid-audit-2026-11-16.md) found that 153 of the 172 numbers the
 * number guard rejected were correct sums and differences the AI computed itself ("xG รวม 4.01"). v2.1 removes the
 * reason to compute, without loosening the guard:
 *   1. withAggregatesV21(): the totals and gaps the AI computed are given in the input, computed here
 *   2. HYBRID_SYSTEM_PROMPT_V21: the owner's rule against any new calculation, and ราคาที่ตัดค่าน้ำแล้ว for no-vig
 *   3. a rejected answer is asked again with the exact violations (retryFeedbackV21), on the same input, within the
 *      same attempt limit (HYBRID_MAX_ATTEMPTS)
 */
import OpenAI from 'openai';
import type { HybridOption } from '@fp/analysis';
import type { RankerResult } from './claude.js';
import { allowedNumbers, BANNED_WORDS, inventedNumbers } from './guards.js';
import { HYBRID_OUTPUT_SCHEMA, HYBRID_SYSTEM_PROMPT, validateHybridOutput } from './hybrid.js';
import { AI_TIMEOUT_MS, userMessage } from './prompt.js';

export const HYBRID_PROMPT_VERSION_V21 = 'hybrid-ai-v2.1';

// ---------------------------------------------------------------- 1. precomputed aggregates

const r2 = (x: number) => Math.round(x * 100) / 100;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const avg = (xs: number[]) => (xs.length ? r2(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const sum = (xs: number[]) => (xs.length ? r2(xs.reduce((a, b) => a + b, 0)) : null);

/** How every added value is computed: shown to the AI in data_quality.aggregates. */
export const AGGREGATES_V21_DEFINITION = {
  source: 'computed by us from the recent_matches listed in this input (90-minute score, the provider\'s xG); never estimated',
  per_match: 'goals_total = goals for + goals against of that match; xg_total = xg_for + xg_against; npxg_total = npxg_for + npxg_against; a total is null when either part is null',
  per_window:
    'over the same matches as the window: *_sum adds the values, *_avg averages them, each over only the matches that have the value; *_matches says how many matches it rests on; a missing value is never counted as zero',
  goal_difference: 'goal_difference_avg = goals_for_avg − goals_against_avg of the window; xg_difference_avg already exists',
  comparison: 'home value and away value side by side with their sum and their gap (home minus away), same window, same matches as each team\'s window',
} as const;

type Match = Record<string, unknown>;

function matchTotals(m: Match): Match {
  const [gf, ga] = String(m.score_for_against ?? '').split('-').map(Number);
  const both = (a: unknown, b: unknown) => (num(a) !== null && num(b) !== null ? r2(num(a)! + num(b)!) : null);
  return {
    ...m,
    goals_total: Number.isFinite(gf) && Number.isFinite(ga) ? gf! + ga! : null,
    xg_total: both(m.xg_for, m.xg_against),
    ...('npxg_for' in m ? { npxg_total: both(m.npxg_for, m.npxg_against) } : {}),
  };
}

function windowAggregates(ms: Match[]) {
  const pick = (k: string) => ms.map((m) => num(m[k])).filter((v): v is number => v !== null);
  const goalsFor = ms.map((m) => Number(String(m.score_for_against ?? '').split('-')[0])).filter(Number.isFinite);
  const goalsAgainst = ms.map((m) => Number(String(m.score_for_against ?? '').split('-')[1])).filter(Number.isFinite);
  const gt = pick('goals_total');
  const xt = pick('xg_total');
  const nt = pick('npxg_total');
  const gfa = avg(goalsFor);
  const gaa = avg(goalsAgainst);
  const xf = pick('xg_for');
  const xa = pick('xg_against');
  return {
    // v2.1.1: every sum and average carries the number of matches it rests on
    goals_matches: gt.length,
    goals_for_sum: sum(goalsFor),
    goals_against_sum: sum(goalsAgainst),
    goals_total_sum: sum(gt),
    goals_total_avg: avg(gt),
    goal_difference_avg: gfa !== null && gaa !== null ? r2(gfa - gaa) : null,
    xg_for_sum: sum(xf),
    xg_for_matches: xf.length,
    xg_against_sum: sum(xa),
    xg_against_matches: xa.length,
    xg_total_sum: sum(xt),
    xg_total_avg: avg(xt),
    xg_total_matches: xt.length,
    ...(ms.some((m) => 'npxg_total' in m) ? { npxg_total_avg: avg(nt), npxg_total_matches: nt.length } : {}),
  };
}

const WINDOWS = { last_10: (ms: Match[]) => ms.slice(0, 10), last_5: (ms: Match[]) => ms.slice(0, 5) } as const;

/**
 * A v2.0 (or earlier) hybrid input with the v2.1 aggregates added. Pure: the given object is not changed. Every added
 * value is computed from the input's own recent_matches, so it can be checked against them.
 */
export function withAggregatesV21(input: Record<string, unknown>): Record<string, unknown> {
  const out = structuredClone(input);
  const sides = [['home_team', 'HOME', 'home_matches_in_last_10'], ['away_team', 'AWAY', 'away_matches_in_last_10']] as const;
  for (const [key, venue, venueWindow] of sides) {
    const team = out[key] as Record<string, unknown> | undefined;
    if (!team || !Array.isArray(team.recent_matches)) continue;
    const ms = (team.recent_matches as Match[]).map(matchTotals);
    team.recent_matches = ms;
    for (const [w, f] of Object.entries(WINDOWS)) if (team[w]) team[w] = { ...(team[w] as object), ...windowAggregates(f(ms)) };
    if (team[venueWindow]) team[venueWindow] = { ...(team[venueWindow] as object), ...windowAggregates(ms.slice(0, 10).filter((m) => m.venue === venue)) };
  }
  const H = out.home_team as Record<string, Record<string, unknown>> | undefined;
  const A = out.away_team as Record<string, Record<string, unknown>> | undefined;
  if (H && A) {
    const pair = (h: unknown, a: unknown) => (num(h) !== null && num(a) !== null ? { home: num(h), away: num(a), sum: r2(num(h)! + num(a)!), gap_home_minus_away: r2(num(h)! - num(a)!) } : null);
    const comparison: Record<string, unknown> = {};
    // each average with the field that counts its matches in the team's window
    const COUNT_OF: Record<string, string> = {
      goals_for_avg: 'goals_matches', goals_against_avg: 'goals_matches', goals_total_avg: 'goals_matches',
      xg_for_avg: 'xg_for_matches', xg_against_avg: 'xg_against_matches', xg_total_avg: 'xg_total_matches',
      npxg_for_avg: 'npxg_matches', npxg_against_avg: 'npxg_matches', shots_on_target_for_avg: 'shots_matches', xpts_avg: 'xpts_matches',
    };
    for (const w of ['last_10', 'last_5']) {
      const block: Record<string, unknown> = {};
      for (const [k, c] of Object.entries(COUNT_OF)) {
        const p = pair(H[w]?.[k], A[w]?.[k]);
        if (p) block[k] = { ...p, home_matches: num(H[w]?.[c]), away_matches: num(A[w]?.[c]) };
      }
      comparison[w] = block;
    }
    const table: Record<string, unknown> = {};
    for (const k of ['rank', 'points', 'goalDiff', 'played']) {
      const p = pair(H.league_table?.[k], A.league_table?.[k]);
      if (p) table[k] = { home: p.home, away: p.away, gap_home_minus_away: p.gap_home_minus_away };
    }
    comparison.league_table = Object.keys(table).length ? table : null;
    const rest = pair((H as unknown as Match).rest_days_before_this_match, (A as unknown as Match).rest_days_before_this_match);
    comparison.rest_days = rest ? { home: rest.home, away: rest.away, gap_home_minus_away: rest.gap_home_minus_away } : null;
    out.comparison = comparison;
  }
  const dq = (out.data_quality ?? {}) as Record<string, unknown>;
  out.data_quality = { ...dq, aggregates: AGGREGATES_V21_DEFINITION };
  return out;
}

// ---------------------------------------------------------------- 2. prompt

/** The owner's rule (16 Nov 2026), verbatim. */
export const NO_CALCULATION_RULE_V21 = `Do not calculate, derive, aggregate, subtract,
average, or invent any numerical values.

Use only numerical values explicitly provided
in the input, including precomputed aggregate fields.

If a numerical value is not available in the input,
omit it from the analysis.

Never use numerical calculations in your written explanation.`;

export const AGGREGATES_GUIDE_V21 = `Precomputed aggregates (v2.1, defined in data_quality.aggregates): each recent match carries goals_total, xg_total and npxg_total; each window (last_10, last_5, home_matches_in_last_10 / away_matches_in_last_10) carries goals_for_sum, goals_against_sum, goals_total_sum, goals_total_avg, goal_difference_avg, xg_for_sum, xg_against_sum, xg_total_sum, xg_total_avg with xg_total_matches (and npxg_total_avg); comparison puts the two teams' values side by side with their sum and gap (home minus away) for each window, the league table and rest days. When you want a total, an average or a gap, quote one of these fields; when none fits, describe the values as given without a new number.`;

export const NO_VIG_WORDING_V21 =
  '- When you refer to market_probability_no_vig, match_odds_1x2_no_vig or any no-vig price, write ราคาที่ตัดค่าน้ำแล้ว (the price with the bookmaker margin removed). Never use the word กำไร.';

/**
 * The v2.0 system prompt with the v2.1 additions: the aggregates guide before the output rules, the owner's
 * no-calculation rule and the no-vig wording inside them. HYBRID_SYSTEM_PROMPT itself is not changed.
 */
export function buildHybridSystemPromptV21(base: string = HYBRID_SYSTEM_PROMPT): string {
  const marker = '\n\nOutput rules:\n';
  if (!base.includes(marker)) throw new Error('v2.0 prompt layout changed: "Output rules:" not found');
  const [head, rules] = base.split(marker) as [string, string];
  return `${head}\n\n${AGGREGATES_GUIDE_V21}\n\n${NO_CALCULATION_RULE_V21}${marker}${rules}\n${NO_VIG_WORDING_V21}`;
}
export const HYBRID_SYSTEM_PROMPT_V21 = buildHybridSystemPromptV21();

// ---------------------------------------------------------------- v2.1.1 (production candidate, 16 Nov 2026)

export const HYBRID_PROMPT_VERSION_V211 = 'hybrid-ai-v2.1.1';

/** The owner's rule of 16 Nov 2026 for averages, verbatim. */
export const AVERAGE_COUNT_RULE_V211 = `Whenever citing an average, explicitly state the number of matches used to calculate it.

If the sample count is unavailable, do not cite the average as a factual statement.`;

export const COUNTS_GUIDE_V211 =
  'Every average and sum in the input has its match count beside it: matches, goals_matches, xg_matches / xg_for_matches, xg_against_matches, xg_total_matches, npxg_matches, npxg_total_matches, shots_matches, xpts_matches, and home_matches / away_matches in comparison. Quote the count with the average, for example "เฉลี่ย 1.8 ประตูใน 10 นัด".';

/**
 * The owner's rule of 17 Nov 2026: summary_th is shown to fans under the Game Compass, and fans do not know Elo or the
 * other model terms ("จากอันดับ Elo และตารางที่ดีกว่า"). A wording rule only: the pick logic and the input are unchanged.
 */
export const PLAIN_WORDS_RULE_V211 =
  '- Readers are ordinary football fans, not analysts. In every Thai text field never write Elo, npxG, xPTS, goals_prevented, closing line, no-vig or any input field name, and never quote a rating number. Say what the value means in plain Thai instead: Elo ratings → ความแข็งแกร่งของทีมจากผลงานที่ผ่านมา (for example ทีมที่แข็งแกร่งกว่าจากผลงานที่ผ่านมา, คู่แข่งที่เจอมาแข็งกว่า); xPTS → แต้มที่ควรได้จากโอกาสที่สร้าง; goals_prevented → ผู้รักษาประตูเซฟได้เกินคาด; the closing line → ราคาตลาดก่อนเตะ. xG may stay as xG, explained in the same sentence the first time (คุณภาพโอกาสยิง).';

/** v2.1 plus the sample-count rule (after the no-calculation rule), where the counts are, and the plain-words rule. */
export function buildHybridSystemPromptV211(base: string = HYBRID_SYSTEM_PROMPT): string {
  const v21 = buildHybridSystemPromptV21(base);
  if (!v21.includes(NO_CALCULATION_RULE_V21)) throw new Error('v2.1 prompt layout changed');
  return `${v21.replace(NO_CALCULATION_RULE_V21, `${NO_CALCULATION_RULE_V21}\n\n${AVERAGE_COUNT_RULE_V211}\n\n${COUNTS_GUIDE_V211}`)}\n${PLAIN_WORDS_RULE_V211}`;
}
export const HYBRID_SYSTEM_PROMPT_V211 = buildHybridSystemPromptV211();

/**
 * Data-leakage check of a built input against its prediction_timestamp_utc (v2.1.1). Every dated value the AI sees
 * must be at or before the decision time: recent matches, head-to-head meetings, recent starters, the market movement
 * points and API-Football's prediction. next_match is a scheduled future fixture by design and is not checked.
 * A value after the cut-off is removed and named in data_quality.cutoff_warnings (always present, [] when clean).
 * The repository queries already filter by the decision time, so this is a second line that should never fire.
 */
export function enforceCutoffV211(input: Record<string, unknown>): { input: Record<string, unknown>; warnings: string[] } {
  const out = structuredClone(input);
  const warnings: string[] = [];
  const cutoff = Date.parse(String(out.prediction_timestamp_utc ?? ''));
  if (!Number.isFinite(cutoff)) {
    warnings.push('prediction_timestamp_utc missing: the cut-off could not be checked');
  } else {
    const day = new Date(cutoff).toISOString().slice(0, 10);
    // a date-only value is after the cut-off when its day is after the decision day (a match earlier that day may be finished)
    const afterDay = (d: unknown) => typeof d === 'string' && d.slice(0, 10) > day;
    const afterTime = (t: unknown) => typeof t === 'string' && Number.isFinite(Date.parse(t)) && Date.parse(t) > cutoff;
    for (const key of ['home_team', 'away_team']) {
      const t = out[key] as Record<string, unknown> | undefined;
      if (!t || !Array.isArray(t.recent_matches)) continue;
      const ms = t.recent_matches as Match[];
      const kept = ms.filter((m) => !afterDay(m.date_utc));
      if (kept.length < ms.length) {
        warnings.push(`${key}: ${ms.length - kept.length} recent matches dated after the decision time removed`);
        t.recent_matches = kept;
      }
    }
    const h2h = (out.match_context as { head_to_head?: { meetings?: Match[] } } | undefined)?.head_to_head;
    if (h2h?.meetings) {
      const kept = h2h.meetings.filter((m) => !afterDay(m.date_utc));
      if (kept.length < h2h.meetings.length) {
        warnings.push(`head_to_head: ${h2h.meetings.length - kept.length} meetings dated after the decision time removed`);
        h2h.meetings = kept;
      }
    }
    const rs = out.recent_starters as Record<string, { to_date_utc?: unknown } | unknown> | undefined;
    for (const side of ['home', 'away']) {
      const s = rs?.[side] as { to_date_utc?: unknown } | undefined;
      if (s && afterDay(s.to_date_utc)) warnings.push(`recent_starters.${side}: lineups dated after the decision time`);
    }
    const mv = (out.market as { movement?: Record<string, { as_of_utc?: unknown } | null> } | undefined)?.movement;
    if (mv)
      for (const k of ['opening', 'day_ago', 'now']) {
        if (mv[k] && afterTime(mv[k]!.as_of_utc)) {
          warnings.push(`market.movement.${k}: as of a time after the decision time, removed`);
          mv[k] = null;
        }
      }
    const api = out.api_football_prediction as { collected_at_utc?: unknown } | null | undefined;
    if (api && afterTime(api.collected_at_utc)) {
      warnings.push('api_football_prediction: collected after the decision time, removed');
      out.api_football_prediction = null;
    }
  }
  const dq = (out.data_quality ?? {}) as Record<string, unknown>;
  out.data_quality = { ...dq, cutoff_warnings: warnings };
  return { input: out, warnings };
}

/** The v2.1.1 input: the cut-off check, then the aggregates (computed only from what passed the check). */
export function prepareHybridInputV211(input: Record<string, unknown>): { input: Record<string, unknown>; cutoffWarnings: string[] } {
  const c = enforceCutoffV211(input);
  return { input: withAggregatesV21(c.input), cutoffWarnings: c.warnings };
}

const AVERAGE_WORD = /เฉลี่ย|average|\bavg\b/i;
/**
 * A cited average: the word followed closely by a number ("เฉลี่ย 1.6", "xG รวมเฉลี่ยของซิตี้อยู่ที่ 3.2"). The word
 * alone ("สร้างโอกาสเฉลี่ยไม่สูง"), a far number, or a number before the word (often a line: "เส้น 3.5 และค่าเฉลี่ย…")
 * does not cite an average value; nor does ราคาเฉลี่ย, the median price across bookmakers (not taken over matches).
 */
const CITED_AVERAGE = /(?<!ราคา)(?:เฉลี่ย|average|\bavg\b)[^\d]{0,26}\d/i;
/** Thai number words of a match count (1–12), as the AI writes them: "สิบเกม", "ห้านัดหลัง", "เกมเดียว". */
const THAI_COUNT = '(?:หนึ่ง|สอง|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ(?:เอ็ด|สอง)?)';
const MATCH_COUNT = new RegExp(`\\d+\\s*(?:นัด|เกม|แมตช์|matches?\\b|games?\\b)|${THAI_COUNT}\\s*(?:นัด|เกม|แมตช์)|(?:นัด|เกม|แมตช์)\\s*(?:เดียว|${THAI_COUNT})`, 'i');

/**
 * Text items that cite an average value without saying over how many matches it was taken ("ใน 10 นัด", "5 เกม",
 * "ในสิบเกม", "เกมเดียว"). One item = one Thai text field or list entry, as in locateViolations. A count in digits is
 * checked by the number guard like any number; a count in words (1–12) names a window or a count the input holds.
 */
export function averagesWithoutCount(raw: unknown): Array<{ field: string; excerpt: string }> {
  const out = (raw ?? {}) as Record<string, unknown>;
  return textFields(out)
    .filter(([, text]) => CITED_AVERAGE.test(text) && !MATCH_COUNT.test(text))
    .map(([field, text]) => ({ field, excerpt: excerptAround(text, text.match(AVERAGE_WORD)![0]) }));
}

/** validateHybridOutput (the same number guard, words, schema and market checks) plus the v2.1.1 sample-count rule. */
export function validateHybridOutputV211(raw: unknown, input: Record<string, unknown>, options: readonly HybridOption[]) {
  const v = validateHybridOutput(raw, input, options);
  const counts = v.violations.some((x) => x.startsWith('schema:')) ? [] : averagesWithoutCount(raw).map((a) => `average without match count in ${a.field}`);
  const violations = [...v.violations, ...counts];
  return { ok: violations.length === 0, violations, decision: violations.length ? null : v.decision };
}

// ---------------------------------------------------------------- 3. retry with the exact violations

export interface LocatedViolation {
  kind: 'NUMBER_NOT_IN_INPUT' | 'BANNED_WORD' | 'AVERAGE_WITHOUT_COUNT' | 'OTHER';
  /** the number or word as written; for OTHER the validator's message */
  value: string;
  /** where in the answer: summary_th, options_review[1].counter_evidence[0], … */
  field: string | null;
  /** the text around it */
  excerpt: string | null;
}

/** Every Thai text field of an answer with its path. */
function textFields(out: Record<string, unknown>): Array<[string, string]> {
  const fields: Array<[string, string]> = [];
  for (const k of ['summary_th', 'team_assessment_th', 'match_outlook_th', 'market_comparison_th']) if (typeof out[k] === 'string') fields.push([k, out[k] as string]);
  for (const k of ['supporting_evidence', 'counter_evidence', 'risk_factors', 'missing_data'])
    ((out[k] as unknown[]) ?? []).forEach((t, i) => typeof t === 'string' && fields.push([`${k}[${i}]`, t]));
  ((out.options_review as Array<Record<string, unknown>>) ?? []).forEach((o, i) => {
    for (const k of ['supporting_evidence', 'counter_evidence']) ((o[k] as unknown[]) ?? []).forEach((t, j) => typeof t === 'string' && fields.push([`options_review[${i}].${k}[${j}]`, t]));
  });
  return fields;
}

const excerptAround = (text: string, needle: string) => {
  const i = text.indexOf(needle);
  return i < 0 ? text.slice(0, 120) : `…${text.slice(Math.max(0, i - 70), i + needle.length + 40)}…`;
};

/**
 * The validator's verdict on an answer, with each number and banned word located in its field. The checks are
 * exactly validateHybridOutput's (the same guard); this only says where.
 */
export function locateViolations(raw: unknown, input: Record<string, unknown>, options: readonly HybridOption[], opts: { averageCounts?: boolean } = {}): LocatedViolation[] {
  const v = opts.averageCounts ? validateHybridOutputV211(raw, input, options) : validateHybridOutput(raw, input, options);
  if (v.ok) return [];
  const located: LocatedViolation[] = [];
  const out = (raw ?? {}) as Record<string, unknown>;
  const allowed = allowedNumbers(input);
  const fields = textFields(out);
  for (const [field, text] of fields) {
    for (const n of inventedNumbers(text, allowed)) located.push({ kind: 'NUMBER_NOT_IN_INPUT', value: n, field, excerpt: excerptAround(text, n.replace('%', '')) });
    for (const w of BANNED_WORDS) if (text.includes(w)) located.push({ kind: 'BANNED_WORD', value: w, field, excerpt: excerptAround(text, w) });
  }
  if (opts.averageCounts) for (const a of averagesWithoutCount(raw)) located.push({ kind: 'AVERAGE_WITHOUT_COUNT', value: 'average', field: a.field, excerpt: a.excerpt });
  for (const msg of v.violations)
    if (!msg.startsWith('number not in input') && !msg.startsWith('banned word') && !msg.startsWith('average without match count')) located.push({ kind: 'OTHER', value: msg, field: null, excerpt: null });
  return located;
}

/** The message sent with a retry: what failed, where, why, and how to fix it. The match data is not changed. */
export function retryFeedbackV21(violations: readonly LocatedViolation[]): string {
  const lines = violations.map((v) => {
    if (v.kind === 'NUMBER_NOT_IN_INPUT')
      return `- Number ${v.value} in ${v.field}: ${v.excerpt}\n  Reason: this number is not in the input.\n  Fix: use only numbers that appear in the input (the precomputed aggregate fields included), or remove the number.`;
    if (v.kind === 'BANNED_WORD')
      return `- Word "${v.value}" in ${v.field}: ${v.excerpt}\n  Reason: banned word.\n  Fix: for a no-vig price write ราคาที่ตัดค่าน้ำแล้ว; otherwise rephrase without it.`;
    if (v.kind === 'AVERAGE_WITHOUT_COUNT')
      return `- An average in ${v.field}: ${v.excerpt}\n  Reason: the number of matches behind the average is not stated.\n  Fix: state it with the count given beside that average in the input (for example "ใน 10 นัด"), or do not cite the average.`;
    return `- ${v.value}\n  Fix: follow the output rules for this field.`;
  });
  return `Your previous answer was rejected by the validation check. The match data has not changed. Fix only the problems below and return the full answer again in the same JSON format. Do not calculate any new number.\n\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------- OpenAI decider with a feedback retry

export interface HybridDeciderV21 {
  decide(input: Record<string, unknown>): Promise<RankerResult>;
  /** the same input, the previous answer, and the feedback on it */
  retry(input: Record<string, unknown>, previousOutput: unknown, feedback: string): Promise<RankerResult>;
}

export function createOpenAIHybridDeciderV21(opts: { apiKey: string; model: string; system?: string; fetch?: typeof fetch; timeoutMs?: number }): HybridDeciderV21 {
  const client = new OpenAI({ apiKey: opts.apiKey, timeout: opts.timeoutMs ?? AI_TIMEOUT_MS, maxRetries: 1, ...(opts.fetch ? { fetch: opts.fetch, maxRetries: 0 } : {}) });
  const system = opts.system ?? HYBRID_SYSTEM_PROMPT_V21;
  const call = async (input: OpenAI.Responses.ResponseInput): Promise<RankerResult> => {
    const response = await client.responses.create({
      model: opts.model,
      instructions: system,
      input,
      text: { format: { type: 'json_schema', name: 'hybrid_decision', schema: HYBRID_OUTPUT_SCHEMA as unknown as Record<string, unknown>, strict: true } },
    });
    const usage = { ...(response.usage as unknown as Record<string, unknown>) };
    const stopReason = response.status === 'incomplete' ? `incomplete: ${response.incomplete_details?.reason ?? 'unknown'}` : (response.status ?? null);
    const refusal = response.output.flatMap((item) => (item.type === 'message' ? item.content : [])).find((c) => c.type === 'refusal');
    if (refusal && refusal.type === 'refusal') return { output: null, model: response.model, stopReason: 'refusal', refusal: { category: null, explanation: refusal.refusal }, usage };
    let output: unknown = null;
    try {
      output = JSON.parse(response.output_text);
    } catch {
      output = null;
    }
    return { output, model: response.model, stopReason, refusal: null, usage };
  };
  return {
    decide: (input) => call([{ role: 'user', content: userMessage(input) }]),
    retry: (input, previousOutput, feedback) =>
      call([
        { role: 'user', content: userMessage(input) },
        { role: 'assistant', content: JSON.stringify(previousOutput) },
        { role: 'user', content: feedback },
      ]),
  };
}
