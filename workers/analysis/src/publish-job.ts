/**
 * Phase 6 — Publish.
 *
 * Takes the latest rule-based decision (Phase 5) of each upcoming fixture and writes it to the
 * immutable track record (`analysis_predictions`, hash-chained) together with a snapshot of
 * everything the system knew at that moment (`analysis_snapshots`).
 *
 * Two rounds per fixture:
 *   EARLY  — within 24h of kickoff (before lineups)
 *   LINEUP — 15–80 min before kickoff, after confirmed lineups (Player Impact uses real lineups)
 * 🌫️ NO_CLEAR_SIGNAL is published too: coverage and honesty count as much as hits.
 */
import { buildReason, DEFAULT_RULES, IMPACT_VERSION, publishRoundFor, selectionLabel, type MissingPlayer, type PublishRound } from '@fp/analysis';
import { runJob, type JobContext } from '@fp/database';
import { addHours } from '@fp/shared';

export interface PublishOptions {
  now?: Date;
  rulesVersion?: string;
  /** decision must be at most this old (minutes) */
  maxRunAgeMinutes?: Partial<Record<PublishRound, number>>;
}

export function publishJob(ctx: JobContext, opts: PublishOptions = {}) {
  const leagues = ctx.env.TRACKED_LEAGUES;
  const rulesVersion = opts.rulesVersion ?? DEFAULT_RULES.version;
  const maxAge = { EARLY: 240, LINEUP: 75, ...opts.maxRunAgeMinutes };
  return runJob(ctx, 'publish', { leagues, rulesVersion }, async () => {
    const now = opts.now ?? new Date();
    const fixtures = await ctx.repo.fixturesForCandidates(leagues, now.toISOString(), addHours(now, 24).toISOString());
    const report: Array<Record<string, unknown>> = [];
    let published = 0;

    for (const f of fixtures) {
      const lineups = await ctx.repo.lineupsForFixture(f.id);
      const hasLineups = [f.homeTeamId, f.awayTeamId].every((t) => (lineups.get(`${f.id}:${t}`)?.starters.size ?? 0) >= 11);
      const round = publishRoundFor(f.kickoffAt, now, hasLineups);
      if (!round) continue;
      if (await ctx.repo.isPublished(f.id, round)) continue;

      const run = await ctx.repo.latestRun(f.id, rulesVersion);
      const skip = (why: string) => report.push({ fixture: f.id, round, result: 'SKIP', note: why });
      if (!run) {
        skip('no decision yet (run model:candidates)');
        continue;
      }
      if (now.getTime() - run.startedAt.getTime() > maxAge[round] * 60_000) {
        skip('decision too old (run model:candidates)');
        continue;
      }
      if (round === 'LINEUP') {
        const lineupAt = await ctx.repo.lineupSyncedAt(f.id);
        if (lineupAt && run.startedAt < lineupAt) {
          skip('decision older than the confirmed lineup');
          continue;
        }
      }

      const header = (await ctx.repo.fixtureHeader(f.id))!;
      const cands = await ctx.repo.runCandidates(run.id);
      const pick = run.outcome === 'SIGNAL' ? cands.find((c) => c.rank === 1) ?? null : null;
      const summary = run.summary as {
        rejectReasons?: Record<string, number>;
        modelSource?: string;
        impact?: { used: boolean; home: ImpactSide; away: ImpactSide } | null;
      };

      // Player Impact details (names) from the latest impact rows
      const impactRow = (await ctx.repo.latestProbabilities(f.id, IMPACT_VERSION)).find((r) => r.inputs && 'impact' in r.inputs);
      const impactFull = impactRow?.inputs?.impact as { home: ImpactSide; away: ImpactSide; alpha: number; enabled: boolean } | undefined;

      const move = pick ? await ctx.repo.selectionMovement(f.id, pick.market, pick.selection, pick.line) : null;
      const label = pick ? selectionLabel(pick.market, pick.selection, pick.line, header.home, header.away) : null;
      const factors = (pick?.factors ?? {}) as { strength?: string | null; agreement?: boolean | null; gateZ?: number | null; nBookmakers?: number; modelSource?: string };

      const reason = buildReason({
        kind: pick ? 'SIGNAL' : 'NO_CLEAR_SIGNAL',
        round,
        home: header.home,
        away: header.away,
        pick: pick
          ? {
              label: label!,
              modelProbability: pick.modelProbability,
              marketProbability: pick.marketProbability ?? 0,
              odds: pick.odds ?? 0,
              nBookmakers: Number(factors.nBookmakers ?? 0),
              strength: factors.strength ?? null,
              agreement: factors.agreement ?? null,
              gateZ: factors.gateZ ?? null,
              modelSource: summary.modelSource ?? 'DC',
            }
          : null,
        rejectReasons: summary.rejectReasons,
        impact: impactFull ? { home: impactFull.home, away: impactFull.away } : null,
        marketMove: move ? { opening: move.opening, current: move.current } : null,
      });

      const prediction = {
        fixture_id: f.id,
        publish_round: round,
        run_id: run.id,
        candidate_id: pick?.id ?? null,
        kind: pick ? 'SIGNAL' : 'NO_CLEAR_SIGNAL',
        market: pick?.market ?? null,
        selection: pick?.selection ?? null,
        line: pick?.line ?? null,
        odds_at_publish: pick?.odds ?? null,
        model_probability: pick ? round5(pick.modelProbability) : null,
        market_probability: pick?.marketProbability != null ? round5(pick.marketProbability) : null,
        signal_strength: pick ? (factors.strength ?? 'LEAN') : null,
        reason,
        model_version_id: summary.modelSource === 'DC+IMPACT' ? IMPACT_VERSION : (run.modelVersionId ?? null),
        decision_rule_version: run.rulesVersion,
        prompt_version: null,
      };

      // everything the system knew at publish time
      const [formHome, formAway, apiPred, lineupPlayers, injuries, dcRows] = await Promise.all([
        ctx.repo.teamForm(f.homeTeamId, f.kickoffAt),
        ctx.repo.teamForm(f.awayTeamId, f.kickoffAt),
        ctx.repo.latestApiPrediction(f.id),
        ctx.repo.lineupPlayers(f.id),
        ctx.repo.injuriesDetailed(f.id),
        ctx.repo.latestProbabilities(f.id, run.modelVersionId ?? 'dixon-coles-v0.2'),
      ]);
      const xgAvg = (rows: typeof formHome) => {
        const x = rows.filter((r) => r.xgFor != null);
        return x.length ? { matches: x.length, xgFor: avg(x.map((r) => r.xgFor!)), xgAgainst: avg(x.map((r) => r.xgAgainst ?? 0)) } : null;
      };
      const snapshot = {
        form_snapshot: { home: formHome, away: formAway },
        xg_snapshot: { home: xgAvg(formHome), away: xgAvg(formAway) },
        injury_snapshot: injuries,
        lineup_snapshot: lineupPlayers,
        odds_snapshot: pick ? { reference: pick.odds, best: (pick.factors as Record<string, unknown>).bestOdds ?? null, movement: move } : null,
        market_snapshot: pick ? { marketProbability: pick.marketProbability, nBookmakers: factors.nBookmakers ?? null } : null,
        api_prediction_snapshot: apiPred,
        model_snapshot: {
          modelSource: summary.modelSource ?? null,
          rulesVersion: run.rulesVersion,
          runId: run.id,
          decisionAt: run.startedAt.toISOString(),
          inputs: run.inputs,
          prices: dcRows.map((r) => ({ model: r.modelVersionId, market: r.market, selection: r.selection, line: r.line, p: r.probability })),
          impact: impactFull ?? null,
        },
        candidates_snapshot: cands.map((c) => ({
          market: c.market,
          selection: c.selection,
          line: c.line,
          odds: c.odds,
          model: c.modelProbability,
          market_p: c.marketProbability,
          edge: c.edge,
          rank: c.rank,
          reasons: (c.factors as { rejectReasons?: string[] }).rejectReasons ?? [],
        })),
        ai_reasoning: null,
      };

      const res = await ctx.repo.publishPrediction(prediction, snapshot);
      published++;
      report.push({
        fixture: f.id,
        match: `${header.home} vs ${header.away}`,
        round,
        result: pick ? `🧭 ${label}` : '🌫️ หมอกข้อมูล',
        strength: prediction.signal_strength ?? '-',
        id: res.publicId,
        hash: res.recordHash.slice(0, 12),
      });
    }
    if (report.length) console.table(report);
    return published;
  });
}

interface ImpactSide {
  attackLoss: number;
  defenceLoss: number;
  missing: MissingPlayer[];
}

const avg = (xs: number[]) => Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100;
const round5 = (x: number) => Math.round(x * 1e5) / 1e5;
