/**
 * E2E: published picks (PGlite, all migrations) -> pick-notes job (fake writer / no writer) -> web view.
 * The real AI clients are never called here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PICK_NOTE_PROMPT_VERSION, type PreviewWriter, type RankerResult } from '@fp/ai';
import { PICK_NOTE_VERSION } from '@fp/analysis';
import { Repository, type JobContext } from '@fp/database';
import { ApiFootball, ApiFootballClient } from '@fp/football';
import { createLogger, type Env } from '@fp/shared';
import { createTestDb } from '../../../packages/database/test/helpers.js';
import { pickNoteJob } from '../src/pick-note-job.js';

let db: Awaited<ReturnType<typeof createTestDb>>;
let ctx: JobContext;
const NOW = new Date();
const KO = new Date(NOW.getTime() + 6 * 3_600_000);

/** fake AI: answers per pick round + home team, records what it saw */
function fakeWriter(answers: Record<string, Partial<RankerResult> & { output?: unknown }>): PreviewWriter & { calls: number; inputs: Record<string, unknown>[] } {
  const w = {
    calls: 0,
    inputs: [] as Record<string, unknown>[],
    async write(input: Record<string, unknown>): Promise<RankerResult> {
      w.calls++;
      w.inputs.push(input);
      const key = `${(input.fixture as { home: string }).home}/${(input.pick as { round: string }).round}`;
      const a = answers[key];
      if (!a) throw new Error('API down');
      return { output: null, model: 'gpt-test', stopReason: 'completed', refusal: null, usage: { input_tokens: 2000, output_tokens: 80 }, ...a };
    },
  };
  return w;
}

async function publish(fixtureId: number, round: 'EARLY' | 'LINEUP', pick: { selection: string; line: number; model: number; market: number } | null) {
  const run = await db.query<{ id: string }>(`insert into analysis_runs (fixture_id, outcome) values ($1, $2) returning id`, [fixtureId, pick ? 'SIGNAL' : 'NO_CLEAR_SIGNAL']);
  if (!pick) {
    await db.query(`insert into analysis_predictions (fixture_id, publish_round, kind, run_id) values ($1, $2, 'NO_CLEAR_SIGNAL', $3)`, [fixtureId, round, run.rows[0]!.id]);
    return;
  }
  const cand = await db.query<{ id: number }>(
    `insert into analysis_candidates (run_id, fixture_id, market, selection, line, odds, model_probability, market_probability, support_score, rank)
     values ($1, $2, 'ASIAN_HANDICAP', $3, $4, 1.95, $5, $6, 10, 1) returning id`,
    [run.rows[0]!.id, fixtureId, pick.selection, pick.line, pick.model, pick.market],
  );
  await db.query(
    `insert into analysis_predictions (fixture_id, publish_round, kind, market, selection, line, odds_at_publish, model_probability, market_probability, signal_strength, run_id, candidate_id)
     values ($1, $2, 'SIGNAL', 'ASIAN_HANDICAP', $3, $4, 1.95, $5, $6, 'STRONG', $7, $8)`,
    [fixtureId, round, pick.selection, pick.line, pick.model, pick.market, run.rows[0]!.id, cand.rows[0]!.id],
  );
}

beforeAll(async () => {
  db = await createTestDb();
  const repo = new Repository(db);
  const client = new ApiFootballClient({ apiKey: 'test', fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch });
  const env: Env = {
    API_FOOTBALL_KEY: 'test',
    API_FOOTBALL_BASE_URL: 'https://v3.football.api-sports.io',
    API_FOOTBALL_RPM: 1000,
    DATABASE_URL: 'pglite',
    TRACKED_LEAGUES: [39],
    SEASON: 2026,
    ODDS_MARKETS: ['MATCH_WINNER', 'ASIAN_HANDICAP', 'OVER_UNDER'],
    ODDS_BOOKMAKERS: [],
    LOG_LEVEL: 'error',
    ANTHROPIC_API_KEY: undefined,
  };
  ctx = { env, db, repo, client, api: new ApiFootball(client), log: createLogger('error') };

  await db.exec(`
    insert into leagues (id, name, type, country) values (39, 'Premier League', 'League', 'England');
    insert into teams (id, name) values (1, 'Egnatia'), (2, 'Midtjylland'), (3, 'Home B'), (4, 'Away B'), (5, 'Home C'), (6, 'Away C');`);
  await db.query(
    `insert into fixtures (id, league_id, season, round, kickoff_at, home_team_id, away_team_id, status_short, slug) values
      (201, 39, 2026, 'Regular Season - 9', $1, 1, 2, 'NS', 'n201'),
      (202, 39, 2026, 'Regular Season - 9', $1, 3, 4, 'NS', 'n202'),
      (203, 39, 2026, 'Regular Season - 9', $1, 5, 6, 'NS', 'n203')`,
    [KO.toISOString()],
  );
  // 201: a pick (AI explains it) · 202: a pick whose AI note fails the guard · 203: fog (no note)
  await publish(201, 'EARLY', { selection: 'HOME', line: 1.75, model: 0.815, market: 0.671 });
  await publish(202, 'EARLY', { selection: 'AWAY', line: -0.5, model: 0.58, market: 0.5 });
  await publish(203, 'EARLY', null);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('pickNoteJob', () => {
  it('explains each published pick from the facts; template text when the AI fails the guards; nothing for fog', async () => {
    const writer = fakeWriter({
      'Egnatia/EARLY': { output: { pick_th: 'เข็มทิศเกมชี้ Egnatia +1.75 โมเดลมองต่างจากตลาด ให้โอกาสถูก 81% ขณะที่ตลาดให้ 67%' } },
      'Home B/EARLY': { output: { pick_th: 'ตลาดประเมินพลาด Away B ชนะแน่นอน 90%' } },
    });
    expect(await pickNoteJob(ctx, { now: NOW, writer })).toBe(2);
    expect(writer.calls).toBe(2);

    const a = (await db.query<Record<string, unknown>>(`select p.* from pick_explanations p join analysis_predictions a on a.id = p.analysis_prediction_id where a.fixture_id = 201`)).rows;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ text_source: 'AI', ai_status: 'OK', version: PICK_NOTE_VERSION, prompt_version: PICK_NOTE_PROMPT_VERSION, model: 'gpt-test' });
    expect(a[0]!.note_th).toContain('มองต่างจากตลาด');

    // what the AI saw: the pick with both chances, the gap and the win conditions, plus the match facts; never the price
    const seen = writer.inputs.find((i) => (i.fixture as { home: string }).home === 'Egnatia')!;
    expect(seen.pick).toMatchObject({ round: 'EARLY', market: 'ASIAN_HANDICAP', side: 'Egnatia', line: 1.75, label: 'Egnatia +1.75', modelChance: 0.815, marketChance: 0.671, differencePts: 14.4, strength: 'STRONG' });
    expect((seen.pick as { winConditions: string[] }).winConditions[0]).toBe('Egnatia ชนะ เสมอ หรือแพ้ 1 ลูก → ถูก');
    expect(seen.home).toBeDefined();
    expect(seen.data_support).toBeDefined();
    expect(JSON.stringify(seen.pick)).not.toContain('1.95');

    const b = (await db.query<Record<string, unknown>>(`select p.* from pick_explanations p join analysis_predictions a on a.id = p.analysis_prediction_id where a.fixture_id = 202`)).rows[0]!;
    expect(b).toMatchObject({ text_source: 'TEMPLATE', ai_status: 'INVALID' });
    expect(b.guard_violations).toEqual(expect.arrayContaining(['banned word "ประเมินพลาด"', 'banned word "แน่นอน"', 'number not in input: 90%']));
    expect(b.note_th).toBe('โมเดลมองว่า Away B จะชนะห่างมากกว่าที่ตลาดคาด ที่ Away B -0.5 โมเดลให้โอกาสถูก 58% ขณะที่ตลาดให้ 50%');

    // fog gets no note
    expect((await db.query(`select 1 from pick_explanations where fixture_id = 203`)).rows).toHaveLength(0);
  });

  it('retries a failed AI note once, never a passed one; a new round gets its own note', async () => {
    const again = fakeWriter({ 'Home B/EARLY': { output: { pick_th: 'เข็มทิศเกมชี้ Away B -0.5 โมเดลมองต่างจากตลาดเล็กน้อย จากฟอร์มที่ดีกว่าในช่วงหลัง' } } });
    expect(await pickNoteJob(ctx, { now: NOW, writer: again })).toBe(1);
    expect(again.calls).toBe(1);
    expect((await db.query(`select note_th from web_pick_explanations where fixture_id = 202`)).rows[0]).toMatchObject({ note_th: expect.stringContaining('ฟอร์มที่ดีกว่า') });

    // the LINEUP round is a new pick (a new row in the chain): it is explained on its own, from the LINEUP facts
    await publish(201, 'LINEUP', { selection: 'HOME', line: 1.5, model: 0.7, market: 0.62 });
    const lineup = fakeWriter({ 'Egnatia/LINEUP': { output: { pick_th: 'รอบตัวจริงเข็มทิศเกมยังชี้ Egnatia +1.5 โมเดลมองต่างจากตลาดน้อยลง' } } });
    expect(await pickNoteJob(ctx, { now: NOW, writer: lineup })).toBe(1);
    expect((lineup.inputs[0]!.fixture as { stage: string }).stage).toBe('LINEUP');
    expect((await db.query(`select count(*) n from web_pick_explanations where fixture_id = 201`)).rows[0]).toMatchObject({ n: 2 });
    expect(await pickNoteJob(ctx, { now: NOW, writer: fakeWriter({}) })).toBe(0);
  });

  it('without an AI key every pick still gets the template note, once; rows are immutable and refused after kickoff', async () => {
    await db.query(`insert into teams (id, name) values (7, 'Home D'), (8, 'Away D')`);
    await db.query(`insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short, slug) values (204, 39, 2026, $1, 7, 8, 'NS', 'n204')`, [KO.toISOString()]);
    await publish(204, 'EARLY', { selection: 'HOME', line: 0, model: 0.6, market: 0.52 });
    expect(await pickNoteJob(ctx, { now: NOW, writer: null })).toBe(1);
    expect(await pickNoteJob(ctx, { now: NOW, writer: null })).toBe(0);
    const d = (await db.query<Record<string, unknown>>(`select * from pick_explanations where fixture_id = 204`)).rows[0]!;
    expect(d).toMatchObject({ text_source: 'TEMPLATE', ai_status: 'SKIPPED', model: null });

    await expect(db.query(`update pick_explanations set note_th = 'x' where fixture_id = 204`)).rejects.toThrow();
    await db.query(`update fixtures set kickoff_at = now() - interval '1 minute' where id = 204`);
    await expect(
      db.query(`insert into pick_explanations (analysis_prediction_id, fixture_id, kickoff_at, version, text_source, ai_status, note_th, facts) values ($1, 204, now(), 'v', 'TEMPLATE', 'SKIPPED', 'x', '{}')`, [d.analysis_prediction_id]),
    ).rejects.toThrow(/before kickoff/);
  });
});
