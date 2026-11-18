/**
 * Decisions v2 shadow (.scratch/decisions-v2/spec.md, migration 0062). Never published: nothing here is read by the
 * pick, publish or featured jobs, and the Hybrid AI ×3 decision is never part of what Decisions sees.
 *
 * For each fixture whose DAILY Hybrid AI input is stored (the shared raw data, written before kickoff) and that kicks
 * off more than MIN_LEAD_MINUTES from now, the analyst answers in categories through OpenAI Decisions on exactly that
 * input, the engine prices every option, and one row per fixture and version set is stored before kickoff (a DB
 * trigger refuses a late row). The odds are the input's own main-line snapshot, the same prices the Hybrid AI decided
 * on, so both are judged on one snapshot and one settlement.
 *
 * DECISIONS_V2=shadow turns it on; unset, the job does nothing. An API failure leaves no row, so the next hourly run
 * tries again while the match has not started; a persistent failure (no credit, bad key) stops this run.
 */
import { createHash } from 'node:crypto';
import { createDecisionsV2Client, DECISIONS_V2_PROMPT_VERSION, isPersistentApiError, runDecisionsV2, type DecisionsV2Client } from '@fp/ai';
import { DECISIONS_V2_ENGINE_VERSION, DECISIONS_V2_RULES, hybridInputOptions, hybridInputQuality } from '@fp/analysis';
import { runJob, type JobContext } from '@fp/database';

export const DECISIONS_V2_CONCURRENCY = 2;
export const DECISIONS_V2_MAX_PER_RUN = 120;
export const MIN_LEAD_MINUTES = 5;
const HORIZON_HOURS = 30;

export function decisionsV2Job(ctx: JobContext, opts: { now?: Date; client?: DecisionsV2Client; limit?: number } = {}) {
  const versions = { engine: DECISIONS_V2_ENGINE_VERSION, rules: DECISIONS_V2_RULES.version, prompt: DECISIONS_V2_PROMPT_VERSION };
  return runJob(ctx, 'decisions-v2', versions, async () => {
    if (ctx.env.DECISIONS_V2 !== 'shadow' && !opts.client) {
      ctx.log.info('Decisions v2 is off (DECISIONS_V2 unset)');
      return 0;
    }
    const client = opts.client ?? (ctx.env.OPENAI_API_KEY ? createDecisionsV2Client({ apiKey: ctx.env.OPENAI_API_KEY }) : null);
    if (!client) {
      ctx.log.warn('no OPENAI_API_KEY: Decisions v2 skipped');
      return 0;
    }
    const now = opts.now ?? new Date();
    const { rows } = await ctx.db.query<{ id: string | number; fixture_id: string | number; input: Record<string, any>; input_hash: string }>(
      `select d.id, d.fixture_id, d.input, d.input_hash
         from (select distinct on (h.fixture_id) h.id, h.fixture_id, h.input, h.input_hash
                 from hybrid_decisions h
                where h.publish_round = 'DAILY' and h.kickoff_at > $1::timestamptz and h.kickoff_at < $1::timestamptz + make_interval(hours => $2)
                order by h.fixture_id, h.decided_at desc, h.id desc) d
         join fixtures f on f.id = d.fixture_id
        where f.kickoff_at > $1::timestamptz + make_interval(mins => $3)
          and not exists (select 1 from decisions_v2 v where v.fixture_id = d.fixture_id
                            and v.engine_version = $4 and v.rules_version = $5 and v.prompt_version = $6)
        order by f.kickoff_at, d.fixture_id
        limit $7`,
      [now.toISOString(), HORIZON_HOURS, MIN_LEAD_MINUTES, versions.engine, versions.rules, versions.prompt, opts.limit ?? DECISIONS_V2_MAX_PER_RUN],
    );
    let written = 0;
    let stop = false;
    const counts: Record<string, number> = {};
    const queue = [...rows];
    await Promise.all(
      Array.from({ length: DECISIONS_V2_CONCURRENCY }, async () => {
        for (let r = queue.shift(); r && !stop; r = queue.shift()) {
          let res;
          try {
            res = await runDecisionsV2(r.input, client);
          } catch (err) {
            ctx.log.warn('Decisions v2 call failed', { fixtureId: Number(r.fixture_id), error: String(err).slice(0, 200) });
            if (isPersistentApiError(err)) stop = true;
            continue;
          }
          const snapshot = { asOf: r.input.prediction_timestamp_utc ?? null, options: hybridInputOptions(r.input), quality: hybridInputQuality(r.input) };
          const d = res.decision;
          const c = d?.chosen ?? null;
          try {
            await ctx.db.query(
              `insert into decisions_v2 (fixture_id, hybrid_decision_id, input_hash, odds_snapshot, odds_hash, engine_version, rules_version, prompt_version, model,
                                         status, side, market, selection, line, odds, market_probability, fair_probability, ev, ev_sd, no_pick_reasons,
                                         market_fit, view, candidates, evidence, request_sha256, response, usage, note)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28)
               on conflict (fixture_id, engine_version, rules_version, prompt_version) do nothing`,
              [
                Number(r.fixture_id), Number(r.id), r.input_hash, JSON.stringify(snapshot), createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
                versions.engine, versions.rules, versions.prompt, res.model,
                res.status, d?.side ?? null, c?.market ?? null, c?.selection ?? null, c?.line ?? null, c?.odds ?? null,
                c ? round(c.marketProbability, 5) : null, c ? round(c.fairProbability, 5) : null, c ? round(c.ev, 5) : null, c ? round(c.evSd, 5) : null,
                JSON.stringify(d?.noPickReasons ?? []), JSON.stringify(res.fit), JSON.stringify(res.answers), JSON.stringify(d?.candidates ?? []),
                JSON.stringify(res.evidence), res.requestSha256, JSON.stringify(res.response), JSON.stringify(res.response?.usage ?? null), res.note,
              ],
            );
            written++;
            const k = res.status === 'OK' ? (d?.side ?? '?') : res.status;
            counts[k] = (counts[k] ?? 0) + 1;
          } catch (err) {
            // e.g. the match started while the call was running: the trigger refuses it, which is the point
            ctx.log.warn('Decisions v2 row not stored', { fixtureId: Number(r.fixture_id), error: String(err).slice(0, 200) });
          }
        }
      }),
    );
    ctx.log.info('Decisions v2 shadow', { due: rows.length, written, ...counts });
    if (stop) throw new Error('Decisions v2 stopped on a persistent API error');
    return written;
  });
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
