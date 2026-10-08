/**
 * E2E: fixtures + model rows (PGlite, all migrations) -> preview job (fake writer / no writer) -> web view.
 * The real Claude client is never called here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PreviewWriter, RankerResult } from '@fp/ai';
import { Repository, type JobContext } from '@fp/database';
import { ApiFootball, ApiFootballClient } from '@fp/football';
import { createLogger, type Env } from '@fp/shared';
import { createTestDb } from '../../../packages/database/test/helpers.js';
import { matchPreviewJob } from '../src/preview-job.js';

let db: Awaited<ReturnType<typeof createTestDb>>;
let ctx: JobContext;
const NOW = new Date();
const KO = new Date(NOW.getTime() + 6 * 3_600_000);
const one = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, params)).rows[0]!;

/** fake AI: answers per home team name */
function fakeWriter(answers: Record<string, Partial<RankerResult> & { output?: unknown }>): PreviewWriter & { calls: number; inputs: Record<string, unknown>[] } {
  const w = {
    calls: 0,
    inputs: [] as Record<string, unknown>[],
    async write(input: Record<string, unknown>): Promise<RankerResult> {
      w.calls++;
      w.inputs.push(input);
      const home = (input.fixture as { home: string }).home;
      const a = answers[home];
      if (!a) throw new Error('API down');
      return { output: null, model: 'claude-opus-5-5', stopReason: 'end_turn', refusal: null, usage: { input_tokens: 2000, output_tokens: 400 }, ...a };
    },
  };
  return w;
}

const prose = (over: Record<string, unknown> = {}) => ({
  output: {
    overview_th: 'โมเดลให้เจ้าบ้าน 50% เกมนี้ข้อมูลเอียงไปทางเจ้าบ้านเล็กน้อย',
    home_th: 'เจ้าบ้านฟอร์มดีจากข้อมูลล่าสุด',
    away_th: 'ทีมเยือนมีข้อมูลน้อยในระบบ',
    score_th: 'สกอร์ที่โมเดลให้โอกาสสูงสุดคือ 1-0',
    ...over,
  },
});

beforeAll(async () => {
  db = await createTestDb();
  const repo = new Repository(db);
  const client = new ApiFootballClient({ apiKey: 'test', fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch });
  const env: Env = {
    API_FOOTBALL_KEY: 'test',
    API_FOOTBALL_BASE_URL: 'https://v3.football.api-sports.io',
    API_FOOTBALL_RPM: 1000,
    DATABASE_URL: 'pglite',
    TRACKED_LEAGUES: [39, 1129],
    SEASON: 2026,
    ODDS_MARKETS: ['MATCH_WINNER', 'ASIAN_HANDICAP', 'OVER_UNDER'],
    ODDS_BOOKMAKERS: [],
    LOG_LEVEL: 'error',
    ANTHROPIC_API_KEY: undefined,
  };
  ctx = { env, db, repo, client, api: new ApiFootball(client), log: createLogger('error') };

  await db.exec(`
    insert into leagues (id, name, type, country) values (39, 'Premier League', 'League', 'England'), (1129, 'ASEAN Club Championship', 'Cup', 'World');
    insert into teams (id, name) values (1, 'Home A'), (2, 'Away A'), (3, 'Home B'), (4, 'Away B'), (5, 'Home C'), (6, 'Away C'), (7, 'Home D'), (8, 'Away D');
    insert into model_versions (id) values ('dixon-coles-v0.2'), ('ensemble-v0.1');
    insert into model_configs (league_id, purpose, model_version_id, params, metrics, enabled, matches_evaluated, tuned_at) values
      (39, 'ENSEMBLE', 'ensemble-v0.1', '{}', '{}', true, 300, '2026-09-20');
    insert into standings (league_id, season, team_id, rank, points, played, win, draw, lose, goals_for, goals_against) values
      (39, 2026, 1, 2, 20, 8, 6, 2, 0, 15, 4), (39, 2026, 2, 15, 7, 8, 2, 1, 5, 6, 12);`);
  // 101: EPL, model + ensemble, tuned           -> AI prose (OK)
  // 102: ASEAN cross-league cup, few matches    -> AI invents a number -> template, THIN
  // 103: EPL, no model rows                     -> AI refused -> template
  // 104: EPL, outside the 48h window            -> nothing
  await db.query(
    `insert into fixtures (id, league_id, season, round, kickoff_at, home_team_id, away_team_id, status_short, slug) values
      (101, 39, 2026, 'Regular Season - 9', $1, 1, 2, 'NS', 'm101'),
      (102, 1129, 2026, 'Group A', $1, 3, 4, 'NS', 'm102'),
      (103, 39, 2026, null, $1, 5, 6, 'NS', 'm103'),
      (104, 39, 2026, null, $2, 7, 8, 'NS', 'm104')`,
    [KO.toISOString(), new Date(NOW.getTime() + 80 * 3_600_000).toISOString()],
  );
  // finished history for form / h2h (ids 1..5)
  const past = (i: number) => new Date(NOW.getTime() - i * 7 * 86_400_000).toISOString();
  await db.query(
    `insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short, goals_home, goals_away, ft_home, ft_away, slug) values
      (1, 39, 2026, $1, 1, 2, 'FT', 2, 0, 2, 0, 'p1'),
      (2, 39, 2026, $2, 2, 1, 'FT', 1, 1, 1, 1, 'p2'),
      (3, 39, 2026, $3, 1, 7, 'FT', 3, 1, 3, 1, 'p3'),
      (4, 39, 2026, $4, 8, 2, 'FT', 2, 0, 2, 0, 'p4'),
      (5, 39, 2026, $5, 1, 8, 'FT', 1, 0, 1, 0, 'p5')`,
    [past(1), past(2), past(3), past(4), past(5)],
  );
  await db.query(`insert into fixture_statistics (fixture_id, team_id, type, value_num) values (1, 1, 'expected_goals', 1.8), (1, 2, 'expected_goals', 0.6)`);
  await db.query(`insert into injuries (fixture_id, league_id, season, team_id, player_id, player_name, type, reason) values (101, 39, 2026, 2, 900, 'B. Injured', 'Missing Fixture', 'Knee Injury')`);

  const at = new Date(NOW.getTime() - 3_600_000).toISOString();
  const inputs = (extra: Record<string, unknown>) =>
    JSON.stringify({ lambda: 1.6, mu: 0.9, rho: -0.05, matchesUsed: 380, xgShare: 0.9, home: { weightedMatches: 20 }, away: { weightedMatches: 18 }, ...extra });
  await db.query(
    `insert into probability_predictions (fixture_id, model_version_id, computed_at, market, selection, line, probability, inputs) values
      (101, 'dixon-coles-v0.2', $1, 'MATCH_WINNER', 'HOME', null, 0.55, $2),
      (101, 'dixon-coles-v0.2', $1, 'MATCH_WINNER', 'DRAW', null, 0.25, null),
      (101, 'dixon-coles-v0.2', $1, 'MATCH_WINNER', 'AWAY', null, 0.20, null),
      (101, 'dixon-coles-v0.2', $1, 'OVER_UNDER', 'OVER', 2.5, 0.52, null),
      (101, 'ensemble-v0.1',    $1, 'MATCH_WINNER', 'HOME', null, 0.50, null),
      (101, 'ensemble-v0.1',    $1, 'MATCH_WINNER', 'DRAW', null, 0.27, null),
      (101, 'ensemble-v0.1',    $1, 'MATCH_WINNER', 'AWAY', null, 0.23, null),
      (102, 'dixon-coles-v0.2', $1, 'MATCH_WINNER', 'HOME', null, 0.40, $3),
      (102, 'dixon-coles-v0.2', $1, 'MATCH_WINNER', 'DRAW', null, 0.30, null),
      (102, 'dixon-coles-v0.2', $1, 'MATCH_WINNER', 'AWAY', null, 0.30, null)`,
    [
      at,
      inputs({}),
      inputs({ matchesUsed: 40, home: { weightedMatches: 3 }, away: { weightedMatches: 2 }, crossLeague: { lambda: 1.2, mu: 1.1, weightCupOnly: 0.5, cupMatchesUsed: 40 } }),
    ],
  );
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('matchPreviewJob', () => {
  it('writes an AI preview where the text passes the guards, template text otherwise, and never skips a match', async () => {
    const writer = fakeWriter({
      'Home A': prose(),
      'Home B': prose({ score_th: 'สกอร์น่าจะเป็น 2-1 โดยเจ้าบ้านมีโอกาส 72%' }), // invented number + foreign scoreline
      'Home C': { output: null, stopReason: 'refusal', refusal: { category: 'general_harms', explanation: null } },
    });
    expect(await matchPreviewJob(ctx, { now: NOW, writer })).toBe(3);
    expect(writer.calls).toBe(3);

    const a = await one(`select * from match_previews where fixture_id = 101`);
    expect(a).toMatchObject({ stage: 'EARLY', text_source: 'AI', ai_status: 'OK', data_support: 'LIMITED', prompt_version: 'preview-ai-v0.2', version: 'preview-v0.2', predicted_home: 1, predicted_away: 0 });
    expect(a.overview_th).toContain('50%');
    expect(Number(a.p_home)).toBe(0.5); // ensemble, like 📊 มุมมองโมเดล
    expect(Number(a.expected_home)).toBeCloseTo(1.6, 1);
    // both teams have fewer than 5 recent results in the DB -> LIMITED; no odds is a minor note
    expect(a.data_notes).toEqual([expect.stringContaining('Home A มีผลการแข่งขันล่าสุดในระบบเพียง 4 นัด'), expect.stringContaining('Away A มีผลการแข่งขันล่าสุดในระบบเพียง 3 นัด'), expect.stringContaining('ไม่มีราคาตลาด')]);

    // what the AI saw: form with xG, standing, injuries, model, h2h, the data-support notes
    const seen = writer.inputs.find((i) => (i.fixture as { home: string }).home === 'Home A')!;
    const home = seen.home as { form: unknown[]; standing: { rank: number }; injuries: unknown[] };
    const away = seen.away as { injuries: Array<{ player: string }> };
    expect(home.form).toHaveLength(4);
    expect(home.standing.rank).toBe(2);
    expect(away.injuries[0]!.player).toBe('B. Injured');
    expect((seen.h2h as unknown[]).length).toBe(2);
    expect((seen.model as { scorelines: unknown[] }).scorelines).toHaveLength(3);
    expect((seen.data_support as { level: string }).level).toBe('LIMITED');

    const b = await one(`select * from match_previews where fixture_id = 102`);
    expect(b).toMatchObject({ text_source: 'TEMPLATE', ai_status: 'INVALID', data_support: 'THIN' });
    expect(b.guard_violations).toEqual(expect.arrayContaining(['number not in input: 72%', 'scoreline not in input: 2-1']));
    expect((b.data_notes as string[])[0]).toContain('บอลถ้วยที่ทีมมาจากคนละลีก');
    expect(b.score_th).toContain('สกอร์ที่โมเดลให้โอกาสสูงสุด');
    expect(b.predicted_home).not.toBeNull();

    const c = await one(`select * from match_previews where fixture_id = 103`);
    expect(c).toMatchObject({ text_source: 'TEMPLATE', ai_status: 'REFUSED', data_support: 'THIN', predicted_home: null, p_home: null });
    expect(c.overview_th).toContain('โมเดลยังไม่มีตัวเลข');

    expect((await one(`select count(*) n from match_previews where fixture_id = 104`)).n).toBe(0);
  });

  it('retries a failed AI attempt once per stage (append-only), never a passed one', async () => {
    // API down: 102 (INVALID) and 103 (REFUSED) are retried, 101 (OK) is not; nothing stored
    const down = fakeWriter({});
    expect(await matchPreviewJob(ctx, { now: NOW, writer: down })).toBe(0);
    expect(down.calls).toBe(2);

    const second = fakeWriter({
      'Home B': prose({ overview_th: 'บอลถ้วยข้ามลีก ข้อมูลเทียบกันได้น้อย โมเดลเอียงไปทางเจ้าบ้านเล็กน้อยเท่านั้น', score_th: 'สกอร์ของโมเดลสูสี ข้อมูลยังบางมาก' }),
      'Home C': prose({ overview_th: 'โมเดลให้ 99% แน่นอน' }),
    });
    expect(await matchPreviewJob(ctx, { now: NOW, writer: second })).toBe(2);
    const b = (await db.query<Record<string, unknown>>(`select text_source, ai_status from match_previews where fixture_id = 102 order by id`)).rows;
    expect(b).toEqual([
      { text_source: 'TEMPLATE', ai_status: 'INVALID' },
      { text_source: 'AI', ai_status: 'OK' },
    ]);
    expect((await one(`select text_source from web_match_previews where fixture_id = 102`)).text_source).toBe('AI');

    // two attempts is the limit, even when both failed (103); without a writer nothing is retried
    const third = fakeWriter({ 'Home C': prose() });
    expect(await matchPreviewJob(ctx, { now: NOW, writer: third })).toBe(0);
    expect(third.calls).toBe(0);
    expect(Number((await one(`select count(*) n from match_previews where fixture_id = 103`)).n)).toBe(2);
  });

  it('is idempotent per stage; a LINEUP stage is added once the XIs are confirmed', async () => {
    const writer = fakeWriter({});
    expect(await matchPreviewJob(ctx, { now: NOW, writer: null })).toBe(0);
    expect(writer.calls).toBe(0);

    await db.query(`insert into fixture_lineups (fixture_id, team_id, formation) values (101, 1, '4-3-3'), (101, 2, '4-4-2')`);
    await db.query(`insert into fixture_lineup_players (fixture_id, team_id, player_id, player_name, number, position, is_starter)
                    select 101, t, t * 100 + g, 'P' || g, g, 'M', true from generate_series(1, 11) g, (values (1), (2)) as teams(t)`);
    const later = new Date(KO.getTime() - 60 * 60_000);
    expect(await matchPreviewJob(ctx, { now: later, writer: null })).toBe(1);
    const rows = (await db.query<Record<string, unknown>>(`select stage, text_source, ai_status from match_previews where fixture_id = 101 order by id`)).rows;
    expect(rows).toEqual([
      { stage: 'EARLY', text_source: 'AI', ai_status: 'OK' },
      { stage: 'LINEUP', text_source: 'TEMPLATE', ai_status: 'SKIPPED' },
    ]);
    expect((await one(`select home_th from match_previews where fixture_id = 101 and stage = 'LINEUP'`)).home_th).toContain('ประกาศตัวจริงแล้ว');
  });

  it('the site sees the latest stage per fixture, read-only and immutable', async () => {
    const v = await one(`select stage, overview_th from web_match_previews where fixture_id = 101`);
    expect(v.stage).toBe('LINEUP');
    expect((await db.query(`select fixture_id from web_match_previews order by fixture_id`)).rows.map((r: Record<string, unknown>) => Number(r.fixture_id))).toEqual([101, 102, 103]);
    await expect(db.query(`update match_previews set overview_th = 'x' where fixture_id = 101`)).rejects.toThrow();
    await expect(db.query(`delete from match_previews where fixture_id = 101`)).rejects.toThrow();
  });

  it('refuses rows at/after kickoff', async () => {
    await db.query(`update fixtures set kickoff_at = now() - interval '1 minute' where id = 103`);
    await expect(
      db.query(
        `insert into match_previews (fixture_id, stage, kickoff_at, version, text_source, ai_status, data_support, overview_th, home_th, away_th, score_th, facts)
         values (103, 'LINEUP', now(), 'v', 'TEMPLATE', 'SKIPPED', 'THIN', 'a', 'b', 'c', 'd', '{}')`,
      ),
    ).rejects.toThrow(/before kickoff/);
  });
});
