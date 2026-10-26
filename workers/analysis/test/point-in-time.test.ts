/**
 * Audit A-08: a replay at time T reads only what existed at T. Rows stored later (a quote fetched after T even
 * when its bookmaker set it before T, a later model run, a later tuning) must not change the decision at T.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_RULES, generateCandidates } from '@fp/analysis';
import { Repository } from '@fp/database';
import { createTestDb } from '../../../packages/database/test/helpers.js';
import { candidateContext } from '../src/candidates-job.js';

let db: Awaited<ReturnType<typeof createTestDb>>;
let repo: Repository;
const KO = new Date(Date.now() + 3 * 86_400_000);
const T = new Date(KO.getTime() - 6 * 3_600_000);
const at = (minutes: number) => new Date(T.getTime() + minutes * 60_000).toISOString();
const fixture = { id: 501, kickoffAt: KO };

function odds(bk: number, price: (base: number) => number, source: string, collected: string) {
  const rows = [
    ['ASIAN_HANDICAP', 4, 'Asian Handicap', 'HOME', -0.5, -0.5, 'Home -0.5', 1.95],
    ['ASIAN_HANDICAP', 4, 'Asian Handicap', 'AWAY', 0.5, -0.5, 'Away +0.5', 1.95],
    ['OVER_UNDER', 5, 'Goals Over/Under', 'OVER', 2.5, null, 'Over 2.5', 1.9],
    ['OVER_UNDER', 5, 'Goals Over/Under', 'UNDER', 2.5, null, 'Under 2.5', 2.0],
  ] as const;
  return rows
    .map(([m, bet, name, sel, line, hl, raw, o]) => `(501, ${bk}, '${m}', ${bet}, '${name}', '${sel}', ${line}, ${hl ?? 'null'}, '${raw}', ${price(o).toFixed(3)}, '${source}', '${collected}')`)
    .join(',\n');
}
const insertOdds = (values: string) =>
  db.exec(`insert into odds_history (fixture_id, bookmaker_id, market, api_bet_id, api_bet_name, selection, line, home_line, raw_value, odds, source_updated_at, collected_at) values ${values};`);

function probs(computedAt: string, home: number, over: number) {
  const inputs = `'{"lambda": 1.4, "mu": 1.1, "home": {"weightedMatches": 20}, "away": {"weightedMatches": 20}}'`;
  return `
    insert into probability_predictions (fixture_id, model_version_id, computed_at, market, selection, line, probability, inputs) values
      (501, 'dixon-coles-v0.2', '${computedAt}', 'MATCH_WINNER', 'HOME', null, 0.45, ${inputs}),
      (501, 'dixon-coles-v0.2', '${computedAt}', 'MATCH_WINNER', 'DRAW', null, 0.27, null),
      (501, 'dixon-coles-v0.2', '${computedAt}', 'MATCH_WINNER', 'AWAY', null, 0.28, null),
      (501, 'dixon-coles-v0.2', '${computedAt}', 'ASIAN_HANDICAP', 'HOME', -0.5, ${home}, null),
      (501, 'dixon-coles-v0.2', '${computedAt}', 'ASIAN_HANDICAP', 'AWAY', 0.5, ${1 - home}, null),
      (501, 'dixon-coles-v0.2', '${computedAt}', 'OVER_UNDER', 'OVER', 2.5, ${over}, null),
      (501, 'dixon-coles-v0.2', '${computedAt}', 'OVER_UNDER', 'UNDER', 2.5, ${1 - over}, null);`;
}

async function decisionAt(when: Date, pointInTime: boolean) {
  const cfg = await repo.latestModelConfigs(39, pointInTime ? when : undefined);
  const c = await candidateContext(repo, fixture, cfg, when, { pointInTime });
  return { quotes: c!.quotes, computedAt: c!.computedAt, decision: generateCandidates(c!.input, DEFAULT_RULES) };
}

beforeAll(async () => {
  db = await createTestDb();
  repo = new Repository(db);
  await db.exec(`
    insert into leagues (id, name) values (39, 'Premier League');
    insert into teams (id, name) values (1, 'A'), (2, 'B');
    insert into bookmakers (id, name) values (1, 'b1'), (2, 'b2'), (3, 'b3');
    insert into model_versions (id) values ('dixon-coles-v0.2');
    insert into fixtures (id, league_id, season, kickoff_at, home_team_id, away_team_id, status_short) values (501, 39, 2026, '${KO.toISOString()}', 1, 2, 'NS');
    insert into model_configs (league_id, purpose, model_version_id, params, metrics, enabled, matches_evaluated, tuned_at) values
      (39, 'SIDES', 'dixon-coles-v0.2', '{}', '{"test": {"z": 3}}', true, 300, '${at(-2 * 24 * 60)}'),
      (39, 'TOTALS', 'dixon-coles-v0.2', '{}', '{"test": {"z": 3}}', true, 300, '${at(-2 * 24 * 60)}');
    ${probs(at(-180), 0.56, 0.5)}
  `);
  // three bookmakers, fetched 110 minutes before T
  await insertOdds([1, 2, 3].map((bk) => odds(bk, (o) => o, at(-120), at(-110))).join(',\n'));
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('replay at T (point in time)', () => {
  it('rows stored after T do not change the decision at T', async () => {
    const before = await decisionAt(T, true);
    expect(before.computedAt).toBe(at(-180));
    expect(before.quotes).toHaveLength(12);

    await insertOdds(
      [
        // set by the bookmaker before T but fetched an hour after it
        odds(1, (o) => o * 1.3, at(-30), at(60)),
        // set and fetched after T
        odds(2, (o) => o * 0.7, at(30), at(40)),
      ].join(',\n'),
    );
    await db.exec(`
      ${probs(at(30), 0.7, 0.3)}
      insert into model_configs (league_id, purpose, model_version_id, params, metrics, enabled, matches_evaluated, tuned_at) values
        (39, 'SIDES', 'dixon-coles-v0.2', '{}', '{"test": {"z": 0}}', false, 300, '${at(60)}');
    `);

    const after = await decisionAt(T, true);
    expect(after.computedAt).toBe(before.computedAt);
    expect(after.quotes.map(({ collectedAt: _c, ...q }) => q)).toEqual(before.quotes.map(({ collectedAt: _c, ...q }) => q));
    expect(after.decision).toEqual(before.decision);
  });

  it('the same reads without point in time do see the later rows (the test can tell them apart)', async () => {
    const live = await decisionAt(T, false);
    expect(live.computedAt).toBe(at(30));
    const replay = await decisionAt(T, true);
    expect(live.decision).not.toEqual(replay.decision);
  });

  it('a quote is known only once it is both stamped and stored by then', async () => {
    const quotes = await repo.latestQuotes(501, new Date(at(35)));
    // bookmaker 2's later quotes are stamped T+30 and stored T+40: not known at T+35
    expect(quotes.filter((q) => q.bookmakerId === 2).every((q) => q.updatedAt.toISOString() === at(-120))).toBe(true);
    // bookmaker 1's T-30 quotes were stored at T+60: not known at T+35
    expect(quotes.filter((q) => q.bookmakerId === 1).every((q) => q.updatedAt.toISOString() === at(-120))).toBe(true);
    expect(quotes.every((q) => q.collectedAt!.getTime() <= Date.parse(at(35)))).toBe(true);
  });
});
