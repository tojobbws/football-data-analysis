/**
 * Hybrid AI v2.2-panel (EXPERIMENTAL, ADR 0022): how the three lenses' answers become the one stored decision.
 * The majority rule is v1.6's (HYBRID_MAJORITY = 2); only the text a majority keeps changes (defender, then metrics,
 * then context). Pure: no database, no AI.
 */
import { describe, expect, it } from 'vitest';
import { HYBRID_MAJORITY, HYBRID_PROMPT_VERSION_V211, HYBRID_PROMPT_VERSION_V22_PANEL, type PanelRole } from '@fp/ai';
import type { HybridOption } from '@fp/analysis';
import { combineVotes, hybridPromptVersion, hybridVersion, panelOpenAIModel, panelReasoningEffort, PANEL_TEXT_PRIORITY, usesV211Pipeline, type Answer } from '../src/hybrid-job.js';

const OPTIONS: Record<string, HybridOption> = {
  FAVORITE: { side: 'FAVORITE', market: 'ASIAN_HANDICAP', selection: 'HOME', line: -0.75, odds: 1.95, marketProbability: 0.49 },
  UNDERDOG: { side: 'UNDERDOG', market: 'ASIAN_HANDICAP', selection: 'AWAY', line: 0.75, odds: 1.93, marketProbability: 0.51 },
};

/** a valid answer of one lens choosing `side` (an option or NO_PICK); its text names the lens */
function lens(role: PanelRole | undefined, side: string, model = `gpt-${role ?? 'x'}`): Answer {
  const option = OPTIONS[side] ?? null;
  const text = `เหตุผลจาก ${role ?? 'คำตอบ'} (${side})`;
  return {
    res: { output: { side, summary_th: text, by: role }, model, stopReason: 'stop', refusal: null, usage: { input_tokens: 4000, output_tokens: 900, input_tokens_details: { cached_tokens: 3000 } } as never },
    result: {
      ok: true,
      violations: [],
      decision: { side: side as never, option, confidence: option ? 'MEDIUM' : null, summaryTh: text, supportingEvidence: [], counterEvidence: [], riskFactors: [], missingData: [] },
    },
    violations: [],
    attempts: 1,
    failure: null,
    persistent: false,
    feedbackRetries: 0,
    latencyMs: 1200,
    ...(role ? { role, model } : {}),
  };
}

describe('combineVotes with panel lenses', () => {
  it('3/3 agree: the pick, with the defender\'s explanation (the most market-sceptical)', () => {
    const row = combineVotes([lens('metrics', 'UNDERDOG'), lens('context', 'UNDERDOG'), lens('defender', 'UNDERDOG')]);
    expect(row).toMatchObject({ status: 'OK', side: 'UNDERDOG', market: 'ASIAN_HANDICAP', selection: 'AWAY', line: 0.75, odds: 1.93, market_probability: 0.51, confidence: 'MEDIUM', model: 'gpt-defender' });
    expect(row.summary_th).toBe('เหตุผลจาก defender (UNDERDOG)');
    expect(row.output).toMatchObject({ by: 'defender' });
    // featured-ai-v4 counts the votes that gave the decision's side: 3 of 3
    expect((row.votes as Array<{ side: string }>).filter((v) => v.side === row.side)).toHaveLength(3);
  });

  it('2/3 (metrics + context agree, defender NO_PICK): a valid pick with the metrics explanation', () => {
    const row = combineVotes([lens('metrics', 'FAVORITE'), lens('context', 'FAVORITE'), lens('defender', 'NO_PICK')]);
    expect(row).toMatchObject({ status: 'OK', side: 'FAVORITE', market: 'ASIAN_HANDICAP', selection: 'HOME', line: -0.75, odds: 1.95, model: 'gpt-metrics' });
    expect(row.summary_th).toBe('เหตุผลจาก metrics (FAVORITE)');
    expect((row.votes as Array<{ side: string }>).filter((v) => v.side === row.side)).toHaveLength(2);
  });

  it('2/3 without the defender and metrics: the context explanation', () => {
    const row = combineVotes([lens('metrics', 'NO_PICK'), lens('context', 'UNDERDOG'), lens('defender', 'UNDERDOG')]);
    expect(row.summary_th).toBe('เหตุผลจาก defender (UNDERDOG)');
    const row2 = combineVotes([lens('metrics', 'FAVORITE'), lens('context', 'UNDERDOG'), lens('defender', 'UNDERDOG')]);
    expect(row2.summary_th).toBe('เหตุผลจาก defender (UNDERDOG)');
  });

  it('1/3 (only one lens picks; the defender and the other lens say NO_PICK): NO_PICK', () => {
    for (const picker of ['metrics', 'context'] as const) {
      const answers = (['metrics', 'context', 'defender'] as const).map((r) => lens(r, r === picker ? 'UNDERDOG' : 'NO_PICK'));
      const row = combineVotes(answers);
      expect(row).toMatchObject({ status: 'OK', side: 'NO_PICK', market: null, line: null, odds: null, confidence: null });
      // the NO_PICK text is the defender's
      expect(row.summary_th).toBe('เหตุผลจาก defender (NO_PICK)');
    }
  });

  it('a split (metrics FAVORITE, context UNDERDOG, defender NO_PICK): NO_PICK', () => {
    const row = combineVotes([lens('metrics', 'FAVORITE'), lens('context', 'UNDERDOG'), lens('defender', 'NO_PICK')]);
    expect(row).toMatchObject({ status: 'OK', side: 'NO_PICK', output: null });
    expect(String(row.summary_th)).not.toMatch(/\d/);
  });

  it('keeps the majority rule unchanged and records each lens and model in the votes (no migration: optional jsonb fields)', () => {
    expect(HYBRID_MAJORITY).toBe(2);
    const row = combineVotes([lens('metrics', 'UNDERDOG', 'gpt-a'), lens('context', 'NO_PICK', 'gpt-b'), lens('defender', 'UNDERDOG', 'gpt-c')]);
    expect(row.votes).toEqual([
      { status: 'OK', side: 'UNDERDOG', confidence: 'MEDIUM', attempts: 1, feedbackRetries: 0, latencyMs: 1200, role: 'metrics', model: 'gpt-a' },
      { status: 'OK', side: 'NO_PICK', confidence: null, attempts: 1, feedbackRetries: 0, latencyMs: 1200, role: 'context', model: 'gpt-b' },
      { status: 'OK', side: 'UNDERDOG', confidence: 'MEDIUM', attempts: 1, feedbackRetries: 0, latencyMs: 1200, role: 'defender', model: 'gpt-c' },
    ]);
    expect(row.usage).toEqual({ input_tokens: 12000, output_tokens: 2700 });
  });

  it('a failed lens: two agreeing valid lenses still decide; too few valid lenses fail as before', () => {
    const failed: Answer = { res: null, result: null, violations: [], attempts: 1, failure: 'Error: 500', persistent: false, feedbackRetries: 0, latencyMs: 5, role: 'defender', model: 'gpt-defender' };
    expect(combineVotes([lens('metrics', 'UNDERDOG'), lens('context', 'UNDERDOG'), failed])).toMatchObject({ status: 'OK', side: 'UNDERDOG', summary_th: 'เหตุผลจาก metrics (UNDERDOG)' });
    expect(combineVotes([lens('metrics', 'UNDERDOG'), lens('context', 'FAVORITE'), failed])).toMatchObject({ status: 'ERROR' });
    expect((combineVotes([lens('metrics', 'UNDERDOG'), lens('context', 'FAVORITE'), failed]).votes as Array<Record<string, unknown>>)[2]).toMatchObject({ status: 'ERROR', role: 'defender', model: 'gpt-defender' });
  });

  it('answers without a lens (v2.0 / v2.1.1) keep the first agreeing answer\'s text and no role/model fields', () => {
    const row = combineVotes([lens(undefined, 'NO_PICK'), lens(undefined, 'UNDERDOG', 'gpt-1'), lens(undefined, 'UNDERDOG', 'gpt-2')]);
    expect(row).toMatchObject({ side: 'UNDERDOG', model: 'gpt-1' });
    for (const v of row.votes as Array<Record<string, unknown>>) {
      expect(v).not.toHaveProperty('role');
      expect(v).not.toHaveProperty('model');
    }
    expect(PANEL_TEXT_PRIORITY).toEqual(['defender', 'metrics', 'context']);
  });
});

describe('versions and lens configuration', () => {
  it('v2.1.1 stays the default; v2.2-panel only when set; it runs the v2.1.1 pipeline', () => {
    expect(hybridVersion({})).toBe('v2.1.1');
    expect(hybridVersion({ HYBRID_VERSION: 'v2.2-panel' })).toBe('v2.2-panel');
    expect(hybridPromptVersion('v2.1.1')).toBe(HYBRID_PROMPT_VERSION_V211);
    expect(hybridPromptVersion('v2.2-panel')).toBe(HYBRID_PROMPT_VERSION_V22_PANEL);
    expect([usesV211Pipeline('v2.0'), usesV211Pipeline('v2.1.1'), usesV211Pipeline('v2.2-panel')]).toEqual([false, true, true]);
  });

  it('each lens\'s model: OPENAI_PANEL_<ROLE>_MODEL, else OPENAI_HYBRID_MODEL, else OPENAI_MODEL; effort only when set', () => {
    const env = { OPENAI_MODEL: 'base', OPENAI_HYBRID_MODEL: 'hybrid', OPENAI_PANEL_DEFENDER_MODEL: 'strict', OPENAI_PANEL_METRICS_EFFORT: 'high' };
    expect(panelOpenAIModel(env, 'defender')).toBe('strict');
    expect(panelOpenAIModel(env, 'metrics')).toBe('hybrid');
    expect(panelOpenAIModel({ OPENAI_MODEL: 'base' }, 'context')).toBe('base');
    expect(panelReasoningEffort(env, 'metrics')).toBe('high');
    expect(panelReasoningEffort(env, 'context')).toBeUndefined();
  });
});
