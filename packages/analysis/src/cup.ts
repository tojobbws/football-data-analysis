/**
 * Two-legged cup ties and the chance of going through (qualification probability).
 *
 * Not the 90-minute win chance: a tie is decided on the two legs together, then extra time, then penalties,
 * under the rules of that competition and season (competition_rules). The 90-minute scores are what the
 * aggregate uses; extra-time goals and the shoot-out only matter when the aggregate is level after the second leg.
 *
 * What is an assumption and says so on the page: extra time is priced as 30 of 90 minutes of the second leg's
 * scoring rates (independent Poisson goals), and a shoot-out is 50/50. Away goals are not modelled (UEFA dropped
 * the rule from 2021-22, and every season in the data is later); a rule that asks for them gives no probability.
 */
import { parseRound, type Stage } from './rounds.js';

export interface CompetitionRule {
  leagueId: number;
  /** first season (start year) the rule applies from; the latest row not after the match's season wins */
  fromSeason: number;
  stage: Stage;
  /** 1 = single match (league phase, final), 2 = two-legged tie */
  legs: number;
  awayGoals: boolean;
  extraTime: boolean;
  penalties: boolean;
  neutralVenue: boolean;
}

export function ruleFor(rules: readonly CompetitionRule[], leagueId: number, season: number, stage: Stage): CompetitionRule | null {
  const hits = rules.filter((r) => r.leagueId === leagueId && r.stage === stage && r.fromSeason <= season);
  return hits.sort((a, b) => b.fromSeason - a.fromSeason)[0] ?? null;
}

export interface TieFixture {
  id: number;
  leagueId: number;
  season: number;
  round: string | null;
  kickoffAt: Date;
  homeId: number;
  awayId: number;
  /** API-Football short status (NS, FT, AET, PEN, PST ...) */
  status: string;
  /** 90-minute goals; null until the match has finished */
  ft: [number, number] | null;
  /** goals scored in extra time only */
  et: [number, number] | null;
  /** shoot-out goals */
  pen: [number, number] | null;
}

const FINISHED = new Set(['FT', 'AET', 'PEN']);
const PRE_MATCH = new Set(['NS', 'TBD']);

export type TieStatus = 'FIRST_LEG_NEXT' | 'SECOND_LEG_NEXT' | 'COMPLETE' | 'SECOND_LEG_NOT_SCHEDULED' | 'IN_PROGRESS';

export interface Tie {
  key: string;
  leagueId: number;
  season: number;
  stage: Stage;
  rule: CompetitionRule;
  /** "team A" = the home side of the first leg; ids are the two teams */
  teamA: number;
  teamB: number;
  legs: TieFixture[];
  /** 90-minute aggregate of the legs finished so far, by team */
  aggregate: { a: number; b: number };
  status: TieStatus;
}

const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

/** Group fixtures into two-legged ties by competition, season, stage and the pair of teams. Single-match stages are not ties. */
export function buildTies(fixtures: readonly TieFixture[], rules: readonly CompetitionRule[]): Tie[] {
  const groups = new Map<string, { stage: Stage; rule: CompetitionRule; legs: TieFixture[] }>();
  for (const f of fixtures) {
    const { stage } = parseRound(f.round);
    const rule = ruleFor(rules, f.leagueId, f.season, stage);
    if (!rule || rule.legs < 2) continue;
    const key = `${f.leagueId}:${f.season}:${stage}:${pairKey(f.homeId, f.awayId)}`;
    const g = groups.get(key) ?? { stage, rule, legs: [] };
    g.legs.push(f);
    groups.set(key, g);
  }
  const ties: Tie[] = [];
  for (const [key, g] of groups) {
    const legs = [...g.legs].sort((a, b) => a.kickoffAt.getTime() - b.kickoffAt.getTime()).slice(0, g.rule.legs);
    const first = legs[0]!;
    const teamA = first.homeId;
    const teamB = first.awayId;
    const agg = { a: 0, b: 0 };
    for (const l of legs) {
      if (!FINISHED.has(l.status) || !l.ft) continue;
      const aHome = l.homeId === teamA;
      agg.a += aHome ? l.ft[0] : l.ft[1];
      agg.b += aHome ? l.ft[1] : l.ft[0];
    }
    const done = legs.filter((l) => FINISHED.has(l.status) && l.ft);
    let status: TieStatus;
    if (legs.length < g.rule.legs) status = done.length ? 'SECOND_LEG_NOT_SCHEDULED' : 'FIRST_LEG_NEXT';
    else if (done.length === legs.length) status = 'COMPLETE';
    else if (legs.some((l) => !FINISHED.has(l.status) && !PRE_MATCH.has(l.status) && l.status !== 'PST')) status = 'IN_PROGRESS';
    else status = done.length === 0 ? 'FIRST_LEG_NEXT' : 'SECOND_LEG_NEXT';
    ties.push({ key, leagueId: first.leagueId, season: first.season, stage: g.stage, rule: g.rule, teamA, teamB, legs, aggregate: agg, status });
  }
  return ties.sort((a, b) => a.legs[0]!.kickoffAt.getTime() - b.legs[0]!.kickoffAt.getTime());
}

export interface TieResult {
  winner: number | null;
  decidedBy: 'AGGREGATE' | 'EXTRA_TIME' | 'PENALTIES' | 'UNDECIDED';
}

/** Who went through a finished tie, from the played data: aggregate, then extra time (second leg), then penalties. */
export function resolveTie(tie: Tie): TieResult {
  if (tie.status !== 'COMPLETE') return { winner: null, decidedBy: 'UNDECIDED' };
  if (tie.aggregate.a !== tie.aggregate.b) return { winner: tie.aggregate.a > tie.aggregate.b ? tie.teamA : tie.teamB, decidedBy: 'AGGREGATE' };
  const last = tie.legs[tie.legs.length - 1]!;
  const aHome = last.homeId === tie.teamA;
  if (tie.rule.extraTime && last.et) {
    const a = aHome ? last.et[0] : last.et[1];
    const b = aHome ? last.et[1] : last.et[0];
    if (a !== b) return { winner: a > b ? tie.teamA : tie.teamB, decidedBy: 'EXTRA_TIME' };
  }
  if (tie.rule.penalties && last.pen) {
    const a = aHome ? last.pen[0] : last.pen[1];
    const b = aHome ? last.pen[1] : last.pen[0];
    if (a !== b) return { winner: a > b ? tie.teamA : tie.teamB, decidedBy: 'PENALTIES' };
  }
  return { winner: null, decidedBy: 'UNDECIDED' };
}

// ---------------------------------------------------------------------------
// Qualification probability
// ---------------------------------------------------------------------------

/** P(home goals - away goals = d) from a scoreline matrix [home][away]. */
export function goalDiffPmf(matrix: readonly (readonly number[])[]): Map<number, number> {
  const out = new Map<number, number>();
  matrix.forEach((row, h) =>
    row.forEach((p, a) => {
      if (p > 0) out.set(h - a, (out.get(h - a) ?? 0) + p);
    }),
  );
  return out;
}

const convolve = (x: Map<number, number>, y: Map<number, number>): Map<number, number> => {
  const out = new Map<number, number>();
  for (const [dx, px] of x) for (const [dy, py] of y) out.set(dx + dy, (out.get(dx + dy) ?? 0) + px * py);
  return out;
};

const negate = (m: Map<number, number>): Map<number, number> => new Map([...m].map(([d, p]) => [-d, p]));

function poisson(rate: number, max: number): number[] {
  const out = [Math.exp(-rate)];
  for (let k = 1; k <= max; k++) out.push((out[k - 1]! * rate) / k);
  return out;
}

/** Goal difference (home - away) of independent Poisson goals, truncated at `max` each. */
export function poissonDiffPmf(lambdaHome: number, lambdaAway: number, max = 10): Map<number, number> {
  const ph = poisson(lambdaHome, max);
  const pa = poisson(lambdaAway, max);
  const out = new Map<number, number>();
  ph.forEach((x, h) => pa.forEach((y, a) => out.set(h - a, (out.get(h - a) ?? 0) + x * y)));
  const total = [...out.values()].reduce((s, p) => s + p, 0);
  return new Map([...out].map(([d, p]) => [d, p / total]));
}

export function matrixMeans(matrix: readonly (readonly number[])[]): { home: number; away: number } {
  let home = 0;
  let away = 0;
  matrix.forEach((row, h) =>
    row.forEach((p, a) => {
      home += h * p;
      away += a * p;
    }),
  );
  return { home, away };
}

/** One leg as the forecast sees it: played (score known) or still to play (scoreline matrix of that leg, home first). */
export interface LegInput {
  homeId: number;
  awayId: number;
  /** 90-minute score when played */
  played: [number, number] | null;
  /** scoreline matrix [home goals][away goals] when not yet played */
  matrix: readonly (readonly number[])[] | null;
}

export interface QualificationInput {
  teamA: number;
  teamB: number;
  legs: [LegInput, LegInput];
  rule: Pick<CompetitionRule, 'awayGoals' | 'extraTime' | 'penalties'>;
  /** share of 90 minutes that extra time is priced at (30/90) */
  extraTimeShare?: number;
}

export type QualificationResult =
  | {
      available: true;
      /** chance team A / team B goes through; they sum to 1 */
      pA: number;
      pB: number;
      /** chance the aggregate is level after the second leg (extra time follows) */
      pExtraTime: number;
      /** chance the tie reaches a shoot-out */
      pPenalties: number;
      assumptions: string[];
    }
  | { available: false; reason: 'AWAY_GOALS_NOT_MODELLED' | 'NO_TIEBREAK_RULE' | 'MATRIX_MISSING' | 'TIE_FINISHED' | 'LEG_TEAMS_MISMATCH' };

export function qualificationProbability(input: QualificationInput): QualificationResult {
  const { teamA, teamB, legs, rule } = input;
  if (rule.awayGoals) return { available: false, reason: 'AWAY_GOALS_NOT_MODELLED' };
  if (!rule.extraTime && !rule.penalties) return { available: false, reason: 'NO_TIEBREAK_RULE' };
  const ok = (l: LegInput) => (l.homeId === teamA && l.awayId === teamB) || (l.homeId === teamB && l.awayId === teamA);
  if (!legs.every(ok) || legs[0].homeId === legs[1].homeId) return { available: false, reason: 'LEG_TEAMS_MISMATCH' };
  if (legs.every((l) => l.played)) return { available: false, reason: 'TIE_FINISHED' };

  // goal difference seen from team A, per leg
  let diff = new Map<number, number>([[0, 1]]);
  for (const l of legs) {
    const aHome = l.homeId === teamA;
    let leg: Map<number, number>;
    if (l.played) leg = new Map([[aHome ? l.played[0] - l.played[1] : l.played[1] - l.played[0], 1]]);
    else if (l.matrix) leg = aHome ? goalDiffPmf(l.matrix) : negate(goalDiffPmf(l.matrix));
    else return { available: false, reason: 'MATRIX_MISSING' };
    diff = convolve(diff, leg);
  }
  let pA = 0;
  let pB = 0;
  let level = 0;
  for (const [d, p] of diff) {
    if (d > 0) pA += p;
    else if (d < 0) pB += p;
    else level += p;
  }

  const assumptions: string[] = [];
  let pExtraTime = 0;
  let pPenalties = 0;
  if (level > 1e-12) {
    pExtraTime = rule.extraTime ? level : 0;
    let stillLevel = level;
    if (rule.extraTime) {
      // extra time is part of the second leg: its scoring rates come from that leg's matrix
      const second = legs[1];
      const m = second.matrix;
      if (!m) return { available: false, reason: 'MATRIX_MISSING' };
      const mean = matrixMeans(m);
      const share = input.extraTimeShare ?? 30 / 90;
      const aHome = second.homeId === teamA;
      const et = poissonDiffPmf(mean.home * share, mean.away * share);
      let etA = 0;
      let etB = 0;
      let etLevel = 0;
      for (const [d, p] of et) {
        const dA = aHome ? d : -d;
        if (dA > 0) etA += p;
        else if (dA < 0) etB += p;
        else etLevel += p;
      }
      pA += level * etA;
      pB += level * etB;
      stillLevel = level * etLevel;
      assumptions.push('ต่อเวลาพิเศษประเมินจากอัตราทำประตูของนัดที่สอง คิดเป็น 30 จาก 90 นาที');
    }
    pPenalties = rule.penalties ? stillLevel : 0;
    if (rule.penalties) {
      pA += stillLevel / 2;
      pB += stillLevel / 2;
      assumptions.push('การดวลจุดโทษถือว่าสองทีมมีโอกาสเท่ากัน (50/50)');
    } else if (stillLevel > 1e-12) {
      // no shoot-out rule and still level: nobody is ahead, split evenly rather than invent a winner
      pA += stillLevel / 2;
      pB += stillLevel / 2;
    }
  }
  const total = pA + pB;
  return { available: true, pA: pA / total, pB: pB / total, pExtraTime, pPenalties, assumptions };
}
