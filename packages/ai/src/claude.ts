/**
 * Claude calls with structured output. One request per fixture; jobs depend on the small
 * `ShadowRanker` / `PreviewWriter` interfaces, so tests run with fakes and never call the API.
 */
import Anthropic from '@anthropic-ai/sdk';
import { isPersistentOpenAIError } from './openai.js';
import { AI_MODEL, AI_TIMEOUT_MS, OUTPUT_SCHEMA, SYSTEM_PROMPT, userMessage } from './prompt.js';
import { PREVIEW_OUTPUT_SCHEMA, PREVIEW_SYSTEM_PROMPT } from './preview.js';
import { PICK_NOTE_OUTPUT_SCHEMA, PICK_NOTE_SYSTEM_PROMPT } from './pick-note.js';
import { HYBRID_AI_MODEL, HYBRID_OUTPUT_SCHEMA, HYBRID_SYSTEM_PROMPT } from './hybrid.js';

export interface RankerResult {
  /** parsed JSON answer, or null on refusal / unparseable text */
  output: unknown;
  /** model that answered (as reported by the API) */
  model: string;
  stopReason: string | null;
  refusal: { category: string | null; explanation: string | null } | null;
  usage: Record<string, unknown>;
}

export interface ShadowRanker {
  rank(input: Record<string, unknown>): Promise<RankerResult>;
}

export interface PreviewWriter {
  write(input: Record<string, unknown>): Promise<RankerResult>;
}

export interface StructuredCallOptions {
  apiKey?: string;
  model?: string;
  system: string;
  schema: Record<string, unknown>;
  effort?: 'low' | 'medium' | 'high';
}

/** A JSON-schema-constrained Claude call; refusals and unparseable text come back as data, never throw. */
export function createStructuredCall(opts: StructuredCallOptions): (input: Record<string, unknown>) => Promise<RankerResult> {
  const client = new Anthropic({ apiKey: opts.apiKey, timeout: AI_TIMEOUT_MS, maxRetries: 1 });
  const model = opts.model ?? AI_MODEL;
  return async (input) => {
    // Claude Haiku 5.5 has no server-side refusal fallback: a refusal comes back as data (below)
    const response = await client.messages.create({
      model,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: opts.effort ?? 'medium', format: { type: 'json_schema', schema: opts.schema } },
      system: opts.system,
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
  };
}

/**
 * An API error that the next request would hit too (bad request incl. "credit balance is too low",
 * bad key, no permission): a job stops calling the API for the rest of its run instead of
 * waiting on every fixture. Rate limits, overload and network errors are not.
 */
export function isPersistentApiError(err: unknown): boolean {
  return err instanceof Anthropic.BadRequestError || err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError || isPersistentOpenAIError(err);
}

export function createClaudeRanker(opts: { apiKey?: string; model?: string } = {}): ShadowRanker {
  return { rank: createStructuredCall({ ...opts, system: SYSTEM_PROMPT, schema: OUTPUT_SCHEMA }) };
}

export function createClaudePreviewWriter(opts: { apiKey?: string; model?: string } = {}): PreviewWriter {
  return { write: createStructuredCall({ ...opts, system: PREVIEW_SYSTEM_PROMPT, schema: PREVIEW_OUTPUT_SCHEMA }) };
}

export function createClaudePickNoteWriter(opts: { apiKey?: string; model?: string } = {}): PreviewWriter {
  return { write: createStructuredCall({ ...opts, system: PICK_NOTE_SYSTEM_PROMPT, schema: PICK_NOTE_OUTPUT_SCHEMA }) };
}

export interface HybridDecider {
  decide(input: Record<string, unknown>): Promise<RankerResult>;
}

export function createClaudeHybridDecider(opts: { apiKey?: string; model?: string } = {}): HybridDecider {
  return { decide: createStructuredCall({ ...opts, model: opts.model ?? HYBRID_AI_MODEL, system: HYBRID_SYSTEM_PROMPT, schema: HYBRID_OUTPUT_SCHEMA as unknown as Record<string, unknown> }) };
}
