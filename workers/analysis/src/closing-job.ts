/**
 * Closing market: keep the market's view at kickoff for good (market_closing), before the odds
 * snapshots it comes from expire (ADR 0002). Per match: the 1X2 and the main AH and O/U line,
 * each side with its median closing odds, no-vig probability, and the model probability the last
 * pre-kickoff candidates run used. Lets model-vs-market be measured over the whole history.
 * Also fills in the closing odds and CLV of locked shadow picks (shadow trial, ADR 0003), the same
 * way settlement does for real picks.
 */
import { closingLineValue, closingMarket } from '@fp/analysis';
import { runJob, type JobContext } from '@fp/database';

const lineKey = (x: number | null) => (x === null ? '' : String(Math.round(x * 4) / 4));

export function closingJob(ctx: JobContext) {
  return runJob(ctx, 'closing', {}, async () => {
    const fixtures = await ctx.repo.fixturesNeedingClosing();
    let written = 0;
    let noQuotes = 0;
    for (const f of fixtures) {
      const sides = closingMarket(await ctx.repo.closingQuotes(f.id), f.kickoffAt);
      if (!sides.length) {
        noQuotes++;
        continue;
      }
      const model = await ctx.repo.preKickoffCandidates(f.id);
      written += await ctx.repo.insertMarketClosing(
        sides.map((s) => {
          const m = model.find((x) => x.market === s.market && x.selection === s.selection && lineKey(x.line) === lineKey(s.line));
          return {
            fixture_id: f.id,
            market: s.market,
            selection: s.selection,
            line: s.line,
            bookmakers: s.nBookmakers,
            median_odds: Math.round(s.medianOdds * 1000) / 1000,
            market_probability: Math.round(s.marketProbability * 1e5) / 1e5,
            analysis_run_id: m?.runId ?? null,
            model_probability: m ? Math.round(m.probability * 1e5) / 1e5 : null,
            closing_at: s.updatedAt.toISOString(),
          };
        }),
      );
    }
    let shadowClv = 0;
    for (const s of await ctx.repo.shadowPicksNeedingClosing()) {
      const c = closingLineValue(s.odds, await ctx.repo.closingOdds(s.fixtureId, s.market, s.selection, s.line));
      if (!c) continue;
      await ctx.repo.setShadowClosing(s.fixtureId, s.rulesVersion, s.round, c.closingOdds, c.clv);
      shadowClv++;
    }
    ctx.log.info('closing market recorded', { fixtures: fixtures.length, rows: written, noQuotes, shadowClv });
    return written;
  });
}
