/**
 * Dry-run backtest of the Hybrid AI (hybrid-ai-v1) on finished matches, as of each match's original EARLY decision time.
 * Writes NOTHING to the database: no decision, no pick. Each fixture costs up to HYBRID_MAX_ATTEMPTS AI calls.
 *
 * Leak control: the stored standings, injuries and lineups are post-match snapshots, so this run drops them
 * (standings, opponent ranks, injuries, lineup -> null / empty). Odds, recent matches and the legacy model's
 * probabilities are read as of the decision time. The AI therefore sees less than it does live.
 *
 *   npx tsx scripts/hybrid-backtest.ts [--n 30] [--seed s1] [--skip 0] [--out reports/hybrid-backtest.json]
 *   (--skip N: leave out the first N fixtures of the seeded order, to run the next batch)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { buildHybridInput, createOpenAIHybridDecider, HYBRID_MAX_ATTEMPTS, validateHybridOutput, type HybridSource } from '@fp/ai';
import { closingLineValue, hybridMarket, hybridOptions, settle, type HybridSide } from '@fp/analysis';
import { createPgDb, Repository } from '@fp/database';
import { loadDotEnvFile, loadEnv } from '@fp/shared';

const { values } = parseArgs({ options: { n: { type: 'string', default: '30' }, seed: { type: 'string', default: 's1' }, skip: { type: 'string', default: '0' }, out: { type: 'string', default: 'reports/hybrid-backtest.json' } } });
loadDotEnvFile();
const env = loadEnv();
if (!env.OPENAI_API_KEY || !env.OPENAI_MODEL) throw new Error('OPENAI_API_KEY and OPENAI_MODEL are needed (the live engine uses them)');
const db = createPgDb(env.DATABASE_URL!, { max: 4 });
const repo = new Repository(db);
const decider = createOpenAIHybridDecider({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL });

// only matches decided before the live Hybrid AI started (2026-10-26), one EARLY row per fixture
const rows = (
  await db.query<Record<string, unknown>>(
    `select p.fixture_id, p.published_at, p.kind, p.market, p.selection, p.line, p.odds_at_publish, p.status as rules_status, p.clv as rules_clv,
            f.league_id, f.kickoff_at, f.home_team_id, f.away_team_id, f.status_short,
            coalesce(f.ft_home, f.goals_home) as gh, coalesce(f.ft_away, f.goals_away) as ga
       from analysis_predictions p join fixtures f on f.id = p.fixture_id
      where p.publish_round = 'EARLY' and p.published_at < '2026-10-26' and p.published_at < f.kickoff_at
        and f.status_short in ('FT','AET','PEN') and coalesce(f.ft_home, f.goals_home) is not null
      order by md5(p.fixture_id::text || $1) offset $2 limit $3`,
    [values.seed, Number(values.skip), Number(values.n)],
  )
).rows;

type Result = Record<string, unknown>;

async function run(r: Record<string, unknown>): Promise<Result> {
  const fixtureId = Number(r.fixture_id);
  const now = new Date(r.published_at as string);
  const f = { id: fixtureId, leagueId: Number(r.league_id), kickoffAt: new Date(r.kickoff_at as string), homeTeamId: Number(r.home_team_id), awayTeamId: Number(r.away_team_id) };
  const header = (await repo.fixtureHeader(fixtureId))!;
  const market = hybridMarket(await repo.latestQuotes(fixtureId, now), now);
  const options = hybridOptions(market);
  const base = { fixtureId, match: `${header.home} vs ${header.away}`, league: header.league, kickoff: f.kickoffAt.toISOString(), decidedAt: now.toISOString(), final: `${r.gh}-${r.ga}` };
  const rules = r.kind === 'SIGNAL' ? { market: r.market, selection: r.selection, line: Number(r.line), odds: Number(r.odds_at_publish), status: r.rules_status, clv: r.rules_clv == null ? null : Number(r.rules_clv) } : null;
  if (!options.length) return { ...base, status: 'NO_OPTIONS', rules };

  const [recentHome, recentAway, dcRows] = await Promise.all([repo.teamRecentMatches(f.homeTeamId, now, 10), repo.teamRecentMatches(f.awayTeamId, now, 10), repo.latestProbabilities(fixtureId, 'dixon-coles-v0.2', now)]);
  const noRank = (ms: typeof recentHome) => ms.map((m) => ({ ...m, opponentRank: null, opponentTableSize: null }));
  const dcOf = (m: string, s: string, line: number | null) => dcRows.find((p) => p.market === m && p.selection === s && (line === null ? p.line === null : p.line !== null && Math.abs(p.line - line) < 1e-9))?.probability;
  const legacyOptions: Partial<Record<HybridSide, number>> = {};
  for (const o of options) {
    const p = dcOf(o.market, o.selection, o.line);
    if (p !== undefined) legacyOptions[o.side] = p;
  }
  const [h, d, a] = (['HOME', 'DRAW', 'AWAY'] as const).map((s) => dcOf('MATCH_WINNER', s, null));
  const src: HybridSource = {
    fixture: { id: fixtureId, home: header.home, away: header.away, league: header.league, kickoffAt: f.kickoffAt },
    predictionAt: now,
    publishRound: 'EARLY',
    recent: { home: noRank(recentHome), away: noRank(recentAway) },
    standings: { home: null, away: null },
    injuries: [],
    lineup: null,
    market,
    legacy: dcRows.length ? { options: legacyOptions, x12: h !== undefined && d !== undefined && a !== undefined ? { home: h, draw: d, away: a } : null } : null,
  };
  const input = buildHybridInput(src);

  let attempts = 0;
  const violations: string[] = [];
  let tokens = { in: 0, out: 0 };
  for (; attempts < HYBRID_MAX_ATTEMPTS; ) {
    attempts++;
    let res;
    try {
      res = await decider.decide(input);
    } catch (err) {
      return { ...base, status: 'ERROR', error: String(err).slice(0, 200), rules };
    }
    const u = res.usage as { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
    tokens = { in: tokens.in + (u.input_tokens ?? u.prompt_tokens ?? 0), out: tokens.out + (u.output_tokens ?? u.completion_tokens ?? 0) };
    if (res.refusal || res.output === null) {
      violations.push(`attempt ${attempts}: ${res.refusal ? 'refusal' : 'unparseable'}`);
      if (res.refusal) break;
      continue;
    }
    const v = validateHybridOutput(res.output, input, options);
    if (!v.ok || !v.decision) {
      violations.push(...v.violations.map((x) => `attempt ${attempts}: ${x}`));
      continue;
    }
    const side = v.decision.side;
    const o = v.decision.option;
    if (!o) return { ...base, status: 'OK', side, confidence: v.decision.confidence, attempts, tokens, rules, options: options.map((x) => x.side) };
    const outcome = settle(o.market === 'ASIAN_HANDICAP' ? { market: 'ASIAN_HANDICAP', selection: o.selection as 'HOME' | 'AWAY', line: o.line } : { market: 'OVER_UNDER', selection: o.selection as 'OVER' | 'UNDER', line: o.line }, Number(r.gh), Number(r.ga));
    const profit = { WIN: o.odds - 1, HALF_WIN: (o.odds - 1) / 2, PUSH: 0, HALF_LOSS: -0.5, LOSS: -1 }[outcome];
    const closing = closingLineValue(o.odds, await repo.closingOdds(fixtureId, o.market, o.selection, o.line));
    return { ...base, status: 'OK', side, confidence: v.decision.confidence, attempts, tokens, pick: { market: o.market, selection: o.selection, line: o.line, odds: o.odds }, outcome, profit, clv: closing?.clv ?? null, rules, agreesWithRules: rules ? rules.market === o.market && rules.selection === o.selection && rules.line === o.line : null };
  }
  return { ...base, status: 'INVALID', attempts, tokens, violations, rules };
}

// 4 at a time
const results: Result[] = new Array(rows.length);
let next = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (next < rows.length) {
      const i = next++;
      results[i] = await run(rows[i]!);
      console.log(`${i + 1}/${rows.length} ${results[i]!.match} -> ${results[i]!.status} ${results[i]!.side ?? ''} ${results[i]!.outcome ?? ''}`);
    }
  }),
);

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const picks = results.filter((x) => x.pick);
const rulesPicked = results.filter((x) => x.rules);
const rulesProfit = (x: Result) => {
  const rr = x.rules as { odds: number; status: string };
  return ({ WIN: rr.odds - 1, HALF_WIN: (rr.odds - 1) / 2, PUSH: 0, HALF_LOSS: -0.5, LOSS: -1 } as Record<string, number>)[rr.status] ?? 0;
};
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const summary = {
  version: 'hybrid-ai-v1 dry-run, standings/injuries/lineups removed',
  fixtures: results.length,
  status: Object.fromEntries([...new Set(results.map((x) => x.status as string))].map((s) => [s, results.filter((x) => x.status === s).length])),
  noPick: results.filter((x) => x.status === 'OK' && x.side === 'NO_PICK').length,
  picks: picks.length,
  outcomes: Object.fromEntries([...new Set(picks.map((x) => x.outcome as string))].map((s) => [s, picks.filter((x) => x.outcome === s).length])),
  units: Number(sum(picks.map((x) => x.profit as number)).toFixed(2)),
  clvMean: mean(picks.map((x) => x.clv as number | null).filter((x): x is number => x !== null)),
  clvN: picks.filter((x) => x.clv != null).length,
  rulesPicksOnSameFixtures: rulesPicked.length,
  rulesUnits: Number(sum(rulesPicked.map(rulesProfit)).toFixed(2)),
  rulesClvMean: mean(rulesPicked.map((x) => (x.rules as { clv: number | null }).clv).filter((x): x is number => x !== null)),
  bothPicked: results.filter((x) => x.pick && x.rules).length,
  sameBet: results.filter((x) => x.agreesWithRules === true).length,
  tokens: { in: sum(results.map((x) => (x.tokens as { in: number } | undefined)?.in ?? 0)), out: sum(results.map((x) => (x.tokens as { out: number } | undefined)?.out ?? 0)) },
};
await mkdir(dirname(values.out!), { recursive: true });
await writeFile(values.out!, JSON.stringify({ summary, results }, null, 2));
console.log('\n' + JSON.stringify(summary, null, 2));
await db.close();
