import {
  DEFAULT_RULES,
  DIXON_COLES_VERSION,
  ELO_VERSION,
  generateCandidates,
  IMPACT_VERSION,
  SHADOW_RULES,
  type CandidateInput,
  type DecisionRules,
  type MainLine,
  type MarketCode,
  type ModelPrice,
  type OutcomeDistribution,
} from '@fp/analysis';
import { runJob, type JobContext, type ModelConfig } from '@fp/database';
import { addHours, stableStringify } from '@fp/shared';
import { ENSEMBLE_VERSION } from './jobs.js';

/**
 * Phase 5: for fixtures kicking off within `hours`, compare the latest model
 * probabilities with the latest odds, evaluate every selection and store the
 * decision (SIGNAL / NO_CLEAR_SIGNAL) + all candidates. Nothing is published here.
 * A fixture is re-evaluated when probabilities / gates / phase change, or when odds moved and
 * the last evaluation is older than `minGapHours` (keeps storage small on the free tier).
 */
export function generateCandidatesJob(
  ctx: JobContext,
  opts: { hours?: number; now?: Date; rules?: DecisionRules; shadowRules?: DecisionRules | null; minGapHours?: number } = {},
) {
  const leagues = ctx.env.TRACKED_LEAGUES;
  const hours = opts.hours ?? 36;
  const minGapMs = (opts.minGapHours ?? 3) * 3_600_000;
  const rules = opts.rules ?? DEFAULT_RULES;
  const shadowRules = opts.shadowRules === undefined ? SHADOW_RULES : opts.shadowRules;
  return runJob(ctx, 'candidates', { leagues, hours, rules: rules.version }, async () => {
    const now = opts.now ?? new Date();
    const fixtures = await ctx.repo.fixturesForCandidates(leagues, now.toISOString(), addHours(now, hours).toISOString());
    const configs = new Map<number, Partial<Record<string, ModelConfig>>>();
    const report: Array<Record<string, unknown>> = [];
    let written = 0;

    for (const f of fixtures) {
      if (!configs.has(f.leagueId)) configs.set(f.leagueId, await ctx.repo.latestModelConfigs(f.leagueId));
      const cfg = configs.get(f.leagueId)!;

      const c = await candidateContext(ctx.repo, f, cfg, now);
      if (!c) {
        report.push({ fixture: f.id, outcome: 'SKIP', note: 'no probabilities yet (run model:probabilities)' });
        continue;
      }
      const { quotes, computedAt, impact, impactFresh, impactHead, useImpact, input, modelSource } = c;
      const lastOdds = quotes.length ? new Date(Math.max(...quotes.map((q) => q.updatedAt.getTime()))).toISOString() : null;
      const inputsKey = {
        probabilitiesComputedAt: computedAt,
        lastOddsUpdate: lastOdds,
        quotes: quotes.length,
        configIds: { sides: cfg.SIDES?.id ?? null, totals: cfg.TOTALS?.id ?? null, ensemble: cfg.ENSEMBLE?.id ?? null, impact: cfg.IMPACT?.id ?? null },
        impactComputedAt: impactFresh ? impactHead!.computedAt.toISOString() : null,
        // re-evaluate once inside the final hours before kickoff even if nothing else changed
        phase: f.kickoffAt.getTime() - now.getTime() < 3 * 3_600_000 ? 'FINAL' : 'EARLY',
      };
      // Skip when nothing that matters changed. Odds-only changes are re-evaluated at most every `minGapHours`.
      const prev = await ctx.repo.lastAnalysisRun(f.id, rules.version);
      if (prev) {
        const { lastOddsUpdate: _a, quotes: _b, ...stablePrev } = prev.inputs as typeof inputsKey;
        const { lastOddsUpdate: _c, quotes: _d, ...stableNow } = inputsKey;
        const sameStable = stableStringify(stablePrev) === stableStringify(stableNow);
        const sameOdds = prev.inputs.lastOddsUpdate === inputsKey.lastOddsUpdate;
        const recent = now.getTime() - prev.startedAt.getTime() < minGapMs;
        if (sameStable && (sameOdds || recent)) continue;
      }

      const d = generateCandidates(input, rules);

      let rank = 0;
      const rows = d.candidates.map((c) => ({
        fixture_id: f.id,
        market: c.market,
        selection: c.selection,
        line: c.line,
        bookmaker_id: null,
        odds: c.odds,
        model_probability: c.modelProbability ?? 0,
        market_probability: c.marketProbability,
        support_score: c.supportScore,
        rank: c.passed ? ++rank : null,
        factors: {
          passed: c.passed,
          rejectReasons: c.rejectReasons,
          strength: c.strength,
          ev: c.ev,
          hasModelPrice: c.modelProbability !== null,
          agreement: c.agreement,
          gateZ: c.gateZ,
          modelSource,
          nBookmakers: c.nBookmakers,
          bestOdds: c.bestOdds,
          bestBookmakerId: c.bestBookmakerId,
          oddsUpdatedAt: c.oddsUpdatedAt,
          distribution: c.distribution,
          onMainLine: c.onMainLine,
        },
      }));

      // Why this line: the main line, where it came from, and how both of its sides were judged
      const mainLines = Object.values(d.mainLines).map((ml) => ({
        ...ml,
        sides: d.candidates
          .filter((c) => c.market === ml.market && c.onMainLine)
          .map((c) => ({
            selection: c.selection,
            line: c.line,
            modelProbability: c.modelProbability,
            marketProbability: c.marketProbability,
            ev: c.ev,
            passed: c.passed,
            rejectReasons: c.rejectReasons,
          })),
      }));

      await ctx.repo.insertAnalysisRun(
        {
          fixture_id: f.id,
          model_version_id: DIXON_COLES_VERSION,
          decision_rule_version: rules.version,
          outcome: d.outcome,
          inputs: inputsKey,
          summary: {
            ...d.summary,
            decisionReason: d.decisionReason,
            fogReasons: d.fogReasons,
            mainLines,
            rules,
            modelSource,
            impact: impact && impactFresh ? { used: useImpact, home: impact.home, away: impact.away } : null,
          },
          started_at: now.toISOString(),
          finished_at: new Date().toISOString(),
        },
        rows,
      );
      written += rows.length;

      // Shadow rules on the same inputs: kept aside, never published. Not inside the final
      // minutes, where every rule set says "too close to kickoff" and would wipe the shadow pick.
      if (shadowRules && f.kickoffAt.getTime() - now.getTime() >= shadowRules.minMinutesBeforeKickoff * 60_000) {
        const sd = generateCandidates(input, shadowRules);
        const sp = sd.pick;
        await ctx.repo.upsertShadowDecision({
          fixture_id: f.id,
          rules_version: shadowRules.version,
          evaluated_at: now.toISOString(),
          outcome: sd.outcome,
          market: sp?.market ?? null,
          selection: sp?.selection ?? null,
          line: sp?.line ?? null,
          odds: sp?.odds ?? null,
          model_probability: sp?.modelProbability ?? null,
          bias: sp?.bias ?? null,
          market_probability: sp?.marketProbability ?? null,
          edge: sp?.edge ?? null,
          strength: sp?.strength ?? null,
          passed: sd.summary.passed,
        });
      }

      report.push({
        fixture: f.id,
        kickoff: f.kickoffAt.toISOString().slice(0, 16),
        outcome: d.outcome === 'SIGNAL' ? '🧭 SIGNAL' : '🌫️ NO_CLEAR_SIGNAL',
        reason: d.decisionReason,
        mainAH: mainLineCell(d.mainLines.ASIAN_HANDICAP),
        mainOU: mainLineCell(d.mainLines.OVER_UNDER),
        pick: d.pick ? `${d.pick.market} ${d.pick.selection}${d.pick.line === null ? '' : ' ' + d.pick.line}` : '-',
        edge: d.pick?.edge ?? '-',
        odds: d.pick?.odds ?? '-',
        strength: d.pick?.strength ?? '-',
        model: modelSource,
        evaluated: d.summary.evaluated,
        passed: d.summary.passed,
        topReject: topReason(d.summary.rejectReasons),
      });
    }
    if (report.length) console.table(report);
    return written;
  });
}

/**
 * Everything the decision rules read for one fixture: the latest model prices (Player Impact when the
 * league trusts it and it is built on the same Dixon-Coles run, else Dixon-Coles with the ensemble's
 * 1X2), Elo, the latest quotes and the market gates. Null before the Probability Engine has priced it.
 */
export async function candidateContext(
  repo: JobContext['repo'],
  f: { id: number; kickoffAt: Date },
  cfg: Partial<Record<string, ModelConfig>>,
  now: Date,
) {
  const probs = await repo.latestProbabilities(f.id, DIXON_COLES_VERSION);
  if (!probs.length) return null;
  const quotes = await repo.latestQuotes(f.id);
  const computedAt = probs[0]!.computedAt.toISOString();

  // Player Impact layer: use it only if trusted for this league AND built on the same DC run
  const impactRows = await repo.latestProbabilities(f.id, IMPACT_VERSION);
  const impactHead = impactRows.find((r) => r.inputs && 'impact' in r.inputs);
  const impact = impactHead?.inputs?.impact as
    | { key: { basedOn: string }; home: { attackLoss: number; defenceLoss: number }; away: { attackLoss: number; defenceLoss: number } }
    | undefined;
  const impactFresh = Boolean(impact && impact.key.basedOn === computedAt);
  const useImpact = Boolean(cfg.IMPACT?.enabled) && impactFresh;
  const maxLoss = impact && impactFresh ? Math.max(impact.home.attackLoss, impact.home.defenceLoss, impact.away.attackLoss, impact.away.defenceLoss) : 0;
  const gates = {
    MATCH_WINNER: gateOf(cfg.ENSEMBLE ?? cfg.SIDES),
    ASIAN_HANDICAP: gateOf(cfg.SIDES),
    OVER_UNDER: gateOf(cfg.TOTALS),
  };

  // Model prices: ensemble for 1X2 when the league uses it, Dixon-Coles for the rest
  const dc = probs.filter((p) => p.modelVersionId === DIXON_COLES_VERSION);
  const ens = probs.filter((p) => p.modelVersionId === ENSEMBLE_VERSION);
  const elo = probs.filter((p) => p.modelVersionId === ELO_VERSION);
  const toPrice = (p: (typeof probs)[number]): ModelPrice => ({
    market: p.market as MarketCode,
    selection: p.selection,
    line: p.line,
    probability: p.probability,
    distribution: (p.inputs?.distribution as OutcomeDistribution | undefined) ?? null,
  });
  let model: ModelPrice[];
  if (useImpact) {
    model = impactRows.map(toPrice); // impact job already blends 1X2 with Elo when the league uses the ensemble
  } else {
    model = dc.filter((p) => p.market !== 'MATCH_WINNER' || !ens.length).map(toPrice);
    for (const p of ens) model.push({ market: 'MATCH_WINNER', selection: p.selection, line: null, probability: p.probability });
  }
  const modelSource = useImpact ? 'DC+IMPACT' : ens.length ? 'DC/ENSEMBLE' : 'DC';

  const first = dc.find((p) => p.inputs && 'lambda' in p.inputs)?.inputs as
    | { home?: { weightedMatches?: number }; away?: { weightedMatches?: number } }
    | undefined;
  const eloP = (s: string) => elo.find((p) => p.selection === s)?.probability;
  const input: CandidateInput = {
    fixtureId: f.id,
    kickoffAt: f.kickoffAt,
    now,
    model,
    elo1x2: elo.length === 3 ? { home: eloP('HOME')!, draw: eloP('DRAW')!, away: eloP('AWAY')! } : null,
    quotes,
    gates,
    teamData: { homeWeightedMatches: Number(first?.home?.weightedMatches ?? 0), awayWeightedMatches: Number(first?.away?.weightedMatches ?? 0) },
    // absences we know about but did not price in -> big ones block the signal
    unmodelledLoss: useImpact ? 0 : maxLoss,
  };
  return { quotes, computedAt, impact, impactFresh, impactHead, useImpact, input, modelSource };
}

function gateOf(c: ModelConfig | undefined) {
  if (!c) return { enabled: false, z: 0 };
  const test = c.metrics.test as { z?: number } | undefined;
  return { enabled: c.enabled, z: Number(test?.z ?? 0) };
}

/** "-1.25 (6)" when usable, else the status */
function mainLineCell(ml: MainLine) {
  return ml.status === 'OK' ? `${ml.line} (${ml.nBookmakers})` : ml.status;
}

function topReason(r: Partial<Record<string, number>>) {
  const e = Object.entries(r).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0];
  return e ? `${e[0]} (${e[1]})` : '-';
}
