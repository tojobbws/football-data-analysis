/**
 * 🔎 วิเคราะห์เกม — a written preview for every upcoming match of the tracked leagues.
 *
 * Not a pick and never counted in 🧭 stats. Per fixture and stage (EARLY within 48h, LINEUP once the
 * XIs are confirmed) the job collects what the system knows (form, xG, standings, injuries, lineups,
 * the model's latest pre-kickoff numbers, market consensus, H2H, which way each source leans), rates
 * the data support and writes the Thai text. The AI only turns the facts into prose; its text is
 * guarded like the shadow ranking (no invented numbers, no foreign scorelines, no gambling words, no
 * disagreement left out). Without an API key, or when the AI answer fails, the deterministic template
 * text is stored instead — so every match has a preview.
 *
 * preview-v1.1 is laid out like a match preview in the Thai football press: a headline (headline_th),
 * a lead (overview_th), the home side (home_th), the away side (away_th), the team news
 * (team_news_th), the analysis with the reasons behind the most likely score (analysis_th) and a few
 * facts read off the data (facts_th). The game summary's confidence level and both-teams-score chance
 * are set here by rules, never by the AI. The v1.0 parts (attack_th, defence_th, opponent_th,
 * score_th, key_factor_th) and h2h_th / summary_th stay null.
 */
import {
  isPersistentApiError,
  createClaudePreviewWriter,
  createOpenAIPreviewWriter,
  PREVIEW_PROMPT_VERSION,
  validatePreviewOutput,
  type PreviewWriter,
} from '@fp/ai';
import {
  assessDataSupport,
  bothTeamsScore,
  buildTemplateText,
  compareViews,
  confidenceLevel,
  DIXON_COLES_VERSION,
  ELO_VERSION,
  formAverages,
  formSummary,
  goalBands,
  matrixExpectedGoals,
  PREVIEW_VERSION,
  previewFocus,
  previewScoreMatrix,
  previewStageFor,
  restDays,
  topScorelines,
  type GoalBands,
  type PreviewFacts,
  type PreviewFormRow,
  type PreviewModel,
  type PreviewTeam,
  type PreviewText,
} from '@fp/analysis';
import { runJob, type JobContext } from '@fp/database';
import { footballDayHorizon, toDateString } from '@fp/shared';
import { ENSEMBLE_VERSION } from './jobs.js';

export interface PreviewJobOptions {
  now?: Date;
  /** fixtures within this many hours get an EARLY preview (default 48) */
  hours?: number;
  writer?: PreviewWriter | null;
  limit?: number;
  /** stop starting new previews after this many minutes: the nearest kickoffs come first, the rest wait for the next run */
  budgetMinutes?: number;
  /** rewrite a stage whose rows all came from an older PREVIEW_VERSION (once per version, still before kickoff only) */
  refresh?: boolean;
  /** only fixtures kicking off before this moment (e.g. the end of today's football day for a refresh of today only) */
  until?: Date;
}

/** attempts per (fixture, stage): the first, plus one retry when the AI attempt was INVALID / REFUSED */
export const MAX_ATTEMPTS_PER_STAGE = 2;

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** OpenAI when OPENAI_API_KEY and OPENAI_MODEL are set, else Claude when ANTHROPIC_API_KEY is, else none (template text). */
function defaultPreviewWriter(ctx: JobContext): PreviewWriter | null {
  const { OPENAI_API_KEY, OPENAI_MODEL, ANTHROPIC_API_KEY } = ctx.env;
  if (OPENAI_API_KEY && OPENAI_MODEL) return createOpenAIPreviewWriter({ apiKey: OPENAI_API_KEY, model: OPENAI_MODEL });
  return ANTHROPIC_API_KEY ? createClaudePreviewWriter({ apiKey: ANTHROPIC_API_KEY }) : null;
}

export function matchPreviewJob(ctx: JobContext, opts: PreviewJobOptions = {}) {
  const leagues = ctx.env.TRACKED_LEAGUES;
  const hours = opts.hours ?? 48;
  return runJob(ctx, 'preview', { leagues, hours, version: PREVIEW_VERSION, refresh: Boolean(opts.refresh), until: opts.until?.toISOString() ?? null }, async () => {
    const now = opts.now ?? new Date();
    let writer = opts.writer === undefined ? defaultPreviewWriter(ctx) : opts.writer;
    if (!writer) ctx.log.warn('no AI key (OPENAI_API_KEY + OPENAI_MODEL, or ANTHROPIC_API_KEY) — previews use the template text');

    const end = footballDayHorizon(now, hours);
    const fixtures = await ctx.repo.fixturesForCandidates(leagues, now.toISOString(), (opts.until && opts.until < end ? opts.until : end).toISOString());
    const report: Array<Record<string, unknown>> = [];
    let written = 0;
    const deadline = opts.budgetMinutes ? Date.now() + opts.budgetMinutes * 60_000 : null;

    for (const f of fixtures.slice(0, opts.limit ?? Infinity)) {
      const lineups = await ctx.repo.lineupsForFixture(f.id);
      const hasLineups = [f.homeTeamId, f.awayTeamId].every((t) => (lineups.get(`${f.id}:${t}`)?.starters.size ?? 0) >= 11);
      const stage = previewStageFor(f.kickoffAt, now, hasLineups, { hoursAhead: hours });
      if (!stage) continue;
      // one preview per stage; a failed AI attempt (guard / refusal) may be retried once — rows are
      // append-only and the site shows the latest, so the first text stays on record
      const prev = await ctx.repo.previewAttempts(f.id, stage, opts.refresh ? PREVIEW_VERSION : undefined);
      if (prev.aiOk || (!writer && prev.attempts > 0) || prev.attempts >= MAX_ATTEMPTS_PER_STAGE) continue;

      if (deadline !== null && Date.now() > deadline) {
        ctx.log.warn('preview time budget used up; the rest wait for the next run', { budgetMinutes: opts.budgetMinutes, written });
        break;
      }
      const { facts, bands, btts } = await collectFacts(ctx, f, stage);
      const support = assessDataSupport(facts);
      const confidence = confidenceLevel(facts, support);
      const template = buildTemplateText(facts, support);
      const input: Record<string, unknown> = { ...facts, data_support: { level: support.level, notes_th: support.notes } };

      let text: PreviewText = template;
      let row: Record<string, unknown> = { text_source: 'TEMPLATE', ai_status: 'SKIPPED', prompt_version: null, model: null, output: null, guard_violations: [], usage: null };
      if (writer) {
        let res;
        try {
          res = await writer.write(input);
        } catch (err) {
          if (isPersistentApiError(err)) {
            // e.g. no credit: stop asking for this run; this match and the rest get the template text now
            // (one attempt used, so a later run with a working API asks the AI once more)
            ctx.log.error('AI preview disabled for this run', { fixtureId: f.id, error: String(err) });
            writer = null;
          } else {
            // transient API problem: no row, so the next run retries (until kickoff)
            ctx.log.warn('AI preview call failed', { fixtureId: f.id, error: String(err) });
            report.push({ match: `${facts.fixture.home} vs ${facts.fixture.away}`, stage, result: 'ERROR', note: String(err).slice(0, 80) });
            continue;
          }
        }
        const base = res ? { prompt_version: PREVIEW_PROMPT_VERSION, model: res.model, output: res.output, usage: res.usage } : null;
        if (!res || !base) {
          // AI turned off above: template row (ai_status SKIPPED)
        } else if (res.refusal) {
          row = { ...base, text_source: 'TEMPLATE', ai_status: 'REFUSED', guard_violations: [`refusal: ${res.refusal.category ?? 'unknown'}`] };
        } else if (res.output === null) {
          row = { ...base, text_source: 'TEMPLATE', ai_status: 'INVALID', guard_violations: [`unparseable output (stop_reason ${res.stopReason})`] };
        } else {
          const v = validatePreviewOutput(res.output, input);
          if (v.ok && v.text) {
            text = v.text;
            row = { ...base, text_source: 'AI', ai_status: 'OK', guard_violations: [] };
          } else {
            row = { ...base, text_source: 'TEMPLATE', ai_status: 'INVALID', guard_violations: v.violations };
          }
        }
      }

      const m = facts.model;
      const best = m?.scorelines[0] ?? null;
      try {
        await ctx.repo.insertMatchPreview({
          fixture_id: f.id,
          stage,
          version: PREVIEW_VERSION,
          ...row,
          data_support: support.level,
          data_notes: support.notes,
          predicted_home: best?.home ?? null,
          predicted_away: best?.away ?? null,
          predicted_p: best ? r4(best.p) : null,
          expected_home: m ? r2(m.expectedGoals.home) : null,
          expected_away: m ? r2(m.expectedGoals.away) : null,
          p_home: m ? r4(m.p.home) : null,
          p_draw: m ? r4(m.p.draw) : null,
          p_away: m ? r4(m.p.away) : null,
          p_goals_0_1: bands ? r4(bands.upTo1) : null,
          p_goals_2: bands ? r4(bands.two) : null,
          p_goals_3plus: bands ? r4(bands.threePlus) : null,
          p_btts: btts == null ? null : r4(btts),
          main_side: facts.focus?.mainSide ?? 'HOME',
          confidence: confidence.level,
          confidence_notes: confidence.notes,
          headline_th: text.headline_th,
          overview_th: text.overview_th,
          home_th: text.home_th,
          away_th: text.away_th,
          team_news_th: text.team_news_th,
          analysis_th: text.analysis_th,
          facts_th: text.facts_th,
          attack_th: null,
          defence_th: null,
          opponent_th: null,
          score_th: null,
          key_factor_th: null,
          h2h_th: null,
          summary_th: null,
          facts: input,
        });
        written++;
        report.push({
          match: `${facts.fixture.home} vs ${facts.fixture.away}`,
          stage,
          result: `${row.text_source}/${row.ai_status}`,
          support: support.level,
          score: best ? `${best.home}-${best.away}` : '-',
          note: (row.guard_violations as string[])[0] ?? support.notes[0] ?? '',
        });
      } catch (err) {
        // e.g. kickoff passed while waiting for the API: the DB refuses late rows by design
        ctx.log.warn('preview not stored', { fixtureId: f.id, error: String(err) });
      }
    }
    if (report.length) console.table(report);
    return written;
  });
}

type Fixture = Awaited<ReturnType<JobContext['repo']['fixturesForCandidates']>>[number];

/** Everything a preview (and a Game Compass note) is written from; every derived number is computed here. */
export async function collectFacts(ctx: JobContext, f: Fixture, stage: PreviewFacts['fixture']['stage']): Promise<{ facts: PreviewFacts; bands: GoalBands | null; btts: number | null }> {
  const header = (await ctx.repo.fixtureHeader(f.id))!;
  const [formHome, formAway, standings, injuries, lineup, probs, apiPred, h2h, qHome, qDraw, qAway, place, lineupTeams, keyHome, keyAway] = await Promise.all([
    ctx.repo.teamForm(f.homeTeamId, f.kickoffAt),
    ctx.repo.teamForm(f.awayTeamId, f.kickoffAt),
    ctx.repo.standingsForTeams(header.leagueId, header.season, [f.homeTeamId, f.awayTeamId]),
    ctx.repo.injuriesDetailed(f.id),
    ctx.repo.lineupPlayers(f.id),
    ctx.repo.latestProbabilities(f.id, DIXON_COLES_VERSION),
    ctx.repo.latestApiPrediction(f.id),
    ctx.repo.headToHead(f.homeTeamId, f.awayTeamId, f.kickoffAt),
    ctx.repo.selectionMovement(f.id, 'MATCH_WINNER', 'HOME', null),
    ctx.repo.selectionMovement(f.id, 'MATCH_WINNER', 'DRAW', null),
    ctx.repo.selectionMovement(f.id, 'MATCH_WINNER', 'AWAY', null),
    ctx.repo.fixtureVenueReferee(f.id),
    ctx.repo.lineupTeams(f.id),
    ctx.repo.teamKeyPlayers(f.homeTeamId, header.season, f.kickoffAt),
    ctx.repo.teamKeyPlayers(f.awayTeamId, header.season, f.kickoffAt),
  ]);
  const [detailsHome, detailsAway] = await Promise.all([
    ctx.repo.formDetails(f.homeTeamId, formHome.map((x) => x.fixtureId)),
    ctx.repo.formDetails(f.awayTeamId, formAway.map((x) => x.fixtureId)),
  ]);

  const dc = probs.filter((p) => p.modelVersionId === DIXON_COLES_VERSION);
  const inputs = dc.find((p) => p.inputs && 'lambda' in p.inputs)?.inputs as
    | {
        lambda: number;
        mu: number;
        rho: number;
        matchesUsed: number;
        xgShare: number;
        home?: { weightedMatches?: number };
        away?: { weightedMatches?: number };
        gates?: { MATCH_WINNER?: boolean };
        crossLeague?: { lambda: number; mu: number; weightCupOnly: number; cupMatchesUsed: number };
      }
    | undefined;

  let model: PreviewModel | null = null;
  // card only, kept out of the facts the AI sees (see goalBands)
  let bands: GoalBands | null = null;
  let btts: number | null = null;
  if (inputs && dc.length) {
    const ensemble = probs.filter((p) => p.modelVersionId === ENSEMBLE_VERSION && p.market === 'MATCH_WINNER');
    const oneXTwo = ensemble.length === 3 ? ensemble : dc.filter((p) => p.market === 'MATCH_WINNER');
    const p = (sel: string) => oneXTwo.find((x) => x.selection === sel)?.probability ?? 0;
    // goals come from the totals matrix of the same run, the one behind the outlook's over 2.5: from the
    // sides matrix the bands said 3+ = 75% beside the outlook's over 2.5 = 64% (Liverpool–Villarreal, 2026-10-20).
    // Runs before the scoreline snapshots keep the sides matrix.
    const matrix =
      (await ctx.repo.totalsMatrixAt(f.id, DIXON_COLES_VERSION, dc[0]!.computedAt)) ??
      previewScoreMatrix({
        lambda: Number(inputs.lambda),
        mu: Number(inputs.mu),
        rho: Number(inputs.rho),
        crossLeague: inputs.crossLeague ? { lambda: Number(inputs.crossLeague.lambda), mu: Number(inputs.crossLeague.mu), weightCupOnly: Number(inputs.crossLeague.weightCupOnly) } : null,
      });
    const eg = matrixExpectedGoals(matrix);
    bands = goalBands(matrix);
    btts = bothTeamsScore(matrix);
    model = {
      modelVersionId: ensemble.length === 3 ? ENSEMBLE_VERSION : DIXON_COLES_VERSION,
      computedAt: dc[0]!.computedAt.toISOString(),
      p: { home: r4(p('HOME')), draw: r4(p('DRAW')), away: r4(p('AWAY')) },
      expectedGoals: { home: r2(eg.home), away: r2(eg.away) },
      scorelines: topScorelines(matrix, 3).map((s) => ({ ...s, p: r4(s.p) })),
      matchesUsed: Number(inputs.matchesUsed ?? 0),
      xgShare: Number(inputs.xgShare ?? 0),
      crossLeague: inputs.crossLeague ? { cupMatchesUsed: Number(inputs.crossLeague.cupMatchesUsed) } : null,
      // the league's 1X2 model passed model:tune (runs before the gates were stored say nothing)
      ...(inputs.gates ? { tested: Boolean(inputs.gates.MATCH_WINNER) } : {}),
    };
  }

  const team = (
    id: number,
    name: string,
    form: Awaited<ReturnType<JobContext['repo']['teamForm']>>,
    details: Awaited<ReturnType<JobContext['repo']['formDetails']>>,
    keyPlayers: Awaited<ReturnType<JobContext['repo']['teamKeyPlayers']>>,
    weighted: number | undefined,
  ): PreviewTeam => {
    const xi = lineup.filter((p) => Number(p.team_id) === id && p.is_starter);
    const starters = xi.map((p) => String(p.player_name));
    const rows = form.map(
      (x): PreviewFormRow => ({
        venue: x.venue as 'H' | 'A',
        result: x.result as 'W' | 'D' | 'L',
        goalsFor: x.goalsFor,
        goalsAgainst: x.goalsAgainst,
        xgFor: x.xgFor == null ? null : r2(x.xgFor),
        xgAgainst: x.xgAgainst == null ? null : r2(x.xgAgainst),
        opponent: x.opponent,
        date: toDateString(new Date(x.kickoffAt), 'Asia/Bangkok'),
        competition: details.get(x.fixtureId)?.competition ?? null,
      }),
    );
    const key = new Map(keyPlayers.map((p) => [p.playerId, p]));
    const standing = standings.get(id) ?? null;
    const lineupTeam = lineupTeams.get(id);
    const xiIds = new Set(xi.map((p) => Number(p.player_id)));
    return {
      name,
      form: rows,
      formSummary: formSummary(rows),
      // a table the team has not played in yet (a cup's first round) says nothing: rank 30 with 0 played
      standing: standing && (standing.played ?? 0) > 0 ? standing : null,
      injuries: injuries
        .filter((i) => Number(i.team_id) === id)
        .map((i) => {
          const k = i.player_id == null ? undefined : key.get(Number(i.player_id));
          return {
            player: i.player_name == null ? null : String(i.player_name),
            type: i.type == null ? null : String(i.type),
            reason: i.reason == null ? null : String(i.reason),
            isKeyPlayer: Boolean(k),
            ...(k ? { goals: k.goals, assists: k.assists } : {}),
          };
        }),
      starters: starters.length ? starters : null,
      modelMatches: weighted == null ? null : r2(Number(weighted)),
      restDays: restDays(f.kickoffAt, form[0] ? new Date(form[0].kickoffAt) : null),
      averages: formAverages(form.map((x) => details.get(x.fixtureId) ?? { shotsOnTarget: null, possession: null })),
      keyPlayers: keyPlayers.map(({ name, goals, assists, appearances }) => ({ name, goals, assists, appearances })),
      lineup:
        stage === 'LINEUP' && starters.length
          ? {
              formation: lineupTeam?.formation ?? null,
              coach: lineupTeam?.coach ?? null,
              keyPlayersNotStarting: keyPlayers.filter((p) => !xiIds.has(p.playerId)).map((p) => p.name),
            }
          : null,
    };
  };

  const quote = (q: Awaited<ReturnType<JobContext['repo']['selectionMovement']>>) => (q && q.bookmakers >= 2 ? { opening: q.opening, current: q.current, bookmakers: q.bookmakers } : null);
  const market = qHome || qDraw || qAway ? { home: quote(qHome), draw: quote(qDraw), away: quote(qAway) } : null;

  const facts: PreviewFacts = {
    fixture: {
      home: header.home,
      away: header.away,
      league: header.league,
      leagueCountry: header.leagueCountry,
      leagueType: header.leagueType,
      round: header.round,
      kickoffAt: f.kickoffAt.toISOString(),
      stage,
      venue: place.venue,
      referee: place.referee,
    },
    home: team(f.homeTeamId, header.home, formHome, detailsHome, keyHome, inputs?.home?.weightedMatches),
    away: team(f.awayTeamId, header.away, formAway, detailsAway, keyAway, inputs?.away?.weightedMatches),
    model,
    market: market && (market.home || market.draw || market.away) ? market : null,
    apiPrediction: apiPred
      ? {
          homePct: apiPred.percent_home == null ? null : Number(apiPred.percent_home),
          drawPct: apiPred.percent_draw == null ? null : Number(apiPred.percent_draw),
          awayPct: apiPred.percent_away == null ? null : Number(apiPred.percent_away),
          advice: apiPred.advice == null ? null : String(apiPred.advice),
        }
      : null,
    h2h,
  };
  const elo = probs.filter((p) => p.modelVersionId === ELO_VERSION && p.market === 'MATCH_WINNER');
  const eloP = (sel: string) => elo.find((x) => x.selection === sel)?.probability;
  const otherModel = eloP('HOME') != null && eloP('AWAY') != null ? { home: eloP('HOME')!, away: eloP('AWAY')! } : null;
  facts.views = compareViews(facts, otherModel);
  facts.focus = previewFocus(facts, facts.views);
  return { facts, bands, btts };
}
