/**
 * E2E: finished fixtures in Postgres (PGlite) -> Probability Engine -> probability_predictions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repository, type JobContext } from '@fp/database';
import { ApiFootball, ApiFootballClient } from '@fp/football';
import { createLogger, type Env } from '@fp/shared';
import { createTestDb } from '../../../packages/database/test/helpers.js';
import { backtest, computeProbabilities, tune } from '../src/jobs.js';
import { generateCandidatesJob } from '../src/candidates-job.js';
import { playerImpactJob } from '../src/impact-job.js';
import { publishJob } from '../src/publish-job.js';
import { DEFAULT_RULES, SHADOW_RULES } from '@fp/analysis';

let db: Awaited<ReturnType<typeof createTestDb>>;
let ctx: JobContext;
const NOW = new Date();

beforeAll(async () => {
  db = await createTestDb();
  const repo = new Repository(db);
  const client = new ApiFootballClient({ apiKey: 'test', fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch });
  const env: Env = {
    API_FOOTBALL_KEY: 'test',
    API_FOOTBALL_BASE_URL: 'https://v3.football.api-sports.io',
    API_FOOTBALL_RPM: 1000,
    DATABASE_URL: 'pglite',
    TRACKED_LEAGUES: [39, 5],
    SEASON: 2026,
    ODDS_MARKETS: ['MATCH_WINNER', 'ASIAN_HANDICAP', 'OVER_UNDER'],
    ODDS_BOOKMAKERS: [],
    LOG_LEVEL: 'error',
  };
  ctx = { env, db, repo, client, api: new ApiFootball(client), log: createLogger('error') };

  await db.query(`insert into leagues (id, name) values (39, 'Premier League'), (5, 'UEFA Nations League')`);
  await db.query(`insert into teams (id, name) select g, 'Team ' || g from generate_series(1, 10) g`);
  // 10 teams, double round robin; team 1 strongest (scores more), team 10 weakest
  let id = 1;
  let t = NOW.getTime() - 200 * 86_400_000;
  const rows: string[] = [];
  for (let rep = 0; rep < 2; rep++)
    for (let h = 1; h <= 10; h++)
      for (let a = 1; a <= 10; a++) {
        if (h === a) continue;
        const gh = Math.max(0, Math.round((11 - h) / 3.5 + (rep + h + a) % 2));
        const ga = Math.max(0, Math.round((11 - a) / 4.5 + ((h * a) % 3 === 0 ? 1 : 0) - 0.4));
        rows.push(`(${id++}, 39, 2025, to_timestamp(${t / 1000}), ${h}, ${a}, 'FT', ${gh}, ${ga}, ${gh}, ${ga})`);
        t += 12 * 3_600_000;
      }
  await db.query(
    `insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short, goals_home, goals_away, ft_home, ft_away) values ${rows.join(',')}`,
  );
  // xG for some matches
  await db.query(`insert into fixture_statistics (fixture_id, team_id, type, value_num)
                  select id, home_team_id, 'expected_goals', goals_home + 0.3 from fixtures where id % 2 = 0
                  union all
                  select id, away_team_id, 'expected_goals', goals_away + 0.1 from fixtures where id % 2 = 0`);
  // upcoming: strongest (1) at home vs weakest (10); and a Nations League fixture with no history
  await db.query(`insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short)
                  values (9001, 39, 2026, now() + interval '2 days', 1, 10, 'NS'),
                         (9002, 5, 2026, now() + interval '3 days', 2, 3, 'NS')`);
  // market offers AH -1.25 / +1.25 and O/U 2.75 for 9001
  await db.query(`insert into bookmakers (id, name) values (8, 'Bet365')`);
  await db.query(`insert into odds_history (fixture_id, bookmaker_id, market, api_bet_id, api_bet_name, selection, line, home_line, raw_value, odds, source_updated_at) values
                  (9001, 8, 'ASIAN_HANDICAP', 4, 'Asian Handicap', 'HOME', -1.25, -1.25, 'Home -1.25', 1.9, now()),
                  (9001, 8, 'ASIAN_HANDICAP', 4, 'Asian Handicap', 'AWAY', 1.25, -1.25, 'Away +1.25', 1.95, now()),
                  (9001, 8, 'OVER_UNDER', 5, 'Goals Over/Under', 'OVER', 2.75, null, 'Over 2.75', 1.9, now())`);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

const q = async (sql: string) => (await db.query<Record<string, unknown>>(sql)).rows;

/** Two bookmakers price AH Home -1.25 at the model's probability minus 5pp (3% margin) -> a real edge on HOME. */
async function ahMarketBelowModel(modelVersion: string, at: string) {
  const [row] = await q(`select probability from probability_predictions
                         where fixture_id = 9001 and model_version_id = '${modelVersion}' and market = 'ASIAN_HANDICAP'
                           and selection = 'HOME' and line = -1.25 order by computed_at desc limit 1`);
  const fairHome = Number(row!.probability) - 0.05;
  await db.query(`insert into bookmakers (id, name) values (9, 'Book B') on conflict do nothing`);
  const values: string[] = [];
  for (const bk of [8, 9]) {
    values.push(`(9001, ${bk}, 'ASIAN_HANDICAP', 4, 'Asian Handicap', 'HOME', -1.25, -1.25, 'Home -1.25', ${(1 / (fairHome * 1.03)).toFixed(3)}, '${at}')`);
    values.push(`(9001, ${bk}, 'ASIAN_HANDICAP', 4, 'Asian Handicap', 'AWAY', 1.25, -1.25, 'Away +1.25', ${(1 / ((1 - fairHome) * 1.03)).toFixed(3)}, '${at}')`);
  }
  await db.query(`insert into odds_history (fixture_id, bookmaker_id, market, api_bet_id, api_bet_name, selection, line, home_line, raw_value, odds, source_updated_at) values ${values.join(',')}`);
}

describe('computeProbabilities', () => {
  it('writes 1X2 / AH / O/U for fixtures with enough history and skips leagues without', async () => {
    await computeProbabilities(ctx, { now: NOW });
    const rows = await q(`select model_version_id, market, selection, line, probability, inputs from probability_predictions where fixture_id = 9001 order by model_version_id, market, selection, line`);
    const key = (r: Record<string, unknown>) => `${r.model_version_id}|${r.market}|${r.selection}|${r.line === null ? '' : Number(r.line)}`;
    const keys = rows.map(key);
    expect(keys).toContain('dixon-coles-v0.2|ASIAN_HANDICAP|HOME|-1.25');
    expect(keys).toContain('dixon-coles-v0.2|ASIAN_HANDICAP|AWAY|1.25');
    expect(keys).toContain('dixon-coles-v0.2|OVER_UNDER|OVER|2.75');
    expect(keys).toContain('elo-v0.1|MATCH_WINNER|HOME|');

    const p = (sel: string, model = 'dixon-coles-v0.2') =>
      Number(rows.find((r) => r.model_version_id === model && r.market === 'MATCH_WINNER' && r.selection === sel)!.probability);
    expect(p('HOME') + p('DRAW') + p('AWAY')).toBeCloseTo(1, 3);
    expect(p('HOME')).toBeGreaterThan(p('AWAY')); // strongest at home vs weakest
    expect(p('HOME', 'elo-v0.1')).toBeGreaterThan(p('AWAY', 'elo-v0.1'));

    const ahHome = Number(rows.find((r) => key(r) === 'dixon-coles-v0.2|ASIAN_HANDICAP|HOME|-1.25')!.probability);
    const ahAway = Number(rows.find((r) => key(r) === 'dixon-coles-v0.2|ASIAN_HANDICAP|AWAY|1.25')!.probability);
    expect(ahHome + ahAway).toBeCloseTo(1, 3);

    const first = rows.find((r) => r.inputs && (r.inputs as Record<string, unknown>).lambda !== undefined)!;
    expect((first.inputs as Record<string, number>).matchesUsed).toBe(180);

    expect(await q(`select 1 from probability_predictions where fixture_id = 9002`)).toHaveLength(0);
  });

  it('does not recompute within the gap and the table is insert-only', async () => {
    const before = (await q(`select count(*)::int n from probability_predictions`))[0]!.n;
    await computeProbabilities(ctx, { now: NOW });
    expect((await q(`select count(*)::int n from probability_predictions`))[0]!.n).toBe(before);
    await expect(db.query(`update probability_predictions set probability = 0.99`)).rejects.toThrow(/not allowed/);
  });

  it('registers model versions', async () => {
    const ids = (await q(`select id from model_versions order by id`)).map((r) => r.id);
    expect(ids).toEqual(['dixon-coles-v0.2', 'elo-v0.1', 'ensemble-v0.1']);
  });
});

describe('tuned configs', () => {
  it('tune skips leagues without enough history', async () => {
    expect(await tune(ctx)).toBe(0);
  });

  it('probabilities use the latest config, carry market gates and write ensemble rows', async () => {
    await ctx.repo.insertModelConfigs([
      { leagueId: 39, purpose: 'SIDES', modelVersionId: 'dixon-coles-v0.2', params: { priorStrength: 20, halfLifeDays: 365, xgWeight: 0 }, metrics: {}, enabled: true, matchesEvaluated: 500 },
      { leagueId: 39, purpose: 'TOTALS', modelVersionId: 'dixon-coles-v0.2', params: { priorStrength: 40, halfLifeDays: 730, xgWeight: 0, totalsShrink: 0.75 }, metrics: {}, enabled: false, matchesEvaluated: 500 },
      { leagueId: 39, purpose: 'ELO', modelVersionId: 'elo-v0.1', params: { k: 15, homeAdvantage: 40 }, metrics: {}, enabled: true, matchesEvaluated: 500 },
      { leagueId: 39, purpose: 'ENSEMBLE', modelVersionId: 'ensemble-v0.1', params: { weightDixonColes: 0.75 }, metrics: {}, enabled: true, matchesEvaluated: 500 },
    ]);
    const later = new Date(NOW.getTime() + 7 * 3_600_000); // past the min gap
    await computeProbabilities(ctx, { now: later });
    const rows = await q(`select model_version_id, market, selection, probability, inputs from probability_predictions
                          where fixture_id = 9001 and computed_at = '${later.toISOString()}'`);
    const first = rows.find((r) => r.inputs && (r.inputs as Record<string, unknown>).gates)!;
    expect((first.inputs as Record<string, unknown>).gates).toEqual({ MATCH_WINNER: true, ASIAN_HANDICAP: true, OVER_UNDER: false });
    const ens = rows.filter((r) => r.model_version_id === 'ensemble-v0.1');
    expect(ens).toHaveLength(3);
    expect(ens.reduce((s, r) => s + Number(r.probability), 0)).toBeCloseTo(1, 3);
    // totals use the shrunk model: O/U 2.75 still priced
    expect(rows.some((r) => r.market === 'OVER_UNDER')).toBe(true);
  });

  it('model_configs is append-only', async () => {
    await expect(db.query(`update model_configs set enabled = true`)).rejects.toThrow(/not allowed/);
  });
});

describe('candidate generator job (Phase 5)', () => {
  const LATER = new Date(NOW.getTime() + 7 * 3_600_000);
  const RUN_AT = new Date(LATER.getTime() + 60_000);

  it('thin market (1 bookmaker) -> NO_CLEAR_SIGNAL, but every selection is still recorded', async () => {
    await generateCandidatesJob(ctx, { hours: 72, now: RUN_AT });
    const run = (await q(`select id, outcome, summary from analysis_runs where fixture_id = 9001`))[0]!;
    expect(run.outcome).toBe('NO_CLEAR_SIGNAL');
    const cands = await q(`select rank, factors from analysis_candidates where run_id = '${run.id}'`);
    expect(cands.length).toBeGreaterThan(0);
    expect(cands.every((c) => c.rank === null)).toBe(true);
    expect(cands.some((c) => ((c.factors as { rejectReasons: string[] }).rejectReasons).includes('THIN_MARKET'))).toBe(true);
    // fixture of an untuned league with no probabilities is skipped, not guessed
    expect(await q(`select 1 from analysis_runs where fixture_id = 9002`)).toHaveLength(0);
  });

  it('does not re-evaluate when nothing changed', async () => {
    const before = (await q(`select count(*)::int n from analysis_runs`))[0]!.n;
    await generateCandidatesJob(ctx, { hours: 72, now: new Date(RUN_AT.getTime() + 60_000) });
    expect((await q(`select count(*)::int n from analysis_runs`))[0]!.n).toBe(before);
  });

  it('with a real market below the model -> 🧭 SIGNAL with rank 1 and latest-decision view', async () => {
    await ahMarketBelowModel('dixon-coles-v0.2', new Date(RUN_AT.getTime() - 3_600_000).toISOString());

    await generateCandidatesJob(ctx, { hours: 72, now: new Date(RUN_AT.getTime() + 4 * 3_600_000), rules: { ...DEFAULT_RULES, version: 'rules-test', minOdds: 1.1 } });
    const latest = (await q(`select * from analysis_latest_decision where fixture_id = 9001`))[0]!;
    expect(latest.outcome).toBe('SIGNAL');
    expect(latest.market).toBe('ASIAN_HANDICAP');
    expect(latest.selection).toBe('HOME');
    expect(Number(latest.edge)).toBeGreaterThan(0.03);
    expect(latest.strength).toBe('LEAN'); // gate z unknown (0) in this fixture -> capped at LEAN
    // the shadow rules ran on the same inputs and kept their decision aside
    const shadow = await q(`select rules_version, outcome, passed from shadow_decisions where fixture_id = 9001 and publish_round = 'LATEST'`);
    expect(shadow).toHaveLength(1);
    expect(shadow[0]!.rules_version).toBe(SHADOW_RULES.version);
  });

  it('analysis_runs and candidates are immutable', async () => {
    await expect(db.query(`update analysis_runs set outcome = 'SIGNAL'`)).rejects.toThrow(/not allowed/);
    await expect(db.query(`delete from analysis_candidates`)).rejects.toThrow(/not allowed/);
  });
});

describe('player impact layer', () => {
  const T = new Date(NOW.getTime() + 13 * 3_600_000);

  beforeAll(async () => {
    // team 1: star striker 1099 scored every goal; team 10: nobody special
    await db.query(`insert into fixture_player_stats (fixture_id, team_id, player_id, minutes, position, rating, goals, assists, shots_total, passes_key)
      select f.id, 1, p.pid, 90, case when p.pid = 1099 then 'F' when p.pid = 1001 then 'G' else 'M' end, 7,
             case when p.pid = 1099 then (case when f.home_team_id = 1 then f.goals_home else f.goals_away end) else 0 end, 0, 0, 0
        from fixtures f cross join (select unnest(array[1001,1002,1003,1004,1005,1006,1007,1008,1009,1010,1099]) as pid) p
       where (f.home_team_id = 1 or f.away_team_id = 1) and f.status_short = 'FT'`);
    await db.query(`insert into fixture_player_stats (fixture_id, team_id, player_id, minutes, position, rating, goals, assists, shots_total, passes_key)
      select f.id, 10, 10000 + g, 90, 'M', 7, case when g = 11 then (case when f.home_team_id = 10 then f.goals_home else f.goals_away end) else 0 end, 0, 0, 0
        from fixtures f cross join generate_series(1, 11) g
       where (f.home_team_id = 10 or f.away_team_id = 10) and f.status_short = 'FT'`);
    // confirmed lineup for 9001: team 1 WITHOUT its star (sub 1011 starts), team 10 full strength
    await db.query(`insert into fixture_lineup_players (fixture_id, team_id, player_id, player_name, is_starter)
      select 9001, 1, pid, 'P' || pid, true from unnest(array[1001,1002,1003,1004,1005,1006,1007,1008,1009,1010,1011]) pid
      union all select 9001, 10, 10000 + g, 'Q' || g, true from generate_series(1, 11) g`);
  });

  it('detects the missing star from the lineup and lowers the home win probability', async () => {
    await playerImpactJob(ctx, { hours: 72, now: T });
    const row = (await q(`select * from player_impact_latest where fixture_id = 9001`))[0]!;
    const home = row.home_impact as { source: string; attackLoss: number; missing: Array<{ playerId: number }> };
    expect(home.source).toBe('LINEUP');
    expect(home.attackLoss).toBeGreaterThan(0.3);
    expect(home.missing[0]!.playerId).toBe(1099);
    expect(row.trusted).toBe(false);

    const p = async (v: string) =>
      Number(
        (await q(`select probability from probability_predictions where fixture_id = 9001 and model_version_id = '${v}'
                  and market = 'MATCH_WINNER' and selection = 'HOME' order by computed_at desc limit 1`))[0]!.probability,
      );
    expect(await p('dc-impact-v0.1')).toBeLessThan(await p('dixon-coles-v0.2'));
  });

  it('is idempotent when nothing changed', async () => {
    const before = (await q(`select count(*)::int n from probability_predictions where model_version_id = 'dc-impact-v0.1'`))[0]!.n;
    await playerImpactJob(ctx, { hours: 72, now: new Date(T.getTime() + 60_000) });
    expect((await q(`select count(*)::int n from probability_predictions where model_version_id = 'dc-impact-v0.1'`))[0]!.n).toBe(before);
  });

  it('untrusted layer + big absence -> candidates blocked (MAJOR_ABSENCE_UNMODELLED)', async () => {
    await generateCandidatesJob(ctx, { hours: 72, now: new Date(T.getTime() + 120_000), rules: { ...DEFAULT_RULES, version: 'rules-test-2', minOdds: 1.1 } });
    const run = (await q(`select outcome, summary from analysis_runs where fixture_id = 9001 and decision_rule_version = 'rules-test-2'`))[0]!;
    expect(run.outcome).toBe('NO_CLEAR_SIGNAL');
    const s = run.summary as { rejectReasons: Record<string, number>; modelSource: string; impact: { used: boolean } };
    expect(s.rejectReasons.MAJOR_ABSENCE_UNMODELLED).toBeGreaterThan(0);
    expect(s.impact.used).toBe(false);
  });

  it('trusted layer -> candidates price with DC+IMPACT', async () => {
    await ctx.repo.insertModelConfigs([
      { leagueId: 39, purpose: 'IMPACT', modelVersionId: 'dc-impact-v0.1', params: { alpha: 0.5 }, metrics: { test: { z: 2 } }, enabled: true, matchesEvaluated: 400 },
    ]);
    await playerImpactJob(ctx, { hours: 72, now: new Date(T.getTime() + 180_000) }); // trusted flag changed -> rewrite
    await generateCandidatesJob(ctx, { hours: 72, now: new Date(T.getTime() + 240_000), rules: { ...DEFAULT_RULES, version: 'rules-test-3', minOdds: 1.1 } });
    const run = (await q(`select summary from analysis_runs where fixture_id = 9001 and decision_rule_version = 'rules-test-3'`))[0]!;
    const s = run.summary as { rejectReasons: Record<string, number>; modelSource: string; impact: { used: boolean } };
    expect(s.modelSource).toBe('DC+IMPACT');
    expect(s.impact.used).toBe(true);
    expect(s.rejectReasons.MAJOR_ABSENCE_UNMODELLED).toBeUndefined();
  });
});

describe('publish (Phase 6)', () => {
  let KO: Date;
  beforeAll(async () => {
    KO = new Date((await q(`select kickoff_at from fixtures where id = 9001`))[0]!.kickoff_at as string);
  });

  it('EARLY round: publishes the latest decision with hash chain + snapshot, once', async () => {
    const P = new Date(KO.getTime() - 20 * 3_600_000);
    await generateCandidatesJob(ctx, { hours: 72, now: P });
    expect(await publishJob(ctx, { now: P })).toBe(1);

    const row = (await q(`select * from published_analysis where fixture_id = 9001 and publish_round = 'EARLY'`))[0]!;
    expect(String(row.record_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(row.home_team).toBe('Team 1');
    expect(String(row.reason)).toMatch(/🧭|🌫️/);
    const snap = (await q(`select s.* from analysis_snapshots s join analysis_predictions p on p.id = s.analysis_prediction_id
                           where p.fixture_id = 9001 and p.publish_round = 'EARLY'`))[0]!;
    expect((snap.form_snapshot as { home: unknown[] }).home).toHaveLength(5);
    expect(Array.isArray(snap.candidates_snapshot)).toBe(true);
    expect(String(snap.snapshot_hash)).toMatch(/^[0-9a-f]{64}$/);

    expect(await publishJob(ctx, { now: new Date(P.getTime() + 5 * 60_000) })).toBe(0); // same round never twice
  });

  it('LINEUP round: confirmed lineups + real market edge -> 🧭 SIGNAL priced with DC+IMPACT, chained to EARLY', async () => {
    const L = new Date(KO.getTime() - 60 * 60_000);
    await db.query(`insert into fixture_lineups (fixture_id, team_id, formation) values (9001, 1, '4-3-3'), (9001, 10, '4-4-2')`);
    await ahMarketBelowModel('dc-impact-v0.1', new Date(L.getTime() - 10 * 60_000).toISOString());

    const rules = { ...DEFAULT_RULES, version: 'rules-test-pub', minOdds: 1.01 };
    await generateCandidatesJob(ctx, { hours: 72, now: L, rules });
    expect(await publishJob(ctx, { now: new Date(L.getTime() + 60_000), rulesVersion: rules.version })).toBe(1);

    const early = (await q(`select record_hash from analysis_predictions where fixture_id = 9001 and publish_round = 'EARLY'`))[0]!;
    const lu = (await q(`select * from analysis_predictions where fixture_id = 9001 and publish_round = 'LINEUP'`))[0]!;
    expect(lu.kind).toBe('SIGNAL');
    expect(lu.market).toBe('ASIAN_HANDICAP');
    expect(lu.selection).toBe('HOME');
    expect(lu.model_version_id).toBe('dc-impact-v0.1');
    expect(lu.prev_hash).toBe(early.record_hash);
    expect(String(lu.reason)).toContain('🧭 เข็มทิศเกม: Team 1 -1.25');
    expect(String(lu.reason)).toContain('ปรับตามผู้เล่นที่ขาดแล้ว');
    expect(lu.status).toBe('PENDING');

    // shadow trial: the shadow pick of the same round is locked beside it, under the same conditions
    const locked = await q(`select publish_round, locked_at from shadow_decisions where fixture_id = 9001 and rules_version = '${SHADOW_RULES.version}' and publish_round = 'LINEUP'`);
    expect(locked).toHaveLength(1);
    expect(locked[0]!.locked_at).not.toBeNull();

    const snap = (await q(`select lineup_snapshot from analysis_snapshots where analysis_prediction_id = ${lu.id}`))[0]!;
    expect(snap.lineup_snapshot as unknown[]).toHaveLength(22);
    const chain = await q(`select ok from fp_verify_prediction_chain()`);
    expect(chain.every((r) => r.ok)).toBe(true);
  });
});

describe('backtest job', () => {
  it('runs on DB data and records the run', async () => {
    const n = await backtest(ctx, { warmupMatches: 60 });
    expect(n).toBe(1); // league 39 evaluated, Nations League skipped
    const run = (await q(`select status from sync_runs where job = 'backtest' order by id desc limit 1`))[0]!;
    expect(run.status).toBe('SUCCESS');
  }, 60_000);
});

describe('match report', () => {
  it('renders a Markdown report for upcoming fixtures', async () => {
    const { matchReport } = await import('../src/report-job.js');
    const ko = new Date((await q(`select kickoff_at from fixtures where id = 9001`))[0]!.kickoff_at as string);
    const r = await matchReport(ctx, { hours: 6, now: new Date(ko.getTime() - 3 * 3_600_000) });
    expect(r.fixtures).toBe(1);
    expect(r.markdown).toContain('## Team 1 vs Team 10');
    expect(r.markdown).toContain('Dixon-Coles');
    expect(r.markdown).toContain('ฟอร์ม 5 นัด');
    expect(r.markdown).toContain('ไม่ใช่คำแนะนำในการเล่นพนัน');
  });
});

describe('player impact without injuries coverage', () => {
  const T = new Date(NOW.getTime() + 14 * 3_600_000);

  beforeAll(async () => {
    // EARLY-round view of 9001: no confirmed XIs yet, the star is on the injury list
    await db.query(`delete from fixture_lineup_players where fixture_id = 9001`);
    await db.query(`insert into injuries (fixture_id, league_id, season, team_id, player_id, player_name, type)
                    values (9001, 39, 2026, 1, 1099, 'Star', 'Missing Fixture')`);
  });

  const homeImpact = async () =>
    (await q(`select home_impact from player_impact_latest where fixture_id = 9001`))[0]!.home_impact as { source: string; missing: Array<{ playerId: number }> };

  it('uses the injury list while coverage is unknown', async () => {
    await playerImpactJob(ctx, { hours: 72, now: T });
    const home = await homeImpact();
    expect(home.source).toBe('INJURIES');
    expect(home.missing[0]!.playerId).toBe(1099);
  });

  it('reads an empty or partial injury list as unknown when the league has no injuries coverage', async () => {
    await db.query(`insert into league_seasons (league_id, season, coverage) values (39, 2026, '{"injuries": false}')
                    on conflict (league_id, season) do update set coverage = excluded.coverage`);
    await playerImpactJob(ctx, { hours: 72, now: new Date(T.getTime() + 60_000) });
    const home = await homeImpact();
    expect(home.source).toBe('NONE');
    expect(home.missing).toEqual([]);
  });
});
