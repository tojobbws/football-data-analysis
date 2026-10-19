/**
 * web_model_results / web_model_calibration: last pre-kickoff probabilities per model version,
 * scored on the 90-minute result, nothing computed after kickoff counts, anon sees only the summary views.
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
    insert into model_versions (id) values ('dixon-coles-v0.2'), ('elo-v0.1');
    insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short, goals_home, goals_away, ft_home, ft_away, slug) values
      (1, 39, 2026, '2026-10-01T19:00:00Z', 40, 42, 'FT', 2, 0, 2, 0, 'm1'),
      (2, 296, 2026, '2026-10-02T12:00:00Z', 40, 42, 'FT', 1, 1, 1, 1, 'm2'),
      (3, 296, 2026, now() + interval '1 day', 40, 42, 'NS', null, null, null, null, 'm3');`);
  // fixture 1 ends 2-0 (home win, under 2.5): an early run, a later run, one after kickoff
  await probs(1, 'dixon-coles-v0.2', '2026-09-30T10:00:00Z', 0.2, 0.3, 0.5, 0.9);
  await probs(1, 'dixon-coles-v0.2', '2026-10-01T10:00:00Z', 0.5, 0.3, 0.2, 0.4);
  await probs(1, 'dixon-coles-v0.2', '2026-10-01T21:00:00Z', 1, 0, 0, 0); // after kickoff: must be ignored
  await probs(1, 'elo-v0.1', '2026-10-01T10:00:00Z', 0.4, 0.3, 0.3);
  // fixture 2 ends 1-1 (draw, total 2)
  await probs(2, 'dixon-coles-v0.2', '2026-10-02T06:00:00Z', 0.3, 0.4, 0.3, 0.5);
  await probs(3, 'dixon-coles-v0.2', new Date().toISOString(), 0.3, 0.3, 0.4, 0.4); // not finished
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('web_model_results', () => {
  it('scores the last pre-kickoff run only', async () => {
    const [r] = await q<Record<string, string | number>>(`select * from web_model_results where league_id = 39 and model_version_id = 'dixon-coles-v0.2'`);
    expect(r).toMatchObject({ matches: 1, correct: 1 });
    // (0.5-1)^2 + 0.3^2 + 0.2^2 = 0.38 ; -ln(0.5) = 0.6931 ; over 2.5 forecast 0.4 and 2-0 is under: 0.16
    expect(Number(r!.brier)).toBeCloseTo(0.38, 4);
    expect(Number(r!.log_loss)).toBeCloseTo(0.6931, 4);
    expect(Number(r!.ou_brier)).toBeCloseTo(0.16, 4);
  });

  it('keeps each model version apart and has an all-leagues row', async () => {
    const rows = await q<{ league_id: number | null; model_version_id: string; matches: number }>(`select league_id, model_version_id, matches from web_model_results order by 2, 1`);
    const dcAll = rows.find((r) => r.league_id === null && r.model_version_id === 'dixon-coles-v0.2');
    expect(dcAll!.matches).toBe(2);
    expect(rows.find((r) => r.league_id === null && r.model_version_id === 'elo-v0.1')!.matches).toBe(1);
  });

  it('never counts an unfinished match', async () => {
    const rows = await q(`select 1 from web_model_result_rows where fixture_id = 3`);
    expect(rows).toHaveLength(0);
  });

  it('puts every outcome of every match in exactly one calibration band', async () => {
    const rows = await q<{ model_version_id: string; outcomes: number }>(`select model_version_id, sum(outcomes)::int as outcomes from web_model_calibration group by 1`);
    expect(rows.find((r) => r.model_version_id === 'dixon-coles-v0.2')!.outcomes).toBe(6); // 2 matches x 3 outcomes
  });

  it('is readable by anon, while the raw predictions, row view and snapshots are not', async () => {
    await db.exec('set role anon');
    try {
      expect((await q(`select 1 from web_model_results limit 1`)).length).toBe(1);
      expect((await q(`select 1 from web_model_calibration limit 1`)).length).toBe(1);
      await expect(q(`select 1 from web_model_result_rows limit 1`)).rejects.toThrow();
      await expect(q(`select 1 from probability_predictions limit 1`)).rejects.toThrow();
      await expect(q(`select 1 from scoreline_snapshots limit 1`)).rejects.toThrow();
    } finally {
      await db.exec('reset role');
    }
  });
});
