/**
 * Decisions v2 (experiment, shadow only; .scratch/decisions-v2/spec.md): the analyst reads the same stored raw input
 * as the Hybrid AI and answers in categories through OpenAI's Decisions API. The engine (@fp/analysis decisions-v2)
 * turns those categories into probabilities and expected return; the AI never writes a number.
 *
 * Questions (one request, output free):
 *   margin_vs_market         score, 5 levels: the goal margin against the main handicap line (the view)
 *   total_vs_market          score, 5 levels: total goals against the main total (the view)
 *   performance, availability, situation, market_move  score, 5 levels from the away team to the home team (evidence)
 *   scoring_data, game_state score, 5 levels from fewer goals to more than the main total (evidence)
 *   data_sufficient          predicate: the data is enough to judge (gate below 0.5)
 *   lineup_uncertain         predicate: who plays is unclear (recorded, an assumption)
 * Unlike v1, no question contains a market probability, and Hybrid's answer is never part of the input.
 */
import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import {
  decideV2,
  DECISIONS_V2_RULES,
  estimateOptions,
  hybridInputFit,
  hybridInputOptions,
  hybridInputQuality,
  MARGIN_LEVELS,
  optionEvidence,
  TOTAL_LEVELS,
  type DecisionRulesV2,
  type DecisionV2,
  type FactorReading,
  type MarginLevel,
  type MarketFit,
  type MarketView,
  type OptionEvidence,
  type TotalLevel,
} from '@fp/analysis';
import { HYBRID_SYSTEM_PROMPT, HYBRID_V20_GUIDE } from './hybrid.js';
import { AGGREGATES_GUIDE_V21, COUNTS_GUIDE_V211 } from './hybrid-v21.js';
import { userMessage } from './prompt.js';

export const DECISIONS_V2_PROMPT_VERSION = 'decisions-v2-prompt-0.1';
export const DECISIONS_V2_MODEL = 'gpt-6-luna';

type Input = Record<string, any>;

// ---------------------------------------------------------------- guide

const OU_CHOICE_RULE = /An Over or Under choice needs more than recent goal counts\.[^\n]*\n\n/;

export const DECISIONS_V2_ROLE = `Your task here is not to choose a bet. Read the match data and judge two things against the market's main lines: whether the goal margin will lean toward either team beyond what the main Asian handicap line already prices, and whether there will be more or fewer goals than the main total. Then read a few factors that explain your judgement.

The market price already contains much public information: in most matches the honest answer is AS_MARKET, and a level away from it needs evidence the price may not reflect, for example a team whose xG keeps beating or missing the closing line, an important absence, or a clear gap in rest or in what is at stake. When the evidence is mixed or thin, spread your probability over the levels instead of leaning. Do not automatically favour the favourite, the underdog, more goals or fewer goals. Do not use outside knowledge about these teams or players; data that is missing is unknown, never zero.`;

/** The data guide the Hybrid AI reads, without its choice and output instructions, pinned to the input's fields. */
export function decisionsV2Guide(input: Input): string {
  const marker = '\n\nCompare the available choices:';
  if (!HYBRID_SYSTEM_PROMPT.includes(marker)) throw new Error('Hybrid prompt layout changed: "Compare the available choices:" not found');
  let guide = HYBRID_SYSTEM_PROMPT.split(marker)[0]!.replace(OU_CHOICE_RULE, '');
  if (!('elo_ratings' in input)) guide = guide.replace(`${HYBRID_V20_GUIDE}\n\n`, '');
  if (input.data_quality?.aggregates) guide += `\n\n${AGGREGATES_GUIDE_V21}\n\n${COUNTS_GUIDE_V211}`;
  return `${guide}\n\n${DECISIONS_V2_ROLE}`;
}

const signed = (x: number) => (x > 0 ? `+${x}` : String(x));

/** The two main lines in words, from the input (no number the input does not already hold). */
export function mainLinesText(input: Input): string {
  const { home, away } = input.match as { home: string; away: string };
  const line = Number(input.market?.asian_handicap?.home_line ?? NaN);
  const fav = input.market?.asian_handicap?.favourite;
  const ah = Number.isFinite(line) && input.market?.asian_handicap?.options?.length
    ? `the main Asian handicap line is ${home} ${signed(line)} (${away} ${signed(line === 0 ? 0 : -line)}); the favourite is ${fav ?? 'neither'}`
    : 'there is no main Asian handicap line';
  const total = input.market?.over_under?.options?.length ? input.market.over_under.line : null;
  return `Main lines at the decision time: ${ah}; the main total is ${total ?? 'not available'}.`;
}

// ---------------------------------------------------------------- questions

const TEAM_FACTOR_LEVELS = ['AWAY_CLEARLY', 'AWAY_SLIGHTLY', 'NEUTRAL', 'HOME_SLIGHTLY', 'HOME_CLEARLY'] as const;
const GOALS_FACTOR_LEVELS = ['FEWER_CLEARLY', 'FEWER_SLIGHTLY', 'NEUTRAL', 'MORE_SLIGHTLY', 'MORE_CLEARLY'] as const;

/** Evidence questions: recorded and shown as support or conflict per option; they do not move the numbers. */
export const DECISIONS_V2_FACTORS = [
  { name: 'performance', kind: 'TEAM', text: 'Underlying performance beyond results (xG and shots, results and xG against the closing line, the strength of the opponents behind each form run), compared with what the market already prices. Which team does it favour?' },
  { name: 'availability', kind: 'TEAM', text: "Absences and their weight (injured players' share of their team's goals and minutes, regular starters missing, a confirmed lineup if there is one). Which team does it favour?" },
  { name: 'situation', kind: 'TEAM', text: 'The situation: rest days and congestion, what is at stake in the table or the tie, a neutral venue, a derby. Which team does it favour?' },
  { name: 'market_move', kind: 'TEAM', text: 'Market movement since the opening and over the last day (handicap line, win chances). Toward which team has it moved?' },
  { name: 'scoring_data', kind: 'GOALS', text: "Both teams' chance creation and chances conceded (xG, npxG, shots on target, totals against the closing total line) compared with the main total. Do they point to fewer or more goals?" },
  { name: 'game_state', kind: 'GOALS', text: 'What the teams need from the match (a team that must chase, one protecting a lead in a tie, nothing at stake, a derby) and how that may open or close the game, compared with the main total. Does it point to fewer or more goals?' },
] as const;

export function decisionsV2Questions(input: Input): OpenAI.DecisionCreateParams['questions'] {
  const { home, away } = input.match as { home: string; away: string };
  const teamLevels = (labels: readonly string[], neutral: string) => [
    { label: labels[0]!, description: `clearly favours ${away}` },
    { label: labels[1]!, description: `slightly favours ${away}` },
    { label: labels[2]!, description: neutral },
    { label: labels[3]!, description: `slightly favours ${home}` },
    { label: labels[4]!, description: `clearly favours ${home}` },
  ];
  const goalsLevels = (labels: readonly string[], neutral: string) => [
    { label: labels[0]!, description: 'clearly fewer goals than the main total' },
    { label: labels[1]!, description: 'slightly fewer goals than the main total' },
    { label: labels[2]!, description: neutral },
    { label: labels[3]!, description: 'slightly more goals than the main total' },
    { label: labels[4]!, description: 'clearly more goals than the main total' },
  ];
  const noAh = input.market?.asian_handicap?.options?.length ? '' : ' There is no main handicap line: answer AS_MARKET.';
  const noOu = input.market?.over_under?.options?.length ? '' : ' There is no main total: answer AS_MARKET.';
  return [
    {
      type: 'score',
      name: 'margin_vs_market',
      instructions: `Against the main Asian handicap line, which way will the goal margin between ${home} and ${away} go beyond what that line already prices?${noAh}`,
      levels: teamLevels(MARGIN_LEVELS, 'the line already prices the margin well; the data gives no clear reason to differ'),
    },
    {
      type: 'score',
      name: 'total_vs_market',
      instructions: `Against the main total, will the match have fewer or more goals than that line already prices?${noOu}`,
      levels: goalsLevels(TOTAL_LEVELS, 'the main total already prices the goals well; the data gives no clear reason to differ'),
    },
    ...DECISIONS_V2_FACTORS.map((f) => ({
      type: 'score' as const,
      name: f.name,
      instructions: f.text,
      levels: f.kind === 'TEAM' ? teamLevels(TEAM_FACTOR_LEVELS, 'favours neither, is already in the price, or is unknown') : goalsLevels(GOALS_FACTOR_LEVELS, 'neither, already in the price, or unknown'),
    })),
    {
      type: 'predicate',
      name: 'data_sufficient',
      instructions: 'The data is enough to judge both teams against the market: several recent matches with xG or shots for each team, the strength of the opponents they faced, and the player situation known well enough.',
    },
    {
      type: 'predicate',
      name: 'lineup_uncertain',
      instructions: 'Whether important players will play is uncertain at this time (no confirmed lineup and key starters doubtful, or no injury coverage for this competition).',
    },
  ];
}

export function decisionsV2Request(input: Input): OpenAI.DecisionCreateParams {
  return {
    model: DECISIONS_V2_MODEL,
    input: [{ role: 'user', content: [{ type: 'input_text', text: decisionsV2Guide(input) }, { type: 'input_text', text: `${userMessage(input)}\n\n${mainLinesText(input)}` }] }],
    questions: decisionsV2Questions(input),
  };
}

// ---------------------------------------------------------------- answers

export interface DecisionsV2Answers {
  view: MarketView;
  dataSufficient: number | null;
  lineupUncertain: number | null;
  factors: FactorReading[];
  refusals: string[];
}

type Answer = OpenAI.Decision['answers'][number];

/** null when either view question is missing, refused or not a distribution over its five levels. */
export function parseDecisionsV2Answers(answers: readonly Answer[]): DecisionsV2Answers | null {
  const by = new Map(answers.map((a) => [a.name ?? '', a]));
  const refusals = answers.filter((a) => a.type === 'refusal').map((a) => a.name ?? '?');
  const levels = (name: string, labels: readonly string[]): number[] | null => {
    const a = by.get(name);
    if (!a || a.type !== 'score') return null;
    const p = labels.map((l) => a.probabilities.find((x) => x.label === l)?.probability ?? 0);
    const s = p.reduce((x, y) => x + y, 0);
    return p.every((x) => Number.isFinite(x) && x >= 0) && Math.abs(s - 1) <= 0.05 ? p : null;
  };
  const margin = levels('margin_vs_market', MARGIN_LEVELS);
  const total = levels('total_vs_market', TOTAL_LEVELS);
  if (!margin || !total) return null;
  const factors: FactorReading[] = [];
  for (const f of DECISIONS_V2_FACTORS) {
    const p = levels(f.name, f.kind === 'TEAM' ? TEAM_FACTOR_LEVELS : GOALS_FACTOR_LEVELS);
    if (p) factors.push({ name: f.name, kind: f.kind, probabilities: p });
  }
  const pred = (name: string) => {
    const a = by.get(name);
    return a && a.type === 'predicate' ? a.probability : null;
  };
  return {
    view: {
      margin: Object.fromEntries(MARGIN_LEVELS.map((k, i) => [k, margin[i]!])) as Record<MarginLevel, number>,
      total: Object.fromEntries(TOTAL_LEVELS.map((k, i) => [k, total[i]!])) as Record<TotalLevel, number>,
    },
    dataSufficient: pred('data_sufficient'),
    lineupUncertain: pred('lineup_uncertain'),
    factors,
    refusals,
  };
}

// ---------------------------------------------------------------- one fixture, end to end

export interface DecisionsV2Client {
  decide(body: OpenAI.DecisionCreateParams): Promise<OpenAI.Decision>;
}

export function createDecisionsV2Client(opts: { apiKey: string; timeoutMs?: number }): DecisionsV2Client {
  const client = new OpenAI({ apiKey: opts.apiKey, timeout: opts.timeoutMs ?? 60_000, maxRetries: 2 });
  return { decide: (body) => client.decisions.create(body) };
}

export interface DecisionsV2Result {
  status: 'OK' | 'INVALID' | 'ERROR';
  note: string | null;
  fit: MarketFit | null;
  answers: DecisionsV2Answers | null;
  decision: DecisionV2 | null;
  evidence: OptionEvidence[];
  request: OpenAI.DecisionCreateParams | null;
  requestSha256: string | null;
  response: OpenAI.Decision | null;
  model: string | null;
}

/**
 * One fixture: market fit from the stored input, the Decisions call, then the engine. Without both main lines there
 * is nothing to price and no call is made (status OK, NO_PICK, reason MARKET_FIT_FAILED). An API failure throws.
 */
export async function runDecisionsV2(input: Input, client: DecisionsV2Client, rules: DecisionRulesV2 = DECISIONS_V2_RULES): Promise<DecisionsV2Result> {
  const options = hybridInputOptions(input);
  const quality = hybridInputQuality(input);
  const fit = hybridInputFit(input);
  const empty = { answers: null, evidence: [], request: null, requestSha256: null, response: null, model: null };
  if (!fit || !options.length) {
    const nullFit: MarketFit = { lambdaHome: 0, lambdaAway: 0, rho: 0, residual: { ah: NaN, ou: NaN, draw: null }, ok: false };
    const decision = { ...decideV2(nullFit, [], quality, rules), noPickReasons: ['MARKET_FIT_FAILED' as const] };
    return { ...empty, status: 'OK', note: 'no market fit: a main line is missing', fit, decision };
  }
  const request = decisionsV2Request(input);
  const requestSha256 = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const response = await client.decide(request);
  const answers = parseDecisionsV2Answers(response.answers);
  if (!answers) return { ...empty, status: 'INVALID', note: 'view questions missing, refused or not a distribution', fit, decision: null, request, requestSha256, response, model: response.model };
  const estimates = estimateOptions(fit, options, answers.view);
  if (!estimates) return { ...empty, status: 'INVALID', note: 'view is not a distribution', fit, decision: null, request, requestSha256, response, model: response.model };
  const decision = decideV2(fit, estimates, { ...quality, dataSufficient: answers.dataSufficient }, rules);
  return { status: 'OK', note: null, fit, answers, decision, evidence: optionEvidence(options, answers.factors), request, requestSha256, response, model: response.model };
}
