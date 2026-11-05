/**
 * Majority of three (prompt v1.6, ADR 0013): how the three answers of the AI become the one stored decision.
 * Pure: no database, no AI.
 */
import { describe, expect, it } from 'vitest';
import type { HybridOption } from '@fp/analysis';
import { combineVotes, type Answer } from '../src/hybrid-job.js';

const OPTIONS: Record<string, HybridOption> = {
  FAVORITE: { side: 'FAVORITE', market: 'ASIAN_HANDICAP', selection: 'HOME', line: -0.75, odds: 1.95, marketProbability: 0.49 },
  UNDERDOG: { side: 'UNDERDOG', market: 'ASIAN_HANDICAP', selection: 'AWAY', line: 0.75, odds: 1.93, marketProbability: 0.51 },
  OVER: { side: 'OVER', market: 'OVER_UNDER', selection: 'OVER', line: 2.5, odds: 1.9, marketProbability: 0.5 },
};

/** a valid answer choosing `side` (an option or NO_PICK) */
function ok(side: string, text = `เหตุผลของ ${side}`): Answer {
  const option = OPTIONS[side] ?? null;
  return {
    res: { output: { side, summary_th: text }, model: 'gpt-6-luna', stopReason: 'stop', refusal: null, usage: { input_tokens: 4000, output_tokens: 900 } },
    result: {
      ok: true,
      violations: [],
      decision: { side: side as never, option, confidence: option ? 'MEDIUM' : null, summaryTh: text, supportingEvidence: [], counterEvidence: [], riskFactors: [], missingData: [] },
    },
    violations: [],
    attempts: 1,
    failure: null,
    persistent: false,
  };
}
const invalid = (): Answer => ({
  res: { output: { side: 'OVER' }, model: 'gpt-6-luna', stopReason: 'stop', refusal: null, usage: { input_tokens: 4000, output_tokens: 900 } },
  result: { ok: false, violations: ['banned word "ทีเด็ด"'], decision: null },
  violations: ['attempt 1: banned word "ทีเด็ด"', 'attempt 2: banned word "ทีเด็ด"'],
  attempts: 2,
  failure: null,
  persistent: false,
});
const error = (): Answer => ({ res: null, result: null, violations: [], attempts: 1, failure: 'Error: 500 server error', persistent: false });

describe('combineVotes', () => {
  it('two of three agree: that choice, with the text of the first answer that gave it', () => {
    const row = combineVotes([ok('OVER'), ok('UNDERDOG', 'ทีมเยือนรับแน่น'), ok('UNDERDOG', 'อีกเหตุผล')]);
    expect(row).toMatchObject({ status: 'OK', side: 'UNDERDOG', market: 'ASIAN_HANDICAP', selection: 'AWAY', line: 0.75, odds: 1.93, market_probability: 0.51, confidence: 'MEDIUM', summary_th: 'ทีมเยือนรับแน่น', attempts: 3 });
    expect(row.output).toEqual({ side: 'UNDERDOG', summary_th: 'ทีมเยือนรับแน่น' });
    expect(row.votes).toEqual([
      { status: 'OK', side: 'OVER', confidence: 'MEDIUM', attempts: 1 },
      { status: 'OK', side: 'UNDERDOG', confidence: 'MEDIUM', attempts: 1 },
      { status: 'OK', side: 'UNDERDOG', confidence: 'MEDIUM', attempts: 1 },
    ]);
    expect(row.usage).toEqual({ input_tokens: 12000, output_tokens: 2700 });
  });

  it('two NO_PICK answers make a NO_PICK, whatever the third chose', () => {
    expect(combineVotes([ok('NO_PICK'), ok('FAVORITE'), ok('NO_PICK')])).toMatchObject({ status: 'OK', side: 'NO_PICK', market: null, line: null, confidence: null });
  });

  it('three valid answers, three different choices: NO_PICK (the evidence does not point one way)', () => {
    const row = combineVotes([ok('OVER'), ok('UNDERDOG'), ok('NO_PICK')]);
    expect(row).toMatchObject({ status: 'OK', side: 'NO_PICK', output: null });
    expect(String(row.summary_th)).not.toMatch(/\d/); // no number the guard could not trace
  });

  it('one answer not valid, the other two agree: still a decision', () => {
    const row = combineVotes([invalid(), ok('FAVORITE'), ok('FAVORITE')]);
    expect(row).toMatchObject({ status: 'OK', side: 'FAVORITE', attempts: 4 });
    expect(row.violations).toEqual(['answer 1: attempt 1: banned word "ทีเด็ด"', 'answer 1: attempt 2: banned word "ทีเด็ด"']);
  });

  it('too few valid answers to reach or rule out a majority: the decision fails and is tried again next run', () => {
    const split = combineVotes([invalid(), ok('FAVORITE'), ok('OVER')]);
    expect(split).toMatchObject({ status: 'INVALID' });
    expect(split).not.toHaveProperty('side');
    expect(combineVotes([error(), ok('FAVORITE'), ok('OVER')])).toMatchObject({ status: 'ERROR' });
    const allDown = combineVotes([error(), error(), error()]);
    expect(allDown).toMatchObject({ status: 'ERROR', model: null, output: null, usage: null });
    expect(allDown.violations).toEqual(['answer 1: Error: 500 server error', 'answer 2: Error: 500 server error', 'answer 3: Error: 500 server error']);
  });
});
