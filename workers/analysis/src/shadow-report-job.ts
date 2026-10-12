/**
 * Shadow trial report (ADR 0003): the shadow rules' locked picks beside the real picks of the same
 * period — which side each picks, how they turned out (90-minute result, same settlement rules as
 * the track record), mean CLV, and the verdict against the criteria fixed before the trial.
 * Judged on the LINEUP round; EARLY is shown beside it. Read-only; nothing is published or stored.
 */
import { decideSettlement, SHADOW_TRIAL, trialSide, trialVerdict, type TrialPick } from '@fp/analysis';
import type { JobContext } from '@fp/database';

const sideOf = (market: string, selection: string, line: number | null) =>
  market === 'OVER_UNDER' ? selection : market !== 'ASIAN_HANDICAP' || line === null ? market : line > 0 ? 'AH รอง' : line < 0 ? 'AH ต่อ' : 'AH 0';

const num = (x: unknown) => (x == null ? null : Number(x));

type Pick = TrialPick & { round: string; side: string };

const sides = (picks: readonly Pick[]) => {
  const by = new Map<string, number>();
  for (const p of picks) by.set(p.side, (by.get(p.side) ?? 0) + 1);
  return Object.fromEntries([...by].sort(([a], [b]) => a.localeCompare(b)));
};

export async function shadowReport(ctx: JobContext, opts: { rulesVersion?: string; now?: Date } = {}) {
  const version = opts.rulesVersion ?? SHADOW_TRIAL.rulesVersion;
  const now = opts.now ?? new Date();
  const rows = await ctx.repo.shadowDecisionsToReview(version);

  const shadow: Pick[] = [];
  let noClearSignal = 0;
  for (const r of rows) {
    if (r.outcome !== 'SIGNAL') {
      if (r.publish_round === SHADOW_TRIAL.round) noClearSignal++;
      continue;
    }
    const line = num(r.line);
    const kickoffAt = new Date(r.kickoff_at as string);
    const d = decideSettlement(
      { market: String(r.market), selection: String(r.selection), line, kickoffAt },
      { statusShort: String(r.status_short), kickoffAt, home: num(r.ft_home ?? r.goals_home), away: num(r.ft_away ?? r.goals_away), syncedAt: new Date(r.synced_at as string) },
      now,
    );
    shadow.push({
      round: String(r.publish_round),
      side: sideOf(String(r.market), String(r.selection), line),
      status: d.action === 'SETTLE' ? d.status : d.action === 'VOID' ? 'VOID' : null,
      clv: num(r.clv),
    });
  }

  const since = rows.length ? new Date(Math.min(...rows.map((r) => new Date(r.kickoff_at as string).getTime()))) : now;
  const real: Pick[] = (await ctx.repo.publishedPicksSince(since)).map((p) => ({
    round: p.round,
    side: sideOf(p.market, p.selection, p.line),
    status: p.status === 'PENDING' ? null : (p.status as TrialPick['status']),
    clv: p.clv,
  }));

  const inRound = (ps: Pick[], round: string) => ps.filter((p) => p.round === round);
  const rounds = ['LINEUP', 'EARLY'].map((round) => {
    const s = inRound(shadow, round);
    const r = inRound(real, round);
    return { round, shadow: { ...trialSide(s), sides: sides(s) }, real: { ...trialSide(r), sides: sides(r) } };
  });
  const judged = rounds.find((x) => x.round === SHADOW_TRIAL.round)!;
  return { version, since, noClearSignal, rounds, ...trialVerdict(judged.shadow, judged.real) };
}
