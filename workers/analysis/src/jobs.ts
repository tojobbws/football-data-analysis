import {
  adjustTotals,
  baseRates,
  calibrateImpact,
  computeElo,
  cropMatrix,
  SNAPSHOT_MAX_GOALS,
  crossLeagueExpectedGoals,
  crossLeagueGate,
  UNKNOWN_LEAGUE,
  CROSS_LEAGUE_VERSION,
  dcWalkForward,
  fitCrossLeague,
  mixScoreMatrices,
  IMPACT_VERSION,
  matchContexts,
  sortByTime,
  type ImpactCalibration,
  DIXON_COLES_VERSION,
  ELO_VERSION,
  eloOneXTwo,
  expectedGoals,
  fitDixonColes,
  priceMarkets,
  scoreMatrix,
  tuneLeague,
  walkForwardBacktest,
  type BacktestReport,
  type DixonColesOptions,
  type MatchRecord,
  type TuneResult,
} from '@fp/analysis';
import { runJob, type JobContext, type ModelConfig, type Row } from '@fp/database';
import { addDays, CROSS_LEAGUE_CUPS } from '@fp/shared';

export const ENSEMBLE_VERSION = 'ensemble-v0.1';

/**
 * Cross-league cups: share of the cup-only Dixon-Coles in the sides score matrix (rest = cross-league model).
 * 0.5 was the setting validated in scripts/backtest-pooled.ts (beat cup-only and base rates on 1X2).
 */
export const CROSS_LEAGUE_BLEND = 0.5;
export const CROSS_LEAGUE_PRIOR = 4;

/** Model needs at least this many finished league matches to say anything. */
export const MIN_MATCHES_TO_MODEL = 30;
/** Tuning needs enough matches for warm-up + tune + holdout. */
export const MIN_MATCHES_TO_TUNE = 250;
/** Fixtures with lineups for both teams needed before the Player Impact layer can be calibrated. */
export const MIN_LINEUP_MATCHES_FOR_IMPACT = 300;

/** Used only until a league has been tuned (`npm run model:tune`). */
export const DEFAULT_DC: Required<Pick<DixonColesOptions, 'priorStrength' | 'halfLifeDays' | 'xgWeight' | 'redCardDiscount'>> = {
  priorStrength: 8,
  halfLifeDays: 365,
  xgWeight: 0.5,
  redCardDiscount: 0,
};

const round = (x: number, d = 5) => Math.round(x * 10 ** d) / 10 ** d;

function xgShareOf(history: readonly MatchRecord[]) {
  return history.length ? history.filter((m) => m.homeXg != null && m.awayXg != null).length / history.length : 0;
}

function eventsShareOf(history: ReadonlyArray<{ eventsKnown: boolean }>) {
  return history.length ? history.filter((m) => m.eventsKnown).length / history.length : 0;
}

// ---------------------------------------------------------------------------
// TUNE
// ---------------------------------------------------------------------------

/**
 * Per-league grid search with a time split. Writes the chosen settings and
 * holdout metrics to model_configs (append-only). `enabled` gates each market.
 */
export function tune(ctx: JobContext, opts: { leagues?: number[] } = {}) {
  const leagues = opts.leagues ?? ctx.env.TRACKED_LEAGUES;
  return runJob(ctx, 'tune', { leagues }, async () => {
    const results: Record<number, TuneResult | { skipped: string }> = {};
    const impacts: Record<number, ImpactCalibration | string> = {};
    const crossGates: Record<number, ReturnType<typeof crossLeagueGate>> = {};
    let written = 0;
    for (const league of leagues) {
      const log = ctx.log.child({ league });
      const history = await ctx.repo.finishedMatches(league);
      if (history.length < MIN_MATCHES_TO_TUNE) {
        results[league] = { skipped: `only ${history.length} finished matches (need ${MIN_MATCHES_TO_TUNE})` };
        log.warn('skip tuning', { matches: history.length });
        continue;
      }
      const started = Date.now();
      const r = tuneLeague(history, { warmupMatches: Math.min(150, Math.floor(history.length * 0.25)), xgShare: xgShareOf(history), eventsShare: eventsShareOf(history) });
      log.info('tuned', { ms: Date.now() - started, combos: r.combosTried });
      results[league] = r;

      // A cup priced with the cross-league mix is gated on that mix, not on the cup-only fit.
      const domesticLeagues = CROSS_LEAGUE_CUPS[league];
      let crossGate: ReturnType<typeof crossLeagueGate> | null = null;
      if (domesticLeagues) {
        const domestic = new Map<number, MatchRecord[]>();
        for (const l of domesticLeagues) domestic.set(l, await ctx.repo.finishedMatches(l));
        crossGate = crossLeagueGate(history, domestic, {
          dixonColes: r.sides.params,
          blend: CROSS_LEAGUE_BLEND,
          leaguePrior: CROSS_LEAGUE_PRIOR,
          warmupMatches: Math.min(150, Math.floor(history.length * 0.25)),
        });
        log.info('cross-league gate', { holdout: crossGate.holdoutN, z: crossGate.test.z, cupOnlyZ: r.sides.test.z, enabled: crossGate.enabled });
        crossGates[league] = crossGate;
      }

      const common = { matchesEvaluated: r.matchesEvaluated, leagueId: league };
      const split = { tuneN: r.tuneN, holdoutN: r.holdoutN };
      written += await ctx.repo.insertModelConfigs([
        {
          ...common,
          purpose: 'SIDES',
          modelVersionId: DIXON_COLES_VERSION,
          params: r.sides.params,
          metrics: {
            ...split,
            tune: r.sides.tune,
            holdout: r.sides.holdout,
            baselineHoldout: r.sides.baselineHoldout,
            skill: r.sides.skill,
            test: crossGate?.test ?? r.sides.test,
            ...(crossGate ? { cupOnlyTest: r.sides.test, crossLeague: crossGate } : {}),
            redCard: r.redCard.sides,
            matchesWithRedCard: r.redCard.matchesWithRedCard,
          },
          enabled: crossGate ? crossGate.enabled : r.sides.enabled,
        },
        {
          ...common,
          purpose: 'TOTALS',
          modelVersionId: DIXON_COLES_VERSION,
          params: r.totals.params,
          metrics: {
            ...split,
            tuneBrier: r.totals.tuneBrier,
            holdoutBrier: r.totals.holdoutBrier,
            baselineHoldoutBrier: r.totals.baselineHoldoutBrier,
            untunedHoldoutBrier: r.totals.untunedHoldoutBrier,
            skill: r.totals.skill,
            test: r.totals.test,
            redCard: r.redCard.totals,
          },
          enabled: r.totals.enabled,
        },
        { ...common, purpose: 'ELO', modelVersionId: ELO_VERSION, params: r.elo.params, metrics: { ...split, holdout: r.elo.holdout }, enabled: true },
        {
          ...common,
          purpose: 'ENSEMBLE',
          modelVersionId: ENSEMBLE_VERSION,
          params: { weightDixonColes: r.ensemble.weight, sides: r.sides.params, elo: r.elo.params },
          metrics: {
            ...split,
            candidateWeight: r.ensemble.candidateWeight,
            tuneTestVsDc: r.ensemble.tuneTestVsDc,
            holdout: r.ensemble.holdout,
            skill: r.ensemble.skill,
            test: r.ensemble.test,
          },
          enabled: r.ensemble.enabled,
        },
      ]);

      // Player Impact calibration (needs historical lineups + player stats: run sync:details)
      const lineups = await ctx.repo.lineupsForLeague(league);
      const teamsPerFixture = new Map<string, number>();
      for (const k of lineups.keys()) teamsPerFixture.set(k.split(':')[0]!, (teamsPerFixture.get(k.split(':')[0]!) ?? 0) + 1);
      const lineupMatches = [...teamsPerFixture.values()].filter((n) => n >= 2).length;
      if (lineupMatches < MIN_LINEUP_MATCHES_FOR_IMPACT) {
        impacts[league] = `need ${MIN_LINEUP_MATCHES_FOR_IMPACT} matches with lineups, have ${lineupMatches} (run sync:details)`;
      } else {
        const stats = await ctx.repo.playerStatsForLeague(league);
        const sorted = sortByTime(history);
        const warmup = Math.min(150, Math.floor(history.length * 0.25));
        const ctxs = matchContexts(sorted, warmup);
        const dc = dcWalkForward(sorted, { warmupMatches: warmup, refitEveryDays: 14, dixonColes: r.sides.params });
        const cal = calibrateImpact({ matches: sorted, ctxs, dc, stats, lineups });
        impacts[league] = cal;
        written += await ctx.repo.insertModelConfigs([
          {
            leagueId: league,
            purpose: 'IMPACT',
            modelVersionId: IMPACT_VERSION,
            params: { alpha: cal.alpha },
            metrics: { ...cal },
            enabled: cal.enabled,
            matchesEvaluated: cal.eligible,
          },
        ]);
      }
    }
    printTune(results, impacts, crossGates);
    return written;
  });
}

function printTune(
  results: Record<number, TuneResult | { skipped: string }>,
  impacts: Record<number, ImpactCalibration | string> = {},
  crossGates: Record<number, ReturnType<typeof crossLeagueGate>> = {},
) {
  const pct = (x: number) => `${round(x * 100, 2)}%`;
  console.table(
    Object.entries(results).map(([league, r]) =>
      'skipped' in r
        ? { league, note: r.skipped }
        : {
            league,
            holdout: r.holdoutN,
            'sides (prior/hl/xg)': `${r.sides.params.priorStrength}/${r.sides.params.halfLifeDays}/${r.sides.params.xgWeight}`,
            'red card 1X2/OU': redCardCell(r),
            '1X2 skill (z)': `${pct(r.sides.skill)} (${round(r.sides.test.z, 1)})`,
            'ens w(DC)': r.ensemble.weight === r.ensemble.candidateWeight ? r.ensemble.weight : `${r.ensemble.weight} (grid ${r.ensemble.candidateWeight})`,
            'ens skill (z)': `${pct(r.ensemble.skill)} (${round(r.ensemble.test.z, 1)})`,
            'O/U shrink': r.totals.params.totalsShrink,
            'O/U skill (z)': `${pct(r.totals.skill)} (${round(r.totals.test.z, 1)})`,
            'O/U untuned→tuned': r.totals.untunedHoldoutBrier == null ? '-' : `${round(r.totals.untunedHoldoutBrier, 4)}→${round(r.totals.holdoutBrier, 4)}`,
            '1X2': r.ensemble.enabled ? 'ON' : 'off',
            AH: (crossGates[Number(league)]?.enabled ?? r.sides.enabled) ? 'ON' : 'off',
            'cross-league z': crossGates[Number(league)] ? `${round(crossGates[Number(league)]!.test.z, 1)} (cup only ${round(r.sides.test.z, 1)})` : '-',
            Impact: impactCell(impacts[Number(league)]),
            'O/U': r.totals.enabled ? 'ON' : 'off',
          },
    ),
  );
  console.log('skill = improvement vs league base rates on the most recent 30% (holdout); z = paired significance.');
  console.log('ON = z >= 1.28 (90% one-sided) with >= 100 holdout matches. "grid" = Elo blend rejected (not significantly better than DC on the tune split).');
  console.log('red card = down-weight matches with an early red card; kept only if z >= 1.28 vs off on the tune split (n = matches with a red card).');
}

function redCardCell(r: TuneResult) {
  const one = (c: TuneResult['redCard']['sides']) => (c.tuneTest ? `${c.discount || 'off'}(z${round(c.tuneTest.z, 1)})` : '-');
  return `${one(r.redCard.sides)} / ${one(r.redCard.totals)} n=${r.redCard.matchesWithRedCard}`;
}

function impactCell(c: ImpactCalibration | string | undefined) {
  if (c === undefined) return '-';
  if (typeof c === 'string') return 'no data';
  return `${c.enabled ? 'ON' : 'off'} α=${c.alpha} z=${round(c.test.z, 1)} n=${c.holdoutN}`;
}

// ---------------------------------------------------------------------------
// PROBABILITIES
// ---------------------------------------------------------------------------

/**
 * Probability Engine: for upcoming fixtures, fit models on past matches only and store
 * 1X2 / AH / O/U in `probability_predictions` (insert-only). Uses tuned configs when present.
 * Probabilities come ONLY from here — never from the LLM.
 */
export function computeProbabilities(ctx: JobContext, opts: { days?: number; minGapHours?: number; now?: Date } = {}) {
  const leagues = ctx.env.TRACKED_LEAGUES;
  const days = opts.days ?? 7;
  const minGapMs = (opts.minGapHours ?? 6) * 3_600_000;
  return runJob(ctx, 'probabilities', { leagues, days }, async () => {
    const now = opts.now ?? new Date();
    await ctx.repo.ensureModelVersion(DIXON_COLES_VERSION, 'Dixon-Coles Poisson, time-decayed, xG-blended, shrinkage prior, totals shrink; per-league tuned', {});
    await ctx.repo.ensureModelVersion(ELO_VERSION, 'Elo with home advantage and goal-difference multiplier; heuristic draw share', {});
    await ctx.repo.ensureModelVersion(ENSEMBLE_VERSION, 'Linear blend of Dixon-Coles and Elo 1X2, weight tuned per league', {});

    let written = 0;
    for (const league of leagues) {
      const log = ctx.log.child({ league });
      const history = await ctx.repo.finishedMatches(league);
      if (history.length < MIN_MATCHES_TO_MODEL) {
        log.warn('not enough finished matches to model this league', { matches: history.length, need: MIN_MATCHES_TO_MODEL });
        continue;
      }
      const upcoming = await ctx.repo.upcomingFixturesWithTeams(league, now.toISOString(), addDays(now, days).toISOString());
      if (!upcoming.length) continue;

      const cfg = await ctx.repo.latestModelConfigs(league);
      const sidesP = dcParams(cfg.SIDES) ?? DEFAULT_DC;
      const totalsP = dcParams(cfg.TOTALS) ?? sidesP;
      const totalsShrink = Number(cfg.TOTALS?.params.totalsShrink ?? 0);
      const eloP = cfg.ELO ? { k: Number(cfg.ELO.params.k), homeAdvantage: Number(cfg.ELO.params.homeAdvantage) } : {};
      const ensembleW = cfg.ENSEMBLE ? Number(cfg.ENSEMBLE.params.weightDixonColes) : null;
      if (!cfg.SIDES) log.warn('league not tuned yet — using defaults, all markets gated off (run `npm run model:tune`)');

      const sides = fitDixonColes(history, now, sidesP);
      const totals = sameParams(sidesP, totalsP) ? sides : fitDixonColes(history, now, totalsP);
      // cups between leagues: also learn from the teams' domestic leagues (sides only; totals unchanged)
      const domesticLeagues = CROSS_LEAGUE_CUPS[league];
      let cross: ReturnType<typeof fitCrossLeague> | null = null;
      if (domesticLeagues) {
        const domestic = new Map<number, MatchRecord[]>();
        for (const l of domesticLeagues) domestic.set(l, await ctx.repo.finishedMatches(l));
        cross = fitCrossLeague(history, domestic, now, { dixonColes: sidesP, leaguePrior: CROSS_LEAGUE_PRIOR });
        log.info('cross-league model', { domesticMatches: [...domestic.values()].reduce((n, ms) => n + ms.length, 0), cupMatches: cross.cupMatchesUsed });
      }
      const elo = computeElo(history, now, eloP);
      const drawRate = baseRates(history).p[1];

      const gates = {
        MATCH_WINNER: Boolean(cfg.ENSEMBLE?.enabled ?? cfg.SIDES?.enabled ?? false),
        ASIAN_HANDICAP: Boolean(cfg.SIDES?.enabled ?? false),
        OVER_UNDER: Boolean(cfg.TOTALS?.enabled ?? false),
      };
      const configIds = { sides: cfg.SIDES?.id ?? null, totals: cfg.TOTALS?.id ?? null, elo: cfg.ELO?.id ?? null, ensemble: cfg.ENSEMBLE?.id ?? null };

      for (const f of upcoming) {
        const offered = await ctx.repo.offeredLines(f.id);
        const last = await ctx.repo.lastProbabilityAt(f.id, DIXON_COLES_VERSION);
        if (last && now.getTime() - last.getTime() < minGapMs) {
          // recent run — only recompute if the market now offers a line we have not priced
          const priced = await ctx.repo.latestProbabilities(f.id, DIXON_COLES_VERSION);
          const has = (m: string, sel: string, l: number) => priced.some((p) => p.market === m && p.selection === sel && p.line !== null && Math.abs(p.line - l) < 1e-9);
          const covered = offered.ou.every((l) => has('OVER_UNDER', 'OVER', l)) && offered.ahHome.every((h) => has('ASIAN_HANDICAP', 'HOME', h));
          if (covered) continue;
        }

        const computedAt = now.toISOString();
        // data behind a team's strength: its cup matches, plus its domestic league's when the cross-league mix prices it
        const weighted = (team: number) => (sides.teamMatches.get(team) ?? 0) + (cross ? (cross.within.get(cross.teamLeague.get(team) ?? UNKNOWN_LEAGUE)?.teamMatches.get(team) ?? 0) : 0);

        const gs = expectedGoals(sides, f.homeTeamId, f.awayTeamId);
        const gx = cross ? crossLeagueExpectedGoals(cross, f.homeTeamId, f.awayTeamId) : null;
        const cupOnly = scoreMatrix(gs.lambda, gs.mu, sides.rho);
        const sidesMatrix = gx ? mixScoreMatrices(cupOnly, scoreMatrix(gx.lambda, gx.mu, sides.rho), CROSS_LEAGUE_BLEND) : cupOnly;
        const gt = adjustTotals(expectedGoals(totals, f.homeTeamId, f.awayTeamId), totals.leagueMeanTotal, totalsShrink);
        const totalsMatrix = scoreMatrix(gt.lambda, gt.mu, totals.rho);

        const priced = [
          ...priceMarkets(sidesMatrix, { ou: [], ahHome: offered.ahHome.length ? offered.ahHome : undefined }),
          ...priceMarkets(totalsMatrix, { ou: offered.ou.length ? offered.ou : undefined, ahHome: [] }).filter((p) => p.market === 'OVER_UNDER'),
        ];

        const inputs = {
          lambda: round(gs.lambda, 4),
          mu: round(gs.mu, 4),
          totalsLambda: round(gt.lambda, 4),
          totalsMu: round(gt.mu, 4),
          rho: sides.rho,
          homeAdv: round(sides.homeAdv, 4),
          leagueMeanTotal: round(totals.leagueMeanTotal, 3),
          home: { attack: round(sides.attack.get(f.homeTeamId) ?? 1, 4), defence: round(sides.defence.get(f.homeTeamId) ?? 1, 4), weightedMatches: round(weighted(f.homeTeamId), 2) },
          away: { attack: round(sides.attack.get(f.awayTeamId) ?? 1, 4), defence: round(sides.defence.get(f.awayTeamId) ?? 1, 4), weightedMatches: round(weighted(f.awayTeamId), 2) },
          params: { sides: sidesP, totals: { ...totalsP, totalsShrink } },
          configIds,
          gates,
          matchesUsed: sides.matchesUsed,
          xgShare: round(xgShareOf(history), 3),
          trainedUntil: now.toISOString(),
          linesFromMarket: offered.ou.length + offered.ahHome.length > 0,
          ...(gx && cross
            ? {
                crossLeague: {
                  version: CROSS_LEAGUE_VERSION,
                  weightCupOnly: CROSS_LEAGUE_BLEND,
                  lambda: round(gx.lambda, 4),
                  mu: round(gx.mu, 4),
                  homeLeague: gx.homeLeague,
                  awayLeague: gx.awayLeague,
                  leagueAttack: Object.fromEntries([...cross.leagueAttack].map(([l, v]) => [l, round(v, 4)])),
                  leagueDefence: Object.fromEntries([...cross.leagueDefence].map(([l, v]) => [l, round(v, 4)])),
                  cupMatchesUsed: cross.cupMatchesUsed,
                },
              }
            : {}),
        };

        const rows: Row[] = priced.map((p, i) => ({
          fixture_id: f.id,
          model_version_id: DIXON_COLES_VERSION,
          computed_at: computedAt,
          market: p.market,
          selection: p.selection,
          line: p.line,
          probability: round(p.probability),
          inputs: i === 0 ? { ...inputs, distribution: roundDist(p.distribution) } : { distribution: roundDist(p.distribution) },
        }));

        const e = eloOneXTwo(elo, f.homeTeamId, f.awayTeamId, drawRate);
        const eloP3 = [e.home, e.draw, e.away] as const;
        const dcP3 = (['HOME', 'DRAW', 'AWAY'] as const).map((s) => priced.find((p) => p.market === 'MATCH_WINNER' && p.selection === s)!.probability);
        (['HOME', 'DRAW', 'AWAY'] as const).forEach((sel, i) => {
          rows.push({
            fixture_id: f.id,
            model_version_id: ELO_VERSION,
            computed_at: computedAt,
            market: 'MATCH_WINNER',
            selection: sel,
            line: null,
            probability: round(eloP3[i]!),
            inputs: i === 0 ? { homeRating: round(e.homeRating, 1), awayRating: round(e.awayRating, 1), expected: round(e.expected, 4), drawRate: round(drawRate, 4), params: eloP } : null,
          });
          if (ensembleW !== null) {
            rows.push({
              fixture_id: f.id,
              model_version_id: ENSEMBLE_VERSION,
              computed_at: computedAt,
              market: 'MATCH_WINNER',
              selection: sel,
              line: null,
              probability: round(ensembleW * dcP3[i]! + (1 - ensembleW) * eloP3[i]!),
              inputs: i === 0 ? { weightDixonColes: ensembleW, configId: configIds.ensemble, enabled: gates.MATCH_WINNER } : null,
            });
          }
        });
        written += await ctx.repo.insertProbabilityPredictions(rows);
        await ctx.repo.insertScorelineSnapshot({
          fixture_id: f.id,
          model_version_id: DIXON_COLES_VERSION,
          computed_at: computedAt,
          source: 'live',
          max_goals: SNAPSHOT_MAX_GOALS,
          sides_lambda: round(gs.lambda, 4),
          sides_mu: round(gs.mu, 4),
          sides_rho: round(sides.rho, 4),
          sides_matrix: cropMatrix(sidesMatrix),
          totals_lambda: round(gt.lambda, 4),
          totals_mu: round(gt.mu, 4),
          totals_matrix: cropMatrix(totalsMatrix),
        });
      }
    }
    return written;
  });
}

function dcParams(c: ModelConfig | undefined) {
  if (!c) return null;
  return {
    priorStrength: Number(c.params.priorStrength),
    halfLifeDays: Number(c.params.halfLifeDays),
    xgWeight: Number(c.params.xgWeight),
    // configs tuned before the red-card step have no value -> off (same behaviour as before)
    redCardDiscount: Number(c.params.redCardDiscount ?? 0),
  };
}

function sameParams(a: typeof DEFAULT_DC, b: typeof DEFAULT_DC) {
  return a.priorStrength === b.priorStrength && a.halfLifeDays === b.halfLifeDays && a.xgWeight === b.xgWeight && a.redCardDiscount === b.redCardDiscount;
}

function roundDist(d: { win: number; halfWin: number; push: number; halfLoss: number; loss: number }) {
  return { win: round(d.win, 4), halfWin: round(d.halfWin, 4), push: round(d.push, 4), halfLoss: round(d.halfLoss, 4), loss: round(d.loss, 4) };
}

// ---------------------------------------------------------------------------
// BACKTEST (report only, uses tuned settings when available)
// ---------------------------------------------------------------------------

export function backtest(ctx: JobContext, opts: { warmupMatches?: number } = {}) {
  const leagues = ctx.env.TRACKED_LEAGUES;
  return runJob(ctx, 'backtest', { leagues, ...opts }, async () => {
    const reports: Record<number, (BacktestReport & { tuned: boolean }) | { skipped: string }> = {};
    for (const league of leagues) {
      const history: MatchRecord[] = await ctx.repo.finishedMatches(league);
      const warmup = opts.warmupMatches ?? Math.min(150, Math.max(MIN_MATCHES_TO_MODEL, Math.floor(history.length * 0.3)));
      if (history.length < warmup + 30) {
        reports[league] = { skipped: `only ${history.length} finished matches` };
        continue;
      }
      const cfg = await ctx.repo.latestModelConfigs(league);
      const rep = walkForwardBacktest(history, {
        warmupMatches: warmup,
        refitEveryDays: 7,
        dixonColes: dcParams(cfg.SIDES) ?? DEFAULT_DC,
        totalsShrink: Number(cfg.TOTALS?.params.totalsShrink ?? 0),
        elo: cfg.ELO ? { k: Number(cfg.ELO.params.k), homeAdvantage: Number(cfg.ELO.params.homeAdvantage) } : undefined,
        ensembleWeight: cfg.ENSEMBLE ? Number(cfg.ENSEMBLE.params.weightDixonColes) : 0.5,
      });
      reports[league] = { ...rep, tuned: Boolean(cfg.SIDES) };
    }
    printReport(reports);
    return Object.values(reports).filter((r) => 'matchesEvaluated' in r).length;
  });
}

function printReport(reports: Record<number, (BacktestReport & { tuned: boolean }) | { skipped: string }>) {
  console.table(
    Object.entries(reports).map(([league, r]) =>
      'skipped' in r
        ? { league, matches: 0, note: r.skipped }
        : {
            league,
            tuned: r.tuned ? 'yes' : 'no',
            matches: r.matchesEvaluated,
            'DC logloss': round(r.oneXTwo.dixonColes.logLoss, 4),
            'Elo logloss': round(r.oneXTwo.elo.logLoss, 4),
            'Ens logloss': round(r.oneXTwo.ensemble.logLoss, 4),
            'Base logloss': round(r.oneXTwo.baseline.logLoss, 4),
            'O2.5 Brier DC': round(r.over25.dixonColesBrier, 4),
            'O2.5 Brier base': round(r.over25.baselineBrier, 4),
            skill: `${round(r.skillVsBaseline * 100, 2)}%`,
          },
    ),
  );
  console.log('Full-period walk-forward (includes the tuning period — use `model:tune` holdout numbers for honest gating).');
}
