import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { createOpenAIStructuredCall, isPersistentApiError } from '../src/index.js';

const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };

/** fake Responses API: returns `body` (status 200) or an error status, and keeps the request */
function fakeFetch(status: number, body: unknown) {
  const seen: Array<Record<string, unknown>> = [];
  const f = (async (_url: unknown, init?: { body?: string }) => {
    seen.push(JSON.parse(init?.body ?? '{}'));
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { f, seen };
}

const response = (content: unknown[], over: Record<string, unknown> = {}) => ({
  id: 'resp_1',
  object: 'response',
  model: 'gpt-test',
  status: 'completed',
  incomplete_details: null,
  output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content }],
  usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
  ...over,
});

describe('OpenAI structured call', () => {
  it('sends the system prompt as instructions and the schema as a strict json_schema format; parses the JSON answer', async () => {
    const { f, seen } = fakeFetch(200, response([{ type: 'output_text', text: '{"answer":"11 คน"}', annotations: [] }]));
    const call = createOpenAIStructuredCall({ apiKey: 'k', model: 'gpt-test', system: 'SYS', schemaName: 'match_preview', schema, fetch: f });
    const r = await call({ q: 1 });
    expect(r).toMatchObject({ output: { answer: '11 คน' }, model: 'gpt-test', stopReason: 'completed', refusal: null });
    expect(seen[0]).toMatchObject({
      model: 'gpt-test',
      instructions: 'SYS',
      input: 'Match data (JSON):\n{"q":1}',
      text: { format: { type: 'json_schema', name: 'match_preview', schema, strict: true } },
    });
  });

  it('a refusal comes back as data, never as output', async () => {
    const { f } = fakeFetch(200, response([{ type: 'refusal', refusal: 'cannot help' }]));
    const r = await createOpenAIStructuredCall({ apiKey: 'k', model: 'gpt-test', system: 'S', schemaName: 'x', schema, fetch: f })({});
    expect(r).toMatchObject({ output: null, stopReason: 'refusal', refusal: { category: null, explanation: 'cannot help' } });
  });

  it('a cut-off answer is unparseable, not an error', async () => {
    const { f } = fakeFetch(200, response([{ type: 'output_text', text: '{"answer":"11', annotations: [] }], { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }));
    const r = await createOpenAIStructuredCall({ apiKey: 'k', model: 'gpt-test', system: 'S', schemaName: 'x', schema, fetch: f })({});
    expect(r).toMatchObject({ output: null, stopReason: 'incomplete: max_output_tokens' });
  });

  it('no quota / bad key stop the AI for the run; a plain rate limit does not', async () => {
    const err = async (status: number, code: string) => {
      const { f } = fakeFetch(status, { error: { message: code, type: code, code } });
      return createOpenAIStructuredCall({ apiKey: 'k', model: 'gpt-test', system: 'S', schemaName: 'x', schema, fetch: f })({}).catch((e: unknown) => e);
    };
    const quota = await err(429, 'insufficient_quota');
    expect(quota).toBeInstanceOf(OpenAI.RateLimitError);
    expect(isPersistentApiError(quota)).toBe(true);
    expect(isPersistentApiError(await err(401, 'invalid_api_key'))).toBe(true);
    expect(isPersistentApiError(await err(429, 'rate_limit_exceeded'))).toBe(false);
  });
});
