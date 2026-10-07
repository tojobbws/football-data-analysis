/**
 * Settlement Engine (Phase 7): close PENDING analyses once the match is decided.
 *
 *   PENDING -> WIN / HALF_WIN / LOSS / HALF_LOSS / PUSH   (90-minute score, rules in @fp/analysis)
 *   PENDING -> VOID                                       (cancelled / abandoned / not played within 48h)
 *
 * The DB trigger allows exactly one settlement per analysis and only after full time,
 * and sets settled_at with the DB clock. Closing odds + CLV are stored in the same update.
 * The AI shadow pick (ai_shadow_rankings) is settled with the same rules, so rules vs AI compare fairly.
 * Run `sync:results` first so fixture scores are fresh.
 */
import { closingLineValue, decideSettlement, SETTLEMENT_VERSION } from '@fp/analysis';
import { runJob, type JobContext } from '@fp/database';

export interface SettleSummary {
  settled: number;
  voided: number;
  waiting: number;
  details: Array<{ publicId: string; action: string; status?: string; score?: string; reason?: string; clv?: number | null }>;
}

export function settleJob(ctx: JobContext, opts: { now?: Date } = {}) {
  return runJob(ctx, 'settle', { rules: SETTLEMENT_VERSION }, async () => {
    const now = opts.now ?? new Date();
    const pending = await ctx.repo.pendingSettlements(now);
    const summary: SettleSummary = { settled: 0, voided: 0, waiting: 0, details: [] };

    for (const p of pending) {
      const d = decideSettlement(p, p.fixture, now);
      if (d.action === 'WAIT') {
        summary.waiting++;
        summary.details.push({ publicId: p.publicId, action: 'WAIT', reason: d.reason });
        continue;
      }

      const closing =
        p.market && p.selection ? closingLineValue(p.oddsAtPublish, await ctx.repo.closingOdds(p.fixtureId, p.market, p.selection, p.line)) : null;
      const status = d.action === 'SETTLE' ? d.status : 'VOID';
      const resultScore = d.action === 'SETTLE' ? d.score : d.reason;
      const ok = await ctx.repo.settlePrediction(p.id, { status, resultScore, closingOdds: closing?.closingOdds ?? null, clv: closing?.clv ?? null });
      if (!ok) continue;

      if (d.action === 'SETTLE') summary.settled++;
      else summary.voided++;
      summary.details.push({ publicId: p.publicId, action: d.action, status, score: resultScore, clv: closing?.clv ?? null });
    }

    // AI shadow picks: identical rules, never touches the published record
    let shadowDone = 0;
    for (const a of await ctx.repo.pendingShadowSettlements(now)) {
      const d = decideSettlement(a, a.fixture, now);
      if (d.action === 'WAIT') continue;
      const closing = closingLineValue(a.odds, await ctx.repo.closingOdds(a.fixtureId, a.market, a.selection, a.line));
      const ok = await ctx.repo.settleShadow(a.id, {
        status: d.action === 'SETTLE' ? d.status : 'VOID',
        resultScore: d.action === 'SETTLE' ? d.score : d.reason,
        closingOdds: closing?.closingOdds ?? null,
        clv: closing?.clv ?? null,
      });
      if (ok) shadowDone++;
    }

    ctx.log.info('settlement', { pending: pending.length, settled: summary.settled, voided: summary.voided, waiting: summary.waiting, aiShadowSettled: shadowDone });
    if (summary.details.length) console.table(summary.details);
    return summary.settled + summary.voided + shadowDone;
  });
}
