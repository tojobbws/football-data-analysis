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
 * Fail-safe: an answer that fails validation is asked again up to HYBRID_MAX_ATTEMPTS times, then stored as
 * INVALID and nothing is published for it; the next hourly run tries again while the round is open.
 */
import { createHash } from 'node:crypto';
import {
  buildHybridInput,
  createClaudeHybridDecider,
  createOpenAIHybridDecider,
  HYBRID_ENGINE_VERSION,
  HYBRID_MAX_ATTEMPTS,
  HYBRID_PROMPT_VERSION,
  isPersistentApiError,
  validateHybridOutput,
  type HybridDecider,
  type HybridSource,
  type RankerResult,
} from '@fp/ai';
import { DEFAULT_RULES, hybridMarket, hybridOptions, type HybridSide } from '@fp/analysis';
import { runJob, type JobContext } from '@fp/database';
import { addHours } from '@fp/shared';
import { injuriesCoverage, withOpponentRanksAsOf } from './hybrid-input-v2.js';
import { decisionFresh, dueRound, type PickEngine } from './publish-job.js';

export interface HybridJobOptions {
  now?: Date;
  engine?: PickEngine;
  /** stop starting new fixtures after this many minutes; the rest wait for the next hourly run (default 12) */
  budgetMinutes?: number;
  /** tests inject a fake; null = no AI available */
  decider?: HybridDecider | null;
}

/** OpenAI when OPENAI_API_KEY and OPENAI_MODEL are set, else Claude when ANTHROPIC_API_KEY is, else none. */
function defaultDecider(ctx: JobContext): HybridDecider | null {
  const { OPENAI_API_KEY, OPENAI_MODEL, ANTHROPIC_API_KEY, HYBRID_AI_MODEL } = ctx.env;
  if (OPENAI_API_KEY && OPENAI_MODEL) return createOpenAIHybridDecider({ apiKey: OPENAI_API_KEY, model: OPENAI_MODEL });
  return ANTHROPIC_API_KEY ? createClaudeHybridDecider({ apiKey: ANTHROPIC_API_KEY, model: HYBRID_AI_MODEL }) : null;
}

export function hybridJob(ctx: JobContext, opts: HybridJobOptions = {}) {
  const engine: PickEngine = opts.engine ?? ctx.env.PICK_ENGINE ?? 'legacy';
  return runJob(ctx, 'hybrid', { engine, engineVersion: HYBRID_ENGINE_VERSION, promptVersion: HYBRID_PROMPT_VERSION }, async () => {
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
    const leagues = ctx.env.TRACKED_LEAGUES;
    const fixtures = await ctx.repo.fixturesForCandidates(leagues, now.toISOString(), addHours(now, 24).toISOString());
    const engineVersion = engine === 'hybrid' ? HYBRID_ENGINE_VERSION : DEFAULT_RULES.version;
    const report: Array<Record<string, unknown>> = [];
    let stored = 0;

    const deadline = Date.now() + (opts.budgetMinutes ?? 12) * 60_000;
    for (const f of fixtures) {
      if (Date.now() > deadline) {
        ctx.log.warn('Hybrid AI time budget used up; the rest wait for the next run', { budgetMinutes: opts.budgetMinutes ?? 12, stored });
        break;
      }
      const due = await dueRound(ctx, f, now, { engineVersion, gateRetune: engine !== 'hybrid' });
      if (!due) continue;
      const { round } = due;
      // a published round is final: nothing left to decide
      if (await ctx.repo.isPublished(f.id, round)) continue;
      const existing = await ctx.repo.latestHybridDecision(f.id, round, HYBRID_ENGINE_VERSION);
      if (existing && !(await decisionFresh(ctx, f.id, round, existing.decidedAt, now))) continue;

      const { header, input, inputHash, options, legacy } = await collectHybridInput(ctx, f, round, now, { inputV2: true });
      const base = { fixture_id: f.id, publish_round: round, engine_mode: engine, engine_version: HYBRID_ENGINE_VERSION, prompt_version: HYBRID_PROMPT_VERSION, input, input_hash: inputHash, legacy };
      const match = `${header.home} vs ${header.away} (${round})`;

      let row: Record<string, unknown>;
      if (!options.length) {
        // nothing to choose from: no main AH or O/U line the market trades now; no AI call
        row = { ...base, model: null, status: 'OK', attempts: 0, side: 'NO_PICK', summary_th: 'ยังไม่มีเส้นหลักของตลาดที่เชื่อถือได้ ณ เวลาที่วิเคราะห์', output: null };
      } else {
        let res: RankerResult | null = null;
        let violations: string[] = [];
        let attempts = 0;
        let result: ReturnType<typeof validateHybridOutput> | null = null;
        let failure: string | null = null;
        let stop = false;
        while (attempts < HYBRID_MAX_ATTEMPTS) {
          attempts++;
          try {
            res = await decider.decide(input);
          } catch (err) {
            failure = String(err).slice(0, 300);
            if (isPersistentApiError(err)) stop = true;
            break;
          }
          if (res.refusal) break;
          if (res.output === null) {
            violations.push(`attempt ${attempts}: unparseable output (stop_reason ${res.stopReason})`);
            continue;
          }
          result = validateHybridOutput(res.output, input, options);
          if (result.ok) break;
          violations.push(...result.violations.map((v) => `attempt ${attempts}: ${v}`));
        }
        if (failure) row = { ...base, model: null, status: 'ERROR', attempts, violations: [failure], output: null };
        else if (res?.refusal) row = { ...base, model: res.model, status: 'REFUSED', attempts, violations: [`refusal: ${res.refusal.category ?? 'unknown'}`], output: null, usage: res.usage };
        else if (result?.ok && result.decision) {
          const o = result.decision.option;
          row = {
            ...base,
            model: res!.model,
            status: 'OK',
            attempts,
            violations,
            output: res!.output,
            usage: res!.usage,
            side: result.decision.side,
            market: o?.market ?? null,
            selection: o?.selection ?? null,
            line: o?.line ?? null,
            odds: o?.odds ?? null,
            market_probability: o?.marketProbability ?? null,
            confidence: result.decision.confidence,
            summary_th: result.decision.summaryTh,
          };
        } else row = { ...base, model: res?.model ?? null, status: 'INVALID', attempts, violations, output: res?.output ?? null, usage: res?.usage ?? null };
        if (stop) {
          await ctx.repo.insertHybridDecision(row).catch(() => undefined);
          ctx.log.error('Hybrid AI stopped for this run', { fixtureId: f.id, error: failure });
          report.push({ match, result: 'ERROR', note: (failure ?? '').slice(0, 80) });
          break;
        }
      }

      try {
        await ctx.repo.insertHybridDecision(row);
        stored++;
        const chosen = options.find((o) => o.side === row.side);
        report.push({ match, result: row.status, decision: row.side ?? '-', line: chosen ? chosen.line : '-', legacy: legacy?.outcome ?? '-', attempts: row.attempts });
      } catch (err) {
        // e.g. kickoff passed while waiting for the API: the DB refuses late rows by design
        ctx.log.warn('hybrid decision not stored', { fixtureId: f.id, error: String(err) });
      }
    }
    if (report.length) console.table(report);
    return stored;
  });
}

type Fixture = Awaited<ReturnType<JobContext['repo']['fixturesForCandidates']>>[number];

/**
 * Everything the Hybrid AI sees for one fixture at `now` (read-only): its recent matches and table, injuries,
 * lineups, the market's main lines from quotes known at `now`, and the legacy model's prices as context;
 * plus the rules' decision of the moment, which is stored beside the AI's for comparison and never shown to it.
 */
export async function collectHybridInput(ctx: JobContext, f: Fixture, round: string, now: Date, opts: { inputV2?: boolean } = {}) {
  const header = (await ctx.repo.fixtureHeader(f.id))!;
  const quotes = await ctx.repo.latestQuotes(f.id, now);
  const market = hybridMarket(quotes, now);
  const options = hybridOptions(market);
  const [recentHome, recentAway, standings, injuries, lineupPlayers, dcRows, legacyRun] = await Promise.all([
    ctx.repo.teamRecentMatches(f.homeTeamId, now, 10),
    ctx.repo.teamRecentMatches(f.awayTeamId, now, 10),
    ctx.repo.standingsForTeams(f.leagueId, header.season, [f.homeTeamId, f.awayTeamId]),
    ctx.repo.injuriesDetailed(f.id),
    ctx.repo.lineupPlayers(f.id),
    ctx.repo.latestProbabilities(f.id, 'dixon-coles-v0.2', now),
    ctx.repo.latestRun(f.id, DEFAULT_RULES.version),
  ]);
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
  const dcOf = (market: string, selection: string, line: number | null) => dcRows.find((p) => p.market === market && p.selection === selection && (line === null ? p.line === null : p.line !== null && Math.abs(p.line - line) < 1e-9))?.probability;
  const legacyOptions: Partial<Record<HybridSide, number>> = {};
  for (const o of options) {
    const p = dcOf(o.market, o.selection, o.line);
    if (p !== undefined) legacyOptions[o.side] = p;
  }
  const [h, d, a] = (['HOME', 'DRAW', 'AWAY'] as const).map((s) => dcOf('MATCH_WINNER', s, null));
  const src: HybridSource = {
    fixture: { id: f.id, home: header.home, away: header.away, league: header.league, kickoffAt: f.kickoffAt },
    predictionAt: now,
    publishRound: round,
    recent: { home: v2 ? v2.recentHome : recentHome, away: v2 ? v2.recentAway : recentAway },
    standings: { home: standing(f.homeTeamId), away: standing(f.awayTeamId) },
    injuries: injuries.map((i) => ({ team: side(i.team_id), player: i.player_name == null ? null : String(i.player_name), type: i.type == null ? null : String(i.type), reason: i.reason == null ? null : String(i.reason) })),
    nextMatch: { home: nextHome, away: nextAway },
    ...(v2 ? { injuriesCoverage: v2.injuriesCoverage, opponentRankBasis: 'as_of_results' as const } : {}),
    lineup: starters('HOME').length >= 11 && starters('AWAY').length >= 11 ? { home: starters('HOME'), away: starters('AWAY') } : null,
    market,
    legacy: dcRows.length ? { options: legacyOptions, x12: h !== undefined && d !== undefined && a !== undefined ? { home: h, draw: d, away: a } : null } : null,
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
