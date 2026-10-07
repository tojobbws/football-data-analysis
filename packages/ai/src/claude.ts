/**
 * Claude call for the shadow ranking. One structured-output request per published analysis.
 * Jobs depend on the `ShadowRanker` interface, so tests run with a fake and never call the API.
 */
import Anthropic from '@anthropic-ai/sdk';
import { AI_MODEL, OUTPUT_SCHEMA, SYSTEM_PROMPT, userMessage } from './prompt.js';

export interface RankerResult {
  /** parsed JSON answer, or null on refusal / unparseable text */
  output: unknown;
  /** model that actually answered (differs from AI_MODEL when the server-side fallback ran) */
  model: string;
  stopReason: string | null;
  refusal: { category: string | null; explanation: string | null } | null;
  usage: Record<string, unknown>;
}

export interface ShadowRanker {
  rank(input: Record<string, unknown>): Promise<RankerResult>;
}

export function createClaudeRanker(opts: { apiKey?: string; model?: string } = {}): ShadowRanker {
  const client = new Anthropic({ apiKey: opts.apiKey });
  const model = opts.model ?? AI_MODEL;
  return {
    async rank(input) {
      const response = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        // refusals are re-run on Anthropic's recommended fallback model server-side
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage(input) }],
      });

      const usage = { ...(response.usage as unknown as Record<string, unknown>) };
      if (response.stop_reason === 'refusal') {
        const d = response.stop_details as { category?: string | null; explanation?: string | null } | null;
        return { output: null, model: response.model, stopReason: response.stop_reason, refusal: { category: d?.category ?? null, explanation: d?.explanation ?? null }, usage };
      }
      const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      let output: unknown = null;
      try {
        output = JSON.parse(text);
      } catch {
        output = null;
      }
      return { output, model: response.model, stopReason: response.stop_reason, refusal: null, usage };
    },
  };
}
