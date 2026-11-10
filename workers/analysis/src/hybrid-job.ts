/**
 * Hybrid AI decisions (docs/adr/0010-hybrid-ai-picks.md). For each fixture with a publish round due now and not
 * published yet, the AI reads the verified pre-match data and the market's main lines as they stand now, and
 * chooses AH favourite, AH underdog, Over, Under, or NO_PICK. Every answer is stored in `hybrid_decisions`,
 * valid or not, with exactly what the AI saw.
 *
 * Engine mode (env PICK_ENGINE): `legacy` — this job does nothing; `shadow` — decisions are stored only;
 * `hybrid` — the publish job publishes the round's valid decision. The rules (candidates job) run in every mode
 * and their decision of the moment is stored beside each AI decision.
 *
 * Majority of three (prompt v1.6, docs/adr/0013-hybrid-majority-of-three.md): the AI answers HYBRID_VOTES times on the
 * same input, in parallel. The decision is the choice at least HYBRID_MAJORITY valid answers gave (an option or
 * NO_PICK), with the text of the first answer that gave it. All answers valid and no majority: NO_PICK. Every answer's
 * choice is kept in `votes`.
 *
 * Fail-safe: an answer that fails validation is asked again up to HYBRID_MAX_ATTEMPTS times. Too few valid answers to
 * reach or rule out a majority: stored as INVALID / REFUSED / ERROR and nothing is published for it; the next hourly
 * run tries again while the round is open.
 *
 * PICK_SCHEDULE=daily (docs/adr/0014-one-daily-pick-run.md): every match of the pick day is decided in the runs from
 * 14:00 to 16:00 Thai, DAILY_CONCURRENCY matches at a time so a full day (up to ~100 matches) fits in one run.
 */
import { createHash } from 'node:crypto';
import {
  buildHybridInput,
  createClaudeHybridDecider,
  createOpenAIHybridDecider,
  HYBRID_ENGINE_VERSION,
  HYBRID_MAX_ATTEMPTS,
  HYBRID_PROMPT_VERSION,
  HYBRID_VOTES,
  isPersistentApiError,
  majorityVote,
  validateHybridOutput,
  type HybridDecider,
  type HybridSource,
  type RankerResult,
} from '@fp/ai';
import { DEFAULT_RULES, hybridMarket, hybridOptions, regularStarters, type HybridOption } from '@fp/analysis';
import { runJob, type JobContext } from '@fp/database';
import { competitionKind } from '@fp/shared';
import { injuriesCoverage, withOpponentRanksAsOf } from './hybrid-input-v2.js';
import { decisionFresh, dueRound, pickFixtures, type PickEngine, type PickSchedule } from './publish-job.js';

/** Daily pick run: matches decided at the same time (each asks the AI HYBRID_VOTES times in parallel). */
export const DAILY_CONCURRENCY = 6;

export interface HybridJobOptions {
  now?: Date;
  engine?: PickEngine;
  /** stop starting new fixtures after this many minutes; the rest wait for the next hourly run (default 12, daily 15) */
  budgetMinutes?: number;
  /** tests inject a fake; null = no AI available */
  decider?: HybridDecider | null;
  /** only matches of the current football day (06:00→06:00 Thai); false lifts the cap, for tests */
  sameFootballDay?: boolean;
  /** when picks are made; default env PICK_SCHEDULE, unset = rounds */
  schedule?: PickSchedule;
  /** matches decided at the same time (default 1, daily DAILY_CONCURRENCY) */
  concurrency?: number;
}

/** OpenAI when OPENAI_API_KEY and OPENAI_MODEL are set, else Claude when ANTHROPIC_API_KEY is, else none. */
function defaultDecider(ctx: JobContext): HybridDecider | null {
  const { OPENAI_API_KEY, OPENAI_MODEL, ANTHROPIC_API_KEY, HYBRID_AI_MODEL } = ctx.env;
  if (OPENAI_API_KEY && OPENAI_MODEL) return createOpenAIHybridDecider({ apiKey: OPENAI_API_KEY, model: OPENAI_MODEL });
  return ANTHROPIC_API_KEY ? createClaudeHybridDecider({ apiKey: ANTHROPIC_API_KEY, model: HYBRID_AI_MODEL }) : null;
}

export function hybridJob(ctx: JobContext, opts: HybridJobOptions = {}) {
  const engine: PickEngine = opts.engine ?? ctx.env.PICK_ENGINE ?? 'legacy';
  const schedule: PickSchedule = opts.schedule ?? ctx.env.PICK_SCHEDULE ?? 'rounds';
  const daily = schedule === 'daily';
  const budgetMinutes = opts.budgetMinutes ?? (daily ? 15 : 12);
  const concurrency = Math.max(1, opts.concurrency ?? (daily ? DAILY_CONCURRENCY : 1));
  return runJob(ctx, 'hybrid', { engine, engineVersion: HYBRID_ENGINE_VERSION, promptVersion: HYBRID_PROMPT_VERSION, schedule }, async () => {
    if (engine === 'legacy') {
      ctx.log.info('PICK_ENGINE=legacy: the Hybrid AI does not run');
      return 0;
    }
    const decider = opts.decider === undefined ? defaultDecider(ctx) : opts.decider;
    if (!decider) {
      ctx.log.error('no AI key (OPENAI_API_KEY + OPENAI_MODEL, or ANTHROPIC_API_KEY): no Hybrid AI decision this run');
      return 0;
    }
    const now = opts.now ?? new Date();
    const fixtures = await pickFixtures(ctx, now, schedule, opts.sameFootballDay !== false);
    const engineVersion = engine === 'hybrid' ? HYBRID_ENGINE_VERSION : DEFAULT_RULES.version;
    const report: Array<Record<string, unknown>> = [];
    let stored = 0;

    const deadline = Date.now() + budgetMinutes * 60_000;
    const queue = [...fixtures];
    let stop = false;
    // `concurrency` workers take the fixtures in kick-off order; one stops all on a persistent API error or the budget
    const worker = async () => {
      while (!stop) {
        const f = queue.shift();
        if (!f) return;
        if (Date.now() > deadline) {
          if (!stop) ctx.log.warn('Hybrid AI time budget used up; the rest wait for the next run', { budgetMinutes, stored });
          stop = true;
          return;
        }
        if ((await decideOne(f)) === 'STOP') stop = true;
      }
    };
    const decideOne = async (f: Fixture): Promise<'STOP' | void> => {
      const due = await dueRound(ctx, f, now, { engineVersion, gateRetune: engine !== 'hybrid', promptVersion: engine === 'hybrid' ? HYBRID_PROMPT_VERSION : undefined, schedule });
      if (!due) return;
      const { round } = due;
      // a published round is final: nothing left to decide
      if (await ctx.repo.isPublished(f.id, round)) return;
      const existing = await ctx.repo.latestHybridDecision(f.id, round, HYBRID_ENGINE_VERSION);
      if (existing && !(await decisionFresh(ctx, f.id, round, existing.decidedAt, now))) return;

      const { header, input, inputHash, options, legacy } = await collectHybridInput(ctx, f, round, now, { inputV2: true });
      const base = { fixture_id: f.id, publish_round: round, engine_mode: engine, engine_version: HYBRID_ENGINE_VERSION, prompt_version: HYBRID_PROMPT_VERSION, input, input_hash: inputHash, legacy };
      const match = `${header.home} vs ${header.away} (${round})`;

      let row: Record<string, unknown>;
      if (!options.length) {
        // nothing to choose from: no main AH or O/U line the market trades now; no AI call
        row = { ...base, model: null, status: 'OK', attempts: 0, side: 'NO_PICK', summary_th: 'ยังไม่มีเส้นหลักของตลาดที่เชื่อถือได้ ณ เวลาที่วิเคราะห์', output: null };
      } else {
        const answers = await Promise.all(Array.from({ length: HYBRID_VOTES }, () => askOnce(decider, input, options)));
        row = { ...base, ...combineVotes(answers) };
        const stopOn = answers.find((a) => a.persistent);
        if (stopOn) {
          await ctx.repo.insertHybridDecision(row).catch(() => undefined);
          ctx.log.error('Hybrid AI stopped for this run', { fixtureId: f.id, error: stopOn.failure });
          report.push({ match, result: 'ERROR', note: (stopOn.failure ?? '').slice(0, 80) });
          return 'STOP';
        }
      }

      try {
        await ctx.repo.insertHybridDecision(row);
        stored++;
        const chosen = options.find((o) => o.side === row.side);
        const votes = (row.votes as Vote[] | undefined)?.map((v) => v.side ?? v.status).join(',') ?? '-';
        report.push({ match, result: row.status, decision: row.side ?? '-', line: chosen ? chosen.line : '-', votes, legacy: legacy?.outcome ?? '-', attempts: row.attempts });
      } catch (err) {
        // e.g. kickoff passed while waiting for the API: the DB refuses late rows by design
        ctx.log.warn('hybrid decision not stored', { fixtureId: f.id, error: String(err) });
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    if (report.length) console.table(report);
    return stored;
  });
}

type Fixture = Awaited<ReturnType<JobContext['repo']['fixturesForCandidates']>>[number];

/** One answer of the AI on the input: asked again up to HYBRID_MAX_ATTEMPTS times while it is not valid. */
export interface Answer {
  res: RankerResult | null;
  result: ReturnType<typeof validateHybridOutput> | null;
  violations: string[];
  attempts: number;
  /** the API call failed (not an answer) */
  failure: string | null;
  /** the failure would hit the next call too (no credit, bad key): stop the run */
  persistent: boolean;
}

/** One answer's choice as stored in hybrid_decisions.votes */
export interface Vote {
  status: 'OK' | 'INVALID' | 'REFUSED' | 'ERROR';
  side: string | null;
  confidence: string | null;
  attempts: number;
}

async function askOnce(decider: HybridDecider, input: Record<string, unknown>, options: readonly HybridOption[]): Promise<Answer> {
  const a: Answer = { res: null, result: null, violations: [], attempts: 0, failure: null, persistent: false };
  while (a.attempts < HYBRID_MAX_ATTEMPTS) {
    a.attempts++;
    try {
      a.res = await decider.decide(input);
    } catch (err) {
      a.failure = String(err).slice(0, 300);
      a.persistent = isPersistentApiError(err);
      break;
    }
    if (a.res.refusal) break;
    if (a.res.output === null) {
      a.violations.push(`attempt ${a.attempts}: unparseable output (stop_reason ${a.res.stopReason})`);
      continue;
    }
    a.result = validateHybridOutput(a.res.output, input, options);
    if (a.result.ok) break;
    a.violations.push(...a.result.violations.map((v) => `attempt ${a.attempts}: ${v}`));
  }
  return a;
}

const statusOf = (a: Answer): Vote['status'] => (a.failure ? 'ERROR' : a.res?.refusal ? 'REFUSED' : a.result?.ok && a.result.decision ? 'OK' : 'INVALID');

/** token counts summed over every call of every answer (each numeric usage field added up) */
function sumUsage(answers: readonly Answer[]): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const a of answers) for (const [k, v] of Object.entries(a.res?.usage ?? {})) if (typeof v === 'number') out[k] = (out[k] ?? 0) + v;
  return Object.keys(out).length ? out : null;
}

/**
 * The stored decision from the answers: the choice at least HYBRID_MAJORITY valid answers gave, with the first such
 * answer's output and text. Every answer valid and no majority: NO_PICK. Fewer valid answers than that: the decision
 * fails (INVALID, else REFUSED, else ERROR) and the round is tried again on the next run.
 */
export function combineVotes(answers: readonly Answer[]): Record<string, unknown> {
  const decisions = answers.map((a) => (statusOf(a) === 'OK' ? a.result!.decision! : null));
  const votes: Vote[] = answers.map((a, i) => ({ status: statusOf(a), side: decisions[i]?.side ?? null, confidence: decisions[i]?.confidence ?? null, attempts: a.attempts }));
  const violations = answers.flatMap((a, i) => [...a.violations, ...(a.failure ? [a.failure] : []), ...(a.res?.refusal ? [`refusal: ${a.res.refusal.category ?? 'unknown'}`] : [])].map((v) => `answer ${i + 1}: ${v}`));
  const common = { attempts: answers.reduce((s, a) => s + a.attempts, 0), violations, votes, usage: sumUsage(answers) };
  const tally = majorityVote(decisions.map((d) => d?.side ?? null));

  if (tally) {
    const a = answers[tally.first]!;
    const d = decisions[tally.first]!;
    const o = d.option;
    return {
      ...common,
      model: a.res!.model,
      status: 'OK',
      output: a.res!.output,
      side: d.side,
      market: o?.market ?? null,
      selection: o?.selection ?? null,
      line: o?.line ?? null,
      odds: o?.odds ?? null,
      market_probability: o?.marketProbability ?? null,
      confidence: d.confidence,
      summary_th: d.summaryTh,
    };
  }
  const firstValid = answers.find((_, i) => decisions[i]);
  if (decisions.every((d) => d)) {
    // three valid answers, three different choices: the evidence does not point one way
    return { ...common, model: firstValid!.res!.model, status: 'OK', output: null, side: 'NO_PICK', summary_th: 'การวิเคราะห์แต่ละรอบเลือกไม่ตรงกัน จึงยังไม่เลือกตัวเลือกใด' };
  }
  const status = votes.some((v) => v.status === 'INVALID') ? 'INVALID' : votes.some((v) => v.status === 'REFUSED') ? 'REFUSED' : 'ERROR';
  const last = [...answers].reverse().find((a) => a.res);
  return { ...common, model: last?.res?.model ?? null, status, output: last?.res?.output ?? null };
}

/**
 * Everything the Hybrid AI sees for one fixture at `now` (read-only): its recent matches and table, injuries,
 * lineups, each team's starts in its last stored lineups (prompt v1.7) and the market's main lines from quotes known
 * at `now` (since prompt v1.6 no Dixon-Coles prices);
 * plus the rules' decision of the moment, which is stored beside the AI's for comparison and never shown to it.
 */
export async function collectHybridInput(ctx: JobContext, f: Fixture, round: string, now: Date, opts: { inputV2?: boolean } = {}) {
  const header = (await ctx.repo.fixtureHeader(f.id))!;
  const quotes = await ctx.repo.latestQuotes(f.id, now);
  const market = hybridMarket(quotes, now);
  const options = hybridOptions(market);
  const [recentHome, recentAway, standings, injuries, lineupPlayers, legacyRun, lineupsHome, lineupsAway] = await Promise.all([
    ctx.repo.teamRecentMatches(f.homeTeamId, now, 10),
    ctx.repo.teamRecentMatches(f.awayTeamId, now, 10),
    ctx.repo.standingsForTeams(f.leagueId, header.season, [f.homeTeamId, f.awayTeamId]),
    ctx.repo.injuriesDetailed(f.id),
    ctx.repo.lineupPlayers(f.id),
    ctx.repo.latestRun(f.id, DEFAULT_RULES.version),
    ctx.repo.teamRecentLineups(f.homeTeamId, now),
    ctx.repo.teamRecentLineups(f.awayTeamId, now),
  ]);
  // prompt v1.7: who started each team's last stored lineups (a domestic cup also marks its previous round's XI)
  const kind = competitionKind(header.leagueId, header.leagueType, header.leagueCountry);
  const target = { leagueId: header.leagueId, season: header.season, kind };
  // input v2 (off by default): opponent positions as of each match date, and whether the league reports injuries at all
  const v2 = opts.inputV2
    ? {
        recentHome: await withOpponentRanksAsOf(ctx, recentHome),
        recentAway: await withOpponentRanksAsOf(ctx, recentAway),
        injuriesCoverage: await injuriesCoverage(ctx, f.leagueId, now),
      }
    : null;
  // each team's next fixture after this one (a stored schedule, no API call); today's and later matches only, nothing is re-derived for past decisions
  const [nextHome, nextAway] = await Promise.all([ctx.repo.nextFixtureOfTeam(f.homeTeamId, f.kickoffAt), ctx.repo.nextFixtureOfTeam(f.awayTeamId, f.kickoffAt)]);
  const side = (teamId: unknown) => (Number(teamId) === f.homeTeamId ? 'HOME' : Number(teamId) === f.awayTeamId ? 'AWAY' : null);
  const starters = (s: 'HOME' | 'AWAY') => lineupPlayers.filter((p) => side(p.team_id) === s && p.is_starter).map((p) => String(p.player_name));
  const standing = (teamId: number) => {
    const s = standings.get(teamId);
    return s ? { rank: s.rank, tableSize: s.teams ?? null, played: s.played, points: s.points, goalDiff: s.goalDiff } : null;
  };
  const src: HybridSource = {
    fixture: { id: f.id, home: header.home, away: header.away, league: header.league, kickoffAt: f.kickoffAt },
    predictionAt: now,
    publishRound: round,
    recent: { home: v2 ? v2.recentHome : recentHome, away: v2 ? v2.recentAway : recentAway },
    standings: { home: standing(f.homeTeamId), away: standing(f.awayTeamId) },
    injuries: injuries.map((i) => ({
      team: side(i.team_id),
      player: i.player_name == null ? null : String(i.player_name),
      type: i.type == null ? null : String(i.type),
      reason: i.reason == null ? null : String(i.reason),
      playerId: i.player_id == null ? null : Number(i.player_id),
    })),
    regularStarters: { kind, home: regularStarters(lineupsHome, target), away: regularStarters(lineupsAway, target) },
    nextMatch: { home: nextHome, away: nextAway },
    // prompt v1.5: xG difference, npxG, shooting performance, xPTS and goals prevented beside every recent match and window
    xgMetrics: true,
    ...(v2 ? { injuriesCoverage: v2.injuriesCoverage, opponentRankBasis: 'as_of_results' as const } : {}),
    lineup: starters('HOME').length >= 11 && starters('AWAY').length >= 11 ? { home: starters('HOME'), away: starters('AWAY') } : null,
    market,
  };
  const input = buildHybridInput(src);
  const inputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');

  // the rules' decision of this moment, for the comparison (it does not steer the AI's choice)
  let legacy: Record<string, unknown> | null = null;
  if (legacyRun) {
    const pick = legacyRun.outcome === 'SIGNAL' ? (await ctx.repo.runCandidates(legacyRun.id)).find((c) => c.rank === 1) ?? null : null;
    legacy = {
      runId: legacyRun.id,
      rulesVersion: legacyRun.rulesVersion,
      decidedAt: legacyRun.startedAt.toISOString(),
      outcome: legacyRun.outcome,
      pick: pick ? { market: pick.market, selection: pick.selection, line: pick.line, odds: pick.odds, modelProbability: pick.modelProbability, marketProbability: pick.marketProbability } : null,
    };
  }
  return { header, market, options, input, inputHash, legacy };
}
