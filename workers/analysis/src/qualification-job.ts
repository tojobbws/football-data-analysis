/**
 * Qualification probability of two-legged cup ties (slice 04): the chance each side goes through,
 * from the scoreline matrices of the legs still to play, the aggregate so far and the competition's rules.
 *
 * Runs hourly after `model:probabilities`. For every tie whose next leg kicks off within the window it needs
 * the stored (live) scoreline matrix of every leg not yet played; a tie missing one is skipped, never guessed
 * (the second leg's matrix only exists in the last days before it is played). One forecast is kept per run,
 * appended to qualification_snapshots with its time; nothing is rewritten.
 */
import {
  buildTies,
  DIXON_COLES_VERSION,
  qualificationProbability,
  type CompetitionRule,
  type LegInput,
  type Stage,
  type Tie,
  type TieFixture,
} from '@fp/analysis';
import { runJob, type JobContext } from '@fp/database';

export const QUALIFICATION_VERSION = 'qualification-v0.1';

export interface QualificationOptions {
  now?: Date;
  /** forecast ties whose next leg kicks off within this many days (default 7) */
  days?: number;
  /** do not forecast the same leg again within this many hours (default 6) */
  minGapHours?: number;
}

const round5 = (x: number) => Math.round(x * 1e5) / 1e5;

export function qualificationJob(ctx: JobContext, opts: QualificationOptions = {}) {
  return runJob(ctx, 'qualification', { days: opts.days ?? 7 }, async () => {
    const now = opts.now ?? new Date();
    const horizon = new Date(now.getTime() + (opts.days ?? 7) * 86_400_000);
    const minGapMs = (opts.minGapHours ?? 6) * 3_600_000;

    const rules: CompetitionRule[] = (await ctx.repo.competitionRuleRows()).map((r) => ({
      leagueId: Number(r.league_id),
      fromSeason: Number(r.from_season),
      stage: r.stage as Stage,
      legs: Number(r.legs),
      awayGoals: r.away_goals,
      extraTime: r.extra_time,
      penalties: r.penalties,
      neutralVenue: r.neutral_venue,
    }));
    const leagueIds = [...new Set(rules.map((r) => r.leagueId))];
    if (!leagueIds.length) return 0;

    // both legs of a tie fall within a few weeks of each other
    const rows = await ctx.repo.cupFixtureRows(leagueIds, new Date(now.getTime() - 60 * 86_400_000), new Date(now.getTime() + 30 * 86_400_000));
    const fixtures: TieFixture[] = rows.map((r) => {
      const finished = ['FT', 'AET', 'PEN'].includes(r.status_short);
      const pair = (a: number | null, b: number | null): [number, number] | null => (a == null || b == null ? null : [Number(a), Number(b)]);
      return {
        id: Number(r.id),
        leagueId: Number(r.league_id),
        season: Number(r.season),
        round: r.round,
        kickoffAt: new Date(r.kickoff_at),
        homeId: Number(r.home_team_id),
        awayId: Number(r.away_team_id),
        status: r.status_short,
        ft: finished ? pair(r.ft_home, r.ft_away) : null,
        et: finished ? pair(r.et_home, r.et_away) : null,
        pen: finished ? pair(r.pen_home, r.pen_away) : null,
      };
    });

    let written = 0;
    const skipped: Record<string, number> = {};
    for (const tie of buildTies(fixtures, rules)) {
      if (tie.status !== 'FIRST_LEG_NEXT' && tie.status !== 'SECOND_LEG_NEXT') continue;
      const next = tie.legs.find((l) => l.status === 'NS' && l.kickoffAt > now);
      if (!next || next.kickoffAt > horizon) continue;
      const last = await ctx.repo.lastQualificationAt(next.id);
      if (last && now.getTime() - last.getTime() < minGapMs) continue;

      const result = qualificationProbability({
        teamA: tie.teamA,
        teamB: tie.teamB,
        rule: tie.rule,
        legs: [await legInput(ctx, tie, 0, now), await legInput(ctx, tie, 1, now)],
      });
      if (!result.available) {
        skipped[result.reason] = (skipped[result.reason] ?? 0) + 1;
        continue;
      }
      await ctx.repo.insertQualificationSnapshot({
        fixture_id: next.id,
        model_version_id: QUALIFICATION_VERSION,
        computed_at: now.toISOString(),
        source: 'live',
        tie_key: tie.key,
        stage: tie.stage,
        leg: tie.legs.indexOf(next) + 1,
        team_a_id: tie.teamA,
        team_b_id: tie.teamB,
        agg_a: tie.aggregate.a,
        agg_b: tie.aggregate.b,
        p_a: round5(result.pA),
        p_b: round5(result.pB),
        p_extra_time: round5(result.pExtraTime),
        p_penalties: round5(result.pPenalties),
        assumptions: JSON.stringify(result.assumptions),
      });
      written++;
    }
    if (Object.keys(skipped).length) ctx.log.info('qualification skipped', skipped);
    return written;
  });
}

/** A leg as the forecast sees it: its score when finished, else the last live scoreline matrix before kickoff (null when there is none). */
async function legInput(ctx: JobContext, tie: Tie, index: 0 | 1, now: Date): Promise<LegInput> {
  const leg = tie.legs[index];
  if (!leg) return { homeId: tie.teamB, awayId: tie.teamA, played: null, matrix: null }; // second leg not scheduled: nothing to price from
  if (leg.ft && ['FT', 'AET', 'PEN'].includes(leg.status)) return { homeId: leg.homeId, awayId: leg.awayId, played: leg.ft, matrix: null };
  const before = leg.kickoffAt > now ? leg.kickoffAt : now;
  return { homeId: leg.homeId, awayId: leg.awayId, played: null, matrix: await ctx.repo.latestSidesMatrix(leg.id, before, DIXON_COLES_VERSION) };
}
