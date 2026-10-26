/**
 * web_model_outlook / web_model_outlook_performance: last pre-kickoff probabilities only,
 * ensemble preferred for 1X2, tested flags from the latest tuned config, anon read-only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers.js';

let db: Awaited<ReturnType<typeof createTestDb>>;
const q = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<R>(sql, params)).rows;

async function probs(fixture: number, version: string, at: string, h: number, d: number, a: number, over?: number) {
  for (const [sel, p] of [['HOME', h], ['DRAW', d], ['AWAY', a]] as const)
    await q(`insert into probability_predictions (fixture_id, model_version_id, computed_at, market, selection, line, probability) values ($1, $2, $3, 'MATCH_WINNER', $4, null, $5)`, [fixture, version, at, sel, p]);
  if (over !== undefined)
    await q(`insert into probability_predictions (fixture_id, model_version_id, computed_at, market, selection, line, probability) values ($1, $2, $3, 'OVER_UNDER', 'OVER', 2.5, $4)`, [fixture, version, at, over]);
}

beforeAll(async () => {
  db = await createTestDb();
  await db.exec(`
    insert into leagues (id, name) values (39, 'Premier League'), (296, 'Thai League 1');
    insert into teams (id, name, slug) values (40, 'A', 'a-40'), (42, 'B', 'b-42');
    insert into model_versions (id) values ('dixon-coles-v0.2'), ('ensemble-v0.1');
    -- 1: EPL finished 2-0, tuned (ensemble enabled; an older disabled row must not win)
    -- 2: Thai League finished 1-1, untuned, no ensemble
    -- 3: Thai League upcoming
    insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short, goals_home, goals_away, ft_home, ft_away, slug) values
      (1, 39, 2026, '2026-10-01T19:00:00Z', 40, 42, 'FT', 2, 0, 2, 0, 'm1'),
      (2, 296, 2026, '2026-10-02T12:00:00Z', 40, 42, 'FT', 1, 1, 1, 1, 'm2'),
      (3, 296, 2026, now() + interval '1 day', 40, 42, 'NS', null, null, null, null, 'm3');
    insert into model_configs (league_id, purpose, model_version_id, params, metrics, enabled, matches_evaluated, tuned_at) values
      (39, 'ENSEMBLE', 'ensemble-v0.1', '{}', '{}', false, 100, '2026-09-01'),
      (39, 'ENSEMBLE', 'ensemble-v0.1', '{}', '{}', true, 100, '2026-09-20'),
      (39, 'TOTALS', 'dixon-coles-v0.2', '{}', '{}', false, 100, '2026-09-20');`);
  await probs(1, 'dixon-coles-v0.2', '2026-10-01T10:00:00Z', 0.5, 0.3, 0.2, 0.55);
  await probs(1, 'ensemble-v0.1', '2026-09-30T10:00:00Z', 0.4, 0.3, 0.3);
  await probs(1, 'ensemble-v0.1', '2026-10-01T10:00:00Z', 0.6, 0.25, 0.15);
  await probs(1, 'ensemble-v0.1', '2026-10-01T20:00:00Z', 0.99, 0.005, 0.005); // after kickoff -> ignored
  await probs(2, 'dixon-coles-v0.2', '2026-10-02T06:00:00Z', 0.45, 0.3, 0.25, 0.6);
  await probs(3, 'dixon-coles-v0.2', new Date().toISOString(), 0.3, 0.3, 0.4, 0.4);
  // web_model_outlook_performance is materialized (0044): refresh as the hourly job does
  await q('select fp_refresh_web_results()');
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('web_model_outlook', () => {
  it('uses the last pre-kickoff ensemble for 1X2, Dixon-Coles for O/U, and flags tested markets', async () => {
    const [r] = await q<Record<string, unknown>>(`select * from web_model_outlook where fixture_id = 1`);
    expect(r).toMatchObject({ model_version_id: 'ensemble-v0.1', sides_tested: true, totals_tested: false });
    expect([Number(r!.p_home), Number(r!.p_draw), Number(r!.p_away), Number(r!.p_over25)]).toEqual([0.6, 0.25, 0.15, 0.55]);
    expect(new Date(r!.computed_at as string).toISOString()).toBe('2026-10-01T10:00:00.000Z');
  });

  it('falls back to Dixon-Coles and marks untuned leagues as not tested', async () => {
    const [r] = await q<Record<string, unknown>>(`select * from web_model_outlook where fixture_id = 2`);
    expect(r).toMatchObject({ model_version_id: 'dixon-coles-v0.2', sides_tested: false, totals_tested: false });
    expect(Number(r!.p_home)).toBe(0.45);
  });

  it('scores finished matches only, split by tested', async () => {
    const rows = await q<Record<string, unknown>>(`select * from web_model_outlook_performance order by tested`);
    // untested: fixture 2 (top = HOME 0.45, result DRAW -> wrong; over 0.6 vs 2 goals -> wrong); fixture 3 not finished
    // tested: fixture 1 (top = HOME 0.6, 2-0 -> right; over 0.55 vs 2 goals -> wrong)
    expect(rows.map((r) => [r.tested, r.matches, r.correct, Number(r.expected_rate), r.ou_matches, r.ou_correct])).toEqual([
      [false, 1, 0, 0.45, 1, 0],
      [true, 1, 1, 0.6, 1, 0],
    ]);
  });

  it('is read-only for anon', async () => {
    const grants = await q<{ privilege_type: string }>(
      `select privilege_type from information_schema.role_table_grants where grantee = 'anon' and table_name in ('web_model_outlook', 'web_model_outlook_performance')`,
    );
    expect([...new Set(grants.map((g) => g.privilege_type))]).toEqual(['SELECT']);
  });
});
