import { parseArgs } from 'node:util';
import { createJobContext } from '@fp/database';
import { loadDotEnvFile } from '@fp/shared';
import { generateCandidatesJob } from './candidates-job.js';
import { playerImpactJob } from './impact-job.js';
import { publishJob } from './publish-job.js';
import { matchReport } from './report-job.js';
import { settleJob } from './settle-job.js';
import { closingJob } from './closing-job.js';
import { shadowReport } from './shadow-report-job.js';
import { FEATURED_V2 } from '@fp/analysis';
import { featuredJob } from './featured-job.js';
import { featuredReport } from './featured-report-job.js';
import { aiShadowJob } from './ai-shadow-job.js';
import { hybridJob } from './hybrid-job.js';
import { matchPreviewJob } from './preview-job.js';
import { pickNoteJob } from './pick-note-job.js';
import { backtest, computeProbabilities, tune } from './jobs.js';
import { qualificationJob } from './qualification-job.js';
import { healthJob } from './health-job.js';
import { refreshWebJob } from './refresh-web-job.js';

const USAGE = `usage: npm run job -w @fp/analysis-worker -- <job> [options]

jobs:
  tune [--league ID] [--frozen-from ISO]  grid-search settings per league (time split) -> model_configs; --frozen-from keeps matches from then on out of tuning and gating (final holdout)
  probabilities [--days N] [--min-gap-hours H]   model probabilities for fixtures in the next N days (default 7)
  qualification [--days N]     chance each side goes through a two-legged cup tie (needs the live scoreline matrices); skips ties it cannot price
  impact [--hours N]           Player Impact layer: re-price with missing players (lineups / injuries)
  candidates [--hours N]       evaluate all selections vs odds, store decision (default next 36h)
  report [--hours N]           🔎 Markdown report of upcoming matches (default next 18h) -> reports/
  publish                      write the latest decision to the immutable track record (EARLY / LINEUP rounds)
  hybrid [--budget-minutes M]  Hybrid AI decides each due publish round (PICK_ENGINE=shadow|hybrid; stored, published only in hybrid mode)
  ai-shadow                    AI ranks the candidates of published analyses in parallel (shadow, never published); needs ANTHROPIC_API_KEY
  preview [--hours N] [--until ISO] [--refresh] [--budget-minutes M]  🔎 วิเคราะห์เกม: written preview for every match in the next N hours (default 48), only those kicking off before --until when given; AI text with an AI key, template text without; --refresh rewrites previews from an older version
  pick-notes [--refresh]      Game Compass note (pick_th) for every published pick not yet explained; AI text with an AI key, template text without; --refresh rewrites notes from an older prompt
  settle                      settle PENDING analyses of finished matches (WIN/LOSS/PUSH/VOID + CLV); run sync:results first
  closing                     keep the closing market (1X2 + main AH/O/U line) of kicked-off matches for good
  featured                    daily featured list (shadow, ADR 0004): reserve slots, lock matches at their LINEUP round
  featured-report             daily featured list vs all LINEUP picks, days by selections, verdict (ADR 0004)
  shadow-report               shadow pick rules vs the real ones on kicked-off matches: sides picked and results
  backtest [--warmup N]        walk-forward backtest on finished matches in the DB
  health                       pipeline health: stale jobs, odds feed, unpublished matches; exits 1 on a problem
  refresh-web                  refresh the materialized model results /performance reads (run after settle and closing)`;

/** --until must be a full moment with its zone (2026-10-29T06:00:00+07:00): a bare date would be read as UTC midnight */
function untilDate(s: string): Date {
  const d = new Date(s);
  if (!/T.*(Z|[+-]\d\d:\d\d)$/.test(s) || Number.isNaN(d.getTime())) throw new Error(`--until needs a time with its zone, e.g. 2026-10-29T06:00:00+07:00 (got ${s})`);
  return d;
}

async function main() {
  loadDotEnvFile();
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { days: { type: 'string' }, warmup: { type: 'string' }, league: { type: 'string' }, 'frozen-from': { type: 'string' }, hours: { type: 'string' }, 'budget-minutes': { type: 'string' }, 'min-gap-hours': { type: 'string' }, refresh: { type: 'boolean' }, until: { type: 'string' } },
  });
  const job = positionals[0];
  if (!['probabilities', 'qualification', 'backtest', 'tune', 'candidates', 'impact', 'publish', 'hybrid', 'ai-shadow', 'preview', 'pick-notes', 'settle', 'closing', 'featured', 'featured-report', 'shadow-report', 'report', 'health', 'refresh-web'].includes(job ?? '')) {
    console.log(USAGE);
    process.exit(1);
  }
  const ctx = createJobContext();
  try {
    if (job === 'tune') await tune(ctx, { leagues: values.league ? [Number(values.league)] : undefined, frozenFrom: values['frozen-from'] ? new Date(values['frozen-from']) : undefined });
    else if (job === 'probabilities')
      await computeProbabilities(ctx, {
        days: values.days ? Number(values.days) : undefined,
        minGapHours: values['min-gap-hours'] ? Number(values['min-gap-hours']) : undefined,
      });
    else if (job === 'qualification') await qualificationJob(ctx, { days: values.days ? Number(values.days) : undefined });
    else if (job === 'publish') await publishJob(ctx);
    else if (job === 'settle') await settleJob(ctx);
    else if (job === 'pick-notes') await pickNoteJob(ctx, { refresh: values.refresh });
    else if (job === 'closing') await closingJob(ctx);
    else if (job === 'featured') {
      await featuredJob(ctx);
      await featuredJob(ctx, { config: FEATURED_V2 });
    }
    else if (job === 'featured-report') {
      for (const version of ['featured-v1', 'featured-v2']) {
      const r = await featuredReport(ctx, { version });
      const pct = (x: number | null) => (x === null ? '-' : `${(x * 100).toFixed(1)}%`);
      console.log(`featured list ${r.version} since ${r.since.toISOString().slice(0, 10)} — verdict: ${r.verdict} (needs ${r.trial.minPicks}, extends to ${r.trial.extendTo}; ADR 0003 must also have a verdict)`);
      console.log(`criteria: ${JSON.stringify(r.criteria)} · dropped at LINEUP: ${r.dropped} · days: ${JSON.stringify(r.days)}`);
      console.table(
        (['featured', 'all'] as const).map((who) => ({ who, picks: r[who].picks, settled: r[who].settled, fairHitRate: pct(r[who].fairHitRate), clvN: r[who].clvN, clvMean: pct(r[who].clvMean) })),
      );
    }
    }
    else if (job === 'shadow-report') {
      const r = await shadowReport(ctx);
      const pct = (x: number | null) => (x === null ? '-' : `${(x * 100).toFixed(1)}%`);
      console.log(`shadow trial ${r.version} since ${r.since.toISOString().slice(0, 10)} — verdict: ${r.verdict}`);
      console.log(`criteria: ${JSON.stringify(r.criteria)} · CLV diff ${pct(r.clvDiff)} ± ${pct(r.clvSe)} (SE)`);
      console.table(
        r.rounds.flatMap((x) =>
          (['shadow', 'real'] as const).map((who) => ({
            round: x.round,
            rules: who,
            picks: x[who].picks,
            settled: x[who].settled,
            fairHitRate: pct(x[who].fairHitRate),
            clvN: x[who].clvN,
            clvMean: pct(x[who].clvMean),
            sides: JSON.stringify(x[who].sides),
          })),
        ),
      );
    }
    else if (job === 'hybrid') await hybridJob(ctx, { budgetMinutes: values['budget-minutes'] ? Number(values['budget-minutes']) : undefined });
    else if (job === 'ai-shadow') await aiShadowJob(ctx);
    else if (job === 'preview') await matchPreviewJob(ctx, { hours: values.hours ? Number(values.hours) : undefined, until: values.until ? untilDate(values.until) : undefined, refresh: values.refresh, budgetMinutes: values['budget-minutes'] ? Number(values['budget-minutes']) : undefined });
    else if (job === 'report') {
      const r = await matchReport(ctx, { hours: values.hours ? Number(values.hours) : undefined });
      console.log(r.markdown);
      console.log(`\nsaved: ${r.path}`);
    }
    else if (job === 'health') await healthJob(ctx);
    else if (job === 'refresh-web') await refreshWebJob(ctx);
    else if (job === 'impact') await playerImpactJob(ctx, { hours: values.hours ? Number(values.hours) : undefined });
    else if (job === 'candidates') await generateCandidatesJob(ctx, { hours: values.hours ? Number(values.hours) : undefined });
    else await backtest(ctx, { warmupMatches: values.warmup ? Number(values.warmup) : undefined });
  } finally {
    await ctx.db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
