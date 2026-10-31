/**
 * E2E: fixtures + model rows (PGlite, all migrations) -> preview job (fake writer / no writer) -> web view.
 * The real Claude client is never called here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { PREVIEW_PROMPT_VERSION, type PreviewWriter, type RankerResult } from '@fp/ai';
import { Repository, type JobContext } from '@fp/database';
import { ApiFootball, ApiFootballClient } from '@fp/football';
import { createLogger, type Env } from '@fp/shared';
import { createTestDb } from '../../../packages/database/test/helpers.js';
import { matchPreviewJob } from '../src/preview-job.js';
import { bothTeamsScore, goalBands, PREVIEW_VERSION, priceSelection, scoreMatrix, type PreviewTeam } from '@fp/analysis';

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

/** a v1.1 answer, naming the teams as the guard asks */
const prose = (home: string, away: string, over: Record<string, unknown> = {}) => ({
  output: {
    headline_th: `${home} รับมือ ${away}`,
    overview_th: `โมเดลให้ ${home} 50% เกมนี้ข้อมูลเอียงไปทาง ${home} เล็กน้อย ส่วน ${away} ยังตามอยู่`,
    home_th: `${home} ฟอร์มดีจากข้อมูลล่าสุดในระบบของเรา เกมรุกเดินได้ต่อเนื่อง ส่วนเกมรับยังมีข้อมูลไม่มาก`,
    away_th: `${away} มีข้อมูลน้อยในระบบ จึงอ่านได้ไม่มากว่าจะสร้างปัญหาให้เจ้าบ้านได้แค่ไหนในเกมนี้`,
    team_news_th: 'ยังไม่ประกาศรายชื่อตัวจริงของทั้งสองทีม',
    analysis_th: 'สกอร์ที่โมเดลให้โอกาสสูงสุดคือ 1-0 เป็นหนึ่งในหลายสกอร์ที่เป็นไปได้ ข้อมูลของทั้งสองทีมยังมีไม่มาก',
    facts_th: [`${home} ฟอร์มดีในช่วงหลัง`, `${away} มีข้อมูลในระบบน้อย`, `${home} ได้เล่นในบ้าน`],
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
  await db.query(`insert into fixture_statistics (fixture_id, team_id, type, value_num) values (1, 1, 'expected_goals', 1.8), (1, 2, 'expected_goals', 0.6),
    (1, 1, 'shots_on_goal', 6), (1, 1, 'ball_possession', 58), (3, 1, 'shots_on_goal', 3), (3, 1, 'ball_possession', 51)`);
  await db.query(`insert into injuries (fixture_id, league_id, season, team_id, player_id, player_name, type, reason) values (101, 39, 2026, 2, 900, 'B. Injured', 'Missing Fixture', 'Knee Injury')`);
  // v0.7 facts: venue + referee, table detail, a cup table nobody has played in yet, key players
  await db.exec(`
    insert into venues (id, name, city) values (77, 'Home Park', 'Hometown');
    update fixtures set venue_id = 77, referee = 'A. Referee, England' where id = 101;
    update standings set goals_diff = 11, description = 'Promotion - Champions League', home = '{"played": 4, "win": 4, "draw": 0, "lose": 0, "goals": {"for": 9, "against": 1}}' where team_id = 1;
    insert into standings (league_id, season, team_id, rank, points, played, win, draw, lose, goals_for, goals_against) values (1129, 2026, 3, 30, 0, 0, 0, 0, 0, 0, 0);
    insert into players (id, name) values (101, 'Star Striker'), (502, 'Playmaker'), (900, 'B. Injured');
    insert into fixture_player_stats (fixture_id, team_id, player_id, minutes, goals, assists) values
      (1, 1, 101, 90, 2, 0), (3, 1, 101, 90, 1, 1), (3, 1, 502, 80, 0, 2), (5, 1, 103, 10, 0, 0),
      (2, 2, 900, 90, 1, 0);`);

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
  await db.query(
    `insert into scoreline_snapshots (fixture_id, model_version_id, computed_at, source, sides_lambda, sides_mu, sides_rho, sides_matrix, totals_lambda, totals_mu, totals_matrix)
     values (101, 'dixon-coles-v0.2', $1, 'live', 1.6, 0.9, -0.05, $2, 2.2, 0.6, $3)`,
    [at, JSON.stringify(scoreMatrix(1.6, 0.9, -0.05)), JSON.stringify(TOTALS)],
  );
}, 60_000);

/** totals matrix of fixture 101's run: more goals than the sides rates (1.6 / 0.9) */
const TOTALS = scoreMatrix(2.2, 0.6, -0.05);

afterAll(async () => {
  await db?.close();
});

describe('matchPreviewJob', () => {
  it('writes an AI preview where the text passes the guards, template text otherwise, and never skips a match', async () => {
    const writer = fakeWriter({
      'Home A': prose('Home A', 'Away A'),
      'Home B': prose('Home B', 'Away B', { analysis_th: 'สกอร์น่าจะเป็น 2-1 โดยเจ้าบ้านมีโอกาส 72% ตามตัวเลขที่เห็นในข้อมูลของทั้งสองทีมตอนนี้' }), // invented number + foreign scoreline
      'Home C': { output: null, stopReason: 'refusal', refusal: { category: 'general_harms', explanation: null } },
    });
    expect(await matchPreviewJob(ctx, { sameFootballDay: false, now: NOW, writer })).toBe(3);
    expect(writer.calls).toBe(3);

    const a = await one(`select * from match_previews where fixture_id = 101`);
    expect(a).toMatchObject({ stage: 'EARLY', text_source: 'AI', ai_status: 'OK', data_support: 'LIMITED', prompt_version: PREVIEW_PROMPT_VERSION, version: PREVIEW_VERSION, predicted_home: 2, predicted_away: 0 });
    expect(a.overview_th).toContain('50%');
    expect(Number(a.p_home)).toBe(0.5); // ensemble, like 📊 มุมมองโมเดล
    // goals from the run's totals matrix (the outlook's over 2.5), not the sides one (lambda 1.6)
    expect(Number(a.expected_home)).toBeCloseTo(2.2, 1);
    expect(Number(a.expected_away)).toBeCloseTo(0.6, 1);
    expect(Number(a.p_goals_0_1) + Number(a.p_goals_2) + Number(a.p_goals_3plus)).toBeCloseTo(1, 3);
    expect(Number(a.p_goals_3plus)).toBeCloseTo(priceSelection(TOTALS, { market: 'OVER_UNDER', selection: 'OVER', line: 2.5 }).probability, 3);
    expect(Number(a.p_goals_3plus)).toBeCloseTo(goalBands(TOTALS).threePlus, 3);
    // v1.1: each side in turn, team news, analysis and facts; the v1.0 points and the v0.7 sections stay null
    expect(a).toMatchObject({ main_side: 'HOME', attack_th: null, defence_th: null, opponent_th: null, score_th: null, key_factor_th: null, h2h_th: null, summary_th: null });
    expect(a.headline_th).toBe('Home A รับมือ Away A');
    expect(a.home_th).toContain('Home A ฟอร์มดี');
    expect(a.away_th).toContain('Away A');
    expect(a.team_news_th).toContain('ยังไม่ประกาศรายชื่อตัวจริง');
    expect(a.analysis_th).toContain('สกอร์ที่โมเดลให้โอกาสสูงสุด');
    expect(a.facts_th).toEqual(['Home A ฟอร์มดีในช่วงหลัง', 'Away A มีข้อมูลในระบบน้อย', 'Home A ได้เล่นในบ้าน']);
    // the summary's confidence comes from rules: limited data (short form) -> MEDIUM
    expect(a).toMatchObject({ confidence: 'MEDIUM', confidence_notes: ['ข้อมูลบางส่วนจำกัด'] });
    // both teams to score from the same totals matrix as the bands
    expect(Number(a.p_btts)).toBeCloseTo(bothTeamsScore(TOTALS), 3);
    // both teams have fewer than 5 recent results in the DB -> LIMITED; no odds is a minor note
    expect(a.data_notes).toEqual([expect.stringContaining('Home A มีผลการแข่งขันล่าสุดในระบบเพียง 4 นัด'), expect.stringContaining('Away A มีผลการแข่งขันล่าสุดในระบบเพียง 3 นัด')]);

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
    // the AI never sees the goal bands (3+ is over 2.5, once written up as an over lean)
    expect(JSON.stringify(seen)).not.toMatch(/threePlus|upTo1|p_goals/);
    // which way each source leans: no odds and no Elo here, recent form and xG side with the model
    expect(seen.focus).toEqual({ mainSide: 'HOME', main: 'Home A', opponent: 'Away A' });
    expect(seen.views).toEqual({ model: 'Home A', market: null, recentForm: 'Home A', recentXg: 'Home A', otherModel: null, marketP: null, disagreements: [] });

    // v0.7: venue, referee name only, table detail, form dates + competition, rest days, averages, key players
    const fx = seen.fixture as Record<string, unknown>;
    expect(fx.venue).toEqual({ name: 'Home Park', city: 'Hometown' });
    expect(fx.referee).toBe('A. Referee');
    const h = seen.home as unknown as PreviewTeam;
    expect(h.standing).toMatchObject({ goalDiff: 11, zone: 'Promotion - Champions League', teams: 2, home: { played: 4, win: 4, goalsFor: 9 }, away: null });
    expect(h.form[0]).toMatchObject({ competition: 'Premier League', date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(h.restDays).toBe(7);
    expect(h.averages).toEqual({ matches: 2, shotsOnTarget: 4.5, possession: 54.5 });
    // by goals + assists; a player with neither is left out
    expect(h.keyPlayers).toEqual([
      { name: 'Star Striker', goals: 3, assists: 1, appearances: 2 },
      { name: 'Playmaker', goals: 0, assists: 2, appearances: 1 },
    ]);
    expect(h.lineup).toBeNull(); // EARLY
    const aw = seen.away as unknown as PreviewTeam;
    expect(aw.injuries[0]).toMatchObject({ player: 'B. Injured', isKeyPlayer: true, goals: 1, assists: 0 });

    // a cup table the team has not played in yet is no fact at all
    const cup = writer.inputs.find((i) => (i.fixture as { home: string }).home === 'Home B')!;
    expect((cup.home as { standing: unknown }).standing).toBeNull();

    const b = await one(`select * from match_previews where fixture_id = 102`);
    expect(b).toMatchObject({ text_source: 'TEMPLATE', ai_status: 'INVALID', data_support: 'THIN' });
    expect(b.guard_violations).toEqual(expect.arrayContaining(['analysis_th: number not in input: 72%', 'analysis_th: scoreline not from the model: 2-1']));
    expect((b.data_notes as string[])[0]).toContain('บอลถ้วยที่ทีมมาจากคนละลีก');
    expect(b.analysis_th).toContain('สกอร์ที่โมเดลให้โอกาสสูงสุด');
    // a cup with no table, no recent results and no meeting in the DB: the template lists no facts rather than invent one
    expect(b.facts_th).toEqual([]);
    // a cross-league cup with 40 cup matches is THIN; the template names no stock risk
    expect(b.overview_th).toContain('Home B พบ Away B');
    expect(b.predicted_home).not.toBeNull();

    const c = await one(`select * from match_previews where fixture_id = 103`);
    expect(c).toMatchObject({ text_source: 'TEMPLATE', ai_status: 'REFUSED', data_support: 'THIN', predicted_home: null, p_home: null });
    expect(c.overview_th).toContain('โมเดลยังไม่มีตัวเลข');

    expect((await one(`select count(*) n from match_previews where fixture_id = 104`)).n).toBe(0);
  });

  it('retries a failed AI attempt once per stage (append-only), never a passed one', async () => {
    // API down: 102 (INVALID) and 103 (REFUSED) are retried, 101 (OK) is not; nothing stored
    const down = fakeWriter({});
    expect(await matchPreviewJob(ctx, { sameFootballDay: false, now: NOW, writer: down })).toBe(0);
    expect(down.calls).toBe(2);

    const second = fakeWriter({
      'Home B': prose('Home B', 'Away B', { overview_th: 'บอลถ้วยข้ามลีก Home B กับ Away B ข้อมูลเทียบกันได้น้อย โมเดลเอียงไปทางเจ้าบ้านเล็กน้อยเท่านั้น', analysis_th: 'สกอร์ของโมเดลสูสี ข้อมูลยังบางมากสำหรับคู่นี้ จึงยังสรุปภาพของเกมนี้ได้ไม่ชัดนักในตอนนี้' }),
      'Home C': prose('Home C', 'Away C', { overview_th: 'โมเดลให้ Home C 99% แน่นอนว่าชนะ Away C' }),
    });
    expect(await matchPreviewJob(ctx, { sameFootballDay: false, now: NOW, writer: second })).toBe(2);
    const b = (await db.query<Record<string, unknown>>(`select text_source, ai_status from match_previews where fixture_id = 102 order by id`)).rows;
    expect(b).toEqual([
      { text_source: 'TEMPLATE', ai_status: 'INVALID' },
      { text_source: 'AI', ai_status: 'OK' },
    ]);
    expect((await one(`select text_source from web_match_previews where fixture_id = 102`)).text_source).toBe('AI');

    // two attempts is the limit, even when both failed (103); without a writer nothing is retried
    const third = fakeWriter({ 'Home C': prose('Home C', 'Away C') });
    expect(await matchPreviewJob(ctx, { sameFootballDay: false, now: NOW, writer: third })).toBe(0);
    expect(third.calls).toBe(0);
    expect(Number((await one(`select count(*) n from match_previews where fixture_id = 103`)).n)).toBe(2);
  });

  it('is idempotent per stage; a LINEUP stage is added once the XIs are confirmed', async () => {
    const writer = fakeWriter({});
    expect(await matchPreviewJob(ctx, { sameFootballDay: false, now: NOW, writer: null })).toBe(0);
    expect(writer.calls).toBe(0);

    await db.query(`insert into fixture_lineups (fixture_id, team_id, formation) values (101, 1, '4-3-3'), (101, 2, '4-4-2')`);
    await db.query(`insert into fixture_lineup_players (fixture_id, team_id, player_id, player_name, number, position, is_starter)
                    select 101, t, t * 100 + g, 'P' || g, g, 'M', true from generate_series(1, 11) g, (values (1), (2)) as teams(t)`);
    const later = new Date(KO.getTime() - 60 * 60_000);
    expect(await matchPreviewJob(ctx, { sameFootballDay: false, now: later, writer: null })).toBe(1);
    const rows = (await db.query<Record<string, unknown>>(`select stage, text_source, ai_status from match_previews where fixture_id = 101 order by id`)).rows;
    expect(rows).toEqual([
      { stage: 'EARLY', text_source: 'AI', ai_status: 'OK' },
      { stage: 'LINEUP', text_source: 'TEMPLATE', ai_status: 'SKIPPED' },
    ]);
    const lineupRow = await one(`select home_th, team_news_th, facts from match_previews where fixture_id = 101 and stage = 'LINEUP'`);
    expect(lineupRow.home_th).toContain('ประกาศตัวจริงแล้ว');
    expect(lineupRow.team_news_th).toContain('ทั้งสองทีมประกาศตัวจริงแล้ว');
    // LINEUP: formation and the key players who are not in the XI (Star Striker, id 101, starts)
    expect((lineupRow.facts as { home: PreviewTeam }).home.lineup).toEqual({ formation: '4-3-3', coach: null, keyPlayersNotStarting: ['Playmaker'] });
  });

  it('the site sees the latest stage per fixture, read-only and immutable', async () => {
    const v = await one(`select stage, overview_th from web_match_previews where fixture_id = 101`);
    expect(v.stage).toBe('LINEUP');
    expect((await db.query(`select fixture_id from web_match_previews order by fixture_id`)).rows.map((r: Record<string, unknown>) => Number(r.fixture_id))).toEqual([101, 102, 103]);
    await expect(db.query(`update match_previews set overview_th = 'x' where fixture_id = 101`)).rejects.toThrow();
    await expect(db.query(`delete from match_previews where fixture_id = 101`)).rejects.toThrow();
  });

  it('--refresh rewrites a stage written by an older version, once', async () => {
    await db.query(`update fixtures set kickoff_at = $1 where id = 104`, [KO.toISOString()]);
    await db.query(
      `insert into match_previews (fixture_id, stage, kickoff_at, version, text_source, ai_status, data_support, overview_th, home_th, away_th, score_th, facts)
       values (104, 'EARLY', $1, 'preview-v0.0', 'AI', 'OK', 'GOOD', 'a', 'b', 'c', 'd', '{}')`,
      [KO.toISOString()],
    );
    expect(await matchPreviewJob(ctx, { sameFootballDay: false, now: NOW, writer: null })).toBe(0);
    // --until: only matches kicking off before it (a refresh of today's matches only)
    expect(await matchPreviewJob(ctx, { sameFootballDay: false, now: NOW, writer: null, refresh: true, until: new Date(KO.getTime() - 60_000) })).toBe(0);
    expect(await matchPreviewJob(ctx, { sameFootballDay: false, now: NOW, writer: null, refresh: true })).toBe(1);
    expect(await matchPreviewJob(ctx, { sameFootballDay: false, now: NOW, writer: null, refresh: true })).toBe(0);
    const rows = (await db.query<Record<string, unknown>>(`select version from match_previews where fixture_id = 104 order by id`)).rows;
    expect(rows.map((r) => r.version)).toEqual(['preview-v0.0', PREVIEW_VERSION]);
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

  it('a persistent API error (e.g. no credit) stops the AI for the run; every match still gets the template', async () => {
    await db.query(`insert into teams (id, name) values (11, 'Home E'), (12, 'Away E'), (13, 'Home F'), (14, 'Away F')`);
    await db.query(
      `insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short, slug) values
        (105, 39, 2026, $1, 11, 12, 'NS', 'm105'), (106, 39, 2026, $1, 13, 14, 'NS', 'm106')`,
      [KO.toISOString()],
    );
    const broke = {
      calls: 0,
      async write(): Promise<RankerResult> {
        broke.calls++;
        throw new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low' } }, 'credit balance is too low', new Headers());
      },
    };
    expect(await matchPreviewJob(ctx, { sameFootballDay: false, now: NOW, writer: broke })).toBe(2);
    expect(broke.calls).toBe(1);
    const rows = (await db.query<Record<string, unknown>>(`select fixture_id, text_source, ai_status, model from match_previews where fixture_id in (105, 106) order by fixture_id`)).rows;
    expect(rows).toEqual([
      { fixture_id: 105, text_source: 'TEMPLATE', ai_status: 'SKIPPED', model: null },
      { fixture_id: 106, text_source: 'TEMPLATE', ai_status: 'SKIPPED', model: null },
    ]);
  });

  it('stops starting new previews once the time budget is used up; the next run picks them up', async () => {
    await db.query(`insert into teams (id, name) values (15, 'Home G'), (16, 'Away G')`);
    await db.query(
      `insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short, slug) values (107, 39, 2026, $1, 15, 16, 'NS', 'm107')`,
      [KO.toISOString()],
    );
    const writer = fakeWriter({ 'Home G': prose('Home G', 'Away G') });
    expect(await matchPreviewJob(ctx, { sameFootballDay: false, now: NOW, writer, budgetMinutes: -1 })).toBe(0);
    expect(writer.calls).toBe(0);
    expect((await db.query(`select 1 from match_previews where fixture_id = 107`)).rows).toHaveLength(0);
    await matchPreviewJob(ctx, { sameFootballDay: false, now: NOW, writer });
    expect((await db.query(`select 1 from match_previews where fixture_id = 107`)).rows).toHaveLength(1);
  });
});
