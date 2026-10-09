/**
 * 🔎 วิเคราะห์เกม — a written preview for every upcoming match of the tracked leagues.
 *
 * Not a pick and never counted in 🧭 stats. Per fixture and stage (EARLY within 48h, LINEUP once the
 * XIs are confirmed) the job collects what the system knows (form, xG, standings, injuries, lineups,
 * the model's latest pre-kickoff numbers, market consensus, H2H), rates the data support and writes
 * the Thai text. The AI only turns the facts into prose; its text is guarded like the shadow ranking
 * (no invented numbers, no foreign scorelines, no gambling words). Without an API key, or when the
 * AI answer fails, the deterministic template text is stored instead — so every match has a preview.
 */
import {
  createClaudePreviewWriter,
  PREVIEW_PROMPT_VERSION,
  validatePreviewOutput,
  type PreviewWriter,
} from '@fp/ai';
import {
  assessDataSupport,
  buildTemplateText,
  DIXON_COLES_VERSION,
  formSummary,
  matrixExpectedGoals,
  PREVIEW_VERSION,
  previewScoreMatrix,
  previewStageFor,
  topScorelines,
  type PreviewFacts,
  type PreviewFormRow,
  type PreviewModel,
  type PreviewTeam,
  type PreviewText,
} from '@fp/analysis';
import { runJob, type JobContext } from '@fp/database';
import { addHours } from '@fp/shared';
import { ENSEMBLE_VERSION } from './jobs.js';

export interface PreviewJobOptions {
  now?: Date;
  /** fixtures within this many hours get an EARLY preview (default 48) */
  hours?: number;
  writer?: PreviewWriter | null;
  limit?: number;
  /** rewrite a stage whose rows all came from an older PREVIEW_VERSION (once per version, still before kickoff only) */
  refresh?: boolean;
}

/** attempts per (fixture, stage): the first, plus one retry when the AI attempt was INVALID / REFUSED */
export const MAX_ATTEMPTS_PER_STAGE = 2;

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const r2 = (x: number) => Math.round(x * 100) / 100;

export function matchPreviewJob(ctx: JobContext, opts: PreviewJobOptions = {}) {
  const leagues = ctx.env.TRACKED_LEAGUES;
  const hours = opts.hours ?? 48;
  return runJob(ctx, 'preview', { leagues, hours, version: PREVIEW_VERSION, refresh: Boolean(opts.refresh) }, async () => {
    const now = opts.now ?? new Date();
    const writer = opts.writer === undefined ? (ctx.env.ANTHROPIC_API_KEY ? createClaudePreviewWriter({ apiKey: ctx.env.ANTHROPIC_API_KEY }) : null) : opts.writer;
    if (!writer) ctx.log.warn('ANTHROPIC_API_KEY not set — previews use the template text');

    const fixtures = await ctx.repo.fixturesForCandidates(leagues, now.toISOString(), addHours(now, hours).toISOString());
    const report: Array<Record<string, unknown>> = [];
    let written = 0;

    for (const f of fixtures.slice(0, opts.limit ?? Infinity)) {
      const lineups = await ctx.repo.lineupsForFixture(f.id);
      const hasLineups = [f.homeTeamId, f.awayTeamId].every((t) => (lineups.get(`${f.id}:${t}`)?.starters.size ?? 0) >= 11);
      const stage = previewStageFor(f.kickoffAt, now, hasLineups, { hoursAhead: hours });
      if (!stage) continue;
      // one preview per stage; a failed AI attempt (guard / refusal) may be retried once — rows are
      // append-only and the site shows the latest, so the first text stays on record
      const prev = await ctx.repo.previewAttempts(f.id, stage, opts.refresh ? PREVIEW_VERSION : undefined);
      if (prev.aiOk || (!writer && prev.attempts > 0) || prev.attempts >= MAX_ATTEMPTS_PER_STAGE) continue;

      const facts = await collectFacts(ctx, f, stage);
      const support = assessDataSupport(facts);
      const template = buildTemplateText(facts, support);
      const input: Record<string, unknown> = { ...facts, data_support: { level: support.level, notes_th: support.notes } };

      let text: PreviewText = template;
      let row: Record<string, unknown> = { text_source: 'TEMPLATE', ai_status: 'SKIPPED', prompt_version: null, model: null, output: null, guard_violations: [], usage: null };
      if (writer) {
        let res;
        try {
          res = await writer.write(input);
        } catch (err) {
          // transient API problem: no row, so the next run retries (until kickoff)
          ctx.log.warn('AI preview call failed', { fixtureId: f.id, error: String(err) });
          report.push({ match: `${facts.fixture.home} vs ${facts.fixture.away}`, stage, result: 'ERROR', note: String(err).slice(0, 80) });
          continue;
        }
        const base = { prompt_version: PREVIEW_PROMPT_VERSION, model: res.model, output: res.output, usage: res.usage };
        if (res.refusal) {
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
          overview_th: text.overview_th,
          home_th: text.home_th,
          away_th: text.away_th,
          score_th: text.score_th,
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

async function collectFacts(ctx: JobContext, f: Fixture, stage: PreviewFacts['fixture']['stage']): Promise<PreviewFacts> {
  const header = (await ctx.repo.fixtureHeader(f.id))!;
  const [formHome, formAway, standings, injuries, lineup, probs, apiPred, h2h, qHome, qDraw, qAway] = await Promise.all([
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
        crossLeague?: { lambda: number; mu: number; weightCupOnly: number; cupMatchesUsed: number };
      }
    | undefined;

  let model: PreviewModel | null = null;
  if (inputs && dc.length) {
    const ensemble = probs.filter((p) => p.modelVersionId === ENSEMBLE_VERSION && p.market === 'MATCH_WINNER');
    const oneXTwo = ensemble.length === 3 ? ensemble : dc.filter((p) => p.market === 'MATCH_WINNER');
    const p = (sel: string) => oneXTwo.find((x) => x.selection === sel)?.probability ?? 0;
    const matrix = previewScoreMatrix({
      lambda: Number(inputs.lambda),
      mu: Number(inputs.mu),
      rho: Number(inputs.rho),
      crossLeague: inputs.crossLeague ? { lambda: Number(inputs.crossLeague.lambda), mu: Number(inputs.crossLeague.mu), weightCupOnly: Number(inputs.crossLeague.weightCupOnly) } : null,
    });
    const eg = matrixExpectedGoals(matrix);
    model = {
      modelVersionId: ensemble.length === 3 ? ENSEMBLE_VERSION : DIXON_COLES_VERSION,
      computedAt: dc[0]!.computedAt.toISOString(),
      p: { home: r4(p('HOME')), draw: r4(p('DRAW')), away: r4(p('AWAY')) },
      expectedGoals: { home: r2(eg.home), away: r2(eg.away) },
      scorelines: topScorelines(matrix, 3).map((s) => ({ ...s, p: r4(s.p) })),
      matchesUsed: Number(inputs.matchesUsed ?? 0),
      xgShare: Number(inputs.xgShare ?? 0),
      crossLeague: inputs.crossLeague ? { cupMatchesUsed: Number(inputs.crossLeague.cupMatchesUsed) } : null,
    };
  }

  const team = (id: number, name: string, form: Awaited<ReturnType<JobContext['repo']['teamForm']>>, weighted: number | undefined): PreviewTeam => {
    const starters = lineup.filter((p) => Number(p.team_id) === id && p.is_starter).map((p) => String(p.player_name));
    const rows = form.map(
      (x): PreviewFormRow => ({
        venue: x.venue as 'H' | 'A',
        result: x.result as 'W' | 'D' | 'L',
        goalsFor: x.goalsFor,
        goalsAgainst: x.goalsAgainst,
        xgFor: x.xgFor == null ? null : r2(x.xgFor),
        xgAgainst: x.xgAgainst == null ? null : r2(x.xgAgainst),
        opponent: x.opponent,
      }),
    );
    return {
      name,
      form: rows,
      formSummary: formSummary(rows),
      standing: standings.get(id) ?? null,
      injuries: injuries.filter((i) => Number(i.team_id) === id).map((i) => ({ player: i.player_name == null ? null : String(i.player_name), type: i.type == null ? null : String(i.type), reason: i.reason == null ? null : String(i.reason) })),
      starters: starters.length ? starters : null,
      modelMatches: weighted == null ? null : r2(Number(weighted)),
    };
  };

  const quote = (q: Awaited<ReturnType<JobContext['repo']['selectionMovement']>>) => (q && q.bookmakers >= 2 ? { opening: q.opening, current: q.current, bookmakers: q.bookmakers } : null);
  const market = qHome || qDraw || qAway ? { home: quote(qHome), draw: quote(qDraw), away: quote(qAway) } : null;

  return {
    fixture: {
      home: header.home,
      away: header.away,
      league: header.league,
      leagueCountry: header.leagueCountry,
      leagueType: header.leagueType,
      round: header.round,
      kickoffAt: f.kickoffAt.toISOString(),
      stage,
    },
    home: team(f.homeTeamId, header.home, formHome, inputs?.home?.weightedMatches),
    away: team(f.awayTeamId, header.away, formAway, inputs?.away?.weightedMatches),
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
}
