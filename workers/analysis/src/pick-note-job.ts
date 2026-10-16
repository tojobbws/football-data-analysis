/**
 * The Game Compass note (pick_th): one or two Thai sentences per published pick that say what the
 * view is and where the model sees the match differently from the market, from the same facts as
 * the preview. Runs after `publish`, so every round's pick (EARLY, PREMATCH, LINEUP) gets its own
 * note and the note always matches the pick on the page. Fog gets none.
 *
 * The AI only writes prose; its text is guarded like the preview. Without an AI key, or when the
 * answer fails the guards twice, the template text is stored instead — so every pick has a note.
 */
import {
  createClaudePickNoteWriter,
  createOpenAIPickNoteWriter,
  isPersistentApiError,
  PICK_NOTE_PROMPT_VERSION,
  validatePickNote,
  type PreviewWriter,
} from '@fp/ai';
import { assessDataSupport, PICK_NOTE_VERSION, pickNoteFacts, pickNoteTemplate } from '@fp/analysis';
import { runJob, type JobContext } from '@fp/database';
import { MAX_ATTEMPTS_PER_STAGE, collectFacts } from './preview-job.js';

export interface PickNoteJobOptions {
  now?: Date;
  writer?: PreviewWriter | null;
  limit?: number;
}

/** OpenAI when OPENAI_API_KEY and OPENAI_MODEL are set, else Claude when ANTHROPIC_API_KEY is, else none (template text). */
function defaultWriter(ctx: JobContext): PreviewWriter | null {
  const { OPENAI_API_KEY, OPENAI_MODEL, ANTHROPIC_API_KEY } = ctx.env;
  if (OPENAI_API_KEY && OPENAI_MODEL) return createOpenAIPickNoteWriter({ apiKey: OPENAI_API_KEY, model: OPENAI_MODEL });
  return ANTHROPIC_API_KEY ? createClaudePickNoteWriter({ apiKey: ANTHROPIC_API_KEY }) : null;
}

export function pickNoteJob(ctx: JobContext, opts: PickNoteJobOptions = {}) {
  return runJob(ctx, 'pick-notes', { version: PICK_NOTE_VERSION }, async () => {
    const now = opts.now ?? new Date();
    let writer = opts.writer === undefined ? defaultWriter(ctx) : opts.writer;
    if (!writer) ctx.log.warn('no AI key (OPENAI_API_KEY + OPENAI_MODEL, or ANTHROPIC_API_KEY) — pick notes use the template text');

    const picks = await ctx.repo.picksForNotes(now);
    const report: Array<Record<string, unknown>> = [];
    let written = 0;

    for (const p of picks.slice(0, opts.limit ?? Infinity)) {
      // one note per pick; a failed AI attempt may be retried once (rows are append-only, the site shows the latest)
      if (p.aiOk || (!writer && p.attempts > 0) || p.attempts >= MAX_ATTEMPTS_PER_STAGE) continue;

      const { facts } = await collectFacts(ctx, p.fixture, p.publishRound === 'LINEUP' ? 'LINEUP' : 'EARLY');
      const pick = pickNoteFacts(p, facts.fixture.home, facts.fixture.away);
      if (!pick) continue;
      const support = assessDataSupport(facts);
      const input: Record<string, unknown> = { pick, ...facts, data_support: { level: support.level, notes_th: support.notes } };
      const match = `${facts.fixture.home} vs ${facts.fixture.away} (${p.publishRound})`;

      let note = pickNoteTemplate(pick);
      let row: Record<string, unknown> = { text_source: 'TEMPLATE', ai_status: 'SKIPPED', prompt_version: null, model: null, output: null, guard_violations: [], usage: null };
      if (writer) {
        let res;
        try {
          res = await writer.write(input);
        } catch (err) {
          if (isPersistentApiError(err)) {
            // e.g. no credit: this pick and the rest get the template text now
            ctx.log.error('AI pick notes disabled for this run', { predictionId: p.predictionId, error: String(err) });
            writer = null;
          } else {
            // transient API problem: no row, so the next run retries (until kickoff)
            ctx.log.warn('AI pick note call failed', { predictionId: p.predictionId, error: String(err) });
            report.push({ match, result: 'ERROR', note: String(err).slice(0, 80) });
            continue;
          }
        }
        if (res) {
          const base = { prompt_version: PICK_NOTE_PROMPT_VERSION, model: res.model, output: res.output, usage: res.usage };
          if (res.refusal) {
            row = { ...base, text_source: 'TEMPLATE', ai_status: 'REFUSED', guard_violations: [`refusal: ${res.refusal.category ?? 'unknown'}`] };
          } else if (res.output === null) {
            row = { ...base, text_source: 'TEMPLATE', ai_status: 'INVALID', guard_violations: [`unparseable output (stop_reason ${res.stopReason})`] };
          } else {
            const v = validatePickNote(res.output, input);
            if (v.ok && v.text) {
              note = v.text;
              row = { ...base, text_source: 'AI', ai_status: 'OK', guard_violations: [] };
            } else {
              row = { ...base, text_source: 'TEMPLATE', ai_status: 'INVALID', guard_violations: v.violations };
            }
          }
        }
      }

      try {
        await ctx.repo.insertPickExplanation({
          analysis_prediction_id: p.predictionId,
          fixture_id: p.fixture.id,
          version: PICK_NOTE_VERSION,
          ...row,
          note_th: note,
          facts: input,
        });
        written++;
        report.push({ match, pick: pick.label, result: `${row.text_source}/${row.ai_status}`, note: (row.guard_violations as string[])[0] ?? '' });
      } catch (err) {
        // e.g. kickoff passed while waiting for the API: the DB refuses late rows by design
        ctx.log.warn('pick note not stored', { predictionId: p.predictionId, error: String(err) });
      }
    }
    if (report.length) console.table(report);
    return written;
  });
}
