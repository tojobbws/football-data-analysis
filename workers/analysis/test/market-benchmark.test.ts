/**
 * Migration 0043 (audit 2026-10-26): the SQL settlement matches settlement.ts on every line, and
 * web_benchmark_days / analysis_performance_by_match score the model and the market on the same target,
 * one pick per match, grouped by football day.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fairTarget, settle, settleAsian, type MarketSelection } from '@fp/analysis';
import { createTestDb } from '../../../packages/database/test/helpers.js';

let db: Awaited<ReturnType<typeof createTestDb>>;
const q = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<R>(sql, params)).rows;

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('SQL settlement = settlement.ts', () => {
  it('fp_settle_asian on every margin -6..6 and every quarter-grid line -4..4', async () => {
    const rows = await q<{ margin: number; line: string; outcome: string }>(`
      select m as margin, l::text as line, fp_settle_asian(m, l) as outcome
        from generate_series(-6, 6) m, generate_series(-16, 16) k, lateral (select (k * 0.25)::numeric(5,2) as l) x`);
    expect(rows.length).toBe(13 * 33);
    for (const r of rows) expect(r.outcome, `margin ${r.margin} line ${r.line}`).toBe(settleAsian(Number(r.margin), Number(r.line)));
  });

  it('fp_settle_selection on 1X2, both AH sides and both totals sides', async () => {
    const sels: MarketSelection[] = [
      { market: 'MATCH_WINNER', selection: 'HOME' },
      { market: 'MATCH_WINNER', selection: 'DRAW' },
      { market: 'MATCH_WINNER', selection: 'AWAY' },
      ...[-1.75, -1.25, -0.5, 0, 0.25, 1].flatMap((line) => [
        { market: 'ASIAN_HANDICAP' as const, selection: 'HOME' as const, line },
        { market: 'ASIAN_HANDICAP' as const, selection: 'AWAY' as const, line },
      ]),
      ...[1.5, 2, 2.25, 2.75, 3].flatMap((line) => [
        { market: 'OVER_UNDER' as const, selection: 'OVER' as const, line },
        { market: 'OVER_UNDER' as const, selection: 'UNDER' as const, line },
      ]),
    ];
    for (const sel of sels)
      for (const [h, a] of [[0, 0], [1, 0], [2, 1], [0, 2], [3, 0], [2, 2], [1, 3]] as const) {
        const [r] = await q<{ o: string }>('select fp_settle_selection($1, $2, $3, $4, $5) as o', [sel.market, sel.selection, 'line' in sel ? sel.line : null, h, a]);
        expect(r!.o, `${JSON.stringify(sel)} ${h}-${a}`).toBe(settle(sel, h, a));
      }
  });

  it('fair weights match fairTarget; unsettled scores are null', async () => {
    for (const o of ['WIN', 'HALF_WIN', 'PUSH', 'HALF_LOSS', 'LOSS', 'VOID', 'PENDING'] as const) {
      const [r] = await q<{ w: string; y: number }>('select fp_fair_weight($1) as w, fp_fair_y($1) as y', [o]);
      const t = fairTarget(o);
      expect(Number(r!.w)).toBe(t?.weight ?? 0);
      if (t) expect(r!.y).toBe(t.y);
    }
    const [n] = await q<{ o: string | null }>(`select fp_settle_selection('OVER_UNDER', 'OVER', 2.5, null, 1) as o`);
    expect(n!.o).toBeNull();
  });

  it('football day runs 06:00 -> 06:00 Thai time', async () => {
    const [r] = await q<{ a: string; b: string; c: string }>(`
      select fp_football_day('2026-10-20T13:00:00Z')::text as a,   -- 20:00 Thai
             fp_football_day('2026-10-20T22:30:00Z')::text as b,   -- 05:30 Thai on the 21st: still the 20th
             fp_football_day('2026-10-20T23:00:00Z')::text as c    -- 06:00 Thai on the 21st`);
    expect(r).toEqual({ a: '2026-10-20', b: '2026-10-20', c: '2026-10-21' });
  });
});

describe('web_benchmark_days and analysis_performance_by_match', () => {
  beforeAll(async () => {
    // picks are published before kickoff (trigger), then the matches move into the past and settle
    await db.exec(`
      insert into leagues (id, name) values (39, 'Premier League');
      insert into teams (id, name, slug) values (1, 'A', 'a'), (2, 'B', 'b');
      insert into model_versions (id) values ('dixon-coles-v0.2');
      insert into model_configs (league_id, purpose, model_version_id, params, metrics, enabled, matches_evaluated) values (39, 'SIDES', 'dixon-coles-v0.2', '{}', '{}', true, 300);
      insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short, slug) values
        (21, 39, 2026, now() + interval '1 day', 1, 2, 'NS', 'm21'),
        (22, 39, 2026, now() + interval '1 day', 2, 1, 'NS', 'm22'),
        (23, 39, 2026, now() + interval '1 day', 1, 2, 'NS', 'm23');
      insert into analysis_predictions (fixture_id, publish_round, kind, market, selection, line, model_probability, market_probability) values
        (21, 'EARLY',  'SIGNAL', 'ASIAN_HANDICAP', 'HOME', -0.75, 0.58, 0.50),
        (21, 'LINEUP', 'SIGNAL', 'OVER_UNDER', 'OVER', 2.5, 0.55, 0.50),
        (22, 'EARLY',  'NO_CLEAR_SIGNAL', null, null, null, null, null),
        (22, 'LINEUP', 'SIGNAL', 'OVER_UNDER', 'UNDER', 2.25, 0.56, 0.52),
        (23, 'EARLY',  'NO_CLEAR_SIGNAL', null, null, null, null, null);
      -- 21: 2-1 at 20:00 Thai on the 20th · 22: 1-1 at 05:30 Thai on the 21st (same football day) · 23: 0-0 a day later
      update fixtures set status_short = 'FT', kickoff_at = '2026-10-20T13:00:00Z', ft_home = 2, ft_away = 1, goals_home = 2, goals_away = 1 where id = 21;
      update fixtures set status_short = 'FT', kickoff_at = '2026-10-20T22:30:00Z', ft_home = 1, ft_away = 1, goals_home = 1, goals_away = 1 where id = 22;
      update fixtures set status_short = 'FT', kickoff_at = '2026-10-21T12:00:00Z', ft_home = 0, ft_away = 0, goals_home = 0, goals_away = 0 where id = 23;
      update analysis_predictions set status = 'HALF_WIN', clv = 0.05 where fixture_id = 21 and publish_round = 'EARLY';
      update analysis_predictions set status = 'WIN', clv = 0.02 where fixture_id = 21 and publish_round = 'LINEUP';
      update analysis_predictions set status = 'HALF_WIN', clv = -0.01 where fixture_id = 22 and kind = 'SIGNAL';

      insert into probability_predictions (fixture_id, model_version_id, computed_at, market, selection, probability) values
        (21, 'dixon-coles-v0.2', '2026-10-20T10:00:00Z', 'MATCH_WINNER', 'HOME', 0.5),
        (21, 'dixon-coles-v0.2', '2026-10-20T10:00:00Z', 'MATCH_WINNER', 'DRAW', 0.3),
        (21, 'dixon-coles-v0.2', '2026-10-20T10:00:00Z', 'MATCH_WINNER', 'AWAY', 0.2),
        (22, 'dixon-coles-v0.2', '2026-10-20T20:00:00Z', 'MATCH_WINNER', 'HOME', 0.4),
        (22, 'dixon-coles-v0.2', '2026-10-20T20:00:00Z', 'MATCH_WINNER', 'DRAW', 0.35),
        (22, 'dixon-coles-v0.2', '2026-10-20T20:00:00Z', 'MATCH_WINNER', 'AWAY', 0.25);
      insert into market_closing (fixture_id, market, selection, line, bookmakers, median_odds, market_probability, model_probability, closing_at) values
        (21, 'MATCH_WINNER', 'HOME', null, 5, 2.1, 0.45, null, '2026-10-20T13:00:00Z'),
        (21, 'MATCH_WINNER', 'DRAW', null, 5, 3.2, 0.30, null, '2026-10-20T13:00:00Z'),
        (21, 'MATCH_WINNER', 'AWAY', null, 5, 3.8, 0.25, null, '2026-10-20T13:00:00Z'),
        (21, 'ASIAN_HANDICAP', 'HOME', -0.75, 5, 1.95, 0.50, 0.55, '2026-10-20T13:00:00Z'),
        (21, 'ASIAN_HANDICAP', 'AWAY', 0.75, 5, 1.95, 0.50, 0.45, '2026-10-20T13:00:00Z'),
        (21, 'OVER_UNDER', 'OVER', 2.5, 5, 1.85, 0.52, 0.48, '2026-10-20T13:00:00Z'),
        (21, 'OVER_UNDER', 'UNDER', 2.5, 5, 2.0, 0.48, 0.52, '2026-10-20T13:00:00Z'),
        (22, 'MATCH_WINNER', 'HOME', null, 5, 1.9, 0.50, null, '2026-10-20T22:30:00Z'),
        (22, 'MATCH_WINNER', 'DRAW', null, 5, 3.4, 0.28, null, '2026-10-20T22:30:00Z'),
        (22, 'MATCH_WINNER', 'AWAY', null, 5, 4.2, 0.22, null, '2026-10-20T22:30:00Z'),
        (22, 'ASIAN_HANDICAP', 'HOME', 0, 5, 1.8, 0.55, 0.60, '2026-10-20T22:30:00Z'),
        (22, 'OVER_UNDER', 'OVER', 2.25, 5, 2.1, 0.45, 0.50, '2026-10-20T22:30:00Z');
      -- the 1X2 rows come from the materialized model results (0044), as after the hourly refresh
      select fp_refresh_web_results();
    `);
  });

  const day = async (metric: string, d: string) =>
    (await q<Record<string, number | null>>(`select * from web_benchmark_days where metric = $1 and day = $2`, [metric, d]))[0]!;

  it('1X2: model and closing market on the same matches, summed per football day', async () => {
    const r = await day('1X2', '2026-10-20');
    expect(r.model_version_id).toBe('dixon-coles-v0.2');
    expect(r.n).toBe(2);
    // 21 home win: 0.25 + 0.09 + 0.04 vs 0.3025 + 0.09 + 0.0625 · 22 draw: 0.16 + 0.4225 + 0.0625 vs 0.25 + 0.5184 + 0.0484
    expect(r.brier_model).toBeCloseTo(0.38 + 0.645, 9);
    expect(r.brier_market).toBeCloseTo(0.455 + 0.8168, 9);
    expect(r.log_loss_model).toBeCloseTo(-Math.log(0.5) - Math.log(0.35), 9);
    expect(r.log_loss_market).toBeCloseTo(-Math.log(0.45) - Math.log(0.28), 9);
  });

  it('AH main line: home side only, half results weigh ½, a push drops out', async () => {
    // 21: HOME -0.75 on 2-1 = HALF_WIN (w ½, y 1) · 22: HOME 0 on 1-1 = PUSH (out)
    const r = await day('AH_MAIN', '2026-10-20');
    expect(r).toMatchObject({ n: 1, w: 0.5, hit: 0.5 });
    expect(r.brier_model).toBeCloseTo(0.5 * 0.45 ** 2, 9);
    expect(r.brier_market).toBeCloseTo(0.5 * 0.5 ** 2, 9);
  });

  it('O/U main line: over side, quarter line half loss', async () => {
    // 21: OVER 2.5 on 3 goals = WIN · 22: OVER 2.25 on 2 goals = HALF_LOSS (w ½, y 0)
    const r = await day('OU_MAIN', '2026-10-20');
    expect(r).toMatchObject({ n: 2, w: 1.5, hit: 1 });
    expect(r.brier_model).toBeCloseTo(0.52 ** 2 + 0.5 * 0.5 ** 2, 9);
    expect(r.brier_market).toBeCloseTo(0.48 ** 2 + 0.5 * 0.45 ** 2, 9);
    expect(r.log_loss_model).toBeCloseTo(-Math.log(0.48) - 0.5 * Math.log(0.5), 9);
  });

  it('PICK: one per match (its latest SIGNAL), model and market probability recorded at publish', async () => {
    // 21: LINEUP OVER 2.5 WIN (the EARLY HALF_WIN is not counted again) · 22: UNDER 2.25 HALF_WIN
    const r = await day('PICK', '2026-10-20');
    expect(r).toMatchObject({ n: 2, w: 1.5, w_scored: 1.5, hit: 1.5, clv_n: 2 });
    expect(r.brier_model).toBeCloseTo(0.45 ** 2 + 0.5 * 0.44 ** 2, 9);
    expect(r.brier_market).toBeCloseTo(0.5 ** 2 + 0.5 * 0.48 ** 2, 9);
    // calibration in the large: Σ w·p against Σ w·y
    expect(r.p_model).toBeCloseTo(0.55 + 0.5 * 0.56, 9);
    expect(r.p_market).toBeCloseTo(0.5 + 0.5 * 0.52, 9);
    expect(r.clv_sum).toBeCloseTo(0.01, 9);
  });

  it('FINISHED counts the finished matches of modelled leagues per football day', async () => {
    expect((await day('FINISHED', '2026-10-20')).n).toBe(2);
    expect((await day('FINISHED', '2026-10-21')).n).toBe(1);
  });

  it('analysis_performance_by_match counts each match once; analysis_performance counts each round', async () => {
    const [m] = await q<Record<string, string>>(`select * from analysis_performance_by_match where dimension = 'all'`);
    const [rows] = await q<Record<string, string>>(`select * from analysis_performance where dimension = 'all'`);
    expect(Number(rows!.total_signals)).toBe(3);
    expect(m).toMatchObject({ bucket: 'ALL' });
    expect(Number(m!.total_signals)).toBe(2);
    expect(Number(m!.no_signal)).toBe(1); // 23 only: 22's fog is replaced by its pick
    expect(Number(m!.win)).toBe(1);
    expect(Number(m!.half_win)).toBe(1);
    expect(Number(m!.win_rate)).toBe(1);
    expect(Number(m!.avg_clv)).toBeCloseTo(0.005, 9);
    expect(Number(m!.matches_with_repeat_signal)).toBe(1);
    const markets = await q<{ bucket: string; total_signals: string }>(`select bucket, total_signals from analysis_performance_by_match where dimension = 'market' order by bucket`);
    expect(markets.map((r) => [r.bucket, Number(r.total_signals)])).toEqual([['NONE', 0], ['OVER_UNDER', 2]]);
  });

  it('anon reads the summaries but not the private tables behind them', async () => {
    await db.exec(`begin; set local role anon;`);
    try {
      expect((await q('select * from web_benchmark_days')).length).toBeGreaterThan(0);
      // no grant here (PGlite) or RLS with no policy (Supabase): either way nothing comes back
      expect(await q('select * from market_closing').catch(() => [])).toEqual([]);
    } finally {
      await db.exec('rollback;');
    }
  });
});
