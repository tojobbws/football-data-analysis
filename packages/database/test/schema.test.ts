import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrate.js';
import { createTestDb, MIGRATIONS_DIR } from './helpers.js';

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
let db: TestDb;

const q = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<R>(sql, params)).rows;

async function seedFixture(id: number, kickoffSql: string, status = 'NS') {
  await q(`insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short)
           values ($1, 39, 2026, ${kickoffSql}, 40, 42, $2)`, [id, status]);
}

async function publish(fixtureId: number, extra: Record<string, unknown> = {}) {
  const row = {
    fixture_id: fixtureId,
    kind: 'SIGNAL',
    market: 'ASIAN_HANDICAP',
    selection: 'AWAY',
    line: 0.75,
    model_probability: 0.63,
    market_probability: 0.55,
    signal_strength: 'STRONG',
    reason: 'Recent xG + away form',
    published_at: '2020-01-01T00:00:00Z', // attempt to backdate -> must be ignored
    ...extra,
  };
  const cols = Object.keys(row);
  const rows = await q<Record<string, unknown>>(
    `insert into analysis_predictions (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')}) returning *`,
    Object.values(row),
  );
  return rows[0]!;
}

beforeAll(async () => {
  db = await createTestDb();
  await q(`insert into leagues (id, name) values (39, 'Premier League')`);
  await q(`insert into teams (id, name) values (40, 'Liverpool'), (42, 'Arsenal')`);
  await seedFixture(1, `now() + interval '1 day'`);
  await seedFixture(2, `now() + interval '2 days'`);
  await seedFixture(3, `now() - interval '1 hour'`, '1H');
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('migrations', () => {
  it('are idempotent (re-run applies nothing)', async () => {
    expect(await runMigrations(db, MIGRATIONS_DIR)).toEqual([]);
  });
  it('seed placements and categories', async () => {
    expect((await q(`select count(*)::int as n from placements`))[0]!.n).toBe(11);
  });
});

describe('analysis_predictions immutability', () => {
  let first: Record<string, unknown>;

  it('publishes with DB-controlled time, status and hash chain', async () => {
    first = await publish(1);
    expect(first.status).toBe('PENDING');
    expect(first.public_id).toBe('A000001');
    expect(first.prev_hash).toBe('GENESIS');
    expect(String(first.record_hash)).toMatch(/^[0-9a-f]{64}$/);
    const published = new Date(first.published_at as string);
    expect(Math.abs(published.getTime() - Date.now())).toBeLessThan(60_000); // not 2020
  });

  it('chains the next record to the previous hash', async () => {
    const second = await publish(2, { kind: 'NO_CLEAR_SIGNAL', market: null, selection: null, line: null, model_probability: null, market_probability: null, signal_strength: null });
    expect(second.prev_hash).toBe(first.record_hash);
    expect(second.status).toBe('NO_SIGNAL');
    expect(second.public_id).toBe('A000002');
  });

  it('rejects publishing after kickoff', async () => {
    await expect(publish(3)).rejects.toThrow(/already started/);
  });

  it('rejects the same fixture/round twice', async () => {
    await expect(publish(1)).rejects.toThrow();
  });

  it('rejects editing published content', async () => {
    await expect(q(`update analysis_predictions set selection = 'HOME' where id = $1`, [first.id])).rejects.toThrow(/immutable/);
    await expect(q(`update analysis_predictions set reason = 'edited' where id = $1`, [first.id])).rejects.toThrow(/immutable/);
  });

  it('rejects delete and truncate', async () => {
    await expect(q(`delete from analysis_predictions where id = $1`, [first.id])).rejects.toThrow(/not allowed/);
    await expect(q(`truncate analysis_predictions cascade`)).rejects.toThrow(/not allowed/);
  });

  it('rejects settlement before the match is finished', async () => {
    await expect(q(`update analysis_predictions set status = 'WIN' where id = $1`, [first.id])).rejects.toThrow(/not finished/);
  });

  it('settles exactly once after full time', async () => {
    await q(`update fixtures set status_short = 'FT', ft_home = 1, ft_away = 1 where id = 1`);
    const [settled] = await q<Record<string, unknown>>(
      `update analysis_predictions set status = 'WIN', result_score = '1-1', closing_odds = 1.85, clv = 0.021 where id = $1 returning *`,
      [first.id],
    );
    expect(settled!.status).toBe('WIN');
    expect(settled!.settled_at).not.toBeNull();
    await expect(q(`update analysis_predictions set status = 'LOSS' where id = $1`, [first.id])).rejects.toThrow(/already settled/);
    await expect(q(`update analysis_predictions set clv = 0.5 where id = $1`, [first.id])).rejects.toThrow(/already recorded/);
  });

  it('verifies the chain, and detects tampering done by bypassing triggers', async () => {
    const rows = await q<{ ok: boolean }>(`select * from fp_verify_prediction_chain()`);
    expect(rows.every((r) => r.ok)).toBe(true);

    // simulate an admin disabling the guard and rewriting history
    await db.exec(`
      alter table analysis_predictions disable trigger analysis_predictions_update;
      update analysis_predictions set selection = 'HOME' where chain_seq = 1;
      alter table analysis_predictions enable trigger analysis_predictions_update;`);
    const after = await q<{ ok: boolean; chain_seq: string }>(`select * from fp_verify_prediction_chain()`);
    expect(after.find((r) => Number(r.chain_seq) === 1)!.ok).toBe(false);
  });

  it('computes performance from the records', async () => {
    const [all] = await q<Record<string, unknown>>(`select * from analysis_performance where dimension = 'all'`);
    expect(Number(all!.total_signals)).toBe(1);
    expect(Number(all!.no_signal)).toBe(1);
    expect(Number(all!.win)).toBe(1);
    expect(Number(all!.win_rate)).toBe(1);
  });
});

describe('analysis_snapshots', () => {
  it('stores a hashed snapshot before kickoff and is immutable', async () => {
    await seedFixture(4, `now() + interval '3 days'`);
    const p = await publish(4);
    const [s] = await q<Record<string, unknown>>(
      `insert into analysis_snapshots (analysis_prediction_id, form_snapshot, odds_snapshot) values ($1, $2, $3) returning *`,
      [p.id, JSON.stringify({ home: 'WWDLW' }), JSON.stringify({ ah: -0.75 })],
    );
    expect(String(s!.snapshot_hash)).toMatch(/^[0-9a-f]{64}$/);
    await expect(q(`update analysis_snapshots set ai_reasoning = '{}' where id = $1`, [s!.id])).rejects.toThrow(/not allowed/);
  });
});

describe('odds_history', () => {
  it('is append-only, de-duplicates, and survives pruning of raw responses', async () => {
    await seedFixture(10, `now() + interval '1 day'`);
    await q(`insert into bookmakers (id, name) values (8, 'Bet365')`);
    const [raw] = await q<{ id: string }>(`insert into api_raw_responses (endpoint, http_status, response) values ('/odds', 200, '{}') returning id`);
    const insert = `insert into odds_history (fixture_id, bookmaker_id, market, api_bet_id, api_bet_name, selection, line, home_line, raw_value, odds, source_updated_at, raw_response_id)
                    values (10, 8, 'ASIAN_HANDICAP', 4, 'Asian Handicap', 'HOME', -0.5, -0.5, 'Home -0.5', $1, $2, $3)
                    on conflict do nothing returning id`;
    expect(await q(insert, [1.9, '2026-10-06T10:00:00Z', raw!.id])).toHaveLength(1);
    expect(await q(insert, [1.9, '2026-10-06T10:00:00Z', raw!.id])).toHaveLength(0); // same update -> skipped
    expect(await q(insert, [1.8, '2026-10-06T12:00:00Z', raw!.id])).toHaveLength(1); // moved

    await expect(q(`update odds_history set odds = 2.5 where fixture_id = 10`)).rejects.toThrow(/append-only/);
    await expect(q(`delete from odds_history where fixture_id = 10`)).rejects.toThrow(/append-only/);

    await q(`delete from api_raw_responses where id = $1`, [raw!.id]); // prune audit log
    const rows = await q<{ raw_response_id: unknown }>(`select raw_response_id from odds_history where fixture_id = 10`);
    expect(rows.every((r) => r.raw_response_id === null)).toBe(true);

    const [mv] = await q<Record<string, unknown>>(`select * from odds_movement where fixture_id = 10`);
    expect(Number(mv!.opening_odds)).toBe(1.9);
    expect(Number(mv!.current_odds)).toBe(1.8);
    expect(Number(mv!.n_snapshots)).toBe(2);
  });
});

describe('migration 0010 (AH away-line fix)', () => {
  it('recomputes AWAY derived lines from raw_value, idempotently, leaving odds untouched', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await seedFixture(20, `now() + interval '2 days'`);
    await q(`insert into bookmakers (id, name) values (11, 'B11') on conflict do nothing`);
    // rows as the OLD parser stored them ("Away -0.5" read as away -0.5)
    await q(`insert into odds_history (fixture_id, bookmaker_id, market, api_bet_id, api_bet_name, selection, line, home_line, raw_value, odds, source_updated_at) values
      (20, 11, 'ASIAN_HANDICAP', 4, 'Asian Handicap', 'HOME', -0.5, -0.5, 'Home -0.5', 1.78, now()),
      (20, 11, 'ASIAN_HANDICAP', 4, 'Asian Handicap', 'AWAY', -0.5,  0.5, 'Away -0.5', 2.02, now()),
      (20, 11, 'ASIAN_HANDICAP', 4, 'Asian Handicap', 'AWAY',  0.0,  0.0, 'Away +0',   3.45, now()),
      (20, 11, 'ASIAN_HANDICAP', 4, 'Asian Handicap', 'AWAY',  0.25, -0.25, 'Away +0.25', 4.0, now())`);
    const sql = await readFile(join(MIGRATIONS_DIR, '20261007000010_fix_ah_away_lines.sql'), 'utf8');
    await db.exec(sql);
    await db.exec(sql); // idempotent
    const rows = await q<{ raw_value: string; line: string; home_line: string; odds: string }>(
      `select raw_value, line, home_line, odds from odds_history where fixture_id = 20 order by raw_value`,
    );
    const by = Object.fromEntries(rows.map((r) => [r.raw_value, r]));
    expect(Number(by['Away -0.5']!.line)).toBe(0.5);
    expect(Number(by['Away -0.5']!.home_line)).toBe(-0.5);
    expect(Number(by['Away +0.25']!.line)).toBe(-0.25);
    expect(Number(by['Away +0.25']!.home_line)).toBe(0.25);
    expect(Number(by['Away +0']!.line)).toBe(0);
    expect(Number(by['Home -0.5']!.home_line)).toBe(-0.5);
    expect(Number(by['Away -0.5']!.odds)).toBe(2.02);
    // guard is back on
    await expect(q(`update odds_history set odds = 9 where fixture_id = 20`)).rejects.toThrow(/append-only/);
  });
});
