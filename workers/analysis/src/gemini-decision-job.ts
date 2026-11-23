/**
 * Gemini Decision shadow (owner, 2026-11-23): one Gemini answer per fixture on exactly the input a DAILY Hybrid AI
 * decision stored (written before kickoff), with the Hybrid AI v2.1.1 prompt, JSON schema, number validator and
 * feedback retry unchanged, so the only difference from the Hybrid AI is the model (and one answer instead of a
 * three-answer majority). Stored in decisions_shadow (migration 0061) under its own config; never published: nothing
 * here is read by the pick, publish or featured jobs, and Gemini never sees the Hybrid AI's answer.
 *
 * GEMINI_DECISION=shadow turns it on; unset, the job does nothing. Only fixtures that kick off more than
 * MIN_LEAD_MINUTES from now are asked. An answer that fails validation after its retry is stored as INVALID (final,
 * like a failed vote: no new call); an API failure leaves no row, so the next hourly run tries again before kickoff;
 * a persistent failure (no credit, bad key, unknown model) stops this run.
 */
import { createGeminiHybridDeciderV21, GEMINI_DECISION_MODEL, HYBRID_PROMPT_VERSION_V211, type HybridDecider } from '@fp/ai';
import { hybridInputOptions } from '@fp/analysis';
import { runJob, type JobContext } from '@fp/database';
import { askOnce, statusOf } from './hybrid-job.js';

export const GEMINI_DECISION_CONCURRENCY = 6;
export const GEMINI_DECISION_MAX_PER_RUN = 120;
/** stop starting new calls after this long: the hourly workflow has 30 minutes in all; the rest is asked next run */
export const GEMINI_DECISION_BUDGET_MINUTES = 8;
export const MIN_LEAD_MINUTES = 5;
const HORIZON_HOURS = 30;

/** decisions_shadow.config of a Gemini Decision: the model and the prompt it answered with */
export const geminiDecisionConfig = (model: string) => `gemini:${model}:${HYBRID_PROMPT_VERSION_V211}`;

export function geminiDecisionJob(ctx: JobContext, opts: { now?: Date; decider?: HybridDecider; limit?: number; budgetMinutes?: number } = {}) {
  const model = ctx.env.GEMINI_DECISION_MODEL ?? GEMINI_DECISION_MODEL;
  const config = geminiDecisionConfig(model);
  return runJob(ctx, 'gemini-decision', { config }, async () => {
    if (ctx.env.GEMINI_DECISION !== 'shadow' && !opts.decider) {
      ctx.log.info('Gemini Decision is off (GEMINI_DECISION unset)');
      return 0;
    }
    const decider = opts.decider ?? (ctx.env.GEMINI_API_KEY ? createGeminiHybridDeciderV21({ apiKey: ctx.env.GEMINI_API_KEY, model }) : null);
    if (!decider) {
      ctx.log.warn('no GEMINI_API_KEY: Gemini Decision skipped');
      return 0;
    }
    const now = opts.now ?? new Date();
    const deadline = Date.now() + (opts.budgetMinutes ?? GEMINI_DECISION_BUDGET_MINUTES) * 60_000;
    // the latest DAILY Hybrid AI input of each fixture; v2.1.1 only (the prompt Gemini answers with expects that input)
    const { rows } = await ctx.db.query<{ id: string | number; fixture_id: string | number; input: Record<string, unknown>; input_hash: string }>(
      `select d.id, d.fixture_id, d.input, d.input_hash
         from (select distinct on (h.fixture_id) h.id, h.fixture_id, h.input, h.input_hash, h.prompt_version
                 from hybrid_decisions h
                where h.publish_round = 'DAILY' and h.input is not null
                  and h.kickoff_at > $1::timestamptz and h.kickoff_at < $1::timestamptz + make_interval(hours => $2)
                order by h.fixture_id, h.decided_at desc, h.id desc) d
         join fixtures f on f.id = d.fixture_id
        where d.prompt_version = $3
          and f.kickoff_at > $1::timestamptz + make_interval(mins => $4)
          and not exists (select 1 from decisions_shadow s where s.fixture_id = d.fixture_id and s.config = $5)
        order by f.kickoff_at, d.fixture_id
        limit $6`,
      [now.toISOString(), HORIZON_HOURS, HYBRID_PROMPT_VERSION_V211, MIN_LEAD_MINUTES, config, opts.limit ?? GEMINI_DECISION_MAX_PER_RUN],
    );
    let written = 0;
    let stop: string | null = null;
    let outOfTime = 0;
    const counts: Record<string, number> = {};
    const queue = [...rows];
    await Promise.all(
      Array.from({ length: GEMINI_DECISION_CONCURRENCY }, async () => {
        for (let r = queue.shift(); r && !stop; r = queue.shift()) {
          if (Date.now() > deadline) {
            outOfTime++;
            continue;
          }
          const options = hybridInputOptions(r.input as never);
          if (!options.length) {
            // the Hybrid AI had nothing to choose from either: no call
            counts.NO_OPTIONS = (counts.NO_OPTIONS ?? 0) + 1;
            continue;
          }
          const calledAt = new Date();
          const a = await askOnce(decider, r.input, options, 'v2.1.1');
          const status = statusOf(a);
          if (status === 'ERROR') {
            ctx.log.warn('Gemini Decision call failed', { fixtureId: Number(r.fixture_id), error: (a.failure ?? '').slice(0, 200) });
            if (a.persistent) stop = a.failure;
            continue;
          }
          const d = status === 'OK' ? a.result!.decision! : null;
          const o = d?.option ?? null;
          const response = {
            output: a.res?.output ?? null,
            status,
            stop_reason: a.res?.stopReason ?? null,
            refusal: a.res?.refusal ?? null,
            attempts: a.attempts,
            feedback_retries: a.feedbackRetries ?? 0,
            latency_ms: a.latencyMs ?? null,
            violations: a.violations,
            confidence: d?.confidence ?? null,
          };
          try {
            await ctx.db.query(
              `insert into decisions_shadow (fixture_id, hybrid_decision_id, input_hash, config, model, called_at, status,
                                             side, market, selection, line, odds, market_probability, response, usage)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
               on conflict (fixture_id, config) do nothing`,
              [
                Number(r.fixture_id), Number(r.id), r.input_hash, config, a.res?.model ?? model, calledAt.toISOString(),
                // a refusal is stored as INVALID (the table has no REFUSED); response.refusal says which
                status === 'OK' ? 'OK' : 'INVALID',
                d?.side ?? null, o?.market ?? null, o?.selection ?? null, o?.line ?? null, o?.odds ?? null, o?.marketProbability ?? null,
                JSON.stringify(response), JSON.stringify(a.res?.usage ?? null),
              ],
            );
            written++;
            const k = status === 'OK' ? (d?.side ?? '?') : status;
            counts[k] = (counts[k] ?? 0) + 1;
          } catch (err) {
            ctx.log.warn('Gemini Decision row not stored', { fixtureId: Number(r.fixture_id), error: String(err).slice(0, 200) });
          }
        }
      }),
    );
    ctx.log.info('Gemini Decision shadow', { config, due: rows.length, written, leftForNextRun: outOfTime, ...counts });
    if (stop) throw new Error(`Gemini Decision stopped on a persistent API error: ${stop}`);
    return written;
  });
}
