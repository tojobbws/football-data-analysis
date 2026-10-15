/**
 * Phase 6b — AI shadow ranking.
 *
 * The rules already picked 🧭 (or 🌫️) and that record is published and immutable. Here the AI
 * ranks the SAME candidates from the SAME publish snapshot, without seeing the rules' pick, and
 * the answer is stored before kickoff in `ai_shadow_rankings`. Nothing here changes what is
 * published. After 500–1,000 matches `ai_shadow_comparison` shows whether AI ranking beats the rules.
 *
 * The AI never produces numbers: probabilities/odds come from the snapshot; Thai text is checked
 * so every number in it traces back to the input (see @fp/ai guards).
 */
import { buildShadowInput, createClaudeRanker, createOpenAIRanker, isPersistentApiError, PROMPT_VERSION, validateShadowOutput, type ShadowRanker, type SnapshotCandidate } from '@fp/ai';
import { runJob, type JobContext } from '@fp/database';

export function aiShadowJob(ctx: JobContext, opts: { now?: Date; ranker?: ShadowRanker; limit?: number } = {}) {
  return runJob(ctx, 'ai-shadow', { promptVersion: PROMPT_VERSION }, async () => {
    const { OPENAI_API_KEY, OPENAI_MODEL, ANTHROPIC_API_KEY } = ctx.env;
    // OpenAI when both OPENAI_* are set, else Claude
    const ranker =
      opts.ranker ??
      (OPENAI_API_KEY && OPENAI_MODEL ? createOpenAIRanker({ apiKey: OPENAI_API_KEY, model: OPENAI_MODEL }) : ANTHROPIC_API_KEY ? createClaudeRanker({ apiKey: ANTHROPIC_API_KEY }) : null);
    if (!ranker) {
      ctx.log.warn('no AI key (OPENAI_API_KEY + OPENAI_MODEL, or ANTHROPIC_API_KEY) — AI shadow ranking skipped');
      return 0;
    }
    const now = opts.now ?? new Date();
    const todo = await ctx.repo.publishedAwaitingShadow(now, 5, opts.limit ?? 50);
    const report: Array<Record<string, unknown>> = [];
    let written = 0;

    for (const p of todo) {
      const { input, candidates } = buildShadowInput({ fixture: p.fixture, publishRound: p.publishRound, snapshot: p.snapshot });
      const match = `${p.fixture.home} vs ${p.fixture.away} (${p.publishRound})`;
      if (!candidates.length) {
        report.push({ match, result: 'SKIP', note: 'no candidates in snapshot' });
        continue;
      }

      let res;
      try {
        res = await ranker.rank(input);
      } catch (err) {
        // no row, so the next run retries (until kickoff)
        report.push({ match, result: 'ERROR', note: String(err).slice(0, 80) });
        if (isPersistentApiError(err)) {
          // e.g. no credit: every other call this run would fail the same way
          ctx.log.error('AI shadow stopped for this run', { predictionId: p.predictionId, error: String(err) });
          break;
        }
        ctx.log.warn('AI call failed', { predictionId: p.predictionId, error: String(err) });
        continue;
      }

      const base = { analysis_prediction_id: p.predictionId, model: res.model, prompt_version: PROMPT_VERSION, input, output: res.output, usage: res.usage };
      let row: Record<string, unknown>;
      if (res.refusal) {
        row = { ...base, status: 'REFUSED', guard_violations: [`refusal: ${res.refusal.category ?? 'unknown'}`] };
      } else if (res.output === null) {
        row = { ...base, status: 'INVALID', guard_violations: [`unparseable output (stop_reason ${res.stopReason})`] };
      } else {
        const v = validateShadowOutput(res.output, input, candidates);
        const pick = v.ok ? v.pick : null;
        const snap = (p.snapshot.candidates_snapshot ?? []) as SnapshotCandidate[];
        const agrees = v.noClearSignal
          ? p.rules.kind === 'NO_CLEAR_SIGNAL'
          : p.rules.kind === 'SIGNAL' && !!pick && pick.market === p.rules.market && pick.selection === p.rules.selection && sameLine(pick.line, p.rules.line);
        row = {
          ...base,
          status: v.ok ? 'OK' : 'INVALID',
          ranking: v.ranking,
          no_clear_signal: v.noClearSignal,
          pick_market: pick?.market ?? null,
          pick_selection: pick?.selection ?? null,
          pick_line: pick?.line ?? null,
          pick_odds: pick ? (snap[pick.index]?.odds ?? null) : null,
          agrees_with_rules: v.ok ? agrees : null,
          explanation_th: v.explanation || null,
          guard_violations: v.violations,
        };
      }

      try {
        await ctx.repo.insertShadowRanking(row);
        written++;
        report.push({
          match,
          result: row.status,
          ai: row.no_clear_signal ? '🌫️' : (candidates.find((c) => c.market === row.pick_market && c.selection === row.pick_selection && sameLine(c.line, row.pick_line as number | null))?.label ?? '-'),
          rules: p.rules.kind === 'SIGNAL' ? 'SIGNAL' : '🌫️',
          agrees: row.agrees_with_rules ?? '-',
          model: res.model,
        });
      } catch (err) {
        // e.g. kickoff passed while waiting for the API: the DB refuses late rows by design
        ctx.log.warn('shadow ranking not stored', { predictionId: p.predictionId, error: String(err) });
      }
    }
    if (report.length) console.table(report);
    return written;
  });
}

const sameLine = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) < 1e-9);
