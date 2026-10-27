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
 *   PREMATCH — once, only when EARLY was fog published before the league's gates were re-tuned
 *              (docs/adr/0005-prematch-round.md), or EARLY was published under pick rules that
 *              have since been replaced (docs/adr/0009-prematch-after-rules-change.md)
 * 🌫️ NO_CLEAR_SIGNAL is published too: coverage and honesty count as much as hits.
 */
import { buildHybridReason, buildReason, DEFAULT_RULES, IMPACT_VERSION, prematchCause, publishRoundFor, selectionLabel, SHADOW_RULES, type MissingPlayer, type OutcomeDistribution, type PrematchCause, type PublishRound } from '@fp/analysis';
import { HYBRID_ENGINE_VERSION } from '@fp/ai';
import { runJob, type JobContext } from '@fp/database';
import { addHours } from '@fp/shared';

export type PickEngine = 'legacy' | 'shadow' | 'hybrid';

export interface PublishOptions {
  now?: Date;
  rulesVersion?: string;
  /** shadow trial: lock this shadow rules version's pick at each round too (null = off) */
  shadowRulesVersion?: string | null;
  /** decision must be at most this old (minutes) */
  maxRunAgeMinutes?: Partial<Record<PublishRound, number>>;
  /** who makes the published pick; default env PICK_ENGINE (docs/adr/0010-hybrid-ai-picks.md) */
  engine?: PickEngine;
}

/** How old a decision may be when its round is published (minutes). */
export const MAX_DECISION_AGE_MINUTES: Record<PublishRound, number> = { EARLY: 240, PREMATCH: 240, LINEUP: 75 };

type Fx = { id: number; leagueId: number; kickoffAt: Date; homeTeamId: number; awayTeamId: number };

/**
 * The round this fixture is due to publish now, or null. `engineVersion` is the pick engine in force: an EARLY
 * round published under another one earns a PREMATCH round (ADR 0009). The league re-tune cause (ADR 0005)
 * applies to the rules only; the Hybrid AI does not use the league gates.
 */
export async function dueRound(ctx: JobContext, f: Fx, now: Date, opts: { engineVersion: string; gateRetune: boolean }) {
  const lineups = await ctx.repo.lineupsForFixture(f.id);
  const hasLineups = [f.homeTeamId, f.awayTeamId].every((t) => (lineups.get(`${f.id}:${t}`)?.starters.size ?? 0) >= 11);
  let round: PublishRound | null = publishRoundFor(f.kickoffAt, now, hasLineups);
  let gateTunedAt: Date | null = null;
  let cause: PrematchCause | null = null;
  if (round !== 'LINEUP') {
    // also inside the EARLY window: EARLY is already published there, so its round is used up
    const early = await ctx.repo.publication(f.id, 'EARLY');
    if (early) {
      gateTunedAt = opts.gateRetune ? await ctx.repo.gateTunedAt(f.leagueId) : null;
      cause = prematchCause({
        kickoffAt: f.kickoffAt,
        now,
        early,
        gateTunedAt,
        lineupPublished: await ctx.repo.isPublished(f.id, 'LINEUP'),
        prematchPublished: await ctx.repo.isPublished(f.id, 'PREMATCH'),
        rulesVersion: opts.engineVersion,
      });
      if (cause) round = 'PREMATCH';
    }
  }
  return round ? { round, cause, gateTunedAt } : null;
}

/** A decision taken at `at` is still good for its round: recent enough, and for LINEUP after the confirmed lineup. */
export async function decisionFresh(ctx: JobContext, fixtureId: number, round: PublishRound, at: Date, now: Date, maxAge: Record<PublishRound, number> = MAX_DECISION_AGE_MINUTES) {
  if (now.getTime() - at.getTime() > maxAge[round] * 60_000) return 'decision too old';
  if (round === 'LINEUP') {
    const lineupAt = await ctx.repo.lineupSyncedAt(fixtureId);
    if (lineupAt && at < lineupAt) return 'decision older than the confirmed lineup';
  }
  return null;
}

export function publishJob(ctx: JobContext, opts: PublishOptions = {}) {
  const leagues = ctx.env.TRACKED_LEAGUES;
  const engine: PickEngine = opts.engine ?? ctx.env.PICK_ENGINE ?? 'legacy';
  const rulesVersion = opts.rulesVersion ?? DEFAULT_RULES.version;
  const engineVersion = engine === 'hybrid' ? HYBRID_ENGINE_VERSION : rulesVersion;
  const maxAge = { ...MAX_DECISION_AGE_MINUTES, ...opts.maxRunAgeMinutes };
  const shadowVersion = opts.shadowRulesVersion === undefined ? SHADOW_RULES.version : opts.shadowRulesVersion;
  return runJob(ctx, 'publish', { leagues, rulesVersion, engine, engineVersion }, async () => {
    const now = opts.now ?? new Date();
    const fixtures = await ctx.repo.fixturesForCandidates(leagues, now.toISOString(), addHours(now, 24).toISOString());
    const report: Array<Record<string, unknown>> = [];
    let published = 0;
    if (engine === 'hybrid') await ctx.repo.ensureModelVersion(HYBRID_ENGINE_VERSION, 'Hybrid AI decision engine: verified pre-match data + market main lines (ADR 0010)', {});

    for (const f of fixtures) {
      const due = await dueRound(ctx, f, now, { engineVersion, gateRetune: engine !== 'hybrid' });
      if (!due) continue;
      const { round, cause, gateTunedAt } = due;

      // Shadow trial (ADR 0003): lock the shadow pick of this round under the same conditions as a real pick.
      if (shadowVersion && round !== 'PREMATCH' && !(await ctx.repo.isShadowLocked(f.id, shadowVersion, round))) {
        const evaluatedAt = await ctx.repo.latestShadowEvaluation(f.id, shadowVersion);
        const lineupAt = round === 'LINEUP' ? await ctx.repo.lineupSyncedAt(f.id) : null;
        if (evaluatedAt && now.getTime() - evaluatedAt.getTime() <= maxAge[round] * 60_000 && !(lineupAt && evaluatedAt < lineupAt)) {
          await ctx.repo.lockShadowDecision(f.id, shadowVersion, round);
        }
      }
      if (await ctx.repo.isPublished(f.id, round)) continue;
      const skip = (why: string) => report.push({ fixture: f.id, round, result: 'SKIP', note: why });

      if (engine === 'hybrid') {
        // the Hybrid AI's own decision or nothing: a rules pick is never published in its place
        const d = await ctx.repo.latestHybridDecision(f.id, round, HYBRID_ENGINE_VERSION);
        if (!d) {
          skip('no valid Hybrid AI decision (run model:hybrid)');
          continue;
        }
        const stale = await decisionFresh(ctx, f.id, round, d.decidedAt, now, maxAge);
        if (stale) {
          skip(`Hybrid AI ${stale} (run model:hybrid)`);
          continue;
        }
        const header = (await ctx.repo.fixtureHeader(f.id))!;
        const isPick = d.side !== 'NO_PICK' && d.market !== null && d.selection !== null && d.line !== null;
        const label = isPick ? selectionLabel(d.market!, d.selection!, d.line, header.home, header.away) : null;
        const out = (d.output ?? {}) as { supporting_evidence?: string[]; counter_evidence?: string[]; risk_factors?: string[]; missing_data?: string[] };
        const input = d.input as { home_team?: unknown; away_team?: unknown; injuries?: unknown; confirmed_lineup?: unknown; market?: { asian_handicap?: { bookmakers?: number }; over_under?: { bookmakers?: number } } };
        const nBookmakers = d.market === 'ASIAN_HANDICAP' ? input.market?.asian_handicap?.bookmakers : d.market === 'OVER_UNDER' ? input.market?.over_under?.bookmakers : undefined;
        const reason = buildHybridReason({
          kind: isPick ? 'SIGNAL' : 'NO_CLEAR_SIGNAL',
          round,
          engineChanged: cause === 'RULES_CHANGED',
          label,
          summaryTh: d.summaryTh ?? '',
          supporting: out.supporting_evidence ?? [],
          risks: [...(out.risk_factors ?? []), ...(out.counter_evidence ?? [])],
          missing: out.missing_data ?? [],
          confidence: d.confidence,
          odds: d.odds,
          nBookmakers: nBookmakers ?? null,
        });
        const prediction = {
          fixture_id: f.id,
          publish_round: round,
          run_id: null,
          candidate_id: null,
          kind: isPick ? 'SIGNAL' : 'NO_CLEAR_SIGNAL',
          market: isPick ? d.market : null,
          selection: isPick ? d.selection : null,
          line: isPick ? d.line : null,
          odds_at_publish: isPick ? d.odds : null,
          // the AI weighs evidence; it gives no calibrated probability (the check allows null for hybrid engines)
          model_probability: null,
          market_probability: isPick ? d.marketProbability : null,
          signal_strength: isPick ? (d.confidence === 'HIGH' ? 'STRONG' : d.confidence === 'MEDIUM' ? 'MEDIUM' : 'LEAN') : null,
          model_distribution: null,
          reason,
          model_version_id: HYBRID_ENGINE_VERSION,
          decision_rule_version: d.engineVersion,
          prompt_version: d.promptVersion,
        };
        const snapshot = {
          form_snapshot: { home: input.home_team ?? null, away: input.away_team ?? null },
          xg_snapshot: null,
          injury_snapshot: input.injuries ?? null,
          lineup_snapshot: input.confirmed_lineup ?? null,
          odds_snapshot: isPick ? { reference: d.odds, nBookmakers: nBookmakers ?? null } : null,
          market_snapshot: input.market ?? null,
          api_prediction_snapshot: null,
          model_snapshot: { engine: d.engineVersion, legacy: d.legacy },
          candidates_snapshot: [],
          ai_reasoning: { decisionId: d.id, engineVersion: d.engineVersion, promptVersion: d.promptVersion, model: d.model, inputHash: d.inputHash, decidedAt: d.decidedAt.toISOString(), output: d.output },
        };
        const res = await ctx.repo.publishPrediction(prediction, snapshot);
        published++;
        report.push({ fixture: f.id, match: `${header.home} vs ${header.away}`, round, result: isPick ? `🧭 ${label} (AI)` : '🌫️ หมอกข้อมูล (AI)', strength: prediction.signal_strength ?? '-', id: res.publicId, hash: res.recordHash.slice(0, 12) });
        continue;
      }

      const run = await ctx.repo.latestRun(f.id, rulesVersion);
      if (!run) {
        skip('no decision yet (run model:candidates)');
        continue;
      }
      if (now.getTime() - run.startedAt.getTime() > maxAge[round] * 60_000) {
        skip('decision too old (run model:candidates)');
        continue;
      }
      if (round === 'PREMATCH' && gateTunedAt && run.startedAt < gateTunedAt) {
        skip('decision older than the league re-tune');
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
        fogReasons?: Array<{ market: string | null; reason: string }>;
        modelSource?: string;
        impact?: { used: boolean; home: ImpactSide; away: ImpactSide } | null;
      };

      // Player Impact details (names) from the latest impact rows
      const impactRow = (await ctx.repo.latestProbabilities(f.id, IMPACT_VERSION)).find((r) => r.inputs && 'impact' in r.inputs);
      const impactFull = impactRow?.inputs?.impact as { home: ImpactSide; away: ImpactSide; alpha: number; enabled: boolean } | undefined;

      const move = pick ? await ctx.repo.selectionMovement(f.id, pick.market, pick.selection, pick.line) : null;
      const label = pick ? selectionLabel(pick.market, pick.selection, pick.line, header.home, header.away) : null;
      const factors = (pick?.factors ?? {}) as { strength?: string | null; agreement?: boolean | null; gateZ?: number | null; nBookmakers?: number; modelSource?: string; distribution?: OutcomeDistribution | null; onMainLine?: boolean | null };

      const reason = buildReason({
        kind: pick ? 'SIGNAL' : 'NO_CLEAR_SIGNAL',
        round,
        prematchCause: round === 'PREMATCH' ? cause : null,
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
              onMainLine: factors.onMainLine ?? null,
            }
          : null,
        rejectReasons: summary.rejectReasons,
        fogReasons: summary.fogReasons ?? null,
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
        // frozen with the record but not hashed (docs/adr/0001)
        model_distribution: pick ? (factors.distribution ?? null) : null,
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
