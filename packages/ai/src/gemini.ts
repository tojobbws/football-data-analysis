/**
 * Google Gemini (generateContent REST) behind the same `HybridDeciderV21` interface as the OpenAI decider: the prompt,
 * the JSON schema, the validator and the feedback retry stay the same; only the model answering changes. Used by the
 * Gemini Decision shadow (owner, 2026-11-23): never published.
 * Refusals, blocked prompts and unparseable text come back as data, never throw; HTTP errors throw GeminiApiError.
 */
import type { RankerResult } from './claude.js';
import { HYBRID_OUTPUT_SCHEMA } from './hybrid.js';
import { HYBRID_SYSTEM_PROMPT_V211, type HybridDeciderV21 } from './hybrid-v21.js';
import { AI_TIMEOUT_MS, userMessage } from './prompt.js';

export const GEMINI_DECISION_MODEL = 'gemini-3.8-flash';
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiApiError extends Error {
  constructor(
    readonly status: number,
    readonly apiStatus: string | null,
    message: string,
  ) {
    super(`Gemini ${status}${apiStatus ? ` ${apiStatus}` : ''}: ${message}`);
    this.name = 'GeminiApiError';
  }
}

/** 429 that is not a rate limit: the project cannot pay or has used its quota for the day */
const NO_CREDIT_MESSAGE = /billing|prepay|credit|quota (?:exceeded|exhausted)|exceeded your current quota|per day/i;

/**
 * Gemini errors the next request would hit too: bad request, bad key, no permission, unknown model, or no credit /
 * daily quota left. A plain rate limit, an overload (500/503) or a network error is not persistent.
 */
export function isPersistentGeminiError(err: unknown): boolean {
  if (!(err instanceof GeminiApiError)) return false;
  if ([400, 401, 403, 404].includes(err.status)) return true;
  return err.status === 429 && NO_CREDIT_MESSAGE.test(err.message);
}

type Content = { role: 'user' | 'model'; parts: Array<{ text: string }> };

export function createGeminiHybridDeciderV21(opts: { apiKey: string; model?: string; system?: string; fetch?: typeof fetch; timeoutMs?: number }): HybridDeciderV21 {
  const model = opts.model ?? GEMINI_DECISION_MODEL;
  const system = opts.system ?? HYBRID_SYSTEM_PROMPT_V211;
  const doFetch = opts.fetch ?? fetch;
  const call = async (contents: Content[]): Promise<RankerResult> => {
    const res = await doFetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': opts.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { responseMimeType: 'application/json', responseJsonSchema: HYBRID_OUTPUT_SCHEMA },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? AI_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text();
      let apiStatus: string | null = null;
      let message = text.slice(0, 400);
      try {
        const e = JSON.parse(text).error;
        apiStatus = e?.status ?? null;
        message = String(e?.message ?? message).slice(0, 400);
      } catch {
        /* not JSON */
      }
      throw new GeminiApiError(res.status, apiStatus, message);
    }
    const j = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
      promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
      usageMetadata?: Record<string, unknown>;
      modelVersion?: string;
    };
    const usage = { ...(j.usageMetadata ?? {}) };
    const answeredBy = j.modelVersion ?? model;
    if (j.promptFeedback?.blockReason) {
      return { output: null, model: answeredBy, stopReason: 'refusal', refusal: { category: j.promptFeedback.blockReason, explanation: j.promptFeedback.blockReasonMessage ?? null }, usage };
    }
    const cand = j.candidates?.[0];
    const finish = cand?.finishReason ?? null;
    if (finish && ['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(finish)) {
      return { output: null, model: answeredBy, stopReason: 'refusal', refusal: { category: finish, explanation: null }, usage };
    }
    const text = (cand?.content?.parts ?? []).filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
    let output: unknown = null;
    try {
      output = JSON.parse(text);
    } catch {
      output = null;
    }
    return { output, model: answeredBy, stopReason: finish, refusal: null, usage };
  };
  return {
    decide: (input) => call([{ role: 'user', parts: [{ text: userMessage(input) }] }]),
    retry: (input, previousOutput, feedback) =>
      call([
        { role: 'user', parts: [{ text: userMessage(input) }] },
        { role: 'model', parts: [{ text: JSON.stringify(previousOutput) }] },
        { role: 'user', parts: [{ text: feedback }] },
      ]),
  };
}
