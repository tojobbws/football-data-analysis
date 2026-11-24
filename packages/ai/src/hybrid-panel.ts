/**
 * Hybrid AI v2.2-panel (EXPERIMENTAL, docs/adr/0022-hybrid-v22-adversarial-panel.md). The three answers of the
 * majority vote (ADR 0013) are asked through three different lenses instead of three identical calls:
 *   metrics   underlying numbers and results against the closing line, argued against the market
 *   context   availability, workload and game state, assuming the market has priced public news
 *   defender  the market is efficient and NO_PICK is the default; leave it only when both views converge
 *
 * Everything else is v2.1.1, unchanged: the same input (prepareHybridInputV211), the same output schema, the same
 * validator (validateHybridOutputV211: number guard, match-count rule, banned words), the same feedback retry
 * (retryFeedbackV21) and the same majority rule (HYBRID_MAJORITY). Not in production: hybridVersion() still defaults
 * to v2.1.1, and the rollback stays HYBRID_VERSION=v2.1.1.
 *
 * Prompt caching: the three calls share the same `instructions` (HYBRID_SYSTEM_PROMPT_V22_PANEL) and start the user
 * message with the same userMessage(input); the role text is appended after it, so the long prefix is byte-identical
 * across the three roles.
 */
import OpenAI from 'openai';
import type { RankerResult } from './claude.js';
import { HYBRID_OUTPUT_SCHEMA } from './hybrid.js';
import { HYBRID_SYSTEM_PROMPT_V211, type HybridDeciderV21 } from './hybrid-v21.js';
import { AI_TIMEOUT_MS, userMessage } from './prompt.js';

export const HYBRID_PROMPT_VERSION_V22_PANEL = 'hybrid-ai-v2.2-panel';

export const PANEL_ROLES = ['metrics', 'context', 'defender'] as const;
export type PanelRole = (typeof PANEL_ROLES)[number];

/** The one sentence the panel adds to the v2.1.1 system prompt (shared by every role, so the prefix stays cached). */
export const PANEL_INSTRUCTION_V22 =
  '- Panel role: the end of the user message carries a [PANEL ROLE] section. Follow it while still obeying every rule above (no new calculation, the match count beside every cited average, plain Thai words for fans, the allowed numbers and the output format); the role changes where you look first and how skeptical you are, never these rules.';

export const HYBRID_SYSTEM_PROMPT_V22_PANEL = `${HYBRID_SYSTEM_PROMPT_V211}\n${PANEL_INSTRUCTION_V22}`;

/** Said in every role: the field names are for reading, never for the Thai text. */
const ROLE_FOOTER =
  'The field names above are where to look in the input; never write them in a Thai text field, and say what they mean in plain Thai as the rules above require.';

export const PANEL_ROLE_PROMPTS: Record<PanelRole, string> = {
  metrics: `Role: Underlying Metrics & Closing-Line Auditor.
Look first at the underlying numbers of both teams: npxG, xg_difference, xPTS against actual points, shooting_performance, goals_prevented, opponent_elo_avg, and vs_closing_market (xg_diff_vs_closing_line, xg_total_vs_closing_line).
Adversarial rule: in market_comparison_th and counter_evidence, argue explicitly why the market's main line may already price these numbers, or why the sample behind them is small or noisy.
Choose a side only when the underlying evidence over several matches clearly disagrees with the current main line; otherwise answer NO_PICK.
${ROLE_FOOTER}`,
  context: `Role: Context, Availability & Game-State Auditor.
Look first at the match context: injuries (season_figures, the absences share, recent_starts), confirmed_lineup, starters_workload, rest_days, table_context.stakes, two_legged_tie, derby, neutral_venue and market.movement.
Adversarial rule: assume market.movement has already priced the public team news.
Choose a side only when structural context or high-impact absences still look underpriced against the current main line; otherwise answer NO_PICK.
${ROLE_FOOTER}`,
  defender: `Role: Strict Market Defender (devil's advocate).
Start from the prior that the current main lines are efficiently priced and that NO_PICK is the default answer.
Audit every option for traps first: small match counts, results distorted by red_card_minutes, xG or injury reports listed in data_quality.missing, strong market.movement against the option, and over-reliance on recent goal counts, head-to-head or api_football_prediction.
Leave NO_PICK only when the underlying performance and the match context converge on the same mispricing with no major counter-evidence.
${ROLE_FOOTER}`,
};

/** The role's user message: userMessage(input) first, byte for byte, then the role section. */
export function panelUserMessage(input: Record<string, unknown>, role: PanelRole): string {
  return `${userMessage(input)}\n\n[PANEL ROLE]\n${PANEL_ROLE_PROMPTS[role]}`;
}

export type PanelReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface PanelDeciderOptions {
  apiKey: string;
  /** the OpenAI model of this role (the job resolves OPENAI_PANEL_<ROLE>_MODEL, else OPENAI_HYBRID_MODEL / OPENAI_MODEL) */
  model: string;
  role: PanelRole;
  /** sent as reasoning.effort only when given */
  reasoningEffort?: PanelReasoningEffort;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * One panel lens as a HybridDecider with a feedback retry: the same request as createOpenAIHybridDeciderV21 except the
 * system prompt (the same for all roles) and the role section after the match data.
 */
export function createOpenAIHybridPanelDecider(opts: PanelDeciderOptions): HybridDeciderV21 & { role: PanelRole; model: string } {
  const client = new OpenAI({ apiKey: opts.apiKey, timeout: opts.timeoutMs ?? AI_TIMEOUT_MS, maxRetries: 1, ...(opts.fetch ? { fetch: opts.fetch, maxRetries: 0 } : {}) });
  const call = async (input: OpenAI.Responses.ResponseInput): Promise<RankerResult> => {
    const response = await client.responses.create({
      model: opts.model,
      instructions: HYBRID_SYSTEM_PROMPT_V22_PANEL,
      input,
      ...(opts.reasoningEffort ? { reasoning: { effort: opts.reasoningEffort } } : {}),
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
    role: opts.role,
    model: opts.model,
    decide: (input) => call([{ role: 'user', content: panelUserMessage(input, opts.role) }]),
    retry: (input, previousOutput, feedback) =>
      call([
        { role: 'user', content: panelUserMessage(input, opts.role) },
        { role: 'assistant', content: JSON.stringify(previousOutput) },
        { role: 'user', content: feedback },
      ]),
  };
}
