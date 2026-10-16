/**
 * Player Impact layer job (between Probability Engine and Candidate Generator).
 *
 * For each upcoming fixture with Dixon-Coles prices:
 *   who is missing?  (confirmed lineup if published, otherwise the injuries list — unknown when the
 *                     league has no injuries coverage)
 *   -> attack/defence loss per team -> adjusted λ/μ -> re-price the SAME markets/lines
 *   -> write rows as model 'dc-impact-v0.1' (base DC rows are never modified).
 * Rows are written even when the layer is not trusted yet (useful for 🩹 Injury Impact content);
 * the Candidate Generator only USES them when the league's IMPACT config is enabled.
 */
import {
  absencesFromInjuries,
  absencesFromLineup,
  applyImpact,
  buildTeamProfile,
  DIXON_COLES_VERSION,
  ELO_VERSION,
  IMPACT_VERSION,
  NO_LOSS,
  priceSelection,
  scoreMatrix,
  teamLoss,
  type MarketSelection,
  type TeamLoss,
} from '@fp/analysis';
import { runJob, type JobContext, type Row } from '@fp/database';
import { addHours, stableStringify } from '@fp/shared';

/** Used for informational rows until a league is calibrated. */
export const DEFAULT_IMPACT_ALPHA = 0.5;

const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

export function playerImpactJob(ctx: JobContext, opts: { hours?: number; now?: Date } = {}) {
  const leagues = ctx.env.TRACKED_LEAGUES;
  const hours = opts.hours ?? 36;
  return runJob(ctx, 'impact', { leagues, hours }, async () => {
    const now = opts.now ?? new Date();
    await ctx.repo.ensureModelVersion(IMPACT_VERSION, 'Dixon-Coles adjusted for missing players (lineups / injuries); α calibrated per league', {});
    const fixtures = await ctx.repo.fixturesForCandidates(leagues, now.toISOString(), addHours(now, hours).toISOString());
    const report: Array<Record<string, unknown>> = [];
    let written = 0;

    for (const f of fixtures) {
      const dcRows = await ctx.repo.latestProbabilities(f.id, DIXON_COLES_VERSION);
      const base = dcRows.find((r) => r.modelVersionId === DIXON_COLES_VERSION && r.inputs && 'lambda' in r.inputs);
      if (!base) continue;
      const inp = base.inputs as { lambda: number; mu: number; rho: number; totalsLambda?: number; totalsMu?: number; leagueMeanTotal?: number };
      const cfg = await ctx.repo.latestModelConfigs(f.leagueId);
      const alpha = cfg.IMPACT ? Number(cfg.IMPACT.params.alpha) : DEFAULT_IMPACT_ALPHA;
      const trusted = Boolean(cfg.IMPACT?.enabled);

      // who is missing
      const lineups = await ctx.repo.lineupsForFixture(f.id);
      const injuries = await ctx.repo.injuriesForFixture(f.id);
      // the league has no injury reports: an empty list means "unknown", not "nobody missing"
      const noInjuryReports = (await ctx.repo.injuriesCovered(f.id)) === false;
      const stats = await ctx.repo.playerStatsForTeams([f.homeTeamId, f.awayTeamId], f.kickoffAt);
      const side = (teamId: number): { loss: TeamLoss; source: 'LINEUP' | 'INJURIES' | 'NONE'; profiled: number } => {
        const profile = buildTeamProfile(stats, teamId, f.kickoffAt);
        if (profile.teamMatches < 3) return { loss: NO_LOSS, source: 'NONE', profiled: profile.teamMatches };
        const lu = lineups.get(`${f.id}:${teamId}`);
        if (lu && lu.starters.size >= 11) return { loss: teamLoss(profile, absencesFromLineup(profile, lu.starters, lu.bench)), source: 'LINEUP', profiled: profile.teamMatches };
        if (noInjuryReports) return { loss: NO_LOSS, source: 'NONE', profiled: profile.teamMatches };
        return { loss: teamLoss(profile, absencesFromInjuries(injuries.filter((i) => i.teamId === teamId))), source: 'INJURIES', profiled: profile.teamMatches };
      };
      const home = side(f.homeTeamId);
      const away = side(f.awayTeamId);

      const key = {
        basedOn: base.computedAt.toISOString(),
        alpha,
        trusted,
        home: { source: home.source, missing: home.loss.missing.map((m) => [m.playerId, m.weight]) },
        away: { source: away.source, missing: away.loss.missing.map((m) => [m.playerId, m.weight]) },
      };
      const prev = (await ctx.repo.latestProbabilities(f.id, IMPACT_VERSION)).find((r) => r.inputs && 'impact' in r.inputs);
      if (prev && stableStringify((prev.inputs!.impact as Record<string, unknown>).key) === stableStringify(key)) continue;

      // re-price exactly the markets/lines the Probability Engine priced
      const g = applyImpact({ lambda: inp.lambda, mu: inp.mu }, home.loss, away.loss, alpha);
      // totals shrink is already inside totalsLambda/totalsMu from the Probability Engine
      const gt0 = { lambda: inp.totalsLambda ?? inp.lambda, mu: inp.totalsMu ?? inp.mu };
      const gt = applyImpact(gt0, home.loss, away.loss, alpha);
      const sidesM = scoreMatrix(g.lambda, g.mu, inp.rho);
      const totalsM = scoreMatrix(gt.lambda, gt.mu, inp.rho);

      const ensW = cfg.ENSEMBLE ? Number(cfg.ENSEMBLE.params.weightDixonColes) : 1;
      const elo = dcRows.filter((r) => r.modelVersionId === ELO_VERSION);
      const eloP = (s: string) => elo.find((r) => r.selection === s)?.probability;

      const names = await ctx.repo.playerNames([...home.loss.missing, ...away.loss.missing].map((m) => m.playerId));
      const named = (l: TeamLoss) => ({
        attackLoss: l.attackLoss,
        defenceLoss: l.defenceLoss,
        missing: l.missing.slice(0, 8).map((m) => ({ ...m, name: names.get(m.playerId) ?? null })),
      });
      const impact = {
        key,
        alpha,
        enabled: trusted,
        configId: cfg.IMPACT?.id ?? null,
        home: { source: home.source, profiledMatches: home.profiled, ...named(home.loss) },
        away: { source: away.source, profiledMatches: away.profiled, ...named(away.loss) },
        lambda: r4(g.lambda),
        mu: r4(g.mu),
        baseLambda: inp.lambda,
        baseMu: inp.mu,
      };

      const computedAt = now.toISOString();
      const rows: Row[] = dcRows
        .filter((r) => r.modelVersionId === DIXON_COLES_VERSION)
        .map((r, i) => {
          const sel = { market: r.market, selection: r.selection, ...(r.line === null ? {} : { line: r.line }) } as MarketSelection;
          const priced = priceSelection(r.market === 'OVER_UNDER' ? totalsM : sidesM, sel);
          let p = priced.probability;
          let distribution = priced.distribution;
          if (r.market === 'MATCH_WINNER' && ensW < 1 && eloP(r.selection) !== undefined) {
            p = ensW * p + (1 - ensW) * eloP(r.selection)!;
            // keep EV consistent with the blended probability (1X2 has no push / half results)
            distribution = { win: p, halfWin: 0, push: 0, halfLoss: 0, loss: 1 - p };
          }
          return {
            fixture_id: f.id,
            model_version_id: IMPACT_VERSION,
            computed_at: computedAt,
            market: r.market,
            selection: r.selection,
            line: r.line,
            probability: Math.round(p * 1e5) / 1e5,
            inputs:
              i === 0
                ? { impact, teamData: { home: (base.inputs as Record<string, unknown>).home, away: (base.inputs as Record<string, unknown>).away }, distribution }
                : { distribution },
          };
        });
      written += await ctx.repo.insertProbabilityPredictions(rows);

      const homeWin = (m: number[][]) => priceSelection(m, { market: 'MATCH_WINNER', selection: 'HOME' }).probability;
      const baseHome = dcRows.find((r) => r.modelVersionId === DIXON_COLES_VERSION && r.market === 'MATCH_WINNER' && r.selection === 'HOME')?.probability;
      report.push({
        fixture: f.id,
        source: `${home.source}/${away.source}`,
        'home att/def loss': `${home.loss.attackLoss}/${home.loss.defenceLoss}`,
        'away att/def loss': `${away.loss.attackLoss}/${away.loss.defenceLoss}`,
        'home win base→adj': baseHome === undefined ? '-' : `${(baseHome * 100).toFixed(1)}→${(homeWin(sidesM) * 100).toFixed(1)}%`,
        alpha,
        trusted: trusted ? 'yes' : 'no',
      });
    }
    if (report.length) console.table(report);
    return written;
  });
}
