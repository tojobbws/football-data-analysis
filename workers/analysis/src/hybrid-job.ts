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
 *
 * HYBRID_VERSION (docs/adr/0021-hybrid-v21-no-ai-arithmetic.md): v2.1.1 (default) checks the input against the decision
 * time, adds the precomputed totals with their match counts, uses the v2.1.1 prompt and validator (the same number
 * guard plus the match-count rule) and asks a rejected answer again with its located violations, on the same input
 * and within the same attempt limit. v2.0 is the locked baseline, exactly as before: the rollback.
 */
import { createHash } from 'node:crypto';
import {
  buildHybridInput,
  createClaudeHybridDecider,
  createOpenAIHybridDecider,
  createOpenAIHybridDeciderV21,
  HYBRID_ENGINE_VERSION,
  HYBRID_MAX_ATTEMPTS,
  HYBRID_PROMPT_VERSION,
  HYBRID_PROMPT_VERSION_V211,
  HYBRID_SYSTEM_PROMPT_V211,
  HYBRID_VOTES,
  isPersistentApiError,
  locateViolations,
  majorityVote,
  prepareHybridInputV211,
  retryFeedbackV21,
  validateHybridOutput,
  validateHybridOutputV211,
  type HybridDecider,
  type HybridSource,
  type RankerResult,
} from '@fp/ai';
import { DEFAULT_RULES, hybridMarket, hybridOptions, regularStarters, type HybridOption } from '@fp/analysis';
import { runJob, type JobContext } from '@fp/database';
import { competitionKind } from '@fp/shared';
import { injuriesCoverage, withOpponentRanksAsOf } from './hybrid-input-v2.js';
import { collectV20, eloFor, withElo } from './hybrid-input-v20.js';
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
  /** prompt and input version; default env HYBRID_VERSION, unset = v2.1.1 */
  version?: HybridVersion;
}

export type HybridVersion = 'v2.0' | 'v2.1.1';
/** The Hybrid AI version in force: HYBRID_VERSION, unset = v2.1.1 (ADR 0021); v2.0 is the rollback. */
export const hybridVersion = (env: { HYBRID_VERSION?: HybridVersion }): HybridVersion => env.HYBRID_VERSION ?? 'v2.1.1';
/** The prompt_version stored with each decision of that version. */
export const hybridPromptVersion = (v: HybridVersion) => (v === 'v2.0' ? HYBRID_PROMPT_VERSION : HYBRID_PROMPT_VERSION_V211);

/** The OpenAI model of the pick decision: OPENAI_HYBRID_MODEL, else the shared OPENAI_MODEL. */
export const hybridOpenAIModel = (env: { OPENAI_MODEL?: string; OPENAI_HYBRID_MODEL?: string }) => env.OPENAI_HYBRID_MODEL ?? env.OPENAI_MODEL;

/** OpenAI when OPENAI_API_KEY and a model (OPENAI_HYBRID_MODEL or OPENAI_MODEL) are set, else Claude when ANTHROPIC_API_KEY is, else none. */
function defaultDecider(ctx: JobContext, version: HybridVersion): HybridDecider | null {
  const { OPENAI_API_KEY, ANTHROPIC_API_KEY, HYBRID_AI_MODEL } = ctx.env;
  const model = hybridOpenAIModel(ctx.env);
  const v211 = version === 'v2.1.1';
  if (OPENAI_API_KEY && model) return v211 ? createOpenAIHybridDeciderV21({ apiKey: OPENAI_API_KEY, model, system: HYBRID_SYSTEM_PROMPT_V211 }) : createOpenAIHybridDecider({ apiKey: OPENAI_API_KEY, model });
  return ANTHROPIC_API_KEY ? createClaudeHybridDecider({ apiKey: ANTHROPIC_API_KEY, model: HYBRID_AI_MODEL, ...(v211 ? { system: HYBRID_SYSTEM_PROMPT_V211 } : {}) }) : null;
}

export function hybridJob(ctx: JobContext, opts: HybridJobOptions = {}) {
  const engine: PickEngine = opts.engine ?? ctx.env.PICK_ENGINE ?? 'legacy';
  const schedule: PickSchedule = opts.schedule ?? ctx.env.PICK_SCHEDULE ?? 'rounds';
  const version: HybridVersion = opts.version ?? hybridVersion(ctx.env);
  const promptVersion = hybridPromptVersion(version);
  const daily = schedule === 'daily';
  const budgetMinutes = opts.budgetMinutes ?? (daily ? 15 : 12);
  const concurrency = Math.max(1, opts.concurrency ?? (daily ? DAILY_CONCURRENCY : 1));
  return runJob(ctx, 'hybrid', { engine, engineVersion: HYBRID_ENGINE_VERSION, promptVersion, hybridVersion: version, schedule }, async () => {
    if (engine === 'legacy') {
      ctx.log.info('PICK_ENGINE=legacy: the Hybrid AI does not run');
      return 0;
    }
    const decider = opts.decider === undefined ? defaultDecider(ctx, version) : opts.decider;
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
    let persistentError: string | null = null;
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
      const due = await dueRound(ctx, f, now, { engineVersion, gateRetune: engine !== 'hybrid', promptVersion: engine === 'hybrid' ? promptVersion : undefined, schedule });
      if (!due) return;
      const { round } = due;
      // a published round is final: nothing left to decide
      if (await ctx.repo.isPublished(f.id, round)) return;
      const existing = await ctx.repo.latestHybridDecision(f.id, round, HYBRID_ENGINE_VERSION);
      if (existing && !(await decisionFresh(ctx, f.id, round, existing.decidedAt, now))) return;

      const { header, input, inputHash, options, legacy, cutoffWarnings } = await collectHybridInput(ctx, f, round, now, { inputV2: true, v20: true, version });
      const base = { fixture_id: f.id, publish_round: round, engine_mode: engine, engine_version: HYBRID_ENGINE_VERSION, prompt_version: promptVersion, input, input_hash: inputHash, legacy };
      const match = `${header.home} vs ${header.away} (${round})`;
      if (cutoffWarnings.length) {
        // data after the decision time was removed from the input (should never happen: the queries filter by time)
        ctx.log.error('data cutoff warning: values after the decision time were removed from the input', { fixtureId: f.id, cutoffWarnings });
        console.log(`::error title=Hybrid AI data cutoff::${match}: ${cutoffWarnings.join('; ')}`);
      }

      let row: Record<string, unknown>;
      if (!options.length) {
        // nothing to choose from: no main AH or O/U line the market trades now; no AI call
        row = { ...base, model: null, status: 'OK', attempts: 0, side: 'NO_PICK', summary_th: 'ยังไม่มีเส้นหลักของตลาดที่เชื่อถือได้ ณ เวลาที่วิเคราะห์', output: null };
      } else {
        const answers = await Promise.all(Array.from({ length: HYBRID_VOTES }, () => askOnce(decider, input, options, version)));
        row = { ...base, ...combineVotes(answers) };
        const stopOn = answers.find((a) => a.persistent);
        if (stopOn) {
          await ctx.repo.insertHybridDecision(row).catch(() => undefined);
          ctx.log.error('Hybrid AI stopped for this run', { fixtureId: f.id, error: stopOn.failure });
          report.push({ match, result: 'ERROR', note: (stopOn.failure ?? '').slice(0, 80) });
          persistentError = stopOn.failure;
          return 'STOP';
        }
      }
      if (row.status !== 'OK') {
        // a GitHub annotation on the run: the decision is retried in the next run while the round is open
        console.log(`::warning title=Hybrid AI ${row.status}::${match}: ${((row.violations as string[]) ?? []).join(' | ').slice(0, 500)}`);
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
    if (persistentError) {
      // no credit, bad key, unknown model: the run is marked FAILED so the workflow fails and GitHub notifies the owner
      throw new Error(`Hybrid AI stopped by a persistent API error (no retry can fix it): ${persistentError}`);
    }
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
  /** v2.1.1: attempts that were asked again with the previous answer's located violations */
  feedbackRetries?: number;
  /** time spent on this answer's calls (ms) */
  latencyMs?: number;
}

/** One answer's choice as stored in hybrid_decisions.votes */
export interface Vote {
  status: 'OK' | 'INVALID' | 'REFUSED' | 'ERROR';
  side: string | null;
  confidence: string | null;
  attempts: number;
  /** v2.1.1 */
  feedbackRetries?: number;
  latencyMs?: number;
}

/**
 * One answer, asked again (same input, up to HYBRID_MAX_ATTEMPTS) while it fails validation. v2.1.1: the v2.1.1
 * validator (number guard + match counts), and a retry carries the previous answer and its located violations when
 * the decider supports it; the market options and the input never change between attempts.
 */
export async function askOnce(decider: HybridDecider, input: Record<string, unknown>, options: readonly HybridOption[], version: HybridVersion = 'v2.0'): Promise<Answer> {
  const v211 = version === 'v2.1.1';
  // v2.0 votes stay exactly as before; v2.1.1 also records feedback retries and time
  const a: Answer = { res: null, result: null, violations: [], attempts: 0, failure: null, persistent: false, ...(v211 ? { feedbackRetries: 0, latencyMs: 0 } : {}) };
  let previous: unknown = null;
  let feedback: string | null = null;
  while (a.attempts < HYBRID_MAX_ATTEMPTS) {
    a.attempts++;
    const withFeedback = v211 && feedback !== null && previous !== null && typeof decider.retry === 'function';
    const t0 = Date.now();
    try {
      a.res = withFeedback ? await decider.retry!(input, previous, feedback!) : await decider.decide(input);
      if (withFeedback) a.feedbackRetries!++;
    } catch (err) {
      a.failure = String(err).slice(0, 300);
      a.persistent = isPersistentApiError(err);
      break;
    } finally {
      if (v211) a.latencyMs! += Date.now() - t0;
    }
    if (a.res.refusal) break;
    if (a.res.output === null) {
      a.violations.push(`attempt ${a.attempts}: unparseable output (stop_reason ${a.res.stopReason})`);
      feedback = null;
      continue;
    }
    a.result = v211 ? validateHybridOutputV211(a.res.output, input, options) : validateHybridOutput(a.res.output, input, options);
    if (a.result.ok) break;
    a.violations.push(...a.result.violations.map((v) => `attempt ${a.attempts}${withFeedback ? ' (feedback retry)' : ''}: ${v}`));
    if (v211) {
      previous = a.res.output;
      feedback = retryFeedbackV21(locateViolations(a.res.output, input, options, { averageCounts: true }));
    }
  }
  return a;
}

export const statusOf = (a: Answer): Vote['status'] => (a.failure ? 'ERROR' : a.res?.refusal ? 'REFUSED' : a.result?.ok && a.result.decision ? 'OK' : 'INVALID');

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
  const votes: Vote[] = answers.map((a, i) => ({
    status: statusOf(a),
    side: decisions[i]?.side ?? null,
    confidence: decisions[i]?.confidence ?? null,
    attempts: a.attempts,
    ...(a.feedbackRetries !== undefined ? { feedbackRetries: a.feedbackRetries, latencyMs: a.latencyMs } : {}),
  }));
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
export async function collectHybridInput(ctx: JobContext, f: Fixture, round: string, now: Date, opts: { inputV2?: boolean; v20?: boolean; version?: HybridVersion } = {}) {
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
  const rsHome = regularStarters(lineupsHome, target);
  const rsAway = regularStarters(lineupsAway, target);
  // prompt v2.0 (ADR 0020): the owner's added context, and both Elo ratings beside every recent match
  const v20 = opts.v20
    ? await collectV20(ctx, { header, now, market, standings, injuries, regularStarters: { home: rsHome, away: rsAway } })
    : undefined;
  const elo = opts.v20 ? await eloFor(ctx, now) : null;
  const recentH = v2 ? v2.recentHome : recentHome;
  const recentA = v2 ? v2.recentAway : recentAway;
  const src: HybridSource = {
    fixture: { id: f.id, home: header.home, away: header.away, league: header.league, kickoffAt: f.kickoffAt },
    predictionAt: now,
    publishRound: round,
    recent: { home: elo ? withElo(recentH, elo) : recentH, away: elo ? withElo(recentA, elo) : recentA },
    standings: { home: standing(f.homeTeamId), away: standing(f.awayTeamId) },
    ...(v20 ? { v20 } : {}),
    injuries: injuries.map((i) => ({
      team: side(i.team_id),
      player: i.player_name == null ? null : String(i.player_name),
      type: i.type == null ? null : String(i.type),
      reason: i.reason == null ? null : String(i.reason),
      playerId: i.player_id == null ? null : Number(i.player_id),
    })),
    regularStarters: { kind, home: rsHome, away: rsAway },
    nextMatch: { home: nextHome, away: nextAway },
    // prompt v1.5: xG difference, npxG, shooting performance, xPTS and goals prevented beside every recent match and window
    xgMetrics: true,
    ...(v2 ? { injuriesCoverage: v2.injuriesCoverage, opponentRankBasis: 'as_of_results' as const } : {}),
    lineup: starters('HOME').length >= 11 && starters('AWAY').length >= 11 ? { home: starters('HOME'), away: starters('AWAY') } : null,
    market,
  };
  // v2.1.1: the cut-off check against the decision time, then the precomputed totals with their match counts; the
  // hash is of exactly what the AI sees. v2.0 (and the scripts that call this without a version) are unchanged.
  const built = buildHybridInput(src);
  const v211 = opts.version === 'v2.1.1' ? prepareHybridInputV211(built) : null;
  const input = v211 ? v211.input : built;
  const cutoffWarnings = v211 ? v211.cutoffWarnings : [];
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
  return { header, market, options, input, inputHash, legacy, cutoffWarnings };
}
