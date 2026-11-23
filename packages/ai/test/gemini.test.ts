/** The Gemini Hybrid decider over a fake fetch: request shape, answer parsing, refusals and errors. */
import { describe, expect, it } from 'vitest';
import { createGeminiHybridDeciderV21, GeminiApiError, HYBRID_SYSTEM_PROMPT_V211, isPersistentApiError } from '../src/index.js';

type Sent = { url: string; body: any; headers: Record<string, string> };

function fakeFetch(reply: () => Response) {
  const sent: Sent[] = [];
  const f = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    return reply();
  }) as unknown as typeof fetch;
  return { f, sent };
}

const ok = (parts: Array<{ text: string; thought?: boolean }>, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 }, modelVersion: 'gemini-3.8-flash', ...extra }), { status: 200 });

describe('createGeminiHybridDeciderV21', () => {
  it('sends the v2.1.1 prompt and schema and parses the answer, skipping thought parts', async () => {
    const { f, sent } = fakeFetch(() => ok([{ text: 'thinking...', thought: true }, { text: '{"side":"OVER"}' }]));
    const d = createGeminiHybridDeciderV21({ apiKey: 'k', fetch: f });
    const res = await d.decide({ match: { home: 'A' } });
    expect(res).toMatchObject({ output: { side: 'OVER' }, model: 'gemini-3.8-flash', stopReason: 'STOP', refusal: null, usage: { promptTokenCount: 100 } });
    expect(sent[0]!.url).toContain('/models/gemini-3.8-flash:generateContent');
    expect(sent[0]!.headers['x-goog-api-key']).toBe('k');
    expect(sent[0]!.body.systemInstruction.parts[0].text).toBe(HYBRID_SYSTEM_PROMPT_V211);
    expect(sent[0]!.body.generationConfig.responseMimeType).toBe('application/json');
    expect(sent[0]!.body.contents).toHaveLength(1);
  });

  it('asks again with the previous answer and the feedback as a three-turn conversation', async () => {
    const { f, sent } = fakeFetch(() => ok([{ text: '{"side":"UNDER"}' }]));
    await createGeminiHybridDeciderV21({ apiKey: 'k', fetch: f }).retry({ match: { home: 'A' } }, { side: 'OVER' }, 'fix it');
    expect(sent[0]!.body.contents.map((c: any) => c.role)).toEqual(['user', 'model', 'user']);
    expect(sent[0]!.body.contents[2].parts[0].text).toBe('fix it');
  });

  it('returns unparseable text and refusals as data', async () => {
    const bad = await createGeminiHybridDeciderV21({ apiKey: 'k', fetch: fakeFetch(() => ok([{ text: 'not json' }])).f }).decide({});
    expect(bad.output).toBeNull();
    const blocked = await createGeminiHybridDeciderV21({ apiKey: 'k', fetch: fakeFetch(() => new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }))).f }).decide({});
    expect(blocked).toMatchObject({ output: null, stopReason: 'refusal', refusal: { category: 'SAFETY' } });
  });

  it('throws GeminiApiError on HTTP errors; bad key and no credit are persistent, overload is not', async () => {
    const err = (status: number, s: string, message: string) => () => new Response(JSON.stringify({ error: { code: status, status: s, message } }), { status });
    await expect(createGeminiHybridDeciderV21({ apiKey: 'k', fetch: fakeFetch(err(400, 'INVALID_ARGUMENT', 'API key not valid')).f }).decide({})).rejects.toSatisfy((e) => e instanceof GeminiApiError && isPersistentApiError(e));
    await expect(createGeminiHybridDeciderV21({ apiKey: 'k', fetch: fakeFetch(err(503, 'UNAVAILABLE', 'The model is overloaded')).f }).decide({})).rejects.toSatisfy((e) => e instanceof GeminiApiError && !isPersistentApiError(e));
  });
});
