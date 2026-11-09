/**
 * E2E (PGlite, all migrations): the daily pick run (ADR 0014) with a fake Hybrid AI.
 *  - decisions and DAILY rounds only from 14:00 to 16:00 Thai, for the pick day (14:00 → 14:00) only
 *  - a match already published (an EARLY round of the switch day) is never picked again; nothing inside 15 minutes
 *  - the featured-ai-v3 list (ADR 0015; ai-v2 before it) waits for the run, is chosen once, confirmed at once, and never changes after
 * The clock (and PGlite's now()) is faked: 2027-01-05 is the pick day.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HybridDecider, RankerResult } from '@fp/ai';
import { Repository, type JobContext } from '@fp/database';
import { ApiFootball, ApiFootballClient } from '@fp/football';
import { createLogger, type Env } from '@fp/shared';
import { createTestDb } from '../../../packages/database/test/helpers.js';
import { featuredOnceJob } from '../src/featured-once-job.js';
import { hybridJob } from '../src/hybrid-job.js';
import { publishJob } from '../src/publish-job.js';

const thai = (s: string) => new Date(`${s}:00+07:00`);
const at = (s: string) => vi.setSystemTime(thai(s));

let db: Awaited<ReturnType<typeof createTestDb>>;
let ctx: JobContext;
const q = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<R>(sql, params)).rows;

// fixture, league, home team, Thai kick-off
const MATCHES: Array<[number, number, string, string]> = [
  [601, 39, 'Tonight FC', '2027-01-05T20:00'],
  [602, 140, 'Morning FC', '2027-01-06T07:30'], // tomorrow morning: same pick day
  [603, 39, 'Late FC', '2027-01-06T15:00'], // the next pick day
  [604, 135, 'Soon FC', '2027-01-05T14:30'], // inside 15 minutes of the run
  [605, 78, 'Early FC', '2027-01-05T23:00'], // published at EARLY before the switch
  [606, 61, 'Fog FC', '2027-01-05T21:00'], // the AI finds no pick
  [607, 39, 'Edge FC', '2027-01-06T14:00'], // 14:00 sharp: the next pick day, so the list does not wait for it
];

const answer = (over: Record<string, unknown> = {}) => ({
  team_assessment_th: 'ทีมเหย้าฟอร์มดีกว่า',
  match_outlook_th: 'ทีมเหย้าน่าจะคุมเกม',
  market_comparison_th: 'ตลาดให้ทีมเหย้าต่อ',
  options_review: [{ option: 'UNDERDOG', supporting_evidence: ['ทีมเยือนเสียประตูน้อย'], counter_evidence: ['ทีมเหย้ายิงได้ทุกนัด'], assessment: 'MODERATE' }],
  market: 'AH',
  side: 'UNDERDOG',
  main_line: 0.75,
  confidence: 'MEDIUM',
  supporting_evidence: ['ทีมเยือนเสียประตูน้อย'],
  counter_evidence: ['ทีมเหย้ายิงได้ทุกนัด'],
  risk_factors: [],
  missing_data: [],
  summary_th: 'ทีมเยือนรับได้แน่นกว่าที่ราคาสะท้อน',
  ...over,
});

function fakeDecider(): HybridDecider & { calls: string[] } {
  const d = {
    calls: [] as string[],
    async decide(input: Record<string, unknown>): Promise<RankerResult> {
      const home = (input.match as { home: string }).home;
      d.calls.push(home);
      const output = home === 'Fog FC' ? answer({ market: 'NONE', side: 'NO_PICK', main_line: null, confidence: 'NONE', summary_th: 'หลักฐานยังไม่ชัดพอ' }) : answer();
      return { output, model: 'gpt-test', stopReason: 'stop', refusal: null, usage: { input_tokens: 100, output_tokens: 50 } };
    },
  };
  return d;
}

async function odds(fixture: number) {
  const t = thai('2027-01-05T13:30').toISOString();
  for (const bk of [1, 2, 3])
    for (const [market, bet, sel, line, home, raw, o] of [
      ['ASIAN_HANDICAP', 4, 'HOME', -0.75, -0.75, 'Home -0.75', 1.95],
      ['ASIAN_HANDICAP', 4, 'AWAY', 0.75, -0.75, 'Away +0.75', 1.93],
      ['OVER_UNDER', 5, 'OVER', 2.5, null, 'Over 2.5', 1.9],
      ['OVER_UNDER', 5, 'UNDER', 2.5, null, 'Under 2.5', 1.95],
    ] as const)
      await q(
        `insert into odds_history (fixture_id, bookmaker_id, market, api_bet_id, api_bet_name, selection, line, home_line, raw_value, odds, source_updated_at)
         values ($1, $2, $3, $4, 'x', $5, $6, $7, $8, $9, $10)`,
        [fixture, bk, market, bet, sel, line, home, raw, o, t],
      );
}

const daily = { engine: 'hybrid' as const, schedule: 'daily' as const };

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at('2027-01-05T09:00');
  db = await createTestDb();
  const client = new ApiFootballClient({ apiKey: 'test', fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch });
  const env: Env = {
    API_FOOTBALL_KEY: 'test',
    API_FOOTBALL_BASE_URL: 'https://v3.football.api-sports.io',
    API_FOOTBALL_RPM: 1000,
    DATABASE_URL: 'pglite',
    TRACKED_LEAGUES: [39, 140, 135, 78, 61],
    SEASON: 2026,
    ODDS_MARKETS: ['MATCH_WINNER', 'ASIAN_HANDICAP', 'OVER_UNDER'],
    ODDS_BOOKMAKERS: [],
    LOG_LEVEL: 'error',
  };
  ctx = { env, db, repo: new Repository(db), client, api: new ApiFootball(client), log: createLogger('error') };

  await db.exec(`insert into leagues (id, name) values (39, 'EPL'), (140, 'La Liga'), (135, 'Serie A'), (78, 'Bundesliga'), (61, 'Ligue 1');
                 insert into bookmakers (id, name) values (1, 'B1'), (2, 'B2'), (3, 'B3');
                 insert into teams (id, name) values (999, 'Away FC');`);
  for (const [id, league, home, ko] of MATCHES) {
    await q(`insert into teams (id, name) values ($1, $2)`, [id, home]);
    await q(`insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short) values ($1::int, $2, 2026, $3, $1::int, 999, 'NS')`, [id, league, thai(ko).toISOString()]);
    if (id !== 605) await odds(id);
  }
  // the switch day: 605 was published at the EARLY round (hourly schedule) in the morning
  await q(
    `insert into analysis_predictions (fixture_id, publish_round, kind, market, selection, line, odds_at_publish, market_probability, signal_strength, decision_rule_version)
     values (605, 'EARLY', 'SIGNAL', 'ASIAN_HANDICAP', 'HOME', -0.25, 1.95, 0.52, 'MEDIUM', 'hybrid-ai-v1')`,
  );
}, 60_000);

afterAll(async () => {
  vi.useRealTimers();
  await db?.close();
});

const published = async () =>
  new Map((await q<{ fixture_id: string; publish_round: string; kind: string; reason: string }>(`select fixture_id, publish_round, kind, reason from analysis_predictions order by fixture_id, published_at`)).map((r) => [Number(r.fixture_id), r]));

describe('daily pick run', () => {
  it('decides nothing before 14:00 Thai', async () => {
    at('2027-01-05T13:05');
    const d = fakeDecider();
    expect(await hybridJob(ctx, { ...daily, decider: d })).toBe(0);
    expect(await publishJob(ctx, daily)).toBe(0);
    expect(d.calls).toEqual([]);
  });

  it('the list waits while the run has matches left to decide', async () => {
    at('2027-01-05T14:10');
    expect(await featuredOnceJob(ctx)).toBe(0);
    expect(await q(`select 1 from featured_selections`)).toEqual([]);
  });

  it('at 14:00: every match of the pick day without a round gets one final DAILY round', async () => {
    at('2027-01-05T14:20');
    const d = fakeDecider();
    expect(await hybridJob(ctx, { ...daily, decider: d })).toBe(3);
    expect([...new Set(d.calls)].sort()).toEqual(['Fog FC', 'Morning FC', 'Tonight FC']);
    expect(await publishJob(ctx, daily)).toBe(3);
    const p = await published();
    expect(p.get(601)).toMatchObject({ publish_round: 'DAILY', kind: 'SIGNAL' });
    expect(p.get(601)!.reason.split('\n')[0]).toContain('(วิเคราะห์ก่อนเกม)');
    expect(p.get(602)).toMatchObject({ publish_round: 'DAILY', kind: 'SIGNAL' });
    expect(p.get(606)).toMatchObject({ publish_round: 'DAILY', kind: 'NO_CLEAR_SIGNAL' });
    expect(p.get(605)).toMatchObject({ publish_round: 'EARLY' }); // kept, not redone
    expect(p.has(603)).toBe(false); // next pick day
    expect(p.has(604)).toBe(false); // too close to kick-off
  });

  it('a later run of the same afternoon changes nothing', async () => {
    at('2027-01-05T15:20');
    const d = fakeDecider();
    expect(await hybridJob(ctx, { ...daily, decider: d })).toBe(0);
    expect(await publishJob(ctx, daily)).toBe(0);
    expect(d.calls).toEqual([]);
  });

  it('the list is chosen once from the picks, confirmed at once, and never changes', async () => {
    at('2027-01-05T15:25');
    expect(await featuredOnceJob(ctx)).toBeGreaterThan(0);
    const rows = await q<{ football_date: string; fixture_id: string; phase: string; rank: number | null; locked_at: string | null }>(
      `select football_date::text, fixture_id, phase, rank, locked_at from featured_selections where version = 'featured-ai-v3' order by fixture_id`,
    );
    expect(rows.every((r) => r.football_date === '2027-01-05' && r.locked_at !== null)).toBe(true);
    const by = new Map(rows.map((r) => [Number(r.fixture_id), r]));
    expect([601, 602, 605].map((f) => by.get(f)?.phase)).toEqual(['CONFIRMED', 'CONFIRMED', 'CONFIRMED']);
    expect(by.get(606)).toMatchObject({ phase: 'SKIPPED', rank: null }); // fog: published, not listed
    expect([601, 602, 605].map((f) => by.get(f)!.rank).sort()).toEqual([1, 2, 3]);
    expect(rows.some((r) => r.phase === 'DROPPED' || r.phase === 'RESERVED')).toBe(false);

    at('2027-01-05T17:05');
    expect(await featuredOnceJob(ctx)).toBe(0);
    expect((await q(`select 1 from featured_selections where version = 'featured-ai-v3'`)).length).toBe(rows.length);
  });

  it('nothing after 16:00, and the next pick day starts at 14:00 the next day', async () => {
    at('2027-01-05T16:05');
    const d = fakeDecider();
    expect(await hybridJob(ctx, { ...daily, decider: d })).toBe(0);
    expect(d.calls).toEqual([]);

    at('2027-01-06T14:10');
    expect(await hybridJob(ctx, { ...daily, decider: d })).toBe(1);
    expect(await publishJob(ctx, daily)).toBe(1);
    expect((await published()).get(603)).toMatchObject({ publish_round: 'DAILY' });
  });

  it('the switch day: a pick day ai-v2 already listed gets no ai-v3 list (ADR 0015)', async () => {
    at('2027-01-06T14:30');
    // 603's DAILY decision was no pick (its odds are a day old by then): give it a newer listable pick
    await q(
      `insert into analysis_predictions (fixture_id, publish_round, kind, market, selection, line, odds_at_publish, market_probability, signal_strength, decision_rule_version)
       values (603, 'PREMATCH', 'SIGNAL', 'ASIAN_HANDICAP', 'AWAY', 0.75, 1.93, 0.5, 'MEDIUM', 'hybrid-ai-v1')`,
    );
    // not locked, so the control below may remove it (a locked row cannot be deleted)
    await q(`insert into featured_selections (football_date, version, fixture_id, league_id, phase, rank, first_reserved_at, first_rank)
             values ('2027-01-06', 'featured-ai-v2', 603, 39, 'RESERVED', 1, now(), 1)`);
    expect(await featuredOnceJob(ctx)).toBe(0);
    expect(await q(`select 1 from featured_selections where version = 'featured-ai-v3' and football_date = '2027-01-06'`)).toEqual([]);

    // control: without ai-v2's list, the same run lists 603 under ai-v3
    await q(`delete from featured_selections where version = 'featured-ai-v2' and football_date = '2027-01-06'`);
    expect(await featuredOnceJob(ctx)).toBeGreaterThan(0);
    expect(await q(`select fixture_id::int from featured_selections where version = 'featured-ai-v3' and football_date = '2027-01-06' and rank = 1`)).toEqual([{ fixture_id: 603 }]);
  });
});
