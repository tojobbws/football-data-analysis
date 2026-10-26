/**
 * Shared by the market research scripts (market-gate-report, calibration-experiment): one row per scored side,
 * the walk-forward model's probability beside the market's, on the market's own line, with its fair target.
 * The model is the untuned Dixon-Coles every league starts from (jobs.ts DEFAULT_DC), refit walk-forward on
 * matches before kickoff only. Read-only.
 */
import {
  brier3,
  expectedGoals,
  fairTarget,
  fitDixonColes,
  outcomeIndex,
  priceSelection,
  scoreMatrix,
  settle,
  sortByTime,
  type DixonColesModel,
  type DixonColesOptions,
  type MarketSelection,
  type Probs3,
} from '@fp/analysis';
import type { Db, Repository } from '@fp/database';
import { footballDay } from '@fp/shared';

export type Phase = 'early' | 'close';
export type Market = 'MATCH_WINNER' | 'ASIAN_HANDICAP' | 'OVER_UNDER';
export const MARKETS: Market[] = ['MATCH_WINNER', 'ASIAN_HANDICAP', 'OVER_UNDER'];
// jobs.ts DEFAULT_DC: what a league runs before it is tuned
export const DC_OPTS: DixonColesOptions = { priorStrength: 8, halfLifeDays: 365, xgWeight: 0.5, redCardDiscount: 0 };

/** A two-sided line, one side (AH: HOME and AWAY; O/U 2.5: OVER and UNDER). `first` = HOME / OVER. */
export interface SideRow {
  leagueId: number;
  phase: Phase;
  market: 'ASIAN_HANDICAP' | 'OVER_UNDER';
  first: boolean;
  cluster: string;
  kickoffAt: Date;
  p: number;
  q: number;
  y: 0 | 1;
  weight: number;
}

/** 1X2 of one match, scored as a three-way Brier. */
export interface OneX2Row {
  leagueId: number;
  phase: Phase;
  cluster: string;
  kickoffAt: Date;
  model: number;
  market: number;
}

interface Side { selection: string; line: number | null; odds: number }

export function noVig(odds: readonly number[]): number[] {
  const inv = odds.map((o) => 1 / o);
  const total = inv.reduce((a, b) => a + b, 0);
  return inv.map((x) => x / total);
}

export async function leaguesWithOdds(db: Db, book: string, wanted: number[] | null) {
  return (
    await db.query<{ id: number; name: string; country: string }>(
      `select l.id, l.name, l.country from leagues l
        where exists (select 1 from external_odds o join fixtures f on f.id = o.fixture_id where f.league_id = l.id and o.bookmaker = $1)
        order by l.id`,
      [book],
    )
  ).rows.filter((l) => !wanted || wanted.includes(l.id));
}

/** Every scored row of one league. O/U is the 2.5 line only (football-data keeps no other). */
export async function marketRows(db: Db, repo: Repository, leagueId: number, opts: { book: string; phases: Phase[]; burnInDays: number; refitDays: number }) {
  const sides: SideRow[] = [];
  const oneX2: OneX2Row[] = [];
  const matches = sortByTime(await repo.finishedMatches(leagueId));
  if (!matches.length) return { sides, oneX2 };
  const from = new Date(matches[0]!.kickoffAt.getTime() + opts.burnInDays * 86_400_000);
  const odds = (
    await db.query<{ fixture_id: string; phase: string; market: Market; selection: string; line: string | null; odds: string }>(
      `select o.fixture_id, o.phase, o.market, o.selection, o.line, o.odds from external_odds o
         join fixtures f on f.id = o.fixture_id
        where f.league_id = $1 and o.bookmaker = $2 and o.phase = any($3::text[])`,
      [leagueId, opts.book, opts.phases],
    )
  ).rows;
  const byKey = new Map<string, Side[]>(); // `${fixture}|${phase}|${market}`
  for (const r of odds) {
    const k = `${r.fixture_id}|${r.phase}|${r.market}`;
    const list = byKey.get(k) ?? [];
    byKey.set(k, list);
    list.push({ selection: r.selection, line: r.line === null ? null : Number(r.line), odds: Number(r.odds) });
  }

  let model: DixonColesModel | null = null;
  let lastFit = -Infinity;
  for (const m of matches) {
    if (m.kickoffAt < from) continue;
    if (!opts.phases.some((ph) => MARKETS.some((mk) => byKey.has(`${m.fixtureId}|${ph}|${mk}`)))) continue;
    const t = m.kickoffAt.getTime();
    if (!model || t - lastFit >= opts.refitDays * 86_400_000) {
      model = fitDixonColes(matches, m.kickoffAt, DC_OPTS, model ?? undefined);
      lastFit = t;
    }
    const g = expectedGoals(model, m.homeTeamId, m.awayTeamId);
    const mx = scoreMatrix(g.lambda, g.mu, model.rho);
    const cluster = footballDay(m.kickoffAt).date;

    for (const phase of opts.phases) {
      const x = byKey.get(`${m.fixtureId}|${phase}|MATCH_WINNER`);
      if (x && x.length === 3 && x.every((s) => s.odds > 1)) {
        const sel = ['HOME', 'DRAW', 'AWAY'] as const;
        const q = noVig(sel.map((s) => x.find((r) => r.selection === s)!.odds)) as unknown as Probs3;
        const p = sel.map((s) => priceSelection(mx, { market: 'MATCH_WINNER', selection: s }).probability) as unknown as Probs3;
        const o = outcomeIndex(m.homeGoals, m.awayGoals);
        oneX2.push({ leagueId, phase, cluster, kickoffAt: m.kickoffAt, model: brier3(p, o), market: brier3(q, o) });
      }
      const pair = (market: 'ASIAN_HANDICAP' | 'OVER_UNDER', first: string, second: string, onlyLine?: number) => {
        const list = byKey.get(`${m.fixtureId}|${phase}|${market}`);
        const a = list?.find((s) => s.selection === first);
        const b = list?.find((s) => s.selection === second);
        if (!a || !b || a.line === null || b.line === null || !(a.odds > 1 && b.odds > 1)) return;
        if (onlyLine !== undefined && a.line !== onlyLine) return;
        const q = noVig([a.odds, b.odds]);
        ([
          { market, selection: first, line: a.line },
          { market, selection: second, line: b.line },
        ] as MarketSelection[]).forEach((sel, k) => {
          const target = fairTarget(settle(sel, m.homeGoals, m.awayGoals));
          if (!target) return;
          sides.push({ leagueId, phase, market, first: k === 0, cluster, kickoffAt: m.kickoffAt, p: priceSelection(mx, sel).probability, q: q[k]!, y: target.y, weight: target.weight });
        });
      };
      pair('ASIAN_HANDICAP', 'HOME', 'AWAY');
      pair('OVER_UNDER', 'OVER', 'UNDER', 2.5);
    }
  }
  return { sides, oneX2 };
}
