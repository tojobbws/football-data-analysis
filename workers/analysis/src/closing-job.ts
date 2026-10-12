/**
 * Closing market: keep the market's view at kickoff for good (market_closing), before the odds
 * snapshots it comes from expire (ADR 0002). Per match: the 1X2 and the main AH and O/U line,
 * each side with its median closing odds, no-vig probability, and the model probability the last
 * pre-kickoff candidates run used. Lets model-vs-market be measured over the whole history.
 */
import { closingMarket } from '@fp/analysis';
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
    ctx.log.info('closing market recorded', { fixtures: fixtures.length, rows: written, noQuotes });
    return written;
  });
}
