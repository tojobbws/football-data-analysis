/**
 * OpenAI (GPT) calls with structured output, behind the same `ShadowRanker` / `PreviewWriter`
 * interfaces as the Claude client: the prompts, the JSON schemas and every guard stay the same.
 * Refusals and unparseable text come back as data, never throw.
 */
import OpenAI from 'openai';
import type { HybridDecider, PreviewWriter, RankerResult, ShadowRanker } from './claude.js';
import { HYBRID_OUTPUT_SCHEMA, HYBRID_SYSTEM_PROMPT } from './hybrid.js';
import { OUTPUT_SCHEMA, SYSTEM_PROMPT, userMessage } from './prompt.js';
import { PREVIEW_OUTPUT_SCHEMA, PREVIEW_SYSTEM_PROMPT } from './preview.js';
import { PICK_NOTE_OUTPUT_SCHEMA, PICK_NOTE_SYSTEM_PROMPT } from './pick-note.js';
import { AI_TIMEOUT_MS } from './prompt.js';

export interface OpenAICallOptions {
  apiKey: string;
  model: string;
  system: string;
  /** a-z, 0-9, _ and - only (OpenAI's response format name) */
  schemaName: string;
  schema: Record<string, unknown>;
  /** tests only */
  fetch?: typeof fetch;
}

export function createOpenAIStructuredCall(opts: OpenAICallOptions): (input: Record<string, unknown>) => Promise<RankerResult> {
  const client = new OpenAI({ apiKey: opts.apiKey, timeout: AI_TIMEOUT_MS, maxRetries: 1, ...(opts.fetch ? { fetch: opts.fetch, maxRetries: 0 } : {}) });
  return async (input) => {
    const response = await client.responses.create({
      model: opts.model,
      instructions: opts.system,
      input: userMessage(input),
      text: { format: { type: 'json_schema', name: opts.schemaName, schema: opts.schema, strict: true } },
    });

    const usage = { ...(response.usage as unknown as Record<string, unknown>) };
    const stopReason = response.status === 'incomplete' ? `incomplete: ${response.incomplete_details?.reason ?? 'unknown'}` : (response.status ?? null);
    const refusal = response.output.flatMap((item) => (item.type === 'message' ? item.content : [])).find((c) => c.type === 'refusal');
    if (refusal && refusal.type === 'refusal') {
      return { output: null, model: response.model, stopReason: 'refusal', refusal: { category: null, explanation: refusal.refusal }, usage };
    }
    let output: unknown = null;
    try {
      output = JSON.parse(response.output_text);
    } catch {
      output = null;
    }
    return { output, model: response.model, stopReason, refusal: null, usage };
  };
}

export function createOpenAIRanker(opts: { apiKey: string; model: string }): ShadowRanker {
  return { rank: createOpenAIStructuredCall({ ...opts, system: SYSTEM_PROMPT, schemaName: 'shadow_ranking', schema: OUTPUT_SCHEMA as unknown as Record<string, unknown> }) };
}

export function createOpenAIPreviewWriter(opts: { apiKey: string; model: string }): PreviewWriter {
  return { write: createOpenAIStructuredCall({ ...opts, system: PREVIEW_SYSTEM_PROMPT, schemaName: 'match_preview', schema: PREVIEW_OUTPUT_SCHEMA as unknown as Record<string, unknown> }) };
}

export function createOpenAIPickNoteWriter(opts: { apiKey: string; model: string }): PreviewWriter {
  return { write: createOpenAIStructuredCall({ ...opts, system: PICK_NOTE_SYSTEM_PROMPT, schemaName: 'pick_note', schema: PICK_NOTE_OUTPUT_SCHEMA as unknown as Record<string, unknown> }) };
}

/** OpenAI errors the next request would hit too: bad request, bad key, no permission, or no quota left. */
export function isPersistentOpenAIError(err: unknown): boolean {
  if (err instanceof OpenAI.BadRequestError || err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) return true;
  return err instanceof OpenAI.RateLimitError && err.code === 'insufficient_quota';
}

export function createOpenAIHybridDecider(opts: { apiKey: string; model: string }): HybridDecider {
  return { decide: createOpenAIStructuredCall({ ...opts, system: HYBRID_SYSTEM_PROMPT, schemaName: 'hybrid_decision', schema: HYBRID_OUTPUT_SCHEMA as unknown as Record<string, unknown> }) };
}
